import type { DispatchEntryState, DispatchOutcome, DispatchRecord, DispatchTrigger } from "./dispatch-ledger.js";

/**
 * 调度台账的对外视图（GET /api/dispatches）。
 *
 * 台账 DispatchRecord 是唯一事实源；本模块只做「投影 + 截断 + 排序」，无副作用、可单测：
 * - 任务书很长（可能上千字），列表只给预览；完整内容仍在会话里查（台账看状态、对话看细节）；
 * - 补上执行者的名字/状态，前端不必再逐条回查 /api/agents；
 * - 排序固定为「等判读 → 进行中 → 已交付」，同组按最近动作时间倒序。
 */

/** 任务书预览长度（字符）：**已不再用于截断**，仅作为旧接口的兼容导出保留 */
export const TASK_PREVIEW_CHARS = 80;

/** 台账视图里任务书的安全上限（与写入上限一致；正常情况不会触发） */
export const TASK_MAX_CHARS = 4000;

/** 台账状态的展示优先级（越小越靠前） */
export const DISPATCH_STATE_ORDER: Record<DispatchEntryState, number> = {
  awaiting_verdict: 0,
  tracking: 1,
  done: 2,
};

/** 执行者的最小投影（取不到时用 id 兜底） */
export interface DispatchTargetView {
  agent_id: string;
  name: string | null;
  session_id: string;
  state: string | null;
  phase: string | null;
}

export interface DispatchView {
  id: string;
  state: DispatchEntryState;
  last_status: DispatchTrigger | null;
  last_status_at: string | null;
  /** 已执行「继续」的轮次（0 表示还没返工过） */
  continue_count: number;
  last_verdict: DispatchOutcome | null;
  stalled_at: string | null;
  dispatched_at: string;
  /** 任务书（完整；仅在超过安全上限时置 task_truncated） */
  task: string;
  task_truncated: boolean;
  linked_sessions: string[];
  target: DispatchTargetView;
}

export interface DispatchTargetRecord {
  id: string;
  name: string;
  sessionId: string;
  state: string;
  phase?: string | null;
}

/** 截断到最多 max 个字符（中文按字符计，尾部加省略号）；max 为 null/Infinity 时不截断 */
export function truncateTask(task: string, max: number): { text: string; truncated: boolean } {
  const text = task ?? "";
  if (!Number.isFinite(max) || text.length <= max) return { text, truncated: false };
  return { text: `${text.slice(0, Math.max(0, max - 1))}…`, truncated: true };
}

export function toDispatchView(
  record: DispatchRecord,
  target: DispatchTargetRecord | null,
  opts: { taskChars?: number } = {},
): DispatchView {
  // 默认返回完整任务书（值日生页的台账卡片要能展开看全文），只在极端长度上做安全截断
  const preview = truncateTask(record.task, opts.taskChars ?? TASK_MAX_CHARS);
  return {
    id: record.id,
    state: record.state,
    last_status: record.lastStatus ?? null,
    last_status_at: record.lastStatusAt ?? null,
    continue_count: record.continueCount ?? 0,
    last_verdict: record.lastVerdict ?? null,
    stalled_at: record.stalledAt ?? null,
    dispatched_at: record.dispatchedAt,
    task: preview.text,
    task_truncated: preview.truncated,
    linked_sessions: [...(record.linkedSessions ?? [])],
    target: {
      agent_id: record.targetAgentId,
      name: target?.name ?? null,
      session_id: target?.sessionId ?? record.targetSessionId,
      state: target?.state ?? null,
      phase: target?.phase ?? null,
    },
  };
}

/** 时间戳倒序用的取值：优先最近动作时间，退回派发时间 */
export function dispatchRecency(view: DispatchView): string {
  return view.last_status_at ?? view.stalled_at ?? view.dispatched_at;
}

/** 排序：状态优先级 → 最近动作时间倒序 → id（保证稳定） */
export function sortDispatchViews(views: DispatchView[]): DispatchView[] {
  return [...views].sort((a, b) => {
    const byState = DISPATCH_STATE_ORDER[a.state] - DISPATCH_STATE_ORDER[b.state];
    if (byState !== 0) return byState;
    const at = dispatchRecency(a);
    const bt = dispatchRecency(b);
    if (at !== bt) return at < bt ? 1 : -1;
    return a.id.localeCompare(b.id);
  });
}

/** `state` 查询参数：active=未结单（含等判读/进行中）；all/缺省=全部 */
export function matchStateFilter(state: DispatchEntryState, filter: string | null): boolean {
  if (!filter || filter === "all") return true;
  if (filter === "active") return state !== "done";
  return state === filter;
}
