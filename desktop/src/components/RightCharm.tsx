import { useState } from "react";
import { useAgentsStore } from "../state/agentsStore";
import { useBrowserStore } from "../state/browserStore";
import { useWindowManagerStore } from "../state/windowManagerStore";

/**
 * 右栏（45px，Windows 8 charms 风格，鼠标到右边缘唤出/移开收回）：
 * - 仅提供「打开/关闭模态」切换——视觉层面切换当前视图，不导航、不销毁数据
 * - off = 自由网格磁贴墙；on = 打开态分屏（左坞 + 右舞台 + 左栏列表）
 * - 尚无任何打开窗口时不允许进入空 on 模态
 */
export default function RightCharm() {
  const mode = useWindowManagerStore((state) => state.mode);
  const toggleMode = useWindowManagerStore((state) => state.toggleMode);
  const openAgentIds = useAgentsStore((state) => state.openAgentIds);
  const openBrowserIds = useBrowserStore((state) => state.openBrowserIds);
  const [open, setOpen] = useState(false);
  const [hoverBtn, setHoverBtn] = useState(false);
  const opening = mode === "on";
  const hasOpen = openAgentIds.length + openBrowserIds.length > 0;

  const blockedByEmpty = !opening && !hasOpen;
  const label = blockedByEmpty
    ? "尚无打开的窗口（双击磁贴或从左栏打开）"
    : opening
      ? "关闭模态"
      : "打开模态";

  const onToggle = () => {
    if (blockedByEmpty) return;
    toggleMode();
  };

  return (
    <>
      {/* 右缘热区：hover 滑出 charm 条 */}
      <div
        className="wm-right-hotzone"
        onMouseEnter={() => setOpen(true)}
        aria-hidden="true"
      />
      <div
        className={`wm-charm-bar${open ? " wm-charm-bar--open" : ""}${opening ? " wm-charm-bar--on" : ""}`}
        onMouseEnter={() => setOpen(true)}
        onMouseLeave={() => setOpen(false)}
      >
        <button
          type="button"
          className={`wm-charm__btn${hoverBtn ? " wm-charm__btn--hover" : ""}`}
          onClick={onToggle}
          onMouseEnter={() => setHoverBtn(true)}
          onMouseLeave={() => setHoverBtn(false)}
          title={label}
          aria-label={label}
        >
          <span className="wm-charm__icon">{opening ? "▤" : "⊞"}</span>
          <span className="wm-charm__label">{opening ? "关闭" : "打开"}</span>
        </button>
        <span className="wm-charm__mode">{opening ? "分屏" : "磁贴墙"}</span>
      </div>
    </>
  );
}