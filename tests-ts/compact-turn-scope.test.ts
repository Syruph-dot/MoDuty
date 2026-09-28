import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { buildCompactHandoff, formatMessagesForHandoff, groupConversationTurns } from "../src/compact-handoff.ts";
import { capHistoryEntry } from "../src/context.ts";
import { SessionManager } from "../src/session-manager.ts";
import type { StoredMessage } from "../src/serialization.ts";

/**
 * 值日生上下文死锁的回归（2026-09-28 实测）：
 *  - 边界之后第一条 turn 的最后一条 agent 消息是残留的 streaming（空内容）→ 压缩范围永久为 0；
 *  - “只有用户消息、没有回复”的 turn 被旧口径判为未完成 → 同样永久挡住压缩范围；
 *  - 单条 16 万字符的消息（上游原始流泄漏）没有任何上限，一条就能吃掉大半个窗口。
 */

const msg = (over: Partial<StoredMessage> & { id: string; role: StoredMessage["role"] }): StoredMessage =>
  ({ content: "", timestamp: "2026-09-28T00:00:00.000Z", ...over }) as StoredMessage;

test("只有用户消息的轮次算已结束；最后一条仍在 streaming 才算未结束", () => {
  const { turns } = groupConversationTurns([
    msg({ id: "msg_u1", role: "user", content: "第一问" }),          // 发送失败/被中断，没有回复
    msg({ id: "msg_u2", role: "user", content: "再问一次" }),
    msg({ id: "msg_a2", role: "agent", content: "答", status: "done" }),
    msg({ id: "msg_u3", role: "user", content: "第三问" }),
    msg({ id: "msg_a3", role: "agent", content: "", status: "streaming" }),
  ]);
  assert.equal(turns.length, 3);
  assert.deepEqual(turns.map((turn) => turn.complete), [true, true, false]);
});

test("残留 streaming 定型后，压缩能覆盖整个尾部；此前会因第一条未完成而整体失败", async () => {
  const messages = [
    msg({ id: "msg_u1", role: "user", content: "任务" }),
    msg({ id: "msg_s1", role: "agent", content: "", status: "streaming" }), // 进程被杀留下的残骸
    msg({ id: "msg_u2", role: "user", content: "继续" }),
    msg({ id: "msg_a2", role: "agent", content: "完成", status: "done" }),
  ];
  const summarize = async (): Promise<string> => "# 交接摘要\n已完成。";
  await assert.rejects(
    buildCompactHandoff({ sessionId: "ses_t", messages, contextWindow: 32_000, model: "m", idFactory: () => "cmp_1", summarize }),
    /no older complete turns/u,
  );

  const finalized = messages.map((message) => (message.status === "streaming" ? { ...message, status: "stopped" as const } : message));
  const result = await buildCompactHandoff({ sessionId: "ses_t", messages: finalized, contextWindow: 32_000, model: "m", idFactory: () => "cmp_1", summarize });
  assert.equal(result.retainedTurnCount, 0);
  assert.equal(result.checkpoint.coveredThroughMessageId, "msg_a2");
});

test("摘要输入只含旧摘要与本段 turns，不含运行时提示层", async () => {
  const prompts: string[] = [];
  await buildCompactHandoff({
    sessionId: "ses_t",
    messages: [msg({ id: "msg_u1", role: "user", content: "任务" }), msg({ id: "msg_a1", role: "agent", content: "好的", status: "done" })],
    contextWindow: 32_000,
    model: "m",
    idFactory: () => "cmp_1",
    summarize: async (input) => {
      prompts.push(input);
      return "# 交接摘要\n已完成。";
    },
  });
  assert.equal(prompts.length, 1);
  assert.match(prompts[0]!, /Older completed transcript segment/u);
  assert.equal(prompts[0]!.includes("Current runtime state"), false);
  assert.equal(prompts[0]!.includes("Active Plan State"), false);
});

test("历史投影对单条超长消息设上限；摘要输入与落盘保持完整", async () => {
  const message = msg({ id: "msg_a1", role: "agent", content: "长".repeat(40_000), status: "done" });
  // 投影层截断（只影响送进模型的历史）
  const capped = capHistoryEntry(formatMessagesForHandoff([message]));
  assert.ok(capped.length < 21_000, `实际长度 ${capped.length}`);
  assert.match(capped, /本条内容过长已截断/u);
  assert.match(capped, /完整内容仍在会话记录里/u);
  // 摘要输入不截断：压缩要基于完整原文
  assert.ok(formatMessagesForHandoff([message]).includes("长".repeat(40_000)));
  // 落盘也不截断：工具结果全文要能被关系图等下游读到
  const root = await mkdtemp(path.join(tmpdir(), "moduty-nocap-"));
  try {
    const sessions = new SessionManager(root);
    const session = await sessions.createSession("任务", root);
    await sessions.addMessage(session.id, "agent", "短", { toolCalls: [{ tool: "read_file", args: "{}", result: "x".repeat(200_100) }] });
    assert.equal((await sessions.getStoredMessages(session.id)).at(-1)?.toolCalls?.[0]?.result.length, 200_100);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("开轮前把残留 streaming 消息定型为 stopped（写盘生效）", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "moduty-streaming-"));
  try {
    const sessions = new SessionManager(root);
    const session = await sessions.createSession("任务", root);
    await sessions.addMessage(session.id, "user", "开始");
    const streaming = await sessions.addMessage(session.id, "agent", "", { status: "streaming" });
    assert.equal((await sessions.getStoredMessages(session.id)).at(-1)?.status, "streaming");

    assert.deepEqual(await sessions.finalizeAbandonedStreaming(session.id), [streaming.id]);
    assert.equal((await sessions.getStoredMessages(session.id)).at(-1)?.status, "stopped");
    // 幂等：再调用一次不再有可定型的消息
    assert.deepEqual(await sessions.finalizeAbandonedStreaming(session.id), []);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

