import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { buildTurnModeBlock, resolveTurnMode } from "../src/turn-mode.ts";
import { buildDispatchSnapshot } from "../src/dispatch-snapshot.ts";
import { foldLedgerTraces, isLedgerTraceMessage } from "../src/context.ts";
import type { DispatchRecord } from "../src/dispatch-ledger.ts";

/** 值日生提示词工程：轮次模式块 / 台账快照 / 留痕折叠 */

function record(over: Partial<DispatchRecord> = {}): DispatchRecord {
  return {
    id: "dsp_000000000001",
    dispatcherId: "agt_duty",
    dispatcherSessionId: "ses_duty",
    targetAgentId: "agt_a",
    targetSessionId: "ses_a",
    task: "任务书",
    linkedSessions: [],
    dispatchedAt: "2026-09-20T10:00:00.000Z",
    state: "tracking",
    ...over,
  };
}

describe("turn mode", () => {
  it("由 transient 推导：系统注入默认判读轮，普通轮默认对话轮", () => {
    assert.equal(resolveTurnMode({}), "chat");
    assert.equal(resolveTurnMode({ transient: true }), "verdict");
    assert.equal(resolveTurnMode({ turnMode: "stalled", transient: true }), "stalled");
  });

  it("判读轮/停转轮明确禁止面向老师说话，对话轮要求按角色扮演层说话", () => {
    const verdict = buildTurnModeBlock("verdict");
    assert.match(verdict, /不要面向老师说话/);
    assert.match(verdict, /dispatch verdict/);
    const stalled = buildTurnModeBlock("stalled");
    assert.match(stalled, /已被结单/);
    const chat = buildTurnModeBlock("chat");
    assert.match(chat, /角色扮演层/);
    assert.match(chat, /台账快照/);
  });
});

describe("dispatch snapshot", () => {
  it("空台账且无待办时不注入", () => {
    assert.equal(buildDispatchSnapshot({ records: [] }), null);
    assert.equal(buildDispatchSnapshot({ records: [], pendingQuestions: 0 }), null);
  });

  it("未结单在前并给出完整 id/轮次/上次判读，已结单只列最近几条", () => {
    const now = Date.parse("2026-09-21T00:00:00.000Z");
    const text = buildDispatchSnapshot({
      records: [
        record({ id: "dsp_open_wait", state: "awaiting_verdict", lastStatus: "completed", lastStatusAt: "2026-09-20T23:50:00.000Z", continueCount: 1, lastVerdict: "continue" }),
        record({ id: "dsp_open_track", state: "tracking" }),
        record({ id: "dsp_done_1", state: "done", lastVerdict: "deliver", lastStatusAt: "2026-09-20T20:00:00.000Z" }),
        record({ id: "dsp_done_2", state: "done", lastVerdict: "cancelled", lastStatusAt: "2026-09-20T19:00:00.000Z" }),
        record({ id: "dsp_done_3", state: "done", lastVerdict: "deliver", lastStatusAt: "2026-09-18T19:00:00.000Z" }),
        record({ id: "dsp_done_4", state: "done", lastVerdict: "deliver", lastStatusAt: "2026-09-17T19:00:00.000Z" }),
      ],
      targetNames: { agt_a: "文件统计" },
      pendingQuestions: 1,
      now,
    }) ?? "";
    assert.match(text, /台账快照/);
    assert.match(text, /dsp_open_wait/);
    assert.match(text, /等判读/);
    assert.match(text, /已返工 1\/3/);
    assert.match(text, /上次判读 continue/);
    assert.match(text, /文件统计/);
    assert.match(text, /dsp_done_2 .*cancelled/);
    // 默认只列最近 3 条已结单：第三新的之外的旧条目（dsp_done_4）不该出现
    assert.ok(!text.includes("dsp_done_4"), "最旧的一条已结单不应出现在快照里");
    assert.match(text, /待老师拍板：1/);
  });

  it("未结单条目带上「老师原话 + 关键输入」，并按条聚合（2026-09-21 串台复盘）", () => {
    const now = Date.parse("2026-09-21T10:00:00.000Z");
    const text = buildDispatchSnapshot({
      records: [
        record({
          id: "dsp_074176ed8d29",
          state: "awaiting_verdict",
          targetAgentId: "agt_81116b6852d3",
          dispatchedAt: "2026-09-21T09:08:00.000Z",
          task: "总体任务：P1 横屏… 来源：https://typesafe.ai/blog/x\n\n指令（值日生的补充要求…）：研究一下别人给我的资产",
          askExcerpt: "P1 横屏（适合电脑） P2 竖屏（适合手机） 【博客信息】标题：Jev 官方博客解读…",
        }),
        record({
          id: "dsp_done_9",
          state: "done",
          targetAgentId: "agt_81116b6852d3",
          lastVerdict: "deliver",
          lastStatusAt: "2026-09-21T09:21:00.000Z",
          askExcerpt: "研究一下别人给我的资产，他们的网站的服务器要到期，准备挂到我们这边。给出方案让我看看",
        }),
      ],
      targetNames: { agt_81116b6852d3: "网站迁移" },
      now,
    }) ?? "";
    // 未结单：原话主题与关键输入都要给（判读/重派的口径依据）
    assert.match(text, /老师原话：P1 横屏/);
    assert.match(text, /关键输入：https:\/\/typesafe\.ai\/blog\/x/);
    assert.match(text, /派发 09-21 17:08/);
    // 已结单：一行结论 + 原话主题（不复述整段）
    assert.match(text, /dsp_done_9 .*deliver .*老师原话：研究一下别人给我的资产/);
  });
});

describe("ledger trace folding", () => {
  it("识别留痕消息", () => {
    assert.equal(isLedgerTraceMessage({ role: "system", content: "【判读留痕】dsp_x：…" }), true);
    assert.equal(isLedgerTraceMessage({ role: "system", content: "【自动派发】老师已确认…" }), true);
    assert.equal(isLedgerTraceMessage({ role: "user", content: "【判读留痕】x" }), false);
    assert.equal(isLedgerTraceMessage({ role: "system", content: "普通系统消息" }), false);
  });

  it("少量留痕原样返回，不折腾历史形状", () => {
    const messages = [
      { role: "user", content: "帮我写短文" },
      { role: "system", content: "【判读留痕】dsp_a：判定可交付" },
    ];
    assert.equal(foldLedgerTraces(messages), messages);
  });

  it("多条留痕折叠成按 dsp 归并的一块，最近两条保留原文", () => {
    const messages = [
      { role: "user", content: "任务一" },
      { role: "system", content: "【自动派发】老师已确认复用，实际派发给 A（台账 dsp_a）。" },
      { role: "assistant", content: "已交给「A」处理。" },
      { role: "system", content: "【判读留痕】dsp_a：判定可交付，已上报老师。备注：可交付" },
      { role: "user", content: "再做一件" },
      { role: "system", content: "【判读留痕】dsp_b：判定继续返工（1/3），已向执行者下发指令。" },
      { role: "system", content: "【判读留痕】dsp_c：判定可交付，已上报老师。" },
    ];
    const folded = foldLedgerTraces(messages);
    const text = folded.map((m) => m.content).join("\n");
    // 折叠块存在，且旧的 dsp_a 两条被归并成一行
    assert.match(text, /【台账留痕·历史已折叠 2 条】/);
    assert.match(text, /- dsp_a（2 条）：/);
    // 最近两条（dsp_b/dsp_c）保留原文，未进折叠块
    assert.ok(!text.includes("- dsp_b"), "最近留痕不该被折叠成摘要行");
    // 折叠块插在第一条被折叠留痕的位置（即 user「任务一」之后）
    const firstUser = folded.findIndex((m) => m.content === "任务一");
    const foldBlock = folded.findIndex((m) => m.content.startsWith("【台账留痕"));
    assert.equal(foldBlock, firstUser + 1);
    // 对话内容一条不丢
    assert.ok(text.includes("再做一件"));
    assert.ok(text.includes("已交给「A」处理。"));
  });
});

describe("ledger CLI（dispatch list/show/cancel 的进程内实现）", async () => {
  const { handleLedgerQuery } = await import("../src/http/agent-orchestration.ts");

  const dispatcher = { id: "agt_duty", name: "值日生", kind: "dispatcher", sessionId: "ses_duty" };
  const worker = { id: "agt_worker", name: "文件统计", sessionId: "ses_w" };
  const records = new Map<string, DispatchRecord>();
  const written: Array<{ sessionId: string; role: string; content: string }> = [];
  const ledger = {
    listAll: async () => [...records.values()],
    markDone: async (id: string, verdict: string) => {
      const found = records.get(id);
      if (!found || found.state === "done") return null;
      const next = { ...found, state: "done" as const, lastVerdict: verdict as DispatchRecord["lastVerdict"] };
      records.set(id, next);
      return next;
    },
  };
  const makeDeps = (caller: unknown) =>
    ({
      registry: {
        agentBySessionId: async (sessionId: string) =>
          sessionId === "ses_duty" ? dispatcher : sessionId === "ses_w" ? worker : (caller as Record<string, unknown> | null),
        listAgents: async () => [dispatcher, worker],
        dispatches: ledger,
      },
      agent: {
        sessionManager: {
          addMessage: async (sessionId: string, role: string, content: string) => {
            written.push({ sessionId, role, content });
          },
        },
      },
    }) as never;

  it("list 默认只看未结单、给全 id 与执行者名，--state all 含已结单", async () => {
    records.clear();
    records.set("dsp_open", record({ id: "dsp_open", state: "awaiting_verdict", targetAgentId: "agt_worker", lastStatus: "completed", continueCount: 1, lastVerdict: "continue" }));
    records.set("dsp_done", record({ id: "dsp_done", state: "done", targetAgentId: "agt_worker", lastVerdict: "deliver" }));

    const active = await handleLedgerQuery(makeDeps(null), { kind: "ledger", op: "list", callerSessionId: "ses_duty" });
    assert.equal(active.ok, true);
    assert.match(active.output, /dsp_open/);
    assert.match(active.output, /文件统计/);
    assert.match(active.output, /返工 1\/3/);
    assert.ok(!active.output.includes("dsp_done"), "默认不应列出已结单");

    const all = await handleLedgerQuery(makeDeps(null), { kind: "ledger", op: "list", state: "all", callerSessionId: "ses_duty" });
    assert.match(all.output, /dsp_done/);
  });

  it("show 给出完整任务书与元数据", async () => {
    records.clear();
    const longTask = "把这段任务书写得很长".repeat(20);
    records.set("dsp_show", record({ id: "dsp_show", targetAgentId: "agt_worker", task: longTask, state: "tracking" }));
    const res = await handleLedgerQuery(makeDeps(null), { kind: "ledger", op: "show", entryId: "dsp_show", callerSessionId: "ses_duty" });
    assert.equal(res.ok, true);
    assert.match(res.output, /任务书：/);
    assert.ok(res.output.includes(longTask), "show 必须给完整任务书（不截断）");
  });

  it("cancel 结单写 cancelled 并留痕，且提示不打断执行者", async () => {
    records.clear();
    written.length = 0;
    records.set("dsp_cancel", record({ id: "dsp_cancel", targetAgentId: "agt_worker", state: "tracking" }));
    const res = await handleLedgerQuery(makeDeps(null), { kind: "ledger", op: "cancel", entryId: "dsp_cancel", note: "派错人了", callerSessionId: "ses_duty" });
    assert.equal(res.ok, true);
    assert.equal(records.get("dsp_cancel")?.state, "done");
    assert.equal(records.get("dsp_cancel")?.lastVerdict, "cancelled");
    assert.match(res.output, /不会被中断/);
    assert.equal(written[0]?.content.includes("已取消"), true);

    const again = await handleLedgerQuery(makeDeps(null), { kind: "ledger", op: "cancel", entryId: "dsp_cancel", callerSessionId: "ses_duty" });
    assert.equal(again.ok, false);
  });

  it("非值日生调用被拒绝；他人台账不可见", async () => {
    records.clear();
    records.set("dsp_other", record({ id: "dsp_other", dispatcherId: "agt_someone_else", targetAgentId: "agt_worker" }));
    const refused = await handleLedgerQuery(makeDeps(null), { kind: "ledger", op: "list", callerSessionId: "ses_w" });
    assert.equal(refused.ok, false);
    const invisible = await handleLedgerQuery(makeDeps(null), { kind: "ledger", op: "show", entryId: "dsp_other", callerSessionId: "ses_duty" });
    assert.equal(invisible.ok, false);
  });
});
