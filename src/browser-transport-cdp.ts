/**
 * CDP 传输后端：不依赖 Playwright，直接用 HTTP 发现 + 原生 WebSocket + CDP 方法驱动浏览器。
 *
 * 为什么必须有它：发行版 sidecar 是 `bun --compile` 产物，而 Playwright 的传输层在 bun 下
 * 不工作（实测同一 `launchPersistentContext` 调用 node 648 ms 完成、bun 20 s 无返回）。
 * 本传输自行拉起浏览器并只走 CDP，因此与运行时无关——bun 与 node 都跑通过。
 *
 * 顺带拿到的两个好处：
 * - `navigator.webdriver === false`（我们自己启动，不带 `--enable-automation`；
 *   Playwright 的启动路径拿不到，`ignoreDefaultArgs` 也无效）；
 * - UA 不含 `HeadlessChrome`（有头启动时）。
 *
 * 与 Playwright 传输的已知语义差异（Phase 2(b)/3 收敛）：
 * - 只固定驱动一个页面目标，`tabs` 恒为 1。多标签是一等能力，随磁贴内嵌一起做。
 * - `click` 的"严格模式"是近似：匹配到多个元素时报错文案仿照 Playwright，但不是原生行为。
 */
import { spawn, type ChildProcess } from "node:child_process";
import fs from "node:fs";
import net from "node:net";
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
import {
  resolveBrowserExecutable,
  type BrowserDomAction,
  type BrowserLaunchOptions,
  type BrowserPageMeta,
  type BrowserSession,
  type BrowserTransport,
  type BrowserWaitKind,
  type BrowserWaitUntil,
  type SnapshotItem,
} from "./browser-transport.js";

const DEBUG_PORT_TIMEOUT_MS = 25_000;

/** 常用按键映射（其余单字符走 Input.insertText） */
const KEY_MAP: Record<string, { key: string; code: string; vk: number; text?: string }> = {
  Enter: { key: "Enter", code: "Enter", vk: 13, text: "\r" },
  Tab: { key: "Tab", code: "Tab", vk: 9 },
  Escape: { key: "Escape", code: "Escape", vk: 27 },
  Backspace: { key: "Backspace", code: "Backspace", vk: 8 },
  Delete: { key: "Delete", code: "Delete", vk: 46 },
  ArrowUp: { key: "ArrowUp", code: "ArrowUp", vk: 38 },
  ArrowDown: { key: "ArrowDown", code: "ArrowDown", vk: 40 },
  ArrowLeft: { key: "ArrowLeft", code: "ArrowLeft", vk: 37 },
  ArrowRight: { key: "ArrowRight", code: "ArrowRight", vk: 39 },
  Home: { key: "Home", code: "Home", vk: 36 },
  End: { key: "End", code: "End", vk: 35 },
  PageUp: { key: "PageUp", code: "PageUp", vk: 33 },
  PageDown: { key: "PageDown", code: "PageDown", vk: 34 },
  " ": { key: " ", code: "Space", vk: 32, text: " " },
};

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** 取一个空闲端口（供 `--remote-debugging-port` 使用） */
async function findFreePort(): Promise<number> {
  return await new Promise<number>((resolve, reject) => {
    const server = net.createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      const port = typeof address === "object" && address ? address.port : 0;
      server.close(() => (port ? resolve(port) : reject(new Error("无法分配空闲端口"))));
    });
  });
}

interface CdpMessage {
  id?: number;
  method?: string;
  params?: Record<string, unknown>;
  result?: Record<string, unknown>;
  error?: { code: number; message: string };
  sessionId?: string;
}

/**
 * 极简 CDP 客户端：单 WebSocket、自增 id、按 id 配 promise、事件按 (method, sessionId) 分发。
 * 扁平会话模式（`Target.attachToTarget({flatten:true})`）下，命令与事件都带 `sessionId`。
 */
class CdpConnection {
  private nextId = 1;
  private readonly pending = new Map<number, { resolve: (value: Record<string, unknown>) => void; reject: (error: Error) => void; method: string }>();
  private readonly listeners = new Set<(message: CdpMessage) => void>();
  private closed = false;

  private constructor(private readonly socket: WebSocket) {
    socket.onmessage = (event) => {
      let message: CdpMessage;
      try {
        message = JSON.parse(typeof event.data === "string" ? event.data : String(event.data)) as CdpMessage;
      } catch {
        return;
      }
      if (message.id !== undefined) {
        const slot = this.pending.get(message.id);
        if (!slot) return;
        this.pending.delete(message.id);
        if (message.error) slot.reject(new Error(`${slot.method}: ${message.error.message} (${message.error.code})`));
        else slot.resolve(message.result ?? {});
        return;
      }
      for (const listener of [...this.listeners]) listener(message);
    };
    socket.onclose = () => {
      this.closed = true;
      for (const slot of this.pending.values()) slot.reject(new Error(`${slot.method}: CDP 连接已关闭`));
      this.pending.clear();
    };
  }

  static async connect(url: string, timeoutMs = 10_000): Promise<CdpConnection> {
    return await new Promise<CdpConnection>((resolve, reject) => {
      const socket = new WebSocket(url);
      const timer = setTimeout(() => reject(new Error(`CDP WebSocket 连接超时：${url}`)), timeoutMs);
      socket.onopen = () => {
        clearTimeout(timer);
        resolve(new CdpConnection(socket));
      };
      socket.onerror = (event) => {
        clearTimeout(timer);
        reject(new Error(`CDP WebSocket 错误：${String((event as { message?: string })?.message ?? event)}`));
      };
    });
  }

  send(method: string, params: Record<string, unknown> = {}, sessionId?: string): Promise<Record<string, unknown>> {
    if (this.closed) return Promise.reject(new Error(`${method}: CDP 连接已关闭`));
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject, method });
      this.socket.send(JSON.stringify(sessionId ? { id, method, params, sessionId } : { id, method, params }));
    });
  }

  onEvent(listener: (message: CdpMessage) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /** 等一个事件（可按 sessionId 过滤） */
  waitForEvent(method: string, sessionId: string | undefined, timeoutMs: number): Promise<CdpMessage> {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        off();
        reject(new Error(`等待事件超时：${method}`));
      }, timeoutMs);
      const off = this.onEvent((message) => {
        if (message.method !== method) return;
        if (sessionId && message.sessionId && message.sessionId !== sessionId) return;
        clearTimeout(timer);
        off();
        resolve(message);
      });
    });
  }

  close(): void {
    this.closed = true;
    try {
      this.socket.close();
    } catch {
      // 已断开
    }
  }
}

async function fetchJson(url: string, timeoutMs = 5000): Promise<Record<string, unknown>> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, { signal: controller.signal });
    return (await response.json()) as Record<string, unknown>;
  } finally {
    clearTimeout(timer);
  }
}

class CdpSession implements BrowserSession {
  private connection: CdpConnection;
  private sessionId: string;
  private readonly child: ChildProcess;
  private readonly ephemeralDir: string | null;
  private frameUnsubscribe: (() => void) | null = null;
  private closed = false;

  constructor(input: { connection: CdpConnection; sessionId: string; child: ChildProcess; ephemeralDir: string | null }) {
    this.connection = input.connection;
    this.sessionId = input.sessionId;
    this.child = input.child;
    this.ephemeralDir = input.ephemeralDir;
  }

  private send(method: string, params: Record<string, unknown> = {}): Promise<Record<string, unknown>> {
    return this.connection.send(method, params, this.sessionId);
  }

  /** 求值并解包：`Runtime.evaluate` + `returnByValue`，异常显式抛出而不是静默 null */
  private async evalValue(expression: string): Promise<unknown> {
    const result = await this.send("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true });
    if (result.exceptionDetails) {
      const details = result.exceptionDetails as { text?: string; exception?: { description?: string } };
      throw new Error(`js exception: ${details.exception?.description ?? details.text ?? "unknown"}`);
    }
    return (result.result as { value?: unknown } | undefined)?.value ?? null;
  }

  async navigate(url: string, waitUntil: BrowserWaitUntil, timeoutMs: number): Promise<BrowserPageMeta> {
    const normalized = /^https?:\/\//i.test(url) ? url : `https://${url}`;
    await this.send("Page.enable");
    await this.send("Page.navigate", { url: normalized });

    // waitUntil=commit 只要求导航已提交，不等到文档就绪
    if (waitUntil !== "commit") {
      const want = waitUntil === "load" ? "complete" : "interactive";
      const deadline = Date.now() + timeoutMs;
      for (;;) {
        const state = (await this.evalValue("document.readyState").catch(() => null)) as string | null;
        if (state && (state === want || (want === "interactive" && state === "complete"))) break;
        if (Date.now() > deadline) throw new Error(`Timeout: 导航后文档未达到 ${want}`);
        await sleep(150);
      }
    }
    return await this.meta();
  }

  async snapshot(maxNodes: number): Promise<SnapshotItem[]> {
    return (await this.evalValue(snapshotScript(maxNodes))) as SnapshotItem[];
  }

  /**
   * 点击选择器。
   * Playwright 的 `click` 会自动等待元素出现并滚动入视口，这里用轮询 + `scrollIntoView` 近似。
   */
  async click(selector: string, timeoutMs: number): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const count = (await this.evalValue(selectorCountScript(selector)).catch(() => 0)) as number;
      if (count > 1) {
        throw new Error(`strict mode violation: locator('${selector}') resolved to ${count} elements`);
      }
      if (count === 1) {
        const center = (await this.evalValue(elementCenterScript(selector))) as { ok: boolean; x?: number; y?: number; reason?: string } | null;
        if (center?.ok && typeof center.x === "number" && typeof center.y === "number") {
          await this.clickAt(center.x, center.y);
          return;
        }
      }
      if (Date.now() > deadline) {
        throw new Error(`Timeout: 点击元素超时（selector=${selector}）`);
      }
      await sleep(200);
    }
  }

  async clickAt(x: number, y: number): Promise<void> {
    const point = { x: Math.round(x), y: Math.round(y), button: "left", clickCount: 1 };
    await this.send("Input.dispatchMouseEvent", { type: "mouseMoved", ...point });
    await this.send("Input.dispatchMouseEvent", { type: "mousePressed", ...point });
    await this.send("Input.dispatchMouseEvent", { type: "mouseReleased", ...point });
  }

  async fill(selector: string, text: string, timeoutMs: number): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const result = (await this.evalValue(fillScript(selector, text)).catch(() => null)) as { ok: boolean; mode?: string } | null;
      if (result?.ok) {
        // contenteditable 走真实输入，保证富文本/非受控场景也能生效
        if (result.mode === "contenteditable") {
          await this.send("Input.insertText", { text });
        }
        return;
      }
      if (Date.now() > deadline) throw new Error(`Timeout: 填充元素超时（selector=${selector}）`);
      await sleep(200);
    }
  }

  async press(key: string): Promise<void> {
    const mapped = KEY_MAP[key];
    if (!mapped) {
      // 单字符或未知键：直接插入文本（与原实现 press 失败后回落 insertText 一致）
      await this.send("Input.insertText", { text: key });
      return;
    }
    const base = { key: mapped.key, code: mapped.code, windowsVirtualKeyCode: mapped.vk, nativeVirtualKeyCode: mapped.vk };
    await this.send("Input.dispatchKeyEvent", { type: mapped.text ? "keyDown" : "rawKeyDown", ...base, ...(mapped.text ? { text: mapped.text } : {}) });
    await this.send("Input.dispatchKeyEvent", { type: "keyUp", ...base });
  }

  async domAction(action: BrowserDomAction, selector: string, text?: string): Promise<unknown> {
    switch (action) {
      case "fill": {
        const result = (await this.evalValue(fillScript(selector, text ?? ""))) as { ok: boolean };
        if (!result?.ok) throw new Error(`元素不存在：${selector}`);
        return true;
      }
      case "click": {
        await this.click(selector, 10_000);
        return true;
      }
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
      await sleep(200);
    }
  }

  async evaluate(script: string): Promise<unknown> {
    return this.evalValue(script);
  }

  async screenshot(): Promise<string> {
    const result = await this.send("Page.captureScreenshot", { format: "jpeg", quality: 70 });
    return `data:image/jpeg;base64,${String(result.data ?? "")}`;
  }

  async startScreencast(onFrame: (dataUrl: string) => void): Promise<boolean> {
    await this.send("Page.enable").catch(() => undefined);
    await this.send("Page.startScreencast", { format: "jpeg", quality: 60, maxWidth: 1280, maxHeight: 800, everyNthFrame: 1 }).catch(() => undefined);
    this.frameUnsubscribe?.();
    this.frameUnsubscribe = this.connection.onEvent((message) => {
      if (message.method !== "Page.screencastFrame") return;
      if (message.sessionId && message.sessionId !== this.sessionId) return;
      const params = message.params as { data?: string; sessionId?: number } | undefined;
      if (params?.sessionId !== undefined) {
        void this.send("Page.screencastFrameAck", { sessionId: params.sessionId }).catch(() => undefined);
      }
      if (params?.data) onFrame(`data:image/jpeg;base64,${params.data}`);
    });
    return true;
  }

  async stopScreencast(): Promise<void> {
    this.frameUnsubscribe?.();
    this.frameUnsubscribe = null;
    await this.send("Page.stopScreencast").catch(() => undefined);
  }

  async meta(): Promise<BrowserPageMeta> {
    const value = (await this.evalValue(PAGE_META_SCRIPT).catch(() => null)) as { url?: string; title?: string } | null;
    return { url: value?.url ?? "", title: value?.title ?? "", tabs: 1 };
  }

  tabsHint(fallback: number): number {
    // CDP 传输当前固定驱动一个页面目标；多标签随磁贴内嵌一起做（落地计划 Phase 2(b)/3）
    return this.closed ? fallback : 1;
  }

  nativeHandles(): { context: unknown; page: unknown } {
    // 逃生舱在 CDP 下没有对应物：需要 Playwright 特有能力（如 Cookie API）的调用方会拿到 null
    return { context: null, page: null };
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    this.frameUnsubscribe?.();
    this.frameUnsubscribe = null;
    await this.connection.send("Browser.close").catch(() => undefined);
    this.connection.close();
    // 必须等进程真的退出再返回：否则调用方紧接着删 profile 目录会撞上文件锁
    // （Windows 下表现为 EBUSY/EPERM，实测会把 deleteInstance 打断）
    const exited = await this.waitForExit(4000);
    if (!exited && this.child.pid) {
      try {
        this.child.kill();
      } catch {
        // 已退出
      }
      await this.waitForExit(3000);
    }
    if (this.ephemeralDir) {
      await fs.promises.rm(this.ephemeralDir, { recursive: true, force: true }).catch(() => undefined);
    }
  }

  private async waitForExit(timeoutMs: number): Promise<boolean> {
    if (this.child.exitCode !== null || this.child.signalCode !== null) return true;
    return await new Promise<boolean>((resolve) => {
      const onExit = (): void => {
        clearTimeout(timer);
        this.child.off("exit", onExit);
        resolve(true);
      };
      const timer = setTimeout(() => {
        this.child.off("exit", onExit);
        resolve(false);
      }, timeoutMs);
      this.child.once("exit", onExit);
    });
  }
}

export const cdpTransport: BrowserTransport = {
  name: "cdp",

  isAvailable(): boolean {
    // 只依赖 HTTP + WebSocket + 子进程，bun 与 node 都可用
    return true;
  },

  async launch(options: BrowserLaunchOptions): Promise<BrowserSession> {
    const { executablePath } = resolveBrowserExecutable();
    if (!executablePath) {
      throw new Error("没有找到可用的 Edge / Chrome 可执行文件；CDP 传输必须显式指定浏览器路径");
    }
    const headless = options.headless ?? false;
    const ephemeralDir = options.profileDir ? null : fs.mkdtempSync(path.join(process.env.MOMOKA_BROWSER_TEMP_ROOT?.trim() || os.tmpdir(), "momoka-incognito-"));
    const userDataDir = options.profileDir ?? ephemeralDir!;
    const port = await findFreePort();

    const args = [
      `--remote-debugging-port=${port}`,
      `--user-data-dir=${userDataDir}`,
      `--window-size=${options.viewport.width},${options.viewport.height}`,
      // 自动化标志一律不加：`navigator.webdriver` 保持 false（Playwright 的启动路径做不到）
      "--no-first-run",
      "--no-default-browser-check",
      "--disable-sync",
      ...(headless ? ["--headless=new"] : []),
    ];
    const child = spawn(executablePath, args, { stdio: "ignore", windowsHide: !headless });

    const cleanupOnFailure = async (): Promise<void> => {
      try {
        child.kill();
      } catch {
        // 已退出
      }
      if (ephemeralDir) await fs.promises.rm(ephemeralDir, { recursive: true, force: true }).catch(() => undefined);
    };

    try {
      // 等调试端口就绪
      const deadline = Date.now() + DEBUG_PORT_TIMEOUT_MS;
      let version: Record<string, unknown> | null = null;
      for (;;) {
        if (child.exitCode !== null) throw new Error(`浏览器进程提前退出（code=${child.exitCode}）`);
        version = await fetchJson(`http://127.0.0.1:${port}/json/version`).catch(() => null);
        if (version?.webSocketDebuggerUrl) break;
        if (Date.now() > deadline) throw new Error(`等待调试端口超时（--remote-debugging-port=${port}）`);
        await sleep(250);
      }

      const connection = await CdpConnection.connect(String(version.webSocketDebuggerUrl));
      // 不靠 /json/list 的顺序挑页面目标（实测第一条可能是 edge://sync-confirmation-dialog/），
      // 显式新建一个目标再附着，得到确定的 sessionId
      const created = await connection.send("Target.createTarget", { url: "about:blank" });
      const targetId = String(created.targetId ?? "");
      if (!targetId) throw new Error("Target.createTarget 未返回 targetId");
      const attached = await connection.send("Target.attachToTarget", { targetId, flatten: true });
      const sessionId = String(attached.sessionId ?? "");
      if (!sessionId) throw new Error("Target.attachToTarget 未返回 sessionId");

      return new CdpSession({ connection, sessionId, child, ephemeralDir });
    } catch (error) {
      await cleanupOnFailure();
      throw error;
    }
  },
};
