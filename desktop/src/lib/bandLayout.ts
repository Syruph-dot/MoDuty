import {
  GRID_START_ROW,
  SYSTEM_BAND_ID,
  UNGROUPED_BAND_ID,
  type Tile,
  type TileGrid,
  type TileGroup,
} from "../types";
import type { GridMetrics } from "./gridLayout";

/**
 * Band（组带）布局：由 tileStore 的 tiles/groups 派生（纯函数，无几何事实源）。
 * - Band 序列：每个组带一个起始 X（px，累加），组间 GROUP_GAP 间距
 * - 组内局部网格：tile.grid 为带内局部坐标；渲染 = band.x + 局部网格
 * - 带序：用户组（order）→ 未分组 → 系统（browser）
 * - 可见性由调用方传入 isVisible（墙治理筛选只作用于 agent；widget/browser 恒可见）
 */

export const GROUP_GAP = 120;
export { UNGROUPED_BAND_ID, SYSTEM_BAND_ID } from "../types";

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
  /** 是否系统带（browser，不参与成组/排斥） */
  isSystem?: boolean;
  /** 用户组可改名；未分组/系统带固定文案 */
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

  // 2) 未分组带（agent/widget 同权）
  const ungrouped = Object.values(tiles).filter((t) => t.groupId === UNGROUPED_BAND_ID && visible(t));
  if (ungrouped.length > 0) {
    const band = makeBand(UNGROUPED_BAND_ID, "未分组", ungrouped, metrics);
    for (const id of band.ids) bandOf[id] = band.id;
    bands.push(band);
  }

  // 3) 系统带（browser，最右，不参与成组）
  const system = Object.values(tiles).filter(
    (t) => (t.groupId === SYSTEM_BAND_ID || t.kind === "browser") && visible(t),
  );
  if (system.length > 0) {
    const band = makeBand(SYSTEM_BAND_ID, "系统", system, metrics, { isSystem: true });
    for (const id of band.ids) bandOf[id] = band.id;
    bands.push(band);
  }

  // 4) X 轴排布：x 累加 + GROUP_GAP；contentWidth = 最后带右缘 + 右 padding
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
