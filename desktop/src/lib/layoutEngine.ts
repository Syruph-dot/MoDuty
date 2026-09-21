import type { TileGeometry } from "../types";

/**
 * 磁贴双几何布局引擎。
 *
 * 两种模式：
 * - shelf（无磁贴打开）：每个磁贴使用用户自由摆放的 idle geometry（tiles[id]）。
 * - open（至少一个磁贴打开）：
 *   - 未打开的磁贴 → 左半屏「坞」：紧凑网格，占用 DOCK_RATIO 宽度；
 *   - 打开的磁贴 → 右半屏「舞台」：按 2n / 2n+1 规则铺开。
 *
 * 打开态布局是纯计算（不持久化）；idle geometry 仍由 store 持久化。
 */

export interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface OpenLayoutResult {
  /** tileId → 打开态 geometry（只有已打开的磁贴有戏：整屏舞台分格） */
  geometryOf: Record<string, TileGeometry>;
  /** 舞台区域（V2：占满整墙——左坞已删除，未打开的磁贴不再排一列小格子） */
  stage: Rect;
}

/** 舞台格子之间的间隙与四周内边距 */
export const STAGE_GAP = 10;

/** 画布为空时的安全兜底（bounds 尚未测量到） */
export function isBoundsReady(bounds: { width: number; height: number }): boolean {
  return bounds.width > 0 && bounds.height > 0;
}

/**
 * 计算打开态布局。
 *
 * V2：左坞（未打开磁贴的紧凑网格列）已删除——「当前 Agent 的下属」改用窗口头部的标签页条表达，
 * 所以打开态只有一整块舞台，打开卡片铺满整墙。
 *
 * @param bounds   整墙尺寸（像素）
 * @param openIds  当前打开的磁贴 id（顺序 = 打开顺序，越早越靠前）
 */
export function computeOpenLayout(
  bounds: { width: number; height: number },
  openIds: string[],
): OpenLayoutResult {
  const width = Math.max(0, bounds.width);
  const height = Math.max(0, bounds.height);

  const stage: Rect = { x: 0, y: 0, w: width, h: height };

  const geometryOf: Record<string, TileGeometry> = {};

  // ---- 右半屏舞台：打开的磁贴 ----
  // k = 2n：n 列 × 2 行，每格 w=stage.w/n、h=stage.h/2
  // k = 2n+1：n+1 列，最后一列独占全高（"2 2 2 2 1"）
  const k = openIds.length;
  const colCount = Math.max(1, Math.ceil(k / 2));
  const cellW = stage.w / colCount;
  const halfH = stage.h / 2;
  const lastColSingle = k % 2 === 1;

  openIds.forEach((id, index) => {
    if (!width || !height) {
      // bounds 未就绪：退化为空几何（不渲染偏移，避免 NaN/负尺寸）
      geometryOf[id] = { x: stage.x, y: 0, w: 0, h: 0 };
      return;
    }
    const col = Math.floor(index / 2);
    const row = index % 2;
    const single = lastColSingle && index === k - 1; // 奇数时最后一块独占一列
    const x = stage.x + col * cellW + STAGE_GAP / 2;
    const y = stage.y + (single ? 0 : row * halfH) + STAGE_GAP / 2;
    const w = Math.max(0, cellW - STAGE_GAP);
    const h = Math.max(0, (single ? stage.h : halfH) - STAGE_GAP);
    geometryOf[id] = { x, y, w, h };
  });

  return { geometryOf, stage };
}
