import type { IncomingMessage, ServerResponse } from "node:http";
import type { RouteContext } from "./route-context.js";
import { json, corsHeaders } from "./http-utils.js";

/**
 * 会话关系图谱路由：
 * - GET /api/graph/sessions -> 返回 { nodes: [...], links: [...] }
 *   仅包含 ampersand (&) 引用关系的有向图
 */
export async function handleGraphRoutes(
  ctx: RouteContext,
  request: IncomingMessage,
  response: ServerResponse,
  url: URL,
): Promise<boolean> {
  if (!url.pathname.startsWith("/api/graph/")) return false;

  const sessionManager = ctx.agent.sessionManager;

  // GET /api/graph/sessions
  if (url.pathname === "/api/graph/sessions" && request.method === "GET") {
    try {
      const graphData = await buildSessionGraph(sessionManager);
      json(response, 200, graphData);
    } catch (error) {
      json(response, 500, { error: error instanceof Error ? error.message : String(error) });
    }
    return true;
  }

  return false;
}

interface GraphNode {
  id: string;
  name: string;
  goal: string;
  type: "agent" | "session";
  updatedAt: string;
}

interface GraphLink {
  source: string;
  target: string;
  type: "references";
}

interface GraphData {
  nodes: GraphNode[];
  links: GraphLink[];
}

/**
 * 构建会话关系图（仅 ampersand 引用）
 * 遍历所有会话的 transcript.md，提取 &ses_xxx 引用，建立有向边
 */
async function buildSessionGraph(sessionManager: {
  listSessions: () => Promise<Array<{
    id: string;
    name: string;
    goal: string;
    createdAt: string;
    lastMessageAt: string;
    folderPath: string;
  }>>;
  getMessages: (id: string, limit: number | null) => Promise<Array<{ role: string; content: string; timestamp: string }>>;
}): Promise<GraphData> {
  const sessions = await sessionManager.listSessions();
  const nodes: GraphNode[] = [];
  const linkSet = new Set<string>(); // 去重用：source->target
  const links: GraphLink[] = [];

  // 正则匹配 &ses_xxx 或 &tile_xxx
  const ampRefRegex = /&(ses_[a-z0-9]+|tile_[a-z0-9]+)/gi;

  for (const session of sessions) {
    // 添加节点
    nodes.push({
      id: session.id,
      name: session.name,
      goal: session.goal,
      type: "session",
      updatedAt: session.lastMessageAt,
    });

    // 读取该会话的所有消息，提取 ampersand 引用
    const messages = await sessionManager.getMessages(session.id, null);
    const referencedIds = new Set<string>();

    for (const msg of messages) {
      const content = msg.content ?? "";
      let match;
      while ((match = ampRefRegex.exec(content)) !== null) {
        const ref = match[1]; // ses_xxx 或 tile_xxx
        if (ref.startsWith("ses_")) {
          referencedIds.add(ref.slice(4)); // 去掉 "ses_" 前缀
        } else if (ref.startsWith("tile_")) {
          // tile_ 引用需要通过 agentRegistry 解析为 sessionId
          // 这里暂时跳过，或记录为特殊类型
          referencedIds.add(`tile:${ref.slice(5)}`);
        }
      }
    }

    // 为每个引用创建有向边：当前会话 -> 被引用会话
    for (const targetId of referencedIds) {
      // 只创建指向已存在会话的边
      const targetExists = sessions.some((s) => s.id === targetId);
      if (targetExists) {
        const key = `${session.id}->${targetId}`;
        if (!linkSet.has(key)) {
          linkSet.add(key);
          links.push({ source: session.id, target: targetId, type: "references" });
        }
      }
    }
  }

  // 也添加 Agent 作为节点（如果有 agentRegistry 可用）
  // 这里简化：只返回会话节点

  return { nodes, links };
}