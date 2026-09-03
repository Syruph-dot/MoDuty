import { create } from "zustand";

import { spawnXToCol } from "../lib/persistTiles";
import { useTileStore } from "./tileStore";
import { WIDGET_REGISTRY } from "./widgetRegistry";
import type { WidgetInstance, WidgetKind } from "../types";

/* 启动时光标相对磁贴墙的落点：由 WidgetPickerCard 选择后传入 */
interface WidgetSpawn {
  x: number;
  y: number;
}

/**
 * widget 实例薄层（v3）：
 * - 只保存「实例存在性与外观」（id / kind / title）
 * - 几何与组属统一在 tileStore（单一事实源），本 store 不再持有 widget.grid
 * - 兼容层：WidgetInstance.grid 仍暴露（读时从 tileStore 取），减少消费端改动
 */
interface WidgetStore {
  /** 桌面上的所有 widget 磁贴（不含 agent/browser）；grid 为 tileStore 派生 */
  widgets: WidgetInstance[];
  /** 启动时从 tileStore（已迁移）还原已有的 widget 实例 */
  hydrate: () => void;
  /** 新建一个 widget 实例（默认落位或光标落位） */
  addWidget: (kind: WidgetKind, spawn?: WidgetSpawn) => void;
  /** 移除（同时从 tileStore 清理几何/组属） */
  removeWidget: (id: string) => void;
  /** 改名（仅前端，不接后端） */
  renameWidget: (id: string, title: string) => void;
  /** 兼容旧调用：拖动中（等价 tileStore.moveTile） */
  moveWidget: (id: string, grid: WidgetInstance["grid"]) => void;
  /** 兼容旧调用：拖动结束（等价 tileStore.commitTile） */
  commitWidget: (id: string, grid: WidgetInstance["grid"]) => void;
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

/** 从 tileStore 派生 widget 实例列表（kind 由 id 前缀解析；未知 kind 跳过） */
function deriveWidgets(): WidgetInstance[] {
  const tiles = useTileStore.getState().tiles;
  const result: WidgetInstance[] = [];
  for (const tile of Object.values(tiles)) {
    if (tile.kind !== "widget") continue;
    const kind = tile.id.slice("widget:".length).split(":")[0] as WidgetKind;
    const def = WIDGET_REGISTRY[kind];
    if (!def) continue;
    result.push({ id: tile.id, kind, title: def.defaultTitle, grid: tile.grid });
  }
  return result;
}

export const useWidgetStore = create<WidgetStore>()((set) => ({
  widgets: [],

  hydrate: () => {
    set({ widgets: deriveWidgets() });
  },

  addWidget(kind, spawn) {
    const def = WIDGET_REGISTRY[kind];
    if (!def) return;
    const tiles = useTileStore.getState();
    set((state) => {
      const id = nextWidgetId(kind, state.widgets);
      tiles.ensureTile(id, "widget", { colHint: spawnXToCol(spawn?.x), grid: { ...def.defaultGrid, col: 0, row: def.defaultGrid.row } });
      const instance: WidgetInstance = { id, kind, title: def.defaultTitle, grid: tiles.tiles[id]?.grid ?? def.defaultGrid };
      return { widgets: [...state.widgets, instance] };
    });
  },

  removeWidget(id) {
    useTileStore.getState().removeTile(id);
    set((state) => ({ widgets: state.widgets.filter((widget) => widget.id !== id) }));
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
    useTileStore.getState().moveTile(id, grid);
    set((state) => ({
      widgets: state.widgets.map((widget) => (widget.id === id ? { ...widget, grid } : widget)),
    }));
  },

  commitWidget(id, grid) {
    useTileStore.getState().commitTile(id, grid);
    set((state) => ({
      widgets: state.widgets.map((widget) => (widget.id === id ? { ...widget, grid } : widget)),
    }));
  },
}));
