import type { DispatchRecord } from "./dispatch-ledger.js";

/**
 * 台账快照：每轮注入提示词尾部（值日生专属），把"在途状态"从历史里拿出来。
 *
 * 为什么需要：台账是调度状态的唯一事实源，但它不在模型上下文里——`dispatch` 相关 CLI 原本
 * 只有 `verdict` 一条写路径，模型想知道"还有谁没结单、第几轮、上次判读是什么"只能翻会话历史，
 * 而历史有 4000 token 预算、中段会被丢弃（长会话里必然出现"值日生忘了自己在等谁"）。
 *
 * 设计约束：
 * - 只给概览（未结单 + 最近交付 + 待拍板计数），细节走 `dispatch list/show`；
 * - 台账 id 必须给全（判读/取消都要用）；
 * - 空台账且无待办时返回 null（不注入，别占 token）。
 */

export interface DispatchSnapshotInput {
  /** 该值日生的全部台账（调用方已按 dispatcherId 过滤） */
  records: DispatchRecord[];
  /** agentId → 展示名（取不到时回退 id） */
  targetNames?: Record<string, string>;
  /** 待老师拍板的问题集数量 */
  pendingQuestions?: number;
  /** 最近交付列几条，默认 3 */
  maxClosed?: number;
  /** 当前时间（测试注入用） */
  now?: number;
}

function pad(value: number): string {
  return value < 10 ? `0${value}` : String(value);
}

/** 台账时间戳 → MM-DD HH:mm（本地时区） */
export function formatStamp(iso: string | undefined, now = Date.now()): string {
  if (!iso) return "";
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return "";
  const d = new Date(t);
  const stamp = `${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
  const minutes = Math.round((now - t) / 60000);
  if (minutes < 1) return `${stamp}（刚刚）`;
  if (minutes < 60) return `${stamp}（${minutes} 分钟前）`;
  if (minutes < 60 * 24) return `${stamp}（${Math.round(minutes / 60)} 小时前）`;
  return `${stamp}（${Math.round(minutes / 1440)} 天前）`;
}

function describeOpen(record: DispatchRecord, targetNames: Record<string, string>, now: number): string {
  const name = targetNames[record.targetAgentId] ?? record.targetAgentId;
  const bits: string[] = [];
  if (record.stalledAt) bits.push(`已停转 ${formatStamp(record.stalledAt, now)}`);
  else if (record.lastStatusAt) bits.push(`最近状态 ${record.lastStatus === "completed" ? "执行者完成" : record.lastStatus === "error" ? "执行者出错" : "疑似停转"} ${formatStamp(record.lastStatusAt, now)}`);
  if (record.continueCount) bits.push(`已返工 ${record.continueCount}/3`);
  if (record.lastVerdict) bits.push(`上次判读 ${record.lastVerdict}`);
  const state = record.state === "awaiting_verdict" ? "等判读" : "进行中";
  return `- ${state} ${record.id} → 「${name}」 ${bits.length ? `· ${bits.join(" · ")}` : ""}`.trimEnd();
}

/** 生成台账快照文本；无可注入内容时返回 null */
export function buildDispatchSnapshot(input: DispatchSnapshotInput): string | null {
  const now = input.now ?? Date.now();
  const targetNames = input.targetNames ?? {};
  const maxClosed = input.maxClosed ?? 3;
  const open = input.records
    .filter((record) => record.state !== "done")
    .sort((a, b) => (a.state === b.state ? 0 : a.state === "awaiting_verdict" ? -1 : 1));
  const closed = input.records
    .filter((record) => record.state === "done")
    .sort((a, b) => Date.parse(b.lastStatusAt ?? b.dispatchedAt) - Date.parse(a.lastStatusAt ?? a.dispatchedAt))
    .slice(0, maxClosed);
  const pending = input.pendingQuestions ?? 0;

  if (open.length === 0 && closed.length === 0 && pending === 0) return null;

  const lines: string[] = [
    "## 台账快照（系统维护，唯一事实源）",
    "在途状态以这里与 `run_momoka_cli dispatch list/show` 为准；不要靠历史消息推断谁还没结单。",
  ];
  if (open.length > 0) {
    lines.push(`未结单 ${open.length} 条：`);
    for (const record of open) lines.push(describeOpen(record, targetNames, now));
  } else {
    lines.push("未结单：无。");
  }
  if (closed.length > 0) {
    lines.push("最近交付：");
    for (const record of closed) {
      const name = targetNames[record.targetAgentId] ?? record.targetAgentId;
      const verdict = record.lastVerdict ?? "deliver";
      lines.push(`- ${record.id} → 「${name}」 ${verdict}${record.continueCount ? `（返工 ${record.continueCount} 次）` : ""} ${formatStamp(record.lastStatusAt ?? record.dispatchedAt, now)}`);
    }
  }
  lines.push(
    pending > 0
      ? `待老师拍板：${pending} 组问题未作答（老师作答后系统会自动派发，不要重复派发）。`
      : "待老师拍板：无。",
  );
  return lines.join("\n");
}
