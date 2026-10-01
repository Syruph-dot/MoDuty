import os from "node:os";
import path from "node:path";
import { readdir } from "node:fs/promises";

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
 * Claude Code 适配器。
 *
 * 布局（实测）：`~/.claude/projects/<编码后的 cwd>/<sessionId>.jsonl`，没有索引文件，
 * 目录本身就是索引。记录形如
 * `{type: user|assistant|system|attachment|file-history-snapshot|last-prompt|permission-mode|ai-title, uuid,
 *   parentUuid, timestamp, cwd, sessionId, version, gitBranch, isSidechain, message}`。
 *
 * 只导入 user / assistant 两类；`attachment`（hook 输出）、`file-history-snapshot`、
 * `permission-mode`、`last-prompt`、`queue-operation` 都是运行态簿记，不是对话内容。
 */
export function claudeRoot(): string {
  const override = process.env.MOMOKA_CLAUDE_ROOT?.trim();
  return override ? path.resolve(override) : path.join(os.homedir(), ".claude", "projects");
}

interface HeadScan {
  title: string;
  firstTimestamp: string;
}

/** 标题探测：流式读，拿到「标题 + 首条时间」就停（看 TITLE_SCAN_BYTES 的注释） */
async function scanHead(filePath: string): Promise<HeadScan> {
  const result: HeadScan = { title: "", firstTimestamp: "" };
  try {
    await scanJsonlUntil(filePath, TITLE_SCAN_BYTES, (raw) => {
      if (!raw || typeof raw !== "object") return false;
      const record = raw as Record<string, unknown>;
      const timestamp = textOf(record.timestamp);
      if (timestamp && !result.firstTimestamp) result.firstTimestamp = timestamp;
      if (record.type === "ai-title") {
        const aiTitle = textOf(record.aiTitle);
        if (aiTitle) result.title = aiTitle;
      } else if (!result.title && (record.type === "user" || record.type === "assistant")) {
        const message = (record.message ?? {}) as Record<string, unknown>;
        result.title = pickTitleFrom(extractBlocks(message.content).texts);
      }
      return result.title !== "" && result.firstTimestamp !== "";
    });
  } catch {
    return result;
  }
  return result;
}

export const claudeAdapter: SourceAdapter = {
  source: "claude",
  label: "Claude Code",

  async probe(): Promise<SourceProbe> {
    const root = claudeRoot();
    try {
      const entries = await readdir(root, { withFileTypes: true });
      const projects = entries.filter((entry) => entry.isDirectory());
      return { available: true, root, ...(projects.length ? {} : { reason: "目录存在但没有项目子目录" }) };
    } catch (error) {
      return { available: false, root, reason: `无法读取 ${root}：${error instanceof Error ? error.message : String(error)}` };
    }
  },

  async list(): Promise<SourceSessionSummary[]> {
    const root = claudeRoot();
    const summaries: SourceSessionSummary[] = [];
    let projectDirs: string[];
    try {
      projectDirs = (await readdir(root, { withFileTypes: true }))
        .filter((entry) => entry.isDirectory())
        .map((entry) => entry.name);
    } catch {
      return summaries;
    }
    for (const project of projectDirs) {
      const dir = path.join(root, project);
      let files: string[];
      try {
        files = (await readdir(dir, { withFileTypes: true }))
          .filter((entry) => entry.isFile() && entry.name.endsWith(".jsonl"))
          .map((entry) => entry.name);
      } catch {
        continue;
      }
      for (const file of files) {
        const filePath = path.join(dir, file);
        const info = await statFile(filePath);
        if (!info) continue;
        const head = await scanHead(filePath);
        const externalId = file.replace(/\.jsonl$/u, "");
        summaries.push({
          externalId,
          title: head.title || externalId,
          createdAt: head.firstTimestamp ? new Date(head.firstTimestamp).toISOString() : new Date(info.mtimeMs).toISOString(),
          updatedAt: new Date(info.mtimeMs).toISOString(),
          messageCount: null,
          workspace: project,
          fingerprint: fingerprintOf(info),
          path: filePath,
        });
      }
    }
    return summaries.sort((left, right) => right.updatedAt.localeCompare(left.updatedAt));
  },

  async read(externalId: string): Promise<SourceReadResult> {
    const filePath = await locate(externalId);
    if (!filePath) throw new Error(`Claude 会话不存在：${externalId}`);
    const info = await statFile(filePath);
    const builder = new ImportedMessageBuilder();
    let firstTimestamp = "";
    let lastTimestamp = "";
    let title = "";
    let model = "";

    await forEachJsonlRecord(filePath, (raw) => {
      if (!raw || typeof raw !== "object") return;
      const record = raw as Record<string, unknown>;
      if (record.isSidechain === true) return; // 子代理侧链不是主对话
      const type = record.type;
      if (type !== "user" && type !== "assistant") {
        if (type === "ai-title" && !title) title = textOf(record.aiTitle);
        return;
      }
      const timestamp = textOf(record.timestamp);
      if (timestamp && !firstTimestamp) firstTimestamp = timestamp;
      if (timestamp) lastTimestamp = timestamp;

      const message = (record.message ?? {}) as Record<string, unknown>;
      const blocks = extractBlocks(message.content);
      const messageModel = textOf(message.model);
      if (messageModel) model = messageModel;
      if (!title && type === "user") title = pickTitleFrom(blocks.texts);

      if (type === "user") {
        builder.push("user", blocks.text, timestamp);
        for (const call of blocks.toolUses) builder.addToolUse(call.id, call.name, call.args, timestamp, model);
        for (const result of blocks.toolResults) builder.addToolResult(result.id, result.result, result.isError, timestamp);
        return;
      }
      builder.push("agent", blocks.text, timestamp, { reasoning: blocks.reasoning, model: messageModel });
      for (const call of blocks.toolUses) builder.addToolUse(call.id, call.name, call.args, timestamp, messageModel);
      for (const result of blocks.toolResults) builder.addToolResult(result.id, result.result, result.isError, timestamp);
    });

    const messages = builder.build();
    // 头扫描没挑到标题时不再回退到原始文本：那多半是注入包装串，不如老实用会话 id
    const resolvedTitle = title || externalId;
    const summary: SourceSessionSummary = {
      externalId,
      title: resolvedTitle,
      createdAt: normalizeTime(firstTimestamp, info?.mtimeMs),
      updatedAt: normalizeTime(lastTimestamp, info?.mtimeMs),
      messageCount: messages.length,
      workspace: path.basename(path.dirname(filePath)),
      fingerprint: info ? fingerprintOf(info) : "",
      path: filePath,
    };
    return { summary, messages };
  },
};

async function locate(externalId: string): Promise<string | null> {
  const root = claudeRoot();
  let projectDirs: string[];
  try {
    projectDirs = (await readdir(root, { withFileTypes: true }))
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name);
  } catch {
    return null;
  }
  const target = `${externalId}.jsonl`;
  const matches: Array<{ filePath: string; mtimeMs: number }> = [];
  for (const project of projectDirs) {
    const candidate = path.join(root, project, target);
    const info = await statFile(candidate);
    if (info) matches.push({ filePath: candidate, mtimeMs: info.mtimeMs });
  }
  if (!matches.length) return null;
  matches.sort((left, right) => right.mtimeMs - left.mtimeMs);
  return matches[0].filePath;
}

function normalizeTime(value: string, fallbackMs: number | undefined): string {
  if (value) {
    const date = new Date(value);
    if (!Number.isNaN(date.getTime())) return date.toISOString();
  }
  return new Date(fallbackMs ?? 0).toISOString();
}
