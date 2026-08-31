import { create } from "zustand";

import { listAgents } from "../lib/api";
import { createAgent as apiCreateAgent, deleteAgent as apiDeleteAgent, renameAgent as apiRenameAgent } from "../lib/api";
import { firstFreeCell, insertTile } from "../lib/gridLayout";
import { loadAllTiles, removeTile, saveTile, spawnXToCol } from "../lib/persistTiles";
import type { Agent, AgentStateEvent, TileGrid } from "../types";
import { useWindowManagerStore } from "./windowManagerStore";

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
}

/** 把 agents 列表里没有 tiles 记录的逐个插入到网格空位（不落盘，等用户真正动过再写） */
function ensureDefaultTiles(agents: Agent[], stored: Record<string, TileGrid>): Record<string, TileGrid> {
  let next: Record<string, TileGrid> = { ...stored };
  let changed = false;
  let colHint = 0;
  for (const agent of agents) {
    if (!next[agent.id]) {
      next = insertTile(next, agent.id, colHint);
      colHint += 1;
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
  return changed ? next : stored;
}

/** 磁贴墙全局状态：agents + 实时事件应用（SSE 驱动）+ 磁贴几何 */
export const useAgentsStore = create<AgentsStore>()((set) => ({
  agents: [],
  tiles: {},
  openAgentIds: [],
  loading: false,
  error: null,

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
        return {
          agents: state.agents.filter((agent) => agent.id !== id),
          tiles: rest,
          openAgentIds: state.openAgentIds.filter((openId) => openId !== id),
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
}));
