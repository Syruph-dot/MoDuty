import { executeToolCall, TOOL_SPECS } from "./tools.js";
import { loadSettings } from "./settings-store.js";
import { appendTraceEvent } from "./trace.js";
import { normalizeUsage } from "./context-stats.js";
import type { ModelClient, ModelRunContext, ModelRunResult, ModelUsage, StreamEvent, ToolCall } from "./types.js";

type FetchLike = typeof fetch;

interface OpenAICompatibleModelClientOptions {
  apiKey?: string;
  baseUrl?: string;
  model?: string;
  fetch?: FetchLike;
  /** 工具调用轮数上限（默认无限；模型不再请求工具时自然终止，requestTimeoutMs 兜底防死循环） */
  maxToolRounds?: number;
  /** 模型调用是否使用 SSE 流式（配合 context.onEvent 消费增量 token） */
  stream?: boolean;
  /** 单轮模型请求超时（毫秒），默认不限制；为防死循环设为较大值 */
  requestTimeoutMs?: number;
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
  /** 本轮模型调用的 usage（服务商提供时） */
  usage?: ModelUsage;
}

const APPROVAL_PATTERN = /pending approval/i;
const DEFAULT_DASHSCOPE = "https://dashscope.aliyuncs.com/compatible-mode/v1";
const ZEN_BASE_PATTERN = /opencode\.ai\/zen/i;

export function createOpenAICompatibleModelClient(options: OpenAICompatibleModelClientOptions = {}): ModelClient {
  const apiKey = options.apiKey || process.env.ALIYUN_API_KEY || process.env.OPENAI_API_KEY || "";
  const baseUrl = (options.baseUrl || process.env.OPENAI_BASE_URL || DEFAULT_DASHSCOPE).replace(/\/+$/u, "");
  const model = options.model || process.env.MOMOKA_MODEL || "qwen-plus";
  const fetchImpl = options.fetch ?? fetch;
  const maxToolRounds = options.maxToolRounds ?? Infinity;
  const stream = options.stream ?? false;
  const requestTimeoutMs = options.requestTimeoutMs ?? 600_000;
  const isZen = ZEN_BASE_PATTERN.test(baseUrl);

  return {
    async run(input: string, context: ModelRunContext): Promise<ModelRunResult> {
      // 每次对话重新解析凭证：参数 > 环境变量 > 配置文件(.momoka/settings.json) > 默认值
      // 这样软件内修改设置无需重启后端即可生效
      const settings = await loadSettings();
      const apiKey =
        options.apiKey || process.env.ALIYUN_API_KEY || process.env.OPENAI_API_KEY || settings.apiKey || "";
      const baseUrl = (
        options.baseUrl || process.env.OPENAI_BASE_URL || settings.baseUrl || DEFAULT_DASHSCOPE
      ).replace(/\/+$/u, "");
      const model = options.model || process.env.MOMOKA_MODEL || settings.model || "qwen-plus";
      const isZen = ZEN_BASE_PATTERN.test(baseUrl);

      if (!apiKey && (baseUrl === DEFAULT_DASHSCOPE || isZen)) {
        if (isZen) {
          throw new Error(
            "OpenCode Zen 需要 API key：请前往 https://opencode.ai/auth 注册免费账号并获取 API key，然后设置 OPENAI_API_KEY 环境变量。"
          );
        }
        throw new Error("API key 未配置：请设置 ALIYUN_API_KEY 或 OPENAI_API_KEY，或提供无需鉴权的 OPENAI_BASE_URL");
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
        // 归集 usage：多轮工具调用时取 prompt tokens 峰值轮（代表本次 run 使用过的最大上下文）
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

  const isZen = ZEN_BASE_PATTERN.test(baseUrl);
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (apiKey) {
    if (isZen) {
      headers["x-api-key"] = apiKey;
    } else {
      headers["authorization"] = `Bearer ${apiKey}`;
    }
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
          // OpenAI 兼容流式：usage 通常在最后一个数据帧（[DONE] 前）以完整统计出现
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
