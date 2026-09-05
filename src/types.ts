import type { IncomingMessage, ServerResponse } from "node:http";
import type { SessionManager } from "./session-manager.js";
import type { AgentRegistry } from "./agent-registry.js";

export type JsonObject = Record<string, unknown>;

export interface ToolCall {
  tool: string;
  args: string;
  result: string;
}

/** 单次模型调用的 token 统计（OpenAI 兼容 usage 字段） */
export interface ModelUsage {
  promptTokens?: number;
  completionTokens?: number;
  cachedTokens?: number;
  totalTokens?: number;
}

/** Agent 上下文占用指标（用于磁贴第二页展示） */
export interface ContextStats {
  /** 上下文长度（最近一次推理峰值 prompt tokens） */
  promptTokens: number;
  /** 上下文窗口（按模型标准，模型未知用通用默认） */
  contextWindow: number;
  /** 缓存命中 tokens；服务商未提供为 null */
  cachedTokens: number | null;
  updatedAt: string;
}

export interface ModelRunResult {
  output: string;
  toolCalls?: ToolCall[];
  /** 本轮 run 的代表性 usage（多轮工具调用取 prompt tokens 峰值轮） */
  usage?: ModelUsage;
}

export interface ModelClient {
  run(input: string, context: ModelRunContext): Promise<ModelRunResult>;
}

export type StreamEvent =
  | { type: "token"; text: string }
  | { type: "tool_start"; name: string; args: string }
  | { type: "tool_result"; name: string; result: string }
  | { type: "approval_requested"; name: string; args: string; result: string };

/** Agent 生命周期状态（agent-registry / agent-state） */
export type AgentState = "idle" | "running" | "waiting_approval" | "completed" | "error";

/** Agent 角色类别：缺省为普通执行者；dispatcher 为值日生（调度者，可自动记账/接收投递） */
export type AgentKind = "dispatcher" | "worker";

/** Agent running 时的子阶段（由 SSE 事件推导） */
export type AgentPhase = "planning" | "searching" | "reading" | "executing" | "verifying";

export interface AgentRecord {
  id: string; // agt_xxx
  name: string; // persona 名
  role: string; // 系统提示词 / 角色定位
  kind?: AgentKind; // 角色类别：dispatcher（值日生）| worker / 缺省
  model?: string; // 可选，缺省用全局 model client
  workspaceDir: string; // 工作目录
  sessionId: string; // 1:1 绑定的 session（上下文串）
  state: AgentState;
  phase?: AgentPhase; // running 时的子阶段
  /** 最近一次运行的耗时（ms），chat 结束时更新（输出区"运行时间"用） */
  lastRunDurationMs?: number;
  contextStats?: ContextStats; // 上下文占用指标（内存 + 落盘）
  createdAt: string;
  lastActiveAt: string;
}

export interface ModelRunContext {
  systemPrompt: string;
  topic: string;
  workDir?: string;
  tracePath?: string;
  sessionId?: string | null;
  runId?: string;
  matchedSkills: MatchedSkill[];
  requestKind: "chat" | "continuation" | "revision";
  /** 流式/进度事件回调（SSE 转发用） */
  onEvent?: (event: StreamEvent) => void;
  /** 外部取消信号（客户端断开/超时） */
  signal?: AbortSignal;
  /** 会话检索工具所需的会话管理器（引用资源句柄 &ses_ / &tile_） */
  sessionManager?: SessionManager;
  /** tile→session 解析所需的 Agent 注册表（&tile_<agentId> 别名） */
  agentRegistry?: AgentRegistry;
}

export type MomokaRequestKind = ModelRunContext["requestKind"];

export interface SkillMeta {
  name: string;
  description?: string;
  triggerKeywords: string[];
  utilityScore: number;
  version?: string;
  path: string;
}

export interface MatchedSkill {
  meta: SkillMeta;
  content: string;
  score: number;
  reasons: string[];
}

export interface OutputRecord {
  outputId: string;
  topic: string;
  prompt: string;
  response: string;
  matchedSkills: string[];
  toolCalls: ToolCall[];
  sessionId?: string | null;
  timestamp: string;
}

export interface JudgmentRecord {
  outputId: string;
  score: number;
  context: string;
  contextSource: "selected_text" | "full_output";
  quote: string;
  leftContext: string;
  rightContext: string;
  contextWindowChars: number;
  comment: string;
  commentSource: "user_comment" | "none";
  topic: string;
  matchedSkills: string[];
  timestamp: string;
}

export interface PreferenceUpdate {
  updated: boolean;
  promoted: JsonObject[];
}

export interface EvolutionProposal {
  id: string;
  key: string;
  type: "skill_rewrite" | "skill_promote";
  skill: string;
  status: "pending";
  createdAt: string;
  summary: string;
  targetFiles: string[];
  expectedDiff: string;
  applyGuardrails: string;
  evidence: JudgmentRecord[];
}

export interface Reflection {
  stance: "reject" | "weak_reject" | "ambivalent" | "weak_endorse" | "endorse";
  nextGuessStrategy: "pivot" | "adjust" | "diverge" | "refine" | "deepen";
  summary: string;
  intentHypothesis: string;
  nextGuessInstruction: string;
}

export interface AnnotationRuntimeBundle {
  topic: string;
  ledgerSize: number;
  relevantAnnotations: JudgmentRecord[];
  promotedPreferences: JsonObject[];
  rules: string[];
  conversationHistory: string;
}

export interface OutputAssessment {
  action: "accept" | "revise";
  reasons: string[];
  revisionPrompt: string;
}

export interface RuntimeEnvelope {
  bundle: AnnotationRuntimeBundle;
  conversationHistory: string;
  runtimeContext: string;
  runtimeInput: string;
}

export interface MomokaGraphState {
  runId: string;
  requestKind: "chat" | "judge";
  sessionId: string | null;
  outputId: string;
  topic: string;
  workDir?: string;
  tracePath?: string;
  userMessage: string;
  conversationHistory: string;
  matchedSkills: MatchedSkill[];
  runtimeBundle?: AnnotationRuntimeBundle;
  runtimeContext: string;
  runtimeInput: string;
  systemPrompt: string;
  draftOutput: string;
  toolCalls: ToolCall[];
  assessment?: OutputAssessment;
  judgment?: JudgmentRecord & { label?: string };
  reflection?: Reflection;
  preferenceUpdate?: PreferenceUpdate;
  evolutionProposals: EvolutionProposal[];
  continueRequested: boolean;
  continuationOutputId?: string;
  finalResponse: string;
}

export interface ChatRunInput {
  message: string;
  sessionId?: string | null;
  outputId?: string;
  topic?: string;
  workDir?: string;
}

export interface JudgeRunInput {
  outputId: string;
  score: number;
  context?: string;
  comment?: string;
  continue?: boolean;
}

export interface RunRecord {
  runId: string;
  kind: "chat" | "judge";
  sessionId: string | null;
  outputId: string;
  response: string;
  createdAt: string;
  state: RunStateSummary;
}

export interface RunStateSummary {
  requestKind: "chat" | "judge";
  assessmentAction?: OutputAssessment["action"];
  continueRequested: boolean;
  continuationOutputId?: string;
  toolEvents: Array<{
    name: string;
    argumentsLength: number;
    argumentsSha256: string;
    argumentsRedacted: boolean;
    resultLength: number;
    resultSha256: string;
    resultRedacted: boolean;
  }>;
}

export interface RunRecordInput extends Omit<RunRecord, "state"> {
  state: MomokaGraphState;
}

export interface ChatRunResult extends ChatResponse {
  state: MomokaGraphState;
}

export interface JudgeRunResult extends JudgeResponse {
  state: MomokaGraphState;
}

export interface MomokaRuntime {
  runChat(input: ChatRunInput): Promise<ChatRunResult>;
  runJudge(input: JudgeRunInput): Promise<JudgeRunResult>;
}

export interface ChatRequest {
  message: string;
  sessionId?: string | null;
  outputId?: string;
  topic?: string;
  workDir?: string;
  onEvent?: (event: StreamEvent) => void;
  signal?: AbortSignal;
}

export interface ChatResponse {
  runId: string;
  outputId: string;
  topic: string;
  response: string;
  annotationRuntimeContext: string;
  outputAssessment: OutputAssessment;
  toolCalls: ToolCall[];
  matchedSkills: string[];
  skillReasons: Array<{ name: string; score: number; reasons: string[] }>;
  sessionId?: string | null;
}

export interface JudgeRequest {
  outputId: string;
  score: number;
  context?: string;
  comment?: string;
  continue?: boolean;
}

export interface JudgeResponse {
  runId: string;
  outputId: string;
  score: number;
  label: string;
  analysis: string;
  reflection: Reflection;
  annotatedText: string;
  comment: string;
  preferenceUpdate: PreferenceUpdate;
  evolutionProposals: EvolutionProposal[];
  nextOutputId?: string;
  nextResponse?: string;
  nextAnnotationRuntimeContext?: string;
  nextOutputAssessment?: OutputAssessment;
  nextToolCalls?: ToolCall[];
  nextSkillReasons?: Array<{ name: string; score: number; reasons: string[] }>;
}

export interface MomokaAgent {
  memory: {
    recordOutput(record: Omit<OutputRecord, "timestamp"> & { timestamp?: string }): Promise<OutputRecord>;
    getOutput(outputId: string): Promise<OutputRecord | null>;
    recordJudgment(input: {
      outputId: string;
      score: number;
      context?: string;
      comment?: string;
    }): Promise<JudgmentRecord>;
  };
  chat(request: ChatRequest): Promise<ChatResponse>;
  judge(request: JudgeRequest): Promise<JudgeResponse>;
  listApprovals(workDir: string): Promise<unknown[]>;
  decideApproval(workDir: string, id: string, decision: "approved" | "rejected", operator: string): Promise<unknown>;
  buildSystemPrompt(input?: { userMessage?: string; topic?: string; matchedSkills?: MatchedSkill[]; workDir?: string }): Promise<string>;
  createSession(goal: string, folderPath: string): Promise<unknown>;
}

export type MomokaHttpHandler = (request: IncomingMessage, response: ServerResponse) => void;
