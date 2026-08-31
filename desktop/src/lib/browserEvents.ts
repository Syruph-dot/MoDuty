/**
 * 订阅 /api/browsers/events（浏览器生命周期事件）。
 * 浏览器与 Agent 解耦：本频道只推 browser_created / browser_deleted / browser_state。
 * EventSource 原生自动重连；不可用时静默（浏览器磁贴缺失时桌面自动补齐由 hydrate 兜底）。
 */
import type { BrowserInfo } from "../types";

export interface BrowserServiceEvent {
  type: "browser_created" | "browser_deleted" | "browser_state";
  browser: BrowserInfo;
}

export interface BrowserEventStreamControl {
  stop(): void;
}

export function startBrowserEventStream(
  base: string,
  onEvent: (event: BrowserServiceEvent) => void,
): BrowserEventStreamControl {
  if (typeof EventSource === "undefined") {
    return { stop: () => undefined };
  }
  const source = new EventSource(`${base}/api/browsers/events`);
  source.onmessage = (event) => {
    try {
      onEvent(JSON.parse(String(event.data)) as BrowserServiceEvent);
    } catch {
      // 忽略坏帧
    }
  };
  // onerror 交给浏览器自动重连，不做额外处理
  return {
    stop: () => source.close(),
  };
}