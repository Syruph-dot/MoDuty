import { test } from "node:test";
import assert from "node:assert/strict";
import {
  buildVerdictWakeMessage,
  describePreviousAttempt,
  verdictTriggerLabel,
} from "../src/verdict-prompt.js";

/**
 * 回归：值日生的判读唤醒提示词。
 *
 * 背景（2026-09-21 实测）：判读轮多次「只调一次 inspect_session 就收尾、正文 0 字、不提交判定」，
 * 条目就停在等判读。补唤醒如果只是「再发一遍同样的东西」，模型很可能又只读不判——
 * 所以补唤醒必须带上前一轮做了什么，并把「必须以提交判定收尾」写成硬要求。
 */

const ENTRY = {
  id: "dsp_1b2c9b2d3560",
  task: "https://github.com/lMakiNishikinol/MDG-BlogWebsite/tree/my-local-work 研究一下别人给我的资产…",
  targetSessionId: "ses_891ff88437ba",
  continueCount: 0,
};

test("常规唤醒：自包含（条目 / 任务 / 会话句柄 / 两种判定命令）", () => {
  const message = buildVerdictWakeMessage({ entry: ENTRY, trigger: "completed" });
  assert.match(message, /【台账判读请求】条目 dsp_1b2c9b2d3560：执行者报告完成/);
  assert.match(message, /执行者会话：&ses_891ff88437ba/);
  assert.match(message, /dispatch verdict dsp_1b2c9b2d3560 continue/);
  assert.match(message, /dispatch verdict dsp_1b2c9b2d3560 deliver/);
  assert.match(message, /不要重复派发任务/);
  // 常规唤醒不带「补唤醒」段落
  assert.doesNotMatch(message, /【补唤醒/);
});

test("补唤醒：带上上一轮做了什么，并要求以提交判定收尾", () => {
  const message = buildVerdictWakeMessage({
    entry: ENTRY,
    trigger: "verdict_unsettled",
    previousAttemptTools: ["inspect_session"],
    unsettledAttempt: 1,
  });
  assert.match(message, /【补唤醒·第 1 次】/);
  assert.match(message, /上一轮判读只调用了这些工具：inspect_session/);
  assert.match(message, /没有提交判定/);
  assert.match(message, /必须\*\*以提交判定收尾\*\*/);
  assert.match(message, /只看不判等于没做/);
  // 原始判读请求仍然保留（补唤醒不是替代，而是加强）
  assert.match(message, /【台账判读请求】/);
  assert.match(message, /dispatch verdict dsp_1b2c9b2d3560 deliver/);
});

test("补唤醒：上一轮完全没动作 / 第二次补唤醒都能说清楚", () => {
  assert.match(describePreviousAttempt([]), /没有任何动作/);
  assert.match(describePreviousAttempt(undefined), /没有任何动作/);
  const second = buildVerdictWakeMessage({
    entry: { ...ENTRY, continueCount: 2 },
    trigger: "verdict_unsettled",
    previousAttemptTools: ["inspect_session", "read_session"],
    unsettledAttempt: 2,
  });
  assert.match(second, /【补唤醒·第 2 次】/);
  assert.match(second, /inspect_session → read_session/);
  assert.match(second, /已返工轮次：2\/3/);
  assert.match(verdictTriggerLabel("stalled"), /停转/);
  assert.match(verdictTriggerLabel("error"), /出错/);
});
