import path from "node:path";
import { readdir, stat } from "node:fs/promises";

import type { MomokaAgentCore } from "../agent.js";
import type { AgentRegistry } from "../agent-registry.js";
import { isDispatcherAgent } from "../agent-registry.js";
import type { AgentStateMachine, AgentStateEvent, ContextStatsSnake } from "../agent-state.js";
import type { WorkspaceManager } from "../workspace-manager.js";
import type { AgentRecord, ChatResponse, StreamEvent } from "../types.js";
import { DISPATCH_MAX_CONTINUE, LEDGER_TASK_MAX_CHARS, type DispatchRecord, type DispatchTrigger, type DispatchVerdict } from "../dispatch-ledger.js";
import type { DispatchBridgeInput } from "../dispatch-bridge.js";
import type { RouteContext } from "./route-context.js";
import { ensureAgents } from "./route-context.js";
import { isFullyAutomatic } from "../permission-mode.js";
import { contextStatsToSnake } from "./serialization.js";
import type { AgentEventBroadcaster } from "./sse.js";

/**
 * Agent 编排层：单链收尾（台账 → 判读 → 返工/上报）的唯一实现。
 *
 * 用户设计（2026-09-10 口述拍板）：值日生发现**台账**状态变化 → 查看结果 →
 * 判定返工（发「继续」，≤3 次）或判定任务完成 → 上报用户。半常驻：平时 idle，被动触发。
 *
 *   派发（dispatch-bridge / POST /api/agents/:id/dispatch，原子建条目）
 *     └─ 台账条目 = 唯一事实源（dispatch-ledger.ts）
 *          ├─ 传感器①：执行者终态（completed/error，来自 agent 状态机）→ markAwaitingVerdict
 *          ├─ 传感器②：停转扫描器（runs trace mtime，30 分钟无进展）→ markAwaitingVerdict(stalled)
 *          └─ awaiting_verdict → wakeDispatcher 注入判读请求（transient，不落历史）
 *               └─ 值日生 read_session 判读 → run_momoka_cli dispatch verdict
 *                    ├─ continue → continueTracking + 驱动执行者返工（≤ DISPATCH_MAX_CONTINUE）
 *                    └─ deliver  → markDone + dispatch_verdict 广播（桌面通知上报）
 *
 * 注意：agent 状态机（agent-state.ts）只是磁贴 UI 投影 + pending 挂起语义，
 * 不得作为业务触发源——业务触发源是台账。
 */

export interface OrchestrationDeps {
  agent: MomokaAgentCore;
  registry: AgentRegistry;
  machine: AgentStateMachine;
  broadcaster: AgentEventBroadcaster;
  workspaces: WorkspaceManager;
}

export function orchestrationOf(ctx: RouteContext): OrchestrationDeps {
  const { registry, machine } = ensureAgents(ctx);
  return { agent: ctx.agent, registry, machine, broadcaster: ctx.broadcaster, workspaces: ctx.workspaces };
}

/* ============================================================
 * 统一驱动器：所有「跑一轮 Agent 对话」的唯一入口
 * （SSE 桌面对话 / 右键菜单任务 / 审批续跑 / 答案续跑 / 判读唤醒 全走这里）
 * ============================================================ */

export interface DriveTurnOptions {
  message: string;
  /** 系统注入（判读请求等）：只进本轮模型输入，不写会话历史 */
  transient?: boolean;
  /** 额外事件监听（SSE 转发等）；状态机喂食由驱动器内部完成 */
  onEvent?: (event: StreamEvent) => void;
  signal?: AbortSignal;
}

export interface DriveTurnResult {
  response: ChatResponse;
  /** 本轮挂起等待人工（审批/答案），未记 completed */
  held?: "approval" | "question";
}

export async function driveAgentTurn(
  deps: OrchestrationDeps,
  record: AgentRecord,
  opts: DriveTurnOptions,
): Promise<DriveTurnResult> {
  try {
    const response = await deps.agent.chat({
      message: opts.message,
      sessionId: record.sessionId,
      transient: opts.transient,
      onEvent: (event) => {
        deps.machine.consumeEvent(record.id, event);
        opts.onEvent?.(event);
      },
      signal: opts.signal,
    });
    const hasPendingApproval = await checkHasPendingApproval(deps.workspaces, record);
    const hasPendingQuestion = await checkHasPendingQuestion(deps.registry, record);
    let held: DriveTurnResult["held"];
    if (hasPendingApproval) held = "approval";
    else if (hasPendingQuestion) held = "question";
    if (!held) {
      deps.machine.complete(record.id);
    }
    return { response, held };
  } catch (error) {
    if (error instanceof Error && error.name === "AbortError") {
      deps.machine.cancel(record.id);
    } else {
      deps.machine.fail(record.id);
    }
    throw error;
  }
}

/* ============================================================
 * 全局接线：状态机 → UI 投影；执行者终态 → 台账判读回路（传感器①）
 * ============================================================ */

export function wireAgentStatePersistence(deps: OrchestrationDeps): void {
  deps.machine.subscribe((event) => {
    // UI 投影：持久化注册表 + 广播给 /api/agents/events（磁贴转圈、列表状态）。失败不炸服务。
    void persistAgentState(deps, event).catch((error: unknown) => {
      console.error("[orchestration] persist agent state failed:", error);
    });
    // 收尾链路传感器①：执行者终态 → 台账条目进入判读队列
    void onExecutorTerminal(deps, event).catch((error: unknown) => {
      console.error("[orchestration] executor terminal handling failed:", error);
    });
  });
}

async function persistAgentState(deps: OrchestrationDeps, event: AgentStateEvent): Promise<void> {
  const updated = await deps.registry.updateAgentState(event.agent_id, event.state, event.phase);
  const payload: AgentStateEvent = {
    ...event,
    ...(updated?.name ? { name: updated.name } : {}),
    ...(updated?.contextStats ? { context_stats: contextStatsToSnake(updated.contextStats) } : {}),
  };
  deps.broadcaster.broadcast(`data: ${JSON.stringify(payload)}\n\n`);
}

/** 执行者进入终态 → 台账 tracking 条目转入 awaiting_verdict，唤醒值日生判读 */
async function onExecutorTerminal(deps: OrchestrationDeps, event: AgentStateEvent): Promise<void> {
  if (event.state !== "completed" && event.state !== "error") return;
  const entries = await deps.registry.dispatches.activeForTarget(event.agent_id);
  for (const entry of entries) {
    if (entry.state !== "tracking") continue;
    const trigger: DispatchTrigger = event.state === "completed" ? "completed" : "error";
    const updated = await deps.registry.dispatches.markAwaitingVerdict(entry.id, trigger);
    if (updated) {
      await wakeDispatcher(deps, updated, trigger);
    }
  }
}

/** 检查某 Agent 绑定的 workspace 是否有待决审批（pending_approval 时不 complete） */
export async function checkHasPendingApproval(workspaces: WorkspaceManager, record: AgentRecord): Promise<boolean> {
  // 完全自动模式：不产生人工审批，遗留 pending 也不阻塞任务完结
  if (isFullyAutomatic()) {
    return false;
  }
  return await workspaces.hasPendingApproval(record.workspaceDir);
}

/** 检查某 Agent 是否有未答的桌面提问（requiring_input 时不 complete，保持等待用户作答） */
export async function checkHasPendingQuestion(registry: AgentRegistry, record: AgentRecord): Promise<boolean> {
  const pending = await registry.pendingQuestionsForAgent(record.id);
  return pending.length > 0;
}

/* ============================================================
 * 审批/答案续跑：统一驱动的两个薄包装
 * ============================================================ */

/** 审批通过后续跑：从断点继续（工具结果已在历史中），不是从头跑 */
export async function resumeAgentAfterApproval(deps: OrchestrationDeps, record: AgentRecord): Promise<void> {
  void driveAgentTurn(deps, record, { message: "审批已通过。请根据工具执行结果继续完成任务。" }).catch((error: unknown) => {
    console.error("[resume] 审批后续跑失败:", error);
  });
}

/** 审批决策的 Agent 联动：脱离 waiting_approval；批准则异步续跑 */
export async function driveApprovalDecision(
  deps: OrchestrationDeps,
  sessionId: string,
  decision: "approved" | "rejected",
): Promise<void> {
  const bound = (await deps.registry.listAgents()).find((candidate) => candidate.sessionId === sessionId);
  if (!bound) {
    return;
  }
  deps.machine.decide(bound.id, decision);
  if (decision === "approved") {
    void resumeAgentAfterApproval(deps, bound);
  }
}

/** 桌面用户提交问题答案后的续跑：答案已由路由层写入会话历史，这里只驱动 */
export async function driveQuestionAnswered(deps: OrchestrationDeps, record: AgentRecord): Promise<void> {
  deps.machine.answerReceived(record.id);
  void driveAgentTurn(deps, record, {
    message: "桌面用户已回答你刚才的提问，答案已记录在上面的消息中。请根据用户的回答继续完成任务。",
    transient: true,
  }).catch((error: unknown) => {
    console.error("[question] 答案后续跑失败:", error);
  });
}

/* ============================================================
 * 唤醒器：台账条目 → 值日生判读请求（transient 注入，不落历史）
 * ============================================================ */

const triggerLabel = (trigger: DispatchTrigger): string =>
  trigger === "completed" ? "执行者报告完成" : trigger === "error" ? "执行者出错" : "疑似停转（长时间无进展）";

async function wakeDispatcher(deps: OrchestrationDeps, entry: DispatchRecord, trigger: DispatchTrigger): Promise<void> {
  const dispatcher = await deps.registry.getAgent(entry.dispatcherId);
  if (!dispatcher || !isDispatcherAgent(dispatcher)) return;
  const message = [
    `【台账判读请求】条目 ${entry.id}：${triggerLabel(trigger)}。任务：${entry.task.slice(0, 160)}`,
    `执行者会话：&ses_${entry.targetSessionId.replace(/^ses_/, "")}`,
    entry.continueCount ? `已返工轮次：${entry.continueCount}/${DISPATCH_MAX_CONTINUE}。` : undefined,
    "请 read_session 看该会话的收尾部分（不要整篇读），判读产出是否有效：",
    `无效（报错/截断/未收尾/与任务无关）→ run_momoka_cli dispatch verdict ${entry.id} continue [问题备注]`,
    `有效或无法挽救 → run_momoka_cli dispatch verdict ${entry.id} deliver [交付备注]`,
    "判定通过工具提交即可，不要向老师复述任务内容，也不要重复派发任务。",
  ]
    .filter(Boolean)
    .join("\n");
  void driveAgentTurn(deps, dispatcher, { message, transient: true }).catch((error: unknown) => {
    console.error("[waker] 唤醒值日生判读失败:", error);
  });
}

/* ============================================================
 * 派发桥：run_momoka_cli agent chat/dispatch/verdict 的进程内实现
 * （http.ts 接线；tools.ts 命中相关子命令时不再 spawn CLI 回环 HTTP）
 * ============================================================ */

export async function handleDispatchBridge(deps: OrchestrationDeps, input: DispatchBridgeInput): Promise<{ ok: boolean; output: string; dispatchId?: string }> {
  if (input.kind === "verdict") {
    return { ok: true, output: await handleDispatchVerdict(deps, input) };
  }

  const executorId = input.executorId ?? "";
  const task = (input.task ?? "").trim();
  if (!executorId.startsWith("agt_") || !task) {
    return { ok: false, output: "错误：派发需要执行者 agt_ id 与非空任务书。" };
  }
  const target = await deps.registry.getAgent(executorId);
  if (!target) return { ok: false, output: `错误：执行者 ${executorId} 不存在。` };
  const caller = await deps.registry.agentBySessionId(input.callerSessionId);
  if (!caller) return { ok: false, output: "错误：无法定位调用者会话。" };

  // 复用确认硬约束（2026-09-10 拍板 8：保留；仅 dispatch，同步 chat 豁免——与旧口径一致）
  if (input.kind === "dispatch") {
    const refusal = await validateDispatcherReuse(deps.registry, input.callerSessionId, target, input.confirm);
    if (refusal) return { ok: false, output: refusal };
  }

  const entry = await deps.registry.recordDispatch({
    dispatcherId: caller.id,
    dispatcherSessionId: caller.sessionId,
    targetAgentId: target.id,
    targetSessionId: target.sessionId,
    task: task.slice(0, LEDGER_TASK_MAX_CHARS),
    linkedSessions: extractSessionRefs(task),
  });

  if (input.kind === "chat") {
    // 同步派发：等执行者本轮结束（结果给调用者）；台账照常进入判读队列
    const result = await driveAgentTurn(deps, target, { message: task });
    const output = result.response.response.trim();
    return {
      ok: true,
      dispatchId: entry.id,
      output: output.slice(0, 4000) || `（执行者无文本输出；台账 ${entry.id} 已进入判读队列）`,
    };
  }

  // 异步派发：发起即回（懒调度）
  void driveAgentTurn(deps, target, { message: task }).catch((error: unknown) => {
    console.error("[dispatch] 驱动执行者失败:", error);
  });
  return {
    ok: true,
    dispatchId: entry.id,
    output: `已派发 ${target.id}「${target.name}」（台账 ${entry.id}）。执行者完成/出错/停转后系统会唤醒你判读，届时用 dispatch verdict 提交判定。`,
  };
}

/**
 * 复用确认硬约束（自 tools.ts 迁入并结构化，不再解析 CLI 字符串）。
 * 口径与旧实现一致：目标会话已有消息 → 视为复用，必须携带合法确认凭证
 * （提问属于派发者会话、已作答、第一题选「复用」、题干含目标 agentId）。
 */
async function validateDispatcherReuse(
  registry: AgentRegistry,
  callerSessionId: string,
  target: { id: string; name: string; sessionId: string },
  confirmId?: string,
): Promise<string | null> {
  const existingMessages = await registry.sessionMessageCount(target.sessionId);
  if (existingMessages === 0) return null; // 刚新建的执行者，不需要确认

  if (!confirmId) {
    return [
      "【已拦截】复用既有执行者必须先获得老师确认。",
      `目标 ${target.id}「${target.name}」已有 ${existingMessages} 条历史消息，属于复用而不是新建。`,
      "请改用带载荷的 ask_question：选项依次为 [\"复用\",\"新建\"]、题干里包含目标 id，并附 dispatch 载荷 { targetId: \"" + target.id + "\", task: <任务书>, newName: <新建名字> }：",
      `  复用 ${target.id}「${target.name}」吗？`,
      "老师作答后系统会自动派发（无需 --confirm）；CLI 人工派发仍可用 --confirm <qst_id>。",
    ].join("\n");
  }

  const sets = await registry.questions.listAll().catch(() => []);
  const set = sets.find((item) => item.id === confirmId);
  const questionText = set?.questions?.[0]?.prompt ?? "";
  const reuseAnswer = set?.answers?.find((item) => item.questionIndex === 0);
  const valid =
    Boolean(set) &&
    set?.sessionId === callerSessionId &&
    set?.status === "answered" &&
    reuseAnswer?.choiceIndex === 0 &&
    questionText.includes(target.id);
  if (!valid) {
    return [
      `【已拦截】确认凭证无效：${confirmId || "(缺失)"}。`,
      `要求：该 qst_ 提问属于本会话、已作答、第一题选了第一项（“复用”）、且题干包含目标 id ${target.id}。`,
      "请重新 ask_question 确认，或改用 agent create 新建执行者。",
    ].join("\n");
  }
  return null;
}

function extractSessionRefs(task: string): string[] {
  const refs: string[] = [];
  for (const match of task.matchAll(/&ses_([a-z0-9]+)/gi)) {
    refs.push(`ses_${match[1]}`);
  }
  return refs;
}

/* ============================================================
 * 判定提交：值日生通过 run_momoka_cli dispatch verdict 表达判读结论
 * ============================================================ */

async function handleDispatchVerdict(deps: OrchestrationDeps, input: DispatchBridgeInput): Promise<string> {
  const entryId = input.entryId ?? "";
  const choice = input.choice;
  if (!entryId || (choice !== "deliver" && choice !== "continue")) {
    return "错误：dispatch verdict 需要 <dsp_id> 与 deliver|continue。";
  }
  const all = await deps.registry.dispatches.listAll();
  const entry = all.find((item) => item.id === entryId);
  if (!entry) return `错误：台账条目 ${entryId} 不存在。`;
  if (entry.state !== "awaiting_verdict") {
    return `错误：条目 ${entryId} 当前状态为 ${entry.state}（非 awaiting_verdict），无需或不能判定。`;
  }
  if (input.callerSessionId !== entry.dispatcherSessionId) {
    return "错误：只有该条目的派发者（值日生）可以提交判定。";
  }

  if (choice === "deliver") {
    await deps.registry.dispatches.markDone(entry.id, "deliver");
    await deps.agent.sessionManager.addMessage(
      entry.dispatcherSessionId,
      "system",
      `【判读留痕】${entry.id}：判定可交付，已上报老师。${input.note ? `备注：${input.note.slice(0, 120)}` : ""}`,
    );
    broadcastDispatchVerdict(deps, { entry, verdict: "deliver", note: input.note });
    return "判定已提交：交付。系统已上报老师（桌面通知）。";
  }

  if ((entry.continueCount ?? 0) >= DISPATCH_MAX_CONTINUE) {
    return [
      `【已拦截】条目 ${entry.id} 已继续 ${DISPATCH_MAX_CONTINUE} 次，达到返工上限。`,
      `请改用 run_momoka_cli dispatch verdict ${entryId} deliver [备注] 收尾上报，备注说明已达返工上限与现状。`,
    ].join("\n");
  }
  const updated = await deps.registry.dispatches.continueTracking(entry.id);
  const target = await deps.registry.getAgent(entry.targetAgentId);
  if (!target) return "错误：执行者已不存在，无法返工。请改判 deliver。";
  const note = input.note?.trim();
  const message = note
    ? `值日生判读：上一轮产出未通过（${note.slice(0, 150)}）。请继续完成任务。`
    : "值日生判读：上一轮产出无效或未正常收尾。请继续完成任务。";
  void driveAgentTurn(deps, target, { message }).catch((error: unknown) => {
    console.error("[verdict] 驱动执行者返工失败:", error);
  });
  await deps.agent.sessionManager.addMessage(
    entry.dispatcherSessionId,
    "system",
    `【判读留痕】${entry.id}：判定继续返工（${updated?.continueCount ?? 1}/${DISPATCH_MAX_CONTINUE}），已向执行者下发指令。${note ? `问题：${note.slice(0, 120)}` : ""}`,
  );
  broadcastDispatchVerdict(deps, { entry: updated ?? entry, verdict: "continue", note: input.note });
  return `判定已提交：继续（${updated?.continueCount ?? 1}/${DISPATCH_MAX_CONTINUE}）。已向执行者下发返工指令。`;
}

/** 判读结论广播（A6 桌面通知的数据源；system 留痕消息负责会话内记录） */
function broadcastDispatchVerdict(
  deps: OrchestrationDeps,
  payload: { entry: DispatchRecord; verdict: DispatchVerdict; note?: string },
): void {
  deps.broadcaster.broadcast(
    `data: ${JSON.stringify({
      type: "dispatch_verdict",
      dispatch_id: payload.entry.id,
      dispatcher_agent_id: payload.entry.dispatcherId,
      dispatcher_session_id: payload.entry.dispatcherSessionId,
      target_agent_id: payload.entry.targetAgentId,
      target_session_id: payload.entry.targetSessionId,
      task: payload.entry.task.slice(0, 160),
      verdict: payload.verdict,
      continue_count: payload.entry.continueCount ?? 0,
      note: payload.note ?? "",
    })}\n\n`,
  );
}

/* ============================================================
 * 停转扫描器（传感器②）：唯一能发现「没有任何状态变化的卡死」的传感器
 * ============================================================ */

const stallThresholdMs = (): number => Number(process.env.MODUTY_STALL_MS ?? 30 * 60 * 1000);

/** 由 http.ts 接线启动；每分钟扫描，条目活动超阈值即转入判读队列 */
export function startDispatchStallScanner(deps: OrchestrationDeps): NodeJS.Timeout {
  const timer = setInterval(() => {
    void scanStalledDispatches(deps).catch((error: unknown) => {
      console.error("[stall-scan] failed:", error);
    });
  }, 60_000);
  timer.unref();
  return timer;
}

async function scanStalledDispatches(deps: OrchestrationDeps): Promise<void> {
  const entries = await deps.registry.dispatches.listAll();
  const now = Date.now();
  for (const entry of entries) {
    if (entry.state === "tracking") {
      // 活动信号 = 执行者 runs 树最新 trace mtime；没有任何运行痕迹则回退派发时间
      const activity = await latestRunActivity(deps, entry.targetAgentId);
      const base = activity ?? Date.parse(entry.dispatchedAt);
      if (Number.isFinite(base) && now - base > stallThresholdMs()) {
        const updated = await deps.registry.dispatches.markAwaitingVerdict(entry.id, "stalled");
        if (updated) {
          await wakeDispatcher(deps, updated, "stalled");
        }
      }
    } else if (entry.state === "awaiting_verdict") {
      // 判读卡住（值日生没提 verdict / 判读轮失败）：超阈值重新唤醒（touch 防抖到下个周期）
      const base = Date.parse(entry.lastStatusAt ?? entry.dispatchedAt);
      if (Number.isFinite(base) && now - base > stallThresholdMs()) {
        await deps.registry.dispatches.touch(entry.id);
        await wakeDispatcher(deps, entry, entry.lastStatus ?? "error");
      }
    }
  }
}

/** 执行者最近活动时间：其工作区 runs 树最新 trace.jsonl 的 mtime */
async function latestRunActivity(deps: OrchestrationDeps, targetAgentId: string): Promise<number | null> {
  try {
    const target = await deps.registry.getAgent(targetAgentId);
    if (!target) return null;
    const runsDir = path.join(target.workspaceDir, "runs");
    const runs = await readdir(runsDir).catch(() => [] as string[]);
    let latest: number | null = null;
    for (const run of runs) {
      const info = await stat(path.join(runsDir, run, "trace.jsonl")).catch(() => null);
      if (info && (latest === null || info.mtimeMs > latest)) {
        latest = info.mtimeMs;
      }
    }
    return latest;
  } catch {
    return null;
  }
}
