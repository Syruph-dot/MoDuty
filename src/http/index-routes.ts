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
    // 消息索引的生产者：从会话库按会话重建（增量写入留待后续，这里保证索引能被一次性填满）
    const messages = await rebuildMessageIndex(ctx);
    json(response, 200, { memories, messages, status: await index.status() });
    return true;
  }

  return false;
}

/** 把最近若干会话的消息写入索引（超出上限的会话不建，避免一次重建卡住） */
async function rebuildMessageIndex(ctx: RouteContext): Promise<{ sessions: number; written: number }> {
  const index = ctx.agent.memoryStore.index;
  if (!index) return { sessions: 0, written: 0 };
  const MAX_SESSIONS = 50;
  const MAX_MESSAGES_PER_SESSION = 400;
  let sessions = 0;
  let written = 0;
  try {
    const all = await ctx.agent.sessionManager.listSessions();
    const recent = [...all].sort((a, b) => String(b.lastMessageAt ?? "").localeCompare(String(a.lastMessageAt ?? ""))).slice(0, MAX_SESSIONS);
    for (const session of recent) {
      const messages = await ctx.agent.sessionManager.getMessages(session.id, MAX_MESSAGES_PER_SESSION);
      if (messages.length === 0) continue;
      sessions += 1;
      written += await index.upsertMessages(messages.map((message, position) => ({
        id: `${session.id}:${message.id ?? position}`,
        sessionId: session.id,
        role: message.role,
        content: message.content,
        createdAt: message.timestamp,
      })));
    }
  } catch {
    // 索引重建失败不影响主流程
  }
  return { sessions, written };
}
