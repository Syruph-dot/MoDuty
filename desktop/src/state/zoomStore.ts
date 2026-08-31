import { create } from "zustand";

export const ZOOM_MIN = 0.5;
export const ZOOM_MAX = 2;
export const ZOOM_STEP = 0.25;

interface ZoomStore {
  level: number;
  setLevel: (level: number) => void;
  zoomIn: () => void;
  zoomOut: () => void;
}

function clampLevel(level: number): number {
  return Math.max(ZOOM_MIN, Math.min(ZOOM_MAX, Math.round(level * 100) / 100));
}

/**
 * 画布缩放级别：只改变 cellSize（由 Desktop 经 computeMetrics 派生），
 * grid 坐标零改动 → 布局、拖动换算、持久化均不受影响。
 */
export const useZoomStore = create<ZoomStore>((set) => ({
  level: 1,
  setLevel: (level) => set({ level: clampLevel(level) }),
  zoomIn: () => set((state) => ({ level: clampLevel(state.level + ZOOM_STEP) })),
  zoomOut: () => set((state) => ({ level: clampLevel(state.level - ZOOM_STEP) })),
}));