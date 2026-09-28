import test from "node:test";
import assert from "node:assert/strict";

import { extractSessionRefs, knownSessionRefs, stripUnknownSessionRefs } from "../src/http/agent-orchestration.ts";

/**
 * 参考会话契约（用户 2026-09-28 拍板）：
 * 值日生仍在任务书文本里自己写 `&ses_<id>`；后端正则抓取 → 归一化去重 → 按会话存在性校验。
 * 不存在的句柄不阻断派发，但从下发文本里剔除（去掉 `&` 前缀），且不进台账。
 */

const existing = new Set(["ses_ab12cd34ef56", "ses_0099aabbccdd"]);

test("句柄抓取：大小写归一化、去重、只认带 & 前缀的句柄", () => {
  assert.deepEqual(
    extractSessionRefs(
      "参考 &SES_AB12CD34EF56 与 &ses_0099aabbccdd，再提一次 &ses_ab12cd34ef56；裸 ses_ab12cd34ef56 不算句柄。",
    ),
    ["ses_ab12cd34ef56", "ses_0099aabbccdd"],
  );
});

test("不存在的句柄从任务书剔除（去掉 & 前缀），存在的原样保留", () => {
  const task = "写一篇短文。参考 &ses_ab12cd34ef56 里的目录约定；&ses_ffffffffffff 是编造的，不要用它。";
  const { task: cleaned, removed } = stripUnknownSessionRefs(task, existing);
  assert.deepEqual(removed, ["ses_ffffffffffff"]);
  assert.equal(cleaned.includes("&ses_ab12cd34ef56"), true);
  assert.equal(cleaned.includes("&ses_ffffffffffff"), false);
  // 裸 ID 留在散文里，读起来仍通顺，但不再被当作资源句柄解析
  assert.equal(cleaned.includes("ses_ffffffffffff"), true);
});

test("全部存在时不改动原文；全部不存在时逐条剔除且不重复", () => {
  const ok = "参考 &ses_ab12cd34ef56 与 &ses_0099aabbccdd。";
  assert.deepEqual(stripUnknownSessionRefs(ok, existing), { task: ok, removed: [] });

  const bad = "参考 &SES_FFFFFFFFFFFF 与 &ses_ffffffffffff。";
  assert.deepEqual(stripUnknownSessionRefs(bad, existing).removed, ["ses_ffffffffffff"]);
});

test("台账只记存在性通过的句柄", () => {
  const delivered = "总体任务：老师原话里带了 &ses_deadbeef0000\n\n指令（值日生的补充要求）：参考 &ses_ab12cd34ef56 与 &ses_ffffffffffff";
  assert.deepEqual(knownSessionRefs(delivered, existing), ["ses_ab12cd34ef56"]);
});

test("短 ID 不会吃掉长 ID 的前缀", () => {
  const long = new Set(["ses_abcdef"]);
  const { task: cleaned, removed } = stripUnknownSessionRefs("参考 &ses_abc，也要看 &ses_abcdef。", long);
  assert.deepEqual(removed, ["ses_abc"]);
  assert.equal(cleaned.includes("&ses_abcdef"), true); // 有效句柄必须保留 & 前缀
  assert.equal(/&ses_abc(?![\da-z])/u.test(cleaned), false); // 短句柄已被剔除
  assert.equal(cleaned.includes("ses_abc，"), true); // 剩下的裸 ID 仍在散文里
});
