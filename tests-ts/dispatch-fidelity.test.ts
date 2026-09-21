import { test } from "node:test";
import assert from "node:assert/strict";
import {
  buildDispatchEnvelope,
  buildDispatchFidelityNote,
  checkDispatchFidelity,
  extractDispatchHandles,
} from "../src/dispatch-fidelity.js";
import { describeSelfBlock } from "../src/agent-identity.js";

/**
 * 回归：MDG-BlogWebsite 任务（2026-09-21）暴露的两个派发链路缺陷。
 *
 * 1) 派发保真：老师原话里的 GitHub 链接没进任务书 → 执行者拿不到输入，反问答疑 + 全局乱搜，
 *    最后空响应报错、台账卡在等判读。修法：原话里有、任务书里没有的 URL/绝对路径自动补进任务书尾部。
 * 2) 自我身份：执行者不知道自己是谁、会话 id 是多少，靠猜 ses_0b8042189ff1 / tile_… 白烧一轮工具调用。
 *    修法：每轮动态上下文注入一次身份块（不放 system，避免破坏上游前缀缓存）。
 */

const REAL_ASK =
  "https://github.com/lMakiNishikinol/MDG-BlogWebsite/tree/my-local-work  研究一下别人给我的资产，他们的网站的服务器要到期，准备挂到我们这边。给出方案让我看看";
const REAL_TASK = "研究一下别人给我的资产，他们的网站的服务器要到期，准备挂到我们这边。给出方案让我看看";

test("派发保真：抽出原话里的链接，并补进丢失它的任务书", () => {
  assert.deepEqual(extractDispatchHandles(REAL_ASK), [
    "https://github.com/lMakiNishikinol/MDG-BlogWebsite/tree/my-local-work",
  ]);
  const note = buildDispatchFidelityNote(REAL_ASK, REAL_TASK);
  assert.match(note, /（老师原话·任务书以此为准）/);
  assert.match(note, /https:\/\/github\.com\/lMakiNishikinol\/MDG-BlogWebsite/);
  // 只补缺失项：任务书已经带上链接时不应再补
  assert.equal(buildDispatchFidelityNote(REAL_ASK, `看下这个仓库 ${REAL_ASK}`), "");
  // 原话没有句柄 → 不补
  assert.equal(buildDispatchFidelityNote("把表整理一下", "整理表格"), "");
});

test("派发保真：Windows 与 ~/ 路径都能抽出来，句尾标点要剥掉", () => {
  const ask = "根据 zip 文件 D:\\OBSIDIAN\\SyrVault1\\00_杂事\\国能26年度综测材料新版.zip 提取要素（参考 C:/Users/17206/Desktop/mo-auto.txt）";
  const handles = extractDispatchHandles(ask);
  assert.ok(handles.includes("D:\\OBSIDIAN\\SyrVault1\\00_杂事\\国能26年度综测材料新版.zip"), JSON.stringify(handles));
  assert.ok(handles.includes("C:/Users/17206/Desktop/mo-auto.txt"), JSON.stringify(handles));
  const note = buildDispatchFidelityNote(ask, "提取要素并整理成表");
  assert.match(note, /mo-auto\.txt/);
  assert.match(buildDispatchFidelityNote("看下 ~/notes/todo.md", "整理待办"), /~\/notes\/todo\.md/);
});

test("自我身份块：给出可用 id，缺 id/sessionId 时不注入半截信息", () => {
  const block = describeSelfBlock({
    id: "agt_0b8042189ff1",
    name: "网站迁移",
    sessionId: "ses_891ff88437ba",
    isDispatcher: false,
    workspaceDir: "D:\\work",
  });
  assert.ok(block);
  assert.match(block, /agent_id：agt_0b8042189ff1/);
  assert.match(block, /session_id：ses_891ff88437ba/);
  assert.match(block, /执行者/);
  assert.match(block, /read_session ses_891ff88437ba/);
  assert.equal(describeSelfBlock({ id: "", name: "x", sessionId: "ses_1", isDispatcher: false }), null);
  assert.equal(describeSelfBlock({ id: "agt_1", name: "x", sessionId: "", isDispatcher: false }), null);
  // 值日生身份多一层语义
  assert.match(
    describeSelfBlock({ id: "agt_a75dfea26f66", name: "值日生", sessionId: "ses_30620c1873eb", isDispatcher: true }) ?? "",
    /值日生（调度者）/,
  );
});

test("原话随行：任务书与老师原话完全脱节时，附上老师原话而不是拒绝派发", () => {
  const ask = [
    "P1 横屏（适合电脑）  P2 竖屏（适合手机）  【博客信息】",
    "标题：Jev 官方博客解读：把“快思考”做成软件原语",
    "来源：https://typesafe.ai/blog/introducing-system-one-models-and-jev",
    "评测：https://evals.typesafe.ai/",
  ].join("\n");
  const wrongTask = "研究一下别人给我的资产，他们的网站的服务器要到期，准备挂到我们这边。给出方案让我看看";
  const envelope = buildDispatchEnvelope(ask, wrongTask);
  // 不拒绝：note 里带上了老师原话全文与缺失输入清单
  assert.match(envelope.note, /（老师原话·任务书以此为准）/);
  assert.match(envelope.note, /Jev 官方博客解读/);
  assert.match(envelope.note, /typesafe\.ai\/blog\/introducing-system-one-models-and-jev/);
  assert.match(envelope.note, /其中这些输入务必用上：/);
  // 留痕描述：说清发生了什么，且明确任务书本身没被改写
  assert.equal(typeof envelope.mismatch, "string");
  assert.match(String(envelope.mismatch), /任务书与老师原话完全脱节/);
  assert.match(String(envelope.mismatch), /任务书本身未改写/);
});

test("原话随行：只是漏了其中几条输入时也附原话，但不留脱节留痕", () => {
  const ask = "看 https://a.example/x 和 https://b.example/y";
  const partial = "研究 https://a.example/x 这篇";
  const envelope = buildDispatchEnvelope(ask, partial);
  assert.match(envelope.note, /（老师原话·任务书以此为准）/);
  assert.match(envelope.note, /- https:\/\/b\.example\/y/);
  assert.equal(envelope.mismatch, null);
});

test("原话随行：两边一致时不附加任何文本（不塞冗余长文）", () => {
  const ask = "研究 https://a.example/x";
  const envelope = buildDispatchEnvelope(ask, "研究 https://a.example/x 并给出结论");
  assert.equal(envelope.note, "");
  assert.equal(envelope.mismatch, null);
});

test("原话随行：老师原话本来就没有句柄时不附加", () => {
  const envelope = buildDispatchEnvelope("帮我写一篇短文", "写一篇 500 字短文");
  assert.equal(envelope.note, "");
  assert.equal(envelope.mismatch, null);
});
