import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { atomicWriteJson } from "./write-queue.js";

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
  }>;
  changedSessions: Array<{
    id: string;
    name: string;
    goal: string;
    lastMessageAt: string;
    /** 基于 messageCount 差分推算的新增 turn 区间（1-based 闭区间） */
    changedTurnRanges: Array<[number, number]>;
    snippet: string;             // 最近新增内容片段（用于 LLM 定位）
  }>;
}

/** 读取元数据（不存在则返回默认值） */
export async function readDailyGenMeta(): Promise<DailyGenMeta> {
  try {
    const content = await readFile(META_FILE, "utf8");
    return JSON.parse(content) as DailyGenMeta;
  } catch {
    return { lastGenAt: null, updatedAt: new Date().toISOString() };
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
  }>>; getMessages: (id: string, limit: number | null) => Promise<Array<{ role: string; content: string; timestamp: string }>>; },
): Promise<ChangedSessionsResult> {
  const sinceTime = new Date(since).getTime();
  const sessions = await sessionManager.listSessions();

  const newSessions: ChangedSessionsResult["newSessions"] = [];
  const changedSessions: ChangedSessionsResult["changedSessions"] = [];

  for (const session of sessions) {
    const createdTime = new Date(session.createdAt).getTime();
    const lastMsgTime = new Date(session.lastMessageAt).getTime();

    if (createdTime > sinceTime) {
      // 新建会话
      newSessions.push({
        id: session.id,
        name: session.name,
        goal: session.goal,
        createdAt: session.createdAt,
      });
    } else if (lastMsgTime > sinceTime) {
      // 变更会话：需要推算新增 turn 区间
      // 策略：读取完整消息列表，找出 timestamp > since 的连续区间
      const messages = await sessionManager.getMessages(session.id, null);
      const changedTurnRanges: Array<[number, number]> = [];
      let rangeStart = -1;

      messages.forEach((msg, idx) => {
        const msgTime = new Date(msg.timestamp).getTime();
        if (msgTime > sinceTime) {
          if (rangeStart === -1) rangeStart = idx + 1; // 1-based
        } else if (rangeStart !== -1) {
          changedTurnRanges.push([rangeStart, idx]);
          rangeStart = -1;
        }
      });
      if (rangeStart !== -1) {
        changedTurnRanges.push([rangeStart, messages.length]);
      }

      // 取最近新增内容作为 snippet（最多 500 字符）
      const newMessages = messages.filter((m) => new Date(m.timestamp).getTime() > sinceTime);
      const snippet = newMessages
        .map((m) => `${m.role}: ${m.content.slice(0, 200)}`)
        .join("\n---\n")
        .slice(0, 500);

      changedSessions.push({
        id: session.id,
        name: session.name,
        goal: session.goal,
        lastMessageAt: session.lastMessageAt,
        changedTurnRanges,
        snippet,
      });
    }
  }

  return { newSessions, changedSessions };
}