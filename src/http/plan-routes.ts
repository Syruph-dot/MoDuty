import type { IncomingMessage, ServerResponse } from "node:http";

import type { NewPlanStepInput, PlanStatus, PlanStepStatus } from "../plan-store.js";
import { MomokaHttpError } from "../agent.js";
import { json, readJsonBody } from "./http-utils.js";
import { planToSnake } from "./serialization.js";
import type { RouteContext } from "./route-context.js";

const PLAN_STATUS_VALUES: PlanStatus[] = ["active", "done", "failed", "cancelled"];
const STEP_STATUS_VALUES: PlanStepStatus[] = ["pending", "ready", "running", "done", "failed", "skipped", "blocked"];
const ATTEMPT_STATUS_VALUES = ["done", "failed", "skipped", "blocked"] as const;

function asStringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.map((item) => String(item)) : [];
}

function parseSteps(value: unknown): NewPlanStepInput[] {
  if (!Array.isArray(value)) return [];
  const steps: NewPlanStepInput[] = [];
  for (const item of value) {
    if (typeof item !== "object" || item === null) continue;
    const raw = item as Record<string, unknown>;
    const title = String(raw.title ?? "").trim();
    if (!title) continue;
    steps.push({
      title,
      ...(raw.detail ? { detail: String(raw.detail) } : {}),
      ...(Array.isArray(raw.depends_on) ? { dependsOn: asStringArray(raw.depends_on) } : {}),
      ...(Array.isArray(raw.dependsOn) ? { dependsOn: asStringArray(raw.dependsOn) } : {}),
      ...(raw.owner_agent_id ? { ownerAgentId: String(raw.owner_agent_id) } : {}),
      ...(raw.ownerAgentId ? { ownerAgentId: String(raw.ownerAgentId) } : {}),
      ...(Array.isArray(raw.acceptance_criteria) ? { acceptanceCriteria: asStringArray(raw.acceptance_criteria) } : {}),
      ...(Array.isArray(raw.acceptanceCriteria) ? { acceptanceCriteria: asStringArray(raw.acceptanceCriteria) } : {}),
      ...(Array.isArray(raw.artifacts) ? { artifacts: asStringArray(raw.artifacts) } : {}),
      ...(raw.id ? { id: String(raw.id) } : {}),
    });
  }
  return steps;
}

/**
 * 计划路由（P1）：把「要做什么」变成可读可写的资源。
 *
 * - `GET  /api/plans`                       列表（可按 status / dispatcher_id 过滤）
 * - `POST /api/plans`                       建计划（可同时给初始步骤与依赖）
 * - `GET  /api/plans/:id`                   取单个计划（步骤带派生状态）
 * - `PATCH /api/plans/:id/steps/:stepId`    改步骤：status / 验收标准 / 产物 / 证据 / 关联派发 / 记一次尝试
 * - `GET  /api/plans/by-dispatch/:dispatchId`  由派发 id 反查计划步（台账 ↔ 计划对齐）
 */
export async function handlePlanRoutes(
  ctx: RouteContext,
  request: IncomingMessage,
  response: ServerResponse,
  url: URL,
): Promise<boolean> {
  const plans = ctx.agent.plans;

  if (request.method === "GET" && url.pathname === "/api/plans") {
    const status = url.searchParams.get("status");
    const limitRaw = Number(url.searchParams.get("limit") ?? "");
    const list = await plans.listPlans({
      ...(status && PLAN_STATUS_VALUES.includes(status as PlanStatus) ? { status: status as PlanStatus } : {}),
      ...(url.searchParams.get("dispatcher_id") ? { dispatcherId: String(url.searchParams.get("dispatcher_id")) } : {}),
      ...(Number.isFinite(limitRaw) && limitRaw > 0 ? { limit: limitRaw } : {}),
    });
    json(response, 200, { plans: list.map(planToSnake) });
    return true;
  }

  if (request.method === "POST" && url.pathname === "/api/plans") {
    const body = await readJsonBody(request);
    const goal = String(body.goal ?? "").trim();
    if (!goal) throw new MomokaHttpError(400, "goal is required");
    const plan = await plans.createPlan({
      goal,
      steps: parseSteps(body.steps),
      ...(body.dispatcher_id ? { dispatcherId: String(body.dispatcher_id) } : {}),
      ...(body.session_id ? { sessionId: String(body.session_id) } : {}),
    });
    json(response, 200, { plan: planToSnake(plan) });
    return true;
  }

  const byDispatchMatch = url.pathname.match(/^\/api\/plans\/by-dispatch\/([^/]+)$/u);
  if (byDispatchMatch && request.method === "GET") {
    const found = await plans.findByDispatch(decodeURIComponent(byDispatchMatch[1] ?? ""));
    if (!found) throw new MomokaHttpError(404, "No plan step bound to this dispatch");
    json(response, 200, { plan: planToSnake(found.plan), step_id: found.step.id });
    return true;
  }

  const stepMatch = url.pathname.match(/^\/api\/plans\/([^/]+)\/steps\/([^/]+)$/u);
  if (stepMatch && request.method === "PATCH") {
    const planId = decodeURIComponent(stepMatch[1] ?? "");
    const stepId = decodeURIComponent(stepMatch[2] ?? "");
    const body = await readJsonBody(request);

    // 记一次执行尝试（attempts+1 + 证据 + 终态）
    if (body.attempt && typeof body.attempt === "object") {
      const attempt = body.attempt as Record<string, unknown>;
      const status = String(attempt.status ?? "");
      if (!ATTEMPT_STATUS_VALUES.includes(status as (typeof ATTEMPT_STATUS_VALUES)[number])) {
        throw new MomokaHttpError(400, `attempt.status must be one of ${ATTEMPT_STATUS_VALUES.join(", ")}`);
      }
      const updated = await plans.recordAttempt(planId, stepId, {
        status: status as (typeof ATTEMPT_STATUS_VALUES)[number],
        summary: String(attempt.summary ?? ""),
        ...(Array.isArray(attempt.artifacts) ? { artifacts: asStringArray(attempt.artifacts) } : {}),
        ...(Array.isArray(attempt.source_refs) ? { sourceRefs: asStringArray(attempt.source_refs) } : {}),
        ...(attempt.error ? { error: String(attempt.error) } : {}),
      });
      if (!updated) throw new MomokaHttpError(404, "Unknown plan");
      json(response, 200, { plan: planToSnake(updated) });
      return true;
    }

    // 关联派发（台账 ↔ 计划）
    if (body.dispatch_id) {
      const updated = await plans.attachDispatch(planId, stepId, String(body.dispatch_id));
      if (!updated) throw new MomokaHttpError(404, "Unknown plan");
      json(response, 200, { plan: planToSnake(updated) });
      return true;
    }

    const status = body.status === undefined ? undefined : String(body.status);
    if (status && !STEP_STATUS_VALUES.includes(status as PlanStepStatus)) {
      throw new MomokaHttpError(400, `status must be one of ${STEP_STATUS_VALUES.join(", ")}`);
    }
    const updated = await plans.updateStep(planId, stepId, {
      ...(status ? { status: status as PlanStepStatus } : {}),
      ...(Array.isArray(body.acceptance_criteria) ? { acceptanceCriteria: asStringArray(body.acceptance_criteria) } : {}),
      ...(Array.isArray(body.artifacts) ? { artifacts: asStringArray(body.artifacts) } : {}),
      ...(body.last_error !== undefined ? { lastError: String(body.last_error) } : {}),
      ...(body.owner_agent_id !== undefined ? { ownerAgentId: String(body.owner_agent_id) } : {}),
      ...(body.evidence && typeof body.evidence === "object"
        ? {
            evidence: {
              kind: String((body.evidence as Record<string, unknown>).kind ?? "note") as "attempt" | "verification" | "note",
              summary: String((body.evidence as Record<string, unknown>).summary ?? ""),
              ...(Array.isArray((body.evidence as Record<string, unknown>).source_refs)
                ? { sourceRefs: asStringArray((body.evidence as Record<string, unknown>).source_refs) }
                : {}),
            },
          }
        : {}),
    });
    if (!updated) throw new MomokaHttpError(404, "Unknown plan");
    json(response, 200, { plan: planToSnake(updated) });
    return true;
  }

  const planMatch = url.pathname.match(/^\/api\/plans\/([^/]+)$/u);
  if (planMatch && request.method === "GET") {
    const plan = await ctx.agent.plans.getPlan(decodeURIComponent(planMatch[1] ?? ""));
    if (!plan) throw new MomokaHttpError(404, "Unknown plan");
    json(response, 200, { plan: planToSnake(plan) });
    return true;
  }

  return false;
}
