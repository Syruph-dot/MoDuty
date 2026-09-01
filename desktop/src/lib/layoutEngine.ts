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
  /** agentId → 打开态 geometry（未打开→坞格子；已打开→舞台格子） */
  geometryOf: Record<string, TileGeometry>;
  /** 左半屏坞区域（含内边距前的外框） */
  dock: Rect;
  /** 右半屏舞台区域 */
  stage: Rect;
  /** 坞与舞台的分界 x 坐标（磁贴中心小于它即视为"拖入左坞"） */
  dockRightEdgeX: number;
}

/** 左半屏坞占整墙宽度的比例 */
export const DOCK_RATIO = 0.3;
/** 舞台格子之间的间隙与四周内边距 */
export const STAGE_GAP = 10;
/** 坞区域四周内边距 */
export const DOCK_PADDING = 10;
/** 坞内每行最多磁贴数 */
export const DOCK_COLS = 3;

/** 画布为空时的安全兜底（bounds 尚未测量到） */
export function isBoundsReady(bounds: { width: number; height: number }): boolean {
  return bounds.width > 0 && bounds.height > 0;
}

/**
 * 计算打开态布局。
 *
 * @param bounds   整墙尺寸（像素）
 * @param openIds  当前打开的磁贴 id（顺序 = 打开顺序，越早越靠前）
 * @param allIds   全部磁贴 id（openIds 之外的进坞）
 */
export function computeOpenLayout(
  bounds: { width: number; height: number },
  openIds: string[],
  allIds: string[],
): OpenLayoutResult {
  const width = Math.max(0, bounds.width);
  const height = Math.max(0, bounds.height);

  const dock: Rect = {
    x: 0,
    y: 0,
    w: width * DOCK_RATIO,
    h: height,
  };
  const stage: Rect = {
    x: dock.w,
    y: 0,
    w: width - dock.w,
    h: height,
  };

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

  // ---- 左半屏坞：未打开的磁贴（关联会话网格：≤6 → 2×3；>6 → 3×4，最多 12）----
  const dockIds = allIds.filter((id) => !openIds.includes(id));
  const m = dockIds.length;
  // 用户规则：候选 ≤6 → 2 列；>6 → 3 列。行数不限（browser 续排可能超过 12）
  const dockCols = m > 0 ? (m <= 6 ? 2 : 3) : 1;
  const dockRows = m > 0 ? Math.ceil(m / dockCols) : 0;
  const usableW = Math.max(0, dock.w - DOCK_PADDING * 2);
  const usableH = Math.max(0, dock.h - DOCK_PADDING * 2);
  const dockCellW = dockCols > 0 ? usableW / dockCols : 0;
  const dockCellH = dockRows > 0 ? usableH / dockRows : 0;

  dockIds.forEach((id, index) => {
    if (!width || !height) {
      geometryOf[id] = { x: dock.x + DOCK_PADDING, y: DOCK_PADDING, w: 0, h: 0 };
      return;
    }
    const col = index % dockCols;
    const row = Math.floor(index / dockCols);
    const x = dock.x + DOCK_PADDING + col * dockCellW;
    const y = dock.y + DOCK_PADDING + row * dockCellH;
    geometryOf[id] = { x, y, w: dockCellW, h: dockCellH };
  });

  return { geometryOf, dock, stage, dockRightEdgeX: dock.x + dock.w };
}