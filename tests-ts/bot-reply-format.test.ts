import { test } from "node:test";
import assert from "node:assert/strict";

import { MAX_SINGLE_MESSAGE_CHARS, splitReplyForDelivery } from "../src/bot/reply-format.js";

test("短回复原样一条发出，不做任何改动", () => {
  assert.deepEqual(splitReplyForDelivery("收到，处理中…"), ["收到，处理中…"]);
  assert.deepEqual(splitReplyForDelivery("  前后空白会被去掉  "), ["前后空白会被去掉"]);
  assert.deepEqual(splitReplyForDelivery(""), []);
});

test("长回复拆成多条，且不丢字（用户拍板：不截断，用多条消息发完）", () => {
  const paragraphs = Array.from({ length: 40 }, (_, i) => `第 ${i + 1} 段：${"内容".repeat(30)}`);
  const text = paragraphs.join("\n");
  const parts = splitReplyForDelivery(text, 500);
  assert.ok(parts.length > 1, `应拆成多条，实际 ${parts.length}`);
  for (const part of parts) assert.ok(part.length <= 500, `单条不应超过 500：${part.length}`);
  // 拼回去必须与原文一致（只允许在断行处去掉换行/空白）
  assert.equal(parts.join("\n").replace(/\s+/gu, ""), text.replace(/\s+/gu, ""));
});

test("优先在换行处断开，段落不会被切碎", () => {
  const text = `${"甲".repeat(300)}\n${"乙".repeat(300)}`;
  const parts = splitReplyForDelivery(text, 400);
  assert.equal(parts.length, 2);
  assert.equal(parts[0], "甲".repeat(300));
  assert.equal(parts[1], "乙".repeat(300));
});

test("单个超长段落也能硬切，且不把代理对（emoji）切坏", () => {
  const text = "🍊".repeat(400); // 每个 emoji 占 2 个 UTF-16 码元
  const parts = splitReplyForDelivery(text, 300);
  assert.ok(parts.length > 1);
  for (const part of parts) {
    // 每个分片自身必须是合法字符串（无孤立代理项）
    assert.equal(part, [...part].join(""), `分片含孤立代理项：${JSON.stringify(part.slice(0, 20))}`);
    assert.ok(part.length <= 300);
  }
  assert.equal(parts.join(""), text);
});

test("默认上限约 1800 字", () => {
  assert.equal(MAX_SINGLE_MESSAGE_CHARS, 1800);
  const parts = splitReplyForDelivery("字".repeat(4000));
  assert.ok(parts.length >= 3, `应拆成至少 3 条，实际 ${parts.length}`);
  for (const part of parts) assert.ok(part.length <= MAX_SINGLE_MESSAGE_CHARS);
});
