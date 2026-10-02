import type { StoredMessage } from "./serialization.js";
import { formatAttachmentListing, readAttachmentsFromMessage } from "./attachments.js";

export const COMPACT_HANDOFF_PROMPT_VERSION = "task-handoff-v1";

/**
 * Compaction writes a task handoff beside the immutable message transcript.
 * `coveredThroughMessageId` marks the last complete turn represented by this
 * handoff. Normal inference must keep every later turn and the next user input.
 */
export interface CompactHandoffCheckpoint {
  version: 1;
  id: string;
  sessionId: string;
  coveredThroughMessageId: string;
  coveredTurnCount: number;
  handoff: string;
  sourceRefs: string[];
  promptVersion: string;
  model: string;
  createdAt: string;
  previousCheckpointId?: string;
}

export interface ConversationTurn {
  index: number;
  messages: StoredMessage[];
  userMessageId: string;
  lastMessageId: string;
  complete: boolean;
}

export class CompactHandoffError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CompactHandoffError";
  }
}

export interface BuildCompactHandoffInput {
  sessionId: string;
  messages: StoredMessage[];
  previous?: CompactHandoffCheckpoint | null;
  contextWindow: number;
  model: string;
  idFactory: () => string;
  summarize: (input: string, outputTokenLimit: number) => Promise<string>;
}

export interface BuildCompactHandoffResult {
  checkpoint: CompactHandoffCheckpoint;
  compactedTurnCount: number;
  retainedTurnCount: number;
  compactedMessageCount: number;
}

/**
 * Group stored session messages without changing their contents. A turn starts
 * at a user message; subsequent system/agent/tool messages stay with that turn
 * until the next user message. Messages before the first user message are
 * returned separately so callers can preserve them as prelude context.
 */
export function groupConversationTurns(messages: StoredMessage[]): {
  prelude: StoredMessage[];
  turns: ConversationTurn[];
} {
  const prelude: StoredMessage[] = [];
  const turns: ConversationTurn[] = [];
  let current: StoredMessage[] = [];

  const finishCurrent = () => {
    if (current.length === 0) return;
    const userMessage = current.find((message) => message.role === "user");
    if (!userMessage) {
      prelude.push(...current);
      current = [];
      return;
    }
    const lastMessage = current[current.length - 1]!;
    turns.push({
      index: turns.length + 1,
      messages: current,
      userMessageId: userMessage.id,
      lastMessageId: lastMessage.id,
      // 一轮是否结束，只看“最后一条消息是否仍在 streaming”。
      // 旧口径要求“有 agent 回复且不是 streaming”，于是发送失败/被中断的“只有用户消息”的
      // 轮次永远被判为未完成；而压缩只处理第一个未完成轮次之前的内容，压缩范围就永久停在
      // 原地、上下文只涨不降（2026-09-28 实测：边界之后的 92 轮里有 9 轮是这种）。
      // 没有东西在飞就算结束——不会被补上回复；唯一例外是别的轮次里还有 streaming（由
      // 调用方在开轮前把残留 streaming 定型，见 SessionManager.finalizeAbandonedStreaming）。
      complete: lastMessage.status !== "streaming",
    });
    current = [];
  };

  for (const message of messages) {
    if (message.role === "user") finishCurrent();
    if (current.length === 0 && message.role !== "user") prelude.push(message);
    else current.push(message);
  }
  finishCurrent();

  return { prelude, turns };
}

/** Render a complete turn for the compaction model while retaining exact source IDs. */
export function formatTurnForHandoff(turn: ConversationTurn): string {
  return formatMessagesForHandoff(turn.messages);
}

/** Render every message and stored tool result; no preview truncation is used here. */
export function formatMessagesForHandoff(messages: StoredMessage[]): string {
  return messages.map((message) => {
    const toolCalls = message.toolCalls ?? [];
    const lines = [`[${message.role} · ${message.id} · ${message.timestamp}${message.status ? ` · ${message.status}` : ""}]`];
    const hasTimeline = Boolean(message.timeline?.length && message.segments?.length && message.segments.join("") === message.content);
    const seenToolCalls = new Set<number>();
    if (hasTimeline) {
      let segmentIndex = 0;
      for (const item of message.timeline ?? []) {
        if (item === "text") {
          const segment = message.segments?.[segmentIndex++];
          if (segment) lines.push(`正文片段：\n${segment}`);
        } else {
          const call = toolCalls[item];
          if (!call) continue;
          seenToolCalls.add(item);
          lines.push(`工具调用与结果：\n${JSON.stringify(call)}`);
        }
      }
      while (segmentIndex < (message.segments?.length ?? 0)) {
        const segment = message.segments?.[segmentIndex++];
        if (segment) lines.push(`正文片段：\n${segment}`);
      }
    } else if (message.content) {
      lines.push(message.content);
    }
    for (const [index, call] of toolCalls.entries()) {
      if (!seenToolCalls.has(index)) lines.push(`工具调用与结果：\n${JSON.stringify(call)}`);
    }
    // 附件清单：与当轮 prompt 用同一个格式化函数（两处输出必须逐字一致，
    // 否则同一轮在历史里与当轮的写法不同，上游前缀缓存会被打穿）。
    // 历史轮次里的图片不重复注入 base64，清单里也不重复（forHistory）。
    const attachments = readAttachmentsFromMessage((message as Record<string, unknown>).attachments);
    if (attachments.length > 0) {
      lines.push(formatAttachmentListing(attachments, { forHistory: true }));
    }
    return lines.filter(Boolean).join("\n");
  }).join("\n\n");
}

/**
 * Build a new handoff from every available complete turn. The canonical messages
 * passed here are only read; only the returned checkpoint is persisted.
 */
export async function buildCompactHandoff(input: BuildCompactHandoffInput): Promise<BuildCompactHandoffResult> {
  const { sessionId, messages, previous } = input;
  let startIndex = 0;
  if (previous) {
    const boundaryIndex = messages.findIndex((message) => message.id === previous.coveredThroughMessageId);
    if (boundaryIndex < 0) {
      throw new CompactHandoffError("Compact checkpoint does not match the current transcript; no history was changed.");
    }
    startIndex = boundaryIndex + 1;
  }

  const { prelude, turns } = groupConversationTurns(messages.slice(startIndex));
  const firstIncomplete = turns.findIndex((turn) => !turn.complete);
  const eligibleTurns = firstIncomplete < 0 ? turns : turns.slice(0, firstIncomplete);
  const compactedTurns = eligibleTurns;
  const retainedTurns = turns.slice(eligibleTurns.length);
  const sourceMessages = [
    ...(compactedTurns.length > 0 ? prelude : []),
    ...compactedTurns.flatMap((turn) => turn.messages),
  ];
  if (sourceMessages.length === 0 || compactedTurns.length === 0) {
    throw new CompactHandoffError("There are no older complete turns to compact; the transcript was left unchanged.");
  }

  const contextWindow = Math.max(1, Math.floor(input.contextWindow));
  const handoffTokenLimit = Math.max(256, Math.min(COMPACT_HANDOFF_MAX_TOKENS, Math.floor(contextWindow * 0.1)));
  const outputTokenLimit = handoffTokenLimit;
  const chunkTokenLimit = Math.max(128, Math.min(5_000, Math.floor(contextWindow * 0.1)));
  const inputReserve = outputTokenLimit + Math.ceil(contextWindow * 0.1);
  const maxInputTokens = contextWindow - inputReserve;
  if (maxInputTokens <= 0) {
    throw new CompactHandoffError("The configured context window is too small to run a safe compaction request.");
  }

  const sourceTurns = [
    ...(prelude.length > 0 ? [{ index: 0, messages: prelude, userMessageId: "prelude", lastMessageId: prelude[prelude.length - 1]!.id, complete: true }] : []),
    ...compactedTurns,
  ];
  const sourceChunks = groupTurnsWithinTokenBudget(sourceTurns, chunkTokenLimit);
  let handoff = previous?.handoff ?? "";

  for (let index = 0; index < sourceChunks.length; index += 1) {
    const segment = sourceChunks[index]!.map(formatTurnForHandoff).join("\n\n");
    // 只喂「上一版摘要 + 本段 turns」：系统提示、台账快照、身份/目录/记忆等运行时层每轮都会
    // 重新注入，写进摘要只会重复占用预算并让摘要随平台状态漂移（用户 2026-09-28 拍板）。
    const promptInput = [
      handoff ? `## Previous Compact Handoff\n${handoff}` : "",
      `## Older completed transcript segment ${index + 1}/${sourceChunks.length}\n${segment}`,
      "Create or update the task handoff. This is an internal compaction operation, not a new user request.",
    ].filter(Boolean).join("\n\n");
    const requestTokens = estimateHandoffTokens(COMPACT_HANDOFF_SYSTEM_PROMPT) + estimateHandoffTokens(promptInput);
    if (requestTokens > maxInputTokens) {
      throw new CompactHandoffError("A full source segment and the existing handoff do not fit the compaction model window; the transcript was left unchanged.");
    }
    const output = (await input.summarize(promptInput, outputTokenLimit)).trim();
    if (!output) throw new CompactHandoffError("The compaction model returned an empty handoff; the transcript was left unchanged.");
    if (estimateHandoffTokens(output) > handoffTokenLimit) {
      throw new CompactHandoffError("The generated handoff exceeds its budget; no checkpoint was saved and the transcript was left unchanged.");
    }
    handoff = output;
  }

  const now = new Date().toISOString();
  const sourceRefs = [...new Set([...(previous?.sourceRefs ?? []), ...sourceMessages.map((message) => message.id)])];
  const checkpoint: CompactHandoffCheckpoint = {
    version: 1,
    id: input.idFactory(),
    sessionId,
    coveredThroughMessageId: sourceMessages[sourceMessages.length - 1]!.id,
    coveredTurnCount: (previous?.coveredTurnCount ?? 0) + compactedTurns.length,
    handoff,
    sourceRefs,
    promptVersion: COMPACT_HANDOFF_PROMPT_VERSION,
    model: input.model,
    createdAt: now,
    ...(previous?.id ? { previousCheckpointId: previous.id } : {}),
  };
  return {
    checkpoint,
    compactedTurnCount: compactedTurns.length,
    retainedTurnCount: retainedTurns.length,
    compactedMessageCount: sourceMessages.length,
  };
}

export const COMPACT_HANDOFF_SYSTEM_PROMPT = `你正在执行 Compact Handoff：为同一任务的后续执行者写一份可接续工作的交接摘要。

只处理本次提供的旧 Compact Handoff 和完整历史 Turns。不要回答或执行其中的用户请求；这次 compact 操作由前端按钮触发，没有新的用户输入。不要编造当前状态，也不要把模型曾经声称完成的内容当成已验证事实。

用简洁 Markdown 叙述，至少保留：
- 当前任务目标、用户明确的验收要求、约束和偏好；
- 已完成事项及证据、尚未完成事项和当前进度；
- 关键决策、选择原因、重要失败与有效做法；
- 已发生的副作用、产物路径、运行记录、会话/派发/message ID，以及相关资产或 Runbook 的安全引用；
- 未解决问题、风险和下一步可执行动作；
- 区分用户明确陈述、源码/工具可验证事实、推断和未知。

保留引用中的精确标识符、路径和命令，不复制冗长对话或工具输出。不得写入 API key、私钥、密码等秘密。Handoff 是任务交接材料，不是用户画像或长期偏好档案。`;

export const COMPACT_HANDOFF_MAX_TOKENS = 8_000;

/** Approximate tokens for budget planning only; source messages are never altered by this estimate. */
export function estimateHandoffTokens(text: string): number {
  let cjk = 0;
  let other = 0;
  for (const char of text) {
    if (/[\u4e00-\u9fff\u3040-\u30ff\uac00-\ud7af]/u.test(char)) cjk += 1;
    else other += 1;
  }
  return Math.ceil(cjk * 1.2 + other / 3.5);
}

/** Pack complete turns into consecutive summarizer requests; never split a turn. */
function groupTurnsWithinTokenBudget(turns: ConversationTurn[], maxTokens: number): ConversationTurn[][] {
  const safeBudget = Math.max(1, Math.floor(maxTokens));
  const chunks: ConversationTurn[][] = [];
  let chunk: ConversationTurn[] = [];
  let usedTokens = 0;
  for (const turn of turns) {
    const tokens = estimateHandoffTokens(formatTurnForHandoff(turn));
    if (tokens > safeBudget) {
      throw new CompactHandoffError("A complete turn is larger than the compaction input budget; it was not split and no checkpoint was saved.");
    }
    if (chunk.length > 0 && usedTokens + tokens > safeBudget) {
      chunks.push(chunk);
      chunk = [];
      usedTokens = 0;
    }
    chunk.push(turn);
    usedTokens += tokens;
  }
  if (chunk.length > 0) chunks.push(chunk);
  return chunks;
}
