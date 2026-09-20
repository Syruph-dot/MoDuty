import {
  GRID_START_ROW,
  UNGROUPED_BAND_ID,
  type Tile,
  type TileGrid,
  type TileGeometry,
  type TileGroup,
} from "../types";
import type { GridMetrics } from "./gridLayout";

/**
 * Band（组带）布局：由 tileStore 的 tiles/groups 派生（纯函数，无几何事实源）。
 * - Band 序列：每个组带一个起始 X（px，累加），组间 GROUP_GAP 间距
 * - 组内局部网格：tile.grid 为带内局部坐标；渲染 = band.x + 局部网格
 * - 带序：用户组（order）→ 未分组（agent/widget/browser 同权）
 * - 可见性由调用方传入 isVisible（墙治理筛选只作用于 agent；widget/browser 恒可见）
 */

export const GROUP_GAP = 120;
export { UNGROUPED_BAND_ID } from "../types";

export interface Band {
  id: string;
  name: string;
  /** 组带起始 X（内容区相对坐标，渲染时再加 metrics.padding） */
  x: number;
  /** 组带宽度 px（组内列数决定；组带随内容收缩） */
  width: number;
  /** 组内最大列数（gridMap 局部坐标的 maxCol） */
  maxCol: number;
  ids: string[];
  /** 带内局部 gridMap（displace/落位只在此 map 内运行，天然不跨组） */
  gridMap: Record<string, TileGrid>;
  /** 用户组可改名；未分组带固定文案 */
  editable?: boolean;
}

export interface BandLayout {
  bands: Band[];
  /** tileId → band.id（命中检测快速判定跨带） */
  bandOf: Record<string, string>;
  /** 内容区宽度 px（最后带右缘 + 右 padding） */
  contentWidth: number;
}

export interface BandInput {
  tiles: Record<string, Tile>;
  groups: TileGroup[];
  metrics: GridMetrics;
  /** 可见性过滤（如墙治理筛选的 agent）；缺省全部可见 */
  isVisible?: (id: string) => boolean;
}

function bandWidthOf(maxCol: number, m: GridMetrics): number {
  if (maxCol <= 0) return 0;
  return maxCol * (m.cellW + m.gap) - m.gap;
}

/** 把磁贴集合装配成一个 band（局部坐标已在 tile.grid；clamp 到可放置范围） */
function makeBand(
  id: string,
  name: string,
  tiles: Tile[],
  metrics: GridMetrics,
  extra?: Partial<Band>,
): Band {
  const ordered = [...tiles].sort((a, b) => a.grid.col - b.grid.col || a.grid.row - b.grid.row);
  const ids = ordered.map((t) => t.id);
  const gridMap: Record<string, TileGrid> = {};
  let maxCol = 0;
  for (const tile of ordered) {
    const g = tile.grid;
    const grid: TileGrid = {
      col: Math.max(0, g.col),
      row: Math.max(GRID_START_ROW, Math.min(g.row, metrics.rows - g.h)),
      w: g.w,
      h: g.h,
    };
    gridMap[tile.id] = grid;
    maxCol = Math.max(maxCol, grid.col + grid.w);
  }
  return { id, name, x: 0, width: 0, maxCol, ids, gridMap, ...extra };
}

export function computeBands(input: BandInput): BandLayout {
  const { tiles, groups, metrics, isVisible } = input;
  const visible = (t: Tile): boolean => (isVisible ? isVisible(t.id) : true);
  const bands: Band[] = [];
  const bandOf: Record<string, string> = {};

  // 1) 用户组（按 order）
  const sortedGroups = [...groups].sort((a, b) => a.order - b.order);
  for (const g of sortedGroups) {
    const members = Object.values(tiles).filter((t) => t.groupId === g.id && visible(t));
    if (members.length === 0) continue;
    const band = makeBand(g.id, g.name, members, metrics, { editable: true });
    for (const id of band.ids) bandOf[id] = band.id;
    bands.push(band);
  }

  // 2) 未分组带（agent/widget/browser 同权）
  const ungrouped = Object.values(tiles).filter((t) => t.groupId === UNGROUPED_BAND_ID && visible(t));
  if (ungrouped.length > 0) {
    const band = makeBand(UNGROUPED_BAND_ID, "未分组", ungrouped, metrics);
    for (const id of band.ids) bandOf[id] = band.id;
    bands.push(band);
  }

  // 3) X 轴排布：x 累加 + GROUP_GAP；contentWidth = 最后带右缘 + 右 padding
  let cursor = 0;
  let contentWidth = 0;
  for (const band of bands) {
    band.x = cursor;
    band.width = bandWidthOf(band.maxCol, metrics);
    const right = cursor + band.width;
    if (right > contentWidth) contentWidth = right;
    cursor = right + GROUP_GAP;
  }
  contentWidth += metrics.padding;

  return { bands, bandOf, contentWidth };
}

/* ────────────────────── 拖拽落点解译（唯一权威：灰框位置 → 含义） ────────────────────── */

/** 落点含义：带内移位 / 进入用户组 / 回未分组 */
export type DropKind = "move" | "group" | "ungroup";

export interface DropIntent {
  sourceId: string;
  sourceBandId: string;
  /** 目标带（灰框中心落在哪条带；落在带间空隙时归最近的带） */
  bandId: string;
  /** 灰框在目标带内的局部格 */
  grid: TileGrid;
  /** 灰框像素（内容区坐标，可直接交给 GhostPreview 渲染） */
  pixels: TileGeometry;
  /** 该格上已存在的磁贴（用于高亮与让位；同带时为“被推开的那张”） */
  targetTileId: string | null;
  kind: DropKind;
}

/** 带在内容区 X 轴上的 [left, right]；width 为 0（空带/单列未展开）时退化为中心点 */
function bandXRange(band: Band): { left: number; right: number } {
  return { left: band.x, right: band.x + Math.max(0, band.width) };
}

/** 取 x（带坐标系：内容区 x 减去 padding）落在哪条带；落在空隙/外侧时取最近的带 */
export function pickBandAtX(bands: Band[], x: number): Band | null {
  if (bands.length === 0) return null;
  let best = bands[0];
  let bestDist = Infinity;
  for (const band of bands) {
    const { left, right } = bandXRange(band);
    const dist = x < left ? left - x : x > right ? x - right : 0;
    if (dist < bestDist) {
      bestDist = dist;
      best = band;
    } else if (dist === bestDist && band.x < best.x) {
      best = band; // 平局取靠左的带（更符合“往回并”的直觉）
    }
  }
  return best;
}

/**
 * 解译拖拽落点：
 * 1) 磁贴中心（内容区像素）→ 落在哪条带（pickBandAtX，空隙归最近带）
 * 2) 带内局部格：按磁贴块中心对齐到目标格，并 clamp 到 [0, 带列数]（允许向右多占一列）×
 *    [GRID_START_ROW, GRID_ROWS - h]（绝不出网格）
 * 3) 含义：同带 = 移位；跨带且目标是用户组 = 进组；跨带且目标是未分组 = 回未分组
 *
 * 注：这里不再按指针“悬停到什么元素”判定，灰框落在哪就是哪 —— 预览与落点天然一致。
 */
export function resolveDropIntent(input: {
  bands: Band[];
  metrics: GridMetrics;
  sourceId: string;
  sourceBandId: string | null;
  /** 磁贴中心（内容区坐标） */
  centerX: number;
  centerY: number;
  w: number;
  h: number;
}): DropIntent | null {
  const { bands, metrics, sourceId, sourceBandId, centerX, centerY, w, h } = input;
  if (bands.length === 0) return null;
  // 带坐标系：内容区 x = padding + 带坐标，所以这里先把 padding 减掉
  const bandX = centerX - metrics.padding;
  const band = pickBandAtX(bands, bandX);
  if (!band) return null;

  const stepX = metrics.cellW + metrics.gap;
  const stepY = metrics.cellH + metrics.gap;
  // 磁贴块中心对齐：块的像素跨度 = w*step - gap
  const spanX = w * stepX - metrics.gap;
  const spanY = h * stepY - metrics.gap;
  const localX = centerX - metrics.padding - band.x;
  const localY = centerY - metrics.padding;
  const maxCol = Math.max(0, band.maxCol);
  const col = Math.max(0, Math.min(maxCol, Math.round((localX - spanX / 2) / stepX)));
  const row = Math.max(
    GRID_START_ROW,
    Math.min(metrics.rows - h, Math.round((localY - spanY / 2) / stepY)),
  );
  const grid: TileGrid = { col, row, w, h };

  let targetTileId: string | null = null;
  for (const [id, tg] of Object.entries(band.gridMap)) {
    if (id === sourceId) continue;
    const overlap =
      tg.col < grid.col + grid.w && tg.col + tg.w > grid.col && tg.row < grid.row + grid.h && tg.row + tg.h > grid.row;
    if (overlap) {
      targetTileId = id;
      break;
    }
  }

  const kind: DropKind = band.id === sourceBandId ? "move" : band.id === UNGROUPED_BAND_ID ? "ungroup" : "group";

  return {
    sourceId,
    sourceBandId: sourceBandId ?? band.id,
    bandId: band.id,
    grid,
    pixels: {
      x: metrics.padding + band.x + grid.col * stepX,
      y: metrics.padding + grid.row * stepY,
      w: spanX,
      h: spanY,
    },
    targetTileId,
    kind,
  };
}
