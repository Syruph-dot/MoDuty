import type { IncomingMessage, ServerResponse } from "node:http";
import { readSessionGraph } from "../relation-graph.js";
import type { RouteContext } from "./route-context.js";
import { json } from "./http-utils.js";

/** The desktop graph and agent relations read the same SQLite projection. */
export async function handleGraphRoutes(
  ctx: RouteContext,
  request: IncomingMessage,
  response: ServerResponse,
  url: URL,
): Promise<boolean> {
  if (url.pathname !== "/api/graph/sessions" || request.method !== "GET") return false;
  try {
    const sessionManager = ctx.agent.sessionManager;
    json(response, 200, await readSessionGraph(sessionManager.sessionsDir, sessionManager));
  } catch (error) {
    json(response, 500, { error: error instanceof Error ? error.message : String(error) });
  }
  return true;
}
