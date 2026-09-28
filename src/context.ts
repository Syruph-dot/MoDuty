/** Token estimate and message formatting shared by context budget checks. */
export function estimateTokens(text: string): number {
  let cjk = 0;
  let other = 0;
  for (const ch of text) {
    if (/[\u4e00-\u9fff\u3040-\u30ff\uac00-\ud7af]/u.test(ch)) cjk += 1;
    else other += 1;
  }
  return Math.ceil(cjk * 1.2 + other / 3.5);
}

export function formatMessages(messages: Array<{ role: string; content: string }>): string {
  return messages.map((message) => `[${message.role}]\n${message.content}`).join("\n\n");
}

/**
 * 对话历史投影里单条消息的字符上限。
 *
 * 上限只作用于“送进模型的历史”，不改落盘：原始 transcript、工具结果全文与
 * 会话关系图仍然能看到完整内容（实测：关系图需要发现 20 万字符之后的 &ses_ 链接）。
 * 一条异常输出（例如上游未解析的原始流，实测有一条 16 万字符）不该独自吃掉窗口。
 */
export const HISTORY_ENTRY_MAX_CHARS = 20_000;

export function capHistoryEntry(text: string, limit = HISTORY_ENTRY_MAX_CHARS): string {
  if (text.length <= limit) return text;
  return `${text.slice(0, limit)}\n…[本条内容过长已截断，共 ${text.length} 字符；完整内容仍在会话记录里]`;
}
