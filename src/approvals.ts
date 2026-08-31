import { readFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import path from "node:path";

import { decodeCommandOutput } from "./exec-encoding.js";
import { atomicWriteJson, withFileLock } from "./write-queue.js";
import { appendTraceEvent, sanitizeDisplayText, sha256 } from "./trace.js";

/** 并发防护：同一审批同时被多个请求决定时，只允许一个通过读-写窗口 */
const decidingApprovals = new Set<string>();

export type ApprovalStatus = "pending" | "approved" | "rejected" | "executed";
export type ApprovalToolName = "read_file" | "list_files" | "write_file" | "append_file" | "run_shell";

export interface PendingApproval {
  id: string;
  workspace: string;
  targetWorkspace: string;
  toolName: ApprovalToolName;
  args: Record<string, string>;
  status: ApprovalStatus;
  requestedAt: string;
  tracePath?: string;
  sessionId?: string;
  runId?: string;
  operator?: string;
  decidedAt?: string;
  executedAt?: string;
  execution?: {
    resultLength: number;
    resultSha256: string;
    result: string;
    resultRedacted: boolean;
    resultTruncated: boolean;
  };
}

export interface ApprovalExecutionEvent {
  approvalId: string;
  toolName: ApprovalToolName;
  args: Record<string, string>;
  result: string;
  resultLength: number;
  resultRedacted: boolean;
  resultTruncated: boolean;
  sessionId?: string;
  runId?: string;
  message: string;
  messageId?: string;
}

export interface ShellRunResult {
  code: number;
  stdout: string;
  stderr: string;
}

export type ShellRunner = (command: string, args: string[], cwd: string) => Promise<ShellRunResult>;
export interface ApprovalStoreOptions { run?: ShellRunner; }
export class ApprovalError extends Error {}

export class ApprovalStore {
  private readonly run: ShellRunner;

  constructor(readonly workspace: string, options: ApprovalStoreOptions = {}) {
    this.workspace = path.resolve(workspace);
    this.run = options.run ?? runAllowedCommand;
  }

  async list(): Promise<PendingApproval[]> {
    try {
      const value = JSON.parse(await readFile(this.filePath(), "utf8")) as unknown;
      return Array.isArray(value) ? value.filter(isPendingApproval) : [];
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
      throw error;
    }
  }

  async request(input: Omit<PendingApproval, "id" | "workspace" | "status" | "requestedAt">): Promise<PendingApproval> {
    const records = await this.list();
    const record: PendingApproval = {
      ...input,
      workspace: this.workspace,
      targetWorkspace: path.resolve(input.targetWorkspace),
      id: randomUUID(),
      status: "pending",
      requestedAt: new Date().toISOString(),
    };
    records.push(record);
    await this.save(records);
    await appendTraceEvent(record.tracePath, "approval_requested", traceDetails(record));
    return record;
  }

  async runWhitelisted(command: string, cwd = this.workspace): Promise<ShellRunResult> {
    const parsed = parseWhitelistedCommand(command);
    if (!parsed) throw new Error("Command is not on the automatic execution allowlist");
    return await this.run(parsed.command, parsed.args, cwd);
  }

  async runApproved(command: string, cwd: string): Promise<ShellRunResult> {
    // 人工批准的命令原样经系统 shell 执行（测试期：不限制控制语法 / PowerShell）。
    // 仍走 this.run（沙箱开启时即为沙箱执行器），确保在沙箱内运行。
    const rawCommand = process.platform === "win32" ? "cmd.exe" : "/bin/sh";
    const rawArgs = process.platform === "win32" ? ["/d", "/s", "/c", command] : ["-c", command];
    return await this.run(rawCommand, rawArgs, cwd);
  }

  async decide(id: string, decision: "approved" | "rejected", operator: string): Promise<PendingApproval> {
    if (!operator.trim()) throw new ApprovalError("Approval operator is required");
    if (decidingApprovals.has(id)) throw new ApprovalError(`Approval ${id} is already being decided`);
    decidingApprovals.add(id);
    try {
      const records = await this.list();
      const record = records.find((candidate) => candidate.id === id);
      if (!record) throw new ApprovalError(`Unknown approval: ${id}`);
      if (record.status !== "pending") throw new ApprovalError(`Approval ${id} has already been decided`);
      record.status = decision;
      record.operator = operator.trim();
      record.decidedAt = new Date().toISOString();
      await this.save(records);
      await appendTraceEvent(record.tracePath, "approval_decision", { ...traceDetails(record), decision, operator: record.operator });
      return record;
    } finally {
      decidingApprovals.delete(id);
    }
  }

  async complete(id: string, result: string): Promise<PendingApproval> {
    const records = await this.list();
    const record = records.find((candidate) => candidate.id === id);
    if (!record) throw new ApprovalError(`Unknown approval: ${id}`);
    if (record.status !== "approved") throw new ApprovalError(`Approval ${id} cannot be executed`);
    const display = sanitizeDisplayText(result);
    record.status = "executed";
    record.executedAt = new Date().toISOString();
    record.execution = {
      resultLength: result.length,
      resultSha256: sha256(result),
      result: display.text,
      resultRedacted: display.redacted,
      resultTruncated: display.truncated,
    };
    await this.save(records);
    await appendTraceEvent(record.tracePath, "approval_executed", {
      ...traceDetails(record), operator: record.operator, resultLength: result.length, resultSha256: sha256(result),
    });
    return record;
  }

  private filePath(): string { return path.join(this.workspace, "pending_approvals.json"); }
  private async save(records: PendingApproval[]): Promise<void> {
    await withFileLock(this.filePath(), () => atomicWriteJson(this.filePath(), records));
  }
}

export function createApprovalExecutionEvent(record: PendingApproval): ApprovalExecutionEvent {
  const execution = record.execution;
  if (!execution) throw new ApprovalError(`Approval ${record.id} has no execution result`);
  return {
    approvalId: record.id,
    toolName: record.toolName,
    args: record.args,
    result: execution.result,
    resultLength: execution.resultLength,
    resultRedacted: execution.resultRedacted,
    resultTruncated: execution.resultTruncated,
    sessionId: record.sessionId,
    runId: record.runId,
    message: `已执行批准的 ${record.toolName}。\n\n${execution.result || "命令未输出内容。"}`,
  };
}

export function parseWhitelistedCommand(input: string): { command: string; args: string[] } | null {
  const tokens = parseExecutableCommand(input);
  if (!tokens) return null;
  const [command, second, ...rest] = [tokens.command, ...tokens.args];
  if (command === "npm" && second === "test") return { command: "npm", args: ["test", ...rest] };
  if (command === "dir") return { command: "cmd.exe", args: ["/d", "/s", "/c", "dir", ...tokens.args] };
  if (["pytest", "rg", "ls"].includes(command)) return { command, args: tokens.args };
  return null;
}

export function parseExecutableCommand(input: string): { command: string; args: string[] } | null {
  if (/[|;&><`$()\r\n]/u.test(input)) return null;
  const [command, ...args] = input.trim().split(/\s+/u);
  if (!command || /^(?:powershell|powershell\.exe|pwsh|pwsh\.exe)$/iu.test(command)) return null;
  return { command, args };
}

function traceDetails(record: PendingApproval): Record<string, unknown> {
  return {
    approvalId: record.id,
    toolName: record.toolName,
    arguments: record.args,
    workspace: record.workspace,
    targetWorkspace: record.targetWorkspace,
    sessionId: record.sessionId,
    runId: record.runId,
  };
}

function runAllowedCommand(command: string, args: string[], cwd: string): Promise<ShellRunResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd, shell: false, windowsHide: true });
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    child.stdout.on("data", (chunk: Buffer) => stdout.push(chunk));
    child.stderr.on("data", (chunk: Buffer) => stderr.push(chunk));
    child.once("error", reject);
    child.once("close", (code) => resolve({ code: code ?? 1, stdout: decodeCommandOutput(Buffer.concat(stdout)), stderr: decodeCommandOutput(Buffer.concat(stderr)) }));
  });
}

function isPendingApproval(value: unknown): value is PendingApproval {
  if (!value || typeof value !== "object") return false;
  const record = value as Record<string, unknown>;
  return typeof record.id === "string" && typeof record.workspace === "string" && typeof record.targetWorkspace === "string"
    && typeof record.toolName === "string" && typeof record.status === "string" && typeof record.requestedAt === "string"
    && !!record.args && typeof record.args === "object";
}
