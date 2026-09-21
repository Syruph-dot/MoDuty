import { test } from "node:test";
import assert from "node:assert/strict";
import { classifyBotCommand, polishCliOutput, runBotCommand } from "../src/bot/command.js";

test("手机命令分流：只读命令秒回，驱动 Agent 的命令先回「处理中」", () => {
  // 裸文本 → 交给值日生（长任务）
  assert.equal(classifyBotCommand("帮我看看今天的日报"), "agent");
  // 只读
  assert.equal(classifyBotCommand("/help"), "quick");
  assert.equal(classifyBotCommand("/status"), "quick");
  assert.equal(classifyBotCommand("/sessions 日报"), "quick");
  assert.equal(classifyBotCommand("/session list"), "quick");
  assert.equal(classifyBotCommand("/session inspect ses_abc"), "quick");
  assert.equal(classifyBotCommand("/new 压缩包说明"), "quick");
  assert.equal(classifyBotCommand("/agent list"), "quick");
  assert.equal(classifyBotCommand("/agent create --name X"), "quick");
  assert.equal(classifyBotCommand("/dispatch list"), "quick");
  // 驱动 Agent
  assert.equal(classifyBotCommand("/chat 日报 帮我看看"), "agent");
  assert.equal(classifyBotCommand("/agent 填表助手 你好"), "agent");
  assert.equal(classifyBotCommand("/agent dispatcher 你好"), "agent");
});

test("输出整理：去掉 done 行与工具噪声、统计工具次数、超长截断", () => {
  const raw = [
    "→ 值日生 值日生 (agt_1)",
    "[工具 web_search 运行中]",
    "[工具 web_search 完成] 12 条结果",
    "今天的事情都办完了～",
    "[工具 run_momoka_cli 完成] ok",
    "[done run=run_1]",
  ].join("\n");
  const out = polishCliOutput(raw);
  assert.equal(out, "今天的事情都办完了～\n\n（期间调用了 2 个工具）");
  assert.doesNotMatch(out, /done run=/);
  assert.doesNotMatch(out, /→ 值日生/);

  // 用户拍板：正常长度不截断（投递层会拆成多条消息发完），只保留跑飞兜底
  const long = polishCliOutput("x".repeat(2500));
  assert.equal(long.length, 2500);
  assert.doesNotMatch(long, /已截断/);
  const runaway = polishCliOutput("x".repeat(61_000));
  assert.match(runaway, /停止读取/);

  assert.equal(polishCliOutput("   \n\n  "), "（没有输出）");
});

test("不认识的命令回用法，不触发任何执行", async () => {
  const result = await runBotCommand({ text: "/xyzzy", defaultTarget: { kind: "dispatcher" } });
  assert.equal(result.ran, false);
  assert.match(result.text, /不认识的命令/);
  assert.match(result.text, /\/status/);
});

test("/chat 与 /agent 缺参数时给出用法", async () => {
  const chat = await runBotCommand({ text: "/chat 只有会话名", defaultTarget: { kind: "dispatcher" } });
  assert.equal(chat.ran, false);
  assert.match(chat.text, /用法：\/chat/);

  const agent = await runBotCommand({ text: "/agent", defaultTarget: { kind: "dispatcher" } });
  assert.equal(agent.ran, false);
  assert.match(agent.text, /用法：\/agent/);
});
