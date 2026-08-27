// Arona Chest 前后端共享数据形状（与后端 snake_case 对齐）

export type AgentState = "idle" | "running" | "waiting_approval" | "completed" | "error";
export type AgentPhase = "planning" | "searching" | "reading" | "executing" | "verifying";

/** 磁贴在桌面上的几何（绝对定位），持久化到 localStorage */
export interface TileGeometry {
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface SessionSummary {
  goal: string;
  folder_path: string;
  message_count: number;
  last_message_at: string;
}

/** 上下文占用指标（后端 contextStats 的 snake 化，磁贴第二页数据） */
export interface ContextStats {
  prompt_tokens: number;
  context_window: number;
  cached_tokens: number | null;
  updated_at: string;
}

export interface Agent {
  id: string;
  name: string;
  role: string;
  model?: string;
  workspace_dir: string;
  session_id: string;
  state: AgentState;
  phase: AgentPhase | null;
  context_stats?: ContextStats | null;
  created_at: string;
  last_active_at: string;
  session: SessionSummary | null;
}

export interface AgentStateEvent {
  type: "agent_state";
  agent_id: string;
  state: AgentState;
  phase?: AgentPhase;
  context_stats?: ContextStats | null;
}