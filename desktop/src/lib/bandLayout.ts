import { GRID_START_ROW, type TileGrid } from "../types";
import type { Agent } from "../types";
import type { GroupMemberTile, TileGroup } from "../state/agentsStore";
import type { GridMetrics } from "./gridLayout";

/**
 * Band（组带）布局：打破全局网格，采用两层结构。
 * - Band 序列：每个组带一个起始 X（px，累加），组间 GROUP_GAP 间距
 * - 组内局部网格：col/row 仅带内有效（gridMap 局部），渲染 = band.x + 局部网格
 * - 未分组 session 统一作为最后一个「未分组」带；browser/widget 并入最右「系统」带（不参与成组）
 * - 所有 tile 位置均存于 groupMembers（g=UNGROUPED_BAND_ID 表示未分组），不再使用全局 tiles map
 */

export const GROUP_GAP = 120;
export const UNGROUPED_BAND_ID = "__ungrouped";
export const SYSTEM_BAND_ID = "__system";

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
  /** 是否系统带（browser/widget，不参与成组/排斥） */
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
  agents: Agent[];
  groups: TileGroup[];
  groupMembers: Record<string, GroupMemberTile>;
  browsers: { id: string }[];
  browserTiles: Record<string, TileGrid>;
  widgets: { id: string; grid: TileGrid }[];
  metrics: GridMetrics;
}

function bandWidthOf(maxCol: number, m: GridMetrics): number {
  if (maxCol <= 0) return 0;
  return maxCol * (m.cellW + m.gap) - m.gap;
}

export function computeBands(input: BandInput): BandLayout {
  const { agents, groups, groupMembers, browsers, browserTiles, widgets, metrics } = input;
  const bands: Band[] = [];
  const bandOf: Record<string, string> = {};

  // 1) 用户组（按 order；成员 = 广义 Tile：墙内可见 agents + widgets，widget 与 session 同权）
  const tileIds = new Set([...agents.map((a) => a.id), ...widgets.map((w) => w.id)]);
  const sortedGroups = [...groups].sort((a, b) => a.order - b.order);
  for (const g of sortedGroups) {
    const ids = Object.keys(groupMembers)
      .filter((id) => groupMembers[id].g === g.id && tileIds.has(id))
      .sort((a, b) => {
        const ma = groupMembers[a];
        const mb = groupMembers[b];
        return ma.col - mb.col || ma.row - mb.row;
      });
    if (ids.length === 0) continue;
    const gridMap: Record<string, TileGrid> = {};
    let maxCol = 0;
    for (const id of ids) {
      const m = groupMembers[id];
      const grid: TileGrid = {
        col: Math.max(0, m.col),
        row: Math.max(GRID_START_ROW, Math.min(m.row, metrics.rows - m.h)),
        w: m.w,
        h: m.h,
      };
      gridMap[id] = grid;
      maxCol = Math.max(maxCol, grid.col + grid.w);
      bandOf[id] = g.id;
    }
    bands.push({ id: g.id, name: g.name, x: 0, width: 0, maxCol, ids, gridMap, editable: true });
  }

  // 2) 未分组带：墙内可见 agents − 所有组内成员 + widgets（widget 不再固定进系统带，可自由排布）
  //    所有未分组 tile 均从 groupMembers 中获取（g=UNGROUPED_BAND_ID），不再使用全局 tiles map
  const groupedIds = new Set(Object.keys(bandOf));
  const ungroupedIds = [
    ...agents.filter((a) => !groupedIds.has(a.id)).map((a) => a.id),
    ...widgets.filter((w) => groupMembers[w.id]?.g === UNGROUPED_BAND_ID).map((w) => w.id),
  ];
  if (ungroupedIds.length > 0) {
    const gridMap: Record<string, TileGrid> = {};
    let maxCol = 0;
    for (const id of ungroupedIds) {
      const m = groupMembers[id];
      const grid: TileGrid = m
        ? {
            col: Math.max(0, m.col),
            row: Math.max(GRID_START_ROW, Math.min(m.row, metrics.rows - m.h)),
            w: m.w,
            h: m.h,
          }
        : { col: 0, row: GRID_START_ROW, w: 1, h: 1 };
      gridMap[id] = grid;
      maxCol = Math.max(maxCol, grid.col + grid.w);
      bandOf[id] = UNGROUPED_BAND_ID;
    }
    bands.push({ id: UNGROUPED_BAND_ID, name: "未分组", x: 0, width: 0, maxCol, ids: ungroupedIds, gridMap });
  }

  // 3) 系统带：browser 磁贴（最右，不参与成组）
  const sysIds = browsers.map((b) => b.id);
  if (sysIds.length > 0) {
    const gridMap: Record<string, TileGrid> = {};
    let maxCol = 0;
    for (const b of browsers) {
      const grid = browserTiles[b.id] ?? { col: 0, row: GRID_START_ROW, w: 1, h: 1 };
      gridMap[b.id] = grid;
      maxCol = Math.max(maxCol, grid.col + grid.w);
      bandOf[b.id] = SYSTEM_BAND_ID;
    }
    bands.push({ id: SYSTEM_BAND_ID, name: "系统", x: 0, width: 0, maxCol, ids: sysIds, gridMap, isSystem: true });
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
