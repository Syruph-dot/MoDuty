/**
 * 浏览器传输层接口。
 *
 * 背景：`browser-service.ts` 原先直接把 Playwright 的 `BrowserContext` / `Page` 铺在
 * 业务逻辑里。为此抽出可替换的传输后端；2026-10-01 产品形态收敛为“页面一律磁贴内嵌”
 * 之后，只剩 WebView2 桥一条实现（Playwright / CDP 两条外部浏览器传输已删）。
 *
 * 边界：本模块只描述**语义操作**，不泄漏任何具体传输的类型。
 * 实例注册表、profile 目录、ref 映射、事件与错误转译仍留在 `browser-service.ts`。
 */
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
   * 会话 id（如 `brw_xxx`）。bridge 传输用它推出子 webview 的 label：
   * `tile-<browserId>-<tabId>`。
   */
  browserId?: string;
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
  close(): Promise<void>;
}

export interface BrowserTransport {
  readonly name: "bridge";
  /** 本传输在当前运行时是否可用（WebView2 桥只在 Tauri 壳启动时才有） */
  isAvailable(): boolean;
  launch(options: BrowserLaunchOptions): Promise<BrowserSession>;
}
