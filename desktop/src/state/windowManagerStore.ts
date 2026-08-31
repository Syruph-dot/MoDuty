/**
 * Windows 8 左右栏模态（双模态 + 时间戳排序）。
 *
 * 原则：
 * - 开放集合（谁打开）仍以 agentsStore.openAgentIds / browserStore.openBrowserIds 为事实源；
 * - 本 store 只记录「打开时间戳 / 最近完成」与「模态 / 排序配置」；
 * - 右栏 45px=模态切换（on=打开态分屏视图，off=磁贴墙自由视图；纯视觉切换，不销毁数据）；
 * - 左栏 240px=分类（Agent/Browser）+ 排序（最近打开/最近完成）+ 卡片。
 */
import { create } from "zustand";

export type WindowKind = "agent" | "browser";
export type WindowManagerMode = "on" | "off";
export type WindowSortKey = "openedAt" | "lastCompletedAt";

export interface ManagedWindow {
  kind: WindowKind;
  id: string;
  openedAt: number;
  lastCompletedAt?: number;
}

interface WindowManagerStore {
  /** on=打开态分屏（左坞+右舞台）；off=自由网格磁贴墙 */
  mode: WindowManagerMode;
  /** 左栏分组内排序主键 */
  sortBy: WindowSortKey;
  /** kind:id → 打开时间戳 */
  openedAtMap: Record<string, number>;
  /** kind:id → 最近完成时间戳（agent completed） */
  lastCompletedAtMap: Record<string, number>;
  markOpened: (kind: WindowKind, id: string) => void;
  markCompleted: (kind: WindowKind, id: string) => void;
  toggleMode: () => void;
  setMode: (mode: WindowManagerMode) => void;
  setSortBy: (sortBy: WindowSortKey) => void;
}

function keyOf(kind: WindowKind, id: string): string {
  return `${kind}:${id}`;
}

export const useWindowManagerStore = create<WindowManagerStore>()((set) => ({
  mode: "off",
  sortBy: "openedAt",
  openedAtMap: {},
  lastCompletedAtMap: {},

  markOpened(kind, id) {
    const now = Date.now();
    set((state) => ({
      openedAtMap: { ...state.openedAtMap, [keyOf(kind, id)]: now },
      // 打开窗口 = 进入打开态模态（右栏/左栏可见）
      mode: "on",
    }));
  },

  markCompleted(kind, id) {
    const now = Date.now();
    set((state) => ({
      lastCompletedAtMap: { ...state.lastCompletedAtMap, [keyOf(kind, id)]: now },
    }));
  },

  toggleMode() {
    set((state) => ({ mode: state.mode === "on" ? "off" : "on" }));
  },

  setMode(mode) {
    set({ mode });
  },

  setSortBy(sortBy) {
    set({ sortBy });
  },
}));

/** 从开放集合 + 时间戳派生窗口列表（打开时间升序；未记录时间戳的按 openIds 原顺序兜底） */
export function deriveManagedWindows(
  openAgentIds: string[],
  openBrowserIds: string[],
  map: { openedAtMap: Record<string, number>; lastCompletedAtMap: Record<string, number> },
): ManagedWindow[] {
  const items: ManagedWindow[] = [];
  const pushId = (kind: WindowKind, id: string): void => {
    items.push({
      kind,
      id,
      openedAt: map.openedAtMap[keyOf(kind, id)] ?? 0,
      ...(map.lastCompletedAtMap[keyOf(kind, id)]
        ? { lastCompletedAt: map.lastCompletedAtMap[keyOf(kind, id)] }
        : {}),
    });
  };
  for (const id of openAgentIds) pushId("agent", id);
  for (const id of openBrowserIds) pushId("browser", id);
  return items.sort(
    (a, b) => (a.openedAt ?? 0) - (b.openedAt ?? 0) || items.indexOf(a) - items.indexOf(b),
  );
}