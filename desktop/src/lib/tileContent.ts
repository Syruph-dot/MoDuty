/**
 * Agent 磁贴内容映射（设计稿 interactionv2）。
 * 纯映射，不含组件逻辑，便于冒烟测试与常量复用。
 */

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