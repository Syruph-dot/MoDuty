import { GRID_ROWS, TILE_SIZES, type TileGeometry, type TileGrid } from "../types";
import { GRID_START_ROW } from "../types";

/**
 * Win8 磁贴网格布局引擎（布局去自由化）。
 * 全部为纯函数，可直接单测。
 *
 * 模型：
 * - 网格是唯一事实来源：5 行固定（GRID_ROWS）、列数不限、单位尺寸 ∈ TILE_SIZES
 * - 第 0 行保留（GRID_START_ROW=1 起可放）：磁贴从第 2 格开始放置，顶部留空行
 * - 像素几何 = grid × cellSize + gap（gridToPixels 派生）
 * - 缩放 = 调整 cellSize（zoom），grid 坐标零改动
 */

export type TileGridMap = Record<string, TileGrid>;
export type ResizeDirection = "n" | "s" | "e" | "w" | "ne" | "nw" | "se" | "sw";

export const GRID_GAP = 8;
export const GRID_PADDING = 12;
export const MIN_CELL = 32;

/** 网格度量（像素层）；由视口尺寸 + zoom 计算，一次计算全画布共享 */
export interface GridMetrics {
  cellW: number;
  cellH: number;
  gap: number;
  padding: number;
  rows: number;
}

/** 根据视口（可见区）尺寸计算单元格大小。cellW=cellH（正方形 Win8 单元）。 */
export function computeMetrics(
  _viewW: number,
  viewH: number,
  opts: { gap?: number; padding?: number; rows?: number; zoom?: number } = {},
): GridMetrics {
  const gap = opts.gap ?? GRID_GAP;
  const padding = opts.padding ?? GRID_PADDING;
  const rows = opts.rows ?? GRID_ROWS;
  const zoom = opts.zoom ?? 1;
  const usableH = Math.max(0, viewH - padding * 2 - gap * (rows - 1));
  const cellH = Math.max(MIN_CELL, Math.floor(usableH / rows) * zoom);
  return { cellW: cellH, cellH, gap, padding, rows };
}

/** grid → 像素（绝对定位几何）。 */
export function gridToPixels(tg: TileGrid, m: GridMetrics): TileGeometry {
  return {
    x: m.padding + tg.col * (m.cellW + m.gap),
    y: m.padding + tg.row * (m.cellH + m.gap),
    w: tg.w * m.cellW + (tg.w - 1) * m.gap,
    h: tg.h * m.cellH + (tg.h - 1) * m.gap,
  };
}

/**
 * 像素 → 鼠标中心所在格（坐标需为“已减去墙偏移与 scrollLeft 的内容区坐标”）。
 * 以格子中心为基准做四舍五入：中心没过格中心阈值不切换（无向下的 ceil 感）。
 * 返回的 col/row 可为负，由调用方 clamp。
 */
export function pixelsToGrid(
  x: number,
  y: number,
  m: GridMetrics,
): { col: number; row: number } {
  return {
    col: Math.round((x - m.padding - (m.cellW + m.gap) / 2) / (m.cellW + m.gap)),
    row: Math.round((y - m.padding - (m.cellH + m.gap) / 2) / (m.cellH + m.gap)),
  };
}

/** 把 row 限制在 [GRID_START_ROW, rows-h]、col 限制在 ≥ 0。 */
export function clampGrid(tg: TileGrid, rows: number): TileGrid {
  return {
    col: Math.max(0, tg.col),
    row: Math.max(GRID_START_ROW, Math.min(tg.row, rows - tg.h)),
    w: tg.w,
    h: tg.h,
  };
}

export interface GridRange {
  col: number;
  row: number;
  w: number;
  h: number;
}

/** 两矩形（grid 单位）是否相交（含边相接 = 不相交）。 */
export function rectsOverlap(a: GridRange, b: GridRange): boolean {
  return a.col < b.col + b.w && a.col + a.w > b.col && a.row < b.row + b.h && a.row + a.h > b.row;
}

/** (col,row,w,h) 区域是否与地图中其它磁贴重叠，且不越界/不进入保留行。 */
export function isFree(map: TileGridMap, range: GridRange, excludeId?: string): boolean {
  if (range.row < GRID_START_ROW || range.row + range.h > GRID_ROWS) return false;
  for (const [id, tg] of Object.entries(map)) {
    if (id === excludeId) continue;
    if (rectsOverlap(tg, range)) return false;
  }
  return true;
}

/**
 * 移动目标解析（"找空位、不推人"）：
 * 1) 目标格可行 → 直接返回；
 * 2) 同列向下找空；
 * 3) 向右逐列（每列从 r 起向下扫）找第一个可行位置。
 * 找不到（理论上不会，列无限）返回 null。
 */
export function findDropTarget(
  map: TileGridMap,
  selfId: string,
  c: number,
  r: number,
  w: number,
  h: number,
): { col: number; row: number } | null {
  const startRow = Math.max(GRID_START_ROW, Math.min(r, GRID_ROWS - h));
  for (let d = 0; d < 64; d += 1) {
    const candCol = Math.max(0, c + d);
    for (let rr = startRow; rr <= GRID_ROWS - h; rr += 1) {
      if (isFree(map, { col: candCol, row: rr, w, h }, selfId)) {
        return { col: candCol, row: rr };
      }
    }
  }
  return null;
}

/** 在 TILE_SIZES 中取最接近 (rawW, rawH) 的合法尺寸；平局时尊重鼠标主导轴。 */
export function nearestSize(rawW: number, rawH: number, dx: number, dy: number): { w: number; h: number } {
  const cw = Math.max(1, Math.min(3, Math.round(rawW)));
  const ch = Math.max(1, Math.min(3, Math.round(rawH)));
  const preferW = Math.abs(dx) >= Math.abs(dy) && (dx !== 0 || dy === 0);
  let best = TILE_SIZES[0];
  let bestDist = Infinity;
  for (const s of TILE_SIZES) {
    const dist = Math.abs(s.w - cw) + Math.abs(s.h - ch);
    if (dist < bestDist) {
      best = s;
      bestDist = dist;
    } else if (dist === bestDist) {
      const curIsWide = best.w >= best.h;
      const candIsWide = s.w >= s.h;
      // 平局：如果当前候选不符合主导轴而新候选符合，则切换
      if (preferW !== curIsWide && candIsWide === preferW) {
        best = s;
      }
    }
  }
  return best;
}

/**
 * 量化缩放：8 方向把手拖动。
 * - 锚点 = 对角固定格（e/s 系锚西北，w/n 系锚东南/东北/西南）
 * - 鼠标 delta → 目标像素跨度 → 原始单位 (rawW, rawH) → TILE_SIZES 最近合法尺寸
 * - 若有冲突 → findDropTarget 找最近空位；找不到退回原几何
 */
export function quantizeResize(
  map: TileGridMap,
  selfId: string,
  dir: ResizeDirection,
  origin: TileGrid,
  dx: number,
  dy: number,
  m: GridMetrics,
): TileGrid {
  const originPx = gridToPixels(origin, m);

  // 各轴目标跨度（单位，含 gap 换算）
  let rawW = origin.w;
  if (dir.includes("e")) {
    const rightPx = originPx.x + originPx.w + dx;
    rawW = (rightPx - originPx.x + m.gap) / (m.cellW + m.gap);
  } else if (dir.includes("w")) {
    const leftPx = originPx.x + dx;
    rawW = (originPx.x + originPx.w - leftPx + m.gap) / (m.cellW + m.gap);
  }

  let rawH = origin.h;
  if (dir.includes("s")) {
    const bottomPx = originPx.y + originPx.h + dy;
    rawH = (bottomPx - originPx.y + m.gap) / (m.cellH + m.gap);
  } else if (dir.includes("n")) {
    const topPx = originPx.y + dy;
    rawH = (originPx.y + originPx.h - topPx + m.gap) / (m.cellH + m.gap);
  }

  const size = nearestSize(rawW, rawH, dx, dy);

  // 锚点格 → 最终 grid
  let col = origin.col;
  let row = origin.row;
  if (dir.includes("e")) {
    col = origin.col; // 西边固定
  } else if (dir.includes("w")) {
    col = origin.col + origin.w - size.w; // 东边固定
  }
  if (dir.includes("s")) {
    row = origin.row; // 北边固定
  } else if (dir.includes("n")) {
    row = origin.row + origin.h - size.h; // 南边固定
  }

  const target = clampGrid({ col, row, w: size.w, h: size.h }, GRID_ROWS);
  if (isFree(map, target, selfId)) return target;
  const dropped = findDropTarget(map, selfId, target.col, target.row, target.w, target.h);
  return dropped ? { ...target, col: dropped.col, row: dropped.row } : origin;
}

/**
 * 拖动灰框临时让位：返回“被 ghost 波及磁贴”的临时网格（预览布局）。
 * - 与 ghost 矩形重叠的磁贴会被临时推挤到 ghost 右侧首个可容纳空位（保持不动其它磁贴）；
 * - 未被波及磁贴保持原位（作为障碍），波及磁贴按 (col,row) 顺序逐个放置；
 * - 纯瞬态：不落盘，ghost 离开波及区域后渲染自然恢复原网格。
 */
export function displaceTiles(
  map: TileGridMap,
  ghost: TileGrid,
  selfId: string,
): Record<string, TileGrid> {
  const ghostRect = { col: ghost.col, row: ghost.row, w: ghost.w, h: ghost.h };
  const affected = Object.entries(map)
    .filter(([id, tg]) => id !== selfId && rectsOverlap(tg, ghostRect))
    .sort(([idA, a], [idB, b]) => a.col - b.col || a.row - b.row || (idA < idB ? -1 : 1));
  if (affected.length === 0) return {};

  // 障碍集：ghost 本身 + 所有未被波及的磁贴（原位不动）
  const obstacles: TileGridMap = {};
  obstacles[selfId] = { col: ghost.col, row: ghost.row, w: ghost.w, h: ghost.h };
  for (const [id, tg] of Object.entries(map)) {
    if (id === selfId) continue;
    if (!rectsOverlap(tg, ghostRect)) obstacles[id] = tg;
  }

  const out: Record<string, TileGrid> = {};
  for (const [id, tg] of affected) {
    let placed: TileGrid | null = null;
    for (let col = ghost.col + ghost.w; col < ghost.col + ghost.w + 64 && !placed; col += 1) {
      for (let row = GRID_START_ROW; row <= GRID_ROWS - tg.h; row += 1) {
        if (isFree(obstacles, { col, row, w: tg.w, h: tg.h })) {
          placed = { col, row, w: tg.w, h: tg.h };
          break;
        }
      }
    }
    const final = placed ?? { ...tg }; // 极端兜底：原位（闪烁可接受，不破坏）
    out[id] = final;
    obstacles[id] = final;
  }
  return out;
}

/**
 * 找到放置 w×h 磁贴的第一个可容纳空位（可放置行范围）；从 colHint 列开始逐列自上而下。
 * 用于新增固定尺寸 widget（如值日生 2×3）——保持已有磁贴位置不变。
 */
export function firstFreeSlot(
  map: TileGridMap,
  colHint: number,
  w: number,
  h: number,
): { col: number; row: number } {
  for (let d = 0; d < 64; d += 1) {
    const col = Math.max(0, colHint + d);
    for (let row = GRID_START_ROW; row <= GRID_ROWS - h; row += 1) {
      if (isFree(map, { col, row, w, h })) {
        return { col, row };
      }
    }
  }
  return { col: Math.max(0, colHint), row: GRID_START_ROW };
}

/** 找到放置 1×1 磁贴的第一个空闲格（可放置行范围）；从 colHint 列开始，逐列自上而下找。 */
export function firstFreeCell(map: TileGridMap, colHint: number): { col: number; row: number } {
  for (let d = 0; d < 64; d += 1) {
    const col = Math.max(0, colHint + d);
    for (let row = GRID_START_ROW; row < GRID_ROWS; row += 1) {
      if (isFree(map, { col, row, w: 1, h: 1 })) {
        return { col, row };
      }
    }
  }
  return { col: Math.max(0, colHint), row: GRID_START_ROW };
}

/**
 * 全量冲突解决（推挤）：
 * 反复找第一对重叠磁贴，把"靠后"（row 大；row 相同 col 大；再同 id 序）者
 * 下移一格；越界 → 右移一列回到 row 0。带步数上限，走满后残留由 compactGrid 兜底。
 * 仅用于"新建插入/顺延"，移动磁贴走 findDropTarget（不推人）。
 */
export function resolveOverlaps(map: TileGridMap, maxSteps = 800): TileGridMap {
  const next: TileGridMap = { ...map };
  let steps = 0;
  for (;;) {
    let pair: [string, string] | null = null;
    const ids = Object.keys(next);
    outer: for (let i = 0; i < ids.length; i += 1) {
      for (let j = i + 1; j < ids.length; j += 1) {
        const a = next[ids[i]];
        const b = next[ids[j]];
        if (rectsOverlap(a, b)) {
          // 靠后者被推
          const aAfter = a.row > b.row || (a.row === b.row && a.col >= b.col);
          pair = aAfter ? [ids[i], ids[j]] : [ids[j], ids[i]];
          break outer;
        }
      }
    }
    if (!pair) break;
    steps += 1;
    if (steps > maxSteps) break;
    const pushed = next[pair[0]];
    pushed.row += 1;
    if (pushed.row + pushed.h > GRID_ROWS) {
      pushed.col += 1;
      pushed.row = GRID_START_ROW;
    }
  }
  return next;
}

/**
 * 新建 Agent / widget / browser 插入（保持布局）：
 * 1) 从 colHint 列开始逐列找第一个空单格（firstFreeCell，绝不与已有磁贴重叠）；
 * 2) 新磁贴 (1×1) 放入；
 * 3) **不推挤、不 compact**：已有磁贴的位置保持不动（用户要求“新建不重新布局”）。
 */
export function insertTile(
  map: TileGridMap,
  newId: string,
  colHint: number,
): TileGridMap {
  const slot = firstFreeCell(map, colHint);
  return {
    ...map,
    [newId]: { col: slot.col, row: slot.row, w: 1, h: 1 },
  };
}

/**
 * 全量紧凑（"整理桌面"）：
 * 按 (col, row) 稳定排序后，逐个放入"逐行扫描的首个可容纳空位"。
 * 消除空洞，保证无重叠；列无限所以必然成功。
 */
export function compactGrid(map: TileGridMap): TileGridMap {
  const entries = Object.entries(map).sort(([idA, a], [idB, b]) => {
    if (a.col !== b.col) return a.col - b.col;
    if (a.row !== b.row) return a.row - b.row;
    return idA.localeCompare(idB);
  });
  const next: TileGridMap = {};
  for (const [id, tg] of entries) {
    outer: for (let col = 0; ; col += 1) {
      for (let row = GRID_START_ROW; row <= GRID_ROWS - tg.h; row += 1) {
        if (isFree(next, { col, row, w: tg.w, h: tg.h })) {
          next[id] = { col, row, w: tg.w, h: tg.h };
          break outer;
        }
      }
    }
  }
  return next;
}

/** 当前内容最大列数（列跨度），用于计算画布宽度。 */
export function maxContentCol(map: TileGridMap): number {
  let maxCol = 0;
  for (const tg of Object.values(map)) {
    maxCol = Math.max(maxCol, tg.col + tg.w);
  }
  return maxCol;
}