import type { ContentPart, MessageContent } from "./types.js";

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

/**
 * 单张图片的 token 估算。
 *
 * 图片 token 由边长决定，跟 base64 字符数不是线性关系，这里不引图像解码库去量真实尺寸，
 * 只按体积给一个偏中上界的保守值：估高只会让压缩提前触发（安全），估低会直接把请求顶爆。
 */
export const IMAGE_TOKEN_ESTIMATE_MIN = 1_200;
export const IMAGE_TOKEN_ESTIMATE_MAX = 6_000;

export function estimateImageTokens(base64Length: number): number {
  const estimate = Math.round(base64Length / 1_500);
  return Math.min(IMAGE_TOKEN_ESTIMATE_MAX, Math.max(IMAGE_TOKEN_ESTIMATE_MIN, estimate));
}

/** 内容块 → 纯文本（token 估算与历史投影用；图片只留一行占位说明） */
export function contentToText(content: MessageContent | null | undefined): string {
  if (content == null) return "";
  if (typeof content === "string") return content;
  return content
    .map((part) => (part.type === "text" ? part.text : `〔图片 ${part.mimeType}，${Math.round((part.data.length * 3) / 4 / 1024)}KB〕`))
    .join("\n");
}

/** 内容块的 token 估算：文本按字符估，图片按张数估 */
export function estimateContentTokens(content: MessageContent | null | undefined): number {
  if (content == null) return 0;
  if (typeof content === "string") return estimateTokens(content);
  let total = 0;
  for (const part of content) {
    total += part.type === "text" ? estimateTokens(part.text) : estimateImageTokens(part.data.length);
  }
  return total;
}

/** 本轮用户输入的图片内容块（缺省为空） */
export function imagePartsOf(parts: readonly ContentPart[] | undefined): ContentPart[] {
  return (parts ?? []).filter((part) => part.type === "image");
}

export function formatMessages(messages: Array<{ role: string; content: MessageContent }>): string {
  return messages.map((message) => `[${message.role}]\n${contentToText(message.content)}`).join("\n\n");
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
