import os from "node:os";
import path from "node:path";
import { readdir, readFile } from "node:fs/promises";

import {
  ImportedMessageBuilder,
  extractBlocks,
  fingerprintOf,
  forEachJsonlRecord,
  pickTitleFrom,
  scanJsonlUntil,
  statFile,
  textOf,
  TITLE_SCAN_BYTES,
} from "./parse.js";
import type { SourceAdapter, SourceProbe, SourceReadResult, SourceSessionSummary } from "./types.js";

/**
 * Codex 适配器。
 *
 * 布局（实测）：`~/.codex/sessions/<YYYY>/<MM>/<DD>/rollout-<ts>-<uuid>.jsonl`，
 * 另有 `~/.codex/archived_sessions/*.jsonl`；索引 `~/.codex/session_index.jsonl`
 * 形如 `{id, thread_name, updated_at}`，但只覆盖约四分之一会话，其余靠文件头部补齐。
 *
 * 记录形如 `{timestamp, ordinal, type, payload}`，`type ∈ session_meta | response_item |
 * turn_context | event_msg | world_state | token_usage_record | compacted`。
 * 只导入 `response_item` 下的 message / reasoning / 各类工具调用；
 * `developer` 角色装的是 Codex 自己的系统指令，属于噪声，不入库。
 */
export function codexRoot(): string {
  const override = process.env.MOMOKA_CODEX_ROOT?.trim();
  return override ? path.resolve(override) : path.join(os.homedir(), ".codex");
}

const UUID_RE = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi;

/** rollout 文件名里的 UUID 即会话 id（session_meta 缺失时的稳定回退） */
export function codexExternalIdFromFile(fileName: string): string {
  const matches = fileName.match(UUID_RE);
  return matches?.length ? matches[matches.length - 1].toLowerCase() : fileName.replace(/\.jsonl$/u, "");
}

interface CodexIndexEntry {
  title: string;
  updatedAt: string;
}

async function loadIndex(root: string): Promise<Map<string, CodexIndexEntry>> {
  const entries = new Map<string, CodexIndexEntry>();
  let text: string;
  try {
    text = await readFile(path.join(root, "session_index.jsonl"), "utf8");
  } catch {
    return entries;
  }
  for (const line of text.split(/\r?\n/u)) {
    if (!line.trim()) continue;
    try {
      const parsed = JSON.parse(line) as Record<string, unknown>;
      const id = textOf(parsed.id);
      if (!id) continue;
      entries.set(id, { title: textOf(parsed.thread_name), updatedAt: textOf(parsed.updated_at) });
    } catch {
      continue;
    }
  }
  return entries;
}

async function collectSessionFiles(root: string): Promise<Array<{ filePath: string; archived: boolean }>> {
  const found: Array<{ filePath: string; archived: boolean }> = [];
  const sessionsRoot = path.join(root, "sessions");
  let years: string[];
  try {
    years = (await readdir(sessionsRoot, { withFileTypes: true })).filter((entry) => entry.isDirectory()).map((entry) => entry.name);
  } catch {
    years = [];
  }
  for (const year of years) {
    const yearDir = path.join(sessionsRoot, year);
    let months: string[];
    try {
      months = (await readdir(yearDir, { withFileTypes: true })).filter((entry) => entry.isDirectory()).map((entry) => entry.name);
    } catch {
      continue;
    }
    for (const month of months) {
      const monthDir = path.join(yearDir, month);
      let days: string[];
      try {
        days = (await readdir(monthDir, { withFileTypes: true })).filter((entry) => entry.isDirectory()).map((entry) => entry.name);
      } catch {
        continue;
      }
      for (const day of days) {
        const dayDir = path.join(monthDir, day);
        try {
          for (const entry of await readdir(dayDir, { withFileTypes: true })) {
            if (entry.isFile() && entry.name.endsWith(".jsonl")) {
              found.push({ filePath: path.join(dayDir, entry.name), archived: false });
            }
          }
        } catch {
          continue;
        }
      }
    }
  }
  const archivedRoot = path.join(root, "archived_sessions");
  try {
    for (const entry of await readdir(archivedRoot, { withFileTypes: true })) {
      if (entry.isFile() && entry.name.endsWith(".jsonl")) {
        found.push({ filePath: path.join(archivedRoot, entry.name), archived: true });
      }
    }
  } catch {
    // 没有归档目录是正常情况
  }
  return found;
}

interface CodexHead {
  sessionId: string;
  cwd: string;
  createdAt: string;
  version: string;
  title: string;
}

async function scanHead(filePath: string, knownTitle: string): Promise<CodexHead> {
  const result: CodexHead = { sessionId: "", cwd: "", createdAt: "", version: "", title: knownTitle };
  try {
    await scanJsonlUntil(filePath, TITLE_SCAN_BYTES, (raw) => {
      if (!raw || typeof raw !== "object") return false;
      const record = raw as Record<string, unknown>;
      const payload = (record.payload ?? {}) as Record<string, unknown>;
      if (record.type === "session_meta") {
        if (!result.sessionId) result.sessionId = textOf(payload.session_id) || textOf(payload.id);
        if (!result.cwd) result.cwd = textOf(payload.cwd);
        if (!result.version) result.version = textOf(payload.cli_version);
        if (!result.createdAt) result.createdAt = textOf(payload.timestamp) || textOf(record.timestamp);
      } else if (!result.title && record.type === "response_item" && payload.type === "message") {
        const role = textOf(payload.role);
        // developer 装的是 Codex 自己的系统指令，不参与标题
        if (role !== "user" && role !== "assistant") return false;
        result.title = pickTitleFrom(extractBlocks(payload.content).texts);
      }
      return result.title !== "" && result.createdAt !== "" && result.cwd !== "";
    });
  } catch {
    return result;
  }
  return result;
}

export const codexAdapter: SourceAdapter = {
  source: "codex",
  label: "Codex",

  async probe(): Promise<SourceProbe> {
    const root = codexRoot();
    try {
      await readdir(root);
      return { available: true, root };
    } catch (error) {
      return { available: false, root, reason: `无法读取 ${root}：${error instanceof Error ? error.message : String(error)}` };
    }
  },

  async list(): Promise<SourceSessionSummary[]> {
    const root = codexRoot();
    const index = await loadIndex(root);
    const files = await collectSessionFiles(root);
    const summaries: SourceSessionSummary[] = [];
    for (const { filePath, archived } of files) {
      const info = await statFile(filePath);
      if (!info) continue;
      const externalId = codexExternalIdFromFile(path.basename(filePath));
      const indexEntry = index.get(externalId);
      const head = await scanHead(filePath, indexEntry?.title ?? "");
      summaries.push({
        externalId,
        title: indexEntry?.title || head.title || externalId,
        createdAt: head.createdAt ? new Date(head.createdAt).toISOString() : new Date(info.mtimeMs).toISOString(),
        updatedAt: indexEntry?.updatedAt
          ? new Date(indexEntry.updatedAt).toISOString()
          : new Date(info.mtimeMs).toISOString(),
        messageCount: null,
        ...(head.cwd ? { workspace: head.cwd } : {}),
        archived,
        fingerprint: fingerprintOf(info),
        path: filePath,
      });
    }
    return summaries.sort((left, right) => right.updatedAt.localeCompare(left.updatedAt));
  },

  async read(externalId: string): Promise<SourceReadResult> {
    const filePath = await locate(externalId);
    if (!filePath) throw new Error(`Codex 会话不存在：${externalId}`);
    const info = await statFile(filePath);
    const index = await loadIndex(codexRoot());
    const indexEntry = index.get(externalId);
    const builder = new ImportedMessageBuilder();
    let cwd = "";
    let model = "";
    let firstTimestamp = "";
    let lastTimestamp = "";
    let title = indexEntry?.title ?? "";

    await forEachJsonlRecord(filePath, (raw) => {
      if (!raw || typeof raw !== "object") return;
      const record = raw as Record<string, unknown>;
      const payload = (record.payload ?? {}) as Record<string, unknown>;
      const timestamp = textOf(record.timestamp);

      if (record.type === "session_meta") {
        if (!cwd) cwd = textOf(payload.cwd);
        if (!firstTimestamp) firstTimestamp = textOf(payload.timestamp) || timestamp;
        return;
      }
      if (record.type === "turn_context") {
        if (!model) model = textOf(payload.model);
        return;
      }
      if (record.type !== "response_item") return;

      if (timestamp && !firstTimestamp) firstTimestamp = timestamp;
      if (timestamp) lastTimestamp = timestamp;

      const itemType = textOf(payload.type);
      if (itemType === "message") {
        const role = textOf(payload.role);
        if (role === "developer") return; // Codex 自身系统指令，不是对话内容
        const blocks = extractBlocks(payload.content);
        if (role === "user") builder.push("user", blocks.text, timestamp);
        else builder.push("agent", blocks.text, timestamp, { model });
        for (const call of blocks.toolUses) builder.addToolUse(call.id, call.name, call.args, timestamp, model);
        for (const result of blocks.toolResults) builder.addToolResult(result.id, result.result, result.isError, timestamp);
        if (!title && role === "user") title = pickTitleFrom(blocks.texts);
        return;
      }
      if (itemType === "reasoning") {
        const summary = Array.isArray(payload.summary) ? payload.summary.map(flattenReasoning).filter(Boolean).join("\n") : "";
        builder.push("agent", "", timestamp, { reasoning: summary, model });
        return;
      }
      const blocks = extractBlocks({ ...payload, type: itemType });
      for (const call of blocks.toolUses) builder.addToolUse(call.id, call.name, call.args, timestamp, model);
      for (const result of blocks.toolResults) builder.addToolResult(result.id, result.result, result.isError, timestamp);
    });

    const messages = builder.build();
    // 头扫描与列表阶段的标题都没能给出非注入型文本时，老实用会话 id
    const resolvedTitle = title || externalId;
    const summary: SourceSessionSummary = {
      externalId,
      title: resolvedTitle,
      createdAt: firstTimestamp || new Date(info?.mtimeMs ?? 0).toISOString(),
      updatedAt: indexEntry?.updatedAt || lastTimestamp || new Date(info?.mtimeMs ?? 0).toISOString(),
      messageCount: messages.length,
      ...(cwd ? { workspace: cwd } : {}),
      archived: filePath.includes(`${path.sep}archived_sessions${path.sep}`),
      fingerprint: info ? fingerprintOf(info) : "",
      path: filePath,
    };
    return { summary, messages };
  },
};

function flattenReasoning(value: unknown): string {
  if (typeof value === "string") return value;
  if (value && typeof value === "object") {
    const obj = value as Record<string, unknown>;
    if (typeof obj.text === "string") return obj.text;
  }
  return "";
}

/**
 * 按 externalId 定位 rollout 文件。
 * 目录层级固定（年/月/日），路径索引缓存 60 秒，避免批量导入时反复遍历。
 */
let pathIndexCache: { root: string; builtAt: number; index: Map<string, string> } | null = null;
const PATH_INDEX_TTL_MS = 60_000;

async function locate(externalId: string): Promise<string | null> {
  const root = codexRoot();
  const now = Date.now();
  if (!pathIndexCache || pathIndexCache.root !== root || now - pathIndexCache.builtAt > PATH_INDEX_TTL_MS) {
    const files = await collectSessionFiles(root);
    const index = new Map<string, string>();
    for (const { filePath } of files) {
      index.set(codexExternalIdFromFile(path.basename(filePath)), filePath);
    }
    pathIndexCache = { root, builtAt: now, index };
  }
  return pathIndexCache.index.get(externalId) ?? null;
}
