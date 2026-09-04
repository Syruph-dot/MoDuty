/**
 * 受控浏览器磁贴：独立实体（与 Agent 解耦）。
 * 显示名称/模式/当前地址/标题/状态；单击或双击打开浏览器窗口。
 */
import { useState, type CSSProperties } from "react";

import type { BrowserInfo } from "../types";

const MODE_BADGE: Record<BrowserInfo["mode"], string> = {
  persistent: "正常",
  incognito: "无痕",
};

const STATE_DOT: Record<BrowserInfo["state"], string> = {
  closed: "state-dot--idle",
  launching: "state-dot--waiting",
  ready: "state-dot--running",
  error: "state-dot--error",
};

export default function BrowserTile({
  browser,
  style,
}: {
  browser: BrowserInfo;
  style?: CSSProperties;
}) {
  const [hovering, setHovering] = useState(false);

  return (
    <button
      type="button"
      className={`browser-tile browser-tile--${browser.state}${hovering ? " browser-tile--hover" : ""}`}
      style={style}
      aria-label={`浏览器 ${browser.name}，状态 ${browser.state}，单击打开`}
      onMouseEnter={() => setHovering(true)}
      onMouseLeave={() => setHovering(false)}
    >
      <span className="browser-tile__accent" aria-hidden="true" />

      <div className="browser-tile__head">
        <span className="browser-tile__mode">{MODE_BADGE[browser.mode]}</span>
        <span className={`state-dot ${STATE_DOT[browser.state]}`} aria-hidden="true" />
      </div>

      <div className="browser-tile__name">{browser.name}</div>

      <div className="browser-tile__url" title={browser.url ?? ""}>
        {browser.url ?? "尚未导航"}
      </div>
      <div className="browser-tile__title">{browser.title ?? (browser.state === "ready" ? "加载中…" : "单击打开浏览器")}</div>

      <div className="browser-tile__footer">
        <span>{browser.state === "ready" ? `${browser.tabs} 个标签页` : browser.state}</span>
        <span className="browser-tile__open">{hovering ? "单击打开" : ""}</span>
      </div>
    </button>
  );
}