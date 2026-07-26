import { executeToolCall, TOOL_SPECS } from "./tools.js";
import { appendTraceEvent } from "./trace.js";
import type { ModelClient, ModelRunContext, ModelRunResult, ToolCall } from "./types.js";

type FetchLike = typeof fetch;

interface OpenAICompatibleModelClientOptions {
  apiKey?: string;
  baseUrl?: string;
  model?: string;
  fetch?: FetchLike;
  maxToolRounds?: number;
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

export function createOpenAICompatibleModelClient(options: OpenAICompatibleModelClientOptions = {}): ModelClient {
  const apiKey = options.apiKey ?? process.env.ALIYUN_API_KEY ?? process.env.OPENAI_API_KEY ?? "";
  const baseUrl = (options.baseUrl ?? process.env.OPENAI_BASE_URL ?? "https://dashscope.aliyuncs.com/compatible-mode/v1").replace(/\/+$/u, "");
  const model = options.model ?? process.env.MOMOKA_MODEL ?? "qwen-plus";
  const fetchImpl = options.fetch ?? fetch;
  const maxToolRounds = options.maxToolRounds ?? 4;

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

      for (let round = 0; round <= maxToolRounds; round += 1) {
        const payload = {
          model,
          messages,
          tools: TOOL_SPECS,
          tool_choice: "auto",
        };
        await appendTraceEvent(context.tracePath, "model_input", {
          requestKind: context.requestKind,
          input,
          model,
        });
        const response = await fetchImpl(`${baseUrl}/chat/completions`, {
          method: "POST",
          headers: {
            "content-type": "application/json",
            authorization: `Bearer ${apiKey}`,
          },
          body: JSON.stringify(payload),
        });
        if (!response.ok) {
          throw new Error(`模型请求失败: HTTP ${response.status} ${await response.text()}`);
        }
        const body = await response.json() as {
          choices?: Array<{
            message?: {
              content?: string | null;
              tool_calls?: ToolCallRequest[];
            };
          }>;
        };
        const message = body.choices?.[0]?.message ?? {};
        const requestedTools = message.tool_calls ?? [];
        if (requestedTools.length === 0) {
          return {
            output: message.content ?? "",
            toolCalls,
          };
        }

        messages.push({
          role: "assistant",
          content: message.content ?? "",
          tool_calls: requestedTools,
        });

        for (const requested of requestedTools) {
          const tool = requested.function.name;
          const args = requested.function.arguments || "{}";
          await appendTraceEvent(context.tracePath, "tool_call", {
            name: tool,
            arguments: args,
          });
          const result = await executeToolCall(tool, args, context.workDir, context.tracePath, {
            sessionId: context.sessionId ?? undefined,
            runId: context.runId,
          });
          await appendTraceEvent(context.tracePath, "tool_result", {
            name: tool,
            result,
          });
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
