import assert from "node:assert/strict";
import test from "node:test";

import { verifyStep } from "../src/verifier.ts";

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
