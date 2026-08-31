import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";

import { atomicWrite, atomicWriteJson, withFileLock } from "./write-queue.js";

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
    return await withFileLock(this.sessionsFile, async () => {
      const sessions = await this.listSessions();
      sessions.unshift(session);
      await this.writeSessions(sessions);
      await this.writeMessages(session.id, []);
      return session;
    });
  }

  async getSession(sessionId: string): Promise<SessionRecord | null> {
    return (await this.listSessions()).find((session) => session.id === sessionId) ?? null;
  }

  async deleteSession(sessionId: string): Promise<boolean> {
    return await withFileLock(this.sessionsFile, async () => {
      const sessions = await this.listSessions();
      const filtered = sessions.filter((session) => session.id !== sessionId);
      if (filtered.length === sessions.length) {
        return false;
      }
      await this.writeSessions(filtered);
      await rm(path.dirname(this.messagesPath(sessionId)), { recursive: true, force: true });
      return true;
    });
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
    return await withFileLock(this.messagesPath(sessionId), async () => {
      const all = await this.getMessages(sessionId, null);
      all.push(message);
      await this.writeMessages(sessionId, all);
      await this.updateSession(sessionId, {
        messageCount: all.length,
        lastMessageAt: message.timestamp,
      });
      // 自包含明文 transcript 随消息增量重写，供 rg 检索与 read_session 区间读取。
      await this.regenerateTranscript(sessionId).catch(() => undefined);
      return message;
    });
  }

  // ===== 流式消息（agent 输出随 token 增量落盘；连接只是在线投影）=====
  // 防抖缓冲：避免每个 token 都全量读写一次磁盘。
  private readonly streamTimers = new Map<string, NodeJS.Timeout>();
  private readonly streamPending = new Map<string, { messageId: string; pending: string }>();

  /** 开始一条流式 agent 消息：先落盘空消息（status=streaming），返回消息 id */
  async beginStreamingMessage(sessionId: string): Promise<SessionMessage> {
    const message: SessionMessage = {
      id: shortId("msg"),
      role: "agent",
      content: "",
      timestamp: new Date().toISOString(),
      status: "streaming",
    };
    await withFileLock(this.messagesPath(sessionId), async () => {
      const messages = await this.getMessages(sessionId, null);
      messages.push(message);
      await this.writeMessages(sessionId, messages);
    });
    return message;
  }

  /** 增量追加流式内容（防抖合并写；调用方按 token 回调即可，无需关心频率） */
  appendStreamingMessage(sessionId: string, messageId: string, delta: string): void {
    const entry = this.streamPending.get(sessionId) ?? { messageId, pending: "" };
    entry.pending += delta;
    this.streamPending.set(sessionId, entry);
    if (this.streamTimers.has(sessionId)) {
      return;
    }
    const timer = setTimeout(() => {
      void this.flushStreamingBuffer(sessionId);
    }, 200);
    this.streamTimers.set(sessionId, timer);
  }

  private async flushStreamingBuffer(sessionId: string): Promise<void> {
    const timer = this.streamTimers.get(sessionId);
    if (timer) {
      clearTimeout(timer);
      this.streamTimers.delete(sessionId);
    }
    const entry = this.streamPending.get(sessionId);
    if (!entry) {
      return;
    }
    this.streamPending.delete(sessionId);
    if (!entry.pending) {
      return;
    }
    await withFileLock(this.messagesPath(sessionId), () =>
      this.flushStreamingBufferLocked(sessionId, entry.messageId, entry.pending),
    );
  }

  /** flush 的锁内实现（假定调用方已持有 messagesPath 锁） */
  private async flushStreamingBufferLocked(sessionId: string, messageId: string, pending: string): Promise<void> {
    const messages = await this.getMessages(sessionId, null);
    const message = messages.find((m) => m.id === messageId);
    if (!message) {
      return;
    }
    message.content += pending;
    await this.writeMessages(sessionId, messages);
  }

  /**
   * 流式消息增量补写（工具事件/时间线）：锁内读-改-写，不更新 count/transcript，
   * 避免高频全量重写。供 tool_start / tool_result / 文本段开始时的实时落盘。
   */
  async updateStreamingMessage(sessionId: string, messageId: string, patch: Record<string, unknown>): Promise<void> {
    await withFileLock(this.messagesPath(sessionId), async () => {
      const messages = await this.getMessages(sessionId, null);
      const message = messages.find((m) => m.id === messageId);
      if (!message) return;
      Object.assign(message, patch);
      await this.writeMessages(sessionId, messages);
    });
  }

  /** 收尾流式消息：落完整段、更新会话元数据与 transcript。status 默认 done，可传 stopped/error */
  async finishStreamingMessage(sessionId: string, messageId: string, extra: Record<string, unknown> = {}): Promise<void> {
    await this.flushStreamingBuffer(sessionId);
    await withFileLock(this.messagesPath(sessionId), async () => {
      const messages = await this.getMessages(sessionId, null);
      const message = messages.find((m) => m.id === messageId);
      if (!message) {
        return;
      }
      Object.assign(message, extra);
      message.status = (extra.status as string | undefined) ?? "done";
      await this.writeMessages(sessionId, messages);
      await this.updateSession(sessionId, {
        messageCount: messages.length,
        lastMessageAt: message.timestamp,
      });
      await this.regenerateTranscript(sessionId).catch(() => undefined);
    });
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

  // ---- 会话检索 / 检视 / 读取（Session-as-a-Resource）----

  transcriptPath(sessionId: string): string {
    return path.join(this.sessionsDir, sessionId, "transcript.md");
  }

  /** 回填缺失 transcript.md（存量会话迁移/懒生成用），返回新建数量。 */
  async ensureTranscripts(): Promise<number> {
    const sessions = await this.listSessions();
    let created = 0;
    for (const session of sessions) {
      try {
        await readFile(this.transcriptPath(session.id), "utf8");
      } catch {
        await this.regenerateTranscript(session.id);
        created += 1;
      }
    }
    return created;
  }

  /** 把 messages.json 重算为自包含明文 transcript.md（含工具调用与结果）。每次 addMessage 增量重写。 */
  async regenerateTranscript(sessionId: string): Promise<void> {
    const session = await this.getSession(sessionId);
    const messages = await this.getMessages(sessionId, null);
    const lines: string[] = [];
    lines.push(`# Session: ${session?.name ?? sessionId} (${sessionId})`);
    if (session) {
      lines.push(`goal: ${session.goal}`);
      lines.push(`created: ${session.createdAt}`);
      lines.push(`turns: ${messages.length}`);
    }
    lines.push("");
    messages.forEach((message, index) => {
      lines.push(`## Turn ${index + 1} · ${message.role} · ${message.timestamp}`);
      lines.push("");
      lines.push(message.content || "");
      for (const call of extractToolCalls(message)) {
        const result = call.result.length > 2000 ? `${call.result.slice(0, 2000)}…[截断]` : call.result;
        lines.push(`🔧 ${call.tool}(${call.args}) -> ${result}`);
      }
      lines.push("");
    });
    const filePath = this.transcriptPath(sessionId);
    await withFileLock(filePath, () => atomicWrite(filePath, lines.join("\n")));
  }

  /** 检视会话元数据（句柄层，不返回历史内容）。 */
  async inspectSession(sessionId: string): Promise<Record<string, unknown>> {
    const session = await this.getSession(sessionId);
    if (!session) throw new Error(`Unknown session: ${sessionId}`);
    const messages = await this.getMessages(sessionId, null);
    return {
      id: session.id,
      name: session.name,
      goal: session.goal,
      createdAt: session.createdAt,
      messageCount: session.messageCount,
      lastMessageAt: session.lastMessageAt,
      turnRange: [1, Math.max(1, messages.length)],
      topics: deriveTopics(session.goal),
      hasTranscript: true,
    };
  }

  /** 读取指定 turn 区间（1-based 闭区间）的明文切片。 */
  async readSessionTranscript(sessionId: string, from: number, to: number): Promise<string> {
    const session = await this.getSession(sessionId);
    if (!session) throw new Error(`Unknown session: ${sessionId}`);
    const messages = await this.getMessages(sessionId, null);
    const total = messages.length;
    let lo = Number.isFinite(from) && from > 0 ? Math.floor(from) : 1;
    let hi = Number.isFinite(to) && to > 0 ? Math.floor(to) : total;
    lo = Math.max(1, lo);
    hi = Math.min(total, hi);
    if (lo > hi) [lo, hi] = [hi, lo];
    const lines: string[] = [];
    for (let i = lo - 1; i < hi; i += 1) {
      const message = messages[i];
      lines.push(`## Turn ${i + 1} · ${message.role} · ${message.timestamp}`);
      lines.push("");
      lines.push(message.content || "");
      for (const call of extractToolCalls(message)) {
        const result = call.result.length > 2000 ? `${call.result.slice(0, 2000)}…[截断]` : call.result;
        lines.push(`🔧 ${call.tool}(${call.args}) -> ${result}`);
      }
      lines.push("");
    }
    return lines.join("\n");
  }

  /** 在 transcript.md 内做内容 grep（rg 侧）。id 省略则跨所有会话。 */
  async searchContentInSession(sessionId: string | undefined, query: string): Promise<Array<{ session: string; line: number; text: string }>> {
    const results: Array<{ session: string; line: number; text: string }> = [];
    const ids = sessionId ? [sessionId] : (await this.listSessions()).map((session) => session.id);
    const needle = query.toLowerCase();
    for (const id of ids) {
      let content = await readFile(this.transcriptPath(id), "utf8").catch(() => null);
      if (!content) {
        // 存量会话可能还没有 transcript：懒生成后再试一次
        await this.regenerateTranscript(id).catch(() => undefined);
        content = await readFile(this.transcriptPath(id), "utf8").catch(() => null);
      }
      if (!content) continue;
      content.split("\n").forEach((text, idx) => {
        if (text.toLowerCase().includes(needle)) {
          results.push({ session: id, line: idx + 1, text: text.slice(0, 300) });
        }
      });
    }
    return results.slice(0, 100);
  }

  /** 跨会话检索，按相关度排序（everything/rg 二分法的 rg 侧入口）。 */
  async searchSessions(query: string, limit = 20): Promise<Array<Record<string, unknown>>> {
    const sessions = await this.listSessions();
    if (!query.trim()) {
      return sessions.slice(0, limit).map((session) => this.toSearchHit(session, 0, [], ""));
    }
    const needle = query.toLowerCase();
    const hits: Array<Record<string, unknown>> = [];
    for (const session of sessions) {
      let score = 0;
      if (session.name.toLowerCase().includes(needle)) score += 5;
      if (session.goal.toLowerCase().includes(needle)) score += 3;
      const messages = await this.getMessages(session.id, null);
      const turnRanges: Array<[number, number]> = [];
      let rangeStart = -1;
      let snippet = "";
      messages.forEach((message, index) => {
        const hay = `${message.content ?? ""} ${JSON.stringify(extractToolCalls(message))}`.toLowerCase();
        const hit = hay.includes(needle);
        if (hit) {
          score += 1;
          if (!snippet) snippet = (message.content ?? "").slice(0, 160);
          if (rangeStart === -1) rangeStart = index + 1;
        } else if (rangeStart !== -1) {
          turnRanges.push([rangeStart, index]);
          rangeStart = -1;
        }
      });
      if (rangeStart !== -1) turnRanges.push([rangeStart, messages.length]);
      if (score > 0) hits.push(this.toSearchHit(session, score, turnRanges, snippet));
    }
    hits.sort((a, b) => Number(b.score) - Number(a.score));
    return hits.slice(0, limit);
  }

  private toSearchHit(session: SessionRecord, score: number, matchedTurns: Array<[number, number]>, snippet: string): Record<string, unknown> {
    return {
      id: session.id,
      name: session.name,
      score,
      matchedTurns,
      snippet,
      message_count: session.messageCount,
      last_message_at: session.lastMessageAt,
    };
  }

  private async updateSession(sessionId: string, updates: Partial<SessionRecord>): Promise<void> {
    await withFileLock(this.sessionsFile, async () => {
      const sessions = await this.listSessions();
      const updated = sessions.map((session) => session.id === sessionId ? { ...session, ...updates } : session);
      await this.writeSessions(updated);
    });
  }

  private messagesPath(sessionId: string): string {
    return path.join(this.sessionsDir, sessionId, "messages.json");
  }

  private async writeMessages(sessionId: string, messages: SessionMessage[]): Promise<void> {
    const filePath = this.messagesPath(sessionId);
    await atomicWriteJson(filePath, messages.map(messageToDisk));
  }

  private async writeSessions(sessions: SessionRecord[]): Promise<void> {
    await atomicWriteJson(this.sessionsFile, sessions.map(sessionToDisk));
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

/** 从消息里抽工具调用；兼容内存态(toolCalls)与落盘态(tool_calls)。 */
function extractToolCalls(message: SessionMessage): Array<{ tool: string; args: string; result: string }> {
  const record = message as Record<string, unknown>;
  const raw = record.toolCalls ?? record.tool_calls;
  if (!Array.isArray(raw)) return [];
  return raw.map((item) => {
    const entry = item as Record<string, unknown>;
    return {
      tool: String(entry.tool ?? entry.name ?? ""),
      args: String(entry.args ?? entry.arguments ?? "{}"),
      result: String(entry.result ?? entry.output ?? ""),
    };
  });
}

/** 从 goal 里粗略抽关键词作为 topic 提示（仅用于 inspect 展示）。 */
function deriveTopics(goal: string): string[] {
  if (!goal) return [];
  const cleaned = goal.replace(/[，。、；：！？,.!?;:\s]+/gu, " ").trim();
  return cleaned.split(" ").filter(Boolean).slice(0, 5);
}
