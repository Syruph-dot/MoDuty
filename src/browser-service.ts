/**
 * 受控浏览器服务（参考 agent-browser / Proma 受管浏览器模式）。
 *
 * - 每个实例 = 一个浏览器磁贴：独立浏览器 profile（persistent 持久化登录态，
 *   incognito 关掉即毁）。
 * - 页面操作全部委托给可替换的**传输后端**（`browser-transport.ts`）：
 *   `browser-service` 只负责实例注册表、profile 目录、ref 映射、事件与错误转译。
 *   这样做的直接原因是打包运行时换成了 bun，而 Playwright 的传输层在 bun 下不工作。
 * - 页面渲染仍用 CDP screencast 帧流推给磁贴（<img> 实时画面）；用户点击坐标 →
 *   鼠标事件注入（真实浏览器，非 iframe）。原生 webview 内嵌见落地计划 Phase 2(b)/3。
 * - Agent 通过 browse_* 工具引用 browser_id 操作同一实例——浏览器与 Agent 解耦。
 * - 引擎：复用系统 Edge（Windows WebView2 同源，发布无需打包浏览器）。
 */
import { randomUUID } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import type { BrowserLaunchOptions, BrowserSession, BrowserTransport } from "./browser-transport.js";
import { resolveBrowserExecutable } from "./browser-transport.js";
import { playwrightTransport } from "./browser-transport-playwright.js";
import { cdpTransport } from "./browser-transport-cdp.js";
import { bridgeTransport } from "./browser-transport-bridge.js";
// 仅类型：给 getContext/getPage 这个逃生艇签名用，不引入运行期耦合
import type { BrowserContext, Page } from "playwright-core";

export type BrowserMode = "persistent" | "incognito";
export type BrowserInstanceState = "closed" | "launching" | "ready" | "error";

/** 传输后端名（便于排查"实际用的是哪条路"） */
export type BrowserTransportName = BrowserTransport["name"];

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
  /** 实际使用的传输后端 */
  transport?: BrowserTransportName;
  /** 是否磁贴内嵌（true = 页面嵌在应用窗口里；false = 外部浏览器窗口） */
  embedded?: boolean;
  /** 实际使用的浏览器可执行文件（解析不到时为空，见 resolveBrowserExecutable 的说明） */
  executablePath?: string;
}

export interface SnapshotTree {
  tree: string;
  refs: Record<string, string>;
}

interface RuntimeInstance {
  info: BrowserInstanceInfo;
  session: BrowserSession | null;
  frameCallback: ((dataUrl: string) => void) | null;
  refMap: Record<string, string>;
  lastSnapshot: string;
}

const DEFAULT_VIEWPORT = { width: 1280, height: 800 };

/**
 * 传输后端候选，按优先级：
 * - node / tsx（dev 与测试）：优先 Playwright，行为与改动前一致；
 * - bun（发行版 sidecar）：Playwright 不可用，自动落到 CDP。
 * 可用 MOMOKA_BROWSER_TRANSPORT 显式指定，用来在 dev 下强制验证 CDP 传输。
 */
function buildTransports(): BrowserTransport[] {
  // 顺序即优先级（仅用于外部浏览器场景）：node 下优先 Playwright（与历史行为一致），
  // bun 下它不可用、自动落到 CDP。磁贴内嵌不走这个顺序，见 selectTransport。
  return [playwrightTransport, cdpTransport, bridgeTransport];
}

/**
 * 是否无头。
 *
 * 默认值是**分传输**的：Playwright 路径保持历史行为（无头），CDP 路径有头，
 * 因为 CDP 有头启动才能同时拿到干净 UA（无 `HeadlessChrome`）与 `webdriver=false`。
 * `MOMOKA_BROWSER_HEADLESS=1|0` 可显式覆盖。
 */
function resolveHeadless(transportName: BrowserTransport["name"]): boolean {
  const raw = process.env.MOMOKA_BROWSER_HEADLESS?.trim();
  if (raw === "1" || raw === "true") return true;
  if (raw === "0" || raw === "false") return false;
  return transportName !== "cdp";
}

function selectTransport(options: { embedded: boolean }): BrowserTransport {
  const list = buildTransports();
  const forced = process.env.MOMOKA_BROWSER_TRANSPORT?.trim();
  if (forced) {
    const match = list.find((transport) => transport.name === forced);
    if (!match) throw new Error(`MOMOKA_BROWSER_TRANSPORT=${forced} 不是已知传输（候选：${list.map((t) => t.name).join(" / ")}）`);
    if (!match.isAvailable()) throw new Error(`MOMOKA_BROWSER_TRANSPORT=${forced} 在当前运行时不可用`);
    return match;
  }
  // 磁贴内嵌与外部浏览器是两条路，不互相回落：
  // embedded 时页面必须嵌在应用窗口里，桥不在就明确报错，否则用户会看到“磁贴里没画面”这种诡异状态
  if (options.embedded) {
    if (!bridgeTransport.isAvailable()) {
      throw new Error(
        "磁贴内嵌需要 WebView2 桥（只在 Tauri 壳启动时才有）。找不到桥的注册文件；"
        + "若只想开外部浏览器窗口，请用 embedded=false 建实例。",
      );
    }
    return bridgeTransport;
  }
  const available = list.filter((transport) => transport.name !== "bridge").find((transport) => transport.isAvailable());
  if (!available) {
    const names = list.map((transport) => transport.name).join(" / ");
    throw new Error(`没有可用的浏览器传输后端（候选：${names}）；当前运行时 ${process.versions.bun ? `bun ${process.versions.bun}` : `node ${process.versions.node}`}`);
  }
  return available;
}

function profileRoot(): string {
  const dir = process.env.MOMOKA_BROWSER_PROFILE_ROOT || path.join(os.homedir(), ".momoka", "browser-profiles");
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

const BROWSER_ID_RE = /^brw_[A-Za-z0-9_-]{1,80}$/u;

function persistedInfo(id: string, name: string, createdAt: string): BrowserInstanceInfo {
  return {
    id, name, mode: "persistent", state: "closed", url: null, title: null, tabs: 0,
    createdAt, lastActiveAt: createdAt, profileDir: path.join(profileRoot(), id),
  };
}

/** 把传输层抛出的错误转译为 AI/用户友好消息（参考 agent-browser toAIFriendlyError） */
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

export class BrowserService {
  private readonly instances = new Map<string, RuntimeInstance>();

  constructor() {
    this.restorePersistentInstances();
  }

  private registryPath(): string {
    return path.join(profileRoot(), "instances.json");
  }

  private restorePersistentInstances(): void {
    const root = profileRoot();
    let saved: unknown = [];
    try {
      saved = JSON.parse(fs.readFileSync(this.registryPath(), "utf8"));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") console.warn("[BrowserService] browser registry unreadable; recovering profile directories", error);
    }
    if (Array.isArray(saved)) {
      for (const row of saved) {
        if (!row || typeof row !== "object") continue;
        const candidate = row as Record<string, unknown>;
        const id = candidate.id;
        if (typeof id !== "string" || !BROWSER_ID_RE.test(id)) continue;
        let profileStats: fs.Stats;
        try { profileStats = fs.lstatSync(path.join(root, id)); } catch { continue; }
        if (!profileStats.isDirectory() || profileStats.isSymbolicLink()) continue;
        const createdAt = typeof candidate.createdAt === "string" && !Number.isNaN(Date.parse(candidate.createdAt))
          ? candidate.createdAt : new Date().toISOString();
        const info = persistedInfo(id, typeof candidate.name === "string" && candidate.name.trim() ? candidate.name : "浏览器", createdAt);
        this.instances.set(id, { info, session: null, frameCallback: null, refMap: {}, lastSnapshot: "" });
      }
    }
    // Older releases created profile directories without a registry. Recover them by stable directory ID.
    for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
      if (!entry.isDirectory() || !BROWSER_ID_RE.test(entry.name) || this.instances.has(entry.name)) continue;
      const info = persistedInfo(entry.name, "浏览器", fs.statSync(path.join(root, entry.name)).birthtime.toISOString());
      this.instances.set(info.id, { info, session: null, frameCallback: null, refMap: {}, lastSnapshot: "" });
    }
    this.persistRegistry();
  }

  private persistRegistry(): void {
    const rows = [...this.instances.values()].filter(({ info }) => info.mode === "persistent")
      .map(({ info }) => ({ id: info.id, name: info.name, createdAt: info.createdAt }));
    const target = this.registryPath();
    const temporary = `${target}.${process.pid}.tmp`;
    fs.writeFileSync(temporary, JSON.stringify(rows, null, 2), "utf8");
    fs.renameSync(temporary, target);
  }

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

  /**
   * 同步视图：`tabs` 用会话的同步提示刷新，保留"跟随用户新开标签"的原行为
   * （`list()` / `getInfo()` 是同步签名，取不到就退回记录值）。
   */
  private view(runtime: RuntimeInstance): BrowserInstanceInfo {
    const stale = runtime.info.state === "ready" && !runtime.session;
    if (stale) runtime.info.state = "closed";
    return { ...runtime.info, tabs: runtime.session?.tabsHint(runtime.info.tabs) ?? runtime.info.tabs };
  }

  async list(): Promise<BrowserInstanceInfo[]> {
    return [...this.instances.values()]
      .map((runtime) => this.view(runtime))
      .sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1));
  }

  getInfo(id: string): BrowserInstanceInfo | null {
    const runtime = this.instances.get(id);
    return runtime ? this.view(runtime) : null;
  }

  /**
   * 逃生艇：拿传输原生的上下文 / 页面句柄。
   *
   * 供需要 Playwright 特有能力（如 Cookie API：`context.addCookies` / `context.cookies`）的
   * 调用方使用（当前调用方是「同一个 persistent profile 跨重启保留登录态」的测试）。
   * CDP 传输下会返回 null；持久化登录态的可移植断言应在 Phase 4 改为传输无关的 Cookie API。
   */
  getContext(id: string): BrowserContext | null {
    return (this.instances.get(id)?.session?.nativeHandles().context as BrowserContext | null | undefined) ?? null;
  }

  getPage(id: string): Page | null {
    return (this.instances.get(id)?.session?.nativeHandles().page as Page | null | undefined) ?? null;
  }

  /** 创建实例（不启动；磁贴打开时才 launch）。persistent 模式建立持久化 profile 目录。 */
  async createInstance(input: { name?: string; mode?: BrowserMode; embedded?: boolean }): Promise<BrowserInstanceInfo> {
    const id = `brw_${randomUUID().slice(0, 12)}`;
    const mode: BrowserMode = input.mode === "incognito" ? "incognito" : "persistent";
    const now = new Date().toISOString();
    const name = (input.name ?? "").trim() || (mode === "persistent" ? "浏览器" : "无痕浏览器");
    const info: BrowserInstanceInfo = {
      id,
      name,
      mode,
      embedded: input.embedded === true,
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
    this.instances.set(id, { info, session: null, frameCallback: null, refMap: {}, lastSnapshot: "" });
    if (mode === "persistent") this.persistRegistry();
    this.emit({ type: "browser_created", browser: { ...info } });
    return { ...info };
  }

  async deleteInstance(id: string): Promise<boolean> {
    const runtime = this.instances.get(id);
    if (!runtime) {
      return false;
    }
    await this.closeInstance(id);
    // 先把实例从注册表拿掉，再尝试删 profile 目录。
    // 反过来写会让“目录删不掉”（浏览器未完全退出时的文件锁）打断整个方法，
    // 结果实例残留成幽灵、而无痕/持久 profile 还留在盘上（2026-10-01 实测）。
    this.instances.delete(id);
    if (runtime.info.mode === "persistent") this.persistRegistry();
    this.emit({ type: "browser_deleted", browser: { ...runtime.info } });
    if (runtime.info.mode === "persistent" && runtime.info.profileDir) {
      // WebView2 关闭子 webview 后，user-data-dir 里的 lockfile 不会立刻释放。
      // 实测直接 rm 会 EBUSY，而“删除实例”的语义里包含清掉登录数据，所以这里退避重试，
      // 重试仍失败才报错（登录数据没清干净属于必须告知的事）。
      const profileDir = runtime.info.profileDir;
      let lastError: unknown = null;
      for (let attempt = 0; attempt < 6; attempt += 1) {
        try {
          await fs.promises.rm(profileDir, { recursive: true, force: true });
          lastError = null;
          break;
        } catch (error) {
          lastError = error;
          await new Promise((resolve) => setTimeout(resolve, 250 * (attempt + 1)));
        }
      }
      if (lastError) {
        throw new Error(
          `浏览器实例已删除，但 profile 目录未清干净（登录数据可能残留）：${profileDir} — ${lastError instanceof Error ? lastError.message : String(lastError)}`,
        );
      }
    }
    return true;
  }

  async closeInstance(id: string): Promise<void> {
    const runtime = this.instances.get(id);
    if (!runtime) {
      return;
    }
    runtime.frameCallback = null;
    const session = runtime.session;
    runtime.session = null;
    if (session) {
      await session.close().catch(() => undefined);
    }
    runtime.info.state = "closed";
    runtime.info.tabs = 0;
    runtime.info.lastActiveAt = new Date().toISOString();
    this.emit({ type: "browser_state", browser: { ...runtime.info } });
  }

  private requireSession(id: string): BrowserSession | null {
    return this.instances.get(id)?.session ?? null;
  }

  /** 启动实例（打开磁贴时调用；幂等：已 ready 直接返回） */
  async launch(id: string): Promise<BrowserInstanceInfo> {
    const runtime = this.instances.get(id);
    if (!runtime) {
      throw new Error(`浏览器实例不存在: ${id}`);
    }
    if (runtime.session) {
      return { ...runtime.info };
    }
    runtime.info.state = "launching";
    try {
      const transport = selectTransport({ embedded: runtime.info.embedded === true });
      const { executablePath } = resolveBrowserExecutable();
      const options: BrowserLaunchOptions = {
        profileDir: runtime.info.profileDir,
        viewport: { ...DEFAULT_VIEWPORT },
        headless: resolveHeadless(transport.name),
        browserId: runtime.info.id,
      };
      const session = await transport.launch(options);
      runtime.session = session;
      runtime.info.state = "ready";
      runtime.info.transport = transport.name;
      runtime.info.executablePath = executablePath;
      runtime.info.lastActiveAt = new Date().toISOString();
      const meta = await session.meta().catch(() => null);
      runtime.info.tabs = meta?.tabs ?? 1;
      runtime.info.title = meta?.title ?? "";
      runtime.info.url = meta?.url ?? runtime.info.url;
      this.emit({ type: "browser_state", browser: { ...runtime.info } });
      return { ...runtime.info };
    } catch (error) {
      runtime.info.state = "error";
      runtime.info.error = error instanceof Error ? error.message : String(error);
      runtime.session = null;
      throw new Error(`浏览器启动失败: ${runtime.info.error}`);
    }
  }

  async navigate(id: string, url: string, waitUntil: "load" | "domcontentloaded" | "commit" = "domcontentloaded"): Promise<{ url: string; title: string } | null> {
    const runtime = this.instances.get(id);
    const session = runtime?.session;
    if (!runtime || !session) {
      return null;
    }
    const meta = await session.navigate(url, waitUntil, 30_000);
    runtime.info.url = meta.url;
    runtime.info.title = meta.title;
    runtime.info.lastActiveAt = new Date().toISOString();
    runtime.info.tabs = meta.tabs;
    return { url: meta.url, title: meta.title };
  }

  /**
   * 观察页面：生成 AX 风格快照树 + ref 映射。
   * 轻量实现（参考 agent-browser snapshot.js）：收集可交互/文本元素，
   * 每个元素生成唯一 CSS selector；ref = [i] 序号，click/fill 可用 ref 或 selector。
   *
   * 首次为空时会短暂重试：`navigate` 用 domcontentloaded 返回时，SPA 往往还没渲染出内容，
   * 立即 observe 会得到空快照，模型会误以为页面不可操作。这里补上重试，
   * 等价于 Playwright 路径的自动等待。
   */
  async snapshot(id: string, maxNodes = 120): Promise<SnapshotTree | null> {
    const session = this.requireSession(id);
    if (!session) {
      return null;
    }
    let items = await session.snapshot(maxNodes);
    for (let attempt = 0; attempt < 8 && items.length === 0; attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 300));
      items = await session.snapshot(maxNodes);
    }

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
    const session = this.requireSession(id);
    const resolved = this.resolveSelector(id, selector, ref);
    if (!session || !resolved) return false;
    await session.click(resolved, 10_000);
    return true;
  }

  /** 磁贴画面点击（坐标支持）：x,y 相对视口 */
  async clickAt(id: string, x: number, y: number): Promise<boolean> {
    const runtime = this.instances.get(id);
    const session = runtime?.session;
    if (!runtime || !session) return false;
    await session.clickAt(x, y);
    runtime.info.lastActiveAt = new Date().toISOString();
    return true;
  }

  async fill(id: string, selector: string, text: string, ref?: string): Promise<boolean> {
    const session = this.requireSession(id);
    const resolved = this.resolveSelector(id, selector, ref);
    if (!session || !resolved) return false;
    await session.fill(resolved, text, 10_000);
    return true;
  }

  async press(id: string, key: string): Promise<boolean> {
    const session = this.requireSession(id);
    if (!session) return false;
    await session.press(key);
    return true;
  }

  async domAction(id: string, action: "focus" | "fill" | "click" | "inspect", selector: string, text?: string): Promise<unknown> {
    const session = this.requireSession(id);
    if (!session) return null;
    return session.domAction(action, selector, text);
  }

  async waitFor(id: string, kind: "url" | "text" | "selector", value: string, timeoutMs = 10_000): Promise<boolean> {
    const session = this.requireSession(id);
    if (!session) return false;
    await session.waitFor(kind, value, timeoutMs);
    return true;
  }

  async executeJS(id: string, script: string): Promise<unknown> {
    const session = this.requireSession(id);
    if (!session) return null;
    // 表达式求值（只执行调用方明确提供的脚本）
    return session.evaluate(script);
  }

  async screenshot(id: string): Promise<string | null> {
    const session = this.requireSession(id);
    if (!session) return null;
    return session.screenshot();
  }

  /** 启动/停止 CDP screencast 帧流；frameCallback 收到 data URL（jpeg） */
  async screencast(id: string, enabled: boolean, callback?: (dataUrl: string) => void): Promise<boolean> {
    const runtime = this.instances.get(id);
    const session = runtime?.session;
    if (!runtime || !session) return false;
    if (!enabled) {
      runtime.frameCallback = null;
      await session.stopScreencast().catch(() => undefined);
      return true;
    }
    // 注意：必须先登记回调再起流。会话内部也存了一份回调，但帧到达时是通过
    // 这里登记的 runtime.frameCallback 转发的——漏登记会表现为“起了流但一帧都不来”。
    runtime.frameCallback = callback ?? null;
    const started = await session.startScreencast((dataUrl) => {
      runtime.frameCallback?.(dataUrl);
    });
    if (!started) runtime.frameCallback = null;
    return started;
  }

  /** 页面变化后刷新实例元信息（标题/URL/tabs） */
  async touch(id: string): Promise<BrowserInstanceInfo | null> {
    const runtime = this.instances.get(id);
    if (!runtime) return null;
    const session = runtime.session;
    if (!session) return { ...runtime.info };
    const meta = await session.meta().catch(() => null);
    if (meta) {
      runtime.info.url = meta.url || runtime.info.url;
      runtime.info.title = meta.title ?? runtime.info.title;
      runtime.info.tabs = meta.tabs;
    }
    runtime.info.lastActiveAt = new Date().toISOString();
    return { ...runtime.info };
  }

  /** 获取或创建共享的搜索专用浏览器（incognito 模式，避免污染用户主浏览器 profile） */
  private searchBrowserId: string | null = null;

  async getOrCreateSearchBrowser(): Promise<string> {
    if (this.searchBrowserId) {
      const info = this.getInfo(this.searchBrowserId);
      if (info && info.state === "ready") {
        return this.searchBrowserId;
      }
      // 如果已存在但状态异常，清理重建
      await this.closeInstance(this.searchBrowserId).catch(() => undefined);
    }
    const created = await this.createInstance({ name: "搜索专用", mode: "incognito" });
    this.searchBrowserId = created.id;
    await this.launch(created.id);
    return created.id;
  }

  async closeAll(): Promise<void> {
    for (const id of [...this.instances.keys()]) {
      await this.closeInstance(id);
    }
  }
}

/** 全局单例：浏览器与 Agent 解耦（Agent 工具经 browse_* 引用实例，不拥有实例） */
export const browserService = new BrowserService();

/** 供测试/诊断：当前会选中的传输后端名 */
export function currentTransportName(options: { embedded?: boolean } = {}): BrowserTransportName {
  return selectTransport({ embedded: options.embedded === true }).name;
}
