/**
 * Playwright 传输后端。
 *
 * 这是**原实现**的搬运：逻辑与改动前逐行等价，只把 `Page` / `BrowserContext` 收进本模块，
 * 不再泄漏到 `browser-service.ts`。
 *
 * 注意它的运行时限：Playwright 的传输层在 **bun** 下不工作（同一 `launchPersistentContext`
 * 调用 node 648 ms 完成、bun 20 s 无返回），而发行版 sidecar 是 `bun --compile` 产物。
 * 所以 `isAvailable()` 在 bun 下返回 false，由 `browser-service.ts` 改选 CDP 传输。
 */
import { chromium, type BrowserContext, type Page } from "playwright-core";

import {
  PAGE_META_SCRIPT,
  inspectElementFn,
  snapshotScript,
} from "./browser-scripts.js";
import {
  resolveBrowserExecutable,
  type BrowserLaunchOptions,
  type BrowserPageMeta,
  type BrowserSession,
  type BrowserTransport,
  type BrowserWaitKind,
  type BrowserWaitUntil,
  type BrowserDomAction,
  type SnapshotItem,
} from "./browser-transport.js";

/** 把用户/模型给的目标补成完整 URL（两个传输共用同一策略） */
export function normalizeBrowserUrl(url: string): string {
  return /^https?:\/\//i.test(url) ? url : `https://${url}`;
}

/** Playwright 分支的 URL 等待需要正则源码（转义元字符，按字面量匹配） */
function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

class PlaywrightSession implements BrowserSession {
  private context: BrowserContext;
  private page: Page;
  private frameCallback: ((dataUrl: string) => void) | null = null;

  constructor(context: BrowserContext, page: Page) {
    this.context = context;
    this.page = page;
  }

  /**
   * 跟随用户切换的 active tab：取前台页面（`context.pages()` 最后一个通常是最近激活的）。
   * 保留原行为——磁贴看到的必须是用户当前在看的那个页面。
   */
  private currentPage(): Page {
    const pages = this.context.pages();
    if (!pages.includes(this.page) && pages.length > 0) {
      this.page = pages[pages.length - 1];
    }
    return this.page;
  }

  async navigate(url: string, waitUntil: BrowserWaitUntil, timeoutMs: number): Promise<BrowserPageMeta> {
    const page = this.currentPage();
    await page.goto(normalizeBrowserUrl(url), { waitUntil, timeout: timeoutMs });
    return {
      url: page.url(),
      title: (await page.title().catch(() => "")) ?? "",
      tabs: this.context.pages().length,
    };
  }

  async snapshot(maxNodes: number): Promise<SnapshotItem[]> {
    return (await this.currentPage().evaluate(snapshotScript(maxNodes))) as SnapshotItem[];
  }

  async click(selector: string, timeoutMs: number): Promise<void> {
    await this.currentPage().click(selector, { timeout: timeoutMs });
  }

  async clickAt(x: number, y: number): Promise<void> {
    // 坐标注入用真实鼠标事件；元素中心由调用方（或 elementCenterScript）给出
    await this.currentPage().mouse.click(x, y);
  }

  async fill(selector: string, text: string, timeoutMs: number): Promise<void> {
    await this.currentPage().fill(selector, text, { timeout: timeoutMs });
  }

  async press(key: string): Promise<void> {
    const page = this.currentPage();
    await page.keyboard.press(key).catch(() => page.keyboard.insertText(key));
  }

  async domAction(action: BrowserDomAction, selector: string, text?: string): Promise<unknown> {
    const page = this.currentPage();
    switch (action) {
      case "fill":
        await page.locator(selector).fill(text ?? "");
        return true;
      case "click":
        await page.locator(selector).click({ timeout: 10_000 });
        return true;
      case "focus":
        await page.locator(selector).focus();
        return true;
      case "inspect":
        return page.locator(selector).evaluate(inspectElementFn);
    }
  }

  async waitFor(kind: BrowserWaitKind, value: string, timeoutMs: number): Promise<void> {
    const page = this.currentPage();
    if (kind === "url") {
      await page.waitForURL(new RegExp(escapeRegExp(value)), { timeout: timeoutMs });
      return;
    }
    if (kind === "text") {
      await page.waitForSelector(`text=${value}`, { timeout: timeoutMs });
      return;
    }
    await page.waitForSelector(value, { timeout: timeoutMs });
  }

  async evaluate(script: string): Promise<unknown> {
    return this.currentPage().evaluate(script);
  }

  async screenshot(): Promise<string> {
    const buffer = await this.currentPage().screenshot({ type: "jpeg", quality: 70 });
    return `data:image/jpeg;base64,${buffer.toString("base64")}`;
  }

  async startScreencast(onFrame: (dataUrl: string) => void): Promise<boolean> {
    this.frameCallback = onFrame;
    const session = await this.context.newCDPSession(this.currentPage()).catch(() => null);
    if (!session) return false;
    await session.send("Page.enable").catch(() => undefined);
    await session
      .send("Page.startScreencast", { format: "jpeg", quality: 60, maxWidth: 1280, maxHeight: 800, everyNthFrame: 1 })
      .catch(() => undefined);
    session.on("Page.screencastFrame", ({ data, sessionId }: { data: string; sessionId: number }) => {
      void session.send("Page.screencastFrameAck", { sessionId }).catch(() => undefined);
      this.frameCallback?.(`data:image/jpeg;base64,${data}`);
    });
    return true;
  }

  async stopScreencast(): Promise<void> {
    this.frameCallback = null;
    const session = await this.context.newCDPSession(this.currentPage()).catch(() => null);
    await session?.send("Page.stopScreencast").catch(() => undefined);
  }

  async meta(): Promise<BrowserPageMeta> {
    const page = this.currentPage();
    const value = (await page.evaluate(PAGE_META_SCRIPT).catch(() => null)) as { url?: string; title?: string } | null;
    return {
      url: value?.url ?? page.url() ?? "",
      title: value?.title ?? (await page.title().catch(() => "")) ?? "",
      tabs: this.context.pages().length,
    };
  }

  tabsHint(fallback: number): number {
    try {
      return this.context.pages().length;
    } catch {
      return fallback;
    }
  }

  nativeHandles(): { context: unknown; page: unknown } {
    return { context: this.context, page: this.currentPage() };
  }

  async close(): Promise<void> {
    this.frameCallback = null;
    await this.context.close().catch(() => undefined);
  }
}

export const playwrightTransport: BrowserTransport = {
  name: "playwright",

  isAvailable(): boolean {
    // bun 下 Playwright 的传输层挂死（实测：启动 20 s 无返回）；node / tsx 正常
    return !process.versions.bun;
  },

  async launch(options: BrowserLaunchOptions): Promise<BrowserSession> {
    const { executablePath } = resolveBrowserExecutable();
    if (!executablePath) {
      // 不静默回落：executablePath 为 undefined 时 Playwright 会改用自带的
      // headless shell（指纹与系统 Edge 完全不同，实测 332ms vs 648ms），
      // 排查“用的哪个浏览器”时会被彻底带偏。
      throw new Error("没有找到可用的 Edge / Chrome 可执行文件；请在 EDGE/Chrome 安装后重试，或用 MOMOKA_BROWSER_TRANSPORT=cdp");
    }
    const context = await chromium.launchPersistentContext(options.profileDir ?? "", {
      executablePath,
      headless: options.headless ?? true,
      viewport: options.viewport,
      deviceScaleFactor: 1,
    });
    const pages = context.pages();
    const page = pages[0] ?? (await context.newPage());
    return new PlaywrightSession(context, page);
  },
};
