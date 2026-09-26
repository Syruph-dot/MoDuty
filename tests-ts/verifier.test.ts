import assert from "node:assert/strict";
import test from "node:test";

import { applyVerdictPolicy, verifyStep, type VerificationReport } from "../src/verifier.ts";

test("验收要求产物但没有显式路径时失败，不从验收文字猜路径", async () => {
  let fileChecks = 0;
  const report = await verifyStep({
    stepId: "step-report",
    artifacts: [],
    acceptanceCriteria: ["输出文件 report.md 必须存在"],
    io: {
      fileSize: async () => {
        fileChecks += 1;
        return 100;
      },
    },
  });

  assert.equal(fileChecks, 0);
  assert.equal(report.verdict, "fail");
  assert.match(report.failures.join("\n"), /没有声明产物路径/);
});

function report(verdict: VerificationReport["verdict"]): VerificationReport {
  return {
    verdict,
    checks: [],
    failures: verdict === "fail" ? ["测试未通过"] : [],
    unmappedCriteria: verdict === "warn" ? ["体验符合预期"] : [],
    evidence: "验收证据",
  };
}

test("只有客观验收通过时允许交付", () => {
  const passed = applyVerdictPolicy({ report: report("pass"), requested: "deliver" });
  assert.equal(passed.allow, true);
  assert.equal(passed.verdict, "deliver");

  const warning = applyVerdictPolicy({ report: report("warn"), requested: "deliver" });
  assert.equal(warning.allow, false);
  assert.equal(warning.verdict, "blocked");

  const failedAtLimit = applyVerdictPolicy({
    report: report("fail"),
    requested: "deliver",
    continueCount: 3,
    maxContinue: 3,
  });
  assert.equal(failedAtLimit.allow, false);
  assert.equal(failedAtLimit.verdict, "blocked");
});

test("缺少验收报告时不允许交付", () => {
  const result = applyVerdictPolicy({ report: null, requested: "deliver" });
  assert.equal(result.allow, false);
  assert.equal(result.verdict, "blocked");
});
