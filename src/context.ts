/**
 * 上下文窗口管理（第四周：上下文）。
 *
 * 目标：上下文是有限资源。历史消息不能无限拼接，必须按 token 预算裁剪：
 * 头部固定保留（目标/开场），尾部保留最近消息，中段折叠为占位提示。
 * 不引入 tokenizer 依赖，用混合估算：CJK ≈ 1 token/字，其他 ≈ 1 token/3.5 字符。
 */

/**
 * 台账留痕标记：这些 system 消息随派发次数线性累积（每次派发/返工/交付都写一条），
 * 占的是同一个历史预算，会把真实对话挤出窗口。
 */
const LEDGER_TRACE_MARKERS = ["【判读留痕】", "【自动派发】", "【自动派发失败】", "【台账判读请求】", "【已拦截】"];

/** 是否台账留痕（system 角色的派发/判读记账消息） */
export function isLedgerTraceMessage(message: { role: string; content: string }): boolean {
  return message.role === "system" && LEDGER_TRACE_MARKERS.some((marker) => message.content.startsWith(marker));
}

/**
 * 台账留痕折叠（只影响送模型的历史，不改落盘）：
 * - 最近的 keepLatest 条留痕保留原文（判读上下文需要）；
 * - 更早的按 dsp_* 归并成一行（首见摘要 + 条数），插在第一条被折叠留痕的位置；
 * - 留痕总数不过多时原样返回（不值得为两三条改动历史形状）。
 *
 * 动机：值日生会话里留痕与真实对话共用 4000 token 预算，不折叠就会出现
 * “模型记得昨天派给谁、却忘了刚才老师说啥”。在途状态另有台账快照/dispatch list，不靠留痕。
 */
export function foldLedgerTraces<T extends { role: string; content: string }>(
  messages: T[],
  keepLatest = 2,
): Array<T | { role: "system"; content: string }> {
  const traceIndexes = messages
    .map((message, index) => (isLedgerTraceMessage(message) ? index : -1))
    .filter((index) => index >= 0);
  if (traceIndexes.length <= keepLatest + 1) return messages;

  const foldSet = new Set(traceIndexes.slice(0, traceIndexes.length - keepLatest));
  const firstFoldIndex = Math.min(...foldSet);

  const order: string[] = [];
  const gistById = new Map<string, string>();
  const countById = new Map<string, number>();
  for (const index of [...foldSet].sort((a, b) => a - b)) {
    const content = messages[index].content;
    const id = content.match(/dsp_[A-Za-z0-9]+/)?.[0] ?? "(无台账 id)";
    countById.set(id, (countById.get(id) ?? 0) + 1);
    if (gistById.has(id)) continue;
    order.push(id);
    const gist = content
      .replace(/^【[^】]*】/, "")
      .replace(/^\s*dsp_[A-Za-z0-9]+\s*[：:]?\s*/, "")
      .replace(/\s+/g, " ")
      .trim()
      .slice(0, 60);
    gistById.set(id, gist);
  }

  const lines = order.map((id) => {
    const count = countById.get(id) ?? 1;
    const suffix = count > 1 ? `（${count} 条）` : "";
    return `- ${id}${suffix}：${gistById.get(id) || "（无摘要）"}`;
  });
  const summary = [
    `【台账留痕·历史已折叠 ${foldSet.size} 条】`,
    ...lines,
    "（完整留痕仍在会话里可查；在途状态请看台账快照或 dispatch list，不要靠留痕推断）",
  ].join("\n");

  const out: Array<T | { role: "system"; content: string }> = [];
  for (let index = 0; index < messages.length; index += 1) {
    if (index === firstFoldIndex) out.push({ role: "system", content: summary });
    if (foldSet.has(index)) continue;
    out.push(messages[index]);
  }
  return out;
}

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