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

/** 执行者上一轮的实际动作（返工指令要告诉它自己上一轮干了什么） */
export interface ExecutorAttemptSummary {
  /** 工具名序列，按发生顺序 */
  tools: string[];
  /** 这一轮有没有写下任何正文（写下来才算有产出） */
  hadText: boolean;
}

/**
 * 构造返工指令。
 *
 * 为什么不能只发「点评 + 请继续完成任务」：实测（2026-09-21 dsp_1b2c9b2d3560）
 * 执行者连续三轮只做浏览器操作、正文 0 字——因为指令里只有一句点评，没告诉它
 * 「原任务要什么」「上一轮实际做了什么」「这一轮必须交到什么程度」。
 * 返工是「带上下文的重做」，不是重发一条催促。
 */
export function buildReworkMessage(input: {
  entry: { id: string; task: string };
  /** 值日生的点评（LLM 生成，保留原话） */
  note?: string;
  /** 第几轮返工 / 上限 */
  round?: number;
  maxRounds?: number;
  previousAttempt?: ExecutorAttemptSummary;
}): string {
  const { entry, note, round, maxRounds = 3, previousAttempt } = input;
  const sections: string[] = [];
  sections.push(`【返工指令】台账 ${entry.id}${round ? `：第 ${round}/${maxRounds} 轮` : ""}：上一轮产出未通过。`);
  if (note?.trim()) sections.push(`值日生的点评：${note.trim().slice(0, 400)}`);
  sections.push(["原任务书（里面可能含老师给的关键输入，必须用上）：", entry.task.slice(0, 500)].join("\n"));
  const tools = previousAttempt?.tools ?? [];
  if (previousAttempt) {
    const toolText = tools.length ? `（${tools.join(" → ")}）` : "";
    sections.push(
      previousAttempt.hadText
        ? `上一轮实际做了什么：调用了 ${tools.length} 次工具${toolText}，虽然有正文但没有通过验收。`
        : `上一轮实际做了什么：调用了 ${tools.length} 次工具${toolText}，**正文 0 字**——只操作了工具、什么都没写下来。`,
    );
  }
  sections.push(
    [
      "这一轮的要求：",
      "1. 必须**写下产出**（正文结论，或写明文件路径与关键内容），不能只做工具操作就结束；",
      "2. 用上原任务书里的链接/路径，针对它给出具体结论，不要给通用套路；",
      "3. 不要重复上一轮那些无效动作（比如每次新建浏览器、反复导航到同一页面）。",
      "完成后用一两句话说明产出在哪里。",
    ].join("\n"),
  );
  return sections.join("\n\n");
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
