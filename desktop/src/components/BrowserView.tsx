import { useEffect, useRef, useState } from "react";

import { browserAction, listBrowsers } from "../lib/api";
import { setWebviewBounds, setWebviewVisible, toPhysicalRect, webviewLabelFor } from "../lib/webviewBridge";
import { useBrowserStore } from "../state/browserStore";
import type { BrowserInfo } from "../types";

/**
 * 受控浏览器的可复用视图：工具栏（刷新 + 地址栏）+ CDP screencast 画面 + 状态栏。
 *
 * 为什么抽出来：同一份浏览器视图有两个宿主——独立的浏览器窗口（BrowserWindow），
 * 以及 Agent 窗口里「当前 Agent 引用了这个浏览器」的标签页内容。外壳（标题栏/关闭按钮）不同，
 * 工具栏、帧流、点击注入完全一样，所以这里只做「壳内的一切」。
 */

export interface BrowserViewController {
  browserState: BrowserInfo;
  busy: boolean;
  address: string;
  setAddress: (value: string) => void;
  streamError: string | null;
  navigate: (rawUrl?: string) => Promise<void>;
  refresh: () => void;
}

export function useBrowserView(browser: BrowserInfo): BrowserViewController {
  const updateBrowser = useBrowserStore((state) => state.updateBrowser);
  const [address, setAddress] = useState(browser.url ?? "");
  const [busy, setBusy] = useState(false);
  const [streamError, setStreamError] = useState<string | null>(null);
  const [browserState, setBrowserState] = useState<BrowserInfo>(browser);

  const currentInfo = (info: BrowserInfo): void => {
    setBrowserState(info);
    updateBrowser(info);
  };

  /**
   * 打开即启动。
   *
   * 只负责"把浏览器跑起来"：画面要么由原生子 webview 直接绘制（embedded），
   * 要么根本渲染不了（浏览器 dev 入口，没有壳）。**不再订阅帧流**——
   * 帧投影是已被否决的方案（画面不可操作、画质与坐标点击不可接受），
   * 留着它当回退只会让两种渲染路径长期共存。
   */
  useEffect(() => {
    const boot = async (): Promise<void> => {
      try {
        if (browser.state !== "ready") {
          const launched = (await browserAction<{ browser: BrowserInfo }>(browser.id, "launch")).browser;
          if (launched) currentInfo(launched);
        }
      } catch (error) {
        setStreamError(error instanceof Error ? error.message : String(error));
        // 启动失败时后端已广播 browser_state(error)，主动拉一次把状态同步到磁贴
        try {
          const list = await listBrowsers();
          const fresh = list.find((item) => item.id === browser.id);
          if (fresh) currentInfo(fresh);
        } catch {
          // 忽略：错误已经展示给用户了
        }
      }
    };
    void boot();
    // 意图：仅挂载时启动一次；browser.state 由 currentInfo 持续更新
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [browser.id]);

  const navigate = async (rawUrl?: string): Promise<void> => {
    const url = (rawUrl ?? address).trim();
    if (!url) return;
    setBusy(true);
    setStreamError(null);
    try {
      const result = await browserAction<{ url: string; title: string }>(browser.id, "navigate", { url });
      setAddress(result.url);
      currentInfo({ ...browserState, url: result.url, title: result.title });
    } catch (error) {
      setStreamError(error instanceof Error ? error.message : String(error));
    } finally {
      setBusy(false);
    }
  };

  const refresh = (): void => {
    if (browserState.url) void navigate(browserState.url);
  };

  return { browserState, busy, address, setAddress, streamError, navigate, refresh };
}

/**
 * 把原生子 webview 钉在占位元素的矩形上。
 *
 * 三个必须成立的点：
 * 1. 坐标是**物理像素**（乘 devicePixelRatio）；
 * 2. 原生视图不参与 DOM 层级，永远盖在 React 上层，所以工具条必须在矩形之外（本组件的
 *    工具栏是独立的一行，天然满足）；
 * 3. 宿主隐藏/滑出视口时必须显式 `set_visible(false)`，否则“窗口关了页面还在”。
 *
 * 用 rAF 跟框而不是只靠 ResizeObserver：磁贴是拖拽定位的，位置变化不触发 size 观察。
 */
function useNativeWebview(browserId: string, targetRef: React.RefObject<HTMLDivElement | null>): void {
  useEffect(() => {
    const label = webviewLabelFor(browserId);
    let raf = 0;
    let lastBounds = "";
    let shown = false;

    const tick = (): void => {
      const el = targetRef.current;
      if (el) {
        const rect = el.getBoundingClientRect();
        const dpr = window.devicePixelRatio || 1;
        const physical = toPhysicalRect(rect);
        const inViewport = rect.width > 0 && rect.height > 0 && rect.bottom > 0 && rect.top < window.innerHeight && rect.right > 0 && rect.left < window.innerWidth;
        const key = `${physical.x},${physical.y},${physical.w},${physical.h}`;
        if (key !== lastBounds) {
          lastBounds = key;
          void setWebviewBounds(label, physical).catch(() => undefined);
        }
        if (inViewport !== shown) {
          shown = inViewport;
          void setWebviewVisible(label, inViewport).catch(() => undefined);
        }
        void dpr;
      }
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => {
      cancelAnimationFrame(raf);
      // 宿主卸载（关窗口 / 切走标签）时把原生视图收起来——React 管不到它
      void setWebviewVisible(label, false).catch(() => undefined);
    };
  }, [browserId, targetRef]);
}

export default function BrowserView({ browser }: { browser: BrowserInfo }) {
  const { browserState, busy, address, setAddress, streamError, navigate, refresh } = useBrowserView(browser);
  const viewportRef = useRef<HTMLDivElement>(null);
  useNativeWebview(browser.id, viewportRef);

  return (
    <div className="browser-view">
      <div className="browser-window__toolbar">
        <button type="button" className="btn btn--ghost btn--sm" onClick={refresh} disabled={busy || browserState.state !== "ready"} aria-label="刷新">
          ⟳
        </button>
        <form
          className="browser-window__address"
          onSubmit={(event) => {
            event.preventDefault();
            void navigate();
          }}
        >
          <input
            className="browser-window__address-input"
            value={address}
            onChange={(event) => setAddress(event.target.value)}
            placeholder="输入网址，Enter 打开（自动补 https://）"
            aria-label="地址栏"
          />
        </form>
      </div>

      <div className="browser-window__viewport" ref={viewportRef}>
        {/* 页面一律由原生子 webview 直接绘制：这块矩形被它盖住，DOM 里不画任何东西。
            桥不可用时后端会把 state 置为 error 并给出原因，第一行就是它。 */}
        <div className="browser-window__placeholder browser-window__placeholder--embedded">
          {browserState.state === "error" ? (
            <p className="browser-window__error-text">{browserState.error ?? streamError ?? "浏览器启动失败"}</p>
          ) : (
            <p>{streamError ? `内嵌视图错误：${streamError}` : "页面由原生 webview 直接绘制"}</p>
          )}
        </div>
        {busy ? <div className="browser-window__busy">导航中…</div> : null}
      </div>

      <footer className="browser-window__status">
        <span>{browserState.url ?? "未导航"}</span>
        <span className="browser-window__status-right">
          {browserState.title ?? ""} · {browserState.state}
        </span>
      </footer>
    </div>
  );
}
