import { json } from "./http-utils.js";
import type { RouteContext } from "./route-context.js";

/**
 * 索引路由（P7）：索引是可重建的副产物，所以这里只提供「看状态」与「重建」。
 *
 * - `GET  /api/index/status`  索引是否可用、库路径、已索引的记忆/消息条数
 * - `POST /api/index/rebuild` 从 JSON 事实源重建记忆索引（换库/损坏/升级后用）
 */
export async function handleIndexRoutes(
  ctx: RouteContext,
  request: import("node:http").IncomingMessage,
  response: import("node:http").ServerResponse,
  url: URL,
): Promise<boolean> {
  const index = ctx.agent.memoryStore.index;
  if (!index) return false;

  if (request.method === "GET" && url.pathname === "/api/index/status") {
    json(response, 200, { index: await index.status() });
    return true;
  }

  if (request.method === "POST" && url.pathname === "/api/index/rebuild") {
    const memories = await ctx.agent.memoryStore.rebuildIndex();
    json(response, 200, { memories, status: await index.status() });
    return true;
  }

  return false;
}
