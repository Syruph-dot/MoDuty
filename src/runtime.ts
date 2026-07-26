import { Annotation, END, MemorySaver, START, StateGraph } from "@langchain/langgraph";

import { generateEvolutionProposals } from "./evolution.js";
import { analyzeJudgment, buildFollowupPrompt } from "./feedback.js";
import { appendTraceEvent, createRunTrace } from "./trace.js";
import type { MemoryStore } from "./memory.js";
import type { AnnotationRuntimeController } from "./runtime-context.js";
import type { SessionManager } from "./session-manager.js";
import type { SkillRouter } from "./skill-router.js";
import type {
  ChatRunInput,
  ChatRunResult,
  JudgeRunInput,
  JudgeRunResult,
  MatchedSkill,
  ModelClient,
  MomokaGraphState,
  MomokaRuntime,
  OutputAssessment,
  RunRecord,
  ToolCall,
} from "./types.js";
import type { RunStore } from "./run-store.js";

const MomokaState = Annotation.Root({
  runId: Annotation<string>,
  requestKind: Annotation<"chat" | "judge">,
  sessionId: Annotation<string | null>,
  outputId: Annotation<string>,
  topic: Annotation<string>,
  workDir: Annotation<string | undefined>,
  tracePath: Annotation<string | undefined>,
  userMessage: Annotation<string>,
  conversationHistory: Annotation<string>,
  matchedSkills: Annotation<MatchedSkill[]>,
  runtimeBundle: Annotation<MomokaGraphState["runtimeBundle"]>,
  runtimeContext: Annotation<string>,
  runtimeInput: Annotation<string>,
  systemPrompt: Annotation<string>,
  draftOutput: Annotation<string>,
  toolCalls: Annotation<ToolCall[]>,
  assessment: Annotation<OutputAssessment | undefined>,
  judgment: Annotation<MomokaGraphState["judgment"]>,
  reflection: Annotation<MomokaGraphState["reflection"]>,
  preferenceUpdate: Annotation<MomokaGraphState["preferenceUpdate"]>,
  evolutionProposals: Annotation<MomokaGraphState["evolutionProposals"]>,
  continueRequested: Annotation<boolean>,
  continuationOutputId: Annotation<string | undefined>,
  finalResponse: Annotation<string>,
});

interface LangGraphMomokaRuntimeOptions {
  modelClient: ModelClient;
  memoryStore: MemoryStore;
  skillRouter: SkillRouter;
  sessionManager: SessionManager;
  runtimeController: AnnotationRuntimeController;
  runStore: RunStore;
  projectRoot: string;
  buildSystemPrompt(input: {
    userMessage?: string;
    topic?: string;
    matchedSkills?: MatchedSkill[];
    workDir?: string;
  }): Promise<string>;
}

function nowIso(): string {
  return new Date().toISOString();
}

function makeId(prefix: string): string {
  return `${prefix}_${crypto.randomUUID().replace(/-/g, "").slice(0, 12)}`;
}

export class LangGraphMomokaRuntime implements MomokaRuntime {
  private readonly chatGraph;
  private readonly judgeGraph;

  constructor(private readonly options: LangGraphMomokaRuntimeOptions) {
    const checkpointer = new MemorySaver();
    this.chatGraph = new StateGraph(MomokaState)
      .addNode("loadSessionContext", this.loadChatSessionContext)
      .addNode("matchSkills", this.matchChatSkills)
      .addNode("buildRuntimeBundle", this.buildChatRuntimeBundle)
      .addNode("generateDraft", this.generateDraft)
      .addNode("runToolsLoop", this.runToolsLoop)
      .addNode("assessOutput", this.assessOutput)
      .addNode("reviseIfNeeded", this.reviseIfNeeded)
      .addNode("persistOutput", this.persistChatOutput)
      .addNode("returnResponse", async (state: typeof MomokaState.State) => ({ finalResponse: state.finalResponse || state.draftOutput }))
      .addEdge(START, "loadSessionContext")
      .addEdge("loadSessionContext", "matchSkills")
      .addEdge("matchSkills", "buildRuntimeBundle")
      .addEdge("buildRuntimeBundle", "generateDraft")
      .addEdge("generateDraft", "runToolsLoop")
      .addEdge("runToolsLoop", "assessOutput")
      .addEdge("assessOutput", "reviseIfNeeded")
      .addEdge("reviseIfNeeded", "persistOutput")
      .addEdge("persistOutput", "returnResponse")
      .addEdge("returnResponse", END)
      .compile({ checkpointer });

    this.judgeGraph = new StateGraph(MomokaState)
      .addNode("loadOutput", this.loadJudgeOutput)
      .addNode("recordJudgment", this.recordJudgment)
      .addNode("reflectJudgment", this.reflectJudgment)
      .addNode("updatePreferences", this.updatePreferences)
      .addNode("generateEvolutionProposals", this.generateEvolutionProposalsNode)
      .addNode("continueIfRequested", this.continueIfRequested)
      .addNode("persistContinuation", this.persistJudgeRun)
      .addNode("returnJudgmentResponse", async (state: typeof MomokaState.State) => ({ finalResponse: state.finalResponse || state.draftOutput }))
      .addEdge(START, "loadOutput")
      .addEdge("loadOutput", "recordJudgment")
      .addEdge("recordJudgment", "reflectJudgment")
      .addEdge("reflectJudgment", "updatePreferences")
      .addEdge("updatePreferences", "generateEvolutionProposals")
      .addEdge("generateEvolutionProposals", "continueIfRequested")
      .addEdge("continueIfRequested", "persistContinuation")
      .addEdge("persistContinuation", "returnJudgmentResponse")
      .addEdge("returnJudgmentResponse", END)
      .compile({ checkpointer });
  }

  async runChat(input: ChatRunInput): Promise<ChatRunResult> {
    const message = input.message.trim();
    if (!message) {
      throw new Error("Message cannot be empty");
    }
    const initialState: typeof MomokaState.State = {
      runId: makeId("run"),
      requestKind: "chat",
      sessionId: input.sessionId ?? null,
      outputId: input.outputId?.trim() || makeId("out"),
      topic: input.topic?.trim() || message.slice(0, 80),
      workDir: input.workDir,
      tracePath: undefined,
      userMessage: message,
      conversationHistory: "",
      matchedSkills: [],
      runtimeBundle: undefined,
      runtimeContext: "",
      runtimeInput: "",
      systemPrompt: "",
      draftOutput: "",
      toolCalls: [],
      assessment: undefined,
      judgment: undefined,
      reflection: undefined,
      preferenceUpdate: undefined,
      evolutionProposals: [],
      continueRequested: false,
      continuationOutputId: undefined,
      finalResponse: "",
    };

    const state = await this.chatGraph.invoke(initialState, {
      configurable: { thread_id: initialState.runId },
    });
    return {
      runId: state.runId,
      outputId: state.outputId,
      topic: state.topic,
      response: state.finalResponse,
      annotationRuntimeContext: state.runtimeContext,
      outputAssessment: state.assessment ?? { action: "accept", reasons: [], revisionPrompt: "" },
      toolCalls: state.toolCalls,
      matchedSkills: state.matchedSkills.map((skill) => skill.meta.name),
      skillReasons: state.matchedSkills.map((skill) => ({
        name: skill.meta.name,
        score: Math.round(skill.score * 1000) / 1000,
        reasons: skill.reasons,
      })),
      sessionId: state.sessionId,
      state,
    };
  }

  async runJudge(input: JudgeRunInput): Promise<JudgeRunResult> {
    const initialState: typeof MomokaState.State = {
      runId: makeId("run"),
      requestKind: "judge",
      sessionId: null,
      outputId: input.outputId,
      topic: "",
      workDir: undefined,
      tracePath: undefined,
      userMessage: "",
      conversationHistory: "",
      matchedSkills: [],
      runtimeBundle: undefined,
      runtimeContext: "",
      runtimeInput: "",
      systemPrompt: "",
      draftOutput: "",
      toolCalls: [],
      assessment: undefined,
      judgment: {
        outputId: input.outputId,
        score: input.score,
        context: input.context ?? "",
        contextSource: "full_output",
        quote: "",
        leftContext: "",
        rightContext: "",
        contextWindowChars: 20,
        comment: input.comment ?? "",
        commentSource: input.comment ? "user_comment" : "none",
        topic: "",
        matchedSkills: [],
        timestamp: nowIso(),
      },
      reflection: undefined,
      preferenceUpdate: undefined,
      evolutionProposals: [],
      continueRequested: Boolean(input.continue),
      continuationOutputId: undefined,
      finalResponse: "",
    };

    const state = await this.judgeGraph.invoke(initialState, {
      configurable: { thread_id: initialState.runId },
    });
    return {
      runId: state.runId,
      outputId: state.outputId,
      score: state.judgment?.score ?? input.score,
      label: state.judgment?.label ?? "",
      analysis: state.reflection?.summary ?? "",
      reflection: state.reflection!,
      annotatedText: state.judgment?.context ?? "",
      comment: state.judgment?.comment ?? "",
      preferenceUpdate: state.preferenceUpdate ?? { updated: false, promoted: [] },
      evolutionProposals: state.evolutionProposals,
      nextOutputId: state.continuationOutputId,
      nextResponse: state.finalResponse || undefined,
      nextAnnotationRuntimeContext: state.runtimeContext || undefined,
      nextOutputAssessment: state.assessment,
      nextToolCalls: state.toolCalls.length > 0 ? state.toolCalls : undefined,
      nextSkillReasons: state.matchedSkills.length > 0
        ? state.matchedSkills.map((skill) => ({
          name: skill.meta.name,
          score: Math.round(skill.score * 1000) / 1000,
          reasons: skill.reasons,
        }))
        : undefined,
      state,
    };
  }

  async getRun(runId: string): Promise<RunRecord | null> {
    return await this.options.runStore.getRun(runId);
  }

  private loadChatSessionContext = async (state: typeof MomokaState.State) => {
    let workDir = state.workDir;
    let conversationHistory = "";
    if (state.sessionId) {
      const session = await this.options.sessionManager.getSession(state.sessionId);
      if (!session) {
        throw new Error(`Unknown session: ${state.sessionId}`);
      }
      workDir = session.folderPath || workDir;
      await this.options.sessionManager.addMessage(state.sessionId, "user", state.userMessage);
      const messages = await this.options.sessionManager.getMessages(state.sessionId, null);
      conversationHistory = this.serializeConversationHistory(messages.slice(0, -1));
    }
    const tracePath = await createRunTrace(workDir ?? this.options.projectRoot);
    return { workDir, conversationHistory, tracePath };
  };

  private matchChatSkills = async (state: typeof MomokaState.State) => {
    const feedbackBoosts = await this.options.memoryStore.getSkillFeedbackBoosts();
    const matchedSkills = await this.options.skillRouter.matchSkills(state.userMessage, {
      topic: state.topic,
      feedbackBoosts,
    });
    const systemPrompt = await this.options.buildSystemPrompt({
      userMessage: state.userMessage,
      topic: state.topic,
      matchedSkills,
      workDir: state.workDir,
    });
    return { matchedSkills, systemPrompt };
  };

  private buildChatRuntimeBundle = async (state: typeof MomokaState.State) => {
    const envelope = await this.options.runtimeController.buildRuntimeEnvelope({
      userMessage: state.userMessage,
      topic: state.topic,
      requestHeading: "Current User Request",
      conversationHistory: state.conversationHistory,
    });
    return {
      runtimeBundle: envelope.bundle,
      runtimeContext: envelope.runtimeContext,
      runtimeInput: envelope.runtimeInput,
    };
  };

  private generateDraft = async (_state: typeof MomokaState.State) => ({});

  private runToolsLoop = async (state: typeof MomokaState.State) => {
    const result = await this.options.modelClient.run(state.runtimeInput, {
      systemPrompt: state.systemPrompt,
      topic: state.topic,
      workDir: state.workDir,
      tracePath: state.tracePath,
      sessionId: state.sessionId,
      runId: state.runId,
      matchedSkills: state.matchedSkills,
      requestKind: "chat",
    });
    return {
      draftOutput: result.output,
      toolCalls: result.toolCalls ?? [],
    };
  };

  private assessOutput = async (state: typeof MomokaState.State) => {
    const assessment = this.options.runtimeController.assessOutput(
      state.runtimeBundle!,
      state.draftOutput,
    );
    return { assessment };
  };

  private reviseIfNeeded = async (state: typeof MomokaState.State) => {
    let draftOutput = state.draftOutput;
    let toolCalls = state.toolCalls;
    let assessment = state.assessment!;
    if (assessment.action === "revise") {
      const revisionInput = this.options.runtimeController.buildRevisionInput({
        runtimeContext: state.runtimeContext,
        requestHeading: "Current User Request",
        requestText: state.userMessage,
        assessment,
      });
      const revised = await this.options.modelClient.run(revisionInput, {
        systemPrompt: state.systemPrompt,
        topic: state.topic,
        workDir: state.workDir,
        tracePath: state.tracePath,
        sessionId: state.sessionId,
        runId: state.runId,
        matchedSkills: state.matchedSkills,
        requestKind: "revision",
      });
      draftOutput = revised.output;
      toolCalls = revised.toolCalls ?? [];
      const reassessed = this.options.runtimeController.assessOutput(state.runtimeBundle!, draftOutput);
      assessment = reassessed.action === "accept"
        ? {
          action: "revise",
          reasons: state.runtimeBundle!.relevantAnnotations
            .filter((annotation) => annotation.score <= 2 && annotation.context)
            .map((annotation) => `hit low-score annotation guardrail: ${annotation.context}`)
            .slice(0, 1),
          revisionPrompt: "",
        }
        : reassessed;
    }
    return {
      draftOutput,
      toolCalls,
      assessment,
      finalResponse: draftOutput,
    };
  };

  private persistChatOutput = async (state: typeof MomokaState.State) => {
    const matchedNames = state.matchedSkills.map((skill) => skill.meta.name);
    await appendTraceEvent(state.tracePath, "final_answer", { response: state.finalResponse });
    await this.options.memoryStore.writeDaily(`**User**: ${state.userMessage}\n**Agent**: ${state.finalResponse.slice(0, 300)}`);
    await this.options.memoryStore.recordOutput({
      outputId: state.outputId,
      prompt: state.userMessage,
      response: state.finalResponse,
      topic: state.topic,
      matchedSkills: matchedNames,
      toolCalls: state.toolCalls,
      sessionId: state.sessionId,
    });
    if (state.sessionId) {
      await this.options.sessionManager.addMessage(state.sessionId, "agent", state.finalResponse, {
        outputId: state.outputId,
        matchedSkills: matchedNames,
        toolCalls: state.toolCalls,
      });
    }
    await this.options.runStore.recordRun({
      runId: state.runId,
      kind: "chat",
      sessionId: state.sessionId,
      outputId: state.outputId,
      response: state.finalResponse,
      createdAt: nowIso(),
      state,
    });
    return {};
  };

  private loadJudgeOutput = async (state: typeof MomokaState.State) => {
    const output = await this.options.memoryStore.getOutput(state.outputId);
    if (!output) {
      throw new Error(`Unknown output_id: ${state.outputId}`);
    }
    const conversationHistory = output.sessionId
      ? this.serializeConversationHistory(await this.options.sessionManager.getMessages(output.sessionId, null))
      : "";
    const workDir = output.sessionId
      ? (await this.options.sessionManager.getSession(output.sessionId))?.folderPath
      : undefined;
    const tracePath = state.continueRequested
      ? await createRunTrace(workDir ?? this.options.projectRoot)
      : undefined;
    return {
      sessionId: output.sessionId ?? null,
      topic: output.topic,
      workDir,
      tracePath,
      conversationHistory,
      userMessage: output.prompt,
    };
  };

  private recordJudgment = async (state: typeof MomokaState.State) => {
    const judgment = await this.options.memoryStore.recordJudgment({
      outputId: state.outputId,
      score: state.judgment?.score ?? 0,
      context: state.judgment?.context ?? "",
      comment: state.judgment?.comment ?? "",
    });
    return { judgment };
  };

  private reflectJudgment = async (state: typeof MomokaState.State) => {
    const labelMap = {
      1: "强烈反对",
      2: "反对",
      3: "不太赞同",
      4: "中立",
      5: "有点赞同",
      6: "赞同",
      7: "强烈赞同",
    } as Record<number, string>;
    const label = labelMap[state.judgment?.score ?? 0] ?? "unknown";
    const reflection = analyzeJudgment({
      score: state.judgment?.score ?? 0,
      label,
      annotatedText: state.judgment?.context ?? "",
      topic: state.judgment?.topic,
      userComment: state.judgment?.comment,
    });
    return {
      judgment: state.judgment ? { ...state.judgment, label } : state.judgment,
      reflection,
    };
  };

  private updatePreferences = async (state: typeof MomokaState.State) => {
    const preferenceUpdate = await this.options.memoryStore.updatePreferences(state.judgment!, {
      intentHypothesis: state.reflection?.intentHypothesis,
    });
    return { preferenceUpdate };
  };

  private generateEvolutionProposalsNode = async (state: typeof MomokaState.State) => {
    const evolutionProposals = await generateEvolutionProposals(this.options.skillRouter, this.options.memoryStore, state.judgment!);
    return { evolutionProposals };
  };

  private continueIfRequested = async (state: typeof MomokaState.State) => {
    await this.options.memoryStore.writeDaily([
      `**Score**: ${state.judgment?.score ?? 0}/7 (${state.judgment?.label ?? "unknown"})`,
      `**Analysis**: ${state.reflection?.summary ?? ""}`,
      `**Strategy**: ${state.reflection?.nextGuessStrategy ?? ""}`,
      `**Context**: ${(state.judgment?.context ?? "").slice(0, 200)}`,
      `**Comment**: ${(state.judgment?.comment ?? "").slice(0, 200) || "none"}`,
    ].join("\n"));

    if (!state.continueRequested) {
      return { finalResponse: "" };
    }
    const output = await this.options.memoryStore.getOutput(state.outputId);
    if (!output) {
      throw new Error(`Unknown output_id: ${state.outputId}`);
    }
    const followupPrompt = buildFollowupPrompt({
      topic: state.topic || output.topic,
      outputText: output.response,
      judgment: state.judgment!,
      reflection: state.reflection!,
    });
    const feedbackBoosts = await this.options.memoryStore.getSkillFeedbackBoosts();
    const matchedSkills = await this.options.skillRouter.matchSkills(followupPrompt, {
      topic: state.topic || output.topic,
      feedbackBoosts,
    });
    const systemPrompt = await this.options.buildSystemPrompt({
      userMessage: followupPrompt,
      topic: state.topic || output.topic,
      matchedSkills,
      workDir: state.workDir,
    });
    const envelope = await this.options.runtimeController.buildRuntimeEnvelope({
      userMessage: followupPrompt,
      topic: state.topic || output.topic,
      requestHeading: "Continuation Request",
      conversationHistory: state.conversationHistory,
    });
    let result = await this.options.modelClient.run(envelope.runtimeInput, {
      systemPrompt,
      topic: state.topic || output.topic,
      workDir: state.workDir,
      tracePath: state.tracePath,
      sessionId: state.sessionId,
      runId: state.runId,
      matchedSkills,
      requestKind: "continuation",
    });
    let assessment = this.options.runtimeController.assessOutput(envelope.bundle, result.output);
    if (assessment.action === "revise") {
      const revisionInput = this.options.runtimeController.buildRevisionInput({
        runtimeContext: envelope.runtimeContext,
        requestHeading: "Continuation Request",
        requestText: followupPrompt,
        assessment,
      });
      result = await this.options.modelClient.run(revisionInput, {
        systemPrompt,
        topic: state.topic || output.topic,
        workDir: state.workDir,
        tracePath: state.tracePath,
        sessionId: state.sessionId,
        runId: state.runId,
        matchedSkills,
        requestKind: "revision",
      });
      const reassessed = this.options.runtimeController.assessOutput(envelope.bundle, result.output);
      assessment = reassessed.action === "accept" ? assessment : reassessed;
    }
    const continuationOutputId = makeId("out");
    await this.options.memoryStore.recordOutput({
      outputId: continuationOutputId,
      prompt: followupPrompt,
      response: result.output,
      topic: state.topic || output.topic,
      matchedSkills: matchedSkills.map((skill) => skill.meta.name),
      toolCalls: result.toolCalls ?? [],
      sessionId: state.sessionId,
    });
    await this.options.memoryStore.writeDaily(`**Continuation**: ${result.output.slice(0, 300)}`);
    return {
      userMessage: followupPrompt,
      matchedSkills,
      systemPrompt,
      runtimeBundle: envelope.bundle,
      runtimeContext: envelope.runtimeContext,
      runtimeInput: envelope.runtimeInput,
      draftOutput: result.output,
      toolCalls: result.toolCalls ?? [],
      assessment,
      continuationOutputId,
      finalResponse: result.output,
    };
  };

  private persistJudgeRun = async (state: typeof MomokaState.State) => {
    if (state.continueRequested) {
      await appendTraceEvent(state.tracePath, "final_answer", { response: state.finalResponse });
    }
    await this.options.runStore.recordRun({
      runId: state.runId,
      kind: "judge",
      sessionId: state.sessionId,
      outputId: state.outputId,
      response: state.finalResponse,
      createdAt: nowIso(),
      state,
    });
    return {};
  };

  private serializeConversationHistory(messages: Array<{ id: string; role: string; content: string; output_id?: unknown; outputId?: unknown }>): string {
    if (messages.length === 0) {
      return "";
    }
    const lines = ["## Conversation History", ""];
    for (const message of messages) {
      lines.push(`<turn id="${this.historyTurnId(message)}" role="${message.role}">`);
      lines.push(message.content);
      lines.push("</turn>");
      lines.push("");
    }
    return lines.join("\n").trimEnd();
  }

  private historyTurnId(message: { id: string; role: string; output_id?: unknown; outputId?: unknown }): string {
    if (message.role === "agent") {
      const outputId = typeof message.output_id === "string"
        ? message.output_id
        : typeof message.outputId === "string"
          ? message.outputId
          : "";
      if (outputId) {
        return outputId;
      }
    }
    return message.id;
  }
}
