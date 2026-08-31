import { create } from "zustand";

import {
  DEFAULT_TILE_GEOMETRY,
  loadAllTiles,
  removeTile,
  saveTile,
} from "../lib/persistTiles";
import { WIDGET_REGISTRY } from "./widgetRegistry";
import type { TileGeometry, WidgetInstance, WidgetKind } from "../types";

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
  moveWidget: (id: string, geometry: TileGeometry) => void;
  /** 拖动结束（落盘 localStorage） */
  commitWidget: (id: string, geometry: TileGeometry) => void;
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
  for (const [key, geom] of Object.entries(all)) {
    if (!key.startsWith("widget:")) continue;
    // key 形如 widget:<kind>:<seq>，解析 kind
    const kind = key.slice("widget:".length).split(":")[0] as WidgetKind;
    const def = WIDGET_REGISTRY[kind];
    if (!def) {
      // 未知 kind（如旧版本残留）→ 跳过，不渲染
      continue;
    }
    result.push({ id: key, kind, title: def.defaultTitle, geometry: geom });
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
      // 默认几何基础上，若用户在选择卡点击处落位，则以光标为中心
      const geometry: TileGeometry = spawn
        ? {
            x: Math.max(0, spawn.x - def.defaultGeometry.w / 2),
            y: Math.max(0, spawn.y - def.defaultGeometry.h / 2),
            w: def.defaultGeometry.w,
            h: def.defaultGeometry.h,
          }
        : { ...DEFAULT_TILE_GEOMETRY };
      const instance: WidgetInstance = { id, kind, title: def.defaultTitle, geometry };
      // 立即落盘几何（空几何也写，方便下次启动还原）
      saveTile(id, geometry);
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

  moveWidget(id, geometry) {
    set((state) => ({
      widgets: state.widgets.map((widget) => (widget.id === id ? { ...widget, geometry } : widget)),
    }));
  },

  commitWidget(id, geometry) {
    set((state) => ({
      widgets: state.widgets.map((widget) => (widget.id === id ? { ...widget, geometry } : widget)),
    }));
    saveTile(id, geometry);
  },
}));
