import type { IncomingMessage, ServerResponse } from "node:http";

import { MomokaHttpError } from "../http-error.js";
import { json, readJsonBody } from "./http-utils.js";
import { ensureAgents, type RouteContext } from "./route-context.js";
import { driveApprovalDecision, orchestrationOf } from "./agent-orchestration.js";

/**
 * 审批路由：两轨共用（桌面端审批面板 + 遗留视图的审批处理）。
 * Agent 联动（状态机 decide + 批准后续跑）委托编排层，本文件只做 HTTP 编解码。
 */
export async function handleApprovalRoutes(
  ctx: RouteContext,
  request: IncomingMessage,
  response: ServerResponse,
  url: URL,
): Promise<boolean> {
  if (request.method === "GET" && url.pathname === "/api/approvals") {
    const workspace = url.searchParams.get("work_dir") ?? "";
    json(response, 200, { approvals: await ctx.agent.listApprovals(workspace) });
    return true;
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
    const outcome = await ctx.agent.decideApproval(workspace, decodeURIComponent(approvalDecisionMatch[1] ?? ""), decision, operator);
    // Agent 联动：审批事件若绑定某 Agent 的 session，则驱动其状态机脱离 waiting_approval
    if (ctx.registry && ctx.machine && typeof outcome === "object" && outcome !== null) {
      const sessionId = (outcome as { event?: { sessionId?: string } }).event?.sessionId;
      if (typeof sessionId === "string" && sessionId) {
        await driveApprovalDecision(orchestrationOf(ctx), sessionId, decision);
      }
    }
    json(response, 200, outcome);
    return true;
  }
  return false;
}
