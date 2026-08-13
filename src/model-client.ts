import { executeToolCall, TOOL_SPECS } from "./tools.js";
import { appendTraceEvent } from "./trace.js";
import type { ModelClient, ModelRunContext, ModelRunResult, StreamEvent, ToolCall } from "./types.js";

type FetchLike = typeof fetch;

interface OpenAICompatibleModelClientOptions {
  apiKey?: string;
  baseUrl?: string;
  model?: string;
  fetch?: FetchLike;
  maxToolRounds?: number;
  /** 模型调用是否使用 SSE 流式（配合 context.onEvent 消费增量 token） */
  stream?: boolean;
  /** 单轮模型请求超时（毫秒），默认 120_000 */
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
}

const APPROVAL_PATTERN = /pending approval/i;

export function createOpenAICompatibleModelClient(options: OpenAICompatibleModelClientOptions = {}): ModelClient {
  const apiKey = options.apiKey ?? process.env.ALIYUN_API_KEY ?? process.env.OPENAI_API_KEY ?? "";
  const baseUrl = (options.baseUrl ?? process.env.OPENAI_BASE_URL ?? "https://dashscope.aliyuncs.com/compatible-mode/v1").replace(/\/+$/u, "");
  const model = options.model ?? process.env.MOMOKA_MODEL ?? "qwen-plus";
  const fetchImpl = options.fetch ?? fetch;
  const maxToolRounds = options.maxToolRounds ?? 4;
  const stream = options.stream ?? false;
  const requestTimeoutMs = options.requestTimeoutMs ?? 120_000;

  return {
    async run(input: string, context: ModelRunContext): Promise<ModelRunResult> {
      if (!apiKey) {
        throw new Error("API key 未配置：请设置 ALIYUN_API_KEY 或 OPENAI_API_KEY");
      }
      const messages: ChatMessage[] = [
        { role: "system", content: context.systemPrompt },
        { role: "user", content: input },
      ];
      const toolCalls: ToolCall[] = [];
      const signal = mergeSignals([context.signal, AbortSignal.timeout(requestTimeoutMs)]);

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
        if (roundResult.toolCalls.length === 0) {
          return {
            output: roundResult.content,
            toolCalls,
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
          const result = await executeToolCall(tool, args, context.workDir, context.tracePath, {
            sessionId: context.sessionId ?? undefined,
            runId: context.runId,
          });
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

      throw new Error(`模型工具调用超过最大轮数: ${maxToolRounds}`);
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

  const response = await fetchImpl(`${baseUrl}/chat/completions`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${apiKey}`,
    },
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
    };
    const message = body.choices?.[0]?.message ?? {};
    return {
      content: message.content ?? "",
      toolCalls: message.tool_calls ?? [],
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
          };
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
  return { content: contentParts.join(""), toolCalls };
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
