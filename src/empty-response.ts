/**
 * 空响应判定与续跑提示（口径对齐 Proma，见 2026-09-21 调研）。
 *
 * Proma 的「本轮有没有产出」口径（apps/electron/src/main/lib/agent-run-message-visibility.ts
 * 的 isVisibleRunMessage）是：正文非空 / 思考非空 / 有 tool_use / 有 tool_result，
 * 任一存在即算可见产出。也就是说「只调了工具、没写正文」是一个**正常回合**，
 * 不是空响应——任务完成度由台账与判读决定，不由这一层决定。
 *
 * MoDuty 之前的口径是「非判读轮只要没有正文就算空」，实测后果是执行者调了 9 次工具、
 * 思考了 3600 字，仍被记为空响应并重试、最终标 error 停止。这与 Proma 的口径相反，
 * 也是「空响应不该导致失败和停止」的要害：空响应指的是**什么都没回来**，
 * 而不是「没写出正文」。
 */

/** 本轮是否有可取用的产出（正文 / 工具调用 / 思考任一非空即算有） */
export function hasUsableOutput(input: {
  text: string;
  toolCalls?: unknown[] | undefined;
  reasoningChars?: number | undefined;
}): boolean {
  if (input.text.trim().length > 0) return true;
  if ((input.toolCalls ?? []).length > 0) return true;
  if ((input.reasoningChars ?? 0) > 0) return true;
  return false;
}

/**
 * 真的什么都没有时的续跑提示。
 *
 * 延续同一个 transcript 往下做，而不是重发一遍任务——Proma 在 pi-agent-adapter 里
 * 明确写了「不能用外层重投原始 prompt 替代，否则会重复执行副作用工具」。
 * 这里的措辞与其压缩续跑提示词（PI_COMPACTION_CONTINUATION_PROMPT）同构：
 * 不要重复已完成的操作、先核验状态、有工作就立刻做、只有全部完成才收尾。
 */
export function buildEmptyContinuationNote(attempt: number, maxAttempts: number): string {
  return [
    `## 空响应续跑（第 ${attempt}/${maxAttempts} 次）`,
    "上游这一次没有返回任何内容：没有正文，也没有工具调用。请接着刚才的进度继续原任务，不要从头再来：",
    "",
    "- 不要重复已经完成或已经提交的操作，先核验当前状态；",
    "- 若仍有工作，立即执行下一项具体行动（工具调用或写文件都算）；",
    "- 只有原任务确实全部完成时才给出最终答复；确实受阻就说明阻塞原因。",
  ].join("\n");
}
