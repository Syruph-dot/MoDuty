import { appendFile, mkdir } from "node:fs/promises";
import { createHash } from "node:crypto";
import path from "node:path";

const MAX_TRACE_STRING_LENGTH = 4_000;
const MAX_DISPLAY_STRING_LENGTH = 8_000;
const SECRET_ASSIGNMENT = /\b((?:api[_-]?key|authorization|access[_-]?token|refresh[_-]?token|id[_-]?token|token|password|passwd|secret)\b\s*[:=]\s*)(["']?)([^\s,"'`}\]]+)\2/giu;
const BEARER_TOKEN = /\b(Bearer\s+)[A-Za-z0-9._~+/=-]+/giu;
const SECRET_QUERY_PARAMETER = /([?&](?:api[_-]?key|access[_-]?token|refresh[_-]?token|token|password|secret)=)[^&\s]+/giu;
const COMMON_SECRET_TOKEN = /\b(?:sk|rk|pk|ghp|github_pat)[_-][A-Za-z0-9._-]+\b/giu;
const SENSITIVE_PATH_OR_COMMAND = /((?:"(?:path|command)"\s*:\s*|(?:path|command)\s*[:=]\s*)["']?)[^"'\n]*(?:\.env(?:\.[^"'\s]*)?|id_rsa|\.pem|credentials?|secrets?)[^"'\n]*/giu;

export async function createRunTrace(workDir: string): Promise<string> {
  const runsDirectory = path.join(workDir, "runs");
  await mkdir(runsDirectory, { recursive: true });

  const timestamp = new Date().toISOString().replace(/[.:]/gu, "-");
  for (let suffix = 0; ; suffix += 1) {
    const runDirectory = path.join(runsDirectory, suffix === 0 ? timestamp : `${timestamp}-${suffix}`);
    try {
      await mkdir(runDirectory);
      const tracePath = path.join(runDirectory, "trace.jsonl");
      await appendFile(tracePath, "", "utf8");
      return tracePath;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") {
        throw error;
      }
    }
  }
}

export async function appendTraceEvent(
  tracePath: string | undefined,
  event: string,
  details: Record<string, unknown> = {},
): Promise<void> {
  if (!tracePath) {
    return;
  }
  const record = sanitizeTraceValue({
    ...normalizeTraceDetails(event, details),
    timestamp: new Date().toISOString(),
    event,
  });
  await appendFile(tracePath, `${JSON.stringify(record)}\n`, "utf8");
}

export function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

export function containsSensitiveTraceContent(value: string): boolean {
  return redactSecrets(value) !== value;
}

export function sanitizeDisplayText(value: string): { text: string; redacted: boolean; truncated: boolean } {
  const redactedValue = redactSecrets(value);
  const truncated = redactedValue.length > MAX_DISPLAY_STRING_LENGTH;
  return {
    text: truncated
      ? `${redactedValue.slice(0, MAX_DISPLAY_STRING_LENGTH)}… [truncated ${redactedValue.length - MAX_DISPLAY_STRING_LENGTH} chars]`
      : redactedValue,
    redacted: redactedValue !== value,
    truncated,
  };
}

function normalizeTraceDetails(event: string, details: Record<string, unknown>): Record<string, unknown> {
  if (event === "model_input") {
    const input = stringValue(details.input);
    const systemPrompt = stringValue(details.systemPrompt);
    const historyPrefix = stringValue(details.historyPrefix);
    return {
      requestKind: details.requestKind,
      model: details.model,
      inputLength: input.length,
      inputSha256: sha256(input),
      // 前缀缓存诊断：system 与 history 的哈希稳定则说明前缀未漂移；
      // prefixSha256 是「system + history」合并后的可缓存前缀指纹。
      systemPromptLength: systemPrompt.length,
      systemPromptSha256: sha256(systemPrompt),
      historyMessageCount: details.historyMessageCount,
      prefixSha256: sha256(`${systemPrompt}\u0000${historyPrefix}`),
    };
  }
  if (event === "tool_result") {
    const result = stringValue(details.result ?? details.resultPreview);
    return {
      name: details.name,
      resultLength: result.length,
      resultSha256: sha256(result),
      resultRedacted: containsSensitiveTraceContent(result),
    };
  }
  if (event === "final_answer") {
    const response = stringValue(details.response);
    return {
      responseLength: response.length,
      responseSha256: sha256(response),
      usage: details.usage ?? null,
      ...(details.emptyResponse ? { emptyResponse: true } : {}),
    };
  }
  return details;
}

function stringValue(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function sanitizeTraceValue(value: unknown, seen = new WeakSet<object>()): unknown {
  if (typeof value === "string") {
    return capTraceString(redactSecrets(value));
  }
  if (value === null || typeof value !== "object") {
    return value;
  }
  if (seen.has(value)) {
    return "[Circular]";
  }
  seen.add(value);
  if (Array.isArray(value)) {
    return value.map((item) => sanitizeTraceValue(item, seen));
  }
  return Object.fromEntries(
    Object.entries(value).map(([key, item]) => [key, sanitizeTraceValue(item, seen)]),
  );
}

function redactSecrets(value: string): string {
  return value
    .replace(SECRET_ASSIGNMENT, "$1[REDACTED]")
    .replace(BEARER_TOKEN, "$1[REDACTED]")
    .replace(SECRET_QUERY_PARAMETER, "$1[REDACTED]")
    .replace(COMMON_SECRET_TOKEN, "[REDACTED]")
    .replace(SENSITIVE_PATH_OR_COMMAND, "$1[REDACTED]");
}

function capTraceString(value: string): string {
  if (value.length <= MAX_TRACE_STRING_LENGTH) {
    return value;
  }
  return `${value.slice(0, MAX_TRACE_STRING_LENGTH)}… [truncated ${value.length - MAX_TRACE_STRING_LENGTH} chars]`;
}
