import { create } from "zustand";
import type { TileGeometry, TileGrid } from "../types";

/**
 * 拖动/缩放过程中的“量化灰色提示框”（Win8 ghost）。
 * TileShell 在拖动中实时写入像素几何，Desktop 层的 GhostPreview 负责渲染。
 * displaced：拖动灰框临时让位预览（被波及磁贴的临时网格），松手/取消清空。
 */
interface GhostStore {
  pixels: TileGeometry | null;
  setGhost: (pixels: TileGeometry) => void;
  clearGhost: () => void;
  /** 被 ghost 波及磁贴的临时网格（id → 临时 grid）；渲染时覆盖原网格，不落盘 */
  displaced: Record<string, TileGrid>;
  setDisplaced: (map: Record<string, TileGrid>) => void;
  clearDisplaced: () => void;
}

export const useGhostStore = create<GhostStore>((set) => ({
  pixels: null,
  setGhost: (pixels) => set({ pixels }),
  clearGhost: () => set({ pixels: null }),
  displaced: {},
  setDisplaced: (map) => set({ displaced: map }),
  clearDisplaced: () => set({ displaced: {} }),
}));