import { access, readFile, stat } from "node:fs/promises";
import path from "node:path";

import { LIKERT_LABELS, defaultPaths, resolveProjectRoot } from "./config.js";
import { analyzeJudgment, buildFollowupPrompt } from "./feedback.js";
import { MemoryStore } from "./memory.js";
import { SessionManager } from "./session-manager.js";
import { ApprovalError, ApprovalStore, createApprovalExecutionEvent } from "./approvals.js";
import { executeApprovedToolCall } from "./tools.js";
import { appendTraceEvent, createRunTrace } from "./trace.js";
import { saveRunSnapshot } from "./snapshot.js";
import { initSettings, isSandboxEnabled as getSandboxFlag, setSandboxEnabled as persistSandboxFlag } from "./settings.js";
import type { ChatRequest, ChatResponse, JudgeRequest, JudgeResponse, ModelClient, MomokaAgent } from "./types.js";

interface MomokaAgentOptions { projectRoot?: string; modelClient: ModelClient; }
const accept = { action: "accept" as const, reasons: [], revisionPrompt: "" };
const makeId = (prefix: string) => `${prefix}_${crypto.randomUUID().replace(/-/g, "").slice(0, 12)}`;

export class MomokaAgentCore implements MomokaAgent {
  readonly projectRoot: string;
  readonly memoryStore: MemoryStore;
  readonly sessionManager: SessionManager;

  constructor(private readonly options: MomokaAgentOptions) {
    this.projectRoot = resolveProjectRoot(options.projectRoot);
    initSettings(this.projectRoot);
    this.memoryStore = new MemoryStore(defaultPaths(this.projectRoot).memoryDir);
    this.sessionManager = new SessionManager(defaultPaths(this.projectRoot).memoryDir);
  }

  get memory() {
    return {
      recordOutput: this.memoryStore.recordOutput.bind(this.memoryStore),
      getOutput: this.memoryStore.getOutput.bind(this.memoryStore),
      recordJudgment: this.memoryStore.recordJudgment.bind(this.memoryStore),
    };
  }

  async buildSystemPrompt(input: { workDir?: string } = {}): Promise<string> {
    let prompt = "You are MOMOKA, a concise file assistant.";
    try { prompt = await readFile(path.join(this.projectRoot, "prompts", "AGENTS.md"), "utf8"); } catch { /* fallback */ }
    return input.workDir ? `${prompt}\n\n## Current Work Directory\n${input.workDir}` : prompt;
  }

  async chat(request: ChatRequest): Promise<ChatResponse> {
    const message = request.message.trim();
    if (!message) throw new MomokaHttpError(400, "Message cannot be empty");
    const runId = makeId("run");
    const outputId = request.outputId?.trim() || makeId("out");
    const sessionId = request.sessionId ?? null;
    let workDir = request.workDir;
    let history = "";
    if (sessionId) {
      const session = await this.sessionManager.getSession(sessionId);
      if (!session) throw new MomokaHttpError(404, `Unknown session: ${sessionId}`);
      workDir = session.folderPath;
      await this.sessionManager.addMessage(sessionId, "user", message);
      history = formatHistory((await this.sessionManager.getMessages(sessionId, null)).slice(0, -1));
    }
    const tracePath = await createRunTrace(workDir ?? this.projectRoot);
    const topic = request.topic?.trim() || message.slice(0, 80);
    const result = await this.options.modelClient.run([history, "## Current User Request", message].filter(Boolean).join("\n\n"), {
      systemPrompt: await this.buildSystemPrompt({ workDir }), topic, workDir, tracePath, sessionId, runId, matchedSkills: [], requestKind: "chat",
      onEvent: request.onEvent, signal: request.signal,
    });
    await appendTraceEvent(tracePath, "final_answer", { response: result.output });
    await this.memoryStore.recordOutput({ outputId, prompt: message, response: result.output, topic, matchedSkills: [], toolCalls: result.toolCalls ?? [], sessionId });
    if (sessionId) await this.sessionManager.addMessage(sessionId, "agent", result.output, { outputId, toolCalls: result.toolCalls ?? [] });
    await saveRunSnapshot({ runId, workDir: workDir ?? this.projectRoot, tracePath, sessionId: sessionId ?? undefined }).catch(async (error: unknown) => {
      await appendTraceEvent(tracePath, "snapshot_failed", { message: error instanceof Error ? error.message : String(error) });
    });
    return { runId, outputId, topic, response: result.output, annotationRuntimeContext: "", outputAssessment: accept, toolCalls: result.toolCalls ?? [], matchedSkills: [], skillReasons: [], sessionId };
  }

  async judge(request: JudgeRequest): Promise<JudgeResponse> {
    if (!Number.isInteger(request.score) || request.score < 1 || request.score > 7) throw new MomokaHttpError(400, "Score must be an integer from 1 to 7");
    const output = await this.memoryStore.getOutput(request.outputId);
    if (!output) throw new MomokaHttpError(404, `Unknown output_id: ${request.outputId}`);
    const judgment = await this.memoryStore.recordJudgment(request);
    const label = LIKERT_LABELS[request.score] ?? "";
    const reflection = analyzeJudgment({ score: request.score, label, annotatedText: judgment.context, topic: judgment.topic, userComment: judgment.comment });
    const base: JudgeResponse = { runId: makeId("run"), outputId: request.outputId, score: request.score, label, analysis: reflection.summary, reflection, annotatedText: judgment.context, comment: judgment.comment, preferenceUpdate: { updated: false, promoted: [] }, evolutionProposals: [] };
    if (!request.continue) return base;
    const sessionId = output.sessionId ?? null;
    const workDir = sessionId ? (await this.sessionManager.getSession(sessionId))?.folderPath : undefined;
    const continuationOutputId = makeId("out");
    const tracePath = await createRunTrace(workDir ?? this.projectRoot);
    const result = await this.options.modelClient.run(buildFollowupPrompt({ topic: output.topic, outputText: output.response, judgment: { ...judgment, label }, reflection }), {
      systemPrompt: await this.buildSystemPrompt({ workDir }), topic: output.topic, workDir, tracePath, sessionId, runId: base.runId, matchedSkills: [], requestKind: "continuation",
    });
    await appendTraceEvent(tracePath, "final_answer", { response: result.output });
    await this.memoryStore.recordOutput({ outputId: continuationOutputId, prompt: output.prompt, response: result.output, topic: output.topic, matchedSkills: [], toolCalls: result.toolCalls ?? [], sessionId });
    if (sessionId) await this.sessionManager.addMessage(sessionId, "agent", result.output, { outputId: continuationOutputId, toolCalls: result.toolCalls ?? [] });
    await saveRunSnapshot({ runId: base.runId, workDir: workDir ?? this.projectRoot, tracePath, sessionId: sessionId ?? undefined }).catch(async (error: unknown) => {
      await appendTraceEvent(tracePath, "snapshot_failed", { message: error instanceof Error ? error.message : String(error) });
    });
    return { ...base, nextOutputId: continuationOutputId, nextResponse: result.output, nextAnnotationRuntimeContext: "", nextOutputAssessment: accept, nextToolCalls: result.toolCalls ?? [], nextSkillReasons: [] };
  }

  async listApprovals(workDir: string) { return await (await this.approvalStore(workDir)).list(); }
  getSandboxEnabled(): boolean { return getSandboxFlag(); }
  async setSandboxEnabled(enabled: boolean): Promise<boolean> { return await persistSandboxFlag(enabled); }
  async decideApproval(workDir: string, id: string, decision: "approved" | "rejected", operator: string) {
    const store = await this.approvalStore(workDir);
    try {
      const approval = await store.decide(id, decision, operator);
      if (decision === "rejected") return { approval, event: null };
      // 幂等：审批已执行过（重复提交/刷新后重试）不再执行
      if (approval.status === "executed") return { approval, event: null, alreadyDecided: true };
      const completed = await store.complete(approval.id, await executeApprovedToolCall(approval.toolName, approval.args, approval.targetWorkspace));
      const event = createApprovalExecutionEvent(completed);
      if (event.sessionId && await this.sessionManager.getSession(event.sessionId)) {
        event.messageId = (await this.sessionManager.addMessage(event.sessionId, "agent", event.message, { eventType: "approval_execution", approvalId: event.approvalId, toolName: event.toolName, toolArgs: event.args, toolResult: event.result, runId: event.runId })).id;
      }
      return { approval: completed, event };
    } catch (error) {
      if (error instanceof ApprovalError) {
        // 已决冲突收敛为幂等返回（含并发锁拒绝），不再让前端“卡住”报错
        if (error.message.includes("already been decided") || error.message.includes("already being decided")) {
          const records = await store.list();
          const current = records.find((candidate) => candidate.id === id);
          if (current) return { approval: current, event: null, alreadyDecided: true };
        }
        throw new MomokaHttpError(409, error.message);
      }
      throw error;
    }
  }
  async createSession(goal: string, folderPath: string) {
    if (!goal.trim() || !folderPath.trim()) throw new MomokaHttpError(400, "Session goal and working directory are required");
    const details = await stat(folderPath).catch(() => null);
    if (!details?.isDirectory()) throw new MomokaHttpError(400, `Directory does not exist: ${folderPath}`);
    return await this.sessionManager.createSession(goal.trim(), path.resolve(folderPath));
  }
  async listDirectories(pathText?: string) {
    if (!pathText?.trim()) return { path: "", parent: null, entries: await listWindowsDrives() };
    const current = path.resolve(pathText); const details = await stat(current).catch(() => null);
    if (!details?.isDirectory()) throw new MomokaHttpError(400, `Path is not a directory: ${current}`);
    const { readdir } = await import("node:fs/promises");
    const entries = (await readdir(current, { withFileTypes: true })).filter((entry) => entry.isDirectory()).sort((a, b) => a.name.localeCompare(b.name)).map((entry) => ({ name: entry.name, path: path.join(current, entry.name), is_dir: true }));
    return { path: current, parent: path.dirname(current) === current ? null : path.dirname(current), entries };
  }
  private async approvalStore(workDir: string) { const workspace = path.resolve(workDir); if (!(await stat(workspace).catch(() => null))?.isDirectory()) throw new MomokaHttpError(400, `Directory does not exist: ${workspace}`); return new ApprovalStore(workspace); }
}

function formatHistory(messages: Array<{ role: string; content: string }>): string { return messages.map((message) => `[${message.role}]\n${message.content}`).join("\n\n"); }
async function listWindowsDrives() { const entries: Array<{ name: string; path: string; is_dir: true }> = []; for (const letter of "ABCDEFGHIJKLMNOPQRSTUVWXYZ") { const drive = `${letter}:\\`; try { await access(drive); entries.push({ name: drive.slice(0, -1), path: drive, is_dir: true }); } catch { /* absent */ } } return entries; }
export class MomokaHttpError extends Error { constructor(readonly statusCode: number, message: string, readonly details: Record<string, unknown> = {}) { super(message); } }
export function createMomokaAgent(options: MomokaAgentOptions): MomokaAgentCore { return new MomokaAgentCore(options); }
