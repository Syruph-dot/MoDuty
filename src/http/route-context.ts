import type { IncomingMessage, ServerResponse } from "node:http";
import type { URL } from "node:url";

import { MomokaAgentCore, MomokaHttpError } from "../agent.js";
import type { AgentRegistry } from "../agent-registry.js";
import type { AgentStateMachine } from "../agent-state.js";
import type { WorkspaceManager } from "../workspace-manager.js";
import type { AgentRecord } from "../types.js";
import { AgentEventBroadcaster } from "./sse.js";

/**
 * 每个路由模块共享的请求上下文。
 * 路由模块签名统一为 handle*(ctx, request, response, url): Promise<boolean>，
 * 返回 false 表示未命中、交给下一个模块。
 */
export interface RouteContext {
  agent: MomokaAgentCore;
  /** 多 Agent 注册表；缺省时 /api/agents 系列返回 503 */
  registry?: AgentRegistry;
  /** 生命周期状态机；缺省时 /api/agents 系列返回 503 */
  machine?: AgentStateMachine;
  /** /api/agents/events 的 SSE 客户端池 */
  broadcaster: AgentEventBroadcaster;
  /** workspace 资源管理（审批存储等） */
  workspaces: WorkspaceManager;
}

/** agents 系列路由的前置条件：registry + machine 必须已装配，否则 503 */
export function ensureAgents(ctx: RouteContext): { registry: AgentRegistry; machine: AgentStateMachine } {
  if (!ctx.registry || !ctx.machine) {
    throw new MomokaHttpError(503, "Agent registry not configured");
  }
  return { registry: ctx.registry, machine: ctx.machine };
}

export async function requireAgent(registry: AgentRegistry, agentId: string): Promise<AgentRecord> {
  const record = await registry.getAgent(agentId);
  if (!record) {
    throw new MomokaHttpError(404, `Unknown agent: ${agentId}`);
  }
  return record;
}

/** 路由模块的统一形状 */
export type RouteHandler = (
  ctx: RouteContext,
  request: IncomingMessage,
  response: ServerResponse,
  url: URL,
) => Promise<boolean>;
