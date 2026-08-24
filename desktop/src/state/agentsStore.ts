import { create } from "zustand";

import { listAgents, listSessions } from "../lib/api";
import { createAgent as apiCreateAgent, deleteAgent as apiDeleteAgent } from "../lib/api";
import type { Agent, AgentStateEvent, SessionRecord } from "../types";

export interface CreateAgentInput {
  name: string;
  role: string;
  workspace_dir: string;
  model?: string;
}

interface AgentsStore {
  agents: Agent[];
  sessions: SessionRecord[];
  loading: boolean;
  error: string | null;
  selectedAgentId: string | null;
  load: (base?: string) => Promise<void>;
  createAgent: (input: CreateAgentInput, base?: string) => Promise<Agent | null>;
  deleteAgent: (id: string, base?: string) => Promise<void>;
  selectAgent: (id: string | null) => void;
  applyAgentEvent: (event: AgentStateEvent) => void;
}

/** 磁贴墙全局状态：agents/sessions + 实时事件应用（SSE 驱动） */
export const useAgentsStore = create<AgentsStore>()((set) => ({
  agents: [],
  sessions: [],
  loading: false,
  error: null,
  selectedAgentId: null,

  async load(base) {
    set({ loading: true, error: null });
    try {
      const [agents, sessions] = await Promise.all([listAgents(base), listSessions(base)]);
      set({ agents, sessions, loading: false });
    } catch (error) {
      set({ loading: false, error: error instanceof Error ? error.message : String(error) });
    }
  },

  async createAgent(input, base) {
    try {
      const agent = await apiCreateAgent(input, base);
      set((state) => ({ agents: [agent, ...state.agents] }));
      return agent;
    } catch (error) {
      set({ error: error instanceof Error ? error.message : String(error) });
      return null;
    }
  },

  async deleteAgent(id, base) {
    await apiDeleteAgent(id, base);
    set((state) => ({
      agents: state.agents.filter((agent) => agent.id !== id),
      selectedAgentId: state.selectedAgentId === id ? null : state.selectedAgentId,
    }));
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
}));