import { test } from "node:test";
import assert from "node:assert/strict";
import { validateMomokaCliArgs } from "../src/tools.js";

test("run_momoka_cli 白名单：放行文档化子命令", () => {
  assert.equal(validateMomokaCliArgs(["agent", "list"]), null);
  assert.equal(validateMomokaCliArgs(["agent", "create", "--name", "执行者A"]), null);
  assert.equal(validateMomokaCliArgs(["agent", "chat", "agt_abc123", "处理报表，参考 &ses_xyz123"]), null);
  assert.equal(validateMomokaCliArgs(["agent", "reset", "agt_abc123"]), null);
  assert.equal(validateMomokaCliArgs(["agent", "stop", "agt_abc123"]), null);
  assert.equal(validateMomokaCliArgs(["session", "list"]), null);
  assert.equal(validateMomokaCliArgs(["session", "inspect", "ses_xyz123"]), null);
});

test("run_momoka_cli 白名单：拒绝非文档化调用", () => {
  assert.match(validateMomokaCliArgs(["rm", "-rf", "/"]) ?? "", /未知命令/);
  assert.match(validateMomokaCliArgs(["node", "evil.mjs"]) ?? "", /未知命令/);
  assert.match(validateMomokaCliArgs(["agent", "delete", "agt_abc123"]) ?? "", /未知子命令/);
  assert.match(validateMomokaCliArgs(["agent", "create"]) ?? "", /必须提供 --name/);
  assert.match(validateMomokaCliArgs(["agent", "chat"]) ?? "", /需要 agentId/);
  assert.match(validateMomokaCliArgs(["session", "inspect"]) ?? "", /需要会话句柄/);
  assert.match(validateMomokaCliArgs(["agent", "list", "x", "y", "z", "w", "a", "b", "c", "d", "e", "f", "g", "h", "i", "j", "k", "l", "m", "n", "o", "p", "q", "r", "s", "t", "u", "v", "x", "y", "z", "w", "a", "b", "c", "d", "e", "f", "g", "h", "i", "j", "k", "l", "m", "n", "o", "p", "q", "r", "s", "t", "u", "v", "x", "y", "z", "w", "a", "b", "c", "d", "e", "f", "g", "h", "i", "j", "k", "l"]) ?? "", /参数数量非法/);
  assert.match(validateMomokaCliArgs(["agent", "create", "--name", "ok\u0000"]) ?? "", /控制字符/);
});

test("run_momoka_cli：新增 help/status 与 session list 过滤", () => {
  assert.equal(validateMomokaCliArgs(["help"]), null);
  assert.equal(validateMomokaCliArgs(["status"]), null);
  assert.match(validateMomokaCliArgs(["help", "extra"]) ?? "", /不接受参数/);
  assert.equal(validateMomokaCliArgs(["session", "list", "--query", "MoDuty", "--limit", "5"]), null);
  assert.equal(validateMomokaCliArgs(["agent", "list", "--query", "行数"]), null);
});

test("远程渠道（手机机器人）多放行两个动词，Agent 侧不放行", () => {
  // remote：值日生 / 按会话对话
  assert.equal(validateMomokaCliArgs(["agent", "dispatcher", "现在怎么样"], "remote"), null);
  assert.equal(validateMomokaCliArgs(["session", "chat", "MoDuty README 摘要", "帮我看看"], "remote"), null);
  assert.match(validateMomokaCliArgs(["agent", "dispatcher"], "remote") ?? "", /需要消息文本/);
  assert.match(validateMomokaCliArgs(["session", "chat", "ses_abc"], "remote") ?? "", /需要 <ses_id|关键词> 与消息文本/);
  // agent 侧（默认 scope）：这两个动词不出现，避免 Agent 互相唤醒成环
  assert.match(validateMomokaCliArgs(["agent", "dispatcher", "hi"]) ?? "", /未知子命令/);
  assert.match(validateMomokaCliArgs(["session", "chat", "ses_abc", "hi"]) ?? "", /未知子命令/);
});

test("回归：MoDuty CLI 的输出按 UTF-8 解码，中文与结构性字符都不乱码", async () => {
  // 实测 2026-09-21：以前用 decodeCommandOutput（Windows 走 GBK）解 Node 子进程输出，
  // 微信机器人回复变成「MOMOKA CLI v1 鈥� 璁� Agent 鐢� Agent 搴旂敤」，Agent 读到的
  // run_momoka_cli 工具结果同样受影响。
  const { runMomokaCliTool } = await import("../src/tools.js");
  const help = await runMomokaCliTool({ args: ["help"] });
  assert.ok(help.includes("MOMOKA CLI"), help.slice(0, 120));
  assert.ok(!help.includes("\uFFFD"), `不应出现替换符：${help.slice(0, 120)}`);
  assert.ok(!/[\uFFFD]|鈥|璁|鐢|搴/.test(help), `不应出现 UTF-8 被当 GBK 解的典型乱码：${help.slice(0, 160)}`);
  assert.match(help, /用法|命令|usage/iu);
});
