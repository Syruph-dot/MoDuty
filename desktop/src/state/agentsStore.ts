import { useMemo } from "react";
import { create } from "zustand";

import { listAgents } from "../lib/api";
import { createAgent as apiCreateAgent, deleteAgent as apiDeleteAgent, renameAgent as apiRenameAgent } from "../lib/api";
import { DEFAULT_FILTERS, deriveVisibleAgents, type AgentFilters, type GroupByKey, type ViewMode } from "../lib/agentFilter";
import { firstFreeCell, compactGrid, resolveOverlaps } from "../lib/gridLayout";
import { loadAllTiles, removeTile, saveTile, spawnXToCol } from "../lib/persistTiles";
import type { Agent, AgentState, AgentStateEvent, TileGrid } from "../types";
import { GRID_ROWS, GRID_START_ROW } from "../types";
import { useWindowManagerStore } from "./windowManagerStore";
import { UNGROUPED_BAND_ID } from "../lib/bandLayout";

/** 一次性存量压缩标记：v3 迁移时全局紧凑 */
import { useWidgetStore } from "./widgetStore";

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

/** 磁贴局部网格：col/row 相对所属组带（组带 x 由渲染层计算），宽高沿用瓦片尺寸。
 *  g 为 UNGROUPED_BAND_ID 时表示未分组磁贴（取代旧的全局 state.tiles）。 */
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
    // 排序后存 order 连续的组列表，成员只含有效组引用（含 UNGROUPED_BAND_ID）
    const sorted = [...groups].sort((a, b) => a.order - b.order).map((g, i) => ({ ...g, order: i }));
    const validIds = new Set([...sorted.map((g) => g.id), UNGROUPED_BAND_ID]);
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

/** 迁移旧版本的 state.tiles 数据到 groupMembers（g=UNGROUPED_BAND_ID） */
function migrateOldTiles(storedTiles: Record<string, TileGrid>, members: Record<string, GroupMemberTile>): Record<string, GroupMemberTile> {
  const next: Record<string, GroupMemberTile> = { ...members };
  for (const [id, grid] of Object.entries(storedTiles)) {
    // 如果已经在用户组中，不覆盖
    if (next[id] && next[id].g !== UNGROUPED_BAND_ID) continue;
    next[id] = { g: UNGROUPED_BAND_ID, col: grid.col, row: grid.row, w: grid.w, h: grid.h };
  }
  return next;
}

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

/** 读取当前 store 的治理偏好（用于持久化时合并） */
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

const INITIAL_MGMT = loadMgmtPrefs();

export interface CreateAgentInput {
  name: string;
  workspace_dir?: string;
  model?: string;
  /** 打开新建菜单时光标相对磁贴墙的 X 像素；新磁贴插入到鼠标 X 轴列 */
  spawn?: { x: number; y: number };
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

interface AgentsStore {
  agents: Agent[];
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
  /** 拖动中 / 任何 store 内同步（不落盘）：更新 groupMembers 中的 grid */
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

/** 组内成员是否为 widget（广义 Tile：agent 或 widget 都可入组） */
function isWidgetId(id: string): boolean {
  return useWidgetStore.getState().widgets.some((w) => w.id === id);
}

/** widget 的未分组带坐标（widget.grid）；非 widget 返回 null */
function widgetGridOf(id: string): TileGrid | null {
  const w = useWidgetStore.getState().widgets.find((x) => x.id === id);
  return w?.grid ?? null;
}

/** 未分组带落盘：widget 写回 widgetStore.grid，agent 写回 localStorage */
function persistUngroupedGrid(id: string, grid: TileGrid): void {
  if (isWidgetId(id)) {
    useWidgetStore.getState().commitWidget(id, grid);
  } else {
    saveTile(id, grid);
  }
}

/** 磁贴墙全局状态：agents + 实时事件应用（SSE 驱动）+ 磁贴几何 + 墙治理（A+B+D) */
export const useAgentsStore = create<AgentsStore>()((set) => ({
  agents: [],
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
      const [agents, storedTiles, storedMembers] = await Promise.all([
        listAgents(),
        Promise.resolve(loadAllTiles()),
        Promise.resolve(INITIAL_GROUPS.members),
      ]);
      // 迁移旧的 tiles 数据到 groupMembers (g=UNGROUPED_BAND_ID)
      const members = migrateOldTiles(storedTiles, storedMembers);
      // 确保新增 agents 都有记录
      const allIds = new Set([...agents.map((a) => a.id), ...Object.keys(members)]);
      for (const agent of agents) {
        if (!members[agent.id]) {
          const slot = firstFreeCell(
            Object.fromEntries(Object.entries(members).filter(([, m]) => m.g === UNGROUPED_BAND_ID).map(([id, m]) => [id, { col: m.col, row: m.row, w: m.w, h: m.h }])),
            0,
          );
          members[agent.id] = { g: UNGROUPED_BAND_ID, col: slot.col, row: slot.row, w: 1, h: 1 };
        }
      }
      // 清理已删除 agent 的记录
      for (const id of Object.keys(members)) {
        if (!allIds.has(id) && members[id]?.g === UNGROUPED_BAND_ID) {
          delete members[id];
        }
      }
      // 一次性存量压缩
      try {
        if (typeof localStorage !== "undefined" && !localStorage.getItem(COMPACT_V3_MARKER)) {
          // 对未分组带的成员做列优先紧凑
          const ungroupedMap: Record<string, TileGrid> = {};
          for (const [id, m] of Object.entries(members)) {
            if (m.g === UNGROUPED_BAND_ID) ungroupedMap[id] = { col: m.col, row: m.row, w: m.w, h: m.h };
          }
          const packed = compactGrid(ungroupedMap);
          for (const [id, g] of Object.entries(packed)) {
            members[id] = { ...members[id], ...g };
          }
          localStorage.setItem(COMPACT_V3_MARKER, "1");
        }
      } catch {}
      persistGroupsStorage([], members);
      set({ agents, groupMembers: members, loading: false });
    } catch (error) {
      set({ loading: false, error: error instanceof Error ? error.message : String(error) });
    }
  },

  async createAgent(input) {
    try {
      const agent = await apiCreateAgent({
        name: input.name,
        ...(input.workspace_dir ? { workspace_dir: input.workspace_dir } : {}),
        ...(input.model ? { model: input.model } : {}),
      });
      set((state) => {
        const members = { ...state.groupMembers };
        if (!members[agent.id]) {
          // 新 agent：插入到鼠标 X 轴列的空位
          const colHint = spawnXToCol(input.spawn?.x);
          const ungroupedMap: Record<string, TileGrid> = {};
          for (const [id, m] of Object.entries(members)) {
            if (m.g === UNGROUPED_BAND_ID) ungroupedMap[id] = { col: m.col, row: m.row, w: m.w, h: m.h };
          }
          const slot = firstFreeCell(ungroupedMap, colHint);
          members[agent.id] = { g: UNGROUPED_BAND_ID, col: slot.col, row: slot.row, w: 1, h: 1 };
        }
        return { agents: [agent, ...state.agents], groupMembers: members };
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
      const message = error instanceof Error ? error.message : String(error);
      set({ error: `重命名 Agent 失败: ${message}` });
      throw error;
    }
  },

  async deleteAgent(id) {
    try {
      await apiDeleteAgent(id);
      set((state) => {
        const { [id]: _removed, ...members } = state.groupMembers;
        return {
          agents: state.agents.filter((agent) => agent.id !== id),
          groupMembers: members,
          openAgentIds: state.openAgentIds.filter((openId) => openId !== id),
          pinnedIds: state.pinnedIds.filter((pid) => pid !== id),
          archivedIds: state.archivedIds.filter((aid) => aid !== id),
        };
      });
      removeTile(id);
    } catch (error) {
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
    set((state) => {
      const target = state.agents.find((agent) => agent.id === event.agent_id);
      if (!target) return {};
      // 幂等短路：事件未带来任何可见变化（SSE 重复推送 / 轮询降级全量回放）时，
      // 不新建 agents 数组 —— 下游 useVisibleAgents / bandLayout / 全墙 Tile 重渲染全部随之跳过
      const prevStats = target.context_stats;
      const nextStats = event.context_stats;
      const statsUnchanged =
        !nextStats ||
        (!!prevStats &&
          prevStats.prompt_tokens === nextStats.prompt_tokens &&
          prevStats.cached_tokens === nextStats.cached_tokens &&
          prevStats.context_window === nextStats.context_window);
      const stateUnchanged =
        target.state === event.state &&
        (target.phase ?? null) === (event.phase ?? null) &&
        statsUnchanged;
      if (stateUnchanged) return {};
      return {
        agents: state.agents.map((agent) =>
          agent.id === event.agent_id
            ? {
                ...agent,
                state: event.state,
                phase: event.phase ?? null,
                ...(event.context_stats ? { context_stats: event.context_stats } : {}),
                // last_active_at 仅在真实变化时更新，避免无条件时间戳导致排序抖动
                last_active_at: new Date().toISOString(),
              }
            : agent,
        ),
      };
    });
  },

  moveTile(id, grid) {
    set((state) => {
      const m = state.groupMembers[id];
      if (!m) return {};
      return {
        groupMembers: {
          ...state.groupMembers,
          [id]: { ...m, col: grid.col, row: grid.row, w: grid.w, h: grid.h },
        },
      };
    });
  },

  commitTile(id, grid) {
    set((state) => {
      const m = state.groupMembers[id];
      if (!m) return {};
      const next = { ...m, col: grid.col, row: grid.row, w: grid.w, h: grid.h };
      if (m.g === UNGROUPED_BAND_ID && !isWidgetId(id)) {
        saveTile(id, { col: grid.col, row: grid.row, w: grid.w, h: grid.h });
      }
      return {
        groupMembers: { ...state.groupMembers, [id]: next },
      };
    });
  },

  resetTile(id) {
    set((state) => {
      const ungroupedMap: Record<string, TileGrid> = {};
      for (const [tid, m] of Object.entries(state.groupMembers)) {
        if (m.g === UNGROUPED_BAND_ID) ungroupedMap[tid] = { col: m.col, row: m.row, w: m.w, h: m.h };
      }
      const slot = firstFreeCell(ungroupedMap, 0);
      const members = {
        ...state.groupMembers,
        [id]: { ...state.groupMembers[id], col: slot.col, row: slot.row, w: 1, h: 1 },
      };
      const m = members[id];
      if (m?.g === UNGROUPED_BAND_ID && !isWidgetId(id)) {
        saveTile(id, { col: slot.col, row: slot.row, w: 1, h: 1 });
      }
      return { groupMembers: members };
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
      let col = 0;
      let row = GRID_START_ROW;
      for (const aid of agentIds) {
        // 已入其它组：沿用旧组内宽高；未分组：沿用 groupMembers 中的坐标
        const old = members[aid] ?? (isWidgetId(aid) ? widgetGridOf(aid) : null);
        const w = old?.w ?? 1;
        const h = old?.h ?? 1;
        members[aid] = { g: id, col, row, w, h };
        row += h;
        if (row > GRID_ROWS - 1) {
          row = GRID_START_ROW;
          col += 1;
        }
      }
      persistGroupsStorage([...groups, group], members);
      return { groups: [...groups, group], groupMembers: members };
    });
    return id;
  },

  joinGroup(agentId, groupId) {
    set((state) => {
      const members: Record<string, GroupMemberTile> = { ...state.groupMembers };
      const cur = members[agentId];
      delete members[agentId]; // 先删除，重新插入
      const groupIds = Object.keys(members).filter((k) => members[k].g === groupId);
      const used = new Set(groupIds.map((k) => `${members[k].col},${members[k].row}`));
      const prev = cur ?? (isWidgetId(agentId) ? widgetGridOf(agentId) : null);
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
      compactGroupMembers(members, groupId);
      persistGroupsStorage(state.groups, members);
      return { groupMembers: members };
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
      // 回未分组带：在现有未分组带中找空位（保证最终布局无重复）
      const ungroupedMap: Record<string, TileGrid> = {};
      for (const [id, m] of Object.entries(members)) {
        if (m.g === UNGROUPED_BAND_ID) ungroupedMap[id] = { col: m.col, row: m.row, w: m.w, h: m.h };
      }
      const slot = firstFreeCell(ungroupedMap, 0);
      members[agentId] = { g: UNGROUPED_BAND_ID, col: slot.col, row: slot.row, w: cur.w, h: cur.h };
      persistUngroupedGrid(agentId, { col: slot.col, row: slot.row, w: cur.w, h: cur.h });
      persistGroupsStorage(groups, members);
      return { groups, groupMembers: members };
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
      // 先删除源，重新插入到目标组
      delete members[agentId];
      // 组内局部 map → resolveOverlaps 挤开波及磁贴
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
      return { groupMembers: members };
    });
  },

  repelDropToUngrouped(agentId, col, row, w, h) {
    set((state) => {
      const members: Record<string, GroupMemberTile> = { ...state.groupMembers };
      const cur = members[agentId];
      // 旧组若因此清空 → 解散
      delete members[agentId];
      let groups = state.groups;
      if (cur && cur.g !== UNGROUPED_BAND_ID) {
        const remaining = Object.keys(members).some((k) => members[k].g === cur.g);
        if (remaining) {
          compactGroupMembers(members, cur.g);
        } else {
          groups = groups.filter((g) => g.id !== cur.g).map((g, i) => ({ ...g, order: i }));
        }
      }
      // 源落到目标位置 → 未分组带 resolveOverlaps
      const ungroupedMap: Record<string, TileGrid> = {};
      for (const [id, m] of Object.entries(members)) {
        if (m.g === UNGROUPED_BAND_ID) ungroupedMap[id] = { col: m.col, row: m.row, w: m.w, h: m.h };
      }
      // widget 也加入 resolveOverlaps 的障碍集
      for (const w of useWidgetStore.getState().widgets) {
        if (!ungroupedMap[w.id]) ungroupedMap[w.id] = w.grid;
      }
      delete ungroupedMap[agentId];
      ungroupedMap[agentId] = { col: Math.max(0, col), row: Math.max(GRID_START_ROW, Math.min(row, GRID_ROWS - (h ?? 1))), w: w ?? 1, h: h ?? 1 };
      const resolved = resolveOverlaps(ungroupedMap);
      // 回写 groupMembers 和 widgetStore
      for (const [aid, g] of Object.entries(resolved)) {
        const widgetDef = useWidgetStore.getState().widgets.find((x) => x.id === aid);
        if (widgetDef) {
          useWidgetStore.getState().commitWidget(aid, g);
        } else {
          members[aid] = { g: UNGROUPED_BAND_ID, col: g.col, row: g.row, w: g.w, h: g.h };
        }
      }
      persistGroupsStorage(groups, members);
      return { groups, groupMembers: members };
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
      const removed: Record<string, GroupMemberTile> = {};
      for (const [aid, m] of Object.entries(state.groupMembers)) {
        if (m.g === groupId) {
          removed[aid] = m;
        } else {
          members[aid] = m;
        }
      }
      // 解散的成员回未分组带：逐个找空位
      const ungroupedMap: Record<string, TileGrid> = {};
      for (const [id, m] of Object.entries(members)) {
        if (m.g === UNGROUPED_BAND_ID) ungroupedMap[id] = { col: m.col, row: m.row, w: m.w, h: m.h };
      }
      for (const [aid, m] of Object.entries(removed)) {
        const slot = firstFreeCell(ungroupedMap, 0);
        members[aid] = { g: UNGROUPED_BAND_ID, col: slot.col, row: slot.row, w: m.w, h: m.h };
        persistUngroupedGrid(aid, { col: slot.col, row: slot.row, w: m.w, h: m.h });
      }
      persistGroupsStorage(groups, members);
      return { groups, groupMembers: members };
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
