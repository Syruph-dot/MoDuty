import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

import { SessionManager } from "./session-manager.js";
import type { AgentPhase, AgentRecord, AgentState } from "./types.js";

export interface CreateAgentInput {
  name: string;
  role: string;
  workspaceDir: string;
  model?: string;
}

function shortId(prefix: string): string {
  return `${prefix}_${crypto.randomUUID().replace(/-/g, "").slice(0, 12)}`;
}

/**
 * 多 Agent 注册表：1 Agent = 1 persona 档案 + 1:1 绑定的 session（上下文串）。
 * 创建 Agent 自动创建其专属 session；删除 Agent 连带删除该 session。
 * 记录 JSON 持久化（默认 memory/.agents/agents.json，可注入路径）。
 */
export class AgentRegistry {
  private readonly registryFile: string;

  constructor(
    private readonly memoryDir: string,
    private readonly sessions: SessionManager,
    registryFile?: string,
  ) {
    this.registryFile = registryFile ?? path.join(memoryDir, ".agents", "agents.json");
  }

  async listAgents(): Promise<AgentRecord[]> {
    try {
      const parsed = JSON.parse(await readFile(this.registryFile, "utf8")) as unknown;
      return Array.isArray(parsed) ? parsed.map(agentFromDisk) : [];
    } catch {
      return [];
    }
  }

  async createAgent(input: CreateAgentInput): Promise<AgentRecord> {
    const name = input.name.trim();
    if (!name) throw new Error("Agent name cannot be empty");
    const role = input.role.trim();
    if (!role) throw new Error("Agent role cannot be empty");
    const workspaceDir = input.workspaceDir.trim();
    if (!workspaceDir) throw new Error("Agent workspace_dir cannot be empty");

    // 1:1 绑定：自动创建 session（name → goal, workspaceDir → folderPath）
    const session = await this.sessions.createSession(name, workspaceDir);
    const now = new Date().toISOString();
    const record: AgentRecord = {
      id: shortId("agt"),
      name,
      role,
      ...(input.model?.trim() ? { model: input.model.trim() } : {}),
      workspaceDir,
      sessionId: session.id,
      state: "idle",
      createdAt: now,
      lastActiveAt: now,
    };
    const agents = await this.listAgents();
    agents.unshift(record);
    await this.writeAgents(agents);
    return record;
  }

  async getAgent(agentId: string): Promise<AgentRecord | null> {
    return (await this.listAgents()).find((agent) => agent.id === agentId) ?? null;
  }

  async deleteAgent(agentId: string): Promise<boolean> {
    const agents = await this.listAgents();
    const target = agents.find((agent) => agent.id === agentId);
    if (!target) {
      return false;
    }
    await this.writeAgents(agents.filter((agent) => agent.id !== agentId));
    await this.sessions.deleteSession(target.sessionId).catch(() => undefined);
    return true;
  }

  async updateAgentState(agentId: string, state: AgentState, phase?: AgentPhase): Promise<AgentRecord | null> {
    const agents = await this.listAgents();
    let updated: AgentRecord | null = null;
    const next = agents.map((agent) => {
      if (agent.id !== agentId) {
        return agent;
      }
      updated = { ...agent, state, phase, lastActiveAt: new Date().toISOString() };
      return updated;
    });
    if (!updated) {
      return null;
    }
    await this.writeAgents(next);
    return updated;
  }

  private async writeAgents(agents: AgentRecord[]): Promise<void> {
    await mkdir(path.dirname(this.registryFile), { recursive: true });
    await writeFile(this.registryFile, `${JSON.stringify(agents.map(agentToDisk), null, 2)}\n`, "utf8");
  }
}

function agentToDisk(agent: AgentRecord): Record<string, unknown> {
  return {
    id: agent.id,
    name: agent.name,
    role: agent.role,
    ...(agent.model ? { model: agent.model } : {}),
    workspaceDir: agent.workspaceDir,
    sessionId: agent.sessionId,
    state: agent.state,
    ...(agent.phase ? { phase: agent.phase } : {}),
    createdAt: agent.createdAt,
    lastActiveAt: agent.lastActiveAt,
  };
}

function agentFromDisk(value: unknown): AgentRecord {
  const raw = (typeof value === "object" && value !== null && !Array.isArray(value) ? value : {}) as Record<string, unknown>;
  return {
    id: String(raw.id ?? ""),
    name: String(raw.name ?? ""),
    role: String(raw.role ?? ""),
    ...(raw.model ? { model: String(raw.model) } : {}),
    workspaceDir: String(raw.workspaceDir ?? ""),
    sessionId: String(raw.sessionId ?? ""),
    state: (typeof raw.state === "string" ? raw.state : "idle") as AgentState,
    ...(raw.phase ? { phase: String(raw.phase) as AgentPhase } : {}),
    createdAt: String(raw.createdAt ?? ""),
    lastActiveAt: String(raw.lastActiveAt ?? ""),
  };
}