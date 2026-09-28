import { access, readFile, stat } from "node:fs/promises";
import path from "node:path";

import { LIKERT_LABELS, defaultPaths, resolveProjectRoot } from "./config.js";
import { analyzeJudgment, buildFollowupPrompt } from "./feedback.js";
import { MemoryStore, USER_SCOPE, PROJECT_SCOPE, type MemoryScopeRef } from "./memory.js";
import { IndexStore } from "./index-store.js";
import { extractFromJudgment } from "./memory-extract.js";
import { formatRecallLines, recallDigest } from "./memory-retrieval.js";
import { appendDeadLetter, classifyRunFailure, withRetry } from "./run-checkpoint.js";
import {
  buildEmptyContinuationNote,
  buildQuietTurnNudge,
} from "./empty-response.js";
import { buildTaskInputBlock } from "./dispatch-fidelity.js";
import { PlanStore } from "./plan-store.js";
import { SessionManager, type SessionMessage } from "./session-manager.js";
import {
  buildCompactHandoff,
  CompactHandoffError,
  formatMessagesForHandoff,
  type BuildCompactHandoffResult,
  type CompactHandoffCheckpoint,
  COMPACT_HANDOFF_SYSTEM_PROMPT,
} from "./compact-handoff.js";
import { MomokaHttpError } from "./http-error.js";
import type { AgentRegistry } from "./agent-registry.js";
import { describeSelfBlock } from "./agent-identity.js";
import { DEFAULT_SYSTEM_PROMPT, DISPATCHER_SYSTEM_PROMPT, isDispatcherAgent } from "./agent-registry.js";
import { WorkspaceManager } from "./workspace-manager.js";
import { ApprovalError, createApprovalExecutionEvent } from "./approvals.js";
import { executeApprovedToolCall, TOOL_SPECS, toolSpecsForKind } from "./tools.js";
import { estimateTokens, formatMessages } from "./context.js";
import { buildContextStats, modelContextWindow } from "./context-stats.js";
import { loadSkillContent, loadSkillIndex, matchSkills } from "./skills.js";
import { buildTurnModeBlock, resolveTurnMode } from "./turn-mode.js";
import { buildDispatchSnapshot } from "./dispatch-snapshot.js";
import { appendTraceEvent, containsSensitiveTraceContent, createRunTrace } from "./trace.js";
import { saveRunSnapshot } from "./snapshot.js";
import { initSettings, isSandboxEnabled as getSandboxFlag, setSandboxEnabled as persistSandboxFlag } from "./settings.js";
import { loadSettings } from "./settings-store.js";
import { ExperienceMemoryService, type ExperienceEvent } from "./experience-memory.js";
import type { ChatRequest, ChatResponse, JudgeRequest, JudgeResponse, ModelClient, ModelRunContext, ModelRunResult, MomokaAgent, StreamEvent } from "./types.js";

interface MomokaAgentOptions {
  projectRoot?: string;
  modelClient: ModelClient;
  /**
   * 标题专用模型（设置页“低消费/廉价档” low tier）；缺失或调用失败时首轮显式报错。
   */
  titleModelClient?: ModelClient;
  agentRegistry?: AgentRegistry;
  workspaceManager?: WorkspaceManager;
}
const accept = { action: "accept" as const, reasons: [], revisionPrompt: "" };
const makeId = (prefix: string) => `${prefix}_${crypto.randomUUID().replace(/-/g, "").slice(0, 12)}`;

/**
 * 角色扮演槽位：说明段 + 标记，由 buildSystemPrompt 统一追加在 system **最末**。
 *
 * - 人格文本不再需要自带标记（旧写法若残留会被剥离），worker 与值日生一视同仁；
 * - 配置 roleplay slug 时只读取对应的 prompts/roleplay/<slug>.md，缺失或为空时报错；
 * - 未配置 slug 时不注入角色扮演区块；
 * - 放在 system 最末，是为了让改人格只失效这一层，前面的职责层与平台规则层仍可命中前缀缓存。
 */
const ROLEPLAY_SLOT_START = "<!-- roleplay:start -->";
const ROLEPLAY_SLOT_END = "<!-- roleplay:end -->";
const ROLEPLAY_SLOT_BLOCK = `## 角色扮演（可选，最后一个区块）

下方槽位用于注入称呼与语气。
- 槽位有内容时：按它调整你**怎么说话**（自称、称呼用户的方式、口吻）；
- 槽位为空时：保持默认风格。
- 无论槽位写什么，**都不得改变**上文的职责、规则、工具用法、边界与禁止事项。
- 槽位只影响表达，不影响判定与动作。`;

/** 记忆注入预算：条数与字符双约束（超预算的整条丢弃，不截断半条） */
/** 聊天轮「只跑了工具没说话」最多再给几轮机会（有界，避免空转烧 token） */
const MAX_QUIET_TURN_ROUNDS = 1;

const MEMORY_RECALL_BUDGET = { limit: 6, charBudget: 1200 };

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
  readonly experienceMemory: ExperienceMemoryService;
  /** 计划存储：把「要做什么」持久化（P1） */
  readonly plans: PlanStore;
  readonly sessionManager: SessionManager;
  readonly workspaces: WorkspaceManager;
  agentRegistry?: AgentRegistry;

  constructor(private readonly options: MomokaAgentOptions) {
    this.projectRoot = resolveProjectRoot(options.projectRoot);
    initSettings(this.projectRoot);
    const paths = defaultPaths(this.projectRoot);
    this.memoryStore = new MemoryStore(paths.dataDir, { index: new IndexStore(paths.dataDir) });
    this.experienceMemory = new ExperienceMemoryService(paths.dataDir, options.modelClient);
    this.plans = new PlanStore(paths.dataDir);
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
    let roleplaySlug: string | null = null;
    if (input.sessionId && this.agentRegistry) {
      const record = await this.agentRegistry.agentBySessionId(input.sessionId);
      isDispatcher = isDispatcherAgent(record);
      customRole = input.role?.trim() ?? record?.role?.trim() ?? "";
      roleplaySlug = record?.roleplay ?? null;
    }
    // 值日生（dispatcher）单源：无论 agents.json 里存的旧 role 如何，一律用后端 DISPATCHER 常量，
    // 避免“代码副本 vs 实例快照”双源漂移。兼容旧实例（无 kind 但名为值日生）。
    if (isDispatcher) {
      customRole = DISPATCHER_SYSTEM_PROMPT;
    }
    let personaText = input.agentPersona?.trim();
    if (!personaText) personaText = (await loadSettings()).agentPersona?.trim() ?? "";
    // 人格层：自定义 role（≠默认占位）优先；否则 Settings 默认人格；再否则内置默认
    const persona = (customRole && customRole !== DEFAULT_SYSTEM_PROMPT)
      ? customRole
      : (personaText || DEFAULT_AGENT_PERSONA);
    // 兼容旧写法：人格文本里残留的槽位标记一律剥离（槽位改由运行时统一追加在最末）
    const personaClean = persona.replace(ROLEPLAY_SLOT_START, "").replace(ROLEPLAY_SLOT_END, "");
    // 平台规则层（恒定附加）
    const rules = await readFile(path.join(this.projectRoot, "prompts", "SYSTEM_RULES.md"), "utf8");
    if (!rules.trim()) throw new Error("Required prompt is empty: prompts/SYSTEM_RULES.md");
    let prompt = personaClean;
    if (rules.trim()) prompt += `\n\n${rules.trim()}`;
    // 角色扮演槽位（system 最末）：只影响称呼与语气。
    // 改人格只会让槽位这一层变化，前面的职责层与平台规则层仍可被上游前缀缓存命中。
    return await this.fillRoleplaySlot(prompt, roleplaySlug);
  }

  /**
   * 追加角色扮演槽位（system 最末）。
   * - 无内容：整块不追加，system 与未接线时逐字节一致；
   * - 有内容：追加说明段 + 标记包裹的人格文本。
   */
  private async fillRoleplaySlot(prompt: string, roleplaySlug?: string | null): Promise<string> {
    const text = await this.loadRoleplayText(roleplaySlug);
    if (!text) return prompt;
    return `${prompt}\n\n${ROLEPLAY_SLOT_BLOCK}\n\n${ROLEPLAY_SLOT_START}\n${text}\n${ROLEPLAY_SLOT_END}`;
  }

  /**
   * 读取明确配置的 prompts/roleplay/<slug>.md。未配置角色扮演时不注入该层；
   * 已配置的提示词不存在或为空时显式失败，不改用另一份提示词。
   */
  private async loadRoleplayText(roleplaySlug?: string | null): Promise<string> {
    const slug = (roleplaySlug ?? "").trim().toLowerCase();
    if (!slug) return "";
    if (!/^[a-z0-9][a-z0-9-]*$/u.test(slug)) throw new Error(`Invalid roleplay prompt slug: ${slug}`);
    const file = path.join(this.projectRoot, "prompts", "roleplay", `${slug}.md`);
    const text = (await readFile(file, "utf8")).trim();
    if (!text) throw new Error(`Configured roleplay prompt is empty: ${file}`);
    return text;
  }

  /**
   * 本轮动态上下文：工作目录 / 命中技能 / 长期记忆。
   *
   * 【重要】不要把这些放回 system：它们每轮都在变（技能按关键词、记忆按主题），
   * 放进 system 会让上游前缀缓存**每一轮都失效**。它们只应出现在末尾的 user 消息里。
   */
  private async buildTurnContext(input: { workDir?: string; topic?: string; message?: string; sessionId?: string | null; tracePath?: string }): Promise<string> {
    const sections: string[] = [];
    // 值日生：台账快照放最前（在途状态的唯一事实源，不靠历史回忆）
    const snapshot = await this.buildDispatcherSnapshot(input.sessionId);
    if (snapshot) sections.push(snapshot);
    // 自我身份：执行者要用 id 才能读自己的历史/搜自己的会话，不给就会靠猜（实测烧掉一整轮）
    const self = await this.buildSelfIdentityBlock(input.sessionId);
    if (self) sections.push(self);
    if (input.workDir) sections.push(`## Current Work Directory\n${input.workDir}`);

    // L5 按角色换视图：执行者额外得到「本次任务的关键输入」层（URL/路径单独成字段）；
    // 值日生不需要——她的输入在台账状态卡里（见 buildDispatcherSnapshot）。
    if (!snapshot) {
      const taskInputs = buildTaskInputBlock(input.message ?? "");
      if (taskInputs) sections.push(taskInputs);
    }

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

    // 长期记忆：按作用域链混合检索 → 预算裁剪 → 带召回理由与来源注入
    if (input.topic) {
      const refs = await this.memoryRefsForSession(input.sessionId);
      const recalled = await this.memoryStore.recallScopes(input.topic, refs, MEMORY_RECALL_BUDGET);
      if (recalled.length > 0) {
        sections.push(`## 相关长期记忆\n${formatRecallLines(recalled).join("\n")}`);
        // 可解释性：把本轮召回的记忆与理由写进 trace，便于回溯提示词里为什么有这段
        if (input.tracePath) {
          await appendTraceEvent(input.tracePath, "memory_recall", {
            count: recalled.length,
            items: recallDigest(recalled),
          }).catch(() => undefined);
        }
      }
    }

    return sections.join("\n\n");
  }

  /**
   * 自我身份块（名字 / agent_id / 本会话 session_id / 角色 / 工作目录）。
   * 实测：不注入时执行者会猜自己的会话 id（ses_xxx? tile_xxx?），白烧一轮工具调用。
   */
  private async buildSelfIdentityBlock(sessionId?: string | null): Promise<string | null> {
    if (!sessionId || !this.agentRegistry) return null;
    try {
      const record = await this.agentRegistry.agentBySessionId(sessionId);
      if (!record) return null;
      return describeSelfBlock({
        id: record.id,
        name: record.name,
        sessionId: record.sessionId,
        isDispatcher: isDispatcherAgent(record),
        workspaceDir: record.workspaceDir,
      });
    } catch {
      return null; // 取不到身份不影响本轮
    }
  }

  /**
   * 值日生的台账快照（非 dispatcher 会话返回 null）：未结单 + 最近交付 + 待拍板计数。
   * 台账是调度状态的唯一事实源，但原本不在模型上下文里——快照把它每轮带进来，
   * 模型就不必（也不该）从会话历史里推断在途任务。
   */
  private async buildDispatcherSnapshot(sessionId?: string | null): Promise<string | null> {
    if (!sessionId || !this.agentRegistry) return null;
    try {
      const record = await this.agentRegistry.agentBySessionId(sessionId);
      if (!record || !isDispatcherAgent(record)) return null;
      const [all, agents, pending] = await Promise.all([
        this.agentRegistry.dispatches.listAll(),
        this.agentRegistry.listAgents(),
        this.agentRegistry.pendingQuestionsForAgent(record.id),
      ]);
      const targetNames: Record<string, string> = {};
      for (const agent of agents) targetNames[agent.id] = agent.name;
      return buildDispatchSnapshot({
        records: all.filter((entry) => entry.dispatcherId === record.id),
        targetNames,
        pendingQuestions: pending.length,
      });
    } catch {
      return null; // 快照失败不影响本轮
    }
  }

  /** 本会话是否属于值日生（头部保留策略与视图分层用） */
  private async isDispatcherSession(sessionId?: string | null): Promise<boolean> {
    if (!sessionId || !this.agentRegistry) return false;
    try {
      const record = await this.agentRegistry.agentBySessionId(sessionId);
      return Boolean(record && isDispatcherAgent(record));
    } catch {
      return false;
    }
  }

  /** 本轮记忆检索的作用域链：本 Agent 分区 → 项目级 → user 全局 */
  private async memoryRefsForSession(sessionId?: string | null): Promise<MemoryScopeRef[]> {
    const refs: MemoryScopeRef[] = [PROJECT_SCOPE, USER_SCOPE];
    if (!sessionId || !this.agentRegistry) return refs;
    try {
      const record = await this.agentRegistry.agentBySessionId(sessionId);
      if (record) refs.unshift({ scope: "agent", scopeId: record.id });
    } catch { /* 反查不到就只用项目级与 user 作用域 */ }
    return refs;
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

  /** Compact older complete turns into a sidecar handoff; never mutate messages.json. */
  async compactSession(sessionId: string): Promise<BuildCompactHandoffResult> {
    return await withSessionLock(sessionId, async () => {
      const session = await this.sessionManager.getSession(sessionId);
      if (!session) throw new MomokaHttpError(404, `Unknown session: ${sessionId}`);
      const messages = await this.sessionManager.getStoredMessages(sessionId);
      const previous = await this.sessionManager.getCompactHandoff(sessionId);
      const { model, contextWindow } = await this.configuredContextWindow();
      const dynamicContext = await this.buildTurnContext({
        workDir: session.folderPath,
        topic: session.goal || session.name,
        sessionId,
      });
      const agentRecord = this.agentRegistry ? await this.agentRegistry.agentBySessionId(sessionId) : null;
      const activePlans = await this.plans.listPlans({ status: "active", limit: 100 });
      const relevantPlans = agentRecord
        ? activePlans.filter((plan) => plan.dispatcherId === agentRecord.id || plan.steps.some((step) => step.ownerAgentId === agentRecord.id)).slice(0, 3)
        : [];
      const planContext = relevantPlans.map((plan) => [
        `计划 ${plan.id}：${plan.goal}（${plan.status}）`,
        ...plan.steps.map((step) => `- ${step.id} ${step.status}：${step.title}${step.acceptanceCriteria.length ? `；验收：${step.acceptanceCriteria.join(" / ")}` : ""}`),
      ].join("\n")).join("\n\n");
      const runtimeContext = [dynamicContext, planContext ? `## Active Plan State\n${planContext}` : ""].filter(Boolean).join("\n\n");

      const result = await buildCompactHandoff({
        sessionId,
        messages,
        previous,
        contextWindow,
        model,
        runtimeContext,
        idFactory: () => makeId("cmp"),
        summarize: async (input, outputTokenLimit) => {
          let response: ModelRunResult;
          try {
            response = await this.options.modelClient.run(input, {
              systemPrompt: COMPACT_HANDOFF_SYSTEM_PROMPT,
              topic: "Compact Handoff",
              workDir: session.folderPath,
              matchedSkills: [],
              requestKind: "continuation",
              tools: [],
              outputTokenLimit,
            });
          } catch {
            throw new CompactHandoffError("Compact model call failed; the transcript and previous checkpoint were left unchanged.");
          }
          if (containsSensitiveTraceContent(response.output)) {
            throw new CompactHandoffError("The generated handoff contains secret-like content; no checkpoint was saved.");
          }
          return response.output;
        },
      });
      await this.sessionManager.saveCompactHandoff(result.checkpoint);
      return result;
    });
  }

  async getCompactHandoff(sessionId: string): Promise<CompactHandoffCheckpoint | null> {
    const session = await this.sessionManager.getSession(sessionId);
    if (!session) throw new MomokaHttpError(404, `Unknown session: ${sessionId}`);
    return await this.sessionManager.getCompactHandoff(sessionId);
  }

  private async configuredContextWindow(sessionId?: string | null): Promise<{ model: string; contextWindow: number }> {
    const settings = await loadSettings();
    const agentRecord = sessionId && this.agentRegistry ? await this.agentRegistry.agentBySessionId(sessionId) : null;
    const selectedModel = agentRecord?.model?.trim();
    const entry = selectedModel
      ? settings.modelPool.find((item) => item.enabled && item.model.toLowerCase() === selectedModel.toLowerCase())
      : settings.modelPool.find((item) => item.id === settings.tierDefaults.high && item.enabled);
    if (selectedModel && !entry) throw new MomokaHttpError(409, `会话模型「${selectedModel}」不在已启用的模型池中`);
    const model = entry?.model || process.env.MOMOKA_MODEL || "unknown";
    return { model, contextWindow: modelContextWindow(model, entry?.contextWindow) };
  }

  private assertPromptFits(input: {
    systemPrompt: string;
    historyMessages: Array<{ role: string; content: string }>;
    input: string;
    tools?: readonly unknown[];
    contextWindow: number;
    outputTokenLimit: number;
  }): void {
    const toolSpecs = input.tools ?? TOOL_SPECS;
    const estimate = estimateTokens(input.systemPrompt)
      + estimateTokens(formatMessages(input.historyMessages))
      + estimateTokens(input.input)
      + estimateTokens(JSON.stringify(toolSpecs));
    const safetyReserve = Math.ceil(input.contextWindow * 0.08);
    const inputLimit = input.contextWindow - input.outputTokenLimit - safetyReserve;
    if (estimate > inputLimit) {
      throw new MomokaHttpError(
        413,
        `完整的 Compact Handoff、Turns、当前 User Input、系统提示和工具规格估算为 ${estimate} tokens，超出本模型可用输入预算 ${Math.max(0, inputLimit)}。历史未被裁剪；请先点击会话卡片上的 Compact 按钮。`,
      );
    }
  }

  private async runChat(request: ChatRequest): Promise<ChatResponse> {
    const message = request.message.trim();
    const runId = makeId("run");
    const outputId = request.outputId?.trim() || makeId("out");
    const sessionId = request.sessionId ?? null;
    let userMessageId: string | undefined;
    let workDir = request.workDir;
    // 会话历史：角色分离的消息数组（只追加，保证前缀稳定）；不再压平成一段文本
    let historyMessages: Array<{ role: "system" | "user" | "assistant"; content: string }> = [];
    if (sessionId) {
      const session = await this.sessionManager.getSession(sessionId);
      if (!session) throw new MomokaHttpError(404, `Unknown session: ${sessionId}`);
      workDir = session.folderPath;
      if (!request.transient) {
        userMessageId = (await this.sessionManager.addMessage(sessionId, "user", message)).id;
        // 仅自动命名 Agent 需要生成标题；普通会话沿用创建时的用户标题。
        const updatedSession = await this.sessionManager.getSession(sessionId);
        const boundAgent = this.agentRegistry ? await this.agentRegistry.agentBySessionId(sessionId) : null;
        if (updatedSession && updatedSession.messageCount === 1 && boundAgent?.autoName) {
          const title = await this.generateTitle(message);
          await this.sessionManager.updateSession(sessionId, { name: title });
          // 名字留空的 Agent（autoName）：首条对话生成标题后回填其名字
          await this.applyAutoAgentName(sessionId, title);
        }
      }
      const stored = await this.sessionManager.getStoredMessages(sessionId);
      // The latest user message is passed separately as this run's actual input.
      // Compact only changes the prompt projection; it never edits the transcript.
      const forHistory = request.transient ? stored : stored.slice(0, -1);
      if (resolveTurnMode(request) === "chat") {
        const compact = await this.sessionManager.getCompactHandoff(sessionId);
        let activeTurns = forHistory;
        if (compact) {
          const boundary = forHistory.findIndex((item) => item.id === compact.coveredThroughMessageId);
          if (boundary < 0) {
            throw new MomokaHttpError(409, "Compact Handoff 与原始会话边界不匹配；为保护完整历史，本轮未发送。请检查会话恢复状态。");
          }
          historyMessages.push({ role: "system", content: `## Compact Handoff\n${compact.handoff}` });
          activeTurns = forHistory.slice(boundary + 1);
        }
        historyMessages.push(...activeTurns.map((item) => ({
          role: item.role === "user" ? "user" as const : item.role === "system" ? "system" as const : "assistant" as const,
          content: formatMessagesForHandoff([item]),
        })));
      }
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
    // 本轮流式到的思考字数：Proma 口径里「有思考」也算可见产出，不是空响应
    let streamedReasoningChars = 0;
    // 本轮流出的正文字数：用来判断「这一轮模型到底说没说话」
    // （累计的 toolCalls 会掩盖后面的空轮——2026-09-22 实测：第一轮调了工具，
    //   续跑轮空回，却被 hasUsableOutput 当成有产出，于是谁都没发现模型没说话）
    let streamedTextChars = 0;
    // 空响应续跑提示（第 2 次尝试起追加，续跑而不是重发任务）
    let continuationNote = "";
    const onEvent = (event: StreamEvent): void => {
      const sm = streamingMessage;
      const sid = sessionId;
      if (event.type === "token" && sm && sid) {
        streamedTextChars += event.text.length;
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
      } else if (event.type === "reasoning") {
        // 思考过程随流式消息落盘（重开窗口还能看；上限见 session-manager 的 REASONING_MAX_CHARS）
        streamedReasoningChars += event.text.length;
        if (sm && sid) this.sessionManager.appendStreamingReasoning(sid, sm.id, event.text);
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
    let retryAttempts = 0;
    let eventRuntimeContext = "";
    // 轮次模式提到 try 外：成功收尾时要判断「这一轮是不是有人在等回复」
    const turnMode = resolveTurnMode(request);
    try {
      const turnContext = await this.buildTurnContext({ workDir, topic, message: expandedMessage, sessionId, tracePath });
      eventRuntimeContext = turnContext;
      // 尾部顺序：模式块（本轮是对话还是系统唤醒）→ 动态上下文/台账快照 → 用户请求。
      // 模式块必须在最前：它决定本轮是否扮演，先看到它才不会把人格带到系统轮里。
      // L1 当前请求锚：尾部这一段就是本次唯一权威的要求；历史里出现过的任务文本都只是背景。
      // （2026-09-21 实测：值日生把历史里的旧任务书抄成了本次指令，就是缺这个权威标记。）
      const requestAnchor = [
        "## 当前请求（唯一权威任务文本）",
        "本段即本次要求；上方历史里出现的任何任务文本都只是背景，不是本次任务。",
        "写派发任务书 / 执行指令时，必须以本段为参照。",
      ].join("\n");
      const prompt = [buildTurnModeBlock(turnMode), turnContext, requestAnchor, expandedMessage]
        .filter(Boolean)
        .join("\n\n");
      const systemPrompt = await this.buildSystemPrompt({ workDir, topic, message: expandedMessage, sessionId });
      const tools = await this.toolsForSession(sessionId);
      const { model, contextWindow } = await this.configuredContextWindow(sessionId);
      const configuredOutputLimit = Number(process.env.MOMOKA_MAX_TOKENS ?? "");
      const outputTokenLimit = Math.min(
        Number.isFinite(configuredOutputLimit) && configuredOutputLimit >= 256 ? Math.floor(configuredOutputLimit) : 16_384,
        Math.max(256, Math.floor(contextWindow * 0.2)),
      );
      // 耐用执行（P6）：上游偶发空流（~20%）与网络抖动走退避重试；
      // 重试复用同一 runId/tracePath，model-client 会从 checkpoint 命中已完成的工具调用而不重放副作用。
      let quietRounds = 0;
      // 每轮开头的基准值：用来判断「这一轮到底产出了什么」
      let seenToolCalls = 0;
      let roundToolStart = 0;
      let roundTextStart = 0;
      let roundReasoningStart = 0;
      for (;;) {
        roundToolStart = seenToolCalls;
        roundTextStart = streamedTextChars;
        roundReasoningStart = streamedReasoningChars;
        try {
          result = await withRetry(
            async (attempt) => {
            // 空响应续跑：第 2 次起追加续跑提示（同一 transcript 往下做，不重发任务）
            const attemptPrompt = continuationNote ? `${prompt}\n\n${continuationNote}` : prompt;
            this.assertPromptFits({ systemPrompt, historyMessages, input: attemptPrompt, tools, contextWindow, outputTokenLimit });
            const runResult = await this.options.modelClient.run(attemptPrompt, {
              systemPrompt, topic, model, workDir, tracePath, sessionId, runId, matchedSkills: [], requestKind: "chat",
              tools,
              outputTokenLimit,
              historyMessages,
              onEvent, signal: request.signal,
              sessionManager: this.sessionManager, agentRegistry: this.agentRegistry,
            });
            // 空响应口径对齐 Proma（isVisibleRunMessage）：正文 / 工具调用 / 思考任一存在
            // 即算本轮有产出，「只调工具没写正文」是正常回合——完成度归台账与判读判，
            // 不在这一层判失败。
            // 关键：这里看的是**这一轮新增**的部分，不是整轮累计——累计的 toolCalls 会把
            // 「工具轮之后的空轮」掩益掉（2026-09-22 实测：续跑轮空回却没人发现）。
            const producedThisRound =
              runResult.output.trim().length > 0 ||
              streamedTextChars > roundTextStart ||
              (runResult.toolCalls ?? []).length > roundToolStart ||
              streamedReasoningChars > roundReasoningStart;
            if (!producedThisRound) {
              const empty = new Error("模型返回空响应（上游只回了空流），本轮没有任何产出");
              empty.name = "EmptyResponseError";
              throw empty;
            }
            return runResult;
          },
          {
            attempts: 3,
            baseMs: 800,
            maxMs: 6000,
            classify: (error: unknown) => {
              if (error instanceof Error && (error.name === "EmptyResponseError" || /空响应|空流/u.test(error.message))) return "retryable";
              return classifyRunFailure(error);
            },
            onRetry: (info) => {
              retryAttempts = info.attempt;
              // 空响应：下一轮不是重发任务，而是带着续跑提示接着往下做
              if (info.error instanceof Error && info.error.name === "EmptyResponseError") {
                continuationNote = buildEmptyContinuationNote(info.attempt, 3);
              }
              void appendTraceEvent(tracePath, "run_retry", {
                attempt: info.attempt,
                delayMs: info.delayMs,
                reason: info.error instanceof Error ? info.error.message : String(info.error),
              });
            },
          },
        );
      } catch (error) {
        // 重试耗尽仍为空流：保持原有的 502 语义（上层据此标记 streaming 消息与状态机）
        if (error instanceof Error && error.name === "EmptyResponseError") {
          await appendTraceEvent(tracePath, "final_answer", { response: "", emptyResponse: true });
          throw new MomokaHttpError(502, "模型返回空响应（上游只回了空流），本轮没有任何产出");
        }
        throw error;
      }

        // 聊天轮：只跑了工具、一句人话都没说 → 再给一轮机会（不是失败、不是停止）。
        // 实测 2026-09-22：老师在值日生对话里派了文件任务，她调了三次工具、正文 0 字就结束，
        // 老师那边只看到自己发的那条消息，以为没回。
        seenToolCalls = (result.toolCalls ?? []).length;
        if (turnMode !== "chat" || result.output.trim() || quietRounds >= MAX_QUIET_TURN_ROUNDS) break;
        quietRounds += 1;
        // 续跑轮如果又空回，下一轮带的是同一份续跑提示（有界，见 MAX_QUIET_TURN_ROUNDS）
        await appendTraceEvent(tracePath, "quiet_turn_nudge", {
          round: quietRounds,
          toolCalls: (result.toolCalls ?? []).length,
        }).catch(() => undefined);
        continuationNote = buildQuietTurnNudge(quietRounds, MAX_QUIET_TURN_ROUNDS);
      }
      if (turnMode === "chat" && !result.output.trim()) {
        throw new MomokaHttpError(502, "工具调用后仍返回空响应，未生成最终答复。");
      }
    } catch (error) {
      // 收尾标记：主动停止→stopped，其他异常→error（原异常继续抛给路由层）
      if (sessionId && streamingMessage) {
        const isAbort = error instanceof Error && error.name === "AbortError";
        await this.sessionManager
          .finishStreamingMessage(sessionId, streamingMessage.id, {
            status: isAbort ? "stopped" : "error",
          })
          .catch(() => undefined);
      }
      // 死信（P6）：重试耗尽/硬失败的运行记一封，方便事后查（主动取消不记）
      const isAbortError = error instanceof Error && error.name === "AbortError";
      if (!isAbortError) {
        await appendDeadLetter(workDir ?? this.projectRoot, {
          runId,
          ...(sessionId ? { sessionId } : {}),
          reason: error instanceof MomokaHttpError && error.message.includes("空响应") ? "empty_response" : "run_failed",
          error: error instanceof Error ? error.message : String(error),
          attempts: retryAttempts + 1,
          workDir,
        }).catch(() => undefined);
      }
      throw error;
    }
    await this.recordRunUsage(result, sessionId);
    await appendTraceEvent(tracePath, "final_answer", { response: result.output, usage: result.usage });
    await this.memoryStore.recordOutput({ outputId, prompt: message, response: result.output, topic, matchedSkills: [], toolCalls: result.toolCalls ?? [], sessionId });
    let completedAgentMessageId: string | undefined;
    let completedAt: string | undefined;
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
      completedAgentMessageId = streamingMessage.id;
      completedAt = streamingMessage.timestamp;
    } else if (sessionId) {
      const completedMessage = await this.sessionManager.addMessage(sessionId, "agent", result.output, { outputId, toolCalls: result.toolCalls ?? [], ...(result.model ? { model: result.model } : {}) });
      completedAgentMessageId = completedMessage.id;
      completedAt = completedMessage.timestamp;
    }
    const completedToolCalls = result.toolCalls ?? [];
    if (sessionId && !request.transient && completedToolCalls.length > 0) {
      const isDispatchResult = completedToolCalls.some((call) => call.tool === "run_momoka_cli");
      const dispatchRefs = completedToolCalls.flatMap((call) => [...`${call.args}\n${call.result}`.matchAll(/dsp_[A-Za-z0-9_-]+/gu)].map((match) => match[0]));
      const runtimeRefs = [...eventRuntimeContext.matchAll(/\b(?:mem|dsp|ses|msg)_[A-Za-z0-9_-]+\b/gu)].map((match) => match[0]);
      this.captureExperience({
        kind: isDispatchResult ? "dispatch_result" : "agent_completed",
        id: outputId,
        topic,
        sessionId,
        references: [`output_id: ${outputId}`, ...dispatchRefs.map((id) => `dispatch_id: ${id}`), ...runtimeRefs.map((id) => `runtime_reference: ${id}`)],
        ...(completedAt ? { occurredAt: completedAt } : {}),
        evidence: [
          { label: "本轮用户目标", ...(userMessageId ? { id: userMessageId } : {}), content: message },
          ...(eventRuntimeContext.trim() ? [{ label: "本轮任务背景与召回的操作知识", content: eventRuntimeContext }] : []),
          { label: "Agent 完成结果", ...(completedAgentMessageId ? { id: completedAgentMessageId } : {}), content: result.output },
          ...completedToolCalls.map((call) => ({
            label: `工具 ${call.tool} 的参数与结果`,
            content: JSON.stringify(call),
          })),
        ],
      });
    }
    await saveRunSnapshot({ runId, workDir: workDir ?? this.projectRoot, tracePath, sessionId: sessionId ?? undefined }).catch(async (error: unknown) => {
      await appendTraceEvent(tracePath, "snapshot_failed", { message: error instanceof Error ? error.message : String(error) });
    });
    return { runId, outputId, topic, response: result.output, annotationRuntimeContext: "", outputAssessment: accept, toolCalls: result.toolCalls ?? [], matchedSkills: [], skillReasons: [], sessionId, ...(result.model ? { model: result.model } : {}) };
  }

  async judge(request: JudgeRequest): Promise<JudgeResponse> {
    if (!Number.isInteger(request.score) || request.score < 1 || request.score > 7) throw new MomokaHttpError(400, "Score must be an integer from 1 to 7");
    const output = await this.memoryStore.getOutput(request.outputId);
    if (!output) throw new MomokaHttpError(404, `Unknown output_id: ${request.outputId}`);
    const judgment = await this.memoryStore.recordJudgment(request);
    // 落进产生这条输出的 Agent 自己的作用域（反查不到就进 user 全局）
    const promoteScope = (await this.memoryRefsForSession(output.sessionId ?? null))[0] ?? USER_SCOPE;
    // P3：抽取为**类型化**记忆（type/status/confidence/sourceRefs），而不是整段文本直接晋升
    const draft = extractFromJudgment({
      comment: judgment.comment,
      quote: judgment.quote,
      score: judgment.score,
      topic: judgment.topic,
      outputId: judgment.outputId,
      commentSource: judgment.commentSource,
    });
    if (draft) {
      await this.memoryStore.rememberTyped(draft, promoteScope, { topic: judgment.topic, outputId: judgment.outputId, source: "judgment" });
    } else {
      await this.memoryStore.promoteToLongTerm(judgment, promoteScope);
    }
    this.captureExperience({
      kind: "user_feedback",
      id: `${judgment.outputId}-${judgment.timestamp}`,
      topic: judgment.topic,
      sessionId: output.sessionId,
      references: [`output_id: ${judgment.outputId}`, `feedback_score: ${judgment.score}`],
      evidence: [
        {
          label: "用户评分与明确反馈",
          content: [`评分：${judgment.score}/7`, judgment.comment ? `反馈：${judgment.comment}` : "反馈文字：无", judgment.quote ? `被评价原文：${judgment.quote}` : ""].filter(Boolean).join("\n"),
        },
        {
          label: "原任务与被评价输出",
          content: `原任务：${output.prompt}\n\nAgent 输出：${output.response}`,
        },
      ],
      occurredAt: judgment.timestamp,
    });
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
    if (sessionId) await this.sessionManager.addMessage(sessionId, "agent", result.output, { outputId: continuationOutputId, toolCalls: result.toolCalls ?? [], ...(result.model ? { model: result.model } : {}) });
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
    const actualModel = result.model ?? agent.model;
    const settings = await loadSettings();
    const defaultEntry = settings.modelPool.find((entry) => entry.id === settings.tierDefaults.high && entry.enabled);
    const configuredWindow = defaultEntry && defaultEntry.model.toLowerCase() === actualModel?.toLowerCase()
      ? defaultEntry.contextWindow
      : settings.modelPool.find((entry) => entry.model.toLowerCase() === actualModel?.toLowerCase())?.contextWindow;
    await registry.updateContextStats(agent.id, buildContextStats(result.usage, actualModel, configuredWindow));
  }
  private captureExperience(event: ExperienceEvent): void {
    void this.experienceMemory.capture(event).then((result) => {
      if (result === "created") console.log(`[ExperienceMemory] captured ${event.kind} ${event.id}`);
    }).catch((error: unknown) => {
      console.warn(`[ExperienceMemory] skipped ${event.kind} ${event.id}:`, error instanceof Error ? error.message : String(error));
    });
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
   * 只使用配置的标题模型；配置缺失、调用失败或输出长度不合要求时显式失败。
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
    const titleClient = this.options.titleModelClient;
    if (!titleClient) throw new Error("标题模型客户端未配置");
    const { output } = await titleClient.run(prompt, context);
    const title = output.trim();
    const characterCount = Array.from(title).length;
    if (characterCount < 2 || characterCount > 8) {
      throw new Error(`标题模型输出长度不合要求：收到 ${characterCount} 个字符，要求 2-8 个。`);
    }
    return title;
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
