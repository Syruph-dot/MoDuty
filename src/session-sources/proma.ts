import os from "node:os";
import path from "node:path";
import { readFile } from "node:fs/promises";

import {
  ImportedMessageBuilder,
  extractBlocks,
  fingerprintOf,
  forEachJsonlRecord,
  isoFromMs,
  statFile,
  textOf,
  titleFrom,
} from "./parse.js";
import type { ImportedMessage, SourceAdapter, SourceProbe, SourceReadResult, SourceSessionSummary } from "./types.js";

/**
 * Proma 适配器（本机直连）。
 *
 * 布局（实测 442 条索引 / 421 个会话文件）：
 * - 索引 `~/.proma/agent-sessions.json`：`{version, sessions: [{id, title, channelId, workspaceId,
 *   createdAt(ms), updatedAt(ms), archived, modelId, isDraft, parentSessionId, legacyTranscript, …}]}`
 * - 正文 `~/.proma/agent-sessions/<id>.jsonl`：`{type: user|assistant|result, message: {content,
 *   usage, model, stop_reason}, session_id, uuid, parent_tool_use_id, _channelModelId, _createdAt}`
 * - 工作区 `~/.proma/agent-workspaces.json`
 *
 * 索引自带标题与时间，所以列表阶段完全不需要读正文——这是三个来源里最轻的一条。
 *
 * 另一条输入通道是 Proma 官方的「迁移压缩包」（整个 .proma 目录的 ZIP），
 * 由 archive.ts 解压后交给本适配器同一套解析逻辑（见 fromDirectory）。
 */
export function promaRoot(): string {
  const override = process.env.MOMOKA_PROMA_ROOT?.trim();
  return override ? path.resolve(override) : path.join(os.homedir(), ".proma");
}

export interface PromaIndexEntry {
  id: string;
  title: string;
  workspaceId: string;
  createdAtMs: number;
  updatedAtMs: number;
  archived: boolean;
  isDraft: boolean;
  modelId: string;
  originRuntime: string;
}

export async function readPromaIndex(root: string): Promise<PromaIndexEntry[]> {
  let text: string;
  try {
    text = await readFile(path.join(root, "agent-sessions.json"), "utf8");
  } catch {
    return [];
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text) as unknown;
  } catch {
    return [];
  }
  const sessions = (parsed as { sessions?: unknown } | null)?.sessions;
  if (!Array.isArray(sessions)) return [];
  const entries: PromaIndexEntry[] = [];
  for (const raw of sessions) {
    if (!raw || typeof raw !== "object") continue;
    const obj = raw as Record<string, unknown>;
    const id = textOf(obj.id);
    if (!id) continue;
    const legacy = (obj.legacyTranscript ?? {}) as Record<string, unknown>;
    entries.push({
      id,
      title: textOf(obj.title),
      workspaceId: textOf(obj.workspaceId),
      createdAtMs: typeof obj.createdAt === "number" ? obj.createdAt : 0,
      updatedAtMs: typeof obj.updatedAt === "number" ? obj.updatedAt : 0,
      archived: obj.archived === true,
      isDraft: obj.isDraft === true,
      modelId: textOf(obj.modelId),
      originRuntime: textOf(legacy.sourceRuntime),
    });
  }
  return entries;
}

/** 会话文件路径；Proma 一律用 `<id>.jsonl` */
export function promaSessionPath(root: string, id: string): string {
  return path.join(root, "agent-sessions", `${id}.jsonl`);
}

export async function readPromaSessionFile(
  root: string,
  entry: PromaIndexEntry,
): Promise<{ messages: ImportedMessage[]; path: string; model: string }> {
  const filePath = promaSessionPath(root, entry.id);
  const builder = new ImportedMessageBuilder();
  let model = entry.modelId;
  await forEachJsonlRecord(filePath, (raw) => {
    if (!raw || typeof raw !== "object") return;
    const record = raw as Record<string, unknown>;
    const type = textOf(record.type);
    if (type !== "user" && type !== "assistant") return; // result 等是运行态汇总
    const message = (record.message ?? {}) as Record<string, unknown>;
    const blocks = extractBlocks(message.content);
    const timestamp = isoFromMs(record._createdAt);
    const recordModel = textOf(message.model) || textOf(record._channelModelId);
    if (recordModel) model = recordModel;
    if (type === "user") {
      builder.push("user", blocks.text, timestamp);
      for (const call of blocks.toolUses) builder.addToolUse(call.id, call.name, call.args, timestamp, model);
      for (const result of blocks.toolResults) builder.addToolResult(result.id, result.result, result.isError, timestamp);
      return;
    }
    builder.push("agent", blocks.text, timestamp, { reasoning: blocks.reasoning, model: recordModel });
    for (const call of blocks.toolUses) builder.addToolUse(call.id, call.name, call.args, timestamp, recordModel);
    for (const result of blocks.toolResults) builder.addToolResult(result.id, result.result, result.isError, timestamp);
  });
  return { messages: builder.build(), path: filePath, model };
}

function toSummary(entry: PromaIndexEntry, filePath: string, fingerprint: string, messageCount: number | null): SourceSessionSummary {
  const createdAt = entry.createdAtMs ? new Date(entry.createdAtMs).toISOString() : new Date(0).toISOString();
  const updatedAt = entry.updatedAtMs ? new Date(entry.updatedAtMs).toISOString() : createdAt;
  return {
    externalId: entry.id,
    title: entry.title || entry.id,
    createdAt,
    updatedAt,
    messageCount,
    ...(entry.workspaceId ? { workspace: entry.workspaceId } : {}),
    archived: entry.archived,
    fingerprint,
    path: filePath,
  };
}

/** 从任意 Proma 数据根构造适配器：本机 `~/.proma` 与解压出来的迁移包共用同一份实现 */
export function createPromaAdapter(describeRoot: () => string, sourceLabel = "Proma"): SourceAdapter {
  return {
    source: "proma",
    label: sourceLabel,

    async probe(): Promise<SourceProbe> {
      const root = describeRoot();
      const entries = await readPromaIndex(root);
      if (!entries.length) {
        return {
          available: false,
          root,
          reason: `未找到 ${path.join(root, "agent-sessions.json")}，或索引为空/不可解析`,
        };
      }
      return { available: true, root };
    },

    async list(): Promise<SourceSessionSummary[]> {
      const root = describeRoot();
      const entries = await readPromaIndex(root);
      const summaries: SourceSessionSummary[] = [];
      for (const entry of entries) {
        const filePath = promaSessionPath(root, entry.id);
        const info = await statFile(filePath);
        if (!info) continue; // 索引里存在但正文缺失（实测 442 索引 / 421 文件），跳过不可导入项
        summaries.push(toSummary(entry, filePath, fingerprintOf(info), null));
      }
      return summaries.sort((left, right) => right.updatedAt.localeCompare(left.updatedAt));
    },

    async read(externalId: string): Promise<SourceReadResult> {
      const root = describeRoot();
      const entries = await readPromaIndex(root);
      const entry = entries.find((item) => item.id === externalId);
      if (!entry) throw new Error(`Proma 会话索引中不存在：${externalId}`);
      const info = await statFile(promaSessionPath(root, entry.id));
      if (!info) throw new Error(`Proma 会话正文缺失：${promaSessionPath(root, entry.id)}`);
      const { messages, path: filePath } = await readPromaSessionFile(root, entry);
      const title = entry.title || titleFrom(messages.find((message) => message.role === "user")?.content ?? "") || externalId;
      return {
        summary: toSummary({ ...entry, title }, filePath, fingerprintOf(info), messages.length),
        messages,
      };
    },
  };
}

export const promaAdapter: SourceAdapter = createPromaAdapter(promaRoot);
