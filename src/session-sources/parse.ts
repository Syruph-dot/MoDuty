import { stat } from "node:fs/promises";
import { createReadStream } from "node:fs";
import { createInterface } from "node:readline";

import type { StoredToolCall } from "../serialization.js";
import type { ExternalSessionSource, ImportedMessage } from "./types.js";

/** 单会话正文读取上限：个别 codex 会话达 80 MB，超过此值视为异常数据并跳过 */
export const MAX_SESSION_BYTES = 256 * 1024 * 1024;

/**
 * 列表阶段的标题扫描预算。
 *
 * 不能只读固定大小的头部：实测 Codex 会话的前 7 行是 session_meta 加两条巨大的
 * developer 系统指令（约 128 KB），真正的用户提问在第 8 行之后。所以这里改成
 * 「流式逐行读到命中就停，最多读这么多个字节」——正常会话只读几十 KB 就拿到标题。
 */
export const TITLE_SCAN_BYTES = 512 * 1024;

export interface FileStat {
  sizeBytes: number;
  mtimeMs: number;
}

export async function statFile(filePath: string): Promise<FileStat | null> {
  try {
    const info = await stat(filePath);
    if (!info.isFile()) return null;
    return { sizeBytes: info.size, mtimeMs: info.mtimeMs };
  } catch {
    return null;
  }
}

/** 内容指纹：size + mtime。用于同步时短路「未变化」，不做内容哈希（1.1 GB 级来源承受不起） */
export function fingerprintOf(stat: FileStat): string {
  return `${stat.sizeBytes}-${Math.round(stat.mtimeMs)}`;
}

/**
 * 逐行读取直到 `visit` 返回 true 或读到 maxBytes 为止。
 * 头部标题探测专用：避免为了拿标题把整个 80 MB 会话读一遍。
 */
export async function scanJsonlUntil(
  filePath: string,
  maxBytes: number,
  visit: (record: unknown) => boolean | void,
): Promise<void> {
  const stream = createReadStream(filePath, { encoding: "utf8" });
  const reader = createInterface({ input: stream, crlfDelay: Infinity });
  let consumed = 0;
  try {
    for await (const line of reader) {
      consumed += Buffer.byteLength(line, "utf8") + 1;
      if (line.trim()) {
        let record: unknown = null;
        try {
          record = JSON.parse(line) as unknown;
        } catch {
          record = null;
        }
        if (record !== null && visit(record) === true) break;
      }
      if (consumed >= maxBytes) break;
    }
  } finally {
    reader.close();
    stream.destroy();
  }
}

/** 逐行解析 JSONL；坏行计数而不抛错（外部来源格式随版本漂移是常态） */
export async function forEachJsonlRecord(
  filePath: string,
  visit: (record: unknown) => void,
): Promise<{ lines: number; badLines: number }> {
  const stream = createReadStream(filePath, { encoding: "utf8" });
  const reader = createInterface({ input: stream, crlfDelay: Infinity });
  let lines = 0;
  let badLines = 0;
  try {
    for await (const line of reader) {
      if (!line.trim()) continue;
      lines += 1;
      try {
        visit(JSON.parse(line) as unknown);
      } catch {
        badLines += 1;
      }
    }
  } finally {
    reader.close();
    stream.destroy();
  }
  return { lines, badLines };
}

export interface ExtractedBlocks {
  /** 所有文本块拼起来的正文 */
  text: string;
  /** 逐个文本块（拼之前）；挑标题时需要按块判断，以跳开注入型包装文本 */
  texts: string[];
  reasoning: string;
  toolUses: Array<{ id: string; name: string; args: string }>;
  toolResults: Array<{ id: string; result: string; isError: boolean }>;
}

function asString(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function safeJson(value: unknown): string {
  if (typeof value === "string") return value;
  if (value === undefined || value === null) return "{}";
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

/** 把 content（string / block 数组 / 单 block）拍平成纯文本，供 tool_result 等嵌套内容使用 */
export function flattenText(content: unknown): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) return content.map(flattenText).filter(Boolean).join("\n");
  if (content && typeof content === "object") {
    const obj = content as Record<string, unknown>;
    if (typeof obj.text === "string") return obj.text;
    if (typeof obj.thinking === "string") return obj.thinking;
    if (obj.content !== undefined) return flattenText(obj.content);
    if (obj.output !== undefined) return flattenText(obj.output);
  }
  return "";
}

/**
 * 抽取一条消息的 content。
 *
 * 同时兼容两族命名：Claude/Proma 的 `text` / `thinking` / `tool_use` / `tool_result`，
 * 以及 Codex 的 `input_text` / `output_text` / `function_call` / `custom_tool_call(_output)`。
 */
export function extractBlocks(content: unknown): ExtractedBlocks {
  const texts: string[] = [];
  const reasonings: string[] = [];
  const toolUses: ExtractedBlocks["toolUses"] = [];
  const toolResults: ExtractedBlocks["toolResults"] = [];

  const visit = (value: unknown): void => {
    if (typeof value === "string") {
      if (value) texts.push(value);
      return;
    }
    if (Array.isArray(value)) {
      for (const item of value) visit(item);
      return;
    }
    if (!value || typeof value !== "object") return;
    const obj = value as Record<string, unknown>;
    const type = asString(obj.type);
    switch (type) {
      case "text":
      case "input_text":
      case "output_text": {
        const text = asString(obj.text);
        if (text) texts.push(text);
        return;
      }
      case "thinking":
      case "reasoning": {
        const text = asString(obj.thinking) || asString(obj.text);
        if (text) reasonings.push(text);
        return;
      }
      case "tool_use": {
        toolUses.push({ id: asString(obj.id), name: asString(obj.name) || "tool", args: safeJson(obj.input) });
        return;
      }
      case "function_call":
      case "custom_tool_call":
      case "local_shell_call": {
        toolUses.push({
          id: asString(obj.call_id) || asString(obj.id),
          name: asString(obj.name) || type,
          args: safeJson(obj.arguments ?? obj.input ?? obj.action),
        });
        return;
      }
      case "tool_result": {
        toolResults.push({
          id: asString(obj.tool_use_id) || asString(obj.call_id) || asString(obj.id),
          result: flattenText(obj.content ?? obj.output),
          isError: obj.is_error === true,
        });
        return;
      }
      case "function_call_output":
      case "custom_tool_call_output": {
        toolResults.push({
          id: asString(obj.call_id) || asString(obj.id),
          result: flattenText(obj.output ?? obj.content),
          isError: obj.is_error === true,
        });
        return;
      }
      default:
        break;
    }
    // 未知 type：尽量保数据而不是丢弃
    if (typeof obj.text === "string") {
      if (obj.text) texts.push(obj.text);
      return;
    }
    if (typeof obj.thinking === "string") {
      if (obj.thinking) reasonings.push(obj.thinking);
      return;
    }
    if (obj.content !== undefined) visit(obj.content);
  };

  visit(content);
  return {
    text: texts.join("\n").trim(),
    texts,
    reasoning: reasonings.join("\n").trim(),
    toolUses,
    toolResults,
  };
}

/**
 * 顺序装配导入消息。
 *
 * 外部格式里 tool_use 与 tool_result 分属不同记录（Claude/Proma 的 tool_result 甚至落在
 * user 记录里），所以用 pending 映射把结果回填到对应的工具调用，而不是产出孤立消息。
 */
export class ImportedMessageBuilder {
  private readonly messages: ImportedMessage[] = [];
  private readonly pending = new Map<string, { messageIndex: number; callIndex: number }>();
  private currentAgentIndex: number | null = null;

  push(
    role: ImportedMessage["role"],
    content: string,
    timestamp: string,
    extra?: { reasoning?: string; model?: string },
  ): void {
    const trimmed = content.trim();
    const reasoning = extra?.reasoning?.trim();
    if (!trimmed && !reasoning) return;
    this.messages.push({
      role,
      content: trimmed,
      timestamp: normalizeTimestamp(timestamp),
      ...(reasoning ? { reasoning } : {}),
      ...(extra?.model ? { model: extra.model } : {}),
    });
    if (role === "user") this.currentAgentIndex = null;
    else if (role === "agent") this.currentAgentIndex = this.messages.length - 1;
  }

  /** 追加一次工具调用；同一 agent 消息内的多次调用会聚合到一个 toolCalls 数组 */
  addToolUse(id: string, name: string, args: string, timestamp: string, model?: string): void {
    if (this.currentAgentIndex === null) {
      this.messages.push({
        role: "agent",
        content: "",
        timestamp: normalizeTimestamp(timestamp),
        toolCalls: [],
        ...(model ? { model } : {}),
      });
      this.currentAgentIndex = this.messages.length - 1;
    }
    const message = this.messages[this.currentAgentIndex];
    const calls: StoredToolCall[] = message.toolCalls ?? (message.toolCalls = []);
    calls.push({ tool: name || "unknown", args: args || "{}", result: "" });
    if (id) this.pending.set(id, { messageIndex: this.currentAgentIndex, callIndex: calls.length - 1 });
  }

  addToolResult(id: string, result: string, isError: boolean, timestamp: string): void {
    const location = id ? this.pending.get(id) : undefined;
    if (location) {
      const call = this.messages[location.messageIndex]?.toolCalls?.[location.callIndex];
      if (call) {
        call.result = result;
        call.status = isError ? "error" : "done";
        if (isError) call.isError = true;
      }
      this.pending.delete(id);
      return;
    }
    // 找不到对应的 tool_use（sidechain、跨文件等）：把结果本身留下，不静默丢弃
    const trimmed = result.trim();
    if (trimmed) this.push("tool", trimmed, timestamp);
  }

  build(): ImportedMessage[] {
    return this.messages.filter((message) => message.content.length > 0 || (message.toolCalls?.length ?? 0) > 0);
  }
}

function normalizeTimestamp(value: string): string {
  if (!value) return new Date(0).toISOString();
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? new Date(0).toISOString() : date.toISOString();
}

/** 从毫秒时间戳取 ISO */
export function isoFromMs(value: unknown): string {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) return new Date(0).toISOString();
  return new Date(value).toISOString();
}

export function textOf(value: unknown): string {
  return typeof value === "string" ? value : "";
}

/** 由首条用户消息生成标题（外部来源多数没有标题字段） */
export function titleFrom(text: string, max = 60): string {
  const flat = text.replace(/\s+/gu, " ").trim();
  if (!flat) return "";
  return flat.length > max ? `${flat.slice(0, max)}…` : flat;
}

/**
 * 注入型包装文本识别。
 *
 * 实测：Claude Code 会往 user 记录里塞 `<system-reminder>` / `<local-command-caveat>`，
 * Codex 会先发一条 `<environment_context>` 再发真实提问。若不做区分，
 * 首条 user 消息会变成标题，界面上看到的全是这类包装串。
 */
const INJECTED_TAG_RE = /^<[A-Za-z][\w:.-]*(\s[^>]*)?>/u;

export function looksInjectedText(text: string): boolean {
  const trimmed = text.trimStart();
  if (!trimmed.startsWith("<")) return false;
  return INJECTED_TAG_RE.test(trimmed);
}

/** 从文本块里挑一个能当标题的——跳过注入型包装块；全是包装时宁可不给标题 */
export function pickTitleFrom(texts: readonly string[], max = 60): string {
  for (const text of texts) {
    if (looksInjectedText(text)) continue;
    const trimmed = text.trim();
    if (trimmed) return titleFrom(trimmed, max);
  }
  return "";
}

/**
 * 外部会话 id → MoDuty 会话 id。
 *
 * 确定性命名是可幂等同步的前提：同一外部会话永远落到同一条 MoDuty 会话，
 * 重复 Sync 只会更新而不会产生副本。字符集满足 session-manager 的 isSafeSessionId。
 */
export function externalSessionId(source: ExternalSessionSource, externalId: string): string {
  const slug = externalId.replace(/[^A-Za-z0-9_-]+/gu, "").slice(0, 48);
  return `ses_${source}_${slug}`;
}
