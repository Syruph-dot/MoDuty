import { create } from "zustand";

import { listAgents } from "../lib/api";
import { createAgent as apiCreateAgent, deleteAgent as apiDeleteAgent } from "../lib/api";
import { DEFAULT_TILE_GEOMETRY, loadAllTiles, removeTile, saveTile } from "../lib/persistTiles";
import type { Agent, AgentStateEvent, TileGeometry } from "../types";

export interface CreateAgentInput {
  name: string;
  role: string;
  workspace_dir: string;
  model?: string;
}

interface AgentsStore {
  agents: Agent[];
  /** 磁贴几何：agent.id → 位置/尺寸；启动时从 localStorage 还原 */
  tiles: Record<string, TileGeometry>;
  loading: boolean;
  error: string | null;
  selectedAgentId: string | null;
  load: (base?: string) => Promise<void>;
  createAgent: (input: CreateAgentInput, base?: string) => Promise<Agent | null>;
  deleteAgent: (id: string, base?: string) => Promise<void>;
  selectAgent: (id: string | null) => void;
  applyAgentEvent: (event: AgentStateEvent) => void;
  /** 拖动中 / 任何 store 内同步（不落盘） */
  moveTile: (id: string, geometry: TileGeometry) => void;
  /** 拖动结束 / 第一次落盘（写 localStorage） */
  commitTile: (id: string, geometry: TileGeometry) => void;
  /** 重置某磁贴到默认位置 */
  resetTile: (id: string) => void;
}

/** 把 agents 列表里没有 tiles 记录的补成默认位置（不落盘，等用户真正动过再写） */
function ensureDefaultTiles(agents: Agent[], stored: Record<string, TileGeometry>): Record<string, TileGeometry> {
  const next: Record<string, TileGeometry> = { ...stored };
  let changed = false;
  for (const agent of agents) {
    if (!next[agent.id]) {
      next[agent.id] = { ...DEFAULT_TILE_GEOMETRY };
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
  loading: false,
  error: null,
  selectedAgentId: null,

  async load(base) {
    set({ loading: true, error: null });
    try {
      const [agents, storedTiles] = await Promise.all([
        listAgents(base),
        Promise.resolve(loadAllTiles()),
      ]);
      const tiles = ensureDefaultTiles(agents, storedTiles);
      set({ agents, tiles, loading: false });
    } catch (error) {
      set({ loading: false, error: error instanceof Error ? error.message : String(error) });
    }
  },

  async createAgent(input, base) {
    try {
      const agent = await apiCreateAgent(input, base);
      set((state) => {
        // 新 agent：自动给一个默认位置
        const tiles = state.tiles[agent.id]
          ? state.tiles
          : { ...state.tiles, [agent.id]: { ...DEFAULT_TILE_GEOMETRY } };
        return { agents: [agent, ...state.agents], tiles };
      });
      return agent;
    } catch (error) {
      set({ error: error instanceof Error ? error.message : String(error) });
      return null;
    }
  },

  async deleteAgent(id, base) {
    await apiDeleteAgent(id, base);
    set((state) => {
      const { [id]: _removed, ...rest } = state.tiles;
      return {
        agents: state.agents.filter((agent) => agent.id !== id),
        tiles: rest,
        selectedAgentId: state.selectedAgentId === id ? null : state.selectedAgentId,
      };
    });
    removeTile(id);
  },

  selectAgent(id) {
    set({ selectedAgentId: id });
  },

  applyAgentEvent(event) {
    set((state) => ({
      agents: state.agents.map((agent) =>
        agent.id === event.agent_id
          ? {
              ...agent,
              state: event.state,
              phase: event.phase ?? null,
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
    const next = { ...DEFAULT_TILE_GEOMETRY };
    set((state) => ({ tiles: { ...state.tiles, [id]: next } }));
    saveTile(id, next);
  },
}));
