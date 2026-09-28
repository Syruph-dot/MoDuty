import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { copyFileSync, mkdirSync, statSync } from "node:fs";
import os from "node:os";
import path from "node:path";

import { SessionManager } from "./session-manager.js";
import { modelContextWindow } from "./context-stats.js";
import { loadSettings } from "./settings-store.js";
import { DispatchLedger, type DispatchRecord } from "./dispatch-ledger.js";
import { QuestionStore, type QuestionAnswer, type QuestionDispatchAction, type QuestionItem, type QuestionSet } from "./question-store.js";
import { atomicWriteJson, withFileLock } from "./write-queue.js";
import type { AgentKind, AgentPhase, AgentRecord, AgentState, ContextStats } from "./types.js";
import { resolveWorkspacesRoot } from "./config.js";

export interface CreateAgentInput {
  /** Agent 名字；留空表示“自动生成”——先用占位名创建，首条对话后按标题回填 */
  name?: string;
  role: string;
  workspaceDir: string;
  model?: string;
  /** 角色类别：dispatcher=值日生（调度者）；缺省 worker */
  kind?: AgentKind;
  /** 角色扮演人格 slug：对应 prompts/roleplay/<slug>.md；缺省时不注入该层 */
  roleplay?: string;
  /** 能力标签（P9）：如 ["写作","数据分析"]，供 DAG 编排做能力匹配 */
  capabilities?: string[];
}

/** 创建 Agent 未填名字时的占位名；对应 autoName=true，首条对话后按标题回填 */
export const AUTO_AGENT_NAME = "新建Agent";

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
 *   ⑤ 收尾判读（系统按台账状态唤醒）：read_session 看收尾 → dispatch verdict 提交判定
 *   （交付 → 系统上报老师；返工 → 系统让执行者继续，≤3 次）
 */
export const DISPATCHER_SYSTEM_PROMPT = 
`你是MOMOKA 桌面的懒调度者 AI。

你信奉“会话即资源”：MoDuty 里每个 Agent/会话都是可检索、可复用、可链接的资源。你的职责不是自己解决复杂任务，而是替老师（用户）找到对的人与对的上下文，把任务干净地派发出去。

## 工作流（每一条新消息都走，出口三选一）

本轮结束前必须落到一个出口：**派发**（agent create + agent dispatch）/ **追问**（ask_question）/ **免调度回应**（仅限 ① 白名单里的四类）。
没有第四个出口——「先搁着」「等老师补充」「无从派发」都不是结束方式，这么说等于这一轮白跑。

### ① 意图判定（默认进调度，免调度是白名单）
- 默认：**每一条新消息都进调度**，只要它要求做点什么——哪怕只有一步（截取音频、转格式、查一条信息、整理一份材料）。
- 只有下列四类才直接回应、不进调度：问候寒暄 / 情绪表达 / 对已有结果的追问 / 对我自身的问题。
- 右键「派发文件」的消息（第一行是带引号的文件绝对路径，第二行是“对于以上路径，用户指示：“…””）：路径与指令都在正文里，属于有明确输入的动手任务，直接进调度；**不得**判定为“没带路径/没带指示”。

### ② 检索择优（元数据层，禁止代读全文）

**首选用 search_sessions**（利用支持多关键词并集功能）：
- 调用示例：search_sessions({"query":"<主关键词>","keywords":["<同义词>","<相关词>"],"limit":10})
- 返回项里的 agent_id 就是可直接派发的执行者 id —— **不需要**再拉全量 agent 列表。
- 对候选再用 inspect_session 看元数据（goal / messageCount / lastMessageAt / topics）。
- 择优依据：主题相关性 > 时效性（lastMessageAt 是不是太旧） > 会话长度（太长难续聊）。

**只有 search_sessions 没给出可用候选时才考虑 agent list，且必须带筛选**：
- 用 run_momoka_cli agent list --query <主题> [--limit N]
- **禁止**不带 --query 直接拉全量列表再取第一条（那样必然反复复用同一个执行者）。

### ③ 决定：复用、新建，或者先问一句
- **复用必须来自检索**：目标 agent 必须出自 ② 的命中候选，且主题匹配。
  - 复用前**必须**先向老师确认：用 ask_question 提问「复用 <agt_id>「<名字>」（主题…、N 条消息、最后活动…）吗？」，
    选项 ["复用","新建"]，并**同时携带 dispatch 载荷**：{ targetId: <目标id>, task: <完整任务书>, newName: <老师若选新建时使用的 2-6 字名字> }。
    老师作答后**系统会自动派发**（复用→派给 targetId；新建→按 newName 建执行者后派发），
    你无需再调用 agent dispatch，只需查看会话里的【自动派发】留痕。
  - 不带确认载荷、也不带 --confirm 凭证的复用派发会被后端直接拒绝（这是硬约束，不是建议）。
- **新建执行者（不用确认）**：没有匹配候选，或候选太久远/太冗长、无法放心复用：
  - run_momoka_cli agent create --name <任务短主题>（从老师请求提炼 2-6 字主题），创建后立刻进入 ④。
- **匹配失败时创建适配执行者**：没有匹配候选、候选不合适、或你对派给谁没有把握——创建具备所需能力的新执行者，不派给能力不符的候选。
   agent create 只要求主题，**不需要工作区**（--workspace 是可选参数，留空由系统用默认目录）。
- **只有一种情况可以停下来问老师**：老师原话里没有任何可执行动作（例如只有“处理一下”“看看这个”）。
   此时用 ask_question 给 2–4 个具体选项让老师一键作答；除此之外，不允许以“信息不足 / 无从派发”结束本轮。

### ④ 下发任务书并回 idle
- **必须真实调用工具**：run_momoka_cli agent dispatch <执行者AgentId> [--confirm <qst_id>] <任务书> 来派发（异步：发起后立即返回，不要用同步的 agent chat 苦等）。任务书文本是 dispatch 的**参数**，不是你的回复。
  - 复用的执行者：必须带 --confirm <qst_id>（来自 ③ 的确认）。
  - 新建的执行者：不带 --confirm。
- 新建执行者也必须真实调用：run_momoka_cli agent create --name <任务短主题>（从老师请求提炼 2-6 字主题），创建后立刻进入派发。
- 任务书要点：
  1. 明确任务目标与验收预期；
  2. 用 &ses_<id> 句柄列出择优出的资源会话，并注明“这些链接的会话可按需自读（inspect_session / read_session）”，让执行者自己引用上下文；
  3. 提示执行者完成后在自身会话中给出结果摘要即可，无需回报给你。
- 派发完成后回复老师一句话即可（固定用这句：“已交给 xx 处理，完成/出错会通过链接通知你”），然后停止，不要等待执行者跑完、不要轮询。

## 禁止提前汇报（硬规则，违反即事故）

派发是**异步**的：agent dispatch 返回时执行者刚开始干活，你**此刻对结果一无所知**。

- 未收到系统投递的完成/出错通知之前，**绝对禁止**写出任何结果性内容：产物列表、文件路径、文件夹名、完成进度、“已完成/已处理/已生成”之类说法。
- 尤其禁止把**任务书里要求的东西**当成**已经做出来的东西**复述（例：任务书写“产物放到 X、Y 目录”，你不得回复“产物已在 X、Y 目录”）。
- 你唯一能说的是：“已交给 xx 处理，完成/出错会通过链接通知你。”
- 要描述结果，必须等系统投递“✅/❌ … &ses_…”之后，再去 inspect/read 那个会话，基于**真实内容**汇报。

## 收尾判读（系统唤醒时执行——你的第二条职责线）

派发出去的任务由系统台账跟踪。执行者完成/出错/停转时，系统会向你注入一条【台账判读请求】
（系统注入**不会**留在会话历史里）。收到后按顺序执行：

1. read_session 查看执行者会话的收尾部分（最后几条消息即可，不要整篇读）。
2. 判定产出是否有效——有效性由你推理：报错、截断、没收尾、与任务无关、牛头不对马嘴，都算无效。
   你只判断"这是不是一个完整、真实、可交付的结果"，不要猜老师会不会满意。
3. 用工具提交判定（判定以工具调用为准，二选一）：
   - 无效 → run_momoka_cli dispatch verdict <dsp_id> continue [问题备注]
     （系统会让执行者返工；每个条目最多继续 3 次，达上限后系统只接受 deliver）
   - 有效或无法挽救 → run_momoka_cli dispatch verdict <dsp_id> deliver [交付备注]
     （系统终止跟踪并向老师发桌面通知）
4. 提交判定后即止：不要向老师复述任务内容，不要重复派发，也不要等待执行者。

判读轮本身也可能失败（上游偶发空响应是已知现象）——系统会在条目停滞时重新唤醒你，照常处理即可。

## 示例（照做，不要只写计划）

老师：“帮我写一篇关于海洋塑料污染的短文，输出成 md 文件。”

你的处理过程：

1. **判定**（自己心里判断，不必长篇输出）：这是要做的事 → 进入调度。
2. **真实调用工具** search_sessions({"query":"海洋塑料污染"}) → 若返回候选会话，再用 inspect_session 看元数据；没有匹配/太久远 → 新建。
3. **新建执行者**（第一次工具调用）：
   调用 run_momoka_cli，参数 args: ["agent", "create", "--name", "海洋塑料短文"]
   工具返回：created agt_xxxx… 「海洋塑料短文」会话 ses_yyyy
4. **派发**（第二次工具调用，不要把任务书写成回复文本）：
   调用 run_momoka_cli，参数 args: ["agent", "dispatch", "agt_xxxx", "写一篇关于海洋塑料污染的短文，输出为 md 文件；目标与验收：500 字左右、含数据引用、保存到工作区。若上面找到可复用会话，在任务书中附 &ses_<id> 并注明可自读。"]
   工具返回后，回复老师一句话：“已交给「海洋塑料短文」处理，完成/出错会通过链接通知你。”然后停止。

老师（右键「派发文件」发来的消息）：

  第一行是一个带引号的文件绝对路径（例如下载目录里的视频文件），
  第二行是“对于以上路径，用户指示：“截取9s~53s的音频””。

你的处理：先 search_sessions 看有没有做过的音频处理会话；没有匹配就
run_momoka_cli agent create --name 音频截取 → run_momoka_cli agent dispatch <agt_id> <任务书> →
回复一句“已交给「音频截取」处理”。不要回复“正文里没带路径/指示，先搁着”。

### 关键区分（避免上次犯的错）
- **执行动作 = 工具调用**：新建执行者、派发任务都必须真的调用 run_momoka_cli，工具返回结果后再回复老师。
- **不要**把“任务书”作为自己的回复正文输出——任务书是传给 run_momoka_cli agent dispatch 的**参数内容**。
- **不要**停在“我应该新建一个执行者…”的计划上：看到这种想法就立即调用 agent create。
- 除搜索/检视外，你只允许调用 run_momoka_cli；执行代码/读写文件/查网页正文等工作都留给执行者。

## 边界与禁止
- 不要自己下场完成复杂任务（写代码/查资料/跑长流程）——那是执行者的工作。
- 不要 read_session 拉全文来“亲自确认”——决策只看元数据与片段。
- 不要脑补会话句柄：引用 &ses_<id> 前必须先用 search_sessions / inspect_session 确认存在。
- 不要在派发后同步等待、轮询执行者状态（系统会主动唤醒你判读）。
- 返工只走收尾判读的 dispatch verdict 通道（由系统唤醒触发）；除此之外不要对 error 自动重试。
- 不要用检索自证当前消息：本轮要求就在 prompt 顶部的「当前请求（唯一权威任务文本）」段里，直接读它。
   不要用 search_content 去自己会话里搜路径/关键词“确认有没有”——搜索索引未命中不等于消息里没有。
- run_momoka_cli 只允许 MOMOKA 文档化的子命令；不要用它或其它工具触碰无关文件与服务端配置。
- 全程用中文：回复老师、留痕、任务书都写中文，不要把英文思考片段夹进正文。
`;
// 注：角色扮演槽位（说明段 + 标记）已移出本人格常量，改由 agent.ts 的 buildSystemPrompt
// 在 system 最末统一追加。这样槽位才真正位于 system 最后一段，且不必要求人格文本自带标记
// （worker 走默认人格时同样能吃到人格文件）。

/** dispatcher（值日生）判定单源：kind 明确为 dispatcher，或旧实例无 kind 但名为「值日生」（且未标为 worker）。
 *  提示词注入与工具表白名单（toolSpecsForKind）必须共用本判定，避免两处规则漂移。 */
export function isDispatcherAgent(
  record: { kind?: "dispatcher" | "worker"; name: string } | null | undefined,
): boolean {
  if (!record) return false;
  return record.kind === "dispatcher" || (record.name === "值日生" && record.kind !== "worker");
}

/** 未提供 workspace 时的默认根目录：每 Agent 一个以 agentId 命名的子目录。 */
function defaultWorkspaceRoot(dataDir: string): string {
  return resolveWorkspacesRoot(dataDir);
}

function shortId(prefix: string): string {
  return `${prefix}_${crypto.randomUUID().replace(/-/g, "").slice(0, 12)}`;
}

/**
 * 把旧的项目级 Agent 注册表导入用户级位置（幂等，启动时同步检查一次）。
 *
 * 旧位置：`<projectRoot>/memory/.agents/agents.json`（项目级，跟仓库目录绑定）。
 * 新位置：`<dataDir>/.agents/agents.json`（用户级，见类注释）。
 *
 * 规则：新位置缺失 → 导入；两边都有且旧文件更新 → 先把新文件备份成
 * `agents.json.bak-<时间戳>` 再导入（否则旧位置里较新的 Agent 会被历史快照盖掉）。
 * 旧位置不存在时什么也不做。
 */
function migrateLegacyAgentsFile(memoryDir: string, targetFile: string): void {
  const legacyFile = path.join(memoryDir, ".agents", "agents.json");
  if (path.resolve(legacyFile) === path.resolve(targetFile)) return;
  let legacyMtime: number;
  try {
    legacyMtime = statSync(legacyFile).mtimeMs;
  } catch {
    return; // 旧位置没有文件：无需迁移
  }
  let targetMtime: number | null = null;
  try {
    targetMtime = statSync(targetFile).mtimeMs;
  } catch {
    targetMtime = null;
  }
  if (targetMtime !== null && targetMtime >= legacyMtime) return;
  if (targetMtime !== null) {
    const backup = `${targetFile}.bak-${new Date().toISOString().replace(/\D/gu, "").slice(0, 14)}`;
    copyFileSync(targetFile, backup);
    console.warn(`[registry] 旧位置的 Agent 注册表更新，已备份 ${backup} 并从 ${legacyFile} 导入`);
  } else {
    console.warn(`[registry] 迁移 Agent 注册表：${legacyFile} → ${targetFile}`);
  }
  mkdirSync(path.dirname(targetFile), { recursive: true });
  copyFileSync(legacyFile, targetFile);
}

/**
 * 多 Agent 注册表：1 Agent = 1 persona 档案 + 1:1 绑定的 session（上下文串）。
 * 创建 Agent 自动创建其专属 session；删除 Agent 连带删除该 session。
 *
 * 记录 JSON 持久化在**用户级**数据目录（`<dataDir>/.agents/agents.json`）。
 * 用户 2026-09-28 拍板：旧版把注册表放在 `<projectRoot>/memory/.agents/`，
 * 项目根一变（例如打包后由安装目录启动）就读到空注册表——值日生与所有
 * 磁贴都消失，而会话/台账因为本来就是用户级所以还在，看起来像“配置没了”。
 */
export class AgentRegistry {
  private readonly registryFile: string;
  /** 派发台账（值日生 → 执行者） */
  readonly dispatches: DispatchLedger;
  /** 问答存储（Agent → 桌面用户的结构化提问） */
  readonly questions: QuestionStore;
  private readonly dataDir: string;

  constructor(
    private readonly memoryDir: string,
    private readonly sessions: SessionManager,
    registryFile?: string,
    dataDir?: string,
  ) {
    this.dataDir = dataDir ?? memoryDir;
    this.registryFile = registryFile ?? path.join(this.dataDir, ".agents", "agents.json");
    migrateLegacyAgentsFile(this.memoryDir, this.registryFile);
    this.dispatches = new DispatchLedger(this.dataDir);
    this.questions = new QuestionStore(this.dataDir);
  }

  /** 按会话反查 Agent（工具执行上下文只有 sessionId） */
  async agentBySessionId(sessionId: string | null | undefined): Promise<AgentRecord | null> {
    if (!sessionId) return null;
    const agents = await this.listAgents();
    return agents.find((agent) => agent.sessionId === sessionId) ?? null;
  }

  /**
   * 会话已有的消息数。
   * 用途：判定一次派发是「复用既有执行者」还是「刚新建的执行者」——
   * 刚新建的执行者在派发前消息数为 0（任务书尚未写入）。
   */
  async sessionMessageCount(sessionId: string): Promise<number> {
    const session = await this.sessions.getSession(sessionId).catch(() => null);
    return session?.messageCount ?? 0;
  }

  /** 当前生效的值日生（dispatcher）：优先 kind 标记，兼容旧数据按名字兜底 */
  async findDispatcher(): Promise<AgentRecord | null> {
    const agents = await this.listAgents();
    return agents.find((agent) => agent.kind === "dispatcher") ?? agents.find((agent) => agent.name === "值日生") ?? null;
  }

  /** 台账薄封装：记录/查询派发；状态转移统一走 this.dispatches 的条目方法 */
  recordDispatch(input: Omit<DispatchRecord, "id" | "state" | "dispatchedAt">): Promise<DispatchRecord> {
    return this.dispatches.record(input);
  }

  activeDispatchesForTarget(targetAgentId: string): Promise<DispatchRecord[]> {
    return this.dispatches.activeForTarget(targetAgentId);
  }

  dropDispatchesForTarget(targetAgentId: string): Promise<void> {
    return this.dispatches.dropByTarget(targetAgentId);
  }

  /** 问答薄封装 */
  createQuestionSet(input: {
    agentId: string;
    sessionId: string;
    questions: QuestionItem[];
    dispatch?: QuestionDispatchAction;
  }): Promise<QuestionSet> {
    return this.questions.create(input);
  }

  pendingQuestionsForAgent(agentId: string): Promise<QuestionSet[]> {
    return this.questions.pendingForAgent(agentId);
  }

  /** 待答 + 最近已答（前端问答卡回看用；只读） */
  questionsForAgent(agentId: string, answeredLimit?: number): Promise<QuestionSet[]> {
    return this.questions.recentForAgent(agentId, answeredLimit);
  }

  answerQuestionSet(setId: string, answers: QuestionAnswer[]): Promise<QuestionSet | null> {
    return this.questions.answer(setId, answers);
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
    // 名字可选：留空 → 占位名 + autoName，首条对话生成标题后由 applyAutoName 回填
    const providedName = input.name?.trim() ?? "";
    const autoName = !providedName;
    const name = providedName || AUTO_AGENT_NAME;
    const id = shortId("agt");
    // role（系统提示词）与 workspace 不再由调用方强制提供：空则补默认。
    const role = input.role.trim() || DEFAULT_SYSTEM_PROMPT;
    const workspaceDir = input.workspaceDir.trim() || path.join(defaultWorkspaceRoot(this.dataDir), id);

    // 1:1 绑定：自动创建 session（name → goal, workspaceDir → folderPath）
    await mkdir(workspaceDir, { recursive: true });
    const session = await this.sessions.createSession(name, workspaceDir);
    const now = new Date().toISOString();
    const configuredWindow = input.model
      ? (await loadSettings()).modelPool.find((entry) => entry.model.toLowerCase() === input.model?.trim().toLowerCase())?.contextWindow
      : undefined;
    const record: AgentRecord = {
      id,
      name,
      ...(autoName ? { autoName: true } : {}),
      role,
      ...(input.kind ? { kind: input.kind } : {}),
      ...(input.roleplay?.trim() ? { roleplay: input.roleplay.trim() } : {}),
      ...(input.capabilities?.length ? { capabilities: input.capabilities.map(String) } : {}),
      ...(input.model?.trim() ? { model: input.model.trim() } : {}),
      workspaceDir,
      sessionId: session.id,
      state: "idle",
      contextStats: {
        promptTokens: 0,
        contextWindow: modelContextWindow(input.model, configuredWindow),
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
      // 清理该 Agent 的待答问题
      void this.questions.dropByAgent(agentId).catch(() => undefined);
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
        autoName: undefined,
        lastActiveAt: new Date().toISOString(),
      };
      agents[index] = updated;
      await this.writeAgents(agents);
      return updated;
    });
  }

  /**
   * 首条对话后的自动命名：仅当该 Agent 名字仍是“自动生成”占位（autoName）时回填。
   * 用 autoName 门控是为了不与用户并发重命名互相覆盖；不满足条件返回 null。
   */
  async applyAutoName(id: string, name: string): Promise<AgentRecord | null> {
    const trimmed = name.trim();
    if (!trimmed) return null;
    return await withFileLock(this.registryFile, async () => {
      const agents = await this.listAgents();
      const index = agents.findIndex((candidate) => candidate.id === id);
      if (index === -1 || !agents[index].autoName) return null;
      const updated: AgentRecord = {
        ...agents[index],
        name: trimmed,
        autoName: undefined,
        lastActiveAt: new Date().toISOString(),
      };
      agents[index] = updated;
      await this.writeAgents(agents);
      return updated;
    });
  }

  /**
   * 更新 Agent 的角色扮演人格 slug。
   * - 传非空字符串：绑定 prompts/roleplay/<slug>.md；
   * - 传 null / 空串：清除绑定，不注入角色扮演槽位。
   */
  async updateAgentRoleplay(id: string, slug: string | null): Promise<AgentRecord | null> {
    return await withFileLock(this.registryFile, async () => {
      const agents = await this.listAgents();
      const index = agents.findIndex((a) => a.id === id);
      if (index === -1) return null;
      const trimmed = slug?.trim() ?? "";
      const updated = { ...agents[index], roleplay: trimmed || null, lastActiveAt: new Date().toISOString() };
      agents[index] = updated;
      await this.writeAgents(agents);
      return updated;
    });
  }

  /** 更新 Agent 的能力标签（P9：DAG 编排做能力匹配用） */
  async updateAgentCapabilities(id: string, capabilities: string[]): Promise<AgentRecord | null> {
    return await withFileLock(this.registryFile, async () => {
      const agents = await this.listAgents();
      const index = agents.findIndex((a) => a.id === id);
      if (index === -1) return null;
      const cleaned = [...new Set(capabilities.map((item) => String(item).trim()).filter(Boolean))];
      const updated = { ...agents[index], capabilities: cleaned, lastActiveAt: new Date().toISOString() };
      agents[index] = updated;
      await this.writeAgents(agents);
      return updated;
    });
  }

  /** 更新 Agent 的 role（系统提示词） */
  async updateAgentRole(id: string, role: string): Promise<AgentRecord | null> {
    return await withFileLock(this.registryFile, async () => {
      const agents = await this.listAgents();
      const index = agents.findIndex((a) => a.id === id);
      if (index === -1) return null;
      const updated = { ...agents[index], role, lastActiveAt: new Date().toISOString() };
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

  /** 归档 Agent：标记为 archived，从主列表隐藏但保留数据 */
  async archiveAgent(agentId: string): Promise<AgentRecord | null> {
    return await withFileLock(this.registryFile, async () => {
      const agents = await this.listAgents();
      const index = agents.findIndex((a) => a.id === agentId);
      if (index === -1) return null;
      const updated = { ...agents[index], archived: true, archivedAt: new Date().toISOString() };
      agents[index] = updated;
      await this.writeAgents(agents);
      return updated;
    });
  }

  /** 取消归档 Agent：恢复到主列表显示 */
  async unarchiveAgent(agentId: string): Promise<AgentRecord | null> {
    return await withFileLock(this.registryFile, async () => {
      const agents = await this.listAgents();
      const index = agents.findIndex((a) => a.id === agentId);
      if (index === -1) return null;
      const updated = { ...agents[index], archived: false, archivedAt: undefined };
      agents[index] = updated;
      await this.writeAgents(agents);
      return updated;
    });
  }

  /** 列出所有 Agent（含归档），可选过滤 */
  async listAllAgents(includeArchived = false): Promise<AgentRecord[]> {
    const agents = await this.listAgents();
    if (includeArchived) return agents;
    return agents.filter((a) => !a.archived);
  }
}

function agentToDisk(agent: AgentRecord): Record<string, unknown> {
  return {
    id: agent.id,
    name: agent.name,
    ...(agent.autoName ? { autoName: true } : {}),
    role: agent.role,
    ...(agent.kind ? { kind: agent.kind } : {}),
    ...(agent.roleplay ? { roleplay: agent.roleplay } : {}),
    ...(agent.capabilities?.length ? { capabilities: agent.capabilities } : {}),
    ...(agent.model ? { model: agent.model } : {}),
    workspaceDir: agent.workspaceDir,
    sessionId: agent.sessionId,
    state: agent.state,
    ...(agent.phase ? { phase: agent.phase } : {}),
    ...(typeof agent.lastRunDurationMs === "number" ? { lastRunDurationMs: agent.lastRunDurationMs } : {}),
    ...(agent.contextStats ? { contextStats: agent.contextStats } : {}),
    createdAt: agent.createdAt,
    lastActiveAt: agent.lastActiveAt,
    archived: agent.archived,
    archivedAt: agent.archivedAt,
  };
}

function agentFromDisk(value: unknown): AgentRecord {
  const raw = (typeof value === "object" && value !== null && !Array.isArray(value) ? value : {}) as Record<string, unknown>;
  const kind = raw.kind === "dispatcher" ? "dispatcher" : raw.kind === "worker" ? "worker" : undefined;
  return {
    id: String(raw.id ?? ""),
    name: String(raw.name ?? ""),
    ...(raw.autoName === true ? { autoName: true } : {}),
    role: String(raw.role ?? ""),
    ...(kind ? { kind } : {}),
    ...(raw.roleplay ? { roleplay: String(raw.roleplay) } : {}),
    ...(Array.isArray(raw.capabilities) ? { capabilities: raw.capabilities.map(String) } : {}),
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
    archived: raw.archived === true,
    archivedAt: raw.archived_at ? String(raw.archived_at) : raw.archivedAt ? String(raw.archivedAt) : undefined,
  };
}
