import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { atomicWriteJson } from "./write-queue.js";
import { buildTurns, type StoredMessage } from "./serialization.js";

const META_FILE = path.join(process.cwd(), "memory", ".daily-gen-meta.json");

export interface DailyGenMeta {
  lastGenAt: string | null;      // ISO timestamp of last daily generation START
  updatedAt: string;             // ISO timestamp of this meta file update
}

export interface ChangedSessionsResult {
  newSessions: Array<{
    id: string;
    name: string;
    goal: string;
    createdAt: string;
    lastMessageAt: string;
    changedTurnRanges: Array<[number, number]>;
    snippet: string;
    snippetTruncated: boolean;
  }>;
  changedSessions: Array<{
    id: string;
    name: string;
    goal: string;
    lastMessageAt: string;
    /** 按实际对话 Turn 索引推算的变更区间（1-based 闭区间） */
    changedTurnRanges: Array<[number, number]>;
    snippet: string;             // 最近新增内容片段（用于 LLM 定位）
    snippetTruncated: boolean;
  }>;
}

/** 读取元数据（不存在则返回默认值） */
export async function readDailyGenMeta(): Promise<DailyGenMeta> {
  try {
    const content = await readFile(META_FILE, "utf8");
    return JSON.parse(content) as DailyGenMeta;
  } catch (error) {
    if (typeof error === "object" && error !== null && "code" in error && (error as NodeJS.ErrnoException).code === "ENOENT") {
      return { lastGenAt: null, updatedAt: new Date().toISOString() };
    }
    throw error;
  }
}

/** 写入元数据（原子写入） */
export async function writeDailyGenMeta(meta: DailyGenMeta): Promise<void> {
  await atomicWriteJson(META_FILE, meta);
}

/** 标记日报生成开始（在实际生成前调用，记录「开始时间」） */
export async function markDailyGenStart(): Promise<string> {
  const now = new Date().toISOString();
  await writeDailyGenMeta({ lastGenAt: now, updatedAt: now });
  return now;
}

/** 标记日报生成完成（可选：更新完成时间，不覆盖 lastGenAt） */
export async function markDailyGenComplete(): Promise<void> {
  const meta = await readDailyGenMeta();
  await writeDailyGenMeta({ ...meta, updatedAt: new Date().toISOString() });
}

/** Restore the previous checkpoint when a generation fails before producing a report. */
export async function restoreDailyGenStart(expectedStart: string, previousStart: string): Promise<void> {
  const meta = await readDailyGenMeta();
  if (meta.lastGenAt !== expectedStart) return;
  await writeDailyGenMeta({ lastGenAt: previousStart, updatedAt: new Date().toISOString() });
}

/**
 * 获取自指定时间以来的新建/变更会话
 * @param since ISO 时间戳（上次日报生成开始时间）
 * @param sessionManager SessionManager 实例
 * @returns 结构化变更结果，供日报生成 Prompt 使用
 */
export async function getChangedSessionsSince(
  since: string,
  sessionManager: { listSessions: () => Promise<Array<{
    id: string;
    name: string;
    goal: string;
    createdAt: string;
    messageCount: number;
    lastMessageAt: string;
    folderPath: string;
  }>>; getStoredMessages: (id: string) => Promise<StoredMessage[]>; },
): Promise<ChangedSessionsResult> {
  const sinceTime = new Date(since).getTime();
  const sessions = await sessionManager.listSessions();

  const newSessions: ChangedSessionsResult["newSessions"] = [];
  const changedSessions: ChangedSessionsResult["changedSessions"] = [];

  for (const session of sessions) {
    const createdTime = new Date(session.createdAt).getTime();
    const lastMsgTime = new Date(session.lastMessageAt).getTime();
    const isNewSession = createdTime > sinceTime;
    const isChangedSession = lastMsgTime > sinceTime;
    if (!isNewSession && !isChangedSession) continue;

    const messages = await sessionManager.getStoredMessages(session.id);
    const visibleMessages = messages.filter((message) => !message.contextOnly);
    const changedMessages = visibleMessages.filter((message) => new Date(message.timestamp).getTime() > sinceTime);
    const turns = buildTurns(visibleMessages);
    const changedTurnIndices = turns
      .filter((turn) => [turn.userMessage.timestamp, turn.agentMessage?.timestamp]
        .some((timestamp) => timestamp && new Date(timestamp).getTime() > sinceTime))
      .map((turn) => turn.index);
    const changedTurnRanges = turnIndicesToRanges(changedTurnIndices);
    const rawSnippet = changedMessages
      .map((message) => `[${message.timestamp}] ${message.role}: ${message.content}`)
      .join("\n---\n");
    const rawSnippetCharacters = Array.from(rawSnippet);
    const snippet = rawSnippetCharacters.slice(0, 500).join("");
    const snippetTruncated = rawSnippetCharacters.length > 500;

    if (isNewSession) {
      // 新建会话
      newSessions.push({
        id: session.id,
        name: session.name,
        goal: session.goal,
        createdAt: session.createdAt,
        lastMessageAt: session.lastMessageAt,
        changedTurnRanges,
        snippet,
        snippetTruncated,
      });
    } else if (isChangedSession) {
      changedSessions.push({
        id: session.id,
        name: session.name,
        goal: session.goal,
        lastMessageAt: session.lastMessageAt,
        changedTurnRanges,
        snippet,
        snippetTruncated,
      });
    }
  }

  return { newSessions, changedSessions };
}

function turnIndicesToRanges(indices: number[]): Array<[number, number]> {
  const sorted = [...new Set(indices)].sort((left, right) => left - right);
  const ranges: Array<[number, number]> = [];
  for (const index of sorted) {
    const previous = ranges[ranges.length - 1];
    if (previous && index === previous[1] + 1) previous[1] = index;
    else ranges.push([index, index]);
  }
  return ranges;
}
