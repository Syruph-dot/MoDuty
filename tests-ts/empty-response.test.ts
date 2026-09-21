import assert from "node:assert/strict";
import test from "node:test";

import { buildEmptyContinuationNote, hasUsableOutput } from "../src/empty-response.js";

test("有正文 = 有产出", () => {
  assert.equal(hasUsableOutput({ text: "方案如下……" }), true);
  assert.equal(hasUsableOutput({ text: "   " }), false);
});

test("只调了工具、没写正文，也算有产出（Proma 口径；这正是空响应不该导致失败的要害）", () => {
  assert.equal(
    hasUsableOutput({ text: "", toolCalls: [{ tool: "browse_navigate" }, { tool: "browse_observe" }] }),
    true,
  );
  assert.equal(hasUsableOutput({ text: "", toolCalls: [] }), false);
});

test("只有思考也算有产出（Proma 把 thinking 计入可见消息）", () => {
  assert.equal(hasUsableOutput({ text: "", reasoningChars: 3624 }), true);
  assert.equal(hasUsableOutput({ text: "", reasoningChars: 0 }), false);
});

test("真的什么都没回来才算空响应", () => {
  assert.equal(hasUsableOutput({ text: "", toolCalls: [], reasoningChars: 0 }), false);
});

test("续跑提示：接着往下做，不重发任务，且带次数", () => {
  const note = buildEmptyContinuationNote(2, 3);
  assert.match(note, /空响应续跑（第 2\/3 次）/);
  assert.match(note, /不要重复已经完成或已经提交的操作/);
  assert.match(note, /立即执行下一项具体行动/);
  assert.match(note, /不要从头再来/);
});
