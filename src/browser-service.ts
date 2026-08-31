/**
 * 受控浏览器服务（参考 agent-browser / Proma 受管浏览器模式）。
 *
 * - 每个实例 = 一个浏览器磁贴：独立 playright 浏览器上下文。
 * - 双模式：persistent（正常模式，userDataDir 持久化登录/Cookie，profile 存
 *   ~/.momoka/browser-profiles/<id>）与 incognito（无痕，临时目录，关闭即毁）。
 * - 页面渲染用 CDP screencast 帧流推给磁贴（<img> 实时画面）；用户点击坐标 →
 *   playwright mouse 注入（真实浏览器，非 iframe）。
 * - Agent 通过 browse_* 工具引用 browser_id 操作同一实例——浏览器与 Agent 解耦。
 * - 引擎：复用系统 Edge（Windows WebView2 同源，发布无需打包浏览器）。
 */
import { chromium, type Browser, type BrowserContext, type Page } from "playwright-core";
import path from "node:path";
import os from "node:os";
import fs from "node:fs";
import { randomUUID } from "node:crypto";

export type BrowserMode = "persistent" | "incognito";
export type BrowserInstanceState = "closed" | "launching" | "ready" | "error";

export interface BrowserInstanceInfo {
  id: string;
  name: string;
  mode: BrowserMode;
  state: BrowserInstanceState;
  url: string | null;
  title: string | null;
  tabs: number;
  createdAt: string;
  lastActiveAt: string;
  profileDir: string | null;
  error?: string;
}

export interface SnapshotTree {
  tree: string;
  refs: Record<string, string>;
}

interface RuntimeInstance {
  info: BrowserInstanceInfo;
  context: BrowserContext | null;
  page: Page | null;
  frameCallback: ((dataUrl: string) => void) | null;
  refMap: Record<string, string>;
  lastSnapshot: string;
}

const EDGE_CANDIDATES = [
  "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe",
  "C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe",
  "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
  "C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe",
];

function resolveExecutable(): string | undefined {
  return EDGE_CANDIDATES.find((candidate) => fs.existsSync(candidate));
}

function profileRoot(): string {
  const dir = path.join(os.homedir(), ".momoka", "browser-profiles");
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

/** 把 Playwright 错误转译为 AI/用户友好消息（参考 agent-browser toAIFriendlyError） */
export function toBrowserFriendlyError(error: unknown, hint?: string): string {
  const message = error instanceof Error ? error.message : String(error);
  const base = hint ? `${hint}: ${message}` : message;
  if (message.includes("strict mode violation")) {
    return `${hint ?? "操作"}: 选择器匹配到多个元素，请先 snapshot 获取 ref 或用更精确的 CSS 选择器。`;
  }
  if (message.includes("intercepts pointer events")) {
    return `${hint ?? "操作"}: 目标被其他元素遮挡（可能是弹窗/遮罩），先关闭弹窗再试。`;
  }
  if (message.includes("not visible") && message.includes("Timeout")) {
    return `${hint ?? "操作"}: 元素不可见，尝试滚动到可视区域或检查是否被隐藏。`;
  }
  if (message.includes("Timeout")) {
    return `${hint ?? "操作"}: 操作超时（元素未就绪）。`;
  }
  return base;
}

export interface BrowserServiceEvent {
  type: "browser_created" | "browser_deleted" | "browser_state";
  browser: BrowserInstanceInfo;
}

class BrowserService {
  private readonly instances = new Map<string, RuntimeInstance>();

  /** 浏览器生命周期事件（created / deleted / state）；订阅方 = /api/browsers/events SSE */
  private readonly listeners = new Set<(event: BrowserServiceEvent) => void>();

  onEvent(listener: (event: BrowserServiceEvent) => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  private emit(event: BrowserServiceEvent): void {
    for (const listener of [...this.listeners]) {
      listener(event);
    }
  }

  async list(): Promise<BrowserInstanceInfo[]> {
    const infos: BrowserInstanceInfo[] = [];
    for (const runtime of this.instances.values()) {
      const stale = runtime.info.state === "ready" && !runtime.context;
      if (stale) {
        runtime.info.state = "closed";
      }
      infos.push({ ...runtime.info, tabs: runtime.context?.pages().length ?? runtime.info.tabs });
    }
    return infos.sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1));
  }

  getInfo(id: string): BrowserInstanceInfo | null {
    const runtime = this.instances.get(id);
    return runtime ? { ...runtime.info, tabs: runtime.context?.pages().length ?? runtime.info.tabs } : null;
  }

  getPage(id: string): Page | null {
    const runtime = this.instances.get(id);
    if (!runtime?.context || !runtime.page) {
      return null;
    }
    // 跟随用户切换的 active tab：取前台页面（context.pages 最后一个通常是最近激活的）
    const pages = runtime.context.pages();
    if (!pages.includes(runtime.page) && pages.length > 0) {
      runtime.page = pages[pages.length - 1];
    }
    return runtime.page;
  }

  getContext(id: string): BrowserContext | null {
    return this.instances.get(id)?.context ?? null;
  }

  /** 创建实例（不启动；磁贴打开时才 launch）。persistent 模式建立持久化 profile 目录。 */
  async createInstance(input: { name?: string; mode?: BrowserMode }): Promise<BrowserInstanceInfo> {
    const id = `brw_${randomUUID().slice(0, 12)}`;
    const mode: BrowserMode = input.mode === "persistent" ? "persistent" : "incognito";
    const now = new Date().toISOString();
    const name = (input.name ?? "").trim() || (mode === "persistent" ? "浏览器" : "无痕浏览器");
    const info: BrowserInstanceInfo = {
      id,
      name,
      mode,
      state: "closed",
      url: null,
      title: null,
      tabs: 0,
      createdAt: now,
      lastActiveAt: now,
      profileDir: mode === "persistent" ? path.join(profileRoot(), id) : null,
    };
    if (mode === "persistent") {
      fs.mkdirSync(info.profileDir!, { recursive: true });
    }
    this.instances.set(id, { info, context: null, page: null, frameCallback: null, refMap: {}, lastSnapshot: "" });
    this.emit({ type: "browser_created", browser: { ...info } });
    return { ...info };
  }

  async deleteInstance(id: string): Promise<boolean> {
    const runtime = this.instances.get(id);
    if (!runtime) {
      return false;
    }
    await this.closeInstance(id);
    if (runtime.info.mode === "persistent" && runtime.info.profileDir) {
      await fs.promises.rm(runtime.info.profileDir, { recursive: true, force: true }).catch(() => undefined);
    }
    this.instances.delete(id);
    this.emit({ type: "browser_deleted", browser: { ...runtime.info } });
    return true;
  }

  async closeInstance(id: string): Promise<void> {
    const runtime = this.instances.get(id);
    if (!runtime) {
      return;
    }
    runtime.frameCallback = null;
    if (runtime.context) {
      await runtime.context.close().catch(() => undefined);
    }
    runtime.context = null;
    runtime.page = null;
    runtime.info.state = "closed";
    runtime.info.tabs = 0;
    runtime.info.lastActiveAt = new Date().toISOString();
  }

  /** 启动实例（打开磁贴时调用；幂等：已 ready 直接返回） */
  async launch(id: string): Promise<BrowserInstanceInfo> {
    const runtime = this.instances.get(id);
    if (!runtime) {
      throw new Error(`浏览器实例不存在: ${id}`);
    }
    if (runtime.context) {
      return { ...runtime.info };
    }
    runtime.info.state = "launching";
    try {
      const executablePath = resolveExecutable();
      const context = await chromium.launchPersistentContext(runtime.info.profileDir ?? "", {
        executablePath,
        headless: true,
        viewport: { width: 1280, height: 800 },
        deviceScaleFactor: 1,
      });
      const pages = context.pages();
      const page = pages[0] ?? (await context.newPage());
      runtime.context = context;
      runtime.page = page;
      runtime.info.state = "ready";
      runtime.info.lastActiveAt = new Date().toISOString();
      runtime.info.tabs = context.pages().length;
      runtime.info.title = (await page.title().catch(() => null)) ?? "";
      this.emit({ type: "browser_state", browser: { ...runtime.info } });
      return { ...runtime.info };
    } catch (error) {
      runtime.info.state = "error";
      runtime.info.error = error instanceof Error ? error.message : String(error);
      runtime.context = null;
      runtime.page = null;
      throw new Error(`浏览器启动失败: ${runtime.info.error}`);
    }
  }

  async navigate(id: string, url: string, waitUntil: "load" | "domcontentloaded" | "commit" = "domcontentloaded"): Promise<{ url: string; title: string } | null> {
    const page = this.getPage(id);
    if (!page) {
      return null;
    }
    const normalized = /^https?:\/\//i.test(url) ? url : `https://${url}`;
    await page.goto(normalized, { waitUntil, timeout: 30_000 });
    const info = this.instances.get(id)!;
    info.info.url = page.url();
    info.info.title = await page.title().catch(() => "");
    info.info.lastActiveAt = new Date().toISOString();
    info.info.tabs = info.context?.pages().length ?? 1;
    return { url: page.url(), title: info.info.title ?? "" };
  }

  /**
   * 观察页面：生成 AX 风格快照树 + ref 映射。
   * 轻量实现（参考 agent-browser snapshot.js）：收集可交互/文本元素，
   * 每个元素生成唯一 CSS selector；ref = [i] 序号，click/fill 可用 ref 或 selector。
   */
  async snapshot(id: string, maxNodes = 120): Promise<SnapshotTree | null> {
    const page = this.getPage(id);
    if (!page) {
      return null;
    }
    // 字符串形式执行（绕开 esbuild 对模块内函数注入的 __name helper，浏览器端无法解析）
    const items = (await page.evaluate(`(() => {
      const max = ${maxNodes};
      const out = [];
      const uniqueId = (el) => {
        if (el.id) return '#' + CSS.escape(el.id);
        return '';
      };
      const cssPath = (el) => {
        const uid = uniqueId(el);
        if (uid) return uid;
        const parts = [];
        let node = el;
        while (node && node.nodeType === 1 && parts.length < 6) {
          let part;
          if (node.id) {
            part = node.tagName.toLowerCase() + '#' + CSS.escape(node.id);
            parts.unshift(part);
            break;
          }
          const parent = node.parentElement;
          if (parent) {
            const children = Array.from(parent.children);
            const index = children.indexOf(node);
            part = index >= 0 ? node.tagName.toLowerCase() + ':nth-child(' + (index + 1) + ')' : node.tagName.toLowerCase();
          } else {
            part = node.tagName.toLowerCase();
          }
          parts.unshift(part);
          node = parent;
        }
        return parts.join(' > ');
      };
      const roleOf = (tag) => {
        if (tag === 'a') return 'link';
        if (tag === 'button') return 'button';
        if (tag === 'input') return 'textbox';
        if (tag === 'textarea') return 'textbox';
        if (tag === 'select') return 'listbox';
        if (tag === 'img') return 'img';
        if (tag === 'h1' || tag === 'h2' || tag === 'h3') return 'heading';
        return 'text';
      };
      const walk = (root) => {
        if (out.length >= max) return;
        const nodes = root.querySelectorAll('a,button,input,textarea,select,label,img,[role],[tabindex],h1,h2,h3,li,p,span,[contenteditable]');
        for (const el of Array.from(nodes).slice(0, max)) {
          const tag = el.tagName.toLowerCase();
          const role = el.getAttribute('role') || roleOf(tag);
          const aria = el.getAttribute('aria-label');
          const placeholder = el.getAttribute('placeholder');
          const title = el.getAttribute('title');
          const text = (el.innerText || '').trim().replace(/\s+/g, ' ').slice(0, 100);
          const value = el.value ? ' value="' + el.value.slice(0, 40) + '"' : '';
          const name = aria || placeholder || title || text;
          const visible = !!(el.offsetParent || el.getClientRects().length > 0) && name.length > 0;
          if (!visible) continue;
          out.push({ tag: tag, role: role, name: name, sel: cssPath(el), visible: true, value: value });
          if (out.length >= max) break;
        }
      };
      walk(document.body || document.documentElement);
      return out;
    })()`)) as Array<{ tag: string; role: string; name: string; sel: string; visible: boolean; value: string }>;

    const lines: string[] = [];
    const refs: Record<string, string> = {};
    items.forEach((item, index) => {
      const ref = `[${index}]`;
      refs[ref] = item.sel;
      lines.push(`${ref} ${item.role} ${item.name}${item.value ?? ""} <${item.sel}>`);
    });
    const tree = lines.length > 0 ? lines.join("\n") : "(页面无可交互元素或尚未加载)";
    const runtime = this.instances.get(id);
    if (runtime) {
      runtime.refMap = refs;
      runtime.lastSnapshot = tree;
    }
    return { tree, refs };
  }

  resolveSelector(id: string, selector: string, ref: string | undefined): string | null {
    const runtime = this.instances.get(id);
    if (!runtime) return null;
    if (ref && runtime.refMap[ref]) {
      return runtime.refMap[ref];
    }
    return selector || null;
  }

  async click(id: string, selector: string, ref?: string): Promise<boolean> {
    const page = this.getPage(id);
    const resolved = this.resolveSelector(id, selector, ref);
    if (!page || !resolved) return false;
    await page.click(resolved, { timeout: 10_000 });
    return true;
  }

  /** 磁贴画面点击（坐标支持）：x,y 相对视口 */
  async clickAt(id: string, x: number, y: number): Promise<boolean> {
    const page = this.getPage(id);
    if (!page) return false;
    await page.mouse.click(x, y);
    const info = this.instances.get(id)!;
    info.info.lastActiveAt = new Date().toISOString();
    return true;
  }

  async fill(id: string, selector: string, text: string, ref?: string): Promise<boolean> {
    const page = this.getPage(id);
    const resolved = this.resolveSelector(id, selector, ref);
    if (!page || !resolved) return false;
    await page.fill(resolved, text, { timeout: 10_000 });
    return true;
  }

  async press(id: string, key: string): Promise<boolean> {
    const page = this.getPage(id);
    if (!page) return false;
    await page.keyboard.press(key).catch(() => page.keyboard.insertText(key));
    return true;
  }

  async domAction(id: string, action: "focus" | "fill" | "click" | "inspect", selector: string, text?: string): Promise<unknown> {
    const page = this.getPage(id);
    if (!page) return null;
    switch (action) {
      case "fill": {
        await page.locator(selector).fill(text ?? "");
        return true;
      }
      case "click": {
        await page.locator(selector).click({ timeout: 10_000 });
        return true;
      }
      case "focus": {
        await page.locator(selector).focus();
        return true;
      }
      case "inspect": {
        return page.locator(selector).evaluate((el) => {
          const rect = el.getBoundingClientRect();
          return {
            tag: el.tagName,
            text: (el.textContent ?? "").trim().slice(0, 200),
            attrs: Array.from(el.attributes).slice(0, 20).map((attr) => `${attr.name}=${attr.value.slice(0, 50)}`),
            x: Math.round(rect.x),
            y: Math.round(rect.y),
            w: Math.round(rect.width),
            h: Math.round(rect.height),
          };
        });
      }
    }
  }

  async waitFor(id: string, kind: "url" | "text" | "selector", value: string, timeoutMs = 10_000): Promise<boolean> {
    const page = this.getPage(id);
    if (!page) return false;
    if (kind === "url") {
      await page.waitForURL(new RegExp(value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")), { timeout: timeoutMs });
      return true;
    }
    if (kind === "text") {
      await page.waitForSelector(`text=${value}`, { timeout: timeoutMs });
      return true;
    }
    await page.waitForSelector(value, { timeout: timeoutMs });
    return true;
  }

  async executeJS(id: string, script: string): Promise<unknown> {
    const page = this.getPage(id);
    if (!page) return null;
    // 表达式求值（绕开 esbuild __name；只执行调用方明确提供的脚本）
    return page.evaluate(script);
  }

  async screenshot(id: string): Promise<string | null> {
    const page = this.getPage(id);
    if (!page) return null;
    return page.screenshot({ type: "jpeg", quality: 70 }).then((buf) => `data:image/jpeg;base64,${buf.toString("base64")}`);
  }

  /** 启动/停止 CDP screencast 帧流；frameCallback 收到 data URL（jpeg） */
  async screencast(id: string, enabled: boolean, callback?: (dataUrl: string) => void): Promise<boolean> {
    const runtime = this.instances.get(id);
    const page = runtime?.page;
    if (!runtime || !page || !runtime.context) return false;
    runtime.frameCallback = enabled ? callback ?? null : null;
    const cdp = await runtime.context.newCDPSession(page).catch(() => null);
    if (!cdp) return false;
    if (enabled) {
      await cdp.send("Page.enable").catch(() => undefined);
      await cdp.send("Page.startScreencast", {
        format: "jpeg",
        quality: 60,
        maxWidth: 1280,
        maxHeight: 800,
        everyNthFrame: 1,
      }).catch(() => undefined);
      cdp.on("Page.screencastFrame", ({ data, sessionId }: { data: string; sessionId: number }) => {
        void cdp.send("Page.screencastFrameAck", { sessionId }).catch(() => undefined);
        if (runtime.frameCallback) {
          runtime.frameCallback(`data:image/jpeg;base64,${data}`);
        }
      });
    } else {
      await cdp.send("Page.stopScreencast").catch(() => undefined);
    }
    return true;
  }

  /** 页面变化后刷新实例元信息（标题/URL/tabs） */
  async touch(id: string): Promise<BrowserInstanceInfo | null> {
    const page = this.getPage(id);
    const runtime = this.instances.get(id);
    if (!page || !runtime) return runtime ? { ...runtime.info } : null;
    runtime.info.url = page.url() || runtime.info.url;
    runtime.info.title = (await page.title().catch(() => null)) ?? runtime.info.title;
    runtime.info.tabs = runtime.context?.pages().length ?? 1;
    runtime.info.lastActiveAt = new Date().toISOString();
    return { ...runtime.info };
  }

  async closeAll(): Promise<void> {
    for (const id of [...this.instances.keys()]) {
      await this.closeInstance(id);
    }
  }
}

/** 全局单例：浏览器与 Agent 解耦（Agent 工具经 browse_* 引用实例，不拥有实例） */
export const browserService = new BrowserService();