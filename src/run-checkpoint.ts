import { createHash } from "node:crypto";
import { readFile, readdir } from "node:fs/promises";
import path from "node:path";

import { isRecord, readJsonObject } from "./json-file.js";
import { atomicWriteJson } from "./write-queue.js";

/**
 * 耐用执行（P6）：checkpoint、工具调用幂等、重试与死信。
 *
 * 背景：原先 `resumeRunFromSnapshot` 只恢复审批记录，不恢复模型循环位置/工具调用位置；工具循环
 * 全在内存里 —— 崩溃等于从头再来。
 *
 * 这模块提供可测的零件，接线在 model-client（每轮落盘 + 命中即复用）与 agent（重试 + 死信）：
 * - checkpoint 与 trace 同目录（`<workDir>/runs/<stamp>/checkpoint.json`），不需要新的路径约定；
 * - 工具调用幂等靠 `key = hash(runId, round, name, args)`：重试/恢复时命中已记录的 key 就直接复用结果，
 *   不再产生第二次副作用（写文件、跑命令都不会重复执行）；
 * - 失败分类决定「重试」还是「记死信」。
 */

export interface RecordedToolCall {
  key: string;
  name: string;
  argsHash: string;
  /** 结果文本（截断保存，供恢复时复用） */
  result: string;
  at: string;
}

export type RunCheckpointStatus = "running" | "completed" | "failed";

export interface RunCheckpoint {
  runId: string;
  sessionId?: string;
  round: number;
  toolCalls: RecordedToolCall[];
  planStepId?: string;
  status: RunCheckpointStatus;
  startedAt: string;
  updatedAt: string;
  lastError?: string;
  retryCount?: number;
  [key: string]: unknown;
}

/** 单条工具结果最多保存多少字符（恢复复用只需要够判断与续跑，不必存全量） */
export const RECORDED_RESULT_MAX_CHARS = 4000;
/** 死信文件最多保留多少条 */
const DEAD_LETTER_MAX = 50;

export function checkpointPathFor(tracePath: string): string {
  return path.join(path.dirname(tracePath), "checkpoint.json");
}

export function deadLetterPath(workDir: string): string {
  return path.join(workDir, "runs", "dead-letter.json");
}

/** 工具调用幂等键：同一 run 的同一轮同名同参 → 同一个 key */
export function toolCallKey(runId: string, round: number, name: string, args: string): string {
  const hash = createHash("sha256").update(`${runId}|${round}|${name}|${args}`).digest("hex").slice(0, 16);
  return `tc_${hash}`;
}

export function argsHashOf(args: string): string {
  return createHash("sha256").update(args).digest("hex").slice(0, 16);
}

export function createCheckpoint(input: {
  runId: string;
  sessionId?: string;
  planStepId?: string;
  startedAt?: string;
}): RunCheckpoint {
  const at = input.startedAt ?? new Date().toISOString();
  return {
    runId: input.runId,
    ...(input.sessionId ? { sessionId: input.sessionId } : {}),
    ...(input.planStepId ? { planStepId: input.planStepId } : {}),
    round: 0,
    toolCalls: [],
    status: "running",
    startedAt: at,
    updatedAt: at,
  };
}

export async function readCheckpoint(file: string): Promise<RunCheckpoint | null> {
  try {
    const parsed = JSON.parse(await readFile(file, "utf8")) as unknown;
    return isCheckpoint(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

export async function writeCheckpoint(file: string, checkpoint: RunCheckpoint): Promise<void> {
  await atomicWriteJson(file, checkpoint);
}

/** 记录一次工具调用（返回同一条对象的更新结果，便于链式写盘） */
export function recordToolCall(
  checkpoint: RunCheckpoint,
  call: { key: string; name: string; args: string; result: string; at?: string },
): RunCheckpoint {
  checkpoint.toolCalls.push({
    key: call.key,
    name: call.name,
    argsHash: argsHashOf(call.args),
    result: call.result.slice(0, RECORDED_RESULT_MAX_CHARS),
    at: call.at ?? new Date().toISOString(),
  });
  checkpoint.updatedAt = call.at ?? new Date().toISOString();
  return checkpoint;
}

/** 命中已记录的工具调用 → 直接复用结果（恢复时不重放副作用） */
export function findRecordedResult(checkpoint: RunCheckpoint | null, key: string): string | undefined {
  return checkpoint?.toolCalls.find((call) => call.key === key)?.result;
}

export function markStatus(
  checkpoint: RunCheckpoint,
  status: RunCheckpointStatus,
  detail?: { error?: string; round?: number },
): RunCheckpoint {
  checkpoint.status = status;
  if (typeof detail?.round === "number") checkpoint.round = detail.round;
  if (detail?.error) checkpoint.lastError = detail.error.slice(0, 2000);
  checkpoint.updatedAt = new Date().toISOString();
  return checkpoint;
}

/** 可重试的失败特征：上游空流、网络抖动、超时、5xx */
const RETRYABLE_PATTERN = /(超时|timeout|timed out|ECONNRESET|ETIMEDOUT|ECONNREFUSED|EAI_AGAIN|socket hang up|fetch failed|network|aborted|空流|empty (?:stream|response)|HTTP 5\d\d|\b50[234]\b)/iu;
/** 明确不可重试：配置错误与请求非法，重试只会再撞一次 */
const FATAL_PATTERN = /(API key 未配置|invalid|400|401|403|404)/iu;

/**
 * 分类失败：可重试（网络/空流/5xx）还是致命（配置错误、请求非法）。
 * 额外支持「空输出也算可重试」——上游偶发只回 1 个帧、无内容是已知现象。
 */
export function classifyRunFailure(error: unknown, options: { outputText?: string } = {}): "retryable" | "fatal" {
  const text = options.outputText ?? "";
  if (text.trim() === "" && options.outputText !== undefined) return "retryable";
  const message = error instanceof Error ? error.message : String(error ?? "");
  if (FATAL_PATTERN.test(message)) return "fatal";
  if (RETRYABLE_PATTERN.test(message)) return "retryable";
  return "fatal";
}

/** 指数退避（不含抖动，抖动由调用方决定）：base * 2^(attempt-1)，封顶 maxMs */
export function backoffDelayMs(attempt: number, options: { baseMs?: number; maxMs?: number } = {}): number {
  const base = options.baseMs ?? 500;
  const max = options.maxMs ?? 8000;
  const index = Math.max(1, Math.floor(attempt));
  return Math.min(max, base * 2 ** (index - 1));
}

export interface RetryInfo {
  attempt: number;
  delayMs: number;
  error: unknown;
  classification: "retryable" | "fatal";
}

/**
 * 带退避的重试包装。只在 `retryable` 时重试；耗尽后抛出最后一次错误。
 * `sleep` 可注入，测试无需真的等。
 */
export async function withRetry<T>(
  fn: (attempt: number) => Promise<T>,
  options: {
    attempts?: number;
    baseMs?: number;
    maxMs?: number;
    sleep?: (ms: number) => Promise<void>;
    classify?: (error: unknown) => "retryable" | "fatal";
    onRetry?: (info: RetryInfo) => void;
  } = {},
): Promise<T> {
  const attempts = Math.max(1, options.attempts ?? 3);
  const sleep = options.sleep ?? (async (ms: number) => { await new Promise((resolve) => setTimeout(resolve, ms)); });
  const classify = options.classify ?? ((error: unknown) => classifyRunFailure(error));
  let lastError: unknown;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      return await fn(attempt);
    } catch (error) {
      lastError = error;
      const classification = classify(error);
      const exhausted = attempt >= attempts;
      if (classification === "fatal" || exhausted) {
        throw error;
      }
      const delayMs = backoffDelayMs(attempt, { baseMs: options.baseMs, maxMs: options.maxMs });
      options.onRetry?.({ attempt, delayMs, error, classification });
      await sleep(delayMs);
    }
  }
  throw lastError;
}

export interface DeadLetterEntry {
  runId: string;
  sessionId?: string;
  reason: string;
  error: string;
  attempts: number;
  at: string;
  workDir?: string;
}

/** 记录一封死信（重试耗尽的运行） */
export async function appendDeadLetter(workDir: string, entry: Omit<DeadLetterEntry, "at"> & { at?: string }): Promise<DeadLetterEntry> {
  const file = deadLetterPath(workDir);
  const payload = await readJsonObject(file);
  const existing = Array.isArray(payload.entries)
    ? (payload.entries.filter(isRecord) as unknown as DeadLetterEntry[])
    : [];
  const record: DeadLetterEntry = { ...entry, at: entry.at ?? new Date().toISOString() };
  const next = [...existing, record].slice(-DEAD_LETTER_MAX);
  await atomicWriteJson(file, { entries: next });
  return record;
}

export async function readDeadLetters(workDir: string): Promise<DeadLetterEntry[]> {
  const payload = await readJsonObject(deadLetterPath(workDir));
  return Array.isArray(payload.entries) ? (payload.entries.filter(isRecord) as unknown as DeadLetterEntry[]) : [];
}

/** 按 runId 在 `<workDir>/runs/<run>/` 下反查断点（恢复入口用：调用方只有 runId 时能找到断点） */
export async function findCheckpointByRunId(
  workDir: string,
  runId: string,
): Promise<{ file: string; checkpoint: RunCheckpoint } | null> {
  const runsDir = path.join(workDir, "runs");
  const entries = await readdir(runsDir, { withFileTypes: true }).catch(() => []);
  const dirs = entries.filter((entry) => entry.isDirectory()).map((entry) => entry.name).sort().reverse();
  for (const dir of dirs) {
    const file = path.join(runsDir, dir, "checkpoint.json");
    const checkpoint = await readCheckpoint(file);
    if (checkpoint && checkpoint.runId === runId) return { file, checkpoint };
  }
  return null;
}

function isCheckpoint(value: unknown): value is RunCheckpoint {
  if (!isRecord(value)) return false;
  if (typeof value.runId !== "string" || typeof value.startedAt !== "string") return false;
  return Array.isArray(value.toolCalls);
}
