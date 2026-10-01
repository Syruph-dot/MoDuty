/**
 * 浏览器传输层接口。
 *
 * 背景：`browser-service.ts` 原先直接把 Playwright 的 `BrowserContext` / `Page` 铺在
 * 业务逻辑里。现在需要一个可替换的传输后端，原因是打包运行时换成了 bun：
 * Playwright 的传输层在 bun 下不工作（同一 `launchPersistentContext` 调用
 * node 648 ms 完成、bun 20 s 无返回），而发行版 sidecar 正是 `bun --compile` 产物。
 *
 * 边界：本模块只描述**语义操作**，不泄漏任何 Playwright 类型。
 * 实例注册表、profile 目录、ref 映射、事件与错误转译仍留在 `browser-service.ts`。
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export type BrowserWaitUntil = "load" | "domcontentloaded" | "commit";
export type BrowserDomAction = "focus" | "fill" | "click" | "inspect";
export type BrowserWaitKind = "url" | "text" | "selector";

/** 快照里的一条可交互/文本元素 */
export interface SnapshotItem {
  tag: string;
  role: string;
  name: string;
  sel: string;
  visible: boolean;
  value: string;
}

export interface BrowserPageMeta {
  url: string;
  title: string;
  /** 标签页数量（同步提示用，见 BrowserSession.tabsHint） */
  tabs: number;
}

export interface BrowserLaunchOptions {
  /** null = 无痕：传输自建临时目录；否则为持久 profile 目录 */
  profileDir: string | null;
  viewport: { width: number; height: number };
  /**
   * 是否无头。默认 false——有头能拿到不含 `HeadlessChrome` 的 UA；
   * 而 `navigator.webdriver` 只有在不走 Playwright 启动参数时才为 false（见 cdp 传输）。
   */
  headless?: boolean;
}

/** 一个已启动的浏览器会话（= 一个浏览器磁贴实例） */
export interface BrowserSession {
  navigate(url: string, waitUntil: BrowserWaitUntil, timeoutMs: number): Promise<BrowserPageMeta>;
  snapshot(maxNodes: number): Promise<SnapshotItem[]>;
  click(selector: string, timeoutMs: number): Promise<void>;
  clickAt(x: number, y: number): Promise<void>;
  fill(selector: string, text: string, timeoutMs: number): Promise<void>;
  press(key: string): Promise<void>;
  domAction(action: BrowserDomAction, selector: string, text?: string): Promise<unknown>;
  waitFor(kind: BrowserWaitKind, value: string, timeoutMs: number): Promise<void>;
  evaluate(script: string): Promise<unknown>;
  /** 返回 data URL（jpeg） */
  screenshot(): Promise<string>;
  startScreencast(onFrame: (dataUrl: string) => void): Promise<boolean>;
  stopScreencast(): Promise<void>;
  /** 主动刷新 URL / 标题 / 标签数 */
  meta(): Promise<BrowserPageMeta>;
  /**
   * 同步的标签数提示（读不到时返回 fallback）。
   * `list()` / `getInfo()` 是同步签名，需要它来保留"跟随用户新开标签"的原行为。
   */
  tabsHint(fallback: number): number;
  /**
   * 逃生艇：传输原生的上下文/页面句柄。
   *
   * 只给需要传输特有能力（如 Playwright 的 Cookie API）的调用方用；CDP 传输返回 null。
   * 消费方必须自己判类型，不要把它当通用接口依赖。
   */
  nativeHandles(): { context: unknown; page: unknown };
  close(): Promise<void>;
}

export interface BrowserTransport {
  readonly name: "playwright" | "cdp";
  /** 本传输在当前运行时是否可用（bun 下 Playwright 不可用） */
  isAvailable(): boolean;
  launch(options: BrowserLaunchOptions): Promise<BrowserSession>;
}

/** 系统 Edge / Chrome 候选路径，按优先级（Edge x86 → Edge x64 → Chrome x64 → Chrome x86） */
export const BROWSER_CANDIDATES = [
  "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe",
  "C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe",
  "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
  "C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe",
];

/**
 * 解析浏览器可执行文件。
 *
 * 注意一个已实测的坑：解析不到时**原来的实现是静默回落到传输自带的浏览器**，
 * 指纹与系统 Edge 完全不同（同一脚本 332 ms vs 648 ms），排查时极易被误导。
 * 所以这里把"没找到"显式暴露出来，并记录实际使用的路径供实例信息展示。
 */
export function resolveBrowserExecutable(): { executablePath: string | undefined; candidates: string[] } {
  return { executablePath: BROWSER_CANDIDATES.find((candidate) => fs.existsSync(candidate)), candidates: BROWSER_CANDIDATES };
}

/** 无痕会话用的临时 profile 目录 */
export function createEphemeralProfileDir(prefix = "momoka-incognito-"): string {
  const root = process.env.MOMOKA_BROWSER_TEMP_ROOT?.trim() || os.tmpdir();
  return fs.mkdtempSync(path.join(root, prefix));
}
