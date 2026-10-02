/**
 * 原生 webview 桥的前端封装（Tauri ↑ 命令）。
 *
 * 磁贴内嵌路线的分工：**前端知道磁贴落在屏幕的哪个矩形**，所以子 webview 的创建、
 * 矩形跟随、显隐都由前端经 Tauri 命令直接指挥 Rust；后端只经桥的 HTTP 端点驱动页面
 * （见 `src/browser-transport-bridge.ts`）。
 *
 * 坐标单位：Tauri 的 `set_bounds` 吃**物理像素**，而 React 给的是 CSS 像素，
 * 必须乘 `window.devicePixelRatio`（本机 1.75）。判据只有一个——点击是否命中。
 */
import { isTauriShell } from "./api";

export interface WebviewBridgeInfo {
  enabled: boolean;
  port?: number;
  bridge_file?: string;
}

let cachedInfo: WebviewBridgeInfo | null = null;

async function invokeBridge<T>(command: string, args?: Record<string, unknown>): Promise<T> {
  const { invoke } = await import("@tauri-apps/api/core");
  return await invoke<T>(command, args);
}

/** 桥是否可用（只在 Tauri 壳里可能为 true）。结果缓存，`force` 可强制重查。 */
export async function webviewBridgeInfo(force = false): Promise<WebviewBridgeInfo> {
  if (cachedInfo && !force) return cachedInfo;
  if (!isTauriShell()) {
    cachedInfo = { enabled: false };
    return cachedInfo;
  }
  try {
    cachedInfo = await invokeBridge<WebviewBridgeInfo>("webview_bridge_info");
  } catch {
    cachedInfo = { enabled: false };
  }
  return cachedInfo;
}

/** label 规则，与 Rust `webview_bridge::label_for` 保持一致 */
export function webviewLabelFor(browserId: string, tabId = "tab0"): string {
  const sanitize = (value: string): string => value.replace(/[^A-Za-z0-9_-]/gu, "_");
  return `tile-${sanitize(browserId)}-${sanitize(tabId)}`;
}

export interface PhysicalRect {
  x: number;
  y: number;
  w: number;
  h: number;
}

/** CSS 像素矩形（DOMRect 形状）→ 物理像素矩形 */
export function toPhysicalRect(rect: { left: number; top: number; width: number; height: number }): PhysicalRect {
  const dpr = typeof window === "undefined" ? 1 : window.devicePixelRatio || 1;
  return {
    x: Math.round(rect.left * dpr),
    y: Math.round(rect.top * dpr),
    w: Math.round(rect.width * dpr),
    h: Math.round(rect.height * dpr),
  };
}

export async function setWebviewBounds(label: string, bounds: PhysicalRect): Promise<void> {
  await invokeBridge("webview_set_bounds", { label, x: bounds.x, y: bounds.y, w: bounds.w, h: bounds.h });
}

export async function setWebviewVisible(label: string, visible: boolean): Promise<void> {
  await invokeBridge("webview_set_visible", { label, visible });
}

/**
 * 切子 webview 的 z 序（不碰 IsVisible）。
 *
 * 子 webview 是独立子 HWND，DOM 的 z-index 管不到它；而 hide 会丢合成表面让 CDP 截图变空，
 * 所以「被卡片盖住」只能用 z 序表达：behind=true → 压到主 webview 之下（视觉消失但仍在渲染），
 * behind=false → 提回最上层。
 */
export async function setWebviewStacked(label: string, behind: boolean): Promise<void> {
  await invokeBridge("webview_set_stacked", { label, behind });
}

export async function closeWebview(label: string): Promise<void> {
  await invokeBridge("webview_close", { label });
}

export async function listWebviews(): Promise<{ labels: string[]; tiles: string[] }> {
  return await invokeBridge<{ labels: string[]; tiles: string[] }>("webview_list");
}
