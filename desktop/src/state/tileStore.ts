import { create } from "zustand";

import {
  clampGrid,
  compactGrid,
  displaceTiles,
  firstFree,
  isFree,
  rectsOverlap,
  resolveOverlaps,
  type TileGridMap,
} from "../lib/gridLayout";
import { loadAllTiles } from "../lib/persistTiles";
import {
  GRID_ROWS,
  SYSTEM_BAND_ID,
  UNGROUPED_BAND_ID,
  isTileGrid,
  type Tile,
  type TileGrid,
  type TileGroup,
  type TileKind,
} from "../types";

/**
 * 磁贴统一事实源（v3）：
 * - 每个磁贴一份记录 { id, kind, groupId, grid }：几何 + 组属 + 类型一体化
 * - 组带语义：groupId = 用户组 id / UNGROUPED_BAND_ID / SYSTEM_BAND_ID（browser）
 * - grid 一律是「带内局部坐标」（col/row 相对所属组带；带起始 X 由 bandLayout 派生）
 * - 单 key 持久化 localStorage；从 v2（geometry）+ groups-v1（组属）一次性迁移
 * - 不变量（每次 commit 后维护）：带内互不重叠；row ∈ [GRID_START_ROW, GRID_ROWS-h]；w,h ∈ TILE_SIZES
 */

const STORAGE_KEY_V3 = "momoka:tiles:v3";
/** 迁移前的旧存储（只读，用于一次性迁移；迁移后不删除，留作回滚兜底） */
const STORAGE_KEY_GROUPS_V1 = "momoka:tiles:groups-v1";

/* ────────────────────────── 持久化 ────────────────────────── */

interface StorageV3 {
  groups: TileGroup[];
  tiles: Record<string, Tile>;
}

/** 旧 groups-v1 存储形状（迁移用） */
interface LegacyGroupsStorage {
  groups: Array<{ id: string; name: string; order?: number }>;
  members: Record<string, { g: string; col: number; row: number; w: number; h: number }>;
}

/** 由 id 前缀推断类型（v2 的 key 规则：widget:* / browser:*，其余为 agent） */
function inferKind(id: string): TileKind | null {
  if (id.startsWith("widget:")) return "widget";
  if (id.startsWith("browser:")) return "browser";
  return "agent";
}

/** 规范化 groupId：非法引用收编回未分组 */
function normalizeGroupId(g: string | undefined, groups: TileGroup[], kind: TileKind): string {
  if (kind === "browser") return SYSTEM_BAND_ID;
  if (g === UNGROUPED_BAND_ID || !g) return UNGROUPED_BAND_ID;
  if (groups.some((grp) => grp.id === g)) return g;
  return UNGROUPED_BAND_ID;
}

function sanitizeTile(value: unknown, groups: TileGroup[]): Tile | null {
  if (!value || typeof value !== "object") return null;
  const raw = value as Record<string, unknown>;
  if (typeof raw.id !== "string" || !raw.id) return null;
  if (!isTileGrid(raw.grid)) return null;
  const kind: TileKind =
    raw.kind === "agent" || raw.kind === "widget" || raw.kind === "browser" ? raw.kind : (inferKind(raw.id) ?? "agent");
  const grid = clampGrid({ col: raw.grid.col, row: raw.grid.row, w: raw.grid.w, h: raw.grid.h }, GRID_ROWS);
  const groupId = normalizeGroupId(typeof raw.groupId === "string" ? raw.groupId : undefined, groups, kind);
  return { id: raw.id, kind, groupId, grid };
}

function loadV3(): StorageV3 | null {
  if (typeof localStorage === "undefined") return null;
  try {
    const raw = localStorage.getItem(STORAGE_KEY_V3);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as Partial<StorageV3>;
    const groups: TileGroup[] = Array.isArray(parsed.groups)
      ? parsed.groups
          .filter((g) => g && typeof g.id === "string" && typeof g.name === "string")
          .map((g, i) => ({ id: g.id, name: g.name, order: Number.isFinite(g.order) ? Number(g.order) : i }))
      : [];
    const tiles: Record<string, Tile> = {};
    if (parsed.tiles && typeof parsed.tiles === "object") {
      for (const [id, value] of Object.entries(parsed.tiles)) {
        const tile = sanitizeTile({ ...(value as object), id }, groups);
        if (tile) tiles[id] = tile;
      }
    }
    return { groups, tiles };
  } catch {
    return null;
  }
}

function loadLegacyGroups(): LegacyGroupsStorage {
  const fallback: LegacyGroupsStorage = { groups: [], members: {} };
  if (typeof localStorage === "undefined") return fallback;
  try {
    const raw = localStorage.getItem(STORAGE_KEY_GROUPS_V1);
    if (!raw) return fallback;
    const parsed = JSON.parse(raw) as Partial<LegacyGroupsStorage>;
    return {
      groups: Array.isArray(parsed.groups)
        ? parsed.groups.filter((g) => g && typeof g.id === "string" && typeof g.name === "string")
        : [],
      members: parsed.members && typeof parsed.members === "object" ? (parsed.members as LegacyGroupsStorage["members"]) : {},
    };
  } catch {
    return fallback;
  }
}

/**
 * 一次性迁移：v2 几何（loadAllTiles，含 widget 与 browser 前缀键）+ groups-v1 组属 → v3。
 * - v2 key 的 browser 前缀 id 归一为不带前缀的 id（与 browserStore 的内存 id 一致），kind=browser，进系统带
 * - widget 前缀与 agent 的 id 原样保留
 * - 组属优先取 groups-v1，几何优先取 groups-v1（成员记录含组内局部坐标），widget 无成员记录时取 v2
 */
function migrateToV3(): StorageV3 {
  const legacy = loadLegacyGroups();
  const v2 = loadAllTiles();
  const groups: TileGroup[] = legacy.groups.map((g, i) => ({ id: g.id, name: g.name, order: i }));
  const tiles: Record<string, Tile> = {};

  // 1) groups-v1 成员（携组属）
  for (const [id, m] of Object.entries(legacy.members)) {
    if (!m || !Number.isFinite(m.col) || !Number.isFinite(m.row)) continue;
    let kind = inferKind(id);
    let cleanId = id;
    if (id.startsWith("browser:")) {
      kind = "browser";
      cleanId = id.slice("browser:".length);
    }
    if (!kind) continue;
    const grid = clampGrid({ col: m.col, row: m.row, w: m.w || 1, h: m.h || 1 }, GRID_ROWS);
    const groupId = normalizeGroupId(m.g, groups, kind);
    tiles[cleanId] = { id: cleanId, kind, groupId, grid };
  }

  // 2) v2 几何（补齐没有成员记录的磁贴；widget 的权威几何在 v2）
  for (const [key, grid] of Object.entries(v2)) {
    let kind: TileKind;
    let id = key;
    if (key.startsWith("widget:")) {
      kind = "widget";
    } else if (key.startsWith("browser:")) {
      kind = "browser";
      id = key.slice("browser:".length);
    } else {
      kind = "agent";
    }
    if (tiles[id]) {
      // widget 的 v2 几何比陈旧成员记录更可信（旧代码 widget 拖动只写 v2）
      if (kind === "widget") {
        tiles[id] = { ...tiles[id], grid: clampGrid(grid, GRID_ROWS) };
      }
      continue;
    }
    if (!isTileGrid(grid)) continue;
    tiles[id] = {
      id,
      kind,
      groupId: normalizeGroupId(undefined, groups, kind),
      grid: clampGrid(grid, GRID_ROWS),
    };
  }

  return { groups, tiles };
}

function persist(state: { groups: TileGroup[]; tiles: Record<string, Tile> }): void {
  if (typeof localStorage === "undefined") return;
  try {
    localStorage.setItem(STORAGE_KEY_V3, JSON.stringify({ groups: state.groups, tiles: state.tiles }));
  } catch {
    /* 配额满 / 隐私模式：静默 */
  }
}

/* ────────────────────────── 内部工具 ────────────────────────── */

/** 某组（带）的局部 gridMap */
function bandGridMap(tiles: Record<string, Tile>, groupId: string): TileGridMap {
  const map: TileGridMap = {};
  for (const tile of Object.values(tiles)) {
    if (tile.groupId === groupId) map[tile.id] = tile.grid;
  }
  return map;
}

/** 组内首列左平移：第一列没有磁贴时整体左移直到第一列有磁贴（组内容紧凑） */
function compactGroup(tiles: Record<string, Tile>, groupId: string): void {
  const ids = Object.keys(tiles).filter((k) => tiles[k].groupId === groupId);
  if (ids.length === 0) return;
  const minCol = Math.min(...ids.map((k) => tiles[k].grid.col));
  if (minCol > 0) {
    for (const k of ids) {
      tiles[k] = { ...tiles[k], grid: { ...tiles[k].grid, col: tiles[k].grid.col - minCol } };
    }
  }
}

/** 组空自动解散并回收 order */
function dissolveEmptyGroup(state: { groups: TileGroup[]; tiles: Record<string, Tile> }, groupId: string): TileGroup[] {
  if (groupId === UNGROUPED_BAND_ID || groupId === SYSTEM_BAND_ID) return state.groups;
  const hasMember = Object.values(state.tiles).some((t) => t.groupId === groupId);
  if (hasMember) return state.groups;
  return state.groups.filter((g) => g.id !== groupId).map((g, i) => ({ ...g, order: i }));
}

/** 无重叠检查（dev 不变量）：发现残留重叠时 resolveOverlaps 兜底纠正 */
function enforceInvariant(tiles: Record<string, Tile>, groupId: string): Record<string, Tile> {
  const map = bandGridMap(tiles, groupId);
  const ids = Object.keys(map);
  let overlap = false;
  outer: for (let i = 0; i < ids.length; i += 1) {
    for (let j = i + 1; j < ids.length; j += 1) {
      if (rectsOverlap(map[ids[i]], map[ids[j]])) {
        overlap = true;
        break outer;
      }
    }
  }
  if (!overlap) return tiles;
  const resolved = resolveOverlaps(map);
  const next = { ...tiles };
  for (const [id, grid] of Object.entries(resolved)) {
    next[id] = { ...next[id], grid };
  }
  return next;
}

/* ────────────────────────── Store ────────────────────────── */

interface TileStore {
  tiles: Record<string, Tile>;
  groups: TileGroup[];
  /** 是否已从 localStorage 还原（启动时由 Desktop 初始化调用一次） */
  hydrated: boolean;

  hydrate: () => void;

  /** 确保磁贴存在（新建 agent/widget/browser 时调用）；缺位时在目标带首空位入座 */
  ensureTile: (id: string, kind: TileKind, opts?: { grid?: TileGrid; groupId?: string; colHint?: number }) => void;
  /** 移除磁贴（删 agent/widget/browser 时调用）；脏组自动解散 */
  removeTile: (id: string) => void;
  /** 已注册 tile 列表变更后的对账：清孤儿（如 widget 实例已不存在） */
  prune: (aliveIds: Set<string>) => void;

  /** 拖动中：仅更新内存 + ghost 预览，不落盘 */
  moveTile: (id: string, grid: TileGrid) => void;
  /** 拖动结束：落盘。不带组切换；clamped 到带内合法范围 */
  commitTile: (id: string, grid: TileGrid) => void;
  /** 灰框让位预览的最终定格：直接以预览结果为最终布局（预览即落盘，同一算法） */
  commitDisplaced: (map: TileGridMap) => void;

  /* 组操作 */
  createGroup: (ids: string[], name?: string) => string;
  joinGroup: (id: string, groupId: string) => void;
  leaveGroup: (id: string) => void;
  renameGroup: (groupId: string, name: string) => void;
  reorderGroups: (groupId: string, targetGroupId: string) => void;
  removeGroup: (groupId: string) => void;

  /**
   * 排斥落位：源放入目标组带的 (col,row,w,h)，被波及磁贴定格到 displaced 预览位置；
   * displaced 缺省时用 resolveOverlaps 兜底。最终无重叠、组属与坐标同步写入。
   */
  repelDropIntoGroup: (
    id: string,
    groupId: string,
    col: number,
    row: number,
    w: number,
    h: number,
    displaced?: TileGridMap,
  ) => void;
  repelDropToUngrouped: (id: string, col: number, row: number, w: number, h: number, displaced?: TileGridMap) => void;
}

const INITIAL = typeof localStorage !== "undefined" ? (loadV3() ?? migrateToV3()) : { groups: [], tiles: {} };

export const useTileStore = create<TileStore>()((set, get) => ({
  tiles: INITIAL.tiles,
  groups: INITIAL.groups,
  hydrated: false,

  hydrate() {
    // 模块加载时已同步迁移/读取；这里再读一次防御外部（多窗口）写入
    const fresh = loadV3() ?? migrateToV3();
    set({ tiles: fresh.tiles, groups: fresh.groups, hydrated: true });
  },

  ensureTile(id, kind, opts) {
    set((state) => {
      if (state.tiles[id]) return {};
      const groupId = opts?.groupId ?? (kind === "browser" ? SYSTEM_BAND_ID : UNGROUPED_BAND_ID);
      const w = opts?.grid?.w ?? 1;
      const h = opts?.grid?.h ?? 1;
      const map = bandGridMap(state.tiles, groupId);
      // opts.grid 为首选位：与现有磁贴碰撞时回落到首个空位（矩形感知）
      const preferred = opts?.grid ? clampGrid(opts.grid, GRID_ROWS) : null;
      const slot =
        preferred && isFree(map, preferred)
          ? { col: preferred.col, row: preferred.row }
          : firstFree(map, opts?.colHint ?? 0, w, h);
      const grid = clampGrid({ col: slot.col, row: slot.row, w, h }, GRID_ROWS);
      const tiles = { ...state.tiles, [id]: { id, kind, groupId, grid } };
      persist({ groups: state.groups, tiles });
      return { tiles };
    });
  },

  removeTile(id) {
    set((state) => {
      const tile = state.tiles[id];
      if (!tile) return {};
      const tiles = { ...state.tiles };
      delete tiles[id];
      const groups = dissolveEmptyGroup({ groups: state.groups, tiles }, tile.groupId);
      if (tile.groupId !== UNGROUPED_BAND_ID && tile.groupId !== SYSTEM_BAND_ID) compactGroup(tiles, tile.groupId);
      persist({ groups, tiles });
      return { tiles, groups };
    });
  },

  prune(aliveIds) {
    set((state) => {
      let changed = false;
      const tiles = { ...state.tiles };
      for (const id of Object.keys(tiles)) {
        if (!aliveIds.has(id)) {
          delete tiles[id];
          changed = true;
        }
      }
      if (!changed) return {};
      let groups = state.groups;
      // 空组解散
      for (const g of state.groups) {
        groups = dissolveEmptyGroup({ groups, tiles }, g.id);
      }
      persist({ groups, tiles });
      return { tiles, groups };
    });
  },

  moveTile(id, grid) {
    set((state) => {
      const tile = state.tiles[id];
      if (!tile) return {};
      return {
        tiles: {
          ...state.tiles,
          [id]: { ...tile, grid: { ...tile.grid, col: grid.col, row: grid.row, w: grid.w, h: grid.h } },
        },
      };
    });
  },

  commitTile(id, grid) {
    set((state) => {
      const tile = state.tiles[id];
      if (!tile) return {};
      const clamped = clampGrid(grid, GRID_ROWS);
      const tiles = { ...state.tiles, [id]: { ...tile, grid: clamped } };
      persist({ groups: state.groups, tiles });
      return { tiles };
    });
  },

  commitDisplaced(map) {
    set((state) => {
      let changed = false;
      const tiles = { ...state.tiles };
      for (const [id, grid] of Object.entries(map)) {
        const tile = tiles[id];
        if (!tile) continue;
        tiles[id] = { ...tile, grid: clampGrid(grid, GRID_ROWS) };
        changed = true;
      }
      if (!changed) return {};
      persist({ groups: state.groups, tiles });
      return { tiles };
    });
  },

  createGroup(ids, name) {
    const id = `grp_${Math.random().toString(16).slice(2, 10)}`;
    set((state) => {
      const group: TileGroup = {
        id,
        name: name ?? `组 ${state.groups.length + 1}`,
        order: state.groups.length,
      };
      const tiles = { ...state.tiles };
      const placed: TileGridMap = {};
      // 逐个矩形感知入座：与已放入者求 firstFree
      for (const tileId of ids) {
        const tile = tiles[tileId];
        if (!tile) continue;
        const slot = firstFree(placed, 0, tile.grid.w, tile.grid.h);
        const grid = { col: slot.col, row: slot.row, w: tile.grid.w, h: tile.grid.h };
        placed[tileId] = grid;
        tiles[tileId] = { ...tile, groupId: id, grid };
      }
      const groups = [...state.groups, group];
      persist({ groups, tiles });
      return { tiles, groups };
    });
    return id;
  },

  joinGroup(id, groupId) {
    set((state) => {
      const tile = state.tiles[id];
      if (!tile || !state.groups.some((g) => g.id === groupId)) return {};
      const tiles = { ...state.tiles };
      delete tiles[id];
      // 矩形感知：目标组内找可容纳 w×h 的首个空位
      const map = bandGridMap(tiles, groupId);
      const slot = firstFree(map, 0, tile.grid.w, tile.grid.h);
      tiles[id] = {
        ...tile,
        groupId,
        grid: { col: slot.col, row: slot.row, w: tile.grid.w, h: tile.grid.h },
      };
      let groups = state.groups;
      if (tile.groupId !== UNGROUPED_BAND_ID && tile.groupId !== SYSTEM_BAND_ID) {
        compactGroup(tiles, tile.groupId);
        groups = dissolveEmptyGroup({ groups, tiles }, tile.groupId);
      }
      persist({ groups, tiles });
      return { tiles, groups };
    });
  },

  leaveGroup(id) {
    set((state) => {
      const tile = state.tiles[id];
      if (!tile || tile.groupId === UNGROUPED_BAND_ID) return {};
      const tiles = { ...state.tiles };
      const oldGroup = tile.groupId;
      delete tiles[id];
      // 回未分组带：矩形感知找空位
      const map = bandGridMap(tiles, UNGROUPED_BAND_ID);
      const slot = firstFree(map, 0, tile.grid.w, tile.grid.h);
      tiles[id] = {
        ...tile,
        groupId: UNGROUPED_BAND_ID,
        grid: { col: slot.col, row: slot.row, w: tile.grid.w, h: tile.grid.h },
      };
      compactGroup(tiles, oldGroup);
      const groups = dissolveEmptyGroup({ groups: state.groups, tiles }, oldGroup);
      persist({ groups, tiles });
      return { tiles, groups };
    });
  },

  renameGroup(groupId, name) {
    set((state) => {
      const groups = state.groups.map((g) => (g.id === groupId ? { ...g, name } : g));
      persist({ groups, tiles: state.tiles });
      return { groups };
    });
  },

  reorderGroups(groupId, targetGroupId) {
    set((state) => {
      const sorted = [...state.groups].sort((a, b) => a.order - b.order);
      const from = sorted.findIndex((g) => g.id === groupId);
      const to = sorted.findIndex((g) => g.id === targetGroupId);
      if (from < 0 || to < 0 || from === to) return {};
      const next = [...sorted];
      const [moved] = next.splice(from, 1);
      next.splice(to, 0, moved);
      const groups = next.map((g, i) => ({ ...g, order: i }));
      persist({ groups, tiles: state.tiles });
      return { groups };
    });
  },

  removeGroup(groupId) {
    set((state) => {
      if (!state.groups.some((g) => g.id === groupId)) return {};
      const tiles = { ...state.tiles };
      const exMembers = Object.values(tiles).filter((t) => t.groupId === groupId);
      const map = bandGridMap(tiles, UNGROUPED_BAND_ID);
      for (const member of exMembers) {
        const slot = firstFree(map, 0, member.grid.w, member.grid.h);
        const grid = { col: slot.col, row: slot.row, w: member.grid.w, h: member.grid.h };
        map[member.id] = grid;
        tiles[member.id] = { ...member, groupId: UNGROUPED_BAND_ID, grid };
      }
      const groups = state.groups.filter((g) => g.id !== groupId).map((g, i) => ({ ...g, order: i }));
      persist({ groups, tiles });
      return { tiles, groups };
    });
  },

  repelDropIntoGroup(id, groupId, col, row, w, h, displaced) {
    set((state) => {
      const tile = state.tiles[id];
      if (!tile || !state.groups.some((g) => g.id === groupId)) return {};
      let tiles = { ...state.tiles };
      const oldGroup = tile.groupId;
      // 源先摘出，目标带定格
      delete tiles[id];
      const targetGrid = clampGrid({ col, row, w, h }, GRID_ROWS);
      tiles[id] = { ...tile, groupId, grid: targetGrid };
      // 波及者定格：预览有结果用预览（所见即所得）；否则 resolveOverlaps 兜底
      if (displaced && Object.keys(displaced).length > 0) {
        for (const [did, grid] of Object.entries(displaced)) {
          const target = tiles[did];
          if (!target || did === id) continue;
          if (target.groupId !== groupId) continue;
          tiles[did] = { ...target, grid: clampGrid(grid, GRID_ROWS) };
        }
      }
      tiles = enforceInvariant(tiles, groupId);
      let groups = state.groups;
      if (oldGroup !== UNGROUPED_BAND_ID && oldGroup !== SYSTEM_BAND_ID && oldGroup !== groupId) {
        compactGroup(tiles, oldGroup);
        groups = dissolveEmptyGroup({ groups, tiles }, oldGroup);
      }
      persist({ groups, tiles });
      return { tiles, groups };
    });
  },

  repelDropToUngrouped(id, col, row, w, h, displaced) {
    // 统一实现：等价于 repel 到未分组带
    const state = get();
    const tile = state.tiles[id];
    if (!tile) return;
    set((s) => {
      const cur = s.tiles[id];
      if (!cur) return {};
      let tiles = { ...s.tiles };
      const oldGroup = cur.groupId;
      delete tiles[id];
      tiles[id] = { ...cur, groupId: UNGROUPED_BAND_ID, grid: clampGrid({ col, row, w, h }, GRID_ROWS) };
      if (displaced && Object.keys(displaced).length > 0) {
        for (const [did, grid] of Object.entries(displaced)) {
          const target = tiles[did];
          if (!target || did === id) continue;
          if (target.groupId !== UNGROUPED_BAND_ID) continue;
          tiles[did] = { ...target, grid: clampGrid(grid, GRID_ROWS) };
        }
      }
      tiles = enforceInvariant(tiles, UNGROUPED_BAND_ID);
      let groups = s.groups;
      if (oldGroup !== UNGROUPED_BAND_ID && oldGroup !== SYSTEM_BAND_ID) {
        compactGroup(tiles, oldGroup);
        groups = dissolveEmptyGroup({ groups, tiles }, oldGroup);
      }
      persist({ groups, tiles });
      return { tiles, groups };
    });
  },
}));

/* ── 模块级查询助手（不订阅、无自引用） ── */

export function groupOfTile(id: string): TileGroup | null {
  const s = useTileStore.getState();
  const tile = s.tiles[id];
  if (!tile) return null;
  return s.groups.find((g) => g.id === tile.groupId) ?? null;
}

/** 组成员 id（按组内行列排序） */
export function groupTileIdsOf(groupId: string): string[] {
  const s = useTileStore.getState();
  return Object.values(s.tiles)
    .filter((t) => t.groupId === groupId)
    .sort((a, b) => a.grid.row - b.grid.row || a.grid.col - b.grid.col)
    .map((t) => t.id);
}

export { displaceTiles, bandGridMap, compactGrid };
