import { GRID_GAP, GRID_PADDING, clampGrid, compactGrid, findDropTarget, nearestSize } from "./gridLayout";
import { GRID_ROWS, GRID_START_ROW, isTileGrid, type TileGrid } from "../types";

const STORAGE_KEY = "momoka:tiles:v2";
const STORAGE_KEY_V1 = "momoka:tiles:v1";

/** 像素→插入列的参考单元宽（仅用于 store 层像素换算；渲染层 cell 可能随视口/zoom 变化） */
const DEFAULT_CELL_W = 160;

export const DEFAULT_TILE_GRID: TileGrid = { col: 0, row: 0, w: 1, h: 1 };

/** 把"鼠标相对磁贴墙的 X 像素"换算成插入列提示（colHint）。 */
export function spawnXToCol(x: number | undefined): number {
  if (x === undefined || !Number.isFinite(x)) return 0;
  return Math.max(0, Math.round((x - GRID_PADDING) / (DEFAULT_CELL_W + GRID_GAP)));
}

type TileGridMap = Record<string, TileGrid>;

/**
 * 磁贴网格持久化（localStorage v2）。
 * - 读：整个 map 一次返回；坏数据/缺字段条目被丢弃
 * - 写：单 key 增量写
 * - v1 → v2 迁移：旧像素几何近似成网格，尺寸量化到 TILE_SIZES 后全局紧凑
 */
export function loadAllTiles(): TileGridMap {
  if (typeof localStorage === "undefined") return {};
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw) {
      const parsed = JSON.parse(raw) as unknown;
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        return ensureReservedRowFree(sanitizeMap(parsed));
      }
    }
  } catch {
    // 坏数据 → 继续尝试 v1 迁移
  }
  return migrateFromV1();
}

export function saveTile(id: string, grid: TileGrid): void {
  if (typeof localStorage === "undefined") return;
  const all = loadAllTiles();
  all[id] = sanitizeGrid(grid) ?? DEFAULT_TILE_GRID;
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(all));
  } catch {
    // 配额满 / 隐私模式：静默失败，磁贴只在本次会话有效
  }
}

/** 批量写回整张 tiles 表（一次性迁移 / 全量整理后使用） */
export function saveAllTiles(map: TileGridMap): void {
  if (typeof localStorage === "undefined") return;
  const all: TileGridMap = {};
  for (const [id, grid] of Object.entries(map)) {
    const g = sanitizeGrid(grid);
    if (g) all[id] = g;
  }
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(all));
  } catch {
    // 静默失败
  }
}

export function removeTile(id: string): void {
  if (typeof localStorage === "undefined") return;
  const all = loadAllTiles();
  if (!(id in all)) return;
  delete all[id];
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(all));
  } catch {
    // 静默失败
  }
}

function sanitizeMap(raw: unknown): TileGridMap {
  const result: TileGridMap = {};
  for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
    const grid = sanitizeGrid(value);
    if (grid) result[key] = grid;
  }
  return result;
}

function sanitizeGrid(value: unknown): TileGrid | null {
  if (!isTileGrid(value)) return null;
  const raw = value as TileGrid;
  if (!Number.isFinite(raw.col) || !Number.isFinite(raw.row) || !Number.isFinite(raw.w) || !Number.isFinite(raw.h)) {
    return null;
  }
  const size = nearestSize(raw.w, raw.h, 0, 0);
  return clampGrid({ col: raw.col, row: raw.row, w: size.w, h: size.h }, GRID_ROWS);
}

/** 保存行（GRID_START_ROW 之上的第 0 行）不放置磁贴：存量 row<1 的磁贴下移到空位，避免与保留行冲突 */
function ensureReservedRowFree(map: TileGridMap): TileGridMap {
  const next: TileGridMap = { ...map };
  for (const [id, tg] of Object.entries(next)) {
    if (tg.row >= GRID_START_ROW) continue;
    const target = findDropTarget(next, id, tg.col, GRID_START_ROW, tg.w, tg.h);
    if (target) {
      next[id] = { ...tg, col: target.col, row: target.row };
    } else {
      // 找不到空位：至少移出保留行，放回行首（后续仍可能冲突，属极端场景）
      next[id] = { ...tg, row: GRID_START_ROW };
    }
  }
  return next;
}

/** v1（像素自由几何）→ v2（网格）一次性迁移；成功写回 v2 并清除 v1。 */
function migrateFromV1(): TileGridMap {
  if (typeof localStorage === "undefined") return {};
  let v1: unknown;
  try {
    const raw = localStorage.getItem(STORAGE_KEY_V1);
    if (!raw) return {};
    v1 = JSON.parse(raw);
  } catch {
    return {};
  }
  if (!v1 || typeof v1 !== "object" || Array.isArray(v1)) return {};
  const map: TileGridMap = {};
  for (const [key, value] of Object.entries(v1 as Record<string, unknown>)) {
    const geom = value as Record<string, unknown> | null;
    if (!geom || typeof geom !== "object") continue;
    const { x, y, w, h } = geom as Record<string, number>;
    if (![x, y, w, h].every((n) => typeof n === "number" && Number.isFinite(n))) continue;
    map[key] = clampGrid(
      {
        col: Math.max(0, Math.round((x - GRID_PADDING) / (DEFAULT_CELL_W + GRID_GAP))),
        row: Math.max(0, Math.round((y - GRID_PADDING) / (DEFAULT_CELL_W + GRID_GAP))),
        w: Math.max(1, Math.min(3, Math.round(w / (DEFAULT_CELL_W + GRID_GAP)))),
        h: Math.max(1, Math.min(3, Math.round(h / (DEFAULT_CELL_W + GRID_GAP)))),
      },
      GRID_ROWS,
    );
  }
  // 量化尺寸 + 全局紧凑，避免旧自由坐标重叠
  const migrated: TileGridMap = {};
  for (const [key, grid] of Object.entries(map)) {
    const size = nearestSize(grid.w, grid.h, 0, 0);
    migrated[key] = { col: grid.col, row: grid.row, w: size.w, h: size.h };
  }
  const packed = compactGrid(migrated);
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(packed));
    localStorage.removeItem(STORAGE_KEY_V1);
  } catch {
    // 写不回也不阻塞本次会话
  }
  return ensureReservedRowFree(packed);
}