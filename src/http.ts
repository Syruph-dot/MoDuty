import type { IncomingMessage, ServerResponse } from "node:http";

import { MomokaAgentCore } from "./agent.js";
import type { AgentRegistry } from "./agent-registry.js";
import type { AgentStateMachine } from "./agent-state.js";
import { WorkspaceManager } from "./workspace-manager.js";
import { MomokaHttpError } from "./http-error.js";
import type { MomokaHttpHandler } from "./types.js";
import { AgentEventBroadcaster } from "./http/sse.js";
import { corsHeaders, json } from "./http/http-utils.js";
import type { RouteContext } from "./http/route-context.js";
import { orchestrationOf, wireAgentStatePersistence } from "./http/agent-orchestration.js";
import { handleSettingsRoutes } from "./http/settings-routes.js";
import { handleSessionRoutes } from "./http/session-routes.js";
import { handleAgentRoutes } from "./http/agent-routes.js";
import { handleApprovalRoutes } from "./http/approval-routes.js";
import { handleBrowserRoutes } from "./http/browser-routes.js";
import { serveStatic } from "./http/static-routes.js";

export interface AgentHttpOptions {
  /** 多 Agent 注册表；缺省时 /api/agents 系列返回 503 */
  registry?: AgentRegistry;
  /** 生命周期状态机；缺省时 /api/agents 系列返回 503 */
  machine?: AgentStateMachine;
  /** workspace 资源管理器；缺省时新建（与 agent 核心共享同一实例更佳） */
  workspaces?: WorkspaceManager;
}

/**
 * MOMOKA HTTP 入口：装配 RouteContext 并按模块顺序分发请求。
 *
 * 路由实现按轨道拆分（http/ 目录），本文件只做：
 * 1. 装配（broadcaster / workspaces / 状态机订阅编排）；
 * 2. 分发顺序：settings → session（遗留只读）→ agent → approval → static → 404；
 * 3. 统一错误转 HTTP（MomokaHttpError → 状态码，其余 → 500）。
 *
 * 新增路由请进对应模块，不要往这里堆 handler——防止重蹈巨型路由文件。
 */
export function createMomokaHttpHandler(agent: MomokaAgentCore, options: AgentHttpOptions = {}): MomokaHttpHandler {
  const broadcaster = new AgentEventBroadcaster();
  const ctx: RouteContext = {
    agent,
    registry: options.registry,
    machine: options.machine,
    broadcaster,
    workspaces: options.workspaces ?? new WorkspaceManager(),
  };
  if (ctx.registry && ctx.machine) {
    // 全局编排：任何状态/phase 转移 → 持久化注册表 + 广播给 /api/agents/events 的客户端
    wireAgentStatePersistence(orchestrationOf(ctx));
  }
  return (request: IncomingMessage, response: ServerResponse) => {
    void dispatch(ctx, request, response);
  };
}

async function dispatch(ctx: RouteContext, request: IncomingMessage, response: ServerResponse): Promise<void> {
  try {
    const url = new URL(request.url ?? "/", "http://localhost");

    // CORS 预检（JSON body / 自定义头）直接放行
    if (request.method === "OPTIONS") {
      response.writeHead(204, corsHeaders());
      response.end();
      return;
    }

    if (await handleSettingsRoutes(ctx, request, response, url)) return;
    if (await handleSessionRoutes(ctx, request, response, url)) return;
    if (await handleAgentRoutes(ctx, request, response, url)) return;
    if (await handleApprovalRoutes(ctx, request, response, url)) return;
    if (await handleBrowserRoutes(ctx, request, response, url)) return;
    if ((request.method === "GET" || request.method === "HEAD") && await serveStatic(ctx.agent.projectRoot, url.pathname, response, request.method === "HEAD")) {
      return;
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
