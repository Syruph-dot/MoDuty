import type { IncomingMessage, ServerResponse } from "node:http";

import { MomokaHttpError } from "../http-error.js";
import { DISPATCHER_SYSTEM_PROMPT } from "../agent-registry.js";
import type { AgentRecord, StreamEvent } from "../types.js";
import { corsHeaders, json, readJsonBody, sseData } from "./http-utils.js";
import { ensureAgents, requireAgent, type RouteContext } from "./route-context.js";
import { checkHasPendingApproval, checkHasPendingQuestion, driveQuestionAnswered, orchestrationOf } from "./agent-orchestration.js";
import { abortChatStreamByAgent, registerChatStream, unregisterChatStream } from "./chat-streams.js";
import { agentToSnake, chatToSnake } from "./serialization.js";

/**
 * Agent 轨道路由（MOMOKA Agent Desktop）：注册表 CRUD、消息读取、
 * /api/agents/events SSE、/api/agents/:id/chat 流式对话，以及旧轨道数据的
 * 清理入口（legacy-sessions）。
 */
export async function handleAgentRoutes(
  ctx: RouteContext,
  request: IncomingMessage,
  response: ServerResponse,
  url: URL,
): Promise<boolean> {
  const agent = ctx.agent;

  if (request.method === "GET" && url.pathname === "/api/agents/events") {
    ensureAgents(ctx);
    ctx.broadcaster.open(response);
    return true;
  }
  if (request.method === "GET" && url.pathname === "/api/agents") {
    const runtime = ensureAgents(ctx);
    const records = await runtime.registry.listAgents();
    const agents = [];
    for (const record of records) {
      agents.push(agentToSnake(record, await agent.sessionManager.getSession(record.sessionId)));
    }
    json(response, 200, { agents });
    return true;
  }

  // 孤儿 session（旧 chat.html 时代残留）—— 数据级清理入口，无 UI
  const legacyMatch = url.pathname.match(/^\/api\/agents\/legacy-sessions$/);
  if (legacyMatch && request.method === "GET") {
    const runtime = ensureAgents(ctx);
    json(response, 200, { sessions: await runtime.registry.listLegacySessions() });
    return true;
  }
  if (legacyMatch && request.method === "DELETE") {
    const runtime = ensureAgents(ctx);
    json(response, 200, { removed: await runtime.registry.cleanupLegacySessions() });
    return true;
  }
  if (request.method === "POST" && url.pathname === "/api/agents") {
    const runtime = ensureAgents(ctx);
    const body = await readJsonBody(request);
    const name = String(body.name ?? "").trim();
    const role = String(body.system ?? body.role ?? "").trim();
    const workspaceDir = String(body.workspace_dir ?? "").trim();
    // name 必填；role 与 workspace_dir 允许空，由 registry 补默认 system prompt / 默认 workspace。
    if (!name) {
      throw new MomokaHttpError(400, "name is required");
    }
    const kind = body.kind === "dispatcher" || body.kind === "worker" ? (body.kind as "dispatcher" | "worker") : undefined;
    // 值日生唯一化：dispatcher（或重名"值日生"）已存在时复用现有记录，不创建第二个
    if (kind === "dispatcher") {
      const existing = await runtime.registry.findDispatcher();
      if (existing) {
        json(response, 200, { agent: agentToSnake(existing, await agent.sessionManager.getSession(existing.sessionId)), reused: true });
        return true;
      }
    }
    // 值日生单源：kind=dispatcher 的 Agent 忽略前端传入的 system，一律使用后端 DISPATCHER 常量，避免双源漂移。
    const effectiveRole = kind === "dispatcher" ? DISPATCHER_SYSTEM_PROMPT : role;
    const record = await runtime.registry.createAgent({
      name,
      role: effectiveRole,
      workspaceDir,
      model: typeof body.model === "string" ? body.model : undefined,
      kind,
    });
    runtime.machine.seed(record.id, record.state, record.phase);
    json(response, 200, { agent: agentToSnake(record, await agent.sessionManager.getSession(record.sessionId)) });
    return true;
  }

  const agentMessagesMatch = url.pathname.match(/^\/api\/agents\/([^/]+)\/messages$/);
  if (agentMessagesMatch && request.method === "GET") {
    const runtime = ensureAgents(ctx);
    const record = await requireAgent(runtime.registry, decodeURIComponent(agentMessagesMatch[1] ?? ""));
    json(response, 200, { messages: await agent.sessionManager.getMessages(record.sessionId) });
    return true;
  }

  // 桌面问答：拉取某 Agent 的待答问题集（RequiringInput 状态时磁贴/窗口调用）
  const agentQuestionsMatch = url.pathname.match(/^\/api\/agents\/([^/]+)\/questions$/);
  if (agentQuestionsMatch && request.method === "GET") {
    const runtime = ensureAgents(ctx);
    const record = await requireAgent(runtime.registry, decodeURIComponent(agentQuestionsMatch[1] ?? ""));
    json(response, 200, { questions: await runtime.registry.pendingQuestionsForAgent(record.id) });
    return true;
  }

  // 提交答案：把答案以 user 消息写入会话（resume 历史完整）→ 驱动状态机脱离 requiring_input → 续跑
  const questionAnswerMatch = url.pathname.match(/^\/api\/agents\/([^/]+)\/questions\/([^/]+)\/answer$/);
  if (questionAnswerMatch && request.method === "POST") {
    const runtime = ensureAgents(ctx);
    const record = await requireAgent(runtime.registry, decodeURIComponent(questionAnswerMatch[1] ?? ""));
    const setId = decodeURIComponent(questionAnswerMatch[2] ?? "");
    const body = await readJsonBody(request) as { answers?: Array<{ questionIndex?: unknown; choiceIndex?: unknown; customText?: unknown }> };
    const raw = Array.isArray(body.answers) ? body.answers : [];
    const answers = raw.map((item) => ({
      questionIndex: Number(item.questionIndex ?? 0),
      choiceIndex: Number(item.choiceIndex ?? -1),
      ...(typeof item.customText === "string" ? { customText: item.customText } : {}),
    }));
    const set = await runtime.registry.answerQuestionSet(setId, answers);
    if (!set) throw new MomokaHttpError(409, "Question set not found or already answered");
    // 把问答摘要写入会话（user 角色）：后续 resume chat 会读到这些历史
    const lines = set.questions.map((question, index) => {
      const answer = answers.find((item) => item.questionIndex === index);
      const chosen = answer && answer.choiceIndex >= 0 && answer.choiceIndex < question.options.length
        ? question.options[answer.choiceIndex]
        : answer?.customText?.trim() ?? "（未作答）";
      return `Q${index + 1}: ${question.prompt}\n  答案: ${chosen}`;
    });
    await agent.sessionManager.addMessage(record.sessionId, "user", `用户对提问的回答：\n${lines.join("\n")}`);
    // Agent 联动：脱离 requiring_input → 异步续跑（不阻塞答案响应）
    const deps = orchestrationOf(ctx);
    void driveQuestionAnswered(deps, record).catch((error: unknown) => {
      console.error("[question] 答案后驱失败:", error);
    });
    json(response, 200, { success: true, question: set });
    return true;
  }

  const agentChatMatch = url.pathname.match(/^\/api\/agents\/([^/]+)\/chat$/);
  if (agentChatMatch && request.method === "POST") {
    const runtime = ensureAgents(ctx);
    const record = await requireAgent(runtime.registry, decodeURIComponent(agentChatMatch[1] ?? ""));
    const body = await readJsonBody(request);
    const message = String(body.message ?? "").trim();
    if (!message) {
      throw new MomokaHttpError(400, "Message cannot be empty");
    }
    await streamAgentChat(ctx, response, record, message);
    return true;
  }

  // 显式取消该 agent 的活跃 chat 流（前端停止按钮调用）
  const agentChatCancelMatch = url.pathname.match(/^\/api\/agents\/([^/]+)\/chat\/cancel$/);
  if (agentChatCancelMatch && request.method === "POST") {
    const runtime = ensureAgents(ctx);
    const record = await requireAgent(runtime.registry, decodeURIComponent(agentChatCancelMatch[1] ?? ""));
    const cancelled = abortChatStreamByAgent(record.id);
    json(response, 200, { cancelled });
    return true;
  }

  // 显式复位（窗口"重试"第一步）：error / waiting_approval / completed → idle；running 不动。
  const agentChatResetMatch = url.pathname.match(/^\/api\/agents\/([^/]+)\/chat\/reset$/);
  if (agentChatResetMatch && request.method === "POST") {
    const runtime = ensureAgents(ctx);
    const record = await requireAgent(runtime.registry, decodeURIComponent(agentChatResetMatch[1] ?? ""));
    runtime.machine.reset(record.id); // 转移经 wireAgentStatePersistence 自动落盘 state=idle
    json(response, 200, { success: true });
    return true;
  }

  // 分发文件给 Agent（Shell verb 桥进程调用）：接收文件路径列表 + 指令，写入会话并触发 chat
  const dispatchFilesMatch = url.pathname.match(/^\/api\/agents\/([^/]+)\/dispatch-files$/);
  if (dispatchFilesMatch && request.method === "POST") {
    const runtime = ensureAgents(ctx);
    const record = await requireAgent(runtime.registry, decodeURIComponent(dispatchFilesMatch[1] ?? ""));
    const body = await readJsonBody(request) as { files?: unknown[]; message?: unknown };
    const files = Array.isArray(body.files) ? body.files.map(String) : [];
    const message = typeof body.message === "string" ? body.message : "";
    if (files.length === 0) {
      throw new MomokaHttpError(400, "files array is required");
    }
    // 构造任务书：文件列表 + 用户指令
    const taskMessage = [
      message ? `指令: ${message}` : "",
      files.length > 0 ? `文件列表 (${files.length} 项):` : "",
      files.map((f, i) => `  ${i + 1}. ${f}`).join("\n"),
      "",
      "请处理上述文件。完成后在会话中给出结果摘要即可，无需回报给调度者。"
    ].filter(Boolean).join("\n");
    await agent.sessionManager.addMessage(record.sessionId, "user", taskMessage);
    // 异步触发 chat（不阻塞响应），由 orchestration 驱动
    const deps = orchestrationOf(ctx);
    void driveQuestionAnswered(deps, record).catch((error: unknown) => {
      console.error("[dispatch-files] 驱动失败:", error);
    });
    json(response, 200, { success: true, filesCount: files.length, message: "已分发给 Agent" });
    return true;
  }

  const agentMatch = url.pathname.match(/^\/api\/agents\/([^/]+)$/);
  if (agentMatch && request.method === "GET") {
    const runtime = ensureAgents(ctx);
    const record = await requireAgent(runtime.registry, decodeURIComponent(agentMatch[1] ?? ""));
    json(response, 200, {
      agent: agentToSnake(record, await agent.sessionManager.getSession(record.sessionId)),
      messages: await agent.sessionManager.getMessages(record.sessionId),
    });
    return true;
  }
  if (agentMatch && request.method === "PUT") {
    const runtime = ensureAgents(ctx);
    const record = await requireAgent(runtime.registry, decodeURIComponent(agentMatch[1] ?? ""));
    const body = await readJsonBody(request);
    const newName = String(body.name ?? "").trim();
    if (!newName) {
      throw new MomokaHttpError(400, "name is required");
    }
    const updated = await runtime.registry.renameAgent(record.id, newName);
    json(response, 200, { agent: agentToSnake(updated, await agent.sessionManager.getSession(updated.sessionId)) });
    return true;
  }
  if (agentMatch && request.method === "DELETE") {
    const runtime = ensureAgents(ctx);
    const record = await requireAgent(runtime.registry, decodeURIComponent(agentMatch[1] ?? ""));
    await runtime.registry.deleteAgent(record.id);
    runtime.machine.drop(record.id);
    json(response, 200, { success: true });
    return true;
  }

  // 截断会话消息：从指定 messageId 开始删除后续消息（用于原地编辑分叉）
  const truncateMatch = url.pathname.match(/^\/api\/agents\/([^/]+)\/messages\/truncate$/);
  if (truncateMatch && request.method === "POST") {
    const runtime = ensureAgents(ctx);
    const record = await requireAgent(runtime.registry, decodeURIComponent(truncateMatch[1] ?? ""));
    const body = await readJsonBody(request) as { messageId?: unknown };
    const messageId = typeof body.messageId === "string" ? body.messageId : "";
    if (!messageId) {
      throw new MomokaHttpError(400, "messageId is required");
    }
    const truncated = await agent.sessionManager.truncateMessages(record.sessionId, messageId);
    json(response, 200, { success: true, messages: truncated });
    return true;
  }

  // Agent 归档/取消归档
  const agentArchiveMatch = url.pathname.match(/^\/api\/agents\/([^/]+)\/archive$/);
  if (agentArchiveMatch && request.method === "POST") {
    const runtime = ensureAgents(ctx);
    const record = await requireAgent(runtime.registry, decodeURIComponent(agentArchiveMatch[1] ?? ""));
    const archived = await runtime.registry.archiveAgent(record.id);
    if (!archived) throw new MomokaHttpError(404, "Agent not found");
    json(response, 200, { success: true, agent: agentToSnake(archived, await agent.sessionManager.getSession(archived.sessionId)) });
    return true;
  }
  const agentUnarchiveMatch = url.pathname.match(/^\/api\/agents\/([^/]+)\/unarchive$/);
  if (agentUnarchiveMatch && request.method === "POST") {
    const runtime = ensureAgents(ctx);
    const record = await requireAgent(runtime.registry, decodeURIComponent(agentUnarchiveMatch[1] ?? ""));
    const unarchived = await runtime.registry.unarchiveAgent(record.id);
    if (!unarchived) throw new MomokaHttpError(404, "Agent not found");
    json(response, 200, { success: true, agent: agentToSnake(unarchived, await agent.sessionManager.getSession(unarchived.sessionId)) });
    return true;
  }

  // System Prompt (Role) 获取/更新
  const agentRoleMatch = url.pathname.match(/^\/api\/agents\/([^/]+)\/role$/);
  if (agentRoleMatch && request.method === "GET") {
    const runtime = ensureAgents(ctx);
    const record = await requireAgent(runtime.registry, decodeURIComponent(agentRoleMatch[1] ?? ""));
    json(response, 200, { role: record.role });
    return true;
  }
  if (agentRoleMatch && request.method === "PUT") {
    const runtime = ensureAgents(ctx);
    const record = await requireAgent(runtime.registry, decodeURIComponent(agentRoleMatch[1] ?? ""));
    const body = await readJsonBody(request) as { role?: unknown };
    const role = typeof body.role === "string" ? body.role : "";
    if (!role.trim()) {
      throw new MomokaHttpError(400, "role is required");
    }
    const updated = await runtime.registry.updateAgentRole(record.id, role);
    if (!updated) throw new MomokaHttpError(404, "Agent not found");
    json(response, 200, { success: true, agent: agentToSnake(updated, await agent.sessionManager.getSession(updated.sessionId)) });
    return true;
  }

  // Session 归档/取消归档
  const sessionArchiveMatch = url.pathname.match(/^\/api\/sessions\/([^/]+)\/archive$/);
  if (sessionArchiveMatch && request.method === "POST") {
    const runtime = ensureAgents(ctx);
    const archived = await agent.sessionManager.archiveSession(decodeURIComponent(sessionArchiveMatch[1] ?? ""));
    if (!archived) throw new MomokaHttpError(404, "Session not found");
    json(response, 200, { success: true, session: archived });
    return true;
  }
  const sessionUnarchiveMatch = url.pathname.match(/^\/api\/sessions\/([^/]+)\/unarchive$/);
  if (sessionUnarchiveMatch && request.method === "POST") {
    const runtime = ensureAgents(ctx);
    const unarchived = await agent.sessionManager.unarchiveSession(decodeURIComponent(sessionUnarchiveMatch[1] ?? ""));
    if (!unarchived) throw new MomokaHttpError(404, "Session not found");
    json(response, 200, { success: true, session: unarchived });
    return true;
  }

  // 获取指定 turn 或 turn 区间（用于会话内跳转定位）
  const turnMatch = url.pathname.match(/^\/api\/sessions\/([^/]+)\/turns\/(\d+)(?:\/(\d+))?$/);
  if (turnMatch && request.method === "GET") {
    const runtime = ensureAgents(ctx);
    const sessionId = decodeURIComponent(turnMatch[1] ?? "");
    const from = parseInt(turnMatch[2] ?? "1", 10);
    const to = turnMatch[3] ? parseInt(turnMatch[3], 10) : from;
    const content = await agent.sessionManager.readSessionTranscript(sessionId, from, to);
    json(response, 200, { sessionId, from, to, content });
    return true;
  }

  // Transcript 多格式导出（JSON/MD/TXT），内容体较大直接返回字符串，由前端下载为文件
  const sessionExportMatch = url.pathname.match(/^\/api\/sessions\/([^/]+)\/export$/);
  if (sessionExportMatch && request.method === "GET") {
    const runtime = ensureAgents(ctx);
    const sessionId = decodeURIComponent(sessionExportMatch[1] ?? "");
    const existing = await agent.sessionManager.getSession(sessionId);
    if (!existing) throw new MomokaHttpError(404, "Session not found");
    const formatParam = String(url.searchParams.get("format") ?? "md");
    const format = formatParam === "json" || formatParam === "txt" ? formatParam : "md";
    const exported = await agent.sessionManager.exportSession(sessionId, format);
    json(response, 200, exported);
    return true;
  }

  // 列表包含归档项
  if (request.method === "GET" && url.pathname === "/api/agents" && url.searchParams.get("include_archived") === "true") {
    const runtime = ensureAgents(ctx);
    const records = await runtime.registry.listAllAgents(true);
    const agents = [];
    for (const record of records) {
      agents.push(agentToSnake(record, await agent.sessionManager.getSession(record.sessionId)));
    }
    json(response, 200, { agents });
    return true;
  }
  if (request.method === "GET" && url.pathname === "/api/sessions" && url.searchParams.get("include_archived") === "true") {
    const runtime = ensureAgents(ctx);
    const sessions = await agent.sessionManager.listAllSessions(true);
    json(response, 200, { sessions });
    return true;
  }

  return false;
}

/**
 * /api/agents/:id/chat：SSE 流式，作用域锁定 Agent 绑定的 session，事件喂给状态机。
 * pending_approval 时不 complete（保持等待，等审批通过后续跑）。
 */
async function streamAgentChat(
  ctx: RouteContext,
  response: ServerResponse,
  record: AgentRecord,
  message: string,
): Promise<void> {
  const { agent, machine, workspaces, registry } = orchestrationOf(ctx);
  const startedAt = Date.now(); // 运行耗时：无论正常结束/异常/取消都记一次
  response.writeHead(200, {
    "content-type": "text/event-stream; charset=utf-8",
    "cache-control": "no-store",
    connection: "keep-alive",
    ...corsHeaders(),
  });
  const controller = new AbortController();
  const streamId = `chat-${record.id}-${Date.now()}`;
  registerChatStream(streamId, { agentId: record.id, controller, response });
  // 连接只是在线投影：agent 输出已由 agent.chat 流式写入会话日志，
  // 客户端断开/收起磁贴**不中止任务**（任务与连接解耦）。
  // 显式停止走 POST /api/agents/:id/chat/cancel（abort）或服务退出。
  // 任务结束（finally）时才从注册表移除，保证 cancel/退出仍能找到它。
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
    const hasPendingApproval = await checkHasPendingApproval(workspaces, record);
    const hasPendingQuestion = await checkHasPendingQuestion(registry, record);
    if (!hasPendingApproval && !hasPendingQuestion) {
      machine.complete(record.id);
    }
    sseData(response, { type: "done", ...chatToSnake(result) });
  } catch (error) {
    if (error instanceof Error && error.name === "AbortError") {
      // 显式停止：回 idle（agent.chat 已把流式消息标记为 stopped）
      machine.cancel(record.id);
    } else {
      machine.fail(record.id);
      sseData(response, { type: "error", error: error instanceof Error ? error.message : String(error) });
    }
  } finally {
    unregisterChatStream(streamId);
    // 记录本次运行耗时（不阻塞响应；写队列串行落盘）
    void orchestrationOf(ctx).registry.updateLastRun(record.id, Date.now() - startedAt).catch(() => undefined);
    try {
      response.end();
    } catch {
      // 响应已关闭，忽略
    }
  }
}
