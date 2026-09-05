import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { SessionManager } from "./session-manager.js";
import { modelContextWindow } from "./context-stats.js";
import { DispatchLedger, type DispatchRecord } from "./dispatch-ledger.js";
import { atomicWriteJson, withFileLock } from "./write-queue.js";
import type { AgentKind, AgentPhase, AgentRecord, AgentState, ContextStats } from "./types.js";

export interface CreateAgentInput {
  name: string;
  role: string;
  workspaceDir: string;
  model?: string;
  /** 角色类别：dispatcher=值日生（调度者）；缺省 worker */
  kind?: AgentKind;
}

/** 新建 Agent 未提供系统提示词时使用的默认 system prompt（前端不再暴露该字段）。
 * 这也是“未自定义”判定的基准：role 恰好等于它时视为用户没自定义，运行时用 Settings 默认人格。 */
export const DEFAULT_SYSTEM_PROMPT =
  "你是一个有用的 AI 助手。请使用可用工具、逐步思考，并用用户所用的语言清晰、准确地帮助其完成任务。";

/**
 * 值日生（Dispatcher）预置 system prompt：BA 风格学生人格 + 懒调度者职责。
 * 由前端在添加值日生磁贴时通过 /api/agents 的 system 字段创建。
 *
 * 工作流（务必按顺序执行）：
 *   ① 意图判定 → ② 检索择优（元数据层） → ③ 复用需确认 / 新建不问 → ④ 派发即回 idle
 * 收尾不靠值日生总结：系统会监听执行者状态并把“可点击链接”投递回值日生会话，
 * 值日生只需要等待老师看到链接后的进一步指示。
 */
export const DISPATCHER_SYSTEM_PROMPT = 
`你是MOMOKA 桌面的懒调度者 AI。

你信奉“会话即资源”：MoDuty 里每个 Agent/会话都是可检索、可复用、可链接的资源。你的职责不是自己解决复杂任务，而是替老师（用户）找到对的人与对的上下文，把任务干净地派发出去。

## 工作流（收到复杂任务时严格按顺序）

### ① 意图判定
- 日常闲聊 / 简单问答：直接自然回应，不调用工具，不进入调度。
- 复杂任务（需要执行代码、查资料、多步产出、使用文件/浏览器等）：进入调度模式。

### ② 检索择优（元数据层，禁止代读全文）
- 用 search_sessions 检索相关会话，得到命中候选（含名称/分数/匹配区间/片段）。
- 对 top 候选用 inspect_session 查看元数据：goal、messageCount、lastMessageAt、turnRange、topics。
- 择优依据：主题相关性 > 时效性（lastMessageAt 是否太旧） > 会话长度（messageCount 是否冗长到难以续聊）。
- 你的决策只基于元数据与片段，不要 read_session 拉取全文——被派发者需要内容时会自己按需读取。

### ③ 决定：复用 or 新建
- 复用候选 = 找到现成的执行 Agent（agt_xxx，1:1 绑定会话），且其会话主题与你需要的任务匹配。
  - 命中候选时：把单一最佳候选报给老师确认（名称、主题、消息数、最后活动时间），问“复用它吗？”。老师 yes → 继续；no → 转新建。
- 新建执行者：
  - 没有匹配候选，或候选太久远/太冗长、无法放心复用时，直接新建，不用问老师：
    run_momoka_cli agent create --name <任务短主题>（从老师请求提炼 2-6 字主题）
  - 创建后立刻进入 ④ 下发任务。

### ④ 下发任务书并回 idle
- **必须真实调用工具**：run_momoka_cli agent dispatch <执行者AgentId> <任务书> 来派发（异步：发起后立即返回，不要用同步的 agent chat 苦等）。任务书文本是 dispatch 的**参数**，不是你的回复。
- 新建执行者也必须真实调用：run_momoka_cli agent create --name <任务短主题>（从老师请求提炼 2-6 字主题），创建后立刻进入派发。
- 任务书要点：
  1. 明确任务目标与验收预期；
  2. 用 &ses_<id> 句柄列出择优出的资源会话，并注明“这些链接的会话可按需自读（inspect_session / read_session）”，让执行者自己引用上下文；
  3. 提示执行者完成后在自身会话中给出结果摘要即可，无需回报给你。
- 派发完成后回复老师一句话即可（“已交给 xx 处理，完成/出错会通过链接通知你”），然后停止，不要等待执行者跑完、不要轮询。

## 收尾（被动触发）
- 执行者完成后，系统会把结果链接投递到本会话（以 &ses_ 形式出现）。
- 老师看到链接后可能让你“看看 X 结果/收尾”，此时你用 inspect_session / read_session 读取执行者会话并汇报。
- 执行者出错时同样会收到链接；若老师让你处理错误，先 inspect 出错会话判断原因，能修正就再派发，不能就如实上报。

## 示例（照做，不要只写计划）

老师：“帮我写一篇关于海洋塑料污染的短文，输出成 md 文件。”

你的处理过程：

1. **判定**（自己心里判断，不必长篇输出）：这是复杂任务 → 进入调度。
2. **真实调用工具** search_sessions({"query":"海洋塑料污染"}) → 若返回候选会话，再用 inspect_session 看元数据；没有匹配/太久远 → 新建。
3. **新建执行者**（第一次工具调用）：
   调用 run_momoka_cli，参数 args: ["agent", "create", "--name", "海洋塑料短文"]
   工具返回：created agt_xxxx… 「海洋塑料短文」会话 ses_yyyy
4. **派发**（第二次工具调用，不要把任务书写成回复文本）：
   调用 run_momoka_cli，参数 args: ["agent", "dispatch", "agt_xxxx", "写一篇关于海洋塑料污染的短文，输出为 md 文件；目标与验收：500 字左右、含数据引用、保存到工作区。若上面找到可复用会话，在任务书中附 &ses_<id> 并注明可自读。"]
   工具返回后，回复老师一句话：“已交给「海洋塑料短文」处理，完成/出错会通过链接通知你。”然后停止。

### 关键区分（避免上次犯的错）
- **执行动作 = 工具调用**：新建执行者、派发任务都必须真的调用 run_momoka_cli，工具返回结果后再回复老师。
- **不要**把“任务书”作为自己的回复正文输出——任务书是传给 run_momoka_cli agent dispatch 的**参数内容**。
- **不要**停在“我应该新建一个执行者…”的计划上：看到这种想法就立即调用 agent create。
- 除搜索/检视外，你只允许调用 run_momoka_cli；执行代码/读写文件/查网页正文等工作都留给执行者。

## 边界与禁止
- 不要自己下场完成复杂任务（写代码/查资料/跑长流程）——那是执行者的工作。
- 不要 read_session 拉全文来“亲自确认”——决策只看元数据与片段。
- 不要脑补会话句柄：引用 &ses_<id> 前必须先用 search_sessions / inspect_session 确认存在。
- 不要在派发后同步等待、轮询执行者状态（系统会主动投递）。
- 不要对 error 自动重试多次：最多把情况报告给老师或按老师指示处理。
- run_momoka_cli 只允许 MOMOKA 文档化的子命令；不要用它或其它工具触碰无关文件与服务端配置。`;

/** 未提供 workspace 时的默认根目录：每 Agent 一个以 agentId 命名的子目录。 */
const DEFAULT_WORKSPACE_ROOT = path.join(os.homedir(), ".momoka", "workspaces");

function shortId(prefix: string): string {
  return `${prefix}_${crypto.randomUUID().replace(/-/g, "").slice(0, 12)}`;
}

/**
 * 多 Agent 注册表：1 Agent = 1 persona 档案 + 1:1 绑定的 session（上下文串）。
 * 创建 Agent 自动创建其专属 session；删除 Agent 连带删除该 session。
 * 记录 JSON 持久化（默认 memory/.agents/agents.json，可注入路径）。
 */
export class AgentRegistry {
  private readonly registryFile: string;
  /** 派发台账（值日生 → 执行者）；memoryDir 与 agents.json 同级 */
  readonly dispatches: DispatchLedger;

  constructor(
    private readonly memoryDir: string,
    private readonly sessions: SessionManager,
    registryFile?: string,
  ) {
    this.registryFile = registryFile ?? path.join(memoryDir, ".agents", "agents.json");
    this.dispatches = new DispatchLedger(memoryDir);
  }

  /** 按会话反查 Agent（工具执行上下文只有 sessionId） */
  async agentBySessionId(sessionId: string | null | undefined): Promise<AgentRecord | null> {
    if (!sessionId) return null;
    const agents = await this.listAgents();
    return agents.find((agent) => agent.sessionId === sessionId) ?? null;
  }

  /** 当前生效的值日生（dispatcher）：优先 kind 标记，兼容旧数据按名字兜底 */
  async findDispatcher(): Promise<AgentRecord | null> {
    const agents = await this.listAgents();
    return agents.find((agent) => agent.kind === "dispatcher") ?? agents.find((agent) => agent.name === "值日生") ?? null;
  }

  /** 台账薄封装：记录/查询/更新一次派发 */
  recordDispatch(input: Omit<DispatchRecord, "id" | "state" | "dispatchedAt">): Promise<DispatchRecord> {
    return this.dispatches.record(input);
  }

  activeDispatchesForTarget(targetAgentId: string): Promise<DispatchRecord[]> {
    return this.dispatches.activeForTarget(targetAgentId);
  }

  updateDispatchStatus(dispatchId: string, status: "completed" | "error", done = false): Promise<DispatchRecord | null> {
    return this.dispatches.updateStatus(dispatchId, status, done);
  }

  dropDispatchesForTarget(targetAgentId: string): Promise<void> {
    return this.dispatches.dropByTarget(targetAgentId);
  }

  async listAgents(): Promise<AgentRecord[]> {
    try {
      const parsed = JSON.parse(await readFile(this.registryFile, "utf8")) as unknown;
      return Array.isArray(parsed) ? parsed.map(agentFromDisk) : [];
    } catch {
      return [];
    }
  }

  async createAgent(input: CreateAgentInput): Promise<AgentRecord> {
    const name = input.name.trim();
    if (!name) throw new Error("Agent name cannot be empty");
    const id = shortId("agt");
    // role（系统提示词）与 workspace 不再由调用方强制提供：空则补默认。
    const role = input.role.trim() || DEFAULT_SYSTEM_PROMPT;
    const workspaceDir = input.workspaceDir.trim() || path.join(DEFAULT_WORKSPACE_ROOT, id);

    // 1:1 绑定：自动创建 session（name → goal, workspaceDir → folderPath）
    await mkdir(workspaceDir, { recursive: true });
    const session = await this.sessions.createSession(name, workspaceDir);
    const now = new Date().toISOString();
    const record: AgentRecord = {
      id,
      name,
      role,
      ...(input.kind ? { kind: input.kind } : {}),
      ...(input.model?.trim() ? { model: input.model.trim() } : {}),
      workspaceDir,
      sessionId: session.id,
      state: "idle",
      contextStats: {
        promptTokens: 0,
        contextWindow: modelContextWindow(input.model),
        cachedTokens: null,
        updatedAt: now,
      },
      createdAt: now,
      lastActiveAt: now,
    };
    return await withFileLock(this.registryFile, async () => {
      const agents = await this.listAgents();
      agents.unshift(record);
      await this.writeAgents(agents);
      return record;
    });
  }

  async getAgent(agentId: string): Promise<AgentRecord | null> {
    return (await this.listAgents()).find((agent) => agent.id === agentId) ?? null;
  }
  async deleteAgent(agentId: string): Promise<boolean> {
    return await withFileLock(this.registryFile, async () => {
      const agents = await this.listAgents();
      const target = agents.find((agent) => agent.id === agentId);
      if (!target) {
        return false;
      }
      await this.writeAgents(agents.filter((agent) => agent.id !== agentId));
      await this.sessions.deleteSession(target.sessionId).catch(() => undefined);
      // 清理该执行者的在途派发跟踪（不阻塞删除）
      void this.dispatches.dropByTarget(agentId).catch(() => undefined);
      return true;
    });
  }

  async updateAgentState(agentId: string, state: AgentState, phase?: AgentPhase): Promise<AgentRecord | null> {
    return await withFileLock(this.registryFile, async () => {
      const agents = await this.listAgents();
      let updated: AgentRecord | null = null;
      const next = agents.map((agent) => {
        if (agent.id !== agentId) {
          return agent;
        }
        updated = { ...agent, state, phase, lastActiveAt: new Date().toISOString() };
        return updated;
      });
      if (!updated) {
        return null;
      }
      await this.writeAgents(next);
      return updated;
    });
  }

  /** 更新某 Agent 的最近一次运行耗时（每次 chat 结束时写入） */
  async updateLastRun(agentId: string, durationMs: number): Promise<AgentRecord | null> {
    return await withFileLock(this.registryFile, async () => {
      const agents = await this.listAgents();
      let updated: AgentRecord | null = null;
      const next = agents.map((agent) => {
        if (agent.id !== agentId) {
          return agent;
        }
        updated = { ...agent, lastRunDurationMs: durationMs, lastActiveAt: new Date().toISOString() };
        return updated;
      });
      if (!updated) {
        return null;
      }
      await this.writeAgents(next);
      return updated;
    });
  }

  /** 更新某 Agent 的上下文占用指标（每次模型调用后写入） */
  async updateContextStats(agentId: string, stats: ContextStats): Promise<AgentRecord | null> {
    return await withFileLock(this.registryFile, async () => {
      const agents = await this.listAgents();
      let updated: AgentRecord | null = null;
      const next = agents.map((agent) => {
        if (agent.id !== agentId) {
          return agent;
        }
        updated = { ...agent, contextStats: stats };
        return updated;
      });
      if (!updated) {
        return null;
      }
      await this.writeAgents(next);
      return updated;
    });
  }

  async renameAgent(id: string, name: string): Promise<AgentRecord> {
    const trimmed = name.trim();
    if (!trimmed) throw new Error("Agent name cannot be empty");
    return await withFileLock(this.registryFile, async () => {
      const agents = await this.listAgents();
      const index = agents.findIndex((candidate) => candidate.id === id);
      if (index === -1) throw new Error("Agent not found");
      const updated: AgentRecord = {
        ...agents[index],
        name: trimmed,
        lastActiveAt: new Date().toISOString(),
      };
      agents[index] = updated;
      await this.writeAgents(agents);
      return updated;
    });
  }

  /**
   * 列出「孤儿 session」：磁盘上存在但没有 Agent 绑定它的 session。
   * 用来识别/清理旧 chat.html 时代残留的会话。
   */
  async listLegacySessions(): Promise<{ id: string; goal: string; folderPath: string; messageCount: number; lastMessageAt: string }[]> {
    const [agents, sessions] = await Promise.all([this.listAgents(), this.sessions.listSessions()]);
    const bound = new Set(agents.map((agent) => agent.sessionId));
    return sessions
      .filter((session) => !bound.has(session.id))
      .map((session) => ({
        id: session.id,
        goal: session.goal,
        folderPath: session.folderPath,
        messageCount: session.messageCount,
        lastMessageAt: session.lastMessageAt,
      }));
  }

  /**
   * 一次性删除所有孤儿 session（无 Agent 绑定）。返回删除数量。
   * 用来清掉旧 chat.html 时代的残留；调用方一般是在迁移/升级时一次性跑。
   */
  async cleanupLegacySessions(): Promise<number> {
    const legacy = await this.listLegacySessions();
    let removed = 0;
    for (const session of legacy) {
      const ok = await this.sessions.deleteSession(session.id).catch(() => false);
      if (ok) removed += 1;
    }
    return removed;
  }

  private async writeAgents(agents: AgentRecord[]): Promise<void> {
    await atomicWriteJson(this.registryFile, agents.map(agentToDisk));
  }
}

function agentToDisk(agent: AgentRecord): Record<string, unknown> {
  return {
    id: agent.id,
    name: agent.name,
    role: agent.role,
    ...(agent.kind ? { kind: agent.kind } : {}),
    ...(agent.model ? { model: agent.model } : {}),
    workspaceDir: agent.workspaceDir,
    sessionId: agent.sessionId,
    state: agent.state,
    ...(agent.phase ? { phase: agent.phase } : {}),
    ...(typeof agent.lastRunDurationMs === "number" ? { lastRunDurationMs: agent.lastRunDurationMs } : {}),
    ...(agent.contextStats ? { contextStats: agent.contextStats } : {}),
    createdAt: agent.createdAt,
    lastActiveAt: agent.lastActiveAt,
  };
}

function agentFromDisk(value: unknown): AgentRecord {
  const raw = (typeof value === "object" && value !== null && !Array.isArray(value) ? value : {}) as Record<string, unknown>;
  const kind = raw.kind === "dispatcher" ? "dispatcher" : raw.kind === "worker" ? "worker" : undefined;
  return {
    id: String(raw.id ?? ""),
    name: String(raw.name ?? ""),
    role: String(raw.role ?? ""),
    ...(kind ? { kind } : {}),
    ...(raw.model ? { model: String(raw.model) } : {}),
    workspaceDir: String(raw.workspaceDir ?? ""),
    sessionId: String(raw.sessionId ?? ""),
    state: (typeof raw.state === "string" ? raw.state : "idle") as AgentState,
    ...(raw.phase ? { phase: String(raw.phase) as AgentPhase } : {}),
    ...(typeof raw.lastRunDurationMs === "number"
      ? { lastRunDurationMs: Number(raw.lastRunDurationMs) }
      : {}),
    ...(typeof raw.contextStats === "object" && raw.contextStats !== null
      ? {
          contextStats: {
            promptTokens: Number((raw.contextStats as Record<string, unknown>).promptTokens ?? 0),
            contextWindow: Number((raw.contextStats as Record<string, unknown>).contextWindow ?? 0) || 131_072,
            cachedTokens: typeof (raw.contextStats as Record<string, unknown>).cachedTokens === "number"
              ? (raw.contextStats as Record<string, unknown>).cachedTokens as number
              : null,
            updatedAt: String((raw.contextStats as Record<string, unknown>).updatedAt ?? ""),
          },
        }
      : {}),
    createdAt: String(raw.createdAt ?? ""),
    lastActiveAt: String(raw.lastActiveAt ?? ""),
  };
}