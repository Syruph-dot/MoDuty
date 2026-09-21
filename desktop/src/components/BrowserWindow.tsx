/**
 * 受控浏览器窗口：标题栏 +（可复用的）浏览器视图。
 * 视图本体（工具栏/帧流/点击注入/状态栏）在 BrowserView 里，Agent 窗口的标签页内容也用同一份。
 * 浏览器是独立实体：打开/关闭只影响浏览器自身，与 Agent 无关。
 */
import type { BrowserInfo } from "../types";
import BrowserView from "./BrowserView";
import { IconClose } from "./ui/icons";

export default function BrowserWindow({
  browser,
  onClose,
}: {
  browser: BrowserInfo;
  onClose: () => void;
}) {
  return (
    <div className="browser-window" role="dialog" aria-label={`浏览器 ${browser.name} 窗口`}>
      <header className="browser-window__header" title="拖动标题栏可移动">
        <div className="browser-window__identity">
          <span
            className={`state-dot state-dot--${browser.state === "ready" ? "running" : browser.state === "error" ? "error" : "idle"}`}
            aria-hidden="true"
          />
          <h2 className="browser-window__title">{browser.name}</h2>
          <span className={`browser-window__mode browser-window__mode--${browser.mode}`}>
            {browser.mode === "persistent" ? "正常模式（登录持久化）" : "无痕模式"}
          </span>
        </div>
        <button type="button" className="browser-window__close" aria-label="关闭浏览器窗口" onClick={onClose}>
          <IconClose />
        </button>
      </header>

      <BrowserView browser={browser} />
    </div>
  );
}
