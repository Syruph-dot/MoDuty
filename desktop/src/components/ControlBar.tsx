import { getCurrentWindow } from "@tauri-apps/api/window";


/**
 * 浮动控制条：无边框全屏窗口的窗口控制（最小化 / 关闭，仅 Tauri 内可见）。
 *
 * 磁贴墙治理入口（搜索筛选 / 归档库 / 视图切换）已移入右缘唤出的 charms 栏
 * （见 RightCharm.tsx）——那里是「窗口外沿工具」的统一去处。
 */
export default function ControlBar() {
  // v2 注入 __TAURI_INTERNALS__；v1 是 __TAURI__
  const inTauri = typeof window !== "undefined"
    && ("__TAURI_INTERNALS__" in (window as unknown as Record<string, unknown>) || "__TAURI__" in window);

  return (
    <>
      {/* 窗口控制（无边框窗口）：保留右上角（设置页同样可见，便于关闭窗口） */}
      {inTauri ? (
        <div className="control-bar control-bar--window" role="toolbar" aria-label="Window controls">
          <button
            type="button"
            className="control-bar__btn"
            aria-label="Minimize window"
            onClick={() => {
              void getCurrentWindow().minimize();
            }}
          >
            −
          </button>
          <button
            type="button"
            className="control-bar__btn control-bar__btn--close"
            aria-label="Close MoDuty"
            onClick={() => {
              void getCurrentWindow().close();
            }}
          >
            ×
          </button>
        </div>
      ) : null}
    </>
  );
}