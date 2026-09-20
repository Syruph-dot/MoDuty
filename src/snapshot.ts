import { copyFile, mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

import { atomicWriteJson, withFileLock } from "./write-queue.js";
import { findCheckpointByRunId } from "./run-checkpoint.js";

export interface RunSnapshotInput {
  runId: string;
  workDir: string;
  tracePath?: string;
  sessionId?: string | null;
}

export interface SnapshotSummary {
  snapshotDir: string;
  runId: string;
  savedAt: string;
  pendingApprovalCount: number;
  finalReportPath: string;
}

export interface FinalReportInput {
  runId: string;
  workDir: string;
  tracePath?: string;
  sessionId?: string | null;
}

export interface ResumeSummary {
  snapshotDir: string;
  runId: string;
  restoredApprovals: number;
  workspaceFiles: string[];
  pendingApprovals: number;
  /**
   * P6：同一 runId 的执行断点（若存在）。
   * 有它意味着可以工具调用位置续跑：`model-client` 会按 `runId+轮次+工具名+参数` 的 key 命中已记录结果，
   * 直接复用而不重放副作用（写文件/跑命令不会再来一次）。
   */
  checkpoint?: {
    file: string;
    status: string;
    round: number;
    recordedToolCalls: number;
    lastError?: string;
  };
}

interface TraceLine {
  event?: string;
  timestamp?: string;
  name?: string;
  arguments?: string;
  decision?: string;
  operator?: string;
  operation?: string;
  requestedPath?: string;
  toolName?: string;
  responseLength?: number;
  [key: string]: unknown;
}

/**
 * 生成 snapshot/<runId>/，包含：
 * - trace.jsonl（本次运行的完整事件流）
 * - pending_approvals.json（审批队列快照）
 * - final_report.md（最终报告：修改文件、验证命令、审批、越权）
 */
export async function saveRunSnapshot(input: RunSnapshotInput): Promise<SnapshotSummary> {
  const workspace = path.resolve(input.workDir);
  const snapshotDir = path.join(workspace, "snapshot", input.runId);
  await mkdir(snapshotDir, { recursive: true });

  if (input.tracePath) {
    await copyFile(input.tracePath, path.join(snapshotDir, "trace.jsonl")).catch(() => undefined);
  }

  let pendingApprovalCount = 0;
  const approvalsPath = path.join(workspace, "pending_approvals.json");
  try {
    await copyFile(approvalsPath, path.join(snapshotDir, "pending_approvals.json"));
    const approvals = JSON.parse(await readFile(approvalsPath, "utf8")) as unknown;
    pendingApprovalCount = Array.isArray(approvals) ? approvals.length : 0;
  } catch {
    pendingApprovalCount = 0;
  }

  const finalReportPath = path.join(snapshotDir, "final_report.md");
  const report = await buildFinalReport({ ...input, workDir: workspace });
  await writeFile(finalReportPath, report, "utf8");

  return {
    snapshotDir,
    runId: input.runId,
    savedAt: new Date().toISOString(),
    pendingApprovalCount,
    finalReportPath,
  };
}

/** 从 trace 事件流汇总生成最终报告（修改文件 / 验证命令 / 审批记录 / 越权与失败） */
export async function buildFinalReport(input: FinalReportInput): Promise<string> {
  const lines: Array<string | null> = [
    `# Final Report — Run ${input.runId}`,
    "",
    `- 生成时间：${new Date().toISOString()}`,
    `- 工作区：${path.resolve(input.workDir)}`,
    input.sessionId ? `- 会话：${input.sessionId}` : null,
    "",
  ];

  const traceEvents = input.tracePath ? await readTraceEvents(input.tracePath) : [];
  const toolEvents = traceEvents.filter((event) => event.event === "tool_call");
  const approvals = traceEvents.filter((event) => event.event?.startsWith("approval_"));
  const violations = traceEvents.filter((event) => event.event === "workspace_violation");
  const finalAnswers = traceEvents.filter((event) => event.event === "final_answer");

  const modifiedFiles = new Set<string>();
  for (const event of toolEvents) {
    if (event.name === "write_file" || event.name === "append_file") {
      const args = typeof event.arguments === "string" ? safeJsonParse(event.arguments) : null;
      if (args?.path) modifiedFiles.add(String(args.path));
    }
  }
  lines.push("## 修改文件");
  if (modifiedFiles.size === 0) {
    lines.push("（无）");
  } else {
    for (const file of modifiedFiles) lines.push(`- ${file}`);
  }
  lines.push("");

  const commands = toolEvents
    .filter((event) => event.name === "run_shell")
    .map((event) => {
      const args = typeof event.arguments === "string" ? safeJsonParse(event.arguments) : null;
      return String(args?.command ?? "?");
    });
  lines.push("## 验证命令 / 执行命令");
  if (commands.length === 0) {
    lines.push("（无）");
  } else {
    for (const command of commands) lines.push(`- \`${command}\``);
  }
  lines.push("");

  lines.push("## 审批记录");
  if (approvals.length === 0) {
    lines.push("（无）");
  } else {
    for (const event of approvals) {
      const decision = event.decision ? `（${event.decision}${event.operator ? ` by ${event.operator}` : ""}）` : "";
      lines.push(`- [${event.event}] ${event.toolName ?? "?"} ${decision}`);
    }
  }
  lines.push("");

  lines.push("## 越权与失败");
  if (violations.length === 0) {
    lines.push("（无）");
  } else {
    for (const event of violations) {
      lines.push(`- ${event.operation ?? "?"} ${event.requestedPath ?? "?"}（已拒绝）`);
    }
  }
  lines.push("");

  lines.push("## 运行统计");
  lines.push(`- 工具调用：${toolEvents.length} 次`);
  lines.push(`- 审批事件：${approvals.length} 条`);
  lines.push(`- 越权拒绝：${violations.length} 次`);
  if (finalAnswers.length > 0) {
    const answer = finalAnswers[finalAnswers.length - 1];
    lines.push(`- 最终答复长度：${typeof answer.responseLength === "number" ? answer.responseLength : "?"}`);
  }
  lines.push("");

  lines.push("## 未解决风险");
  lines.push("- （待人工补充）");
  lines.push("");

  return lines.filter((line): line is string => line !== null).join("\n");
}

/** 从 snapshot/<runId>/ 恢复：把快照中的待审批项合并回工作区（本地文件保留），返回摘要 */
export async function resumeRunFromSnapshot(workDir: string, runId: string): Promise<ResumeSummary> {
  const workspace = path.resolve(workDir);
  const snapshotDir = path.join(workspace, "snapshot", runId);
  let restoredApprovals = 0;

  const snapshotApprovals = path.join(snapshotDir, "pending_approvals.json");
  try {
    const snapshotRecords = JSON.parse(await readFile(snapshotApprovals, "utf8")) as Array<{ id?: string }>;
    if (Array.isArray(snapshotRecords)) {
      const workspaceApprovalsPath = path.join(workspace, "pending_approvals.json");
      let workspaceRecords: Array<{ id?: string }> = [];
      try {
        const parsed = JSON.parse(await readFile(workspaceApprovalsPath, "utf8")) as unknown;
        workspaceRecords = Array.isArray(parsed) ? parsed as Array<{ id?: string }> : [];
      } catch {
        workspaceRecords = [];
      }
      const existingIds = new Set(workspaceRecords.map((record) => record.id));
      const missing = snapshotRecords.filter((record) => record.id && !existingIds.has(record.id));
      if (missing.length > 0) {
        await withFileLock(workspaceApprovalsPath, () =>
          atomicWriteJson(workspaceApprovalsPath, [...workspaceRecords, ...missing]),
        );
        restoredApprovals = missing.length;
      }
    }
  } catch {
    restoredApprovals = 0;
  }

  const found = await findCheckpointByRunId(workspace, runId).catch(() => null);
  return {
    snapshotDir,
    runId,
    restoredApprovals,
    workspaceFiles: [],
    pendingApprovals: restoredApprovals,
    ...(found
      ? {
          checkpoint: {
            file: found.file,
            status: found.checkpoint.status,
            round: found.checkpoint.round,
            recordedToolCalls: found.checkpoint.toolCalls.length,
            ...(found.checkpoint.lastError ? { lastError: found.checkpoint.lastError } : {}),
          },
        }
      : {}),
  };
}

async function readTraceEvents(tracePath: string): Promise<TraceLine[]> {
  try {
    const content = await readFile(tracePath, "utf8");
    return content
      .split("\n")
      .filter(Boolean)
      .map((line) => {
        try {
          return JSON.parse(line) as TraceLine;
        } catch {
          return null;
        }
      })
      .filter((line): line is TraceLine => line !== null);
  } catch {
    return [];
  }
}

function safeJsonParse(value: string): Record<string, unknown> | null {
  try {
    return JSON.parse(value) as Record<string, unknown>;
  } catch {
    return null;
  }
}

