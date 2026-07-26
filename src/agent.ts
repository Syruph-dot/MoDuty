import { access, readFile, stat } from "node:fs/promises";
import path from "node:path";

import { assessmentToSnake, evolutionProposalToSnake, reflectionToSnake } from "./casing.js";
import { LIKERT_LABELS, defaultPaths, resolveProjectRoot } from "./config.js";
import { MemoryStore } from "./memory.js";
import { RunStore } from "./run-store.js";
import { LangGraphMomokaRuntime } from "./runtime.js";
import { AnnotationRuntimeController } from "./runtime-context.js";
import { SessionManager } from "./session-manager.js";
import { ApprovalError, ApprovalStore, createApprovalExecutionEvent } from "./approvals.js";
import { executeApprovedToolCall } from "./tools.js";
import { formatSkillPrompt, SkillRouter } from "./skill-router.js";
import type {
  ChatRequest,
  ChatResponse,
  JudgeRequest,
  JudgeResponse,
  MatchedSkill,
  ModelClient,
  MomokaAgent,
} from "./types.js";

interface MomokaAgentOptions {
  projectRoot?: string;
  modelClient: ModelClient;
}

export class MomokaAgentCore implements MomokaAgent {
  readonly projectRoot: string;
  readonly memoryStore: MemoryStore;
  readonly skillRouter: SkillRouter;
  readonly sessionManager: SessionManager;
  readonly runtimeController: AnnotationRuntimeController;
  readonly runStore: RunStore;
  readonly runtime: LangGraphMomokaRuntime;

  constructor(private readonly options: MomokaAgentOptions) {
    this.projectRoot = resolveProjectRoot(options.projectRoot);
    const paths = defaultPaths(this.projectRoot);
    this.memoryStore = new MemoryStore(paths.memoryDir);
    this.skillRouter = new SkillRouter(paths.skillsDir);
    this.sessionManager = new SessionManager(paths.memoryDir);
    this.runtimeController = new AnnotationRuntimeController(this.memoryStore);
    this.runStore = new RunStore(paths.memoryDir);
    this.runtime = new LangGraphMomokaRuntime({
      modelClient: options.modelClient,
      memoryStore: this.memoryStore,
      skillRouter: this.skillRouter,
      sessionManager: this.sessionManager,
      runtimeController: this.runtimeController,
      runStore: this.runStore,
      projectRoot: this.projectRoot,
      buildSystemPrompt: this.buildSystemPrompt.bind(this),
    });
  }

  get memory() {
    return {
      recordOutput: this.memoryStore.recordOutput.bind(this.memoryStore),
      getOutput: this.memoryStore.getOutput.bind(this.memoryStore),
      recordJudgment: this.memoryStore.recordJudgment.bind(this.memoryStore),
    };
  }

  async buildSystemPrompt(input: {
    userMessage?: string;
    topic?: string;
    matchedSkills?: MatchedSkill[];
    workDir?: string;
  } = {}): Promise<string> {
    const parts: string[] = [];
    const agentsPath = path.join(this.projectRoot, "prompts", "AGENTS.md");
    try {
      parts.push(await readFile(agentsPath, "utf8"));
    } catch {
      parts.push("You are MOMOKA, a document assistant agent.");
    }

    if (input.workDir) {
      parts.push([
        "\n## Current Work Directory",
        `You are constrained to operate inside: ${input.workDir}`,
        "Use paths relative to this directory for file operations. Do not use absolute paths.",
        "",
      ].join("\n"));
    }

    if (input.userMessage) {
      const matched = input.matchedSkills ?? await this.skillRouter.matchSkills(input.userMessage, {
        topic: input.topic,
        feedbackBoosts: await this.memoryStore.getSkillFeedbackBoosts(),
      });
      if (matched.length > 0) {
        parts.push(formatSkillPrompt(matched));
      }
    }

    const memoryContext = await this.memoryStore.getInjectableContext();
    if (memoryContext.trim()) {
      parts.push(`\n## Recent Memory\n${memoryContext}`);
    }

    return parts.join("\n");
  }

  async chat(request: ChatRequest): Promise<ChatResponse> {
    const message = request.message.trim();
    if (!message) {
      throw new MomokaHttpError(400, "Message cannot be empty");
    }
    try {
      const result = await this.runtime.runChat(request);
      return {
        runId: result.runId,
        outputId: result.outputId,
        topic: result.topic,
        response: result.response,
        annotationRuntimeContext: result.annotationRuntimeContext,
        outputAssessment: result.outputAssessment,
        toolCalls: result.toolCalls,
        matchedSkills: result.matchedSkills,
        skillReasons: result.skillReasons,
        sessionId: result.sessionId,
      };
    } catch (error) {
      this.rethrowRuntimeError(error);
    }
  }

  async judge(request: JudgeRequest): Promise<JudgeResponse> {
    if (!Number.isInteger(request.score) || request.score < 1 || request.score > 7) {
      throw new MomokaHttpError(400, "Score must be an integer from 1 to 7", {
        valid_range: Object.fromEntries(Object.entries(LIKERT_LABELS).map(([key, value]) => [String(key), value])),
      });
    }
    try {
      const result = await this.runtime.runJudge(request);
      return {
        runId: result.runId,
        outputId: result.outputId,
        score: result.score,
        label: result.label,
        analysis: result.analysis,
        reflection: result.reflection,
        annotatedText: result.annotatedText,
        comment: result.comment,
        preferenceUpdate: result.preferenceUpdate,
        evolutionProposals: result.evolutionProposals,
        nextOutputId: result.nextOutputId,
        nextResponse: result.nextResponse,
        nextAnnotationRuntimeContext: result.nextAnnotationRuntimeContext,
        nextOutputAssessment: result.nextOutputAssessment,
        nextToolCalls: result.nextToolCalls,
        nextSkillReasons: result.nextSkillReasons,
      };
    } catch (error) {
      this.rethrowRuntimeError(error);
    }
  }

  async getRun(runId: string) {
    return await this.runStore.getRun(runId);
  }

  async listApprovals(workDir: string) {
    return await (await this.approvalStore(workDir)).list();
  }

  async decideApproval(workDir: string, id: string, decision: "approved" | "rejected", operator: string) {
    try {
      const store = await this.approvalStore(workDir);
      const approval = await store.decide(id, decision, operator);
      if (decision === "rejected") return { approval, event: null };
      const result = await executeApprovedToolCall(approval.toolName, approval.args, approval.targetWorkspace);
      const completed = await store.complete(approval.id, result);
      const event = createApprovalExecutionEvent(completed);
      if (event.sessionId && await this.sessionManager.getSession(event.sessionId)) {
        const message = await this.sessionManager.addMessage(event.sessionId, "agent", event.message, {
          eventType: "approval_execution",
          approvalId: event.approvalId,
          toolName: event.toolName,
          toolArgs: event.args,
          toolResult: event.result,
          runId: event.runId,
        });
        event.messageId = message.id;
      }
      return { approval: completed, event };
    } catch (error) {
      if (error instanceof ApprovalError) throw new MomokaHttpError(409, error.message);
      throw error;
    }
  }

  async createSession(goal: string, folderPath: string) {
    if (!goal.trim()) {
      throw new MomokaHttpError(400, "Session goal cannot be empty");
    }
    if (!folderPath.trim()) {
      throw new MomokaHttpError(400, "Working directory cannot be empty");
    }
    try {
      const stats = await stat(folderPath);
      if (!stats.isDirectory()) {
        throw new MomokaHttpError(400, `Path is not a directory: ${folderPath}`);
      }
    } catch (error) {
      if (error instanceof MomokaHttpError) {
        throw error;
      }
      throw new MomokaHttpError(400, `Directory does not exist: ${folderPath}`);
    }
    return await this.sessionManager.createSession(goal.trim(), path.resolve(folderPath));
  }

  async listDirectories(pathText?: string) {
    if (!pathText?.trim()) {
      if (process.platform === "win32") {
        return { path: "", parent: null, entries: await listWindowsDrives() };
      }
      return { path: "", parent: null, entries: [{ name: "/", path: "/", is_dir: true }] };
    }
    const current = path.resolve(pathText);
    const stats = await stat(current);
    if (!stats.isDirectory()) {
      throw new MomokaHttpError(400, `Path is not a directory: ${current}`);
    }
    const { readdir } = await import("node:fs/promises");
    const children = await readdir(current, { withFileTypes: true });
    const entries = children
      .filter((child) => child.isDirectory())
      .sort((a, b) => a.name.localeCompare(b.name))
      .map((child) => ({
        name: child.name,
        path: path.join(current, child.name),
        is_dir: true,
      }));
    const parent = path.dirname(current) === current ? null : path.dirname(current);
    return { path: current, parent, entries };
  }

  private async approvalStore(workDir: string): Promise<ApprovalStore> {
    if (!workDir.trim()) throw new MomokaHttpError(400, "Working directory cannot be empty");
    const workspace = path.resolve(workDir);
    const details = await stat(workspace).catch(() => null);
    if (!details?.isDirectory()) throw new MomokaHttpError(400, `Directory does not exist: ${workspace}`);
    return new ApprovalStore(workspace);
  }

  private rethrowRuntimeError(error: unknown): never {
    if (error instanceof MomokaHttpError) {
      throw error;
    }
    if (error instanceof Error) {
      if (error.message.startsWith("Unknown session: ")) {
        throw new MomokaHttpError(404, error.message);
      }
      if (error.message.startsWith("Unknown output_id: ")) {
        throw new MomokaHttpError(404, error.message);
      }
      if (error.message === "Message cannot be empty") {
        throw new MomokaHttpError(400, error.message);
      }
      throw error;
    }
    throw new Error(String(error));
  }
}

export class MomokaHttpError extends Error {
  constructor(readonly statusCode: number, message: string, readonly details: Record<string, unknown> = {}) {
    super(message);
  }
}

export function createMomokaAgent(options: MomokaAgentOptions): MomokaAgentCore {
  return new MomokaAgentCore(options);
}

async function listWindowsDrives() {
  const entries: Array<{ name: string; path: string; is_dir: true }> = [];
  for (const letter of "ABCDEFGHIJKLMNOPQRSTUVWXYZ") {
    const drive = `${letter}:\\`;
    try {
      await access(drive);
      entries.push({ name: drive.replace("\\", ""), path: drive, is_dir: true });
    } catch {
      // Drive does not exist or is inaccessible.
    }
  }
  return entries;
}

export const httpSerializers = {
  reflectionToSnake,
  assessmentToSnake,
  evolutionProposalToSnake,
};
