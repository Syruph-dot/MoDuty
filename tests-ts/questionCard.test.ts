import { test } from "node:test";
import assert from "node:assert/strict";
import { questionAnswersComplete } from "../desktop/src/components/ui/QuestionCard.js";

/**
 * 回归：ask_question 的「是否全部作答」判定。
 *
 * 历史 bug：判定写成 `choiceIndex >= 0 && (...)`，而「自定义」正是 choiceIndex = -1，
 * 于是只要有一题选了自定义（哪怕已经输入了文字），整个问题集永远判为未作答，
 * 提交按钮一直停在「还有题目未作答」——用户报的「选了自定义就无法完成答题」。
 */

const QUESTIONS = [
  { prompt: "网站原来是什么技术栈？", options: ["静态 HTML", "WordPress 等 CMS", "自研系统"] },
  { prompt: "有计划的目标环境吗？", options: ["云服务器", "国内主机"] },
];

test("逐题选择：全部选中才算答完", () => {
  assert.equal(
    questionAnswersComplete(QUESTIONS, [
      { choiceIndex: 0, customText: "" },
      { choiceIndex: 1, customText: "" },
    ]),
    true,
  );
  // 有一题还没选（初始态 choiceIndex=-1 且无文字）
  assert.equal(
    questionAnswersComplete(QUESTIONS, [
      { choiceIndex: 0, customText: "" },
      { choiceIndex: -1, customText: "" },
    ]),
    false,
  );
});

test("自定义作答：输入了文字就算答完（choiceIndex=-1 不算未作答）", () => {
  assert.equal(
    questionAnswersComplete(QUESTIONS, [
      { choiceIndex: -1, customText: "用的是某个小众建站 SaaS" },
      { choiceIndex: 0, customText: "" },
    ]),
    true,
  );
  // 选了自定义但没打字 → 还没答
  assert.equal(
    questionAnswersComplete(QUESTIONS, [
      { choiceIndex: -1, customText: "   " },
      { choiceIndex: 0, customText: "" },
    ]),
    false,
  );
});

test("边界：空题目集算未答完；选项下标越界不算答", () => {
  assert.equal(questionAnswersComplete([], []), false);
  assert.equal(
    questionAnswersComplete(QUESTIONS, [
      { choiceIndex: 9, customText: "" },
      { choiceIndex: 0, customText: "" },
    ]),
    false,
  );
  // 答案数组缺项 → 未答完
  assert.equal(questionAnswersComplete(QUESTIONS, [{ choiceIndex: 0, customText: "" }]), false);
});
