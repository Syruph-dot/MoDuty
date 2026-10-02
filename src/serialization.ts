import type { SessionMessage, SessionRecord } from "./session-manager.js";
import { readAttachmentsFromMessage, type AttachmentRef } from "./attachments.js";

/** 统一的存盘消息结构（内存态 + 落盘态字段兼容） */
export interface StoredMessage {
  id: string;                 // msg_xxx
  role: "user" | "agent" | "tool" | "system";
  content: string;
  timestamp: string;
  /** 流式状态：streaming=进行中，done=完成，stopped=主动停止，error=异常 */
  status?: "streaming" | "done" | "stopped" | "error";
  /** 工具调用（内存用 toolCalls，落盘用 tool_calls，反序列化时统一） */
  toolCalls?: StoredToolCall[];
  outputId?: string;
  matchedSkills?: string[];
  /** 流式产出的文本段（仅 agent 消息，完成时落盘） */
  segments?: string[];
  /** 时间线：文本段用 "text"，工具调用用下标（对应 toolCalls 顺序） */
  timeline?: Array<"text" | number>;
  /**
   * 仅作上下文注入：落盘给模型看，界面不渲染。
   * 例：ask_question 的答案摘要（用户看到的是问答卡里的回看 QuestionRecap）。
   */
  contextOnly?: boolean;
  /** 模型思考过程（上游 delta.reasoning / reasoning_content 累积）。落盘是为了重开窗口还能看 */
  reasoning?: string;
  /** 产出这条消息时实际使用的模型名（消息头展示用） */
  model?: string;
  /**
   * 随用户消息一起提交的附件（输入框粘贴/拖拽/选择）。
   * 落盘与回读都必须保留：历史投影要按它拼附件清单，界面要按它渲染卡片。
   */
  attachments?: AttachmentRef[];
  /** 兼容旧字段：允许任意额外键 */
  [key: string]: unknown;
}

/** 落盘时的工具调用记录 */
export interface StoredToolCall {
  tool: string;
  args: string;
  result: string;
  /** 完成时的状态 */
  status?: "running" | "done" | "error";
  /** 部分工具以布尔标记错误（与 status 二选一或并存） */
  isError?: boolean;
}

/** 一个完整的对话轮次（Turn）：用户提问 + Agent 回答（含工具调用） */
export interface Turn {
  id: string;                 // turn_xxx
  index: number;              // 1-based
  userMessage: StoredMessage;
  agentMessage?: StoredMessage;
  /** 该轮次创建时间（用户消息的时间） */
  createdAt: string;
  /** 是否已完成（agentMessage.status === 'done' 或 'error'/'stopped'） */
  completed: boolean;
}

/** 会话元数据（落盘结构） */
export interface SessionRecordV2 extends SessionRecord {
  /** 当前轮次号（下一个将创建的 turn index，从 1 开始） */
  turnIndex?: number;
  /** 最后完成的 turn id */
  lastCompletedTurnId?: string;
}

/** 将内存态消息转为落盘结构（toolCalls -> tool_calls 等） */
export function messageToDisk(message: SessionMessage): Record<string, unknown> {
  const out: Record<string, unknown> = { ...message };
  if ("toolCalls" in out) {
    out.tool_calls = out.toolCalls;
    delete out.toolCalls;
  }
  if ("outputId" in out) {
    out.output_id = out.outputId;
    delete out.outputId;
  }
  if ("matchedSkills" in out) {
    out.matched_skills = out.matchedSkills;
    delete out.matchedSkills;
  }
  return out;
}

/** 将落盘结构转为内存态消息（tool_calls -> toolCalls 等） */
export function messageFromDisk(raw: Record<string, unknown>): StoredMessage {
  const toolCalls = raw.toolCalls ?? raw.tool_calls;
  return {
    id: String(raw.id ?? ""),
    role: String(raw.role ?? "user") as StoredMessage["role"],
    content: String(raw.content ?? ""),
    timestamp: String(raw.timestamp ?? ""),
    status: raw.status as StoredMessage["status"],
    toolCalls: Array.isArray(toolCalls)
      ? toolCalls.map((tc: unknown) => {
          const t = tc as Record<string, unknown>;
          return {
            tool: String(t.tool ?? t.name ?? ""),
            args: String(t.args ?? t.arguments ?? "{}"),
            result: String(t.result ?? t.output ?? ""),
            status: t.status as StoredToolCall["status"],
            isError: typeof t.isError === "boolean" ? t.isError : undefined,
          };
        })
      : undefined,
    outputId: raw.output_id ? String(raw.output_id) : raw.outputId ? String(raw.outputId) : undefined,
    matchedSkills: Array.isArray(raw.matched_skills)
      ? raw.matched_skills.map((s: unknown) => String(s))
      : Array.isArray(raw.matchedSkills)
        ? raw.matchedSkills.map((s: unknown) => String(s))
        : undefined,
    segments: Array.isArray(raw.segments) ? raw.segments.map((s: unknown) => String(s)) : undefined,
    timeline: Array.isArray(raw.timeline)
      ? raw.timeline.map((t: unknown) => (t === "text" ? "text" : Number(t)))
      : undefined,
    // 仅上下文注入（界面不渲染，模型仍看得到）：读盘必须保留，否则前端拿不到标记
    ...(raw.contextOnly === true || raw.context_only === true ? { contextOnly: true } : {}),
    ...(typeof raw.reasoning === "string" && raw.reasoning ? { reasoning: raw.reasoning } : {}),
    ...(typeof raw.model === "string" && raw.model ? { model: raw.model } : {}),
    // 附件：磁盘形状不被信任，逐字段校验后再回读（形状不对的项丢弃，不炸整轮）
    ...((): { attachments?: AttachmentRef[] } => {
      const attachments = readAttachmentsFromMessage(raw.attachments);
      return attachments.length > 0 ? { attachments } : {};
    })(),
  };
}

/** 从消息列表构建 Turn 列表（幂等：相同 message.id 只保留第一次出现） */
export function buildTurns(messages: StoredMessage[]): Turn[] {
  const turns: Turn[] = [];
  const seen = new Set<string>();

  let currentTurn: Turn | null = null;
  let turnIndex = 0;

  for (const msg of messages) {
    // 去重：相同 message.id 只保留首次出现（流式中间态会被后续完成态覆盖，这里取第一个非 streaming 的，或最后一个）
    if (seen.has(msg.id)) {
      continue;
    }
    seen.add(msg.id);

    if (msg.role === "user") {
      // 保存上一轮
      if (currentTurn) {
        turns.push(currentTurn);
      }
      turnIndex += 1;
      currentTurn = {
        id: `turn_${turnIndex}`,
        index: turnIndex,
        userMessage: msg,
        createdAt: msg.timestamp,
        completed: false,
      };
    } else if (msg.role === "agent" && currentTurn) {
      currentTurn.agentMessage = msg;
      currentTurn.completed = msg.status !== "streaming";
    }
    // tool 消息不单独开轮次，归属到当前 agentMessage（通过 toolCalls 关联）
  }

  if (currentTurn) {
    turns.push(currentTurn);
  }

  return turns;
}

/** 将 Turn 列表转为 transcript.md 明文（仅 completed=true 的轮次） */
export function turnsToTranscript(turns: Turn[], sessionName: string, sessionId: string, goal: string, createdAt: string): string {
  const lines: string[] = [];
  lines.push(`# Session: ${sessionName} (${sessionId})`);
  lines.push(`goal: ${goal}`);
  lines.push(`created: ${createdAt}`);
  lines.push(`turns: ${turns.length}`);
  lines.push("");

  for (const turn of turns) {
    if (!turn.completed) continue; // 只输出已完成的轮次
    lines.push(`## Turn ${turn.index} · user · ${turn.userMessage.timestamp}`);
    lines.push("");
    lines.push(turn.userMessage.content || "");
    if (turn.agentMessage) {
      lines.push(`## Turn ${turn.index} · agent · ${turn.agentMessage.timestamp}`);
      lines.push("");
      lines.push(turn.agentMessage.content || "");
      for (const call of turn.agentMessage.toolCalls ?? []) {
        const result = call.result.length > 2000 ? `${call.result.slice(0, 2000)}…[截断]` : call.result;
        lines.push(`🔧 ${call.tool}(${call.args}) -> ${result}`);
      }
    }
    lines.push("");
  }

  return lines.join("\n");
}

/** 增量追加：仅把新完成的轮次追加到 transcript.md */
export function appendTurnToTranscript(turn: Turn): string {
  if (!turn.completed || !turn.agentMessage) return "";
  const lines: string[] = [];
  lines.push(`## Turn ${turn.index} · user · ${turn.userMessage.timestamp}`);
  lines.push("");
  lines.push(turn.userMessage.content || "");
  lines.push(`## Turn ${turn.index} · agent · ${turn.agentMessage.timestamp}`);
  lines.push("");
  lines.push(turn.agentMessage.content || "");
  for (const call of turn.agentMessage.toolCalls ?? []) {
    const result = call.result.length > 2000 ? `${call.result.slice(0, 2000)}…[截断]` : call.result;
    lines.push(`🔧 ${call.tool}(${call.args}) -> ${result}`);
  }
  lines.push("");
  return lines.join("\n");
}