import type { IncomingMessage, ServerResponse } from "node:http";

import { MomokaHttpError } from "../http-error.js";
import { gone, json, readJsonBody } from "./http-utils.js";
import type { RouteContext } from "./route-context.js";
import { judgeToSnake, sessionToSnake } from "./serialization.js";

/**
 * 遗留 session 轨道（旧 chat.html 时代 web UI）。
 *
 * 双轨收束决策：本轨道已显式降级为「只读遗留视图」——
 * - 保留全部读接口（列表 / 详情 / 消息 / 检索 / 检视 / transcript 读取），供桌面端
 *   &-mention 候选与历史数据浏览使用；
 * - 写接口（新建 / 删除 session、旧 /api/chat 流式对话）返回 410 Gone，
 *   新对话一律走桌面端 /api/agents/:id/chat；
 * - /api/judge 属于记忆-反馈子系统（桌面端无对应功能、也不依赖 session 轨道），
 *   维持可用，可继续对历史 output 评分。
 */
export async function handleSessionRoutes(
  ctx: RouteContext,
  request: IncomingMessage,
  response: ServerResponse,
  url: URL,
): Promise<boolean> {
  const agent = ctx.agent;

  if (request.method === "GET" && url.pathname === "/api/sessions") {
    json(response, 200, { sessions: (await agent.sessionManager.listSessions()).map(sessionToSnake) });
    return true;
  }
  if (request.method === "POST" && url.pathname === "/api/sessions") {
    gone(response, "Legacy session creation is deprecated (read-only). 请使用 MOMOKA 桌面应用创建 Agent 开始新对话。");
    return true;
  }

  // ---- 会话检索 / 检视 / 读取（Session-as-a-Resource）----
  // 必须放在下方 sessionMatch 之前：否则 /api/sessions/search 会被当作 sessionId="search"，
  // /inspect、/read 会被当作普通 GET 返回 session 元数据而非其语义。
  if (request.method === "GET" && url.pathname === "/api/sessions/search") {
    const query = url.searchParams.get("q") ?? "";
    const rawLimit = Number(url.searchParams.get("limit") ?? "");
    const limit = Number.isInteger(rawLimit) && rawLimit > 0 ? Math.min(rawLimit, 50) : 20;
    json(response, 200, { hits: await agent.sessionManager.searchSessions(query, limit) });
    return true;
  }

  const sessionInspectMatch = url.pathname.match(/^\/api\/sessions\/([^/]+)\/inspect$/);
  if (sessionInspectMatch && request.method === "GET") {
    const sessionId = decodeURIComponent(sessionInspectMatch[1] ?? "");
    if (!(await agent.sessionManager.getSession(sessionId))) {
      throw new MomokaHttpError(404, `Unknown session: ${sessionId}`);
    }
    json(response, 200, { inspect: await agent.sessionManager.inspectSession(sessionId) });
    return true;
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
    return true;
  }

  const sessionMatch = url.pathname.match(/^\/api\/sessions\/([^/]+)(\/messages)?$/);
  if (sessionMatch && request.method === "GET" && sessionMatch[2] === "/messages") {
    const sessionId = decodeURIComponent(sessionMatch[1] ?? "");
    if (!(await agent.sessionManager.getSession(sessionId))) {
      throw new MomokaHttpError(404, `Unknown session: ${sessionId}`);
    }
    json(response, 200, { messages: await agent.sessionManager.getMessages(sessionId) });
    return true;
  }
  if (sessionMatch && request.method === "GET") {
    const sessionId = decodeURIComponent(sessionMatch[1] ?? "");
    const session = await agent.sessionManager.getSession(sessionId);
    if (!session) {
      throw new MomokaHttpError(404, `Unknown session: ${sessionId}`);
    }
    json(response, 200, { session: sessionToSnake(session) });
    return true;
  }
  if (sessionMatch && request.method === "DELETE") {
    gone(response, "Legacy session deletion is deprecated (read-only). 请在 MOMOKA 桌面应用中删除对应 Agent。");
    return true;
  }

  if (request.method === "POST" && url.pathname === "/api/chat") {
    gone(response, "Legacy /api/chat is deprecated (read-only). 请使用桌面端 /api/agents/:id/chat 进行对话。");
    return true;
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
    return true;
  }

  return false;
}
