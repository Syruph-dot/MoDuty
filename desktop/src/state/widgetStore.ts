import { create } from "zustand";

import { firstFreeSlot } from "../lib/gridLayout";
import {
  loadAllTiles,
  removeTile,
  saveTile,
  spawnXToCol,
} from "../lib/persistTiles";
import { WIDGET_REGISTRY } from "./widgetRegistry";
import type { TileGrid, WidgetInstance, WidgetKind } from "../types";

/* 启动时光标相对磁贴墙的落点：由 WidgetPickerCard 选择后传入 */
interface WidgetSpawn {
  x: number;
  y: number;
}

interface WidgetStore {
  /** 桌面上的所有 widget 磁贴（不含 agent） */
  widgets: WidgetInstance[];
  /** 启动时从 localStorage 还原已有的 widget 几何（key: widget:*） */
  hydrate: () => void;
  /** 新建一个 widget 实例（默认落位或光标落位） */
  addWidget: (kind: WidgetKind, spawn?: WidgetSpawn) => void;
  /** 移除（同时清 localStorage 几何） */
  removeWidget: (id: string) => void;
  /** 改名（仅前端，不接后端） */
  renameWidget: (id: string, title: string) => void;
  /** 拖动中（只改 store，不落盘） */
  moveWidget: (id: string, grid: TileGrid) => void;
  /** 拖动结束（落盘 localStorage） */
  commitWidget: (id: string, grid: TileGrid) => void;
}

let widgetSeq = 0;

/** 生成稳定且不会与已有 id 冲突的实例 id */
function nextWidgetId(kind: WidgetKind, existing: WidgetInstance[]): string {
  // 先尝试紧凑编号，冲突则 +1 直到不冲突
  widgetSeq += 1;
  const baseId = `widget:${kind}:${widgetSeq}`;
  if (!existing.some((widget) => widget.id === baseId)) return baseId;
  let i = 1;
  while (existing.some((widget) => widget.id === `widget:${kind}:${widgetSeq}-${i}`)) {
    i += 1;
  }
  return `widget:${kind}:${widgetSeq}-${i}`;
}

/** 从 localStorage 中仅挑出 widget:* 的几何，组装成实例 */
function buildFromStorage(): WidgetInstance[] {
  const all = loadAllTiles();
  const result: WidgetInstance[] = [];
  for (const [key, grid] of Object.entries(all)) {
    if (!key.startsWith("widget:")) continue;
    // key 形如 widget:<kind>:<seq>，解析 kind
    const kind = key.slice("widget:".length).split(":")[0] as WidgetKind;
    const def = WIDGET_REGISTRY[kind];
    if (!def) {
      // 未知 kind（如旧版本残留）→ 跳过，不渲染
      continue;
    }
    result.push({ id: key, kind, title: def.defaultTitle, grid });
  }
  return result;
}

export const useWidgetStore = create<WidgetStore>()((set) => ({
  widgets: [],

  hydrate: () => {
    set({ widgets: buildFromStorage() });
  },

  addWidget(kind, spawn) {
    const def = WIDGET_REGISTRY[kind];
    if (!def) return;
    set((state) => {
      const id = nextWidgetId(kind, state.widgets);
      // 按 defaultGrid 尺寸找空位落位（保持已有磁贴位置不变；值日生 2×3 等固定尺寸生效）
      const map: Record<string, TileGrid> = {};
      for (const widget of state.widgets) {
        map[widget.id] = widget.grid;
      }
      const slot = firstFreeSlot(map, spawnXToCol(spawn?.x), def.defaultGrid.w, def.defaultGrid.h);
      const grid = { ...def.defaultGrid, col: slot.col, row: slot.row };
      const instance: WidgetInstance = { id, kind, title: def.defaultTitle, grid };
      // 立即落盘几何（空几何也写，方便下次启动还原）
      saveTile(id, grid);
      return { widgets: [...state.widgets, instance] };
    });
  },

  removeWidget(id) {
    set((state) => ({ widgets: state.widgets.filter((widget) => widget.id !== id) }));
    removeTile(id);
  },

  renameWidget(id, title) {
    set((state) => {
      const trimmed = title.trim();
      // 找不到实例时回退到 registry 里该 kind 的默认标题
      const fallback = state.widgets.find((widget) => widget.id === id);
      const nextTitle = trimmed || (WIDGET_REGISTRY[fallback?.kind ?? "ringclock"]?.defaultTitle ?? "Widget");
      return {
        widgets: state.widgets.map((widget) =>
          widget.id === id ? { ...widget, title: nextTitle } : widget,
        ),
      };
    });
  },

  moveWidget(id, grid) {
    set((state) => ({
      widgets: state.widgets.map((widget) => (widget.id === id ? { ...widget, grid } : widget)),
    }));
  },

  commitWidget(id, grid) {
    set((state) => ({
      widgets: state.widgets.map((widget) => (widget.id === id ? { ...widget, grid } : widget)),
    }));
    saveTile(id, grid);
  },
}));
