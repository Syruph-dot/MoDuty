import type { TurnMode } from "./types.js";

/**
 * 轮次模式块：每轮注入在提示词尾部**最前面**（先于动态上下文与用户请求）。
 *
 * 为什么放在尾部而不是 system：system 要逐轮字节一致才能命中上游前缀缓存；
 * 而"这一轮是对话还是系统唤醒"每轮都可能变。所以模式判定交给运行时（`request.turnMode` /
 * `transient`），用一段很短的文本在尾部开关**是否扮演**，system 里的角色扮演层保持不动。
 *
 * 三档：
 * - chat    老师直接说话：允许且应当按 system 末尾的角色扮演层说话；
 * - verdict 系统唤醒的台账判读轮：口吻可以带，但**禁止面向老师**（不称呼/不寒暄/不复述），
 *           正文只留一句极短留痕，动作全部走工具调用；
 * - stalled 停转复查唤醒：同 verdict，且先核对台账快照该条是否已被其它轮次结单。
 */
export function resolveTurnMode(input: { turnMode?: TurnMode; transient?: boolean }): TurnMode {
  if (input.turnMode) return input.turnMode;
  return input.transient ? "verdict" : "chat";
}

export function buildTurnModeBlock(mode: TurnMode): string {
  switch (mode) {
    case "verdict":
      return [
        "## 本轮模式：台账判读（系统唤醒，不面向老师）",
        "- 语气可以像平时那样松散，但**不要面向老师说话**：不称呼、不寒暄、不复述任务内容。",
        "- 正文只留一句极短留痕（一句即可）；动作全部走工具调用。",
        "- 只做两件事：read_session 看该会话收尾 → run_momoka_cli dispatch verdict <dsp_id> deliver|continue。",
        "- 不要重复派发、不要等待执行者、不要输出计划或多段分析。",
      ].join("\n");
    case "stalled":
      return [
        "## 本轮模式：停转复查（系统唤醒，不面向老师）",
        "- 同判读轮：不要面向老师说话，正文只留一句极短留痕。",
        "- 先核对下方台账快照：该条目若已被结单（已交付 / 已取消），本地直接不动、留一句即可，不要再提交判定。",
        "- 仍未结单 → read_session 看收尾，再按判读规则提交 deliver|continue。",
        "- 执行者可能只是慢，不是坏了：产出完整可交付就 deliver，明显卡死/无产出再 continue。",
      ].join("\n");
    case "chat":
    default:
      return [
        "## 本轮模式：对话（老师直接说话）",
        "- 按 system 末尾的角色扮演层说话（称呼、口吻、语尾都照它）。",
        "- 复杂任务 → 走①意图判定～④派发流程；闲聊/简单问答 → 自然回应，不调工具。",
        "- 状态以台账快照 / dispatch list 为准，不要靠历史回忆在途任务。",
      ].join("\n");
  }
}
