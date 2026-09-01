import { useMemo } from "react";
import { create } from "zustand";

import { listAgents } from "../lib/api";
import { createAgent as apiCreateAgent, deleteAgent as apiDeleteAgent, renameAgent as apiRenameAgent } from "../lib/api";
import { DEFAULT_FILTERS, deriveVisibleAgents, type AgentFilters, type GroupByKey, type ViewMode } from "../lib/agentFilter";
import { firstFreeCell, insertTile, compactGrid, resolveOverlaps } from "../lib/gridLayout";
import { loadAllTiles, removeTile, saveTile, saveAllTiles, spawnXToCol } from "../lib/persistTiles";
import type { Agent, AgentState, AgentStateEvent, TileGrid } from "../types";
import { GRID_ROWS, GRID_START_ROW } from "../types";
import { useWindowManagerStore } from "./windowManagerStore";

/** 一次性存量压缩标记：首次把横向无限延伸的 agent 磁贴重排为列优先后置位 */
import { useWidgetStore } from "./widgetStore";

const PACK_COLUMN_FIRST_MARKER = "momoka:tiles:packed-colfirst-v2";
const COMPACT_V3_MARKER = "momoka:tiles:compacted-v3";

/** 磁贴墙治理偏好（A+B+D）持久化 key：UI 本地状态，与后端无关 */
const MGMT_STORAGE_KEY = "momoka:tiles:mgmt-v1";

/** 手动画组（拖拽成组）持久化 key：UI 本地状态，与后端无关 */
const GROUPS_STORAGE_KEY = "momoka:tiles:groups-v1";

/* ── 手动画组（拖拽成组）：数据模型 ── */

export interface TileGroup {
  id: string;
  name: string;
  /** 组带在 X 轴的排列顺序（0 = 最左）；解散/重建时自动重排 */
  order: number;
}

/** 组内成员局部网格：col/row 相对本组带（组带 x 由渲染层计算），宽高沿用全局瓦片尺寸 */
export interface GroupMemberTile {
  g: string;
  col: number;
  row: number;
  w: number;
  h: number;
}

interface GroupsStorage {
  groups: TileGroup[];
  members: Record<string, GroupMemberTile>;
}

function loadGroupsStorage(): GroupsStorage {
  const fallback: GroupsStorage = { groups: [], members: {} };
  if (typeof localStorage === "undefined") return fallback;
  try {
    const raw = localStorage.getItem(GROUPS_STORAGE_KEY);
    if (!raw) return fallback;
    const parsed = JSON.parse(raw) as Partial<GroupsStorage>;
    return {
      groups: Array.isArray(parsed.groups)
        ? parsed.groups.filter((g) => g && typeof g.id === "string" && typeof g.name === "string").map((g, i) => ({ id: g.id, name: g.name, order: Number.isFinite(g.order) ? g.order : i }))
        : [],
      members: parsed.members && typeof parsed.members === "object" ? parsed.members : {},
    };
  } catch {
    return fallback;
  }
}

function persistGroupsStorage(groups: TileGroup[], members: Record<string, GroupMemberTile>): void {
  if (typeof localStorage === "undefined") return;
  try {
    // 排序后存 order 连续的组列表，成员只含有效组引用
    const sorted = [...groups].sort((a, b) => a.order - b.order).map((g, i) => ({ ...g, order: i }));
    const validIds = new Set(sorted.map((g) => g.id));
    const clean: Record<string, GroupMemberTile> = {};
    for (const [agentId, m] of Object.entries(members)) {
      if (m && validIds.has(m.g)) clean[agentId] = m;
    }
    localStorage.setItem(GROUPS_STORAGE_KEY, JSON.stringify({ groups: sorted, members: clean }));
  } catch {
    /* 配额满 / 隐私模式：静默 */
  }
}

const INITIAL_GROUPS = loadGroupsStorage();

interface TileMgmtPrefs {
  filters: AgentFilters;
  viewMode: ViewMode;
  groupBy: GroupByKey;
  pinnedIds: string[];
  archivedIds: string[];
  archiveDays: number;
  collapsedWorkspaces: string[];
  activeWorkspace: string;
}

function loadMgmtPrefs(): TileMgmtPrefs {
  const fallback: TileMgmtPrefs = {
    filters: DEFAULT_FILTERS,
    viewMode: "free",
    groupBy: "pinyin",
    pinnedIds: [],
    archivedIds: [],
    archiveDays: 14,
    collapsedWorkspaces: [],
    activeWorkspace: "all",
  };
  if (typeof localStorage === "undefined") return fallback;
  try {
    const raw = localStorage.getItem(MGMT_STORAGE_KEY);
    if (!raw) return fallback;
    const parsed = JSON.parse(raw) as Partial<TileMgmtPrefs>;
    const groupBy: GroupByKey =
      parsed.groupBy === "name" || parsed.groupBy === "workspace" || parsed.groupBy === "state" || parsed.groupBy === "month"
        ? parsed.groupBy
        : "pinyin";
    return {
      filters: { ...DEFAULT_FILTERS, ...(parsed.filters ?? {}) },
      viewMode: parsed.viewMode === "grouped" ? "grouped" : "free",
      groupBy,
      pinnedIds: Array.isArray(parsed.pinnedIds) ? parsed.pinnedIds : [],
      archivedIds: Array.isArray(parsed.archivedIds) ? parsed.archivedIds : [],
      archiveDays: Number.isFinite(Number(parsed.archiveDays)) ? Number(parsed.archiveDays) : 14,
      collapsedWorkspaces: Array.isArray(parsed.collapsedWorkspaces) ? parsed.collapsedWorkspaces : [],
      activeWorkspace: typeof parsed.activeWorkspace === "string" ? parsed.activeWorkspace : "all",
    };
  } catch {
    return fallback;
  }
}

/** 把需要跨启动保持的字段写回 localStorage（面板开关等会话态不落盘） */
function persistMgmtPrefs(s: TileMgmtPrefs): void {
  if (typeof localStorage === "undefined") return;
  try {
    localStorage.setItem(MGMT_STORAGE_KEY, JSON.stringify(s));
  } catch {
    /* 配额满 / 隐私模式：静默，仅本次会话有效 */
  }
}

const INITIAL_MGMT = loadMgmtPrefs();

export interface CreateAgentInput {
  name: string;
  workspace_dir?: string;
  model?: string;
  /** 打开新建菜单时光标相对磁贴墙的 X 像素；新磁贴插入到鼠标 X 轴列 */
  spawn?: { x: number; y: number };
}

interface AgentsStore {
  agents: Agent[];
  /** 磁贴网格（idle 摆放）：agent.id → 网格坐标/尺寸；启动时从 localStorage 还原 */
  tiles: Record<string, TileGrid>;
  /** 已打开的磁贴 id（顺序 = 打开顺序）；打开态几何由布局引擎实时计算，不持久化 */
  openAgentIds: string[];
  loading: boolean;
  error: string | null;
  load: () => Promise<void>;
  createAgent: (input: CreateAgentInput) => Promise<Agent | null>;
  deleteAgent: (id: string) => Promise<void>;
  renameAgent: (id: string, name: string) => Promise<Agent>;
  /** 打开一个磁贴（幂等；加入打开集合，驱动布局进入 open 模式） */
  openAgent: (id: string) => void;
  /** 关闭一个磁贴（从打开集合移除；全部关闭即回到自由摆放） */
  closeAgent: (id: string) => void;
  applyAgentEvent: (event: AgentStateEvent) => void;
  /** 拖动中 / 任何 store 内同步（不落盘） */
  moveTile: (id: string, grid: TileGrid) => void;
  /** 拖动结束 / 第一次落盘（写 localStorage） */
  commitTile: (id: string, grid: TileGrid) => void;
  /** 重置某磁贴到默认位置 */
  resetTile: (id: string) => void;

  /* ── 磁贴墙治理（A+B+D）：状态 ── */
  filters: AgentFilters;
  viewMode: ViewMode;
  groupBy: GroupByKey;
  pinnedIds: string[];
  archivedIds: string[];
  archiveDays: number;
  collapsedWorkspaces: string[];
  activeWorkspace: string;
  /** 顶部治理栏（筛选面板）开关 */
  filterBarOpen: boolean;
  /** 归档库侧边面板开关 */
  archiveOpen: boolean;

  /* ── 拖拽成组（手动画组）：状态与动作 ── */
  groups: TileGroup[];
  groupMembers: Record<string, GroupMemberTile>;
  /** 把 agent 们组成一个新组（内部排入组内网格），返回新组 id；name 缺省取首个 agent 名 */
  createGroup: (agentIds: string[], name?: string) => string;
  /** 把 agent 加入既有组（放到组内首列空行；若已在其它组先移出） */
  joinGroup: (agentId: string, groupId: string) => void;
  /** 把 agent 移出所在组（回未分组区）；若组空则自动解散并回收顺序 */
  leaveGroup: (agentId: string) => void;
  /** 组内自由拖动的提交：更新局部网格（并做首列左平移，保证第一列有磁贴） */
  moveGroupMember: (agentId: string, col: number, row: number, w?: number, h?: number) => void;
  /** 排斥落位（拖拽 ≥1s）：源加入目标组，落在目标磁贴位置，目标组内 resolveOverlaps 挤开波及磁贴 → 最终无重叠 */
  repelDropIntoGroup: (agentId: string, groupId: string, col: number, row: number, w?: number, h?: number) => void;
  /** 排斥落位到未分组带：源先离开旧组（必要时解散），再落到目标位置并 resolveOverlaps 未分组带 */
  repelDropToUngrouped: (agentId: string, col: number, row: number, w?: number, h?: number) => void;
  renameGroup: (groupId: string, name: string) => void;
  /** 拖动组标题调整组间顺序：把 groupId 移到 targetGroupId 的位置 */
  reorderGroups: (groupId: string, targetGroupId: string) => void;
  /** 解散整个组：全部成员回未分组区 */
  removeGroup: (groupId: string) => void;

  /* ── 磁贴墙治理（A+B+D）：actions ── */
  setFilterQuery: (query: string) => void;
  toggleWorkspaceFilter: (ws: string) => void;
  setTimeRange: (range: AgentFilters["timeRange"]) => void;
  toggleStateFilter: (state: AgentState) => void;
  setSort: (sort: AgentFilters["sort"]) => void;
  clearFilters: () => void;
  toggleFilterBar: () => void;
  setViewMode: (mode: ViewMode) => void;
  toggleViewMode: () => void;
  setGroupBy: (mode: GroupByKey) => void;
  setActiveWorkspace: (ws: string) => void;
  toggleWorkspaceCollapse: (ws: string) => void;
  togglePin: (id: string) => void;
  toggleArchive: (id: string) => void;
  unarchiveAll: () => void;
  setArchiveDays: (days: number) => void;
  setArchiveOpen: (open: boolean) => void;
  /** 删除时同步清理治理状态（清理归档/钉住/折叠引用） */
  purgeMgmtForAgent: (id: string) => void;
}

/** 把 agents 列表里没有 tiles 记录的逐个插入到网格空位（不落盘，等用户真正动过再写） */
/** 组内成员是否为 widget（广义 Tile：agent 或 widget 都可入组） */
function isWidgetId(id: string): boolean {
  return useWidgetStore.getState().widgets.some((w) => w.id === id);
}

/** widget 的未分组带坐标（widget.grid）；非 widget 返回 null */
function widgetGridOf(id: string): TileGrid | null {
  const w = useWidgetStore.getState().widgets.find((x) => x.id === id);
  return w?.grid ?? null;
}

/** 未分组带落盘：widget 写回 widgetStore.grid，agent 写回 tiles */
function persistUngroupedGrid(id: string, grid: TileGrid): void {
  if (isWidgetId(id)) {
    useWidgetStore.getState().commitWidget(id, grid);
  } else {
    saveTile(id, grid);
  }
}

function ensureDefaultTiles(agents: Agent[], stored: Record<string, TileGrid>): Record<string, TileGrid> {
  let next: Record<string, TileGrid> = { ...stored };
  let changed = false;
  // 新增自动磁贴：固定从第 0 列起逐列自上而下找空位（列优先回填），
  // 替代旧的 colHint+=1（无限向右延伸、第一行拉长）
  for (const agent of agents) {
    if (!next[agent.id]) {
      next = insertTile(next, agent.id, 0);
      changed = true;
    }
  }
  // 清理已被删 agent 的悬挂条目
  for (const id of Object.keys(next)) {
    if (!agents.some((agent) => agent.id === id)) {
      delete next[id];
      changed = true;
    }
  }
  // 一次性存量压缩：把历史上横向无限延长的 agent 磁贴整体重排为列优先（仅首次，标记后不再动）
  let packed = false;
  try {
    if (typeof localStorage !== "undefined" && !localStorage.getItem(PACK_COLUMN_FIRST_MARKER)) {
      next = compactGrid(next);
      localStorage.setItem(PACK_COLUMN_FIRST_MARKER, "1");
      packed = true;
    }
    // v3 迁移（组带模型）：把未分组磁贴强制列优先整理一次并**写回**，消除历史重叠（未分组带从此无重复）
    if (typeof localStorage !== "undefined" && !localStorage.getItem(COMPACT_V3_MARKER)) {
      next = compactGrid(next);
      saveAllTiles(next);
      localStorage.setItem(COMPACT_V3_MARKER, "1");
      packed = true;
    }
  } catch {
    /* 无 localStorage（SSR/隐私模式）则跳过一次性压缩 */
  }
  return changed || packed ? next : stored;
}

function readMgmt(): TileMgmtPrefs {
  const s = useAgentsStore.getState();
  return {
    filters: s.filters,
    viewMode: s.viewMode,
    groupBy: s.groupBy,
    pinnedIds: s.pinnedIds,
    archivedIds: s.archivedIds,
    archiveDays: s.archiveDays,
    collapsedWorkspaces: s.collapsedWorkspaces,
    activeWorkspace: s.activeWorkspace,
  };
}

/** 组内首列左平移：如果该组第一列没有磁贴，整体左移直到第一列有磁贴（组内容紧凑） */
function compactGroupMembers(members: Record<string, GroupMemberTile>, groupId: string): void {
  const ids = Object.keys(members).filter((k) => members[k].g === groupId);
  if (ids.length === 0) return;
  const minCol = Math.min(...ids.map((k) => members[k].col));
  if (minCol > 0) {
    for (const k of ids) members[k] = { ...members[k], col: members[k].col - minCol };
  }
}

/** 磁贴墙全局状态：agents + 实时事件应用（SSE 驱动）+ 磁贴几何 + 墙治理（A+B+D） */
export const useAgentsStore = create<AgentsStore>()((set) => ({
  agents: [],
  tiles: {},
  openAgentIds: [],
  loading: false,
  error: null,

  filters: INITIAL_MGMT.filters,
  viewMode: INITIAL_MGMT.viewMode,
  groupBy: INITIAL_MGMT.groupBy,
  pinnedIds: INITIAL_MGMT.pinnedIds,
  archivedIds: INITIAL_MGMT.archivedIds,
  archiveDays: INITIAL_MGMT.archiveDays,
  collapsedWorkspaces: INITIAL_MGMT.collapsedWorkspaces,
  activeWorkspace: INITIAL_MGMT.activeWorkspace,
  filterBarOpen: false,
  archiveOpen: false,
  groups: INITIAL_GROUPS.groups,
  groupMembers: INITIAL_GROUPS.members,

  async load() {
    set({ loading: true, error: null });
    try {
      const [agents, storedTiles] = await Promise.all([
        listAgents(),
        Promise.resolve(loadAllTiles()),
      ]);
      const tiles = ensureDefaultTiles(agents, storedTiles);
      set({ agents, tiles, loading: false });
    } catch (error) {
      set({ loading: false, error: error instanceof Error ? error.message : String(error) });
    }
  },

  async createAgent(input) {
    try {
      // spawn 仅用于前端落位，不发给后端
      const agent = await apiCreateAgent({
        name: input.name,
        ...(input.workspace_dir ? { workspace_dir: input.workspace_dir } : {}),
        ...(input.model ? { model: input.model } : {}),
      });
      set((state) => {
        // 新 agent：插入到鼠标 X 轴列；若已有则保持既有位置
        const tiles = state.tiles[agent.id]
          ? state.tiles
          : insertTile(state.tiles, agent.id, spawnXToCol(input.spawn?.x));
        return { agents: [agent, ...state.agents], tiles };
      });
      return agent;
    } catch (error) {
      set({ error: error instanceof Error ? error.message : String(error) });
      return null;
    }
  },

  async renameAgent(id: string, name: string) {
    try {
      const updated = await apiRenameAgent(id, name);
      set((state) => ({
        agents: state.agents.map((agent) => (agent.id === id ? updated : agent)),
      }));
      return updated;
    } catch (error) {
      // 重命名失败时留给内联编辑态保持，错误由桌面顶部 tile-wall__error 展示
      const message = error instanceof Error ? error.message : String(error);
      set({ error: `重命名 Agent 失败: ${message}` });
      throw error;
    }
  },

  async deleteAgent(id) {
    try {
      await apiDeleteAgent(id);
      set((state) => {
        const { [id]: _removed, ...rest } = state.tiles;
        const { [id]: _member, ...membersRest } = state.groupMembers;
        return {
          agents: state.agents.filter((agent) => agent.id !== id),
          tiles: rest,
          groupMembers: membersRest,
          openAgentIds: state.openAgentIds.filter((openId) => openId !== id),
          pinnedIds: state.pinnedIds.filter((pid) => pid !== id),
          archivedIds: state.archivedIds.filter((aid) => aid !== id),
        };
      });
      removeTile(id);
    } catch (error) {
      // 删除失败（如后端未启动/网络错误）：写入 store.error，由桌面顶部 tile-wall__error 展示，
      // 避免确认框关闭后静默无反馈；同时继续抛出，防止调用方误以为已删除。
      const message = error instanceof Error ? error.message : String(error);
      set({ error: `删除 Agent 失败: ${message}` });
      throw error;
    }
  },

  openAgent(id) {
    useWindowManagerStore.getState().markOpened("agent", id);
    window.dispatchEvent(new CustomEvent("momoka:tile-opened"));
    set((state) => ({
      openAgentIds: state.openAgentIds.includes(id) ? state.openAgentIds : [...state.openAgentIds, id],
    }));
  },

  closeAgent(id) {
    set((state) => ({
      openAgentIds: state.openAgentIds.filter((openId) => openId !== id),
    }));
  },

  applyAgentEvent(event) {
    if (event.state === "completed") {
      useWindowManagerStore.getState().markCompleted("agent", event.agent_id);
    }
    set((state) => ({
      agents: state.agents.map((agent) =>
        agent.id === event.agent_id
          ? {
              ...agent,
              state: event.state,
              phase: event.phase ?? null,
              ...(event.context_stats ? { context_stats: event.context_stats } : {}),
              last_active_at: new Date().toISOString(),
            }
          : agent,
      ),
    }));
  },

  moveTile(id, geometry) {
    set((state) => ({ tiles: { ...state.tiles, [id]: geometry } }));
  },

  commitTile(id, geometry) {
    set((state) => ({ tiles: { ...state.tiles, [id]: geometry } }));
    saveTile(id, geometry);
  },

  resetTile(id) {
    set((state) => {
      // 重置到网格最左侧第一个空单格（1×1 默认尺寸）
      const slot = firstFreeCell(state.tiles, 0);
      const next = { ...state.tiles, [id]: { col: slot.col, row: slot.row, w: 1, h: 1 } };
      saveTile(id, next[id]);
      return { tiles: next };
    });
  },

  /* ── 磁贴墙治理（A+B+D）actions ── */

  setFilterQuery(query) {
    set((state) => {
      const filters = { ...state.filters, query };
      persistMgmtPrefs({ ...readMgmt(), filters });
      return { filters };
    });
  },

  toggleWorkspaceFilter(ws) {
    set((state) => {
      const workspaces = state.filters.workspaces.includes(ws)
        ? state.filters.workspaces.filter((w) => w !== ws)
        : [...state.filters.workspaces, ws];
      const filters = { ...state.filters, workspaces };
      persistMgmtPrefs({ ...readMgmt(), filters });
      return { filters };
    });
  },

  setTimeRange(timeRange) {
    set((state) => {
      const filters = { ...state.filters, timeRange };
      persistMgmtPrefs({ ...readMgmt(), filters });
      return { filters };
    });
  },

  toggleStateFilter(agentState) {
    set((state) => {
      const states = state.filters.states.includes(agentState)
        ? state.filters.states.filter((s) => s !== agentState)
        : [...state.filters.states, agentState];
      const filters = { ...state.filters, states };
      persistMgmtPrefs({ ...readMgmt(), filters });
      return { filters };
    });
  },

  setSort(sort) {
    set((state) => {
      const filters = { ...state.filters, sort };
      persistMgmtPrefs({ ...readMgmt(), filters });
      return { filters };
    });
  },

  clearFilters() {
    set(() => {
      const filters = { ...DEFAULT_FILTERS };
      persistMgmtPrefs({ ...readMgmt(), filters });
      return { filters };
    });
  },

  toggleFilterBar() {
    set((state) => ({ filterBarOpen: !state.filterBarOpen }));
  },

  setViewMode(viewMode) {
    set(() => {
      persistMgmtPrefs({ ...readMgmt(), viewMode });
      return { viewMode };
    });
  },

  setGroupBy(groupBy) {
    set(() => {
      persistMgmtPrefs({ ...readMgmt(), groupBy });
      return { groupBy, activeWorkspace: "all" };
    });
  },

  toggleViewMode() {
    const current = useAgentsStore.getState().viewMode;
    const next: ViewMode = current === "free" ? "grouped" : "free";
    // 切换视图时收起归档/筛选面板，避免遮挡
    set(() => {
      persistMgmtPrefs({ ...readMgmt(), viewMode: next });
      return { viewMode: next, archiveOpen: false, filterBarOpen: false };
    });
  },

  setActiveWorkspace(activeWorkspace) {
    set(() => {
      persistMgmtPrefs({ ...readMgmt(), activeWorkspace });
      return { activeWorkspace };
    });
  },

  toggleWorkspaceCollapse(ws) {
    set((state) => {
      const collapsedWorkspaces = state.collapsedWorkspaces.includes(ws)
        ? state.collapsedWorkspaces.filter((w) => w !== ws)
        : [...state.collapsedWorkspaces, ws];
      persistMgmtPrefs({ ...readMgmt(), collapsedWorkspaces });
      return { collapsedWorkspaces };
    });
  },

  togglePin(id) {
    set((state) => {
      const pinnedIds = state.pinnedIds.includes(id)
        ? state.pinnedIds.filter((pid) => pid !== id)
        : [...state.pinnedIds, id];
      persistMgmtPrefs({ ...readMgmt(), pinnedIds });
      return { pinnedIds };
    });
  },

  toggleArchive(id) {
    set((state) => {
      const archivedIds = state.archivedIds.includes(id)
        ? state.archivedIds.filter((aid) => aid !== id)
        : [...state.archivedIds, id];
      persistMgmtPrefs({ ...readMgmt(), archivedIds });
      return { archivedIds };
    });
  },

  unarchiveAll() {
    set(() => {
      persistMgmtPrefs({ ...readMgmt(), archivedIds: [] });
      return { archivedIds: [] };
    });
  },

  setArchiveDays(archiveDays) {
    set(() => {
      persistMgmtPrefs({ ...readMgmt(), archiveDays });
      return { archiveDays };
    });
  },

  setArchiveOpen(archiveOpen) {
    set({ archiveOpen });
  },

  purgeMgmtForAgent(id) {
    set((state) => ({
      pinnedIds: state.pinnedIds.filter((pid) => pid !== id),
      archivedIds: state.archivedIds.filter((aid) => aid !== id),
      collapsedWorkspaces: state.collapsedWorkspaces,
      filters: state.filters,
    }));
  },

  /* ── 拖拽成组（手动画组）actions ── */

  createGroup(agentIds, name) {
    const id = `grp_${Math.random().toString(16).slice(2, 10)}`;
    set((state) => {
      const groups = [...state.groups];
      const group: TileGroup = { id, name: name ?? state.agents.find((a) => a.id === agentIds[0])?.name ?? "新组", order: groups.length };
      const members: Record<string, GroupMemberTile> = { ...state.groupMembers };
      const tiles = { ...state.tiles };
      let col = 0;
      let row = GRID_START_ROW;
      for (const aid of agentIds) {
        // 已入其它组：沿用旧组内宽高；未分组：沿用未分组带宽高（widget → widget.grid）
        const old = members[aid] ?? tiles[aid] ?? widgetGridOf(aid);
        const w = old?.w ?? 1;
        const h = old?.h ?? 1;
        members[aid] = { g: id, col, row, w, h };
        delete tiles[aid]; // 移出未分组带（widget 的未分组坐标在其 store，成组后由 bandLayout 走组内）
        row += h;
        if (row > GRID_ROWS - 1) {
          row = GRID_START_ROW;
          col += 1;
        }
      }
      persistGroupsStorage([...groups, group], members);
      return { groups: [...groups, group], groupMembers: members, tiles };
    });
    return id;
  },

  joinGroup(agentId, groupId) {
    set((state) => {
      const members: Record<string, GroupMemberTile> = { ...state.groupMembers };
      const tiles = { ...state.tiles };
      delete members[agentId]; // 先移出旧组
      const groupIds = Object.keys(members).filter((k) => members[k].g === groupId);
      const used = new Set(groupIds.map((k) => `${members[k].col},${members[k].row}`));
      const prev = members[agentId] ?? tiles[agentId] ?? widgetGridOf(agentId);
      const w = prev?.w ?? 1;
      const h = prev?.h ?? 1;
      let col = 0;
      let row = GRID_START_ROW;
      while (used.has(`${col},${row}`)) {
        row += 1;
        if (row > GRID_ROWS - 1) {
          row = GRID_START_ROW;
          col += 1;
        }
      }
      members[agentId] = { g: groupId, col, row, w, h };
      delete tiles[agentId]; // 移出未分组带
      compactGroupMembers(members, groupId);
      persistGroupsStorage(state.groups, members);
      return { groupMembers: members, tiles };
    });
  },

  leaveGroup(agentId) {
    set((state) => {
      const cur = state.groupMembers[agentId];
      if (!cur) return {};
      const members: Record<string, GroupMemberTile> = { ...state.groupMembers };
      delete members[agentId];
      let groups = state.groups;
      const remaining = Object.keys(members).some((k) => members[k].g === cur.g);
      if (remaining) {
        compactGroupMembers(members, cur.g);
      } else {
        // 组空 → 解散并回收顺序
        groups = groups.filter((g) => g.id !== cur.g).map((g, i) => ({ ...g, order: i }));
      }
      // 回未分组带：在现有未分组网格中找空位（保证最终布局无重复）；widget 写回自身 store
      const tiles = { ...state.tiles };
      delete tiles[agentId];
      const slot = firstFreeCell(tiles, 0);
      const grid: TileGrid = { col: slot.col, row: slot.row, w: cur.w, h: cur.h };
      persistUngroupedGrid(agentId, grid);
      if (!isWidgetId(agentId)) tiles[agentId] = grid;
      persistGroupsStorage(groups, members);
      return { groups, groupMembers: members, tiles };
    });
  },

  moveGroupMember(agentId, col, row, w, h) {
    set((state) => {
      const cur = state.groupMembers[agentId];
      if (!cur) return {};
      const members: Record<string, GroupMemberTile> = { ...state.groupMembers };
      const clampedRow = Math.max(GRID_START_ROW, Math.min(row, GRID_ROWS - 1));
      members[agentId] = {
        ...cur,
        col: Math.max(0, col),
        row: clampedRow,
        w: w ?? cur.w,
        h: h ?? cur.h,
      };
      compactGroupMembers(members, cur.g);
      persistGroupsStorage(state.groups, members);
      return { groupMembers: members };
    });
  },

  renameGroup(groupId, name) {
    set((state) => {
      const groups = state.groups.map((g) => (g.id === groupId ? { ...g, name } : g));
      persistGroupsStorage(groups, state.groupMembers);
      return { groups };
    });
  },

  repelDropIntoGroup(agentId, groupId, col, row, w, h) {
    set((state) => {
      const members: Record<string, GroupMemberTile> = { ...state.groupMembers };
      const tiles = { ...state.tiles };
      delete members[agentId];
      delete tiles[agentId];
      // 组内局部 map（放入源到目标位置）→ resolveOverlaps 挤开波及磁贴
      const map: Record<string, TileGrid> = {};
      for (const [aid, m] of Object.entries(members)) {
        if (m.g === groupId) map[aid] = { col: m.col, row: m.row, w: m.w, h: m.h };
      }
      map[agentId] = { col: Math.max(0, col), row: Math.max(GRID_START_ROW, Math.min(row, GRID_ROWS - (h ?? 1))), w: w ?? 1, h: h ?? 1 };
      const resolved = resolveOverlaps(map);
      for (const [aid, g] of Object.entries(resolved)) {
        const prev = members[aid];
        members[aid] = { g: prev?.g ?? groupId, col: g.col, row: g.row, w: g.w, h: g.h };
      }
      compactGroupMembers(members, groupId);
      persistGroupsStorage(state.groups, members);
      return { groupMembers: members, tiles };
    });
  },

  repelDropToUngrouped(agentId, col, row, w, h) {
    set((state) => {
      const members: Record<string, GroupMemberTile> = { ...state.groupMembers };
      const tiles = { ...state.tiles };
      const cur = members[agentId];
      delete members[agentId];
      delete tiles[agentId];
      // 旧组若因此清空 → 解散并回收顺序
      let groups = state.groups;
      if (cur) {
        const remaining = Object.keys(members).some((k) => members[k].g === cur.g);
        if (remaining) {
          compactGroupMembers(members, cur.g);
        } else {
          groups = groups.filter((g) => g.id !== cur.g).map((g, i) => ({ ...g, order: i }));
        }
      }
      // 源落到目标位置 → 未分组带 resolveOverlaps（agent tiles + widget grid 一起，保证无重复）
      const ungroupedMap: Record<string, TileGrid> = { ...tiles };
      for (const w of useWidgetStore.getState().widgets) ungroupedMap[w.id] = w.grid;
      delete ungroupedMap[agentId];
      ungroupedMap[agentId] = { col: Math.max(0, col), row: Math.max(GRID_START_ROW, Math.min(row, GRID_ROWS - (h ?? 1))), w: w ?? 1, h: h ?? 1 };
      const resolved = resolveOverlaps(ungroupedMap);
      const nextTiles: Record<string, TileGrid> = {};
      for (const [aid, g] of Object.entries(resolved)) {
        if (useWidgetStore.getState().widgets.some((x) => x.id === aid)) {
          useWidgetStore.getState().commitWidget(aid, g);
        } else {
          nextTiles[aid] = g;
          saveTile(aid, g);
        }
      }
      persistGroupsStorage(groups, members);
      return { groups, groupMembers: members, tiles: nextTiles };
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
      persistGroupsStorage(groups, state.groupMembers);
      return { groups };
    });
  },

  removeGroup(groupId) {
    set((state) => {
      const groups = state.groups.filter((g) => g.id !== groupId).map((g, i) => ({ ...g, order: i }));
      const members: Record<string, GroupMemberTile> = {};
      const tiles = { ...state.tiles };
      for (const [aid, m] of Object.entries(state.groupMembers)) {
        if (m.g === groupId) {
          delete tiles[aid];
        } else {
          members[aid] = m;
        }
      }
      // 解散的成员回未分组带：逐个找空位（保证无重叠）；widget 写回自身 store
      for (const [aid, m] of Object.entries(state.groupMembers)) {
        if (m.g !== groupId) continue;
        const slot = firstFreeCell(tiles, 0);
        const grid: TileGrid = { col: slot.col, row: slot.row, w: m.w, h: m.h };
        persistUngroupedGrid(aid, grid);
        if (!isWidgetId(aid)) tiles[aid] = grid;
      }
      persistGroupsStorage(groups, members);
      return { groups, groupMembers: members, tiles };
    });
  },
}));

/** 某 agent 是否在组内（模块级函数，避免 store 对象自引用） */
export function groupOfAgent(agentId: string): TileGroup | null {
  const s = useAgentsStore.getState();
  const m = s.groupMembers[agentId];
  if (!m) return null;
  return s.groups.find((g) => g.id === m.g) ?? null;
}

/** 某组的成员 id 列表（按组内行列排序） */
export function groupAgentIdsOf(groupId: string): string[] {
  const s = useAgentsStore.getState();
  return Object.entries(s.groupMembers)
    .filter(([, m]) => m.g === groupId)
    .sort((a, b) => a[1].row - b[1].row || a[1].col - b[1].col)
    .map(([aid]) => aid);
}

/**
 * 统一可见集派生 hook（A 搜索/筛选 + D 活跃/归档两层；默认不传 now 用当前时间）。
 * 桌面墙（free/grouped）与归档面板共用，保证两边口径一致。
 */
export function useVisibleAgents() {
  const agents = useAgentsStore((state) => state.agents);
  const filters = useAgentsStore((state) => state.filters);
  const pinnedIds = useAgentsStore((state) => state.pinnedIds);
  const archivedIds = useAgentsStore((state) => state.archivedIds);
  const archiveDays = useAgentsStore((state) => state.archiveDays);
  return useMemo(
    () => deriveVisibleAgents(agents, filters, { pinnedIds, archivedIds, archiveDays }),
    [agents, filters, pinnedIds, archivedIds, archiveDays],
  );
}
