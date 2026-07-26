import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";

export interface SessionRecord {
  id: string;
  name: string;
  goal: string;
  folderPath: string;
  createdAt: string;
  messageCount: number;
  lastMessageAt: string;
}

export interface SessionMessage {
  id: string;
  role: string;
  content: string;
  timestamp: string;
  [key: string]: unknown;
}

function shortId(prefix: string): string {
  return `${prefix}_${crypto.randomUUID().replace(/-/g, "").slice(0, 12)}`;
}

export class SessionManager {
  readonly sessionsDir: string;
  private readonly sessionsFile: string;

  constructor(memoryDir: string) {
    this.sessionsDir = path.join(memoryDir, ".sessions");
    this.sessionsFile = path.join(this.sessionsDir, "sessions.json");
  }

  async listSessions(): Promise<SessionRecord[]> {
    try {
      const parsed = JSON.parse(await readFile(this.sessionsFile, "utf8")) as unknown;
      return Array.isArray(parsed) ? parsed.map(sessionFromDisk) : [];
    } catch {
      return [];
    }
  }

  async createSession(goal: string, folderPath: string, sessionId?: string): Promise<SessionRecord> {
    await mkdir(this.sessionsDir, { recursive: true });
    const now = new Date().toISOString();
    const session: SessionRecord = {
      id: sessionId ?? shortId("ses"),
      name: goal.length > 50 ? `${goal.slice(0, 50)}…` : goal,
      goal,
      folderPath,
      createdAt: now,
      messageCount: 0,
      lastMessageAt: now,
    };
    const sessions = await this.listSessions();
    sessions.unshift(session);
    await this.writeSessions(sessions);
    await this.writeMessages(session.id, []);
    return session;
  }

  async getSession(sessionId: string): Promise<SessionRecord | null> {
    return (await this.listSessions()).find((session) => session.id === sessionId) ?? null;
  }

  async deleteSession(sessionId: string): Promise<boolean> {
    const sessions = await this.listSessions();
    const filtered = sessions.filter((session) => session.id !== sessionId);
    if (filtered.length === sessions.length) {
      return false;
    }
    await this.writeSessions(filtered);
    await rm(path.dirname(this.messagesPath(sessionId)), { recursive: true, force: true });
    return true;
  }

  async addMessage(sessionId: string, role: string, content: string, extra: Record<string, unknown> = {}): Promise<SessionMessage> {
    const messages = await this.getMessages(sessionId, null);
    const message: SessionMessage = {
      id: shortId("msg"),
      role,
      content,
      timestamp: new Date().toISOString(),
      ...extra,
    };
    messages.push(message);
    await this.writeMessages(sessionId, messages);
    await this.updateSession(sessionId, {
      messageCount: messages.length,
      lastMessageAt: message.timestamp,
    });
    return message;
  }

  async getMessages(sessionId: string, limit: number | null = 200): Promise<SessionMessage[]> {
    try {
      const parsed = JSON.parse(await readFile(this.messagesPath(sessionId), "utf8")) as unknown;
      const messages = Array.isArray(parsed) ? parsed.filter((item): item is SessionMessage => typeof item === "object" && item !== null && !Array.isArray(item)) : [];
      return limit === null ? messages : messages.slice(-limit);
    } catch {
      return [];
    }
  }

  private async updateSession(sessionId: string, updates: Partial<SessionRecord>): Promise<void> {
    const sessions = await this.listSessions();
    const updated = sessions.map((session) => session.id === sessionId ? { ...session, ...updates } : session);
    await this.writeSessions(updated);
  }

  private messagesPath(sessionId: string): string {
    return path.join(this.sessionsDir, sessionId, "messages.json");
  }

  private async writeMessages(sessionId: string, messages: SessionMessage[]): Promise<void> {
    const filePath = this.messagesPath(sessionId);
    await mkdir(path.dirname(filePath), { recursive: true });
    await writeFile(filePath, `${JSON.stringify(messages.map(messageToDisk), null, 2)}\n`, "utf8");
  }

  private async writeSessions(sessions: SessionRecord[]): Promise<void> {
    await mkdir(this.sessionsDir, { recursive: true });
    await writeFile(this.sessionsFile, `${JSON.stringify(sessions.map(sessionToDisk), null, 2)}\n`, "utf8");
  }
}

function sessionFromDisk(raw: Record<string, unknown>): SessionRecord {
  return {
    id: String(raw.id ?? ""),
    name: String(raw.name ?? ""),
    goal: String(raw.goal ?? ""),
    folderPath: String(raw.folder_path ?? raw.folderPath ?? ""),
    createdAt: String(raw.created_at ?? raw.createdAt ?? ""),
    messageCount: Number(raw.message_count ?? raw.messageCount ?? 0),
    lastMessageAt: String(raw.last_message_at ?? raw.lastMessageAt ?? ""),
  };
}

function sessionToDisk(session: SessionRecord): Record<string, unknown> {
  return {
    id: session.id,
    name: session.name,
    goal: session.goal,
    folder_path: session.folderPath,
    created_at: session.createdAt,
    message_count: session.messageCount,
    last_message_at: session.lastMessageAt,
  };
}

function messageToDisk(message: SessionMessage): Record<string, unknown> {
  const out: Record<string, unknown> = { ...message };
  if ("outputId" in out) {
    out.output_id = out.outputId;
    delete out.outputId;
  }
  if ("matchedSkills" in out) {
    out.matched_skills = out.matchedSkills;
    delete out.matchedSkills;
  }
  if ("toolCalls" in out) {
    out.tool_calls = out.toolCalls;
    delete out.toolCalls;
  }
  return out;
}
