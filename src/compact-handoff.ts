import type { StoredMessage } from "./serialization.js";

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
    const lastAgentMessage = [...current].reverse().find((message) => message.role === "agent");
    turns.push({
      index: turns.length + 1,
      messages: current,
      userMessageId: userMessage.id,
      lastMessageId: current[current.length - 1]!.id,
      complete: Boolean(lastAgentMessage && lastAgentMessage.status !== "streaming"),
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
  return turn.messages.map((message) => {
    const lines = [`[${message.role} · ${message.id} · ${message.timestamp}]`, message.content];
    for (const call of message.toolCalls ?? []) {
      lines.push(`工具 ${call.tool}(${call.args})`, `结果：${call.result}`);
    }
    if (message.reasoning) lines.push(`思考摘要：${message.reasoning}`);
    return lines.filter(Boolean).join("\n");
  }).join("\n\n");
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
