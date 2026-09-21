/**
 * 判读唤醒提示词的唯一构造处。
 *
 * 为什么单独成模块：这条提示词是「唤醒值日生判读」的全部输入质量所在——
 * 它必须自包含（条目、任务、执行者会话句柄、返工轮次、两种判定的命令），
 * 并且**在「上一轮没给出结论」的补唤醒时要带上前一轮做了什么**，
 * 否则重试只是「再叫一遍」，模型很可能又只读不判。
 *
 * 纯函数、无依赖：便于单测（tests-ts/verdict-prompt.test.ts）。
 */
import type { DispatchTrigger } from "./dispatch-ledger.js";

export interface VerdictWakeEntry {
  id: string;
  task: string;
  targetSessionId: string;
  continueCount: number;
}

export interface VerdictWakeInput {
  entry: VerdictWakeEntry;
  trigger: DispatchTrigger;
  /** 上一轮判读实际做了什么（工具名序列，按发生顺序）。仅补唤醒时给 */
  previousAttemptTools?: string[];
  /** 第几次因为「没给出结论」而补唤醒（1 = 第一次补） */
  unsettledAttempt?: number;
}

/** 触发原因的中文说明（也用于判读留痕） */
export function verdictTriggerLabel(trigger: DispatchTrigger): string {
  if (trigger === "completed") return "执行者报告完成";
  if (trigger === "error") return "执行者出错";
  if (trigger === "verdict_unsettled") return "上一次判读没有给出结论（系统自动补唤醒）";
  return "疑似停转（长时间无进展）";
}

/** 上一轮判读做了什么：把工具名序列说成人话，供模型自我纠偏 */
export function describePreviousAttempt(tools?: string[]): string {
  const list = (tools ?? []).map((name) => String(name ?? "").trim()).filter(Boolean);
  if (list.length === 0) return "上一轮判读没有任何动作（既没读会话，也没提交判定）。";
  return `上一轮判读只调用了这些工具：${list.join(" → ")}，**没有提交判定**。`;
}

/**
 * 构造判读请求。两种形态：
 * - 首次/常规触发：说明触发原因 + 任务 + 会话句柄 + 两种判定的命令；
 * - 补唤醒（上一轮没结论）：最前面加上「上一轮做了什么」与硬要求（必须以提交判定收尾）。
 */
export function buildVerdictWakeMessage(input: VerdictWakeInput): string {
  const { entry, trigger, previousAttemptTools, unsettledAttempt } = input;
  const sections: string[] = [];

  if (trigger === "verdict_unsettled" || unsettledAttempt) {
    sections.push(
      [
        `【补唤醒·第 ${unsettledAttempt ?? 1} 次】条目 ${entry.id} 仍停在「等判读」：`,
        describePreviousAttempt(previousAttemptTools),
        `这一轮必须**以提交判定收尾**：先 read_session 读执行者会话的收尾（不要整篇读），`,
        `然后调用一次 run_momoka_cli dispatch verdict ${entry.id} deliver|continue [备注]。`,
        "只看不判等于没做——请不要再只 inspect_session 就结束。",
      ].join("\n"),
    );
  }

  sections.push(
    [
      `【台账判读请求】条目 ${entry.id}：${verdictTriggerLabel(trigger)}。任务：${entry.task.slice(0, 160)}`,
      `执行者会话：&ses_${entry.targetSessionId.replace(/^ses_/, "")}`,
      entry.continueCount ? `已返工轮次：${entry.continueCount}/3。` : undefined,
      "请 read_session 看该会话的收尾部分（不要整篇读），判读产出是否有效：",
      `无效（报错/截断/未收尾/与任务无关）→ run_momoka_cli dispatch verdict ${entry.id} continue [问题备注]`,
      `有效或无法挽救 → run_momoka_cli dispatch verdict ${entry.id} deliver [交付备注]`,
      "判定通过工具提交即可，不要向老师复述任务内容，也不要重复派发任务。",
    ]
      .filter(Boolean)
      .join("\n"),
  );

  return sections.join("\n\n");
}
