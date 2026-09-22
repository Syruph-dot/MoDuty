import { executeToolCall, TOOL_SPECS } from "./tools.js";
import { findPoolEntry, loadSettings, type ModelPoolEntry } from "./settings-store.js";
import { appendTraceEvent } from "./trace.js";
import {
  DEFAULT_RUN_BUDGET,
  checkBudget,
  checkpointPathFor,
  createCheckpoint,
  findRecordedResult,
  markStatus,
  readCheckpoint,
  recordToolCall,
  toolCallKey,
  writeCheckpoint,
  type RunBudget,
} from "./run-checkpoint.js";
import { normalizeUsage } from "./context-stats.js";
import type { ModelClient, ModelRunContext, ModelRunResult, ModelUsage, StreamEvent, ToolCall } from "./types.js";

type FetchLike = typeof fetch;

export type ModelTier = "high" | "low" | "exact";

/** 去除末尾斜杠，空值原样返回 */
function normalizeBaseUrl(value: string | undefined | null): string {
  return value ? value.replace(/\/+$/u, "") : "";
}

/** 由池条目构造运行时模型配置 */
function resolveFromEntry(entry: ModelPoolEntry, tier: ModelTier): { apiKey: string; baseUrl: string; model: string; tier: ModelTier } {
  return { apiKey: entry.apiKey ?? "", baseUrl: normalizeBaseUrl(entry.baseUrl), model: entry.model, tier };
}

/**
 * 根据 tier 解析模型配置。
 *
 * high / low / exact 本质是“模型池指针”：
 * - high / low → settings.tierDefaults.high / low 指向的池条目；
 * - exact      → tierDefaults.exact 指向的池条目，或显式 entryId / (model + baseUrl)；
 * - overrides.entryId → 直接使用指定池条目（不写死任何厂商端点）。
 */
export async function resolveModelConfigByTier(
  tier: ModelTier = "high",
  overrides: { apiKey?: string; baseUrl?: string; model?: string; entryId?: string } = {},
): Promise<{ apiKey: string; baseUrl: string; model: string; tier: ModelTier }> {
  const settings = await loadSettings();

  // 1) 显式指定池条目（最高优先）
  if (overrides.entryId) {
    const entry = settings.modelPool.find((item) => item.id === overrides.entryId);
    if (!entry) {
      throw new Error(`模型池中不存在条目「${overrides.entryId}」：请在设置页检查模型池`);
    }
    if (!entry.enabled) {
      throw new Error(`模型池条目「${entry.name}」已停用，请先在设置页启用`);
    }
    const base = resolveFromEntry(entry, tier);
    return {
      apiKey: overrides.apiKey || base.apiKey,
      baseUrl: normalizeBaseUrl(overrides.baseUrl || base.baseUrl),
      model: overrides.model || base.model,
      tier,
    };
  }

  // 2) exact：默认指针 → 否则要求显式 model（配合 baseUrl）
  if (tier === "exact") {
    const exactEntry = findPoolEntry(settings, settings.tierDefaults.exact);
    if (exactEntry) {
      const base = resolveFromEntry(exactEntry, "exact");
      return {
        apiKey: overrides.apiKey || base.apiKey,
        baseUrl: normalizeBaseUrl(overrides.baseUrl || base.baseUrl),
        model: overrides.model || base.model,
        tier,
      };
    }
    const exactModel = overrides.model || process.env.MOMOKA_EXACT_MODEL || "";
    if (!exactModel) {
      throw new Error("exact 模式未指定模型：请在设置页将某模型条目标为“精确”默认，或提供 model/entryId");
    }
    const exactBaseUrl = normalizeBaseUrl(overrides.baseUrl || process.env.OPENAI_BASE_URL);
    if (!exactBaseUrl) {
      throw new Error("exact 模式需要 Base URL：提供 baseUrl 参数，或在设置页配置模型池");
    }
    return { apiKey: overrides.apiKey || process.env.OPENAI_API_KEY || "", baseUrl: exactBaseUrl, model: exactModel, tier };
  }

  // 3) high / low：tier 默认指针 → 池条目
  const defaultEntryId = settings.tierDefaults[tier];
  const entry = findPoolEntry(settings, defaultEntryId);
  if (entry) {
    const base = resolveFromEntry(entry, tier);
    return {
      apiKey: overrides.apiKey || base.apiKey,
      baseUrl: normalizeBaseUrl(overrides.baseUrl || base.baseUrl),
      model: overrides.model || base.model,
      tier,
    };
  }

  throw new Error(
    tier === "high"
      ? "高消费默认模型未设置：请在“设置 → 模型池”中把某个模型条目标为高消费默认"
      : "低消费默认模型未设置：请在“设置 → 模型池”中把某个模型条目标为低消费默认",
  );
}

/**
 * 兼容旧接口 / 工具直连：
 * - 传了 overrides.baseUrl/model/apiKey → 直连模式（拉模型列表等场景，不要求池配置）；
 * - 否则默认走 high 轨道（tierDefaults.high 池条目）。
 */
export async function resolveModelConfig(
  overrides: { apiKey?: string; baseUrl?: string; model?: string } = {},
): Promise<{ apiKey: string; baseUrl: string; model: string }> {
  if (overrides.baseUrl || overrides.model || overrides.apiKey) {
    const baseUrl = normalizeBaseUrl(overrides.baseUrl || process.env.OPENAI_BASE_URL);
    const model = overrides.model || process.env.MOMOKA_MODEL || "";
    if (!baseUrl) {
      throw new Error("Base URL 未提供（请填写 Base URL 或设置 OPENAI_BASE_URL 环境变量）");
    }
    return { apiKey: overrides.apiKey || process.env.OPENAI_API_KEY || "", baseUrl, model };
  }
  const config = await resolveModelConfigByTier("high");
  return { apiKey: config.apiKey, baseUrl: config.baseUrl, model: config.model };
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
  let config: { apiKey: string; baseUrl: string; model: string; tier: ModelTier };
  try {
    config = await resolveModelConfigByTier(tier);
  } catch (error) {
    // 未配置模型服务时不抛错，而是以诊断信息呈现
    return {
      provider: "未配置",
      hasKey: false,
      issues: [error instanceof Error ? error.message : String(error)],
      keyPrefix: "",
      model: "",
      tier,
    };
  }
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

interface OpenAICompatibleModelClientOptions {
  apiKey?: string;
  baseUrl?: string;
  model?: string;
  fetch?: FetchLike;
  /** 工具调用轮数上限 */
  maxToolRounds?: number;
  /** 运行预算（P6）：轮次 / 工具调用次数 / 墙钟时长；缺省用 DEFAULT_RUN_BUDGET */
  budget?: Partial<RunBudget>;
  /** 模型调用是否使用 SSE 流式 */
  stream?: boolean;
  /** 单轮模型请求超时（毫秒） */
  requestTimeoutMs?: number;
  /** 模型轨道：high | low | exact */
  tier?: ModelTier;
  /**
   * 是否向模型暴露工具（默认 true）。
   * 标题生成等无需工具的调用置 false：省去整份工具规格的 token，且避免模型误触发工具执行。
   */
  tools?: boolean;
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

interface ChatMessage {
  role: "system" | "user" | "assistant" | "tool";
  content: string | null;
  tool_call_id?: string;
  tool_calls?: ToolCallRequest[];
}

/**
 * 会话里的角色名是 MoDuty 自己的（user / agent / system），而 OpenAI 兼容接口只认
 * system / user / assistant / tool。不转换会把 "agent" 直接发上去，上游一律 400 拒绝。
 * 历史为空时不会暴露这个问题（第一轮没有历史），第二轮开始才炸。
 */
function toApiRole(role: string): "system" | "user" | "assistant" {
  if (role === "system") return "system";
  if (role === "agent" || role === "assistant") return "assistant";
  return "user";
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
const QUESTION_PATTERN = /pending question/i;

export function createOpenAICompatibleModelClient(options: OpenAICompatibleModelClientOptions = {}): ModelClient {
  const tier = options.tier ?? "high";
  const fetchImpl = options.fetch ?? fetch;
  const maxToolRounds = options.maxToolRounds ?? DEFAULT_RUN_BUDGET.maxRounds;
  const stream = options.stream ?? false;
  const enableTools = options.tools !== false;
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

      // 消息数组：system（前缀不变）→ 历史（append-only）→ 本轮输入（唯一变动尾）。
      // 顺序固定的目的是让上游前缀缓存尽量命中：任何每轮变化的内容都只能放在末尾。
      const messages: ChatMessage[] = [
        { role: "system", content: context.systemPrompt },
        ...(context.historyMessages ?? []).map((message) => ({
          role: toApiRole(message.role),
          content: message.content,
        })),
        { role: "user", content: input },
      ];
      const toolCalls: ToolCall[] = [];
      const signal = mergeSignals([context.signal, AbortSignal.timeout(requestTimeoutMs)]);
      let usagePeak: ModelUsage | undefined;

      // 耐用执行（P6）：checkpoint 与 trace 同目录；若磁盘上已有同一 runId 的断点，则续用（重试/恢复不重放）
      const runId = context.runId ?? "run";
      const checkpointFile = context.tracePath ? checkpointPathFor(context.tracePath) : null;
      const budget: RunBudget = { ...DEFAULT_RUN_BUDGET, ...(options.budget ?? {}) };
      let checkpoint = createCheckpoint({
        runId,
        ...(context.sessionId ? { sessionId: context.sessionId } : {}),
        budget,
      });
      if (checkpointFile) {
        const restored = await readCheckpoint(checkpointFile).catch(() => null);
        if (restored && restored.runId === runId) checkpoint = restored;
        else await writeCheckpoint(checkpointFile, checkpoint).catch(() => undefined);
      }

      try {
        for (let round = 0; round <= maxToolRounds; round += 1) {
        if (signal?.aborted) {
          throw new Error("请求已取消（客户端断开或超时）");
        }
        await appendTraceEvent(context.tracePath, "model_input", {
          requestKind: context.requestKind,
          input,
          model,
          tier,
          // 前缀缓存诊断用：system 与 history 分离上报，便于比对相邻轮次前缀是否漂移
          systemPrompt: context.systemPrompt,
          historyMessageCount: context.historyMessages?.length ?? 0,
          historyPrefix: (context.historyMessages ?? [])
            .map((message) => `${message.role}\u0000${message.content}`)
            .join("\u0001"),
        });
        const roundResult = await callModelRound({
          fetchImpl,
          baseUrl,
          apiKey,
          model,
          messages,
          signal,
          stream,
          enableTools,
          toolSpecs: context.tools,
          onDelta: (text) => context.onEvent?.({ type: "token", text }),
          onReasoning: (text) => context.onEvent?.({ type: "reasoning", text }),
        });
        if (roundResult.usage && typeof roundResult.usage.promptTokens === "number") {
          if (!usagePeak || (roundResult.usage.promptTokens ?? 0) > (usagePeak.promptTokens ?? 0)) {
            usagePeak = roundResult.usage;
          }
        }
        if (!enableTools || roundResult.toolCalls.length === 0) {
          markStatus(checkpoint, "completed", { round });
          if (checkpointFile) await writeCheckpoint(checkpointFile, checkpoint).catch(() => undefined);
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

        // 并行工具执行：先发出所有 tool_start 事件，再并行执行无依赖的工具
        const toolCallsToExecute = roundResult.toolCalls;
        
        // 先发出所有 tool_start 事件（前端可并行显示工具卡片）
        for (const requested of toolCallsToExecute) {
          const tool = requested.function.name;
          const args = requested.function.arguments || "{}";
          await appendTraceEvent(context.tracePath, "tool_call", {
            name: tool,
            arguments: args,
          });
          context.onEvent?.({ type: "tool_start", name: tool, args });
        }

        // 预算闸门（P6）：轮次 / 工具调用次数 / 墙钟任一超限就立刻停，不再继续烧 token
        checkpoint.round = round;
        const overBudget = checkBudget(checkpoint);
        if (overBudget.exceeded) {
          markStatus(checkpoint, "budget_exceeded", { error: overBudget.reason, round });
          if (checkpointFile) await writeCheckpoint(checkpointFile, checkpoint).catch(() => undefined);
          throw new Error(overBudget.reason ?? "超出运行预算");
        }

        // 顺序执行需要审批/提问的工具，并行执行其余工具
        for (const requested of toolCallsToExecute) {
          const tool = requested.function.name;
          const args = requested.function.arguments || "{}";
          
          const key = toolCallKey(runId, round, tool, args);
          const replayed = findRecordedResult(checkpoint, key);
          let result: string;
          if (replayed !== undefined) {
            // 断点复用（P6）：重试/恢复时命中已记录的调用，不重放副作用
            result = replayed;
            await appendTraceEvent(context.tracePath, "tool_replay", { name: tool, key });
          } else {
            result = await executeToolCall(
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
            recordToolCall(checkpoint, { key, name: tool, args, result });
            if (checkpointFile) await writeCheckpoint(checkpointFile, checkpoint).catch(() => undefined);
          }

          await appendTraceEvent(context.tracePath, "tool_result", {
            name: tool,
            result,
          });
          context.onEvent?.({ type: "tool_result", name: tool, result });
          
          if (APPROVAL_PATTERN.test(result)) {
            context.onEvent?.({ type: "approval_requested", name: tool, args, result });
            // 审批需要等待用户响应，后续工具需等待
          }
          if (QUESTION_PATTERN.test(result)) {
            context.onEvent?.({ type: "question_requested", name: tool, args, result });
            // 问题需要等待用户回答，后续工具需等待
          }
          
          toolCalls.push({ tool, args, result: result.slice(0, 500) });
          messages.push({
            role: "tool",
            tool_call_id: requested.id,
            content: result,
          });
        }
        }

        // 循环走完仍未收敛：按轮次预算失败收尾，并落盘断点供恢复
        markStatus(checkpoint, "budget_exceeded", { error: `模型工具调用超过最大轮数（${maxToolRounds} 轮仍未停止）`, round: maxToolRounds });
        if (checkpointFile) await writeCheckpoint(checkpointFile, checkpoint).catch(() => undefined);
        throw new Error(`模型工具调用超过最大轮数（${maxToolRounds} 轮仍未停止）`);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        if (checkpoint.status === "running") {
          markStatus(checkpoint, /超出预算|超过最大轮数/u.test(message) ? "budget_exceeded" : "failed", { error: message });
          if (checkpointFile) await writeCheckpoint(checkpointFile, checkpoint).catch(() => undefined);
        }
        throw error;
      }
    },
  };
}

/** 单次模型调用的输出预算（含 thinking）。默认 16384，可用 MOMOKA_MAX_TOKENS 覆盖 */
function maxOutputTokens(): number {
  const raw = Number(process.env.MOMOKA_MAX_TOKENS ?? "");
  return Number.isFinite(raw) && raw >= 256 ? Math.floor(raw) : 16_384;
}

async function callModelRound(options: {
  fetchImpl: FetchLike;
  baseUrl: string;
  apiKey: string;
  model: string;
  messages: ChatMessage[];
  signal?: AbortSignal;
  stream: boolean;
  enableTools: boolean;
  /** 本轮允许模型调用的工具表（context.tools；缺省用全量 TOOL_SPECS） */
  toolSpecs?: readonly unknown[];
  onDelta: (text: string) => void;
  onReasoning: (text: string) => void;
}): Promise<ModelRoundResult> {
  const { fetchImpl, baseUrl, apiKey, model, messages, signal, stream, enableTools, toolSpecs, onDelta, onReasoning } = options;
  const payload: Record<string, unknown> = {
    model,
    messages,
    // 必须显式给输出预算：thinking 计入 completion_tokens，默认预算很容易被长思考吃光，
    // 于是 finish_reason=length、正文为空——2026-09-22 实测：模型思考 1 万字符、正文 0 字，
    // 表现成「工具轮之后不说话 / 机器人只回『（期间调用了 N 个工具）』」。
    max_tokens: maxOutputTokens(),
  };
  if (enableTools) {
    payload.tools = toolSpecs ?? TOOL_SPECS;
    payload.tool_choice = "auto";
  }
  if (stream) {
    payload.stream = true;
    // 必须显式要求 usage：OpenAI 兼容接口在流式模式下默认不返回 usage，
    // 拿不到 usage 就无法统计 token 与缓存命中（MoDuty 历史数据因此一直是 0）。
    payload.stream_options = { include_usage: true };
  }

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

  return await parseSseRound(response, onDelta, onReasoning);
}

interface DeltaWithReasoning {
  content?: string | null;
  reasoning?: string;
  reasoning_content?: string;
  tool_calls?: Array<{
    index?: number;
    id?: string;
    function?: { name?: string; arguments?: string };
  }>;
}

async function parseSseRound(response: Response, onDelta: (text: string) => void, onReasoning?: (text: string) => void): Promise<ModelRoundResult> {
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
              delta?: DeltaWithReasoning;
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
          // 推理/思考内容（DeepSeek/Qwen 等上游在 delta.reasoning 或 delta.reasoning_content 中返回）
          const reasoningText = delta.reasoning ?? delta.reasoning_content;
          if (typeof reasoningText === "string" && reasoningText.length > 0 && onReasoning) {
            onReasoning(reasoningText);
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