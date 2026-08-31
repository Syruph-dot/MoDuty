/**
 * 受控浏览器窗口：地址栏 + 控制 + CDP screencast 实时画面（可点击）。
 * 画面数据来自 /api/browsers/:id/stream（SSE 帧流）；点击坐标 → click_at 注入真实浏览器。
 * 浏览器是独立实体：打开/关闭只影响浏览器自身，与 Agent 无关。
 */
import { useEffect, useRef, useState } from "react";

import { awaitApiBase, browserAction } from "../lib/api";
import { useBrowserStore } from "../state/browserStore";
import type { BrowserInfo } from "../types";

export default function BrowserWindow({
  browser,
  onClose,
}: {
  browser: BrowserInfo;
  onClose: () => void;
}) {
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

  return (
    <div className="browser-window" role="dialog" aria-label={`浏览器 ${browser.name} 窗口`}>
      <header className="browser-window__header" title="拖动标题栏可移动">
        <div className="browser-window__identity">
          <span className={`state-dot state-dot--${browserState.state === "ready" ? "running" : browserState.state === "error" ? "error" : "idle"}`} aria-hidden="true" />
          <h2 className="browser-window__title">{browserState.name}</h2>
          <span className={`browser-window__mode browser-window__mode--${browserState.mode}`}>
            {browserState.mode === "persistent" ? "🔒 正常模式（登录持久化）" : "🕶 无痕模式"}
          </span>
        </div>
        <button type="button" className="browser-window__close" aria-label="关闭浏览器窗口" onClick={onClose}>
          ×
        </button>
      </header>

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