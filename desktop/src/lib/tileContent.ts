import type { Agent, AgentPhase, AgentState } from "../types";

/**
 * Agent 磁贴内容映射（设计稿 interactionv2：footer 一句话状态 + role 类标 + 大数字摘要）。
 * 纯映射，不含组件逻辑，便于冒烟测试与常量复用。
 */

/** phase → footer 动作文案（running 时优先展示"正在做什么"） */
export const PHASE_FOOTER: Record<AgentPhase, string> = {
  planning: "Planning…",
  searching: "Searching sessions…",
  reading: "Reading resources…",
  executing: "Executing…",
  verifying: "Verifying…",
};

/** state → footer 静态文案（无 phase 时） */
export const STATE_FOOTER: Record<AgentState, string> = {
  idle: "Standby",
  running: "Running",
  waiting_approval: "Awaiting approval",
  completed: "Completed",
  error: "Error · retry",
};

/** role → 顶部类标（设计稿的 RESEARCH / CONVERSATIONS 风格：全大写 letter-spacing 标签） */
export function roleLabel(role: string | undefined | null): string {
  const trimmed = (role ?? "").trim().toUpperCase();
  return trimmed || "AGENT";
}

/** 组装磁贴 footer 文案：running 且带 phase → phase 动作；否则用 state 静态文案 */
export function tileFooter(agent: Pick<Agent, "state" | "phase">): string {
  if (agent.state === "running" && agent.phase) {
    return PHASE_FOOTER[agent.phase] ?? STATE_FOOTER.running;
  }
  return STATE_FOOTER[agent.state] ?? STATE_FOOTER.idle;
}

/** ISO 时间 → "MM-DD HH:mm" 短格式；无效输入返回 "—" */
export function formatShortTime(iso: string | undefined | null): string {
  if (!iso) return "—";
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return "—";
  return date.toLocaleString("zh-CN", {
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  });
}