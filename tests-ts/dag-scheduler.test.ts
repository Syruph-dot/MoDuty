import assert from "node:assert/strict";
import test from "node:test";

import { pickExecutor, schedulePlan, type DagStep, type ExecutorCandidate } from "../src/dag-scheduler.ts";

const step: DagStep = {
  id: "step-report",
  title: "生成日报",
  status: "ready",
  dependsOn: [],
  capability: "daily-report",
  artifacts: [],
  attempts: 0,
};

test("显式能力没有匹配执行者时保持不可调度，不派给无关空闲 Agent", () => {
  const candidates: ExecutorCandidate[] = [{ id: "agent-general", capabilities: ["chat"] }];

  assert.equal(pickExecutor(step, candidates), undefined);
  const result = schedulePlan({ id: "plan-1", steps: [step] }, candidates);
  assert.deepEqual(result.dispatch, []);
  assert.equal(result.unschedulable[0]?.stepId, step.id);
  assert.match(result.unschedulable[0]?.reason ?? "", /daily-report/);
});

test("显式 owner 不可用时不改派给其它执行者", () => {
  const ownedStep = { ...step, ownerAgentId: "agent-owner" };
  const candidates: ExecutorCandidate[] = [
    { id: "agent-owner", capabilities: ["daily-report"], busy: true },
    { id: "agent-other", capabilities: ["daily-report"] },
  ];

  assert.equal(pickExecutor(ownedStep, candidates), undefined);
  const result = schedulePlan({ id: "plan-2", steps: [ownedStep] }, candidates);
  assert.deepEqual(result.dispatch, []);
  assert.match(result.unschedulable[0]?.reason ?? "", /agent-owner/);
});
