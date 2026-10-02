import type { IncomingMessage, ServerResponse } from "node:http";
import type { SessionManager } from "./session-manager.js";
import type { AgentRegistry } from "./agent-registry.js";
import type { AttachmentRef } from "./attachments.js";

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
  /** 本轮实际使用的模型名（写入消息，供消息头展示） */
  model?: string;
}

export interface ModelClient {
  run(input: string, context: ModelRunContext): Promise<ModelRunResult>;
}

export type StreamEvent =
  | { type: "token"; text: string }
  | { type: "reasoning"; text: string }
  | { type: "tool_start"; name: string; args: string }
  | { type: "tool_result"; name: string; result: string }
  | { type: "policy_notice"; text: string }
  | { type: "experience_recall"; text: string }
  | { type: "approval_requested"; name: string; args: string; result: string }
  | { type: "question_requested"; name: string; args: string; result: string };

/** Agent 生命周期状态（agent-registry / agent-state） */
export type AgentState = "idle" | "running" | "waiting_approval" | "requiring_input" | "completed" | "error";

/** Agent 角色类别：缺省为普通执行者；dispatcher 为值日生（调度者，可自动记账/接收投递） */
export type AgentKind = "dispatcher" | "worker";

/** Agent running 时的子阶段（由 SSE 事件推导） */
export type AgentPhase = "planning" | "searching" | "reading" | "executing" | "verifying";

export interface AgentRecord {
  id: string; // agt_xxx
  name: string; // persona 名
  /** 名字仍为“自动生成”占位（创建时未填写）：首条对话生成标题后回填，用户重命名后清除 */
  autoName?: boolean;
  role: string; // 系统提示词 / 角色定位
  kind?: AgentKind; // 角色类别：dispatcher（值日生）| worker / 缺省
  /** 角色扮演人格 slug：对应 prompts/roleplay/<slug>.md；缺省时不注入该层，配置后文件必须存在 */
  roleplay?: string | null;
  /** 能力标签（P9）：DAG 编排按它做能力匹配选执行者 */
  capabilities?: string[];
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
  /** 是否已归档（归档后不在主列表显示，但数据保留） */
  archived?: boolean;
  archivedAt?: string;
}

export interface ModelRunContext {
  systemPrompt: string;
  topic: string;
  /** Resolved session model; when present, use its enabled model-pool entry. */
  model?: string;
  workDir?: string;
  tracePath?: string;
  sessionId?: string | null;
  runId?: string;
  matchedSkills: MatchedSkill[];
  requestKind: "chat" | "continuation" | "revision";
  /**
   * 本轮允许模型调用的工具表（TOOL_SPECS 的子集）。
   * 缺省 = 全量 TOOL_SPECS；受限角色（值日生 dispatcher）传 toolSpecsForKind 裁剪后的白名单，
   * 让「提示词只允许 run_momoka_cli」的约束落到工具层——模型看不到的工具就调不了。
   */
  tools?: readonly unknown[];
  /** Tool names rejected at execution time by an explicit per-request user boundary. */
  blockedToolNames?: readonly string[];
  /** 流式/进度事件回调（SSE 转发用） */
  onEvent?: (event: StreamEvent) => void;
  /** 外部取消信号（客户端断开/超时） */
  signal?: AbortSignal;
  /** 单次调用输出 token 上限；缺省使用 MOMOKA_MAX_TOKENS/全局默认值。 */
  outputTokenLimit?: number;
  /** 会话检索工具所需的会话管理器（引用资源句柄 &ses_ / &tile_） */
  sessionManager?: SessionManager;
  /** tile→session 解析所需的 Agent 注册表（&tile_<agentId> 别名） */
  agentRegistry?: AgentRegistry;
  /**
   * 会话历史（角色分离的消息数组）。
   *
   * 为什么不是拼成一段文本：历史作为独立消息顺序追加，前缀才能逐字节稳定，
   * 上游 provider 的前缀缓存才可以命中。拼成文本后每轮都会重算整块，前缀随时漂移。
   */
  historyMessages?: Array<{ role: "system" | "user" | "assistant"; content: MessageContent }>;
  /** 当前模型是否支持图片输入（决定图片内容块直发还是降级为文字占位） */
  supportsVision?: boolean;
  /**
   * 本轮用户消息的附加内容块（附件里的图片）。
   *
   * 为什么单独一个字段而不把 input 改成联合类型：input 还参与 trace、估算、续跑提示拼接，
   * 到处都是字符串操作；图片只在拼 wire messages 的那一刻才需要，放在尾部最小侵入。
   */
  inputParts?: ContentPart[];
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

/**
 * 模型消息内容块。
 *
 * 字符串是历史默认形态；图片走内容块（对齐 Proma 的内部消息形状），
 * 到 OpenAI 兼容 wire 上再转成 image_url + data URL。
 */
export type ContentPart =
  | { type: "text"; text: string }
  | { type: "image"; mimeType: string; data: string };

/** 模型消息内容：纯文本或内容块数组 */
export type MessageContent = string | ContentPart[];

/**
 * 工具执行结果。
 *
 * 默认是纯文本；图片/解析类工具可以额外带回内容块（对齐 Proma：工具结果也能带图）。
 * parts 只走模型通道，不进 trace、不进 toolCalls 摘要（base64 落进日志会失控）。
 */
export interface ToolRunResult {
  text: string;
  parts?: ContentPart[];
}

export interface ChatRequest {
  message: string;
  sessionId?: string | null;
  outputId?: string;
  topic?: string;
  workDir?: string;
  /**
   * 系统注入的驱动/判读请求：只进本轮模型输入，**不写入会话历史**。
   * 用于值日生唤醒等系统驱动轮次——避免驱动话术永久污染历史与缓存前缀。
   */
  transient?: boolean;
  /**
   * 轮次模式（决定尾部模式块与是否注入历史）：
   * - chat    老师直接说话（缺省）
   * - verdict 系统唤醒的台账判读轮
   * - stalled 停转复查唤醒
   * 未传时由 transient 推导（transient → verdict）。
   */
  turnMode?: TurnMode;
  /**
   * 随本轮用户消息一起提交的附件（输入框粘贴/拖拽/选择）。
   * 落盘进消息 extra，并把清单拼进模型输入；图片按能力内联为内容块。
   */
  attachments?: AttachmentRef[];
  onEvent?: (event: StreamEvent) => void;
  signal?: AbortSignal;
}

/** 轮次模式：见 src/turn-mode.ts */
export type TurnMode = "chat" | "verdict" | "stalled";

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
  /** 本轮实际使用的模型名（消息头展示用） */
  model?: string;
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
