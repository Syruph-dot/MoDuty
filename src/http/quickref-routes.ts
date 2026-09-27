import type { IncomingMessage, ServerResponse } from "node:http";

import { MomokaHttpError } from "../http-error.js";
import {
  QuickRefConflictError,
  QuickRefSessionNotFoundError,
  QuickRefValidationError,
  SessionQuickRefStore,
  type QuickRefActor,
  type QuickRefEntry,
  type QuickRefAudit,
} from "../session-quickrefs.js";
import { json, readJsonBody } from "./http-utils.js";
import type { RouteContext } from "./route-context.js";

function actorOf(request: IncomingMessage): QuickRefActor {
  const claimed = request.headers["x-momoka-client"];
  return { channel: claimed === "desktop" || claimed === "cli" ? claimed : "api" };
}

function refsOf(value: unknown): string[] {
  if (!Array.isArray(value) || !value.every((item) => typeof item === "string")) {
    throw new QuickRefValidationError("source_refs must be an array of strings.");
  }
  return value;
}

function entryToJson(entry: QuickRefEntry): Record<string, unknown> {
  return {
    id: entry.id,
    session_id: entry.sessionId,
    topic: entry.topic,
    content: entry.content,
    source_refs: entry.sourceRefs,
    origin: entry.origin,
    model: entry.model ?? null,
    prompt_version: entry.promptVersion ?? null,
    created_at: entry.createdAt,
    updated_at: entry.updatedAt,
    revision: entry.revision,
  };
}

function auditToJson(event: QuickRefAudit): Record<string, unknown> {
  return {
    entry_id: event.entryId,
    session_id: event.sessionId,
    action: event.action,
    channel: event.channel,
    agent_id: event.agentId ?? null,
    at: event.at,
  };
}

/** Manual quick-reference CRUD shared by desktop and CLI. Agent writes use the internal tool service. */
export async function handleQuickRefRoutes(
  ctx: RouteContext,
  request: IncomingMessage,
  response: ServerResponse,
  url: URL,
): Promise<boolean> {
  const match = url.pathname.match(/^\/api\/sessions\/([^/]+)\/quickrefs(?:\/([^/]+))?$/u);
  if (!match) return false;
  const sessionId = decodeURIComponent(match[1] ?? "");
  const entryId = match[2] ? decodeURIComponent(match[2]) : null;
  const store = new SessionQuickRefStore(ctx.agent.sessionManager);
  try {
    if (request.method === "GET" && entryId === "audit") {
      json(response, 200, { events: (await store.audit(sessionId)).map(auditToJson) });
      return true;
    }
    if (request.method === "GET" && !entryId) {
      json(response, 200, { entries: (await store.list(sessionId)).map(entryToJson) });
      return true;
    }
    if (request.method === "GET" && entryId) {
      const entry = await store.get(sessionId, entryId);
      if (!entry) throw new MomokaHttpError(404, "Unknown quick reference: " + entryId);
      json(response, 200, { entry: entryToJson(entry) });
      return true;
    }
    if (request.method === "POST" && !entryId) {
      const body = await readJsonBody(request);
      const entry = await store.create(sessionId, {
        topic: typeof body.topic === "string" ? body.topic : "",
        content: typeof body.content === "string" ? body.content : "",
        sourceRefs: body.source_refs === undefined ? [] : refsOf(body.source_refs),
        origin: "manual",
      }, actorOf(request));
      json(response, 201, { entry: entryToJson(entry) });
      return true;
    }
    if (request.method === "PATCH" && entryId) {
      const body = await readJsonBody(request);
      const entry = await store.update(sessionId, entryId, {
        expectedRevision: Number(body.expected_revision),
        ...(body.topic !== undefined ? { topic: typeof body.topic === "string" ? body.topic : "" } : {}),
        ...(body.content !== undefined ? { content: typeof body.content === "string" ? body.content : "" } : {}),
        ...(body.source_refs !== undefined ? { sourceRefs: refsOf(body.source_refs) } : {}),
      }, actorOf(request));
      if (!entry) throw new MomokaHttpError(404, "Unknown quick reference: " + entryId);
      json(response, 200, { entry: entryToJson(entry) });
      return true;
    }
    if (request.method === "DELETE" && entryId) {
      const body = await readJsonBody(request);
      const deleted = await store.delete(sessionId, entryId, Number(body.expected_revision), actorOf(request));
      if (!deleted) throw new MomokaHttpError(404, "Unknown quick reference: " + entryId);
      json(response, 200, { deleted: true });
      return true;
    }
    return false;
  } catch (error) {
    if (error instanceof QuickRefConflictError) throw new MomokaHttpError(409, error.message);
    if (error instanceof QuickRefSessionNotFoundError) throw new MomokaHttpError(404, error.message);
    if (error instanceof QuickRefValidationError) throw new MomokaHttpError(400, error.message);
    throw error;
  }
}
