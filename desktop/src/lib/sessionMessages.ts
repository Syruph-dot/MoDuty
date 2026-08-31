/**
 * 落盘消息 → 展示消息序列（纯函数）。
 *
 * 背景：一次 chat 的历史在落盘时是「1 条 agent 消息 + toolCalls 数组」，而实时 SSE
 * 是「文字段 → 工具卡片 → 文字段」交错推进。若恢复时把工具整批前置，重开/刷新后
 * 顺序就会错位（工具卡片与叙述文字分离）。
 *
 * 修复：后端 chat 流程新增 `timeline`（"text" | 工具下标）与 `segments`（分段文本）
 * 字段随消息落盘；本函数按 timeline 还原真实交错顺序。旧数据（无 timeline）回退为
 * 「工具整批前置 + 完整文本」。
 */

export interface StoredToolCall {
  tool?: string;
  name?: string;
  args?: string;
  result?: string;
}

export interface StoredMessageLike {
  role: string;
  content: string;
  timestamp: string;
  status?: string;
  toolCalls?: StoredToolCall[];
  tool_calls?: StoredToolCall[];
  /** 新数据：文本段按出现顺序归档 */
  segments?: string[];
  /** 新数据：事件时间线，"text"=一段文本，number=toolCalls 下标 */
  timeline?: Array<"text" | number>;
}

export type BuiltSequenceItem =
  | { kind: "tool"; name: string; args: string; result: string }
  | { kind: "text"; content: string };

/** 单条消息的展示顺序（含工具卡片与文本段的交错还原） */
export function buildMessageSequence(message: StoredMessageLike): BuiltSequenceItem[] {
  const toolCalls = (message.toolCalls ?? message.tool_calls ?? []) as StoredToolCall[];
  const timeline = message.timeline;
  const segments = message.segments;
  const items: BuiltSequenceItem[] = [];

  if (Array.isArray(timeline) && Array.isArray(segments) && timeline.length > 0) {
    let segIdx = 0;
    for (const entry of timeline) {
      if (entry === "text") {
        const seg = segments[segIdx] ?? "";
        segIdx += 1;
        if (seg) {
          items.push({ kind: "text", content: seg });
        }
      } else if (typeof entry === "number") {
        const call = toolCalls[entry];
        if (call) {
          items.push({
            kind: "tool",
            name: String(call.tool ?? call.name ?? "tool"),
            args: String(call.args ?? "{}"),
            result: String(call.result ?? ""),
          });
        }
      }
    }
    // 兜底：timeline 截断/异常时把剩余文本段与工具补上，避免内容丢失
    for (; segIdx < segments.length; segIdx += 1) {
      if (segments[segIdx]) {
        items.push({ kind: "text", content: segments[segIdx] });
      }
    }
    return items;
  }

  // 老数据 / 无 timeline：工具整批前置，随后完整文本（与旧版一致）
  for (const call of toolCalls) {
    items.push({
      kind: "tool",
      name: String(call.tool ?? call.name ?? "tool"),
      args: String(call.args ?? "{}"),
      result: String(call.result ?? ""),
    });
  }
  if (message.content) {
    items.push({ kind: "text", content: message.content });
  }
  return items;
}

/** 从历史消息数组生成完整展示序列（保留每条消息之间的顺序） */
export function buildRestoredSequence(
  messages: StoredMessageLike[],
): Array<{ seq: BuiltSequenceItem[]; message: StoredMessageLike }> {
  return messages.map((message) => ({ seq: buildMessageSequence(message), message }));
}