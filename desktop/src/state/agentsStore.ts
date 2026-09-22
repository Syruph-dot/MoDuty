import { useMemo } from "react";
import { create } from "zustand";

import { listAgents } from "../lib/api";
import { createAgent as apiCreateAgent, deleteAgent as apiDeleteAgent, renameAgent as apiRenameAgent } from "../lib/api";
import { DEFAULT_FILTERS, deriveVisibleAgents, type AgentFilters, type GroupByKey, type ViewMode } from "../lib/agentFilter";
import { spawnXToCol } from "../lib/persistTiles";
import { useTileStore } from "./tileStore";
import type { Agent, AgentState, AgentStateEvent } from "../types";
import { useWindowManagerStore } from "./windowManagerStore";

/* ════════════════════════════════════════════════════════════════
 * agentsStore（v3 重构后）：
 * - 只管 agent 业务数据（后端列表、SSE 状态事件、打开集合）与「墙治理偏好」
 * - 磁贴几何与组属 → tileStore（单一事实源），本 store 不再保存/双写
 * ════════════════════════════════════════════════════════════════ */

/** 遇到本地不认识的 agent 事件时，节流拉一次列表（1.5s 合并多次事件） */
let unknownAgentReloadTimer: ReturnType<typeof setTimeout> | null = null;
function scheduleUnknownAgentReload(): void {
  if (unknownAgentReloadTimer) return;
  unknownAgentReloadTimer = setTimeout(() => {
    unknownAgentReloadTimer = null;
    void useAgentsStore.getState().load();
  }, 1500);
}

/** 磁贴墙治理偏好（A+B+D）持久化 key：UI 本地状态，与后端无关 */
const MGMT_STORAGE_KEY = "momoka:tiles:mgmt-v1";

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
  /** 可选：直接指定归属组（绕过默认未分组带） */
  groupId?: string;
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
  /** 删除时同步清理治理状态（清理归档/钉住引用） */
  purgeMgmtForAgent: (id: string) => void;
}

/** 磁贴墙全局状态：agents + 实时事件应用（SSE 驱动）+ 墙治理（A+B+D)。几何/组属见 tileStore。 */
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

  async load() {
    set({ loading: true, error: null });
    try {
      const agents = await listAgents();
      const tiles = useTileStore.getState();
      const alive = new Set(agents.map((a) => a.id));
      // 新 agent 入座未分组带（各自找空位，不推挤）；已被删除的 agent 从其磁贴表清出（prune 只清 agent 类孤儿，
      // widget/browser 的存活判定由各自 store 对账，避免跨 store 误删）
      const agentTiles = Object.values(tiles.tiles).filter((t) => t.kind === "agent");
      for (const t of agentTiles) {
        if (!alive.has(t.id)) tiles.removeTile(t.id);
      }
      let colHint = 0;
      for (const agent of agents) {
        tiles.ensureTile(agent.id, "agent", { colHint: colHint++ });
      }
      set({ agents, loading: false });
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
      // 如果指定了 groupId，直接入组；否则走默认未分组带
      useTileStore.getState().ensureTile(agent.id, "agent", {
        colHint: spawnXToCol(input.spawn?.x),
        groupId: input.groupId,
      });
      set((state) => ({ agents: [agent, ...state.agents] }));
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
      useTileStore.getState().removeTile(id);
      set((state) => ({
        agents: state.agents.filter((agent) => agent.id !== id),
        openAgentIds: state.openAgentIds.filter((openId) => openId !== id),
        pinnedIds: state.pinnedIds.filter((pid) => pid !== id),
        archivedIds: state.archivedIds.filter((aid) => aid !== id),
      }));
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
      if (!target) {
        // 事件里的 agent 本地不认识（多半是后端刚建的）：防抖拉一次列表，让磁贴自己冒出来
        scheduleUnknownAgentReload();
        return {};
      }
      // 幂等短路
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
      // 空名字创建的 Agent：首条对话后后端自动命名，经状态广播回填到磁贴
      const nameChanged = typeof event.name === "string" && event.name.length > 0 && target.name !== event.name;
      if (stateUnchanged && !nameChanged) return {};
      // 关键修复：completed 态不自动回 idle —— 只有用户打开该磁贴（openAgentIds 包含）时才允许 completed→idle 迁移
      const isOpened = state.openAgentIds.includes(event.agent_id);
      if (target.state === "completed" && event.state === "idle" && !isOpened) {
        // 丢弃该事件，保持绿色完成态；但首条对话的自动命名仍需回填
        if (!nameChanged) return {};
        return {
          agents: state.agents.map((agent) =>
            agent.id === event.agent_id ? { ...agent, name: event.name as string, auto_name: false } : agent,
          ),
        };
      }
      return {
        agents: state.agents.map((agent) =>
          agent.id === event.agent_id
            ? {
                ...agent,
                ...(nameChanged ? { name: event.name as string, auto_name: false } : {}),
                state: event.state,
                phase: event.phase ?? null,
                ...(event.context_stats ? { context_stats: event.context_stats } : {}),
                last_active_at: new Date().toISOString(),
              }
            : agent,
        ),
      };
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
}));

/**
 * 统一可见集派生 hook（A 搜索/筛选 + D 活跃/归档两层；默认不传 now 用当前时间）。
 * 桌面墙（free/grouped）与归档面板共用，保证两边口径一致。
 */
/**
 * 确保某个 agent 在本地列表里（不在就拉一次最新列表）；返回是否可用。
 *
 * 动机：值日生 / 手机机器人在**后端**新建的 Agent 不会自动进前端列表，
 * 于是出现「磁贴不出、&tile_ chip 点了没反应」的静默失败——跳转前必须先确认真有这个人。
 * 放在 store 定义之外：写在 store 初始化器里会构成自引用，TS 会把整个 store 的类型判成 any。
 */
export async function ensureAgentInList(id: string): Promise<boolean> {
  const state = useAgentsStore.getState();
  if (state.agents.some((agent) => agent.id === id)) return true;
  await state.load(); // load 里会为新 agent 建磁贴
  return useAgentsStore.getState().agents.some((agent) => agent.id === id);
}

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
