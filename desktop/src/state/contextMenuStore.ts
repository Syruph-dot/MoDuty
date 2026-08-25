import { create } from "zustand";

export interface ContextMenuItem {
  id: string;
  label: string;
  onClick: () => void;
  disabled?: boolean;
}

interface ContextMenuStore {
  open: boolean;
  x: number;
  y: number;
  items: ContextMenuItem[];
  show: (position: { x: number; y: number }, items: ContextMenuItem[]) => void;
  hide: () => void;
}

/**
 * 桌面右键菜单的全局状态（任意位置可触发，ContextMenu 组件统一渲染）。
 * - x/y 是鼠标 client 坐标；ContextMenu 会自己 clamp 到视口内
 * - items 是动态注入的，触发点决定有什么项（目前桌面空白只有 New Agent）
 */
export const useContextMenuStore = create<ContextMenuStore>((set) => ({
  open: false,
  x: 0,
  y: 0,
  items: [],
  show: (position, items) => set({ open: true, x: position.x, y: position.y, items }),
  hide: () => set({ open: false, items: [] }),
}));
