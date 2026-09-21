/**
 * 回复投递格式：一条完整回应可以拆成多条消息发出，但绝不截断。
 *
 * 用户拍板（2026-09-21）：「不要截断回复，用多条消息发完一个回应。」
 * 之前的做法是超过 2000 字就切掉并加一句「已截断」——手机上永远看不到后半段。
 * 现在改成按消息条数拆：单条不超过约 1800 字（微信/飞书气泡的舒适长度），
 * 优先在换行处断开，段落过长才硬切；切点不落在代理对（emoji 等）中间。
 *
 * 纯函数、无依赖：便于单测（tests-ts/bot-reply-format.test.ts）。
 */

/** 单条消息的字符上限（留出余量给微信/飞书自身的限制） */
export const MAX_SINGLE_MESSAGE_CHARS = 1800;

/** 是否落在代理对中间（切在这里会把 emoji / 生僻字切成两个坏字符） */
function isLoneHighSurrogate(text: string, index: number): boolean {
  if (index <= 0 || index >= text.length) return false;
  const code = text.charCodeAt(index - 1);
  return code >= 0xd800 && code <= 0xdbff;
}

/**
 * 把一条完整回应拆成若干条消息。文本本身不做任何删改（除了首尾空白）。
 */
export function splitReplyForDelivery(text: string, limit = MAX_SINGLE_MESSAGE_CHARS): string[] {
  const body = (text ?? "").trim();
  if (!body) return [];
  const size = Math.max(200, Math.floor(limit));
  if (body.length <= size) return [body];

  const parts: string[] = [];
  let rest = body;
  while (rest.length > size) {
    // 优先在换行处断开（保留段落的可读性），其次空格，最后硬切
    const window = rest.slice(0, size);
    let cut = window.lastIndexOf("\n");
    if (cut < size * 0.5) cut = window.lastIndexOf(" ");
    if (cut < size * 0.5) cut = size;
    if (isLoneHighSurrogate(rest, cut)) cut -= 1;
    parts.push(rest.slice(0, cut).trimEnd());
    rest = rest.slice(cut).replace(/^\n+/u, "");
  }
  if (rest.trim()) parts.push(rest.trim());
  return parts.filter(Boolean);
}
