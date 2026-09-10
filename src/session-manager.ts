import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
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

const execFileAsync = promisify(execFile);

/**
 * 内容检索引擎：优先 rg（ripgrep）子进程。
 * 用子进程的好处：不占 Node 主线程、多线程扫描、带命中计数；
 * rg 不存在或执行失败时上层一律回落原先的 JS 全量扫描，保证功能不因此不可用。
 */
const RIPGREP_PATH = process.env.MODUTY_RG_PATH?.trim() || "rg";
let ripgrepReady: boolean | null = null;

async function ripgrepAvailable(): Promise<boolean> {
  if (ripgrepReady !== null) return ripgrepReady;
  try {
    await execFileAsync(RIPGREP_PATH, ["--version"], { timeout: 5000, windowsHide: true });
    ripgrepReady = true;
  } catch {
    ripgrepReady = false;
  }
  return ripgrepReady;
}

/** 跑一次 rg：正常返回 stdout（无命中时为空串）；rg 不可用/超时返回 null 由调用方回落 */
async function runRipgrep(args: string[], cwd: string): Promise<string | null> {
  try {
    const { stdout } = await execFileAsync(RIPGREP_PATH, args, {
      cwd,
      timeout: 15000,
      maxBuffer: 16 * 1024 * 1024,
      windowsHide: true,
    });
    return stdout;
  } catch (error) {
    // rg 无命中时退出码为 1，这不是错误
    if ((error as { code?: number | string }).code === 1) return "";
    return null;
  }
}

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
  /** 是否为草稿态（首条消息前不入列表） */
  draft?: boolean;
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

  /** 列出会话（默认过滤草稿态，includeDraft=true 时包含草稿） */
  async listSessions(includeDraft = false): Promise<SessionRecord[]> {
    try {
      const parsed = JSON.parse(await readFile(this.sessionsFile, "utf8")) as unknown;
      const sessions = Array.isArray(parsed) ? parsed.map(sessionFromDisk) : [];
      return includeDraft ? sessions : sessions.filter((s) => !s.draft);
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
      draft: true,
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
      // 首条消息时取消草稿态
      const isFirstMessage = all.length === 1;
      await this.updateSession(sessionId, {
        messageCount: all.length,
        lastMessageAt: message.timestamp,
        ...(isFirstMessage ? { draft: false } : {}),
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

  /** 导出会话记录为指定格式（JSON/MD/TXT） */
  async exportSession(sessionId: string, format: "json" | "md" | "txt" = "md"): Promise<{ format: string; content: string; filename: string }> {
    const session = await this.getSession(sessionId);
    if (!session) throw new Error(`Unknown session: ${sessionId}`);
    const messages = await this.getStoredMessages(sessionId);
    const turns = buildTurns(messages);
    
    let content: string;
    let filename: string;
    
    switch (format) {
      case "json": {
        const exportData = {
          session: {
            id: session.id,
            name: session.name,
            goal: session.goal,
            folderPath: session.folderPath,
            createdAt: session.createdAt,
            messageCount: session.messageCount,
            lastMessageAt: session.lastMessageAt,
          },
          turns: turns.map((turn) => ({
            index: turn.index,
            userMessage: {
              content: turn.userMessage.content,
              timestamp: turn.userMessage.timestamp,
            },
            agentMessage: turn.agentMessage ? {
              content: turn.agentMessage.content,
              timestamp: turn.agentMessage.timestamp,
              toolCalls: turn.agentMessage.toolCalls?.map((call) => ({
                tool: call.tool,
                args: call.args,
                result: call.result,
                status: call.status,
              })),
            } : null,
            completed: turn.completed,
            createdAt: turn.createdAt,
          })),
        };
        content = JSON.stringify(exportData, null, 2);
        filename = `session_${session.id}.json`;
        break;
      }
      case "md": {
        const lines: string[] = [];
        lines.push(`# Session: ${session.name} (${session.id})`);
        lines.push(`goal: ${session.goal}`);
        lines.push(`created: ${session.createdAt}`);
        lines.push(`turns: ${turns.length}`);
        lines.push("");
        for (const turn of turns) {
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
        content = lines.join("\n");
        filename = `session_${session.id}.md`;
        break;
      }
      case "txt":
      default: {
        const lines: string[] = [];
        lines.push(`Session: ${session.name} (${session.id})`);
        lines.push(`Goal: ${session.goal}`);
        lines.push(`Created: ${session.createdAt}`);
        lines.push(`Turns: ${turns.length}`);
        lines.push("");
        for (const turn of turns) {
          lines.push(`Turn ${turn.index} · user · ${turn.userMessage.timestamp}`);
          lines.push(turn.userMessage.content || "");
          if (turn.agentMessage) {
            lines.push(`Turn ${turn.index} · agent · ${turn.agentMessage.timestamp}`);
            lines.push(turn.agentMessage.content || "");
            for (const call of turn.agentMessage.toolCalls ?? []) {
              lines.push(`Tool: ${call.tool}`);
              lines.push(`Args: ${call.args}`);
              lines.push(`Result: ${call.result}`);
            }
          }
          lines.push("");
        }
        content = lines.join("\n");
        filename = `session_${session.id}.txt`;
        break;
      }
    }
    
    return { format, content, filename };
  }

  /** 按消息 id 全局查找（跨会话）：返回源会话与消息，供 &msg_<id> 引用展开/回溯 */
  async findMessageById(messageId: string): Promise<{ sessionId: string; sessionName: string; message: SessionMessage } | null> {
    const sessions = await this.listSessions(true);
    for (const session of sessions) {
      let messages: SessionMessage[] = [];
      try {
        messages = await this.getStoredMessages(session.id);
      } catch {
        continue;
      }
      const message = messages.find((item) => item.id === messageId);
      if (message) {
        return { sessionId: session.id, sessionName: session.name, message };
      }
    }
    return null;
  }

  /**
   * 在 transcript 内做内容 grep。
   * 优先 rg（行号 + 命中行文本一次拿到），失败则回落 JS 全量扫描。
   * query 按**字面量**处理（rg 用 --fixed-strings），避免模型给出的关键词里的正则元字符改变语义。
   */
  async searchContentInSession(sessionId: string | undefined, query: string): Promise<Array<{ session: string; line: number; text: string }>> {
    const needle = query.trim();
    if (!needle) return [];
    if (await ripgrepAvailable()) {
      const args = [
        "--line-number", "--ignore-case", "--fixed-strings", "--no-ignore", "--hidden",
        "--glob", "transcript.md", "--max-count", "20",
        "-e", needle, "--",
      ];
      args.push(sessionId ? `${sessionId}/transcript.md` : ".");
      const stdout = await runRipgrep(args, this.sessionsDir);
      if (stdout !== null) {
        const results: Array<{ session: string; line: number; text: string }> = [];
        for (const raw of stdout.split("\n")) {
          if (!raw.trim()) continue;
          const match = /^\.?[\\/]?([^\\/:]+)[\\/]transcript\.md:(\d+):(.*)$/.exec(raw);
          if (!match) continue;
          results.push({ session: match[1], line: Number(match[2]), text: match[3].slice(0, 300) });
          if (results.length >= 100) break;
        }
        return results;
      }
    }
    const results: Array<{ session: string; line: number; text: string }> = [];
    const ids = sessionId ? [sessionId] : (await this.listSessions()).map((session) => session.id);
    const lowered = needle.toLowerCase();
    for (const id of ids) {
      let content = await readFile(this.transcriptPath(id), "utf8").catch(() => null);
      if (!content) {
        await this.regenerateTranscript(id).catch(() => undefined);
        content = await readFile(this.transcriptPath(id), "utf8").catch(() => null);
      }
      if (!content) continue;
      content.split("\n").forEach((text, idx) => {
        if (text.toLowerCase().includes(lowered)) {
          results.push({ session: id, line: idx + 1, text: text.slice(0, 300) });
        }
      });
    }
    return results.slice(0, 100);
  }

  /**
   * 跨会话检索，按相关度排序。数据源用 transcript.md（增量维护的纯文本缓存）。
   *
   * 多关键词之间取**并集**（任一命中即入候选，与 rg -e a -e b 语义一致）。
   * 引擎：优先用 rg 做候选筛进与计数（不占 Node 主线程），只对候选会话做逐 turn 解析
   * 以保持原有返回结构；rg 不可用时回落到全量 JS 扫描。
   */
  async searchSessions(query: string, limit = 20, extraKeywords: string[] = []): Promise<Array<Record<string, unknown>>> {
    const sessions = await this.listSessions();
    const keywords = [query, ...extraKeywords].map((item) => item.trim()).filter(Boolean);
    if (keywords.length === 0) {
      return sessions.slice(0, limit).map((session) => this.toSearchHit(session, 0, [], ""));
    }
    const needles = keywords.map((item) => item.toLowerCase());

    // 元数据层命中：名字 +5 / goal +3（对每个关键词分别累加）
    const meta = new Map<string, number>();
    for (const session of sessions) {
      let score = 0;
      for (const needle of needles) {
        if (session.name.toLowerCase().includes(needle)) score += 5;
        if (session.goal.toLowerCase().includes(needle)) score += 3;
      }
      if (score > 0) meta.set(session.id, score);
    }

    // 内容层候选：rg 命中文件（并集）∪ 元数据命中；rg 不可用时退化为全部会话
    const counts = await this.countHitsWithRipgrep(keywords);
    const candidateIds = counts
      ? [...new Set([...counts.keys(), ...meta.keys()])]
      : sessions.map((session) => session.id);
    const byId = new Map(sessions.map((session) => [session.id, session]));

    const hits: Array<Record<string, unknown>> = [];
    for (const id of candidateIds) {
      const session = byId.get(id);
      if (!session) continue;
      const detail = await this.scoreTranscript(session.id, needles);
      const score = (meta.get(session.id) ?? 0) + detail.score;
      if (score > 0) hits.push(this.toSearchHit(session, score, detail.turnRanges, detail.snippet));
    }
    hits.sort((a, b) => Number(b.score) - Number(a.score));
    return hits.slice(0, limit);
  }

  /** 用 rg 统计每个会话的命中行数（多关键词并集）；rg 不可用返回 null */
  private async countHitsWithRipgrep(keywords: string[]): Promise<Map<string, number> | null> {
    if (keywords.length === 0) return null;
    if (!(await ripgrepAvailable())) return null;
    const args = [
      "--count", "--ignore-case", "--fixed-strings", "--no-ignore", "--hidden",
      "--glob", "transcript.md",
    ];
    for (const keyword of keywords) args.push("-e", keyword);
    args.push("--", ".");
    const stdout = await runRipgrep(args, this.sessionsDir);
    if (stdout === null) return null;
    const counts = new Map<string, number>();
    for (const raw of stdout.split("\n")) {
      const match = /([^\\/]+)[\\/]transcript\.md:(\d+)\s*$/.exec(raw.trim());
      if (match) counts.set(match[1], Number(match[2]));
    }
    return counts;
  }

  /**
   * 逐 turn 解析单个 transcript：统计命中段数、命中 turn 区间与首段摘要。
   * 打分口径与原实现一致：**一个命中 twe 1 分**（不按关键词数重复计数）。
   */
  private async scoreTranscript(
    sessionId: string,
    needles: string[],
  ): Promise<{ score: number; turnRanges: Array<[number, number]>; snippet: string }> {
    let content = await readFile(this.transcriptPath(sessionId), "utf8").catch(() => null);
    if (content === null) {
      await this.regenerateTranscript(sessionId).catch(() => undefined);
      content = await readFile(this.transcriptPath(sessionId), "utf8").catch(() => null);
    }
    if (content === null) return { score: 0, turnRanges: [], snippet: "" };

    let score = 0;
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
      if (needles.some((needle) => body.includes(needle))) {
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
    return { score, turnRanges, snippet };
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

  async updateSession(sessionId: string, updates: Partial<SessionRecord>): Promise<void> {
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