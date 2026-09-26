/**
 * 上下文统计辅助（磁贴第二页上下文指标的后端数据源）：
 * - 上下文窗口按模型标准映射；模型未知用通用默认值
 * - usage 归一化：统一从 OpenAI 兼容响应提取 prompt / completion / cached tokens
 */

import type { ContextStats, ModelUsage } from "./types.js";

/** 常见模型上下文窗口（tokens）。值取各家官方文档常用档位。 */
const WINDOW_BY_MODEL_PREFIX: Record<string, number> = {
  "qwen-plus": 131_072,
  "qwen-max": 131_072,
  "qwen-turbo": 1_048_576,
  "qwen-long": 10_485_760,
  "qwen3": 131_072,
  "qwen2.5": 131_072,
  "deepseek-chat": 65_536,
  "deepseek-reasoner": 65_536,
  "gpt-4o": 128_000,
  "gpt-4.1": 1_047_576,
  "gpt-4": 8_192,
  "gpt-3.5-turbo": 16_385,
};

/** 未知模型通用默认窗口（按 qwen-plus 量级） */
const DEFAULT_CONTEXT_WINDOW = 131_072;

/** 环境变量覆盖：MOMOKA_CONTEXT_WINDOW=131072 */
function envWindow(): number | null {
  const raw = process.env.MOMOKA_CONTEXT_WINDOW?.trim();
  if (!raw) return null;
  const value = Number(raw);
  return Number.isFinite(value) && value > 0 ? Math.floor(value) : null;
}

export function modelContextWindow(model: string | undefined, configuredWindow?: number): number {
  const override = envWindow();
  if (override !== null) return override;
  if (typeof configuredWindow === "number" && Number.isSafeInteger(configuredWindow) && configuredWindow > 0) {
    return configuredWindow;
  }
  const key = (model ?? "").toLowerCase();
  for (const [prefix, windowSize] of Object.entries(WINDOW_BY_MODEL_PREFIX)) {
    if (key.startsWith(prefix)) return windowSize;
  }
  return DEFAULT_CONTEXT_WINDOW;
}

/** 从 OpenAI 兼容 usage 原始对象提取归一化 ModelUsage；缺失字段为 undefined */
export function normalizeUsage(raw: unknown): ModelUsage | undefined {
  if (typeof raw !== "object" || raw === null) return undefined;
  const value = raw as Record<string, unknown>;
  const details = (typeof value.prompt_tokens_details === "object" && value.prompt_tokens_details !== null
    ? value.prompt_tokens_details as Record<string, unknown>
    : {}) as Record<string, unknown>;
  const usages: Array<number | null> = [value.prompt_tokens, value.completion_tokens, value.total_tokens, details.cached_tokens].map((item) =>
    typeof item === "number" ? item : null,
  );
  if (usages.every((item) => item === null)) return undefined;
  const result: ModelUsage = {};
  if (typeof value.prompt_tokens === "number") result.promptTokens = value.prompt_tokens;
  if (typeof value.completion_tokens === "number") result.completionTokens = value.completion_tokens;
  if (typeof value.total_tokens === "number") result.totalTokens = value.total_tokens;
  if (typeof details.cached_tokens === "number") result.cachedTokens = details.cached_tokens;
  return result;
}

/** 组装 Agent 的上下文统计（窗口按模型，cached 未知为 null） */
export function buildContextStats(
  usage: ModelUsage,
  model: string | undefined,
  configuredWindow?: number,
  now = new Date(),
): ContextStats {
  return {
    promptTokens: usage.promptTokens ?? 0,
    contextWindow: modelContextWindow(model, configuredWindow),
    cachedTokens: usage.cachedTokens ?? null,
    updatedAt: now.toISOString(),
  };
}
