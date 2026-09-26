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
