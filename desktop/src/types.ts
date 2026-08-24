// MOMOKA Agent Desktop 前后端共享数据形状（与后端 snake_case 对齐）

export type AgentState = "idle" | "running" | "waiting_approval" | "completed" | "error";
export type AgentPhase = "planning" | "searching" | "reading" | "executing" | "verifying";

export interface SessionSummary {
  goal: string;
  folder_path: string;
  message_count: number;
  last_message_at: string;
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
  created_at: string;
  last_active_at: string;
  session: SessionSummary | null;
}

export interface SessionRecord {
  id: string;
  name: string;
  goal: string;
  folder_path: string;
  created_at: string;
  message_count: number;
  last_message_at: string;
}

export interface AgentStateEvent {
  type: "agent_state";
  agent_id: string;
  state: AgentState;
  phase?: AgentPhase;
}