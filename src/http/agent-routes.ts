import type { IncomingMessage, ServerResponse } from "node:http";

import { MomokaHttpError } from "../http-error.js";
import type { AgentRecord, StreamEvent } from "../types.js";
import { corsHeaders, json, readJsonBody, sseData } from "./http-utils.js";
import { ensureAgents, requireAgent, type RouteContext } from "./route-context.js";
import { checkHasPendingApproval, orchestrationOf } from "./agent-orchestration.js";
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
    return true;
  }

  const agentMessagesMatch = url.pathname.match(/^\/api\/agents\/([^/]+)\/messages$/);
  if (agentMessagesMatch && request.method === "GET") {
    const runtime = ensureAgents(ctx);
    const record = await requireAgent(runtime.registry, decodeURIComponent(agentMessagesMatch[1] ?? ""));
    json(response, 200, { messages: await agent.sessionManager.getMessages(record.sessionId) });
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
  const { agent, machine, workspaces } = orchestrationOf(ctx);
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
    const hasPendingApproval = await checkHasPendingApproval(workspaces, record);
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
