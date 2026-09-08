import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";

import { atomicWrite, atomicWriteJson, withFileLock } from "./write-queue.js";
import { refreshSessionGraph } from "./relation-graph.js";
import {
  type StoredMessage,
  type Turn,
  messageToDisk,
  messageFromDisk,
  buildTurns,
  turnsToTranscript,
  appendTurnToTranscript,
} from "./serialization.js";

export interface SessionRecord {
  id: string;
  name: string;
  goal: string;
  folderPath: string;
  createdAt: string;
  messageCount: number;
  lastMessageAt: string;
  /** 当前轮次号（下一个将创建的 turn index，从 1 开始） */
  turnIndex?: number;
  /** 最后完成的 turn id */
  lastCompletedTurnId?: string;
  /** 是否已归档（归档后不在主列表显示，但数据保留） */
  archived?: boolean;
  archivedAt?: string;
}

export interface SessionMessage {
  id: string;
  role: string;
  content: string;
  timestamp: string;
  [key: string]: unknown;
}

export interface StoredMessageCompatible extends SessionMessage {
  status?: "streaming" | "done" | "stopped" | "error";
  toolCalls?: Array<{ tool: string; args: string; result: string; status?: string }>;
  outputId?: string;
  matchedSkills?: string[];
  segments?: string[];
  timeline?: Array<"text" | number>;
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
      turnIndex: 1,
    };
    return await withFileLock(this.sessionsFile, async () => {
      const sessions = await this.listSessions();
      sessions.unshift(session);
      await this.writeSessions(sessions);
      await this.writeMessagesUpsert(session.id, []);
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

  /** 读取原始消息列表（内存态 StoredMessage） */
  async getStoredMessages(sessionId: string): Promise<StoredMessage[]> {
    try {
      const parsed = JSON.parse(await readFile(this.messagesPath(sessionId), "utf8")) as unknown;
      const messages = Array.isArray(parsed)
        ? (parsed as Array<Record<string, unknown>>).map(messageFromDisk)
        : [];
      return messages;
    } catch {
      return [];
    }
  }

  /** 对外暴露的消息列表（兼容旧 SessionMessage 格式） */
  async getMessages(sessionId: string, limit: number | null = 200): Promise<SessionMessage[]> {
    const messages = await this.getStoredMessages(sessionId);
    return limit === null ? messages : messages.slice(-limit);
  }

  /** 写入消息列表（幂等 upsert：同 id 只保留最新） */
  private async writeMessagesUpsert(sessionId: string, messages: StoredMessage[]): Promise<void> {
    // 去重：同 id 保留最后一个（通常是完成态覆盖 streaming 中间态）
    const seen = new Map<string, StoredMessage>();
    for (const msg of messages) {
      seen.set(msg.id, msg);
    }
    const deduped = Array.from(seen.values());
    const filePath = this.messagesPath(sessionId);
    await atomicWriteJson(filePath, deduped.map(messageToDisk));
    refreshSessionGraph(this.sessionsDir, sessionId, this);
  }

  /** 追加消息（非流式）：幂等 upsert + 更新会话元数据 + 增量 transcript */
  async addMessage(sessionId: string, role: string, content: string, extra: Record<string, unknown> = {}): Promise<StoredMessage> {
    const messages = await this.getStoredMessages(sessionId);
    const message: StoredMessage = {
      id: shortId("msg"),
      role: role as StoredMessage["role"],
      content,
      timestamp: new Date().toISOString(),
      ...extra,
    } as StoredMessage;
    messages.push(message);
    await withFileLock(this.messagesPath(sessionId), async () => {
      const all = await this.getStoredMessages(sessionId);
      all.push(message);
      await this.writeMessagesUpsert(sessionId, all);
      await this.updateSession(sessionId, {
        messageCount: all.length,
        lastMessageAt: message.timestamp,
      });
      // 增量 transcript：仅当该消息使某个 turn 完成时追加
      await this.maybeAppendTurnTranscript(sessionId).catch(() => undefined);
    });
    return message;
  }

  // ===== 流式消息（agent 输出随 token 增量落盘；连接只是在线投影）=====
  private readonly streamTimers = new Map<string, NodeJS.Timeout>();
  private readonly streamPending = new Map<string, { messageId: string; pending: string }>();

  /** 开始一条流式 agent 消息：先落盘空消息（status=streaming），返回消息 id */
  async beginStreamingMessage(sessionId: string): Promise<StoredMessage> {
    const message: StoredMessage = {
      id: shortId("msg"),
      role: "agent",
      content: "",
      timestamp: new Date().toISOString(),
      status: "streaming",
    };
    await withFileLock(this.messagesPath(sessionId), async () => {
      const messages = await this.getStoredMessages(sessionId);
      messages.push(message);
      await this.writeMessagesUpsert(sessionId, messages);
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
    if (!entry) return;
    this.streamPending.delete(sessionId);
    if (!entry.pending) return;
    await withFileLock(this.messagesPath(sessionId), () =>
      this.flushStreamingBufferLocked(sessionId, entry.messageId, entry.pending),
    );
  }

  /** flush 的锁内实现（假定调用方已持有 messagesPath 锁） */
  private async flushStreamingBufferLocked(sessionId: string, messageId: string, pending: string): Promise<void> {
    const messages = await this.getStoredMessages(sessionId);
    const message = messages.find((m) => m.id === messageId);
    if (!message) return;
    message.content += pending;
    await this.writeMessagesUpsert(sessionId, messages);
  }

  /**
   * 流式消息增量补写（工具事件/时间线）：锁内读-改-写，不更新 count/transcript，
   * 避免高频全量重写。供 tool_start / tool_result / 文本段开始时的实时落盘。
   */
  async updateStreamingMessage(sessionId: string, messageId: string, patch: Record<string, unknown>): Promise<void> {
    await withFileLock(this.messagesPath(sessionId), async () => {
      const messages = await this.getStoredMessages(sessionId);
      const message = messages.find((m) => m.id === messageId);
      if (!message) return;
      Object.assign(message, patch);
      await this.writeMessagesUpsert(sessionId, messages);
    });
  }

  /** 收尾流式消息：落完整段、更新会话元数据与 transcript。status 默认 done，可传 stopped/error */
  async finishStreamingMessage(sessionId: string, messageId: string, extra: Record<string, unknown> = {}): Promise<void> {
    await this.flushStreamingBuffer(sessionId);
    await withFileLock(this.messagesPath(sessionId), async () => {
      const messages = await this.getStoredMessages(sessionId);
      const message = messages.find((m) => m.id === messageId);
      if (!message) return;
      Object.assign(message, extra);
      message.status = (extra.status as StoredMessage["status"] | undefined) ?? "done";
      await this.writeMessagesUpsert(sessionId, messages);
      await this.updateSession(sessionId, {
        messageCount: messages.length,
        lastMessageAt: message.timestamp,
      });
      // 收尾时尝试追加完成的 turn 到 transcript
      await this.maybeAppendTurnTranscript(sessionId).catch(() => undefined);
    });
  }

  /** 检查是否有新完成的 turn，若有则增量追加到 transcript.md */
  private async maybeAppendTurnTranscript(sessionId: string): Promise<void> {
    const session = await this.getSession(sessionId);
    if (!session) return;
    const messages = await this.getStoredMessages(sessionId);
    const turns = buildTurns(messages);
    const lastAppendedId = session.lastCompletedTurnId;
    const newCompleted = turns.filter((t) => t.completed && t.id !== lastAppendedId);
    if (newCompleted.length === 0) return;
    const transcriptPath = this.transcriptPath(sessionId);
    const appended = newCompleted.map(appendTurnToTranscript).join("");
    if (!appended) return;
    await withFileLock(transcriptPath, async () => {
      let existing = "";
      try { existing = await readFile(transcriptPath, "utf8"); } catch { /* ignore */ }
      await atomicWrite(transcriptPath, existing + appended);
    });
    const latest = newCompleted[newCompleted.length - 1];
    await this.updateSession(sessionId, { lastCompletedTurnId: latest.id });
  }

  // ---- 会话检索 / 检视 / 读取（Session-as-a-Resource）----

  transcriptPath(sessionId: string): string {
    return path.join(this.sessionsDir, sessionId, "transcript.md");
  }

  turnsPath(sessionId: string): string {
    return path.join(this.sessionsDir, sessionId, "turns.json");
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

  /** 重新生成 transcript.md（基于 Turn，仅输出 completed 轮次） */
  async regenerateTranscript(sessionId: string): Promise<void> {
    const session = await this.getSession(sessionId);
    const messages = await this.getStoredMessages(sessionId);
    const turns = buildTurns(messages);
    const content = turnsToTranscript(turns, session?.name ?? sessionId, sessionId, session?.goal ?? "", session?.createdAt ?? "");
    const filePath = this.transcriptPath(sessionId);
    await withFileLock(filePath, () => atomicWrite(filePath, content));
    // 同步更新 lastCompletedTurnId
    const lastCompleted = [...turns].reverse().find((t) => t.completed);
    if (lastCompleted) {
      await this.updateSession(sessionId, { lastCompletedTurnId: lastCompleted.id });
    }
  }

  /**
   * 截断会话消息：从指定 messageId 开始删除后续所有消息（含该消息）。
   * 用于"原地编辑 + 截断分叉重发"：用户编辑某条消息后，从该消息开始重新生成分支。
   * 返回被截断后的消息数组（用于前端重新渲染）。
   */
  async truncateMessages(sessionId: string, fromMessageId: string): Promise<StoredMessage[]> {
    return await withFileLock(this.messagesPath(sessionId), async () => {
      const messages = await this.getStoredMessages(sessionId);
      const index = messages.findIndex((m) => m.id === fromMessageId);
      if (index === -1) {
        throw new Error(`Message not found: ${fromMessageId}`);
      }
      // 保留 fromMessageId 之前的消息，丢弃该消息及之后的所有消息
      const truncated = messages.slice(0, index);
      await this.writeMessagesUpsert(sessionId, truncated);
      // 更新会话元数据
      const lastMsg = truncated[truncated.length - 1];
      await this.updateSession(sessionId, {
        messageCount: truncated.length,
        lastMessageAt: lastMsg?.timestamp ?? new Date().toISOString(),
      });
      // 重新生成 transcript（基于截断后的消息）
      await this.regenerateTranscript(sessionId);
      return truncated;
    });
  }

  /** 检视会话元数据（句柄层，不返回历史内容）。 */
  async inspectSession(sessionId: string): Promise<Record<string, unknown>> {
    const session = await this.getSession(sessionId);
    if (!session) throw new Error(`Unknown session: ${sessionId}`);
    const messages = await this.getStoredMessages(sessionId);
    const turns = buildTurns(messages);
    return {
      id: session.id,
      name: session.name,
      goal: session.goal,
      createdAt: session.createdAt,
      messageCount: session.messageCount,
      lastMessageAt: session.lastMessageAt,
      turnCount: turns.length,
      completedTurns: turns.filter((t) => t.completed).length,
      topics: deriveTopics(session.goal),
      hasTranscript: true,
    };
  }

  /** 读取指定 turn 区间（1-based 闭区间）的明文切片。 */
  async readSessionTranscript(sessionId: string, from: number, to: number): Promise<string> {
    const session = await this.getSession(sessionId);
    if (!session) throw new Error(`Unknown session: ${sessionId}`);
    const messages = await this.getStoredMessages(sessionId);
    const turns = buildTurns(messages);
    const total = turns.length;
    let lo = Number.isFinite(from) && from > 0 ? Math.floor(from) : 1;
    let hi = Number.isFinite(to) && to > 0 ? Math.floor(to) : total;
    lo = Math.max(1, lo);
    hi = Math.min(total, hi);
    if (lo > hi) [lo, hi] = [hi, lo];
    const selected = turns.slice(lo - 1, hi);
    const lines: string[] = [];
    for (const turn of selected) {
      lines.push(`## Turn ${turn.index} · user · ${turn.userMessage.timestamp}`);
      lines.push("");
      lines.push(turn.userMessage.content || "");
      if (turn.agentMessage) {
        lines.push(`## Turn ${turn.index} · agent · ${turn.agentMessage.timestamp}`);
        lines.push("");
        lines.push(turn.agentMessage.content || "");
        for (const call of turn.agentMessage.toolCalls ?? []) {
          const result = call.result.length > 2000 ? `${call.result.slice(0, 2000)}…[截断]` : call.result;
          lines.push(`🔧 ${call.tool}(${call.args}) -> ${result}`);
        }
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

  /** 跨会话检索，按相关度排序。数据源用 transcript.md（增量维护的纯文本缓存）。 */
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
      let content = await readFile(this.transcriptPath(session.id), "utf8").catch(() => null);
      if (content === null) {
        await this.regenerateTranscript(session.id).catch(() => undefined);
        content = await readFile(this.transcriptPath(session.id), "utf8").catch(() => null);
      }
      if (content === null) continue;
      const turnRanges: Array<[number, number]> = [];
      let snippet = "";
      let rangeStart = -1;
      const segmentTitleRe = /^## Turn (\d+)/;
      const lines = content.split("\n");
      let segment: string[] = [];
      let segmentNo = 0;
      const flushSegment = () => {
        if (segment.length === 0 || segmentNo === 0) {
          segment = [];
          return;
        }
        const body = segment.join("\n").toLowerCase();
        if (body.includes(needle)) {
          score += 1;
          if (!snippet) {
            const firstText = segment.find((line) => !line.startsWith("## ") && !line.startsWith("🔧 ") && line.trim());
            snippet = (firstText ?? segment[0] ?? "").slice(0, 160);
          }
          if (rangeStart === -1) rangeStart = segmentNo;
        } else if (rangeStart !== -1) {
          turnRanges.push([rangeStart, segmentNo - 1]);
          rangeStart = -1;
        }
        segment = [];
      };
      for (const line of lines) {
        const titleMatch = line.match(segmentTitleRe);
        if (titleMatch) {
          flushSegment();
          segmentNo = Number(titleMatch[1]);
          segment.push(line);
        } else {
          segment.push(line);
        }
      }
      flushSegment();
      if (rangeStart !== -1) turnRanges.push([rangeStart, segmentNo]);
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

  private async writeSessions(sessions: SessionRecord[]): Promise<void> {
    await atomicWriteJson(this.sessionsFile, sessions.map(sessionToDisk));
  }

  /** 归档会话：标记为 archived，从主列表隐藏但保留数据 */
  async archiveSession(sessionId: string): Promise<SessionRecord | null> {
    return await withFileLock(this.sessionsFile, async () => {
      const sessions = await this.listSessions();
      const index = sessions.findIndex((s) => s.id === sessionId);
      if (index === -1) return null;
      const updated = { ...sessions[index], archived: true, archivedAt: new Date().toISOString() };
      sessions[index] = updated;
      await this.writeSessions(sessions);
      return updated;
    });
  }

  /** 取消归档会话：恢复到主列表显示 */
  async unarchiveSession(sessionId: string): Promise<SessionRecord | null> {
    return await withFileLock(this.sessionsFile, async () => {
      const sessions = await this.listSessions();
      const index = sessions.findIndex((s) => s.id === sessionId);
      if (index === -1) return null;
      const updated = { ...sessions[index], archived: false, archivedAt: undefined };
      sessions[index] = updated;
      await this.writeSessions(sessions);
      return updated;
    });
  }

  /** 列出所有会话（含归档），可选过滤 */
  async listAllSessions(includeArchived = false): Promise<SessionRecord[]> {
    const sessions = await this.listSessions();
    if (includeArchived) return sessions;
    return sessions.filter((s) => !s.archived);
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
    turnIndex: typeof raw.turn_index === "number" ? raw.turn_index : typeof raw.turnIndex === "number" ? raw.turnIndex : undefined,
    lastCompletedTurnId: raw.last_completed_turn_id ? String(raw.last_completed_turn_id) : raw.lastCompletedTurnId ? String(raw.lastCompletedTurnId) : undefined,
    archived: raw.archived === true,
    archivedAt: raw.archived_at ? String(raw.archived_at) : raw.archivedAt ? String(raw.archivedAt) : undefined,
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
    turn_index: session.turnIndex,
    last_completed_turn_id: session.lastCompletedTurnId,
    archived: session.archived,
    archived_at: session.archivedAt,
  };
}

/** 从 goal 里粗略抽关键词作为 topic 提示（仅用于 inspect 展示）。 */
function deriveTopics(goal: string): string[] {
  if (!goal) return [];
  const cleaned = goal.replace(/[，。、；：！？,.!?;:\s]+/gu, " ").trim();
  return cleaned.split(" ").filter(Boolean).slice(0, 5);
}