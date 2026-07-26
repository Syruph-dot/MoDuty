import path from "node:path";

import { readJsonList, writeJsonList } from "./json-file.js";
import { containsSensitiveTraceContent, sha256 } from "./trace.js";
import type { MomokaGraphState, RunRecord, RunRecordInput, RunStateSummary, ToolCall } from "./types.js";

export class RunStore {
  constructor(private readonly memoryDir: string) {}

  private runsPath(): string {
    return path.join(this.memoryDir, ".runs", "runs.json");
  }

  async recordRun(run: RunRecordInput): Promise<RunRecord> {
    const stored = toRunRecord(run);
    const runs = (await readJsonList(this.runsPath())).filter((item) => String(item.run_id ?? item.runId ?? "") !== stored.runId);
    runs.push(runToDisk(stored));
    await writeJsonList(this.runsPath(), runs.slice(-400));
    return stored;
  }

  async getRun(runId: string): Promise<RunRecord | null> {
    const runs = await readJsonList(this.runsPath());
    for (const raw of runs.reverse()) {
      const record = runFromDisk(raw);
      if (record.runId === runId) {
        return record;
      }
    }
    return null;
  }
}

function runToDisk(run: RunRecord): Record<string, unknown> {
  return {
    run_id: run.runId,
    kind: run.kind,
    session_id: run.sessionId,
    output_id: run.outputId,
    response: run.response,
    created_at: run.createdAt,
    state: run.state,
  };
}

function runFromDisk(raw: Record<string, unknown>): RunRecord {
  return {
    runId: String(raw.run_id ?? raw.runId ?? ""),
    kind: raw.kind === "judge" ? "judge" : "chat",
    sessionId: typeof raw.session_id === "string"
      ? raw.session_id
      : typeof raw.sessionId === "string"
        ? raw.sessionId
        : null,
    outputId: String(raw.output_id ?? raw.outputId ?? ""),
    response: String(raw.response ?? ""),
    createdAt: String(raw.created_at ?? raw.createdAt ?? ""),
    state: summarizeRawState(raw.state),
  };
}

function toRunRecord(run: RunRecordInput): RunRecord {
  return {
    runId: run.runId,
    kind: run.kind,
    sessionId: run.sessionId,
    outputId: run.outputId,
    response: run.response,
    createdAt: run.createdAt,
    state: summarizeState(run.state),
  };
}

function summarizeState(state: MomokaGraphState): RunStateSummary {
  return {
    requestKind: state.requestKind,
    assessmentAction: state.assessment?.action,
    continueRequested: state.continueRequested,
    continuationOutputId: state.continuationOutputId,
    toolEvents: summarizeToolCalls(state.toolCalls),
  };
}

function summarizeRawState(value: unknown): RunStateSummary {
  const state = value && typeof value === "object" ? value as Record<string, unknown> : {};
  const rawToolCalls = Array.isArray(state.toolEvents)
    ? state.toolEvents
    : Array.isArray(state.toolCalls)
      ? state.toolCalls
      : [];
  return {
    requestKind: state.requestKind === "judge" ? "judge" : "chat",
    assessmentAction: assessmentAction(state.assessmentAction ?? (state.assessment as Record<string, unknown> | undefined)?.action),
    continueRequested: Boolean(state.continueRequested),
    continuationOutputId: stringOrUndefined(state.continuationOutputId),
    toolEvents: rawToolCalls.map(summarizeRawToolCall),
  };
}

function summarizeToolCalls(toolCalls: ToolCall[]): RunStateSummary["toolEvents"] {
  return toolCalls.map((toolCall) => summarizeToolCall(toolCall.tool, toolCall.args, toolCall.result));
}

function summarizeRawToolCall(value: unknown): RunStateSummary["toolEvents"][number] {
  const toolCall = value && typeof value === "object" ? value as Record<string, unknown> : {};
  if (typeof toolCall.argumentsLength === "number" && typeof toolCall.argumentsSha256 === "string") {
    return {
      name: String(toolCall.name ?? ""),
      argumentsLength: toolCall.argumentsLength,
      argumentsSha256: toolCall.argumentsSha256,
      argumentsRedacted: Boolean(toolCall.argumentsRedacted),
      resultLength: Number(toolCall.resultLength ?? 0),
      resultSha256: String(toolCall.resultSha256 ?? sha256("")),
      resultRedacted: Boolean(toolCall.resultRedacted),
    };
  }
  return summarizeToolCall(String(toolCall.tool ?? toolCall.name ?? ""), String(toolCall.args ?? ""), String(toolCall.result ?? ""));
}

function summarizeToolCall(name: string, args: string, result: string): RunStateSummary["toolEvents"][number] {
  return {
    name,
    argumentsLength: args.length,
    argumentsSha256: sha256(args),
    argumentsRedacted: containsSensitiveTraceContent(args),
    resultLength: result.length,
    resultSha256: sha256(result),
    resultRedacted: containsSensitiveTraceContent(result),
  };
}

function assessmentAction(value: unknown): RunStateSummary["assessmentAction"] {
  return value === "accept" || value === "revise" ? value : undefined;
}

function stringOrUndefined(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}
