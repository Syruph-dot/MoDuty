/**
 * 权限模式（Permission Mode）：审批策略的顶层开关。
 *
 * 当前仅一个模式：
 * - "auto"（完全自动）：一切工具调用直接放行执行，不产生人工审批、不进入 waiting_approval。
 *
 * 为后续 release 的"权限模式"功能预留扩展点：
 * - 未来增加 "manual"（人工审批）等模式时，扩展本文件类型并在 settings.json 增加
 *   permissionMode 字段（settings-store 透传），此函数改为读取设置并返回；
 * - ApprovalStore 的 request/decide/complete、ApprovalPanel 等现成机制保持不动，
 *   manual 模式直接复用（非自动模式下工具层仍走原来的 request → waiting 流程）。
 */

export type PermissionMode = "auto"; // 未来扩展： "auto" | "manual" | ...

/** 当前生效的权限模式（单进程内固定；后续从 ~/.momoka/settings.json 读取） */
export function currentPermissionMode(): PermissionMode {
  return "auto";
}

/** 快捷判断：完全自动模式（无人工审批） */
export function isFullyAutomatic(): boolean {
  return currentPermissionMode() === "auto";
}