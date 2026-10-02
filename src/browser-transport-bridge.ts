/**
 * WebView2 桥传输：把页面操作转发给 Rust 侧的子 webview。
 *
 * 为什么需要第三条传输：前两条（Playwright / 外部浏览器 + CDP）都把页面渲染在**应用之外**，
 * 磁贴里只能放 screencast 帧投影——而那条路已被尖刀否决（帧不可操作、画质与坐标点击不可接受）。
 * 这条传输驱动的是真正嵌在 Tauri 窗口里的 WebView2 子视图，磁贴里就是活的页面。
 *
 * 进程边界：后端是 sidecar（独立进程），webview 活在 UI 进程。所以链路是
 *   后端 → HTTP（只监听 127.0.0.1 + token）→ Rust 桥 → ICoreWebView2Controller → CDP
 *
 * 与外部浏览器传输的关键差异：
 * - `launch()` 不启动任何浏览器进程，而是让 Rust 在窗口里创建一个**隐藏的**子 webview；
 *   真正的矩形由前端在磁贴布局里喂给 Rust（前端才知道磁贴落在哪）。
 * - `startScreencast()` 无意义（页面本来就在屏幕上），返回 false；`screenshot()` 仍然可用。
 * - 需要 Rust 侧桥在跑；桥不在时 `isAvailable()` 为 false，调用方回落。
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import {
  PAGE_META_SCRIPT,
  bodyTextContainsScript,
  elementCenterScript,
  fillScript,
  focusScript,
  inspectScript,
  selectorCountScript,
  selectorExistsScript,
  snapshotScript,
  urlMatchedScript,
} from "./browser-scripts.js";
import type {
  BrowserDomAction,
  BrowserLaunchOptions,
  BrowserPageMeta,
  BrowserSession,
  BrowserTransport,
  BrowserWaitKind,
  BrowserWaitUntil,
  SnapshotItem,
} from "./browser-transport.js";

/** 桥的注册文件（Rust 侧 `webview_bridge::bridge_file_path()` 写它） */
export function bridgeFilePath(): string {
  return path.join(process.env.MOMOKA_BRIDGE_FILE?.trim() || os.tmpdir(), "moduty.momoka.bridge");
}

interface BridgeHandle {
  port: number;
  token: string;
}

/** label 规则与 Rust 侧 `label_for` 保持一致 */
export function bridgeLabelFor(browserId: string, tabId: string): string {
  const sanitize = (value: string): string => value.replace(/[^A-Za-z0-9_-]/gu, "_");
  return `tile-${sanitize(browserId)}-${sanitize(tabId)}`;
}

function readBridgeHandle(): BridgeHandle | null {
  try {
    const parsed = JSON.parse(fs.readFileSync(bridgeFilePath(), "utf8")) as Record<string, unknown>;
    const port = typeof parsed.port === "number" ? parsed.port : 0;
    const token = typeof parsed.token === "string" ? parsed.token : "";
    return port > 0 && token ? { port, token } : null;
  } catch {
    return null;
  }
}

/** 桥是否可用：注册文件在 + `/health` 能答 */
export async function bridgeAvailable(timeoutMs = 1500): Promise<boolean> {
  const handle = readBridgeHandle();
  if (!handle) return false;
  try {
    await bridgeCall(handle, "GET", "/health", undefined, timeoutMs);
    return true;
  } catch {
    return false;
  }
}

async function bridgeCall(
  handle: BridgeHandle,
  method: "GET" | "POST",
  route: string,
  body?: unknown,
  timeoutMs = 30_000,
): Promise<Record<string, unknown>> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(`http://127.0.0.1:${handle.port}${route}`, {
      method,
      signal: controller.signal,
      headers: {
        authorization: `Bearer ${handle.token}`,
        ...(body === undefined ? {} : { "content-type": "application/json" }),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    const payload = (await response.json().catch(() => ({}))) as Record<string, unknown>;
    if (!response.ok) {
      throw new Error(typeof payload.error === "string" ? payload.error : `桥返回 ${response.status}`);
    }
    return payload;
  } finally {
    clearTimeout(timer);
  }
}

class BridgeSession implements BrowserSession {
  private readonly handle: BridgeHandle;
  private readonly label: string;
  private closed = false;

  constructor(handle: BridgeHandle, label: string) {
    this.handle = handle;
    this.label = label;
  }

  private call(route: string, body?: unknown, timeoutMs?: number): Promise<Record<string, unknown>> {
    return bridgeCall(this.handle, "POST", route, body, timeoutMs);
  }

  /** 求值并解包（桥的 `/eval` 已经解过一层 payload） */
  private async evalValue(expression: string): Promise<unknown> {
    const payload = await this.call("/eval", { label: this.label, expression });
    return payload.value ?? null;
  }

  private async cdp(method: string, params: Record<string, unknown>): Promise<Record<string, unknown>> {
    const payload = await this.call("/cdp", { label: this.label, method, params });
    const raw = typeof payload.result === "string" ? payload.result : "{}";
    return JSON.parse(raw) as Record<string, unknown>;
  }

  private async evalParsed<T>(expression: string): Promise<T> {
    // `/cdp` 返回的 result 是字符串化的载荷；`/eval` 已经解包，普通取值走 eval
    return (await this.evalValue(expression)) as T;
  }

  async navigate(url: string, waitUntil: BrowserWaitUntil, timeoutMs: number): Promise<BrowserPageMeta> {
    const normalized = /^https?:\/\//i.test(url) ? url : `https://${url}`;
    await this.cdp("Page.enable", {});
    await this.cdp("Page.navigate", { url: normalized });
    if (waitUntil !== "commit") {
      // 桥侧 /wait-ready 同时校验 URL 前缀与 readyState：
      // 只看 readyState 会在 about:blank（其 readyState 也是 complete）上误判通过
      await this.call("/wait-ready", { label: this.label, prefix: normalized.slice(0, 64), timeoutMs }, timeoutMs + 5000).catch(() => undefined);
      const want = waitUntil === "load" ? "complete" : "interactive";
      const deadline = Date.now() + timeoutMs;
      for (;;) {
        const state = await this.evalValue("document.readyState").catch(() => null);
        if (state === want || (want === "interactive" && state === "complete")) break;
        if (Date.now() > deadline) throw new Error(`Timeout: 导航后文档未达到 ${want}`);
        await new Promise((resolve) => setTimeout(resolve, 150));
      }
    }
    return await this.meta();
  }

  async snapshot(maxNodes: number): Promise<SnapshotItem[]> {
    return this.evalParsed<SnapshotItem[]>(snapshotScript(maxNodes));
  }

  async click(selector: string, timeoutMs: number): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const count = (await this.evalValue(selectorCountScript(selector)).catch(() => 0)) as number;
      if (count > 1) {
        throw new Error(`strict mode violation: locator('${selector}') resolved to ${count} elements`);
      }
      if (count === 1) {
        const center = (await this.evalValue(elementCenterScript(selector))) as { ok: boolean; x?: number; y?: number } | null;
        if (center?.ok && typeof center.x === "number" && typeof center.y === "number") {
          await this.clickAt(center.x, center.y);
          return;
        }
      }
      if (Date.now() > deadline) throw new Error(`Timeout: 点击元素超时（selector=${selector}）`);
      await new Promise((resolve) => setTimeout(resolve, 200));
    }
  }

  async clickAt(x: number, y: number): Promise<void> {
    const point = { x: Math.round(x), y: Math.round(y), button: "left", clickCount: 1 };
    await this.cdp("Input.dispatchMouseEvent", { type: "mouseMoved", ...point });
    await this.cdp("Input.dispatchMouseEvent", { type: "mousePressed", ...point });
    await this.cdp("Input.dispatchMouseEvent", { type: "mouseReleased", ...point });
  }

  async fill(selector: string, text: string, timeoutMs: number): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const result = (await this.evalValue(fillScript(selector, text)).catch(() => null)) as { ok: boolean } | null;
      if (result?.ok) return;
      if (Date.now() > deadline) throw new Error(`Timeout: 填充元素超时（selector=${selector}）`);
      await new Promise((resolve) => setTimeout(resolve, 200));
    }
  }

  async press(key: string): Promise<void> {
    const map: Record<string, { key: string; code: string; vk: number; text?: string }> = {
      Enter: { key: "Enter", code: "Enter", vk: 13, text: "\r" },
      Tab: { key: "Tab", code: "Tab", vk: 9 },
      Escape: { key: "Escape", code: "Escape", vk: 27 },
      Backspace: { key: "Backspace", code: "Backspace", vk: 8 },
      Delete: { key: "Delete", code: "Delete", vk: 46 },
      ArrowUp: { key: "ArrowUp", code: "ArrowUp", vk: 38 },
      ArrowDown: { key: "ArrowDown", code: "ArrowDown", vk: 40 },
      ArrowLeft: { key: "ArrowLeft", code: "ArrowLeft", vk: 37 },
      ArrowRight: { key: "ArrowRight", code: "ArrowRight", vk: 39 },
    };
    const mapped = map[key];
    if (!mapped) {
      await this.cdp("Input.insertText", { text: key });
      return;
    }
    const base = { key: mapped.key, code: mapped.code, windowsVirtualKeyCode: mapped.vk, nativeVirtualKeyCode: mapped.vk };
    await this.cdp("Input.dispatchKeyEvent", { type: mapped.text ? "keyDown" : "rawKeyDown", ...base, ...(mapped.text ? { text: mapped.text } : {}) });
    await this.cdp("Input.dispatchKeyEvent", { type: "keyUp", ...base });
  }

  async domAction(action: BrowserDomAction, selector: string, text?: string): Promise<unknown> {
    switch (action) {
      case "fill": {
        const result = (await this.evalValue(fillScript(selector, text ?? ""))) as { ok: boolean };
        if (!result?.ok) throw new Error(`元素不存在：${selector}`);
        return true;
      }
      case "click":
        await this.click(selector, 10_000);
        return true;
      case "focus": {
        const ok = await this.evalValue(focusScript(selector));
        if (!ok) throw new Error(`元素不存在：${selector}`);
        return true;
      }
      case "inspect": {
        const value = await this.evalValue(inspectScript(selector));
        if (value === null) throw new Error(`元素不存在：${selector}`);
        return value;
      }
    }
  }

  async waitFor(kind: BrowserWaitKind, value: string, timeoutMs: number): Promise<void> {
    const escaped = value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const expression =
      kind === "url" ? urlMatchedScript(escaped) : kind === "text" ? bodyTextContainsScript(value) : selectorExistsScript(value);
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const matched = await this.evalValue(expression).catch(() => false);
      if (matched === true) return;
      if (Date.now() > deadline) throw new Error(`Timeout: 等待 ${kind}=${value} 超时`);
      await new Promise((resolve) => setTimeout(resolve, 200));
    }
  }

  async evaluate(script: string): Promise<unknown> {
    return this.evalValue(script);
  }

  async screenshot(): Promise<string> {
    const result = await this.cdp("Page.captureScreenshot", { format: "jpeg", quality: 70 });
    const data = String(result.data ?? "");
    if (!data) {
      // 隐藏中的 webview 没有合成表面，CDP 会返回空数据。
      // 千万不要改用 `fromSurface: false` 去“偷帧”——实测它会把该 webview 的
      // CDP 彻底挂住（之后连 Runtime.evaluate 也不再返回）。
      throw new Error("截图不可用：该浏览器磁贴当前处于隐藏状态（页面没有合成表面）。请先显示磁贴，或改用 embedded=false 的外部浏览器实例。");
    }
    return `data:image/jpeg;base64,${data}`;
  }

  async startScreencast(): Promise<boolean> {
    // 原生内嵌时页面本来就在屏幕上，不需要帧流
    return false;
  }

  async stopScreencast(): Promise<void> {
    // 同上
  }

  async meta(): Promise<BrowserPageMeta> {
    const value = (await this.evalValue(PAGE_META_SCRIPT).catch(() => null)) as { url?: string; title?: string } | null;
    return { url: value?.url ?? "", title: value?.title ?? "", tabs: 1 };
  }

  tabsHint(fallback: number): number {
    return this.closed ? fallback : 1;
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    await this.call("/webviews/close", { label: this.label }).catch(() => undefined);
  }

  /** 供 browser-service 把前端喂进来的矩形转给 Rust（前端直接调 Tauri 命令，这里只做后端侧兜底） */
  async setBounds(bounds: { x: number; y: number; w: number; h: number }): Promise<void> {
    await this.call("/webviews/bounds", { label: this.label, bounds });
  }

  getLabel(): string {
    return this.label;
  }
}

export const bridgeTransport: BrowserTransport = {
  name: "bridge",

  isAvailable(): boolean {
    // 同步判断只看注册文件在不在；真正的可用性（/health）在 launch 时校验
    return readBridgeHandle() !== null;
  },

  async launch(options: BrowserLaunchOptions & { browserId?: string }): Promise<BrowserSession> {
    const handle = readBridgeHandle();
    if (!handle) {
      throw new Error(`WebView2 桥未就绪：找不到 ${bridgeFilePath()}（应用未以 Tauri 壳启动，或桥被 MOMOKA_WEBVIEW_BRIDGE 关闭）`);
    }
    const browserId = options.browserId ?? "brw_unknown";
    const label = bridgeLabelFor(browserId, "tab0");
    // 建一个磁贴内嵌的 webview。**刻意不在这里隐藏**：
    // 实测隐藏中的 webview 没有合成表面，`Page.captureScreenshot` 只会拿到空数据，
    // 而截图是 Agent 的主要观察手段。矩形随后由前端磁贴布局喂进来（set_bounds），
    // 显隐也由前端按宿主可见性控制（set_visible）。
    await bridgeCall(handle, "POST", "/webviews", {
      label,
      url: "about:blank",
      ...(options.profileDir ? { profileDir: options.profileDir } : {}),
      incognito: options.profileDir === null,
      bounds: { x: 0, y: 0, w: options.viewport.width, h: options.viewport.height },
    }, 60_000);
    // 建完先压到主窗口内容**之下**：0,0×视口只是为了让 headless 的 webview 有合成表面（截图要用），
    // 不能让这个占位矩形真的盖在前端界面上。前端宿主（BrowserView）挂上并喂完矩形后会把它提回最上层，
    // 被卡片盖住时再压回去（见 desktop/src/components/BrowserView.tsx）。
    await bridgeCall(handle, "POST", "/webviews/stacked", { label, behind: true }, 15_000).catch(() => undefined);
    return new BridgeSession(handle, label);
  },
};
