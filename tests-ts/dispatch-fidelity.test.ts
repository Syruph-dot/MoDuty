import { test } from "node:test";
import assert from "node:assert/strict";
import {
  ASK_MAX_CHARS,
  buildDispatchMessage,
  checkDispatchFidelity,
  extractDispatchHandles,
} from "../src/dispatch-fidelity.js";
import { describeSelfBlock } from "../src/agent-identity.js";

/**
 * 回归：派发链路（2026-09-21 两次实测）。
 *
 * 1) MDG-BlogWebsite：老师原话里的 GitHub 链接没进任务书 → 执行者拿不到输入，
 *    反问答疑 + 全局乱搜，最后空响应报错、台账卡在等判读。
 * 2) TypeSafe/Jev 错派：老师在同一条会话里发了新任务，值日生却把历史里那条旧任务书
 *    抄成了本次指令；系统再做「保真补全」，把新链接贴到旧任务书上——旧任务 + 新链接缝成
 *    一条谁都没要过的任务。
 *
 * 现在的口径（用户拍板）：下发给执行者的消息固定是
 * `总体任务：<老师原话>` + `指令：<值日生生成的补充要求，可为空>`。
 * 老师原话每单必带，不依赖任何「分歧迹象」判断。
 */

const REAL_ASK =
  "https://github.com/lMakiNishikinol/MDG-BlogWebsite/tree/my-local-work  研究一下别人给我的资产，他们的网站的服务器要到期，准备挂到我们这边。给出方案让我看看";
const REAL_TASK = "研究一下别人给我的资产，他们的网站的服务器要到期，准备挂到我们这边。给出方案让我看看";

test("句柄抽取：链接、Windows 与 ~/ 路径都能抽出来，句尾标点要剥掉", () => {
  assert.deepEqual(extractDispatchHandles(REAL_ASK), [
    "https://github.com/lMakiNishikinol/MDG-BlogWebsite/tree/my-local-work",
  ]);
  const ask = "根据 zip 文件 D:\\OBSIDIAN\\SyrVault1\\00_杂事\\国能26年度综测材料新版.zip 提取要素（参考 C:/Users/17206/Desktop/mo-auto.txt）";
  const handles = extractDispatchHandles(ask);
  assert.ok(handles.includes("D:\\OBSIDIAN\\SyrVault1\\00_杂事\\国能26年度综测材料新版.zip"), JSON.stringify(handles));
  assert.ok(handles.includes("C:/Users/17206/Desktop/mo-auto.txt"), JSON.stringify(handles));
  assert.deepEqual(extractDispatchHandles("看下 ~/notes/todo.md"), ["~/notes/todo.md"]);
});

test("下发消息：总体任务 = 老师原话，指令 = 值日生给的说明（原话必须带）", () => {
  const { message, mismatch } = buildDispatchMessage({ ask: REAL_ASK, task: REAL_TASK });
  assert.match(message, /^总体任务：https:\/\/github\.com\/lMakiNishikinol\/MDG-BlogWebsite/);
  assert.match(message, /\n\n指令（值日生的补充要求；与总体任务冲突时以总体任务为准）：/);
  assert.ok(message.includes(REAL_TASK), "指令原文应在消息里");
  // 链接在原话里 → 一定到得了执行者手里（这正是 MDG 那次的病）
  assert.ok(message.includes("https://github.com/lMakiNishikinol/MDG-BlogWebsite/tree/my-local-work"));
  assert.equal(mismatch, null);
});

test("下发消息：值日生把原话原样当指令时不重复一遍", () => {
  const { message } = buildDispatchMessage({ ask: REAL_ASK, task: REAL_ASK });
  assert.equal(message, `总体任务：${REAL_ASK}`);
  assert.ok(!message.includes("指令（"));
});

test("下发消息：指令与老师原话脱节（实测的错派）时，原话照样带着，另给一条留痕", () => {
  const ask = [
    "P1 横屏（适合电脑）  P2 竖屏（适合手机）  【博客信息】",
    "标题：Jev 官方博客解读：把“快思考”做成软件原语",
    "来源：https://typesafe.ai/blog/introducing-system-one-models-and-jev",
    "评测：https://evals.typesafe.ai/",
  ].join("\n");
  const wrongTask = "研究一下别人给我的资产，他们的网站的服务器要到期，准备挂到我们这边。给出方案让我看看";
  const { message, mismatch } = buildDispatchMessage({ ask, task: wrongTask });
  // 不拒绝、不改写：消息里既有写错的指令，也有真正的原话
  assert.ok(message.includes("总体任务：P1 横屏"));
  assert.ok(message.includes("Jev 官方博客解读"));
  assert.ok(message.includes("typesafe.ai/blog/introducing-system-one-models-and-jev"));
  assert.ok(message.includes(wrongTask));
  // 留痕说清发生了什么，并给出补救路径
  assert.equal(typeof mismatch, "string");
  assert.match(String(mismatch), /值日生的指令与老师原话说的不是同一件事/);
  assert.match(String(mismatch), /已按「总体任务 = 老师原话」下发/);
  assert.match(String(mismatch), /重派一条并取消本条/);
});

test("下发消息：指令只是漏了部分输入时不报脱节（原话已带全，不误报）", () => {
  const ask = "看 https://a.example/x 和 https://b.example/y";
  const { message, mismatch } = buildDispatchMessage({ ask, task: "研究 https://a.example/x 这篇" });
  assert.ok(message.includes("https://b.example/y"), "原话里的第二条链接也应在消息里");
  assert.equal(mismatch, null);
});

test("下发消息：拿不到老师原话时只发任务文本，不编造", () => {
  const { message, mismatch } = buildDispatchMessage({ task: "把表整理好" });
  assert.equal(message, "把表整理好");
  assert.equal(mismatch, null);
});

test("下发消息：老师原话过长时截断并注明", () => {
  const longAsk = `看这段 ${"很长的原话".repeat(600)}`;
  const { message } = buildDispatchMessage({ ask: longAsk, task: "总结" });
  assert.ok(longAsk.length > ASK_MAX_CHARS);
  assert.match(message, /老师原话过长已截断，完整原话见老师会话/);
});

test("一致性体检：指令与原话毫无共同文本 → disconnected；只是漏了句柄不算", () => {
  const drifted = checkDispatchFidelity("看 https://a.example/x 研究 Jev 的博客", "研究一下别人给我的资产，服务器要到期");
  assert.equal(drifted.disconnected, true);
  assert.deepEqual(drifted.missing, ["https://a.example/x"]);
  // 值日生只是把原话概括了一遍（漏了链接）：重合度高，不报脱节
  const summarized = checkDispatchFidelity(
    "https://github.com/a/b  研究一下别人给我的资产，给出方案让我看看",
    "研究一下别人给我的资产，给出方案让我看看",
  );
  assert.equal(summarized.disconnected, false);
  assert.ok(summarized.overlap > 0.8, String(summarized.overlap));
  assert.equal(checkDispatchFidelity("帮我写一篇短文", "写一篇 500 字短文").disconnected, false);
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
