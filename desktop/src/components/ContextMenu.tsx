import { useEffect } from "react";

import { useContextMenuStore } from "../state/contextMenuStore";

const MENU_ITEM_HEIGHT = 32;
const MENU_PADDING = 8;
const VIEWPORT_MARGIN = 8;

/**
 * 全局右键菜单渲染器：单一实例，由 store 驱动 open/x/y/items。
 * - 自动在视口边界 clamp（避免超出屏幕）
 * - 点击菜单项触发 onClick 后自动关闭
 * - 点击菜单外 / 按 Esc 关闭
 * - 阻止自身的 onContextMenu（防止在菜单上右键再弹一个）
 */
export default function ContextMenu() {
  const open = useContextMenuStore((state) => state.open);
  const x = useContextMenuStore((state) => state.x);
  const y = useContextMenuStore((state) => state.y);
  const items = useContextMenuStore((state) => state.items);
  const hide = useContextMenuStore((state) => state.hide);

  useEffect(() => {
    if (!open) return;
    const handleMouseDown = (event: MouseEvent) => {
      const target = event.target as HTMLElement | null;
      if (target?.closest(".context-menu")) {
        return; // 菜单内部点击由菜单项自己处理
      }
      hide();
    };
    const handleKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") hide();
    };
    const handleScroll = () => hide();
    document.addEventListener("mousedown", handleMouseDown);
    document.addEventListener("keydown", handleKey);
    window.addEventListener("scroll", handleScroll, true);
    return () => {
      document.removeEventListener("mousedown", handleMouseDown);
      document.removeEventListener("keydown", handleKey);
      window.removeEventListener("scroll", handleScroll, true);
    };
  }, [open, hide]);

  if (!open || items.length === 0) return null;

  // 视口边界 clamp（粗略估算菜单尺寸，每项 32px + 8px 上下 padding）
  const menuWidth = 200;
  const menuHeight = items.length * MENU_ITEM_HEIGHT + MENU_PADDING * 2;
  const vw = window.innerWidth;
  const vh = window.innerHeight;
  const left = Math.min(Math.max(VIEWPORT_MARGIN, x), vw - menuWidth - VIEWPORT_MARGIN);
  const top = Math.min(Math.max(VIEWPORT_MARGIN, y), vh - menuHeight - VIEWPORT_MARGIN);

  return (
    <ul
      className="context-menu"
      style={{ left, top }}
      role="menu"
      onContextMenu={(event) => event.preventDefault()}
    >
      {items.map((item) => (
        <li key={item.id} role="none">
          <button
            type="button"
            role="menuitem"
            className="context-menu__item"
            disabled={item.disabled}
            onClick={() => {
              if (item.disabled) return;
              hide();
              item.onClick();
            }}
          >
            {item.label}
          </button>
        </li>
      ))}
    </ul>
  );
}
