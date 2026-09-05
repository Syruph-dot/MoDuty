import { appWindow } from "@tauri-apps/api/window";

import { useAgentsStore } from "../state/agentsStore";
import { useDialogStore } from "../state/dialogStore";

/**
 * 浮动控制条（无边框全屏窗口的窗口控制 + 磁贴墙治理入口）。
 * - 治理按钮（方案 A/B/D）：搜索筛选 / 归档库 / 视图切换（free ↔ grouped）——
 *   浏览器 dev 模式同样显示，便于调试；窗口控制仅在 Tauri 内可见
 * - 治理按钮为直角矩形（用户偏好：禁用圆角矩形）
 */
export default function ControlBar() {
  const inTauri = typeof window !== "undefined" && "__TAURI__" in window;
  const settingsOpen = useDialogStore((state) => state.settingsOpen);
  const filterBarOpen = useAgentsStore((state) => state.filterBarOpen);
  const toggleFilterBar = useAgentsStore((state) => state.toggleFilterBar);
  const setArchiveOpen = useAgentsStore((state) => state.setArchiveOpen);
  const viewMode = useAgentsStore((state) => state.viewMode);
  const toggleViewMode = useAgentsStore((state) => state.toggleViewMode);

  return (
    <>
      {/* 治理栏入口（方案 A/B/D）：搜索筛选 / 归档库 / 视图切换 —— 仅开始界面显示（设置页隐藏） */}
      {!settingsOpen ? (
        <div className="control-bar control-bar--governance" role="toolbar" aria-label="磁贴墙治理入口">
        <button
          type="button"
          className={`control-bar__btn control-bar__btn--mgmt${filterBarOpen ? " control-bar__btn--active" : ""}`}
          aria-label="搜索与筛选（切换治理栏）"
          aria-pressed={filterBarOpen}
          title="搜索 / 筛选 / 排序"
          onClick={toggleFilterBar}
        >
          🔍
        </button>
        <button
          type="button"
          className="control-bar__btn control-bar__btn--mgmt"
          aria-label="打开归档库"
          title="归档库"
          onClick={() => setArchiveOpen(true)}
        >
          🗄
        </button>
        <button
          type="button"
          className="control-bar__btn control-bar__btn--mgmt"
          aria-label={viewMode === "grouped" ? "切换到桌面视图（自由磁贴）" : "切换到分组视图（按工作区）"}
          title={viewMode === "grouped" ? "桌面视图" : "分组视图"}
          aria-pressed={viewMode === "grouped"}
          onClick={toggleViewMode}
        >
          {viewMode === "grouped" ? "▦" : "▤"}
        </button>
      </div>
      ) : null}

      {/* 窗口控制（无边框窗口）：保留右上角（设置页同样可见，便于关闭窗口） */}
      {inTauri ? (
        <div className="control-bar control-bar--window" role="toolbar" aria-label="Window controls">
          <button
            type="button"
            className="control-bar__btn"
            aria-label="Minimize window"
            onClick={() => {
              void appWindow.minimize();
            }}
          >
            −
          </button>
          <button
            type="button"
            className="control-bar__btn control-bar__btn--close"
            aria-label="Close MoDuty"
            onClick={() => {
              void appWindow.close();
            }}
          >
            ×
          </button>
        </div>
      ) : null}
    </>
  );
}