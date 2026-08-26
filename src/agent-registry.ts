import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { SessionManager } from "./session-manager.js";
import type { AgentPhase, AgentRecord, AgentState } from "./types.js";

export interface CreateAgentInput {
  name: string;
  role: string;
  workspaceDir: string;
  model?: string;
}

/** 新建 Agent 未提供系统提示词时使用的默认 system prompt（前端不再暴露该字段）。 */
const DEFAULT_SYSTEM_PROMPT =
  "你是一个有用的 AI 助手。请使用可用工具、逐步思考，并用用户所用的语言清晰、准确地帮助其完成任务。";

/** 未提供 workspace 时的默认根目录：每 Agent 一个以 agentId 命名的子目录。 */
const DEFAULT_WORKSPACE_ROOT = path.join(os.homedir(), ".momoka", "workspaces");

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
    const id = shortId("agt");
    // role（系统提示词）与 workspace 不再由调用方强制提供：空则补默认。
    const role = input.role.trim() || DEFAULT_SYSTEM_PROMPT;
    const workspaceDir = input.workspaceDir.trim() || path.join(DEFAULT_WORKSPACE_ROOT, id);

    // 1:1 绑定：自动创建 session（name → goal, workspaceDir → folderPath）
    await mkdir(workspaceDir, { recursive: true });
    const session = await this.sessions.createSession(name, workspaceDir);
    const now = new Date().toISOString();
    const record: AgentRecord = {
      id,
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

  async renameAgent(id: string, name: string): Promise<AgentRecord> {
    const trimmed = name.trim();
    if (!trimmed) throw new Error("Agent name cannot be empty");
    const agents = await this.listAgents();
    const index = agents.findIndex((candidate) => candidate.id === id);
    if (index === -1) throw new Error("Agent not found");
    const updated: AgentRecord = {
      ...agents[index],
      name: trimmed,
      lastActiveAt: new Date().toISOString(),
    };
    agents[index] = updated;
    await this.writeAgents(agents);
    return updated;
  }

  /**
   * 列出「孤儿 session」：磁盘上存在但没有 Agent 绑定它的 session。
   * 用来识别/清理旧 chat.html 时代残留的会话。
   */
  async listLegacySessions(): Promise<{ id: string; goal: string; folderPath: string; messageCount: number; lastMessageAt: string }[]> {
    const [agents, sessions] = await Promise.all([this.listAgents(), this.sessions.listSessions()]);
    const bound = new Set(agents.map((agent) => agent.sessionId));
    return sessions
      .filter((session) => !bound.has(session.id))
      .map((session) => ({
        id: session.id,
        goal: session.goal,
        folderPath: session.folderPath,
        messageCount: session.messageCount,
        lastMessageAt: session.lastMessageAt,
      }));
  }

  /**
   * 一次性删除所有孤儿 session（无 Agent 绑定）。返回删除数量。
   * 用来清掉旧 chat.html 时代的残留；调用方一般是在迁移/升级时一次性跑。
   */
  async cleanupLegacySessions(): Promise<number> {
    const legacy = await this.listLegacySessions();
    let removed = 0;
    for (const session of legacy) {
      const ok = await this.sessions.deleteSession(session.id).catch(() => false);
      if (ok) removed += 1;
    }
    return removed;
  }

  private async writeAgents(agents: AgentRecord[]): Promise<void> {
    await mkdir(path.dirname(this.registryFile), { recursive: true });
    // 原子写：先写临时文件再 rename，避免并发读方（多实例/中断）读到半截 JSON 而把注册表当成空列表。
    const tmp = `${this.registryFile}.${process.pid}.${Date.now()}.tmp`;
    const payload = `${JSON.stringify(agents.map(agentToDisk), null, 2)}\n`;
    await writeFile(tmp, payload, "utf8");
    await rename(tmp, this.registryFile);
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