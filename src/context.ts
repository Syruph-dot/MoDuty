/**
 * 上下文窗口管理（第四周：上下文）。
 *
 * 目标：上下文是有限资源。历史消息不能无限拼接，必须按 token 预算裁剪：
 * 头部固定保留（目标/开场），尾部保留最近消息，中段折叠为占位提示。
 * 不引入 tokenizer 依赖，用混合估算：CJK ≈ 1 token/字，其他 ≈ 1 token/3.5 字符。
 */

export interface BoundedHistoryOptions {
  /** 预算（估算 token 数），默认 4000 */
  budgetTokens?: number;
  /** 头部固定保留的消息条数（通常是目标/开场），默认 2 */
  headMessages?: number;
  /** 单条消息最大字符数（超长截断），默认 4000 */
  maxMessageChars?: number;
}

export interface BoundedHistoryResult {
  text: string;
  keptCount: number;
  droppedCount: number;
  estimatedTokens: number;
  truncatedMessages: number;
  /** 上下文分隔线位置：head 结束、folded 开始的字符索引（用于前端定位分隔线） */
  dividerOffset?: number;
  /** head 保留的消息数 */
  headCount?: number;
  /** tail 保留的消息数 */
  tailCount?: number;
}

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

export interface BoundedHistoryMessagesResult {
  messages: Array<{ role: string; content: string }>;
  keptCount: number;
  droppedCount: number;
  estimatedTokens: number;
  truncatedMessages: number;
}

/**
 * 预算裁剪历史（角色分离版）。
 *
 * 与 buildBoundedHistory 的区别：不再把历史压成一段文本，而是返回**真正的消息数组**。
 * 目的是让上游 provider 的**前缀缓存**尽可能命中：历史按「只追加」增长，
 * 从第一条消息起的前缀就逐字节稳定；只有超出预算做折叠时才会在中段发生变化。
 *
 * 折叠时插入一条 system 角色的占位说明（而不是把说明混进某条消息正文）。
 * 若将来遇到不接受消息数组中间出现 system 的 provider，把这里改成 user 角色即可。
 */
export function buildBoundedHistoryMessages(
  messages: Array<{ role: string; content: string }>,
  options: BoundedHistoryOptions = {},
): BoundedHistoryMessagesResult {
  const budgetTokens = options.budgetTokens ?? 4000;
  const headCount = Math.min(options.headMessages ?? 2, messages.length);
  const maxMessageChars = options.maxMessageChars ?? 4000;

  if (messages.length === 0) {
    return { messages: [], keptCount: 0, droppedCount: 0, estimatedTokens: 0, truncatedMessages: 0 };
  }

  let truncatedMessages = 0;
  const head = messages.slice(0, headCount).map((message) => {
    if (message.content.length > maxMessageChars) {
      truncatedMessages += 1;
      return { role: message.role, content: `${message.content.slice(0, maxMessageChars)}\n…[单条消息过长已截断]` };
    }
    return { role: message.role, content: message.content };
  });
  const tailCandidates = messages.slice(headCount);

  let remainingTokens = budgetTokens - estimateTokens(formatMessages(head));
  const keptTail: Array<{ role: string; content: string }> = [];
  let usedTokens = 0;

  for (let i = tailCandidates.length - 1; i >= 0; i -= 1) {
    const original = tailCandidates[i];
    let content = original.content;
    if (content.length > maxMessageChars) {
      content = `${content.slice(0, maxMessageChars)}\n…[单条消息过长已截断]`;
      truncatedMessages += 1;
    }
    const tokens = estimateTokens(content);
    if (usedTokens + tokens > remainingTokens && keptTail.length > 0) {
      break;
    }
    keptTail.unshift({ role: original.role, content });
    usedTokens += tokens;
  }

  const droppedCount = tailCandidates.length - keptTail.length;
  const result: Array<{ role: string; content: string }> = [...head];
  if (droppedCount > 0) {
    result.push({
      role: "system",
      content: `[省略中间 ${droppedCount} 条历史消息，如需可让用户补充]`,
    });
  }
  result.push(...keptTail);

  return {
    messages: result,
    keptCount: headCount + keptTail.length,
    droppedCount,
    estimatedTokens: estimateTokens(formatMessages(result)),
    truncatedMessages,
  };
}

/**
 * 预算裁剪历史：
 * - 头部 headMessages 条固定保留；
 * - 尾部从最新消息向前累积，直到预算耗尽（至少保留最近 1 条）；
 * - 中段被折叠的部分用「省略 N 条历史消息」占位，模型仍知道有历史但不用消化全部。
 */
export function buildBoundedHistory(
  messages: Array<{ role: string; content: string }>,
  options: BoundedHistoryOptions = {},
): BoundedHistoryResult {
  const budgetTokens = options.budgetTokens ?? 4000;
  const headCount = Math.min(options.headMessages ?? 2, messages.length);
  const maxMessageChars = options.maxMessageChars ?? 4000;

  if (messages.length === 0) {
    return { text: "", keptCount: 0, droppedCount: 0, estimatedTokens: 0, truncatedMessages: 0 };
  }

  const head = messages.slice(0, headCount).map((message) => {
    if (message.content.length > maxMessageChars) {
      return {
        role: message.role,
        content: `${message.content.slice(0, maxMessageChars)}\n…[单条消息过长已截断]`,
      };
    }
    return message;
  });
  const headTruncated = head.filter((message) => message.content.includes("单条消息过长已截断")).length;
  const tailCandidates = messages.slice(headCount);

  const headText = formatMessages(head);
  let remainingTokens = budgetTokens - estimateTokens(headText);
  let truncatedMessages = headTruncated;

  const keptTail: Array<{ role: string; content: string }> = [];
  let usedTokens = 0;

  for (let i = tailCandidates.length - 1; i >= 0; i -= 1) {
    const original = tailCandidates[i];
    let content = original.content;
    if (content.length > maxMessageChars) {
      content = `${content.slice(0, maxMessageChars)}\n…[单条消息过长已截断]`;
      truncatedMessages += 1;
    }
    const tokens = estimateTokens(content);
    // 预算放不下且已保留至少一条 → 停止；否则至少保留最近一条
    if (usedTokens + tokens > remainingTokens && keptTail.length > 0) {
      break;
    }
    keptTail.unshift({ role: original.role, content });
    usedTokens += tokens;
  }

  const droppedCount = tailCandidates.length - keptTail.length;
  const folded = droppedCount > 0
    ? `\n\n[省略中间 ${droppedCount} 条历史消息，如需可让用户补充]\n\n`
    : "";
  const text = `${headText}${folded}${formatMessages(keptTail)}`;
  const tailCount = keptTail.length;
  const dividerOffset = headText.length;
  return {
    text,
    keptCount: headCount + tailCount,
    droppedCount,
    estimatedTokens: estimateTokens(text),
    truncatedMessages,
    dividerOffset,
    headCount,
    tailCount,
  };
}