import { access, readFile, stat } from "node:fs/promises";
import path from "node:path";

import { LIKERT_LABELS, defaultPaths, resolveProjectRoot } from "./config.js";
import { analyzeJudgment, buildFollowupPrompt } from "./feedback.js";
import { MemoryStore } from "./memory.js";
import { SessionManager, type SessionMessage } from "./session-manager.js";
import { MomokaHttpError } from "./http-error.js";
import type { AgentRegistry } from "./agent-registry.js";
import { DEFAULT_SYSTEM_PROMPT, DISPATCHER_SYSTEM_PROMPT, isDispatcherAgent } from "./agent-registry.js";
import { WorkspaceManager } from "./workspace-manager.js";
import { ApprovalError, createApprovalExecutionEvent } from "./approvals.js";
import { executeApprovedToolCall, toolSpecsForKind } from "./tools.js";
import { buildBoundedHistoryMessages } from "./context.js";
import { buildContextStats } from "./context-stats.js";
import { loadSkillContent, loadSkillIndex, matchSkills } from "./skills.js";
import { appendTraceEvent, createRunTrace } from "./trace.js";
import { saveRunSnapshot } from "./snapshot.js";
import { initSettings, isSandboxEnabled as getSandboxFlag, setSandboxEnabled as persistSandboxFlag } from "./settings.js";
import { loadSettings } from "./settings-store.js";
import type { ChatRequest, ChatResponse, JudgeRequest, JudgeResponse, ModelClient, ModelRunContext, ModelRunResult, MomokaAgent, StreamEvent } from "./types.js";

interface MomokaAgentOptions {
  projectRoot?: string;
  modelClient: ModelClient;
  /**
   * 标题预生成专用模型（设置页“低消费/廉价档” low tier）。
   * 未配置或调用失败时回落到 modelClient，不阻断首轮对话。
   */
  titleModelClient?: ModelClient;
  agentRegistry?: AgentRegistry;
  workspaceManager?: WorkspaceManager;
}
const accept = { action: "accept" as const, reasons: [], revisionPrompt: "" };
const makeId = (prefix: string) => `${prefix}_${crypto.randomUUID().replace(/-/g, "").slice(0, 12)}`;

/**
 * 角色扮演槽位标记。人格文本里包一段 `<!-- roleplay:start -->…<!-- roleplay:end -->`，
 * 运行时用 prompts/ROLEPLAY.md 的内容替换槽位；无内容则连标记一起删掉。
 * 位置固定在 system 最末，保证调整人格时前面已缓存的前缀不失效。
 */
const ROLEPLAY_SLOT_START = "<!-- roleplay:start -->";
const ROLEPLAY_SLOT_END = "<!-- roleplay:end -->";

/**
 * 会话级串行队列：同一会话同一时刻只跑一轮 chat。
 *
 * 为什么需要：“终态全唤醒”定了之后，多个执行者同时完成会同时驱动同一个值日生会话，
 * 并发写同一份 messages.json 会互相覆盖（流式消息 id、messageCount、transcript 都会脏）。
 * 排到后来者等待即可，不丢请求。
 */
const sessionRunTails = new Map<string, Promise<void>>();

async function withSessionLock<T>(sessionId: string | null | undefined, task: () => Promise<T>): Promise<T> {
  if (!sessionId) return await task();
  const previous = sessionRunTails.get(sessionId) ?? Promise.resolve();
  const run = previous.then(task, task);
  // 队列尾只保留“已结束”信号：不传播失败（否则会变成 unhandled rejection）
  sessionRunTails.set(sessionId, run.then(() => undefined, () => undefined));
  return await run;
}

/**
 * 未自定义 role 时的默认人格（Settings.agentPersona 未设置时使用）。
 * 内容来自原 prompts/AGENTS.md 的人格段（# 文件助手 + 能力 + 行为规则），
 * 平台规则层已拆到 prompts/SYSTEM_RULES.md，此处只保留“我是谁/怎么干活”。
 */
const DEFAULT_AGENT_PERSONA = `# 文件助手

你是一个 Agent（代理）。

## 能力
你可以使用以下工具：
- **时间工具**：查询当前日期和时间
- **文件系统读写改**
- **浏览器的唤起、使用和销毁**

## 行为规则
1. 收到任务后，先判断是否需要调用工具
2. 工具调用按需进行，不要猜测文件是否存在——先用 list_files 确认
3. 每次工具调用后，根据返回结果决定下一步
4. 任务完成后给出简洁的总结
5. 如果工具返回错误，解释原因并给出建议`;

export class MomokaAgentCore implements MomokaAgent {
  readonly projectRoot: string;
  readonly memoryStore: MemoryStore;
  readonly sessionManager: SessionManager;
  readonly workspaces: WorkspaceManager;
  agentRegistry?: AgentRegistry;

  constructor(private readonly options: MomokaAgentOptions) {
    this.projectRoot = resolveProjectRoot(options.projectRoot);
    initSettings(this.projectRoot);
    const paths = defaultPaths(this.projectRoot);
    this.memoryStore = new MemoryStore(paths.dataDir);
    this.sessionManager = new SessionManager(paths.dataDir);
    this.workspaces = options.workspaceManager ?? new WorkspaceManager();
    this.agentRegistry = options.agentRegistry;
  }

  get memory() {
    return {
      recordOutput: this.memoryStore.recordOutput.bind(this.memoryStore),
      getOutput: this.memoryStore.getOutput.bind(this.memoryStore),
      recordJudgment: this.memoryStore.recordJudgment.bind(this.memoryStore),
    };
  }

  /**
   * 按会话归属 Agent 的 kind 裁剪本轮模型可见工具表：值日生（dispatcher）只保留调度类白名单
   * （toolSpecsForKind），让「提示词只允许 run_momoka_cli」落到工具层；其余角色返回 undefined = 全量。
   */
  private async toolsForSession(sessionId: string | null | undefined): Promise<readonly unknown[] | undefined> {
    if (!sessionId || !this.agentRegistry) return undefined;
    const record = await this.agentRegistry.agentBySessionId(sessionId);
    return isDispatcherAgent(record) ? toolSpecsForKind("dispatcher") : undefined;
  }

  /**
   * 组装 system prompt：人格层（Agent role / Settings 默认人格）+ 平台规则层（SYSTEM_RULES.md） + 技能/记忆。
   * - role：Agent 自定义 system；未显式传入且 sessionId 可反查时自动取 AgentRecord.role；
   *   等于 DEFAULT_SYSTEM_PROMPT 视为“未自定义”，改用 Settings 默认人格；
   * - agentPersona：Settings 默认人格，未传入时自动 loadSettings；未设置用内置 DEFAULT_AGENT_PERSONA。
   * - 平台规则（安全/命令行/会话引用协议）对所有 Agent 固定附加。
   */
  async buildSystemPrompt(input: {
    workDir?: string;
    topic?: string;
    message?: string;
    sessionId?: string | null;
    role?: string | null;
    agentPersona?: string | null;
  } = {}): Promise<string> {
    let customRole = input.role?.trim() ?? "";
    let isDispatcher = false;
    if (input.sessionId && this.agentRegistry) {
      const record = await this.agentRegistry.agentBySessionId(input.sessionId);
      isDispatcher = isDispatcherAgent(record);
      customRole = input.role?.trim() ?? record?.role?.trim() ?? "";
    }
    // 值日生（dispatcher）单源：无论 agents.json 里存的旧 role 如何，一律用后端 DISPATCHER 常量，
    // 避免“代码副本 vs 实例快照”双源漂移。兼容旧实例（无 kind 但名为值日生）。
    if (isDispatcher) {
      customRole = DISPATCHER_SYSTEM_PROMPT;
    }
    let personaText = input.agentPersona?.trim();
    if (!personaText) {
      try { personaText = (await loadSettings()).agentPersona?.trim() ?? ""; } catch { /* settings 读取失败回落默认 */ }
    }
    // 人格层：自定义 role（≠默认占位）优先；否则 Settings 默认人格；再否则内置默认
    const persona = (customRole && customRole !== DEFAULT_SYSTEM_PROMPT)
      ? customRole
      : (personaText || DEFAULT_AGENT_PERSONA);
    // 平台规则层（恒定附加）
    let rules = "";
    try { rules = await readFile(path.join(this.projectRoot, "prompts", "SYSTEM_RULES.md"), "utf8"); } catch { /* fallback */ }
    let prompt = persona;
    if (rules.trim()) prompt += `\n\n${rules.trim()}`;
    // 角色扮演槽位（前缀结构的最内层）：只影响称呼与语气，放 system 最末。
    // 改人格只会让槽位之后的字节失效，前面的规则层仍可被上游前缀缓存命中。
    return await this.fillRoleplaySlot(prompt);
  }

  /**
   * 填充角色扮演槽位。
   * - 槽位标记由人格文本自身提供（<!-- roleplay:start --> … <!-- roleplay:end -->）；
   * - 内容取自 prompts/ROLEPLAY.md（可选）；
   * - 内容为空时**整块删除**（含标题行），保证 system 前后字节稳定。
   */
  private async fillRoleplaySlot(prompt: string): Promise<string> {
    const start = prompt.indexOf(ROLEPLAY_SLOT_START);
    const end = prompt.indexOf(ROLEPLAY_SLOT_END);
    if (start < 0 || end < 0 || end < start) return prompt;
    let text = "";
    try {
      text = (await readFile(path.join(this.projectRoot, "prompts", "ROLEPLAY.md"), "utf8")).trim();
    } catch {
      // 未提供角色扮演内容：保持空槽位
    }
    const before = prompt.slice(0, start);
    const after = prompt.slice(end + ROLEPLAY_SLOT_END.length);
    if (!text) {
      return `${before}${after}`.replace(/\n{3,}/gu, "\n\n").trimEnd();
    }
    return `${before}${ROLEPLAY_SLOT_START}\n${text}\n${ROLEPLAY_SLOT_END}${after}`;
  }

  /**
   * 本轮动态上下文：工作目录 / 命中技能 / 长期记忆。
   *
   * 【重要】不要把这些放回 system：它们每轮都在变（技能按关键词、记忆按主题），
   * 放进 system 会让上游前缀缓存**每一轮都失效**。它们只应出现在末尾的 user 消息里。
   */
  private async buildTurnContext(input: { workDir?: string; topic?: string; message?: string }): Promise<string> {
    const sections: string[] = [];
    if (input.workDir) sections.push(`## Current Work Directory\n${input.workDir}`);

    // 渐进披露：任务命中技能关键词时，注入相关技能内容（保持提示词精简）
    const matched = matchSkills(input.topic ?? "", input.message ?? "", await loadSkillIndex(this.projectRoot));
    if (matched.length > 0) {
      const contents: string[] = [];
      for (const skill of matched) {
        const content = await loadSkillContent(this.projectRoot, skill);
        if (content) contents.push(`### ${skill.name}${skill.description ? `（${skill.description}）` : ""}\n${content}`);
      }
      if (contents.length > 0) sections.push(`## 可用技能（按需使用）\n${contents.join("\n\n")}`);
    }

    // 长期记忆：按主题注入相关跨会话记忆
    if (input.topic) {
      const memories = await this.memoryStore.searchLongTerm(input.topic);
      if (memories.length > 0) {
        sections.push(`## 相关长期记忆\n${memories.map((memory) => `- ${memory.content}`).join("\n")}`);
      }
    }

    return sections.join("\n\n");
  }

  /** 展开消息引用句柄 &msg_<messageId>（去掉 msg_ 前缀的短 id）：替换为源消息全文，供模型精确回溯 */
  private async expandMessageRefs(text: string): Promise<string> {
    const tokenRe = /&msg_([A-Za-z0-9_-]+)/g;
    const matches = text.match(tokenRe);
    if (!matches) return text;
    let out = text;
    const seen = new Set<string>();
    for (const token of matches) {
      const shortId = token.replace(/^&msg_/, "");
      const fullId = shortId.startsWith("msg_") ? shortId : `msg_${shortId}`;
      if (seen.has(fullId)) continue;
      seen.add(fullId);
      const ref = await this.sessionManager.findMessageById(fullId);
      if (!ref) continue;
      const block = `\n\n[引用消息 · ${ref.sessionName}]
${ref.message.content}`;
      const escaped = token.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      out = out.replace(new RegExp(escaped, "g"), block);
    }
    return out;
  }

  async chat(request: ChatRequest): Promise<ChatResponse> {
    const message = request.message.trim();
    if (!message) throw new MomokaHttpError(400, "Message cannot be empty");
    // 同一会话串行化：并发 run 会互相踩会话（详见 withSessionLock 注释）
    return await withSessionLock(request.sessionId ?? null, () => this.runChat(request));
  }

  private async runChat(request: ChatRequest): Promise<ChatResponse> {
    const message = request.message.trim();
    const runId = makeId("run");
    const outputId = request.outputId?.trim() || makeId("out");
    const sessionId = request.sessionId ?? null;
    let workDir = request.workDir;
    // 会话历史：角色分离的消息数组（只追加，保证前缀稳定）；不再压平成一段文本
    let historyMessages: Array<{ role: "system" | "user" | "assistant"; content: string }> = [];
    if (sessionId) {
      const session = await this.sessionManager.getSession(sessionId);
      if (!session) throw new MomokaHttpError(404, `Unknown session: ${sessionId}`);
      workDir = session.folderPath;
      if (!request.transient) {
        await this.sessionManager.addMessage(sessionId, "user", message);
        // 自动生成标题：若是首条用户消息（messageCount 从 0 变 1），生成标题并更新会话
        const updatedSession = await this.sessionManager.getSession(sessionId);
        if (updatedSession && updatedSession.messageCount === 1) {
          const title = await this.generateTitle(message);
          await this.sessionManager.updateSession(sessionId, { name: title });
          // 名字留空的 Agent（autoName）：首条对话生成标题后回填其名字
          await this.applyAutoAgentName(sessionId, title);
        }
      }
      // transient（系统注入）不落历史：历史取全量；普通消息：历史排除刚写入的这条
      const stored = await this.sessionManager.getMessages(sessionId, null);
      historyMessages = buildBoundedHistoryMessages(
        request.transient ? stored : stored.slice(0, -1),
      ).messages as Array<{ role: "system" | "user" | "assistant"; content: string }>;
    }
    // &msg_<messageId> 引用句柄展开：仅在送入模型时展开，落盘保留原始句柄以便回溯
    const expandedMessage = await this.expandMessageRefs(message);
    const tracePath = await createRunTrace(workDir ?? this.projectRoot);
    const topic = request.topic?.trim() || message.slice(0, 80);
    // 流式落盘：agent 输出随 token 增量写入会话日志。
    // 连接只是在线投影——前端断开/收起磁贴不影响写入，重开窗口即读到进行中内容。
    // 同时记录 tool/text 顺序时间线（timeline）与分段文本（segments），
    // 供前端在重开/刷新后还原“文字段 → 工具卡片 → 文字段”的真实交错顺序。
    let streamingMessage: SessionMessage | null = null;
    // timeline: "text" 表示一段文本，number 表示 toolCalls 下标（工具）；segments 按文本段出现顺序归档
    const timeline: Array<"text" | number> = [];
    const segments: string[] = [];
    let segmentBuf = "";
    let segmentHasText = false;
    let toolCallIndex = 0;
    // 流式工具增量集合（task 完成前即可恢复；finish 时被 result.toolCalls 覆盖）
    const streamingTools: Array<{ tool: string; args: string; result: string }> = [];
    if (sessionId) {
      streamingMessage = await this.sessionManager.beginStreamingMessage(sessionId);
    }
    const onEvent = (event: StreamEvent): void => {
      const sm = streamingMessage;
      const sid = sessionId;
      if (event.type === "token" && sm && sid) {
        this.sessionManager.appendStreamingMessage(sid, sm.id, event.text);
        segmentBuf += event.text;
        if (!segmentHasText) {
          timeline.push("text");
          segmentHasText = true;
          // 文本段开始即落盘时间线，流式恢复时能见到
          void this.sessionManager.updateStreamingMessage(sid, sm.id, { timeline });
        }
      } else if (event.type === "tool_start") {
        // 工具出现时先归档前一段文本，再记录工具下标（与 model-client 的 toolCalls.push 顺序一致）
        if (segmentHasText) {
          segments.push(segmentBuf);
          segmentBuf = "";
          segmentHasText = false;
        }
        streamingTools.push({ tool: event.name, args: event.args, result: "" });
        timeline.push(toolCallIndex);
        toolCallIndex += 1;
        // 工具开始即增量落盘：关闭重开/轮询时可以恢复“进行中的工具卡”
        if (sm && sid) {
          void this.sessionManager.updateStreamingMessage(sid, sm.id, {
            toolCalls: streamingTools,
            timeline,
          });
        }
      } else if (event.type === "tool_result") {
        for (let i = streamingTools.length - 1; i >= 0; i -= 1) {
          if (streamingTools[i].tool === event.name && !streamingTools[i].result) {
            streamingTools[i].result = event.result;
            break;
          }
        }
        if (sm && sid) {
          void this.sessionManager.updateStreamingMessage(sid, sm.id, {
            toolCalls: streamingTools,
          });
        }
      }
      // tool_result 的其它细节由 request.onEvent 透传；timeline 不再推进（工具下标已记录）
      request.onEvent?.(event);
    };
    let result: ModelRunResult;
    try {
      const turnContext = await this.buildTurnContext({ workDir, topic, message: expandedMessage });
      result = await this.options.modelClient.run(
        [turnContext, "## Current User Request", expandedMessage].filter(Boolean).join("\n\n"),
        {
        systemPrompt: await this.buildSystemPrompt({ workDir, topic, message: expandedMessage, sessionId }), topic, workDir, tracePath, sessionId, runId, matchedSkills: [], requestKind: "chat",
        tools: await this.toolsForSession(sessionId),
        historyMessages,
        onEvent, signal: request.signal,
        sessionManager: this.sessionManager, agentRegistry: this.agentRegistry,
        },
      );
      // 空响应兜底：上游只回空流且没有任何工具调用（连"干了活"的证据都没有）→ 本轮必然无产出。
      // 必须当失败：否则状态机会记 completed，值日生判读会拿到"完成"假信号，用户被告知成功。
      // 注意：有工具调用但空收尾的情况**不在此拦**——那属于"产出是否有效"的判读范畴，
      // 由收尾链路（dispatch-ledger → 唤醒值日生判读）处理，这里只兜硬失败。
      if (!result.output.trim() && (result.toolCalls ?? []).length === 0) {
        await appendTraceEvent(tracePath, "final_answer", { response: result.output, usage: result.usage, emptyResponse: true });
        throw new MomokaHttpError(502, "模型返回空响应（上游只回了空流），本轮没有任何产出");
      }
    } catch (error) {
      // 收尾标记：主动停止→stopped，其他异常→error（原异常继续抛给路由层）
      if (sessionId && streamingMessage) {
        const isAbort = error instanceof Error && error.name === "AbortError";
        // 空响应时补一句可读说明：否则会话里只留一条空消息，调度者/用户都看不出发生了什么
        const isEmptyResponse = error instanceof MomokaHttpError && error.message.includes("空响应");
        await this.sessionManager
          .finishStreamingMessage(sessionId, streamingMessage.id, {
            status: isAbort ? "stopped" : "error",
            ...(isEmptyResponse ? { content: "（本轮无任何输出：上游模型返回空流，已按失败处理）" } : {}),
          })
          .catch(() => undefined);
      }
      throw error;
    }
    await this.recordRunUsage(result, sessionId);
    await appendTraceEvent(tracePath, "final_answer", { response: result.output, usage: result.usage });
    await this.memoryStore.recordOutput({ outputId, prompt: message, response: result.output, topic, matchedSkills: [], toolCalls: result.toolCalls ?? [], sessionId });
    if (sessionId && streamingMessage) {
      // 归档最后一段文本（若存在）
      if (segmentHasText) {
        segments.push(segmentBuf);
        segmentBuf = "";
        segmentHasText = false;
      }
      await this.sessionManager.finishStreamingMessage(sessionId, streamingMessage.id, {
        outputId,
        toolCalls: result.toolCalls ?? [],
        segments,
        timeline,
      });
    } else if (sessionId) {
      await this.sessionManager.addMessage(sessionId, "agent", result.output, { outputId, toolCalls: result.toolCalls ?? [] });
    }
    await saveRunSnapshot({ runId, workDir: workDir ?? this.projectRoot, tracePath, sessionId: sessionId ?? undefined }).catch(async (error: unknown) => {
      await appendTraceEvent(tracePath, "snapshot_failed", { message: error instanceof Error ? error.message : String(error) });
    });
    return { runId, outputId, topic, response: result.output, annotationRuntimeContext: "", outputAssessment: accept, toolCalls: result.toolCalls ?? [], matchedSkills: [], skillReasons: [], sessionId };
  }

  async judge(request: JudgeRequest): Promise<JudgeResponse> {
    if (!Number.isInteger(request.score) || request.score < 1 || request.score > 7) throw new MomokaHttpError(400, "Score must be an integer from 1 to 7");
    const output = await this.memoryStore.getOutput(request.outputId);
    if (!output) throw new MomokaHttpError(404, `Unknown output_id: ${request.outputId}`);
    const judgment = await this.memoryStore.recordJudgment(request);
    await this.memoryStore.promoteToLongTerm(judgment);
    const label = LIKERT_LABELS[request.score] ?? "";
    const reflection = analyzeJudgment({ score: request.score, label, annotatedText: judgment.context, topic: judgment.topic, userComment: judgment.comment });
    const base: JudgeResponse = { runId: makeId("run"), outputId: request.outputId, score: request.score, label, analysis: reflection.summary, reflection, annotatedText: judgment.context, comment: judgment.comment, preferenceUpdate: { updated: false, promoted: [] }, evolutionProposals: [] };
    if (!request.continue) return base;
    const sessionId = output.sessionId ?? null;
    const workDir = sessionId ? (await this.sessionManager.getSession(sessionId))?.folderPath : undefined;
    const continuationOutputId = makeId("out");
    const tracePath = await createRunTrace(workDir ?? this.projectRoot);
    const result = await this.options.modelClient.run(buildFollowupPrompt({ topic: output.topic, outputText: output.response, judgment: { ...judgment, label }, reflection }), {
      systemPrompt: await this.buildSystemPrompt({ workDir, topic: output.topic, sessionId }), topic: output.topic, workDir, tracePath, sessionId, runId: base.runId, matchedSkills: [], requestKind: "continuation",
      tools: await this.toolsForSession(sessionId),
      sessionManager: this.sessionManager, agentRegistry: this.agentRegistry,
    });
    await this.recordRunUsage(result, sessionId);
    await appendTraceEvent(tracePath, "final_answer", { response: result.output, usage: result.usage });
    await this.memoryStore.recordOutput({ outputId: continuationOutputId, prompt: output.prompt, response: result.output, topic: output.topic, matchedSkills: [], toolCalls: result.toolCalls ?? [], sessionId });
    if (sessionId) await this.sessionManager.addMessage(sessionId, "agent", result.output, { outputId: continuationOutputId, toolCalls: result.toolCalls ?? [] });
    await saveRunSnapshot({ runId: base.runId, workDir: workDir ?? this.projectRoot, tracePath, sessionId: sessionId ?? undefined }).catch(async (error: unknown) => {
      await appendTraceEvent(tracePath, "snapshot_failed", { message: error instanceof Error ? error.message : String(error) });
    });
    return { ...base, nextOutputId: continuationOutputId, nextResponse: result.output, nextAnnotationRuntimeContext: "", nextOutputAssessment: accept, nextToolCalls: result.toolCalls ?? [], nextSkillReasons: [] };
  }

  async listApprovals(workDir: string) { return await (await this.workspaces.approvalStore(workDir)).list(); }
  getSandboxEnabled(): boolean { return getSandboxFlag(); }
  async setSandboxEnabled(enabled: boolean): Promise<boolean> { return await persistSandboxFlag(enabled); }
  async decideApproval(workDir: string, id: string, decision: "approved" | "rejected", operator: string) {
    const store = await this.workspaces.approvalStore(workDir);
    try {
      const approval = await store.decide(id, decision, operator);
      if (decision === "rejected") return { approval, event: null };
      // 幂等：审批已执行过（重复提交/刷新后重试）不再执行
      if (approval.status === "executed") return { approval, event: null, alreadyDecided: true };
      const completed = await store.complete(approval.id, await executeApprovedToolCall(approval.toolName, approval.args, approval.targetWorkspace));
      const event = createApprovalExecutionEvent(completed);
      if (event.sessionId && await this.sessionManager.getSession(event.sessionId)) {
        event.messageId = (await this.sessionManager.addMessage(event.sessionId, "agent", event.message, { eventType: "approval_execution", approvalId: event.approvalId, toolName: event.toolName, toolArgs: event.args, toolResult: event.result, runId: event.runId })).id;
      }
      return { approval: completed, event };
    } catch (error) {
      if (error instanceof ApprovalError) {
        // 已决冲突收敛为幂等返回（含并发锁拒绝），不再让前端“卡住”报错
        if (error.message.includes("already been decided") || error.message.includes("already being decided")) {
          const records = await store.list();
          const current = records.find((candidate) => candidate.id === id);
          if (current) return { approval: current, event: null, alreadyDecided: true };
        }
        throw new MomokaHttpError(409, error.message);
      }
      throw error;
    }
  }
  /** 把本轮 run 的 usage 记入绑定该 session 的 Agent（供磁贴上下文指标展示） */
  private async recordRunUsage(result: ModelRunResult, sessionId: string | null | undefined): Promise<void> {
    // 注意：这里必须用 this.agentRegistry，而不是 this.options.agentRegistry。
    // server.ts 是在构造后通过 `agent.agentRegistry = registry` 注入注册表的，
    // options 里从来没有这个字段 → 用 options 会永远早退，contextStats 一直是 0（历史遗留缺陷）。
    const registry = this.agentRegistry;
    if (!registry || !sessionId || !result.usage?.promptTokens) return;
    const agent = (await registry.listAgents()).find((candidate) => candidate.sessionId === sessionId);
    if (!agent) return;
    await registry.updateContextStats(agent.id, buildContextStats(result.usage, agent.model));
  }

  /**
   * 名字留空创建的 Agent（autoName）：首条对话生成标题后回填注册表名字。
   * 失败不影响本轮对话；回填后名字经 SSE 状态广播回显到磁贴。
   */
  private async applyAutoAgentName(sessionId: string, title: string): Promise<void> {
    const registry = this.agentRegistry ?? this.options.agentRegistry;
    if (!registry) return;
    try {
      const agent = (await registry.listAgents()).find((candidate) => candidate.sessionId === sessionId);
      if (!agent?.autoName) return;
      await registry.applyAutoName(agent.id, title);
    } catch {
      // 自动命名是锦上添花：失败不影响首轮对话
    }
  }

  /**
   * 根据首条用户消息自动生成会话标题（2-8 字），供会话名与 autoName Agent 名字复用。
   * 优先使用设置页“低消费/廉价档”（low tier）模型；未配置或失败时回落主模型；
   * 再失败则回落到首条消息截取。
   */
  private async generateTitle(message: string): Promise<string> {
    const prompt = `请为以下用户消息生成一个 2-8 字的简短标题，只输出标题本身，不要任何解释或标点：

${message}`;
    const context: ModelRunContext = {
      systemPrompt: "你是一个标题生成助手，只输出 2-8 字的简短标题。",
      topic: "title_generation",
      workDir: this.projectRoot,
      tracePath: "",
      sessionId: null,
      runId: "title_gen",
      matchedSkills: [],
      requestKind: "chat",
      onEvent: undefined,
      signal: undefined,
    };
    const cheapClient = this.options.titleModelClient;
    if (cheapClient && cheapClient !== this.options.modelClient) {
      try {
        const { output } = await cheapClient.run(prompt, context);
        const title = output.trim().slice(0, 12);
        if (title) return title;
      } catch {
        // 廉价档未配置 / 调用失败：回落主模型
      }
    }
    try {
      const { output } = await this.options.modelClient.run(prompt, context);
      const title = output.trim().slice(0, 12);
      return title || message.slice(0, 8);
    } catch {
      return message.slice(0, 8);
    }
  }

  async createSession(goal: string, folderPath: string) {
    if (!goal.trim() || !folderPath.trim()) throw new MomokaHttpError(400, "Session goal and working directory are required");
    const details = await stat(folderPath).catch(() => null);
    if (!details?.isDirectory()) throw new MomokaHttpError(400, `Directory does not exist: ${folderPath}`);
    return await this.sessionManager.createSession(goal.trim(), path.resolve(folderPath));
  }
  async listDirectories(pathText?: string) {
    if (!pathText?.trim()) return { path: "", parent: null, entries: await listWindowsDrives() };
    const current = path.resolve(pathText); const details = await stat(current).catch(() => null);
    if (!details?.isDirectory()) throw new MomokaHttpError(400, `Path is not a directory: ${current}`);
    const { readdir } = await import("node:fs/promises");
    const entries = (await readdir(current, { withFileTypes: true })).filter((entry) => entry.isDirectory()).sort((a, b) => a.name.localeCompare(b.name)).map((entry) => ({ name: entry.name, path: path.join(current, entry.name), is_dir: true }));
    return { path: current, parent: path.dirname(current) === current ? null : path.dirname(current), entries };
  }
}

async function listWindowsDrives() { const entries: Array<{ name: string; path: string; is_dir: true }> = []; for (const letter of "ABCDEFGHIJKLMNOPQRSTUVWXYZ") { const drive = `${letter}:\\`; try { await access(drive); entries.push({ name: drive.slice(0, -1), path: drive, is_dir: true }); } catch { /* absent */ } } return entries; }
export { MomokaHttpError };
export function createMomokaAgent(options: MomokaAgentOptions): MomokaAgentCore { return new MomokaAgentCore(options); }
