import { useEffect, useRef, useState } from "react";

import { awaitApiBase, browserAction } from "../lib/api";
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
  frame: string | null;
  busy: boolean;
  address: string;
  setAddress: (value: string) => void;
  streamError: string | null;
  navigate: (rawUrl?: string) => Promise<void>;
  refresh: () => void;
  clickFrame: (event: React.MouseEvent<HTMLImageElement>) => void;
}

export function useBrowserView(browser: BrowserInfo): BrowserViewController {
  const updateBrowser = useBrowserStore((state) => state.updateBrowser);
  const [address, setAddress] = useState(browser.url ?? "");
  const [frame, setFrame] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [streamError, setStreamError] = useState<string | null>(null);
  const controllerRef = useRef<AbortController | null>(null);
  const [browserState, setBrowserState] = useState<BrowserInfo>(browser);

  const currentInfo = (info: BrowserInfo): void => {
    setBrowserState(info);
    updateBrowser(info);
  };

  // 打开即启动 + 订阅帧流
  useEffect(() => {
    const bootAndStream = async (): Promise<void> => {
      const base = await awaitApiBase();
      try {
        if (browser.state !== "ready") {
          const launched = (await browserAction<{ browser: BrowserInfo }>(browser.id, "launch")).browser;
          if (launched) currentInfo(launched);
        }
      } catch (error) {
        setStreamError(error instanceof Error ? error.message : String(error));
      }
      const controller = new AbortController();
      controllerRef.current = controller;
      try {
        const res = await fetch(`${base}/api/browsers/${encodeURIComponent(browser.id)}/stream`, { signal: controller.signal });
        if (!res.ok || !res.body) {
          setStreamError(`流连接失败: ${res.status}`);
          return;
        }
        const reader = res.body.getReader();
        const decoder = new TextDecoder();
        let buffer = "";
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          buffer += decoder.decode(value, { stream: true }).replace(/^\s+/g, "");
          let idx: number;
          while ((idx = buffer.indexOf("\n\n")) >= 0) {
            const block = buffer.slice(0, idx);
            buffer = buffer.slice(idx + 2);
            for (const line of block.split("\n")) {
              if (!line.startsWith("data: ")) continue;
              try {
                const frameData = JSON.parse(line.slice(6)) as Record<string, unknown>;
                if (frameData.type === "frame" && typeof frameData.data_url === "string") {
                  setFrame(frameData.data_url);
                } else if (frameData.type === "info" && frameData.browser) {
                  currentInfo(frameData.browser as BrowserInfo);
                } else if (frameData.type === "error") {
                  setStreamError(String(frameData.error ?? "stream error"));
                }
              } catch {
                // 忽略坏帧
              }
            }
          }
        }
      } catch (error) {
        if (!(error instanceof DOMException && error.name === "AbortError")) {
          setStreamError(error instanceof Error ? error.message : String(error));
        }
      }
    };
    void bootAndStream();
    return () => {
      controllerRef.current?.abort();
      controllerRef.current = null;
    };
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

  const clickFrame = (event: React.MouseEvent<HTMLImageElement>): void => {
    const img = event.currentTarget;
    const rect = img.getBoundingClientRect();
    const x = ((event.clientX - rect.left) / rect.width) * 1280;
    const y = ((event.clientY - rect.top) / rect.height) * 800;
    void browserAction(browser.id, "click_at", { x: Math.round(x), y: Math.round(y) }).catch((error) => {
      setStreamError(error instanceof Error ? error.message : String(error));
    });
  };

  return { browserState, frame, busy, address, setAddress, streamError, navigate, refresh, clickFrame };
}

export default function BrowserView({ browser }: { browser: BrowserInfo }) {
  const { browserState, frame, busy, address, setAddress, streamError, navigate, refresh, clickFrame } = useBrowserView(browser);

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

      <div className="browser-window__viewport">
        {frame ? (
          <img
            className="browser-window__frame"
            src={frame}
            alt="浏览器实时画面（可点击）"
            onClick={clickFrame}
            title="点击画面 = 在真实浏览器中点击该处"
          />
        ) : (
          <div className="browser-window__placeholder">
            {browserState.state === "error" ? (
              <p className="browser-window__error-text">{streamError ?? "浏览器启动失败"}</p>
            ) : (
              <p>{streamError ? `流错误：${streamError}` : "画面加载中…（首帧到达后显示）"}</p>
            )}
          </div>
        )}
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
