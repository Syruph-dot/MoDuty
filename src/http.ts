import type { IncomingMessage, ServerResponse } from "node:http";
import { readFile, stat } from "node:fs/promises";
import path from "node:path";

import { assessmentToSnake, evolutionProposalToSnake, reflectionToSnake } from "./casing.js";
import { LIKERT_LABELS } from "./config.js";
import { MomokaAgentCore, MomokaHttpError } from "./agent.js";
import { AgentRegistry } from "./agent-registry.js";
import { ApprovalStore } from "./approvals.js";
import { AgentStateMachine, type AgentStateEvent, type ContextStatsSnake } from "./agent-state.js";
import type { SessionRecord } from "./session-manager.js";
import type { AgentRecord, ChatRequest, ChatResponse, ContextStats, JudgeResponse, MomokaHttpHandler, RunRecord, StreamEvent } from "./types.js";
import { loadSettings, saveSettings } from "./settings-store.js";

export interface AgentHttpOptions {
  /** 多 Agent 注册表；缺省时 /api/agents 系列返回 503 */
  registry?: AgentRegistry;
  /** 生命周期状态机；缺省时 /api/agents 系列返回 503 */
  machine?: AgentStateMachine;
}

export function createMomokaHttpHandler(agent: MomokaAgentCore, options: AgentHttpOptions = {}): MomokaHttpHandler {
  const { registry, machine } = options;
  const sseClients = new Set<ServerResponse>();
  if (registry && machine) {
    // 全局编排：任何状态/phase 转移 → 持久化注册表 + 广播给 /api/agents/events 的客户端
    machine.subscribe((event) => {
      void persistAgentState(registry, sseClients, event);
    });
  }
  return (request: IncomingMessage, response: ServerResponse) => {
    void route(agent, request, response, registry, machine, sseClients);
  };
}

async function route(
  agent: MomokaAgentCore,
  request: IncomingMessage,
  response: ServerResponse,
  registry: AgentRegistry | undefined,
  machine: AgentStateMachine | undefined,
  sseClients: Set<ServerResponse>,
): Promise<void> {
  try {
    const url = new URL(request.url ?? "/", "http://localhost");

    // CORS：桌面壳（Tauri webview 为 tauri://localhost 源）跨源访问本地 API；
    // 预检（JSON body / 自定义头）直接放行
    if (request.method === "OPTIONS") {
      response.writeHead(204, corsHeaders());
      response.end();
      return;
    }

    if (request.method === "GET" && url.pathname === "/api/health") {
      send(response, 200, "MOMOKA OK", "text/plain; charset=utf-8");
      return;
    }
    if (request.method === "GET" && url.pathname === "/api/config") {
      const baseUrl = process.env.OPENAI_BASE_URL ?? "";
      const isZen = /opencode\.ai\/zen/i.test(baseUrl);
      const hasKey = Boolean(process.env.ALIYUN_API_KEY || process.env.OPENAI_API_KEY);
      const provider = process.env.ALIYUN_API_KEY ? "DashScope" : (isZen ? "OpenCode Zen" : (baseUrl || "OpenAI"));
      const issues: string[] = [];
      if (!hasKey) {
        if (isZen) {
          issues.push("OpenCode Zen 需要 API key。请前往 https://opencode.ai/auth 注册免费账号，获取 API key 后设置 OPENAI_API_KEY。");
        } else if (process.env.ALIYUN_API_KEY || !baseUrl) {
          issues.push("API key 未配置。请设置 ALIYUN_API_KEY 或 OPENAI_API_KEY。");
        }
      }
      json(response, 200, {
        info: {
          provider,
          key_prefix: `${(process.env.ALIYUN_API_KEY ?? process.env.OPENAI_API_KEY ?? "").slice(0, 8)}...`,
          model: process.env.MOMOKA_MODEL ?? "qwen-plus",
        },
        issues,
      });
      return;
    }
    if (request.method === "GET" && url.pathname === "/api/settings") {
      const settings = await loadSettings();
      const apiKey = settings.apiKey ?? process.env.ALIYUN_API_KEY ?? process.env.OPENAI_API_KEY ?? "";
      const baseUrl = settings.baseUrl ?? process.env.OPENAI_BASE_URL ?? "";
      const model = settings.model ?? process.env.MOMOKA_MODEL ?? "qwen-plus";
      json(response, 200, {
        sandbox_enabled: agent.getSandboxEnabled(),
        apiKey_masked: apiKey ? `${apiKey.slice(0, 8)}...` : "",
        baseUrl,
        model,
      });
      return;
    }
    if (request.method === "POST" && url.pathname === "/api/settings") {
      const body = await readJsonBody(request);
      const patch: { apiKey?: string; baseUrl?: string; model?: string } = {};
      if (typeof body.apiKey === "string") patch.apiKey = body.apiKey;
      if (typeof body.baseUrl === "string") patch.baseUrl = body.baseUrl.replace(/\/+$/u, "");
      if (typeof body.model === "string") patch.model = body.model;
      await saveSettings(patch);
      json(response, 200, { ok: true });
      return;
    }
    if (request.method === "GET" && url.pathname === "/api/models") {
      const settings = await loadSettings();
      const baseUrl = (
        settings.baseUrl ?? process.env.OPENAI_BASE_URL ?? "https://dashscope.aliyuncs.com/compatible-mode/v1"
      ).replace(/\/+$/u, "");
      const apiKey = settings.apiKey ?? process.env.ALIYUN_API_KEY ?? process.env.OPENAI_API_KEY ?? "";
      try {
        const upstream = await fetch(`${baseUrl}/models`, {
          headers: apiKey ? { authorization: `Bearer ${apiKey}` } : {},
        });
        if (!upstream.ok) {
          json(response, upstream.status, { error: `models 请求失败: HTTP ${upstream.status}`, models: [] });
          return;
        }
        const data = (await upstream.json()) as { data?: Array<{ id?: string }> };
        const models = (data.data ?? [])
          .map((m) => m.id)
          .filter((id): id is string => typeof id === "string" && id.length > 0);
        json(response, 200, { models });
      } catch (error) {
        json(response, 502, { error: error instanceof Error ? error.message : String(error), models: [] });
      }
      return;
    }
    if (request.method === "POST" && url.pathname === "/api/settings/sandbox") {
      const body = await readJsonBody(request);
      await agent.setSandboxEnabled(Boolean(body.enabled));
      json(response, 200, { sandbox_enabled: agent.getSandboxEnabled() });
      return;
    }

    if (request.method === "GET" && url.pathname === "/api/directories") {
      json(response, 200, await agent.listDirectories(url.searchParams.get("path") ?? ""));
      return;
    }
    if (request.method === "GET" && url.pathname === "/api/sessions") {
      json(response, 200, { sessions: (await agent.sessionManager.listSessions()).map(sessionToSnake) });
      return;
    }
    if (request.method === "POST" && url.pathname === "/api/sessions") {
      const body = await readJsonBody(request);
      const session = await agent.createSession(String(body.goal ?? ""), String(body.folder_path ?? ""));
      json(response, 200, { session: sessionToSnake(session) });
      return;
    }

    // ---- 会话检索 / 检视 / 读取（Session-as-a-Resource）----
    // 必须放在下方 sessionMatch 之前：否则 /api/sessions/search 会被当作 sessionId="search"，
    // /inspect、/read 会被当作普通 GET 返回 session 元数据而非其语义。
    if (request.method === "GET" && url.pathname === "/api/sessions/search") {
      const query = url.searchParams.get("q") ?? "";
      const rawLimit = Number(url.searchParams.get("limit") ?? "");
      const limit = Number.isInteger(rawLimit) && rawLimit > 0 ? Math.min(rawLimit, 50) : 20;
      json(response, 200, { hits: await agent.sessionManager.searchSessions(query, limit) });
      return;
    }

    const sessionInspectMatch = url.pathname.match(/^\/api\/sessions\/([^/]+)\/inspect$/);
    if (sessionInspectMatch && request.method === "GET") {
      const sessionId = decodeURIComponent(sessionInspectMatch[1] ?? "");
      if (!(await agent.sessionManager.getSession(sessionId))) {
        throw new MomokaHttpError(404, `Unknown session: ${sessionId}`);
      }
      json(response, 200, { inspect: await agent.sessionManager.inspectSession(sessionId) });
      return;
    }

    const sessionReadMatch = url.pathname.match(/^\/api\/sessions\/([^/]+)\/read$/);
    if (sessionReadMatch && request.method === "GET") {
      const sessionId = decodeURIComponent(sessionReadMatch[1] ?? "");
      if (!(await agent.sessionManager.getSession(sessionId))) {
        throw new MomokaHttpError(404, `Unknown session: ${sessionId}`);
      }
      let from = Number(url.searchParams.get("from") ?? "");
      let to = Number(url.searchParams.get("to") ?? "");
      if (!Number.isFinite(from) || from <= 0) from = 1;
      if (!Number.isFinite(to) || to <= 0) to = 0; // 0 = 末尾（由 readSessionTranscript 兜底）
      json(response, 200, { transcript: await agent.sessionManager.readSessionTranscript(sessionId, from, to) });
      return;
    }

    const sessionMatch = url.pathname.match(/^\/api\/sessions\/([^/]+)(\/messages)?$/);
    if (sessionMatch && request.method === "GET" && sessionMatch[2] === "/messages") {
      const sessionId = decodeURIComponent(sessionMatch[1] ?? "");
      if (!await agent.sessionManager.getSession(sessionId)) {
        throw new MomokaHttpError(404, `Unknown session: ${sessionId}`);
      }
      json(response, 200, { messages: await agent.sessionManager.getMessages(sessionId) });
      return;
    }
    if (sessionMatch && request.method === "GET") {
      const sessionId = decodeURIComponent(sessionMatch[1] ?? "");
      const session = await agent.sessionManager.getSession(sessionId);
      if (!session) {
        throw new MomokaHttpError(404, `Unknown session: ${sessionId}`);
      }
      json(response, 200, { session: sessionToSnake(session) });
      return;
    }
    if (sessionMatch && request.method === "DELETE") {
      const sessionId = decodeURIComponent(sessionMatch[1] ?? "");
      if (!await agent.sessionManager.deleteSession(sessionId)) {
        throw new MomokaHttpError(404, `Unknown session: ${sessionId}`);
      }
      json(response, 200, { success: true });
      return;
    }

    // ---- Agent registry & 实时状态 SSE（MOMOKA Agent Desktop）----
    if (request.method === "GET" && url.pathname === "/api/agents/events") {
      ensureAgents(registry, machine);
      openAgentEvents(response, sseClients);
      return;
    }
    if (request.method === "GET" && url.pathname === "/api/agents") {
      const runtime = ensureAgents(registry, machine);
      const records = await runtime.registry.listAgents();
      const agents = [];
      for (const record of records) {
        agents.push(agentToSnake(record, await agent.sessionManager.getSession(record.sessionId)));
      }
      json(response, 200, { agents });
      return;
    }

    // 孤儿 session（旧 chat.html 时代残留）—— 数据级清理入口，无 UI
    const legacyMatch = url.pathname.match(/^\/api\/agents\/legacy-sessions$/);
    if (legacyMatch && request.method === "GET") {
      const runtime = ensureAgents(registry, machine);
      const sessions = await runtime.registry.listLegacySessions();
      json(response, 200, { sessions });
      return;
    }
    if (legacyMatch && request.method === "DELETE") {
      const runtime = ensureAgents(registry, machine);
      const removed = await runtime.registry.cleanupLegacySessions();
      json(response, 200, { removed });
      return;
    }
    if (request.method === "POST" && url.pathname === "/api/agents") {
      const runtime = ensureAgents(registry, machine);
      const body = await readJsonBody(request);
      const name = String(body.name ?? "").trim();
      const role = String(body.role ?? "").trim();
      const workspaceDir = String(body.workspace_dir ?? "").trim();
      // name 必填；role 与 workspace_dir 允许空，由 registry 补默认 system prompt / 默认 workspace。
      if (!name) {
        throw new MomokaHttpError(400, "name is required");
      }
      const record = await runtime.registry.createAgent({
        name,
        role,
        workspaceDir,
        model: typeof body.model === "string" ? body.model : undefined,
      });
      runtime.machine.seed(record.id, record.state, record.phase);
      json(response, 200, { agent: agentToSnake(record, await agent.sessionManager.getSession(record.sessionId)) });
      return;
    }

    const agentMessagesMatch = url.pathname.match(/^\/api\/agents\/([^/]+)\/messages$/);
    if (agentMessagesMatch && request.method === "GET") {
      const runtime = ensureAgents(registry, machine);
      const record = await requireAgent(runtime.registry, decodeURIComponent(agentMessagesMatch[1] ?? ""));
      json(response, 200, { messages: await agent.sessionManager.getMessages(record.sessionId) });
      return;
    }

    const agentChatMatch = url.pathname.match(/^\/api\/agents\/([^/]+)\/chat$/);
    if (agentChatMatch && request.method === "POST") {
      const runtime = ensureAgents(registry, machine);
      const record = await requireAgent(runtime.registry, decodeURIComponent(agentChatMatch[1] ?? ""));
      const body = await readJsonBody(request);
      const message = String(body.message ?? "").trim();
      if (!message) {
        throw new MomokaHttpError(400, "Message cannot be empty");
      }
      await streamAgentChat(agent, runtime.machine, response, record, message);
      return;
    }

    const agentMatch = url.pathname.match(/^\/api\/agents\/([^/]+)$/);
    if (agentMatch && request.method === "GET") {
      const runtime = ensureAgents(registry, machine);
      const record = await requireAgent(runtime.registry, decodeURIComponent(agentMatch[1] ?? ""));
      json(response, 200, {
        agent: agentToSnake(record, await agent.sessionManager.getSession(record.sessionId)),
        messages: await agent.sessionManager.getMessages(record.sessionId),
      });
      return;
    }
    if (agentMatch && request.method === "PUT") {
      const runtime = ensureAgents(registry, machine);
      const record = await requireAgent(runtime.registry, decodeURIComponent(agentMatch[1] ?? ""));
      const body = await readJsonBody(request);
      const newName = String(body.name ?? "").trim();
      if (!newName) {
        throw new MomokaHttpError(400, "name is required");
      }
      const updated = await runtime.registry.renameAgent(record.id, newName);
      json(response, 200, { agent: agentToSnake(updated, await agent.sessionManager.getSession(updated.sessionId)) });
      return;
    }
    if (agentMatch && request.method === "DELETE") {
      const runtime = ensureAgents(registry, machine);
      const record = await requireAgent(runtime.registry, decodeURIComponent(agentMatch[1] ?? ""));
      await runtime.registry.deleteAgent(record.id);
      runtime.machine.drop(record.id);
      json(response, 200, { success: true });
      return;
    }

    if (request.method === "GET" && url.pathname === "/api/approvals") {
      const workspace = url.searchParams.get("work_dir") ?? "";
      json(response, 200, { approvals: await agent.listApprovals(workspace) });
      return;
    }
    const approvalDecisionMatch = url.pathname.match(/^\/api\/approvals\/([^/]+)\/decision$/);
    if (request.method === "POST" && approvalDecisionMatch) {
      const body = await readJsonBody(request);
      const decision = body.decision;
      if (decision !== "approved" && decision !== "rejected") {
        throw new MomokaHttpError(400, "Decision must be approved or rejected");
      }
      const operator = typeof body.operator === "string" ? body.operator : "";
      if (!operator.trim()) throw new MomokaHttpError(400, "Approval operator is required");
      const workspace = typeof body.work_dir === "string" ? body.work_dir : "";
      const outcome = await agent.decideApproval(workspace, decodeURIComponent(approvalDecisionMatch[1] ?? ""), decision, operator);
      // Agent 联动：审批事件若绑定某 Agent 的 session，则驱动其状态机脱离 waiting_approval
      if (registry && machine && typeof outcome === "object" && outcome !== null) {
        const sessionId = (outcome as { event?: { sessionId?: string } }).event?.sessionId;
        if (typeof sessionId === "string" && sessionId) {
          const bound = (await registry.listAgents()).find((candidate) => candidate.sessionId === sessionId);
          if (bound) {
            machine.decide(bound.id, decision);
            // 第 2 周验收：批准后续跑（异步，不阻塞审批响应）
            if (decision === "approved") {
              void resumeAgentAfterApproval(agent, bound, machine);
            }
          }
        }
      }
      json(response, 200, outcome);
      return;
    }

    if (request.method === "POST" && url.pathname === "/api/chat") {
      const body = await readJsonBody(request);
      const chatRequest: ChatRequest = {
        message: String(body.message ?? ""),
        sessionId: typeof body.session_id === "string" ? body.session_id : null,
        outputId: typeof body.output_id === "string" ? body.output_id : undefined,
        topic: typeof body.topic === "string" ? body.topic : undefined,
        workDir: typeof body.work_dir === "string" ? body.work_dir : undefined,
      };
      if (body.stream === true) {
        await streamChat(agent, response, chatRequest);
        return;
      }
      const result = await agent.chat(chatRequest);
      json(response, 200, chatToSnake(result));
      return;
    }

    if (request.method === "POST" && url.pathname === "/api/judge") {
      const body = await readJsonBody(request);
      const result = await agent.judge({
        outputId: String(body.output_id ?? ""),
        score: Number(body.score ?? 0),
        context: typeof body.context === "string" ? body.context : "",
        comment: typeof body.comment === "string" ? body.comment : "",
        continue: Boolean(body.continue),
      });
      json(response, 200, judgeToSnake(result));
      return;
    }

    if (request.method === "GET" || request.method === "HEAD") {
      if (await serveStatic(agent.projectRoot, url.pathname, response, request.method === "HEAD")) {
        return;
      }
    }

    json(response, 404, { error: "Not found" });
  } catch (error) {
    if (error instanceof MomokaHttpError) {
      json(response, error.statusCode, { error: error.message, ...error.details });
      return;
    }
    json(response, 500, { error: error instanceof Error ? error.message : String(error) });
  }
}

async function serveStatic(projectRoot: string, urlPathname: string, response: ServerResponse, headOnly: boolean): Promise<boolean> {
  const staticRoot = path.join(projectRoot, "static");
  const decoded = decodeURIComponent(urlPathname);
  const relativePath = decoded === "/" ? "index.html" : decoded.replace(/^\/+/u, "");
  const candidate = path.resolve(staticRoot, relativePath);
  const relative = path.relative(staticRoot, candidate);
  if (relative.startsWith("..") || path.isAbsolute(relative)) {
    return false;
  }
  const fileStats = await stat(candidate).catch(() => null);
  const filePath = fileStats?.isDirectory() ? path.join(candidate, "index.html") : candidate;
  const finalStats = await stat(filePath).catch(() => null);
  if (!finalStats?.isFile()) {
    return false;
  }
  response.writeHead(200, {
    "content-type": contentTypeFor(filePath),
    "cache-control": "no-store",
  });
  if (headOnly) {
    response.end();
  } else {
    response.end(await readFile(filePath));
  }
  return true;
}

function contentTypeFor(filePath: string): string {
  const ext = path.extname(filePath).toLowerCase();
  if (ext === ".html") return "text/html; charset=utf-8";
  if (ext === ".js") return "application/javascript; charset=utf-8";
  if (ext === ".css") return "text/css; charset=utf-8";
  if (ext === ".json") return "application/json; charset=utf-8";
  if (ext === ".png") return "image/png";
  if (ext === ".jpg" || ext === ".jpeg") return "image/jpeg";
  if (ext === ".svg") return "image/svg+xml";
  return "application/octet-stream";
}

async function streamChat(agent: MomokaAgentCore, response: ServerResponse, request: ChatRequest): Promise<void> {
  response.writeHead(200, {
    "content-type": "text/event-stream; charset=utf-8",
    "cache-control": "no-store",
    connection: "keep-alive",
  });
  const controller = new AbortController();
  response.on("close", () => {
    if (!response.writableEnded) controller.abort();
  });
  try {
    const result = await agent.chat({
      ...request,
      onEvent: (event: StreamEvent) => sseData(response, event),
      signal: controller.signal,
    });
    sseData(response, { type: "done", ...chatToSnake(result) });
  } catch (error) {
    sseData(response, { type: "error", error: error instanceof Error ? error.message : String(error) });
  } finally {
    response.end();
  }
}

function sseData(response: ServerResponse, data: unknown): void {
  response.write(`data: ${JSON.stringify(data)}\n\n`);
}

async function readJsonBody(request: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  if (chunks.length === 0) {
    return {};
  }
  try {
    const parsed = JSON.parse(Buffer.concat(chunks).toString("utf8")) as unknown;
    return typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)
      ? parsed as Record<string, unknown>
      : {};
  } catch {
    throw new MomokaHttpError(400, "Request body must be JSON");
  }
}

function json(response: ServerResponse, status: number, payload: unknown): void {
  send(response, status, `${JSON.stringify(payload)}\n`, "application/json; charset=utf-8");
}

function send(response: ServerResponse, status: number, body: string, contentType: string): void {
  response.writeHead(status, {
    "content-type": contentType,
    "cache-control": "no-store",
    ...corsHeaders(),
  });
  response.end(body);
}

function corsHeaders(): Record<string, string> {
  return {
    "access-control-allow-origin": "*",
    "access-control-allow-methods": "GET, POST, DELETE, OPTIONS",
    "access-control-allow-headers": "content-type",
  };
}

function chatToSnake(payload: ChatResponse): Record<string, unknown> {
  return {
    run_id: payload.runId,
    output_id: payload.outputId,
    topic: payload.topic,
    response: payload.response,
    annotation_runtime_context: payload.annotationRuntimeContext,
    output_assessment: assessmentToSnake(payload.outputAssessment),
    tool_calls: payload.toolCalls,
    matched_skills: payload.matchedSkills,
    skill_reasons: payload.skillReasons,
    session_id: payload.sessionId ?? null,
  };
}

function judgeToSnake(payload: JudgeResponse): Record<string, unknown> {
  const out: Record<string, unknown> = {
    run_id: payload.runId,
    output_id: payload.outputId,
    score: payload.score,
    label: payload.label,
    analysis: payload.analysis,
    reflection: reflectionToSnake(payload.reflection),
    annotated_text: payload.annotatedText,
    comment: payload.comment,
    preference_update: payload.preferenceUpdate,
    evolution_proposals: payload.evolutionProposals.map(evolutionProposalToSnake),
  };
  if (payload.nextOutputId) {
    out.next_output_id = payload.nextOutputId;
    out.next_response = payload.nextResponse;
    out.next_annotation_runtime_context = payload.nextAnnotationRuntimeContext;
    out.next_output_assessment = payload.nextOutputAssessment
      ? assessmentToSnake(payload.nextOutputAssessment)
      : undefined;
    out.next_tool_calls = payload.nextToolCalls ?? [];
    out.next_skill_reasons = payload.nextSkillReasons ?? [];
  }
  return out;
}

function runToSnake(run: RunRecord): Record<string, unknown> {
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

function sessionToSnake(session: {
  id: string;
  name: string;
  goal: string;
  folderPath: string;
  createdAt: string;
  messageCount: number;
  lastMessageAt: string;
}): Record<string, unknown> {
  return {
    id: session.id,
    name: session.name,
    goal: session.goal,
    folder_path: session.folderPath,
    created_at: session.createdAt,
    message_count: session.messageCount,
    last_message_at: session.lastMessageAt,
  };
}

function ensureAgents(registry: AgentRegistry | undefined, machine: AgentStateMachine | undefined): { registry: AgentRegistry; machine: AgentStateMachine } {
  if (!registry || !machine) {
    throw new MomokaHttpError(503, "Agent registry not configured");
  }
  return { registry, machine };
}

async function requireAgent(registry: AgentRegistry, agentId: string) {
  const record = await registry.getAgent(agentId);
  if (!record) {
    throw new MomokaHttpError(404, `Unknown agent: ${agentId}`);
  }
  return record;
}

function agentToSnake(record: AgentRecord, session: SessionRecord | null): Record<string, unknown> {
  return {
    id: record.id,
    name: record.name,
    role: record.role,
    ...(record.model ? { model: record.model } : {}),
    workspace_dir: record.workspaceDir,
    session_id: record.sessionId,
    state: record.state,
    phase: record.phase ?? null,
    ...(record.contextStats ? { context_stats: contextStatsToSnake(record.contextStats) } : {}),
    created_at: record.createdAt,
    last_active_at: record.lastActiveAt,
    session: session
      ? {
          goal: session.goal,
          folder_path: session.folderPath,
          message_count: session.messageCount,
          last_message_at: session.lastMessageAt,
        }
      : null,
  };
}

/** 上下文占用指标（camel 内存）→ 对外 snake 结构 */
function contextStatsToSnake(stats: ContextStats): ContextStatsSnake {
  return {
    prompt_tokens: stats.promptTokens,
    context_window: stats.contextWindow,
    cached_tokens: stats.cachedTokens,
    updated_at: stats.updatedAt,
  };
}

/** /api/agents/events：长连接，广播 agent_state 事件；30s 心跳注释保活 */
function openAgentEvents(response: ServerResponse, sseClients: Set<ServerResponse>): void {
  response.writeHead(200, {
    "content-type": "text/event-stream; charset=utf-8",
    "cache-control": "no-store",
    connection: "keep-alive",
    ...corsHeaders(),
  });
  // 立即冲刷响应头：不做的话 Node 会等第一个 write 才发头，客户端 fetch 将挂起
  response.flushHeaders();
  sseClients.add(response);
  const ping = setInterval(() => {
    if (!response.writableEnded) {
      response.write(": ping\n\n");
    }
  }, 30000);
  response.on("close", () => {
    clearInterval(ping);
    sseClients.delete(response);
  });
}

/** 状态转移 → 持久化注册表 + 广播给所有 /api/agents/events 客户端 */
async function persistAgentState(registry: AgentRegistry, sseClients: Set<ServerResponse>, event: AgentStateEvent): Promise<void> {
  const updated = await registry.updateAgentState(event.agent_id, event.state, event.phase);
  const payload: AgentStateEvent = {
    ...event,
    ...(updated?.contextStats ? { context_stats: contextStatsToSnake(updated.contextStats) } : {}),
  };
  const frame = `data: ${JSON.stringify(payload)}\n\n`;
  for (const client of [...sseClients]) {
    try {
      if (!client.writableEnded) {
        client.write(frame);
      }
    } catch {
      // 客户端已断开，忽略
    }
  }
}

/** 检查某 Agent 绑定的 workspace 是否有待决审批（第 2 周验收：pending_approval 时不 complete） */
async function checkHasPendingApproval(record: AgentRecord): Promise<boolean> {
  try {
    const store = new ApprovalStore(record.workspaceDir);
    const approvals = await store.list();
    return approvals.some((approval) => approval.status === "pending");
  } catch {
    return false;
  }
}

/** 审批通过后续跑：把工具结果交给模型继续推理（第 2 周验收：从断点继续，不是从头跑） */
async function resumeAgentAfterApproval(
  agent: MomokaAgentCore,
  record: AgentRecord,
  machine: AgentStateMachine,
): Promise<void> {
  try {
    await agent.chat({
      message: "审批已通过。请根据工具执行结果继续完成任务。",
      sessionId: record.sessionId,
      onEvent: (event) => {
        machine.consumeEvent(record.id, event);
      },
    });
    machine.complete(record.id);
  } catch (error) {
    console.error("[resume] 审批后续跑失败:", error);
    machine.fail(record.id);
  }
}

/** /api/agents/:id/chat：SSE 流式，作用域锁定 Agent 绑定的 session，事件喂给状态机 */
async function streamAgentChat(
  agent: MomokaAgentCore,
  machine: AgentStateMachine,
  response: ServerResponse,
  record: AgentRecord,
  message: string,
): Promise<void> {
  response.writeHead(200, {
    "content-type": "text/event-stream; charset=utf-8",
    "cache-control": "no-store",
    connection: "keep-alive",
    ...corsHeaders(),
  });
  const controller = new AbortController();
  // 不在 response close 时 abort：前端断开（如切回磁贴态）不应中止后端 chat 流
  // 后端 chat 流会在 response.end()（finally 块）时自然结束
  try {
    const result = await agent.chat({
      message,
      sessionId: record.sessionId,
      onEvent: (event: StreamEvent) => {
        machine.consumeEvent(record.id, event);
        sseData(response, event);
      },
      signal: controller.signal,
    });
    // 第 2 周验收：pending_approval 时不 complete（保持等待，等审批通过后续跑）
    const hasPendingApproval = await checkHasPendingApproval(record);
    if (!hasPendingApproval) {
      machine.complete(record.id);
    }
    sseData(response, { type: "done", ...chatToSnake(result) });
  } catch (error) {
    machine.fail(record.id);
    sseData(response, { type: "error", error: error instanceof Error ? error.message : String(error) });
  } finally {
    response.end();
  }
}

export { LIKERT_LABELS };
