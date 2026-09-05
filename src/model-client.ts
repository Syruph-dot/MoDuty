import { executeToolCall, TOOL_SPECS } from "./tools.js";
import { loadSettings } from "./settings-store.js";
import { appendTraceEvent } from "./trace.js";
import { normalizeUsage } from "./context-stats.js";
import { readFile } from "node:fs/promises";
import path from "node:path";
import type { ModelClient, ModelRunContext, ModelRunResult, ModelUsage, StreamEvent, ToolCall } from "./types.js";

type FetchLike = typeof fetch;

export type ModelTier = "high" | "low" | "exact";

interface ModelTierConfig {
  model: string;
  baseUrl: string;
  description: string;
}

interface ModelTiersFile {
  tiers: Record<ModelTier, ModelTierConfig>;
  defaultTier: ModelTier;
  exactModelEnvVar: string;
}

const DEFAULT_DASHSCOPE = "https://dashscope.aliyuncs.com/compatible-mode/v1";

let cachedTiers: ModelTiersFile | null = null;

async function loadModelTiers(): Promise<ModelTiersFile> {
  if (cachedTiers) return cachedTiers;
  const configPath = path.join(process.cwd(), "config", "model-tiers.json");
  try {
    const content = await readFile(configPath, "utf8");
    cachedTiers = JSON.parse(content) as ModelTiersFile;
    return cachedTiers!;
  } catch {
    // 回退到硬编码默认值
    cachedTiers = {
      tiers: {
        high: { model: "qwen-max", baseUrl: DEFAULT_DASHSCOPE, description: "复杂推理、代码生成、高质量输出" },
        low: { model: "qwen-turbo", baseUrl: DEFAULT_DASHSCOPE, description: "日报生成、简单分类、闲聊、低成本批量" },
        exact: { model: "", baseUrl: "", description: "手动指定精确模型" },
      },
      defaultTier: "high",
      exactModelEnvVar: "MOMOKA_EXACT_MODEL",
    };
    return cachedTiers;
  }
}

/** 根据 tier 解析模型配置 */
export async function resolveModelConfigByTier(
  tier: ModelTier = "high",
  overrides: { apiKey?: string; baseUrl?: string; model?: string } = {},
): Promise<{ apiKey: string; baseUrl: string; model: string; tier: ModelTier }> {
  const settings = await loadSettings();
  const tiers = await loadModelTiers();

  const apiKey = overrides.apiKey || settings.apiKey || process.env.OPENAI_API_KEY || "";

  if (tier === "exact") {
    // exact 模式：必须显式提供 model 和 baseUrl（通过 overrides 或环境变量）
    const exactModel = overrides.model || process.env[tiers.exactModelEnvVar] || "";
    const exactBaseUrl = overrides.baseUrl || process.env.OPENAI_BASE_URL || DEFAULT_DASHSCOPE;
    if (!exactModel) {
      throw new Error(`exact 模式要求指定模型：通过参数 model 或环境变量 ${tiers.exactModelEnvVar}`);
    }
    return {
      apiKey,
      baseUrl: exactBaseUrl.replace(/\/+$/u, ""),
      model: exactModel,
      tier,
    };
  }

  const tierConfig = tiers.tiers[tier] ?? tiers.tiers.high;
  const baseUrl = (overrides.baseUrl || tierConfig.baseUrl || settings.baseUrl || process.env.OPENAI_BASE_URL || DEFAULT_DASHSCOPE).replace(/\/+$/u, "");
  const model = overrides.model || tierConfig.model || settings.model || process.env.MOMOKA_MODEL || "qwen-plus";

  return { apiKey, baseUrl, model, tier };
}

/** 兼容旧接口：默认走 high 轨道 */
export async function resolveModelConfig(
  overrides: { apiKey?: string; baseUrl?: string; model?: string } = {},
): Promise<{ apiKey: string; baseUrl: string; model: string }> {
  const { apiKey, baseUrl, model } = await resolveModelConfigByTier("high", overrides);
  return { apiKey, baseUrl, model };
}

export interface ProviderDiagnostics {
  provider: string;
  hasKey: boolean;
  issues: string[];
  keyPrefix: string;
  model: string;
  tier: ModelTier;
}

/** /api/config 的 provider 诊断 */
export async function describeEnvProviderDiagnostics(tier: ModelTier = "high"): Promise<ProviderDiagnostics> {
  const config = await resolveModelConfigByTier(tier);
  const hasKey = Boolean(config.apiKey);
  const provider = config.baseUrl ? "OpenAI (兼容)" : "未配置";
  const issues: string[] = [];
  if (!hasKey) {
    issues.push("API key 未配置。请在软件设置界面填写（保存在 ~/.momoka/settings.json），或临时设置 OPENAI_API_KEY 环境变量。");
  }
  return {
    provider,
    hasKey,
    issues,
    keyPrefix: `${config.apiKey.slice(0, 8)}...`,
    model: config.model,
    tier: config.tier,
  };
}

/** 上游非 2xx：保留 HTTP 状态码供路由层透传 */
export class UpstreamHttpError extends Error {
  constructor(readonly status: number, message: string) {
    super(message);
  }
}

/** 拉取 OpenAI 兼容上游的 /models 列表（供 /api/models） */
export async function fetchUpstreamModels(baseUrl: string, apiKey: string): Promise<string[]> {
  const upstream = await fetch(`${baseUrl}/models`, {
    headers: apiKey ? { authorization: `Bearer ${apiKey}` } : {},
  });
  if (!upstream.ok) {
    throw new UpstreamHttpError(upstream.status, `models 请求失败: HTTP ${upstream.status}`);
  }
  const data = (await upstream.json()) as { data?: Array<{ id?: string }> };
  return (data.data ?? [])
    .map((m) => m.id)
    .filter((id): id is string => typeof id === "string" && id.length > 0);
}

interface OpenAICompatibleModelClientOptions {
  apiKey?: string;
  baseUrl?: string;
  model?: string;
  fetch?: FetchLike;
  /** 工具调用轮数上限 */
  maxToolRounds?: number;
  /** 模型调用是否使用 SSE 流式 */
  stream?: boolean;
  /** 单轮模型请求超时（毫秒） */
  requestTimeoutMs?: number;
  /** 模型轨道：high | low | exact */
  tier?: ModelTier;
}

interface ChatMessage {
  role: "system" | "user" | "assistant" | "tool";
  content: string | null;
  tool_call_id?: string;
  tool_calls?: ToolCallRequest[];
}

interface ToolCallRequest {
  id: string;
  type: "function";
  function: {
    name: string;
    arguments: string;
  };
}

interface ModelRoundResult {
  content: string;
  toolCalls: ToolCallRequest[];
  usage?: ModelUsage;
}

const APPROVAL_PATTERN = /pending approval/i;

export function createOpenAICompatibleModelClient(options: OpenAICompatibleModelClientOptions = {}): ModelClient {
  const tier = options.tier ?? "high";
  const fetchImpl = options.fetch ?? fetch;
  const maxToolRounds = options.maxToolRounds ?? Infinity;
  const stream = options.stream ?? false;
  const requestTimeoutMs = options.requestTimeoutMs ?? 600_000;

  return {
    async run(input: string, context: ModelRunContext): Promise<ModelRunResult> {
      // 每次 run 重新解析：参数 > 配置文件 > 环境变量 > 默认值
      const { apiKey, baseUrl, model } = await resolveModelConfigByTier(tier, {
        apiKey: options.apiKey,
        baseUrl: options.baseUrl,
        model: options.model,
      });

      if (!apiKey) {
        throw new Error("API key 未配置：请设置 OPENAI_API_KEY 环境变量，或提供无需鉴权的 OPENAI_BASE_URL");
      }

      const messages: ChatMessage[] = [
        { role: "system", content: context.systemPrompt },
        { role: "user", content: input },
      ];
      const toolCalls: ToolCall[] = [];
      const signal = mergeSignals([context.signal, AbortSignal.timeout(requestTimeoutMs)]);
      let usagePeak: ModelUsage | undefined;

      for (let round = 0; round <= maxToolRounds; round += 1) {
        if (signal?.aborted) {
          throw new Error("请求已取消（客户端断开或超时）");
        }
        await appendTraceEvent(context.tracePath, "model_input", {
          requestKind: context.requestKind,
          input,
          model,
          tier,
        });
        const roundResult = await callModelRound({
          fetchImpl,
          baseUrl,
          apiKey,
          model,
          messages,
          signal,
          stream,
          onDelta: (text) => context.onEvent?.({ type: "token", text }),
        });
        if (roundResult.usage && typeof roundResult.usage.promptTokens === "number") {
          if (!usagePeak || (roundResult.usage.promptTokens ?? 0) > (usagePeak.promptTokens ?? 0)) {
            usagePeak = roundResult.usage;
          }
        }
        if (roundResult.toolCalls.length === 0) {
          return {
            output: roundResult.content,
            toolCalls,
            ...(usagePeak ? { usage: usagePeak } : {}),
          };
        }

        messages.push({
          role: "assistant",
          content: roundResult.content,
          tool_calls: roundResult.toolCalls,
        });

        for (const requested of roundResult.toolCalls) {
          const tool = requested.function.name;
          const args = requested.function.arguments || "{}";
          await appendTraceEvent(context.tracePath, "tool_call", {
            name: tool,
            arguments: args,
          });
          context.onEvent?.({ type: "tool_start", name: tool, args });
          const result = await executeToolCall(
            tool,
            args,
            context.workDir,
            context.tracePath,
            {
              sessionId: context.sessionId ?? undefined,
              runId: context.runId,
            },
            context.sessionManager,
            context.agentRegistry,
          );
          await appendTraceEvent(context.tracePath, "tool_result", {
            name: tool,
            result,
          });
          context.onEvent?.({ type: "tool_result", name: tool, result });
          if (APPROVAL_PATTERN.test(result)) {
            context.onEvent?.({ type: "approval_requested", name: tool, args, result });
          }
          toolCalls.push({ tool, args, result: result.slice(0, 500) });
          messages.push({
            role: "tool",
            tool_call_id: requested.id,
            content: result,
          });
        }
      }

      throw new Error(`模型工具调用超过最大轮数（${maxToolRounds} 轮仍未停止）`);
    },
  };
}

async function callModelRound(options: {
  fetchImpl: FetchLike;
  baseUrl: string;
  apiKey: string;
  model: string;
  messages: ChatMessage[];
  signal?: AbortSignal;
  stream: boolean;
  onDelta: (text: string) => void;
}): Promise<ModelRoundResult> {
  const { fetchImpl, baseUrl, apiKey, model, messages, signal, stream, onDelta } = options;
  const payload: Record<string, unknown> = {
    model,
    messages,
    tools: TOOL_SPECS,
    tool_choice: "auto",
  };
  if (stream) payload.stream = true;

  const headers: Record<string, string> = { "content-type": "application/json" };
  if (apiKey) {
    headers["authorization"] = `Bearer ${apiKey}`;
  }

  const response = await fetchImpl(`${baseUrl}/chat/completions`, {
    method: "POST",
    headers,
    body: JSON.stringify(payload),
    signal,
  });
  if (!response.ok) {
    throw new Error(`模型请求失败: HTTP ${response.status} ${await response.text()}`);
  }

  if (!stream) {
    const body = await response.json() as {
      choices?: Array<{
        message?: {
          content?: string | null;
          tool_calls?: ToolCallRequest[];
        };
      }>;
      usage?: unknown;
    };
    const message = body.choices?.[0]?.message ?? {};
    return {
      content: message.content ?? "",
      toolCalls: message.tool_calls ?? [],
      ...(body.usage ? { usage: normalizeUsage(body.usage) } : {}),
    };
  }

  return await parseSseRound(response, onDelta);
}

async function parseSseRound(response: Response, onDelta: (text: string) => void): Promise<ModelRoundResult> {
  if (!response.body) {
    return { content: "", toolCalls: [] };
  }
  const decoder = new TextDecoder();
  const contentParts: string[] = [];
  const accumulated = new Map<number, { id: string; name: string; args: string }>();
  let buffer = "";
  let done = false;
  let lastUsage: ModelUsage | undefined;

  for await (const chunk of response.body as unknown as AsyncIterable<Uint8Array>) {
    buffer += decoder.decode(chunk, { stream: true });
    let boundary: number;
    while (!done && (boundary = buffer.indexOf("\n\n")) >= 0) {
      const frame = buffer.slice(0, boundary);
      buffer = buffer.slice(boundary + 2);
      for (const line of frame.split("\n")) {
        if (!line.startsWith("data:")) continue;
        const data = line.slice(5).trim();
        if (data === "[DONE]") {
          done = true;
          break;
        }
        try {
          const parsed = JSON.parse(data) as {
            choices?: Array<{
              delta?: {
                content?: string | null;
                tool_calls?: Array<{
                  index?: number;
                  id?: string;
                  function?: { name?: string; arguments?: string };
                }>;
              };
            }>;
            usage?: unknown;
          };
          if (parsed.usage) {
            const usage = normalizeUsage(parsed.usage);
            if (usage) lastUsage = usage;
          }
          const delta = parsed.choices?.[0]?.delta ?? {};
          if (typeof delta.content === "string" && delta.content.length > 0) {
            contentParts.push(delta.content);
            onDelta(delta.content);
          }
          for (const piece of delta.tool_calls ?? []) {
            const index = piece.index ?? 0;
            const current = accumulated.get(index) ?? { id: "", name: "", args: "" };
            if (piece.id) current.id += piece.id;
            if (piece.function?.name) current.name += piece.function.name;
            if (piece.function?.arguments) current.args += piece.function.arguments;
            accumulated.set(index, current);
          }
        } catch {
          // 忽略无法解析的帧
        }
      }
    }
    if (done) break;
  }

  const toolCalls: ToolCallRequest[] = [...accumulated.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([, value]) => ({
      id: value.id,
      type: "function",
      function: { name: value.name, arguments: value.args },
    }));
  return { content: contentParts.join(""), toolCalls, ...(lastUsage ? { usage: lastUsage } : {}) };
}

function mergeSignals(signals: Array<AbortSignal | undefined>): AbortSignal | undefined {
  const present = signals.filter((signal): signal is AbortSignal => Boolean(signal));
  if (present.length === 0) return undefined;
  if (present.length === 1) return present[0];
  if (typeof AbortSignal.any === "function") return AbortSignal.any(present);
  const controller = new AbortController();
  for (const signal of present) {
    if (signal.aborted) {
      controller.abort();
      break;
    }
    signal.addEventListener("abort", () => controller.abort(), { once: true });
  }
  return controller.signal;
}