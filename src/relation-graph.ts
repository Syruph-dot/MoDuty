import { readFile, writeFile, mkdir } from "node:fs/promises";
import path from "node:path";

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

const GRAPH_FILE = "memory/.session-graph.json";

/**
 * 获取图谱文件路径
 */
function getGraphFilePath(sessionsDir: string): string {
  return path.join(sessionsDir, "..", ".session-graph.json");
}

/**
 * 读取现有图谱（不存在则返回空）
 */
async function readExistingGraph(sessionsDir: string): Promise<GraphData> {
  const filePath = getGraphFilePath(sessionsDir);
  try {
    const content = await readFile(filePath, "utf8");
    return JSON.parse(content) as GraphData;
  } catch {
    return { nodes: [], links: [] };
  }
}

/**
 * 写入图谱（原子写入）
 */
async function writeGraph(sessionsDir: string, graph: GraphData): Promise<void> {
  const filePath = getGraphFilePath(sessionsDir);
  await mkdir(path.dirname(filePath), { recursive: true });
  await writeFile(filePath, JSON.stringify(graph, null, 2), "utf8");
}

/**
 * 从会话消息中提取 ampersand 引用
 */
export function extractAmpersandRefs(content: string): Set<string> {
  const refs = new Set<string>();
  const ampRefRegex = /&(ses_[a-z0-9]+|tile_[a-z0-9]+)/gi;
  let match;
  while ((match = ampRefRegex.exec(content)) !== null) {
    const ref = match[1];
    if (ref.startsWith("ses_")) {
      refs.add(ref.slice(4));
    }
    // tile_ 引用暂不处理（需 agentRegistry 解析）
  }
  return refs;
}

/**
 * 增量刷新会话关系图
 * - 只更新指定 sessionId 的节点信息和其出边
 * - 入边由其他会话的刷新时更新（或定期全量重建）
 * - 复杂度：O(该会话消息数)，不遍历全量会话
 */
export async function refreshSessionGraph(
  sessionsDir: string,
  sessionId: string,
  sessionManager?: {
    getSession: (id: string) => Promise<{ id: string; name: string; goal: string; lastMessageAt: string } | null>;
    getMessages: (id: string, limit: number | null) => Promise<Array<{ role: string; content: string; timestamp: string }>>;
  }
): Promise<void> {
  // 如果没有 sessionManager，无法获取最新消息，跳过增量更新
  if (!sessionManager) return;

  const session = await sessionManager.getSession(sessionId);
  if (!session) return;

  // 读取现有图谱
  const graph = await readExistingGraph(sessionsDir);

  // 更新/添加节点
  const nodeIndex = graph.nodes.findIndex((n) => n.id === sessionId);
  const nodeData: GraphNode = {
    id: sessionId,
    name: session.name,
    goal: session.goal,
    type: "session",
    updatedAt: session.lastMessageAt,
  };

  if (nodeIndex >= 0) {
    graph.nodes[nodeIndex] = nodeData;
  } else {
    graph.nodes.push(nodeData);
  }

  // 提取该会话最新的 ampersand 引用（读取所有消息）
  const messages = await sessionManager.getMessages(sessionId, null);
  const referencedIds = new Set<string>();
  for (const msg of messages) {
    const refs = extractAmpersandRefs(msg.content ?? "");
    for (const ref of refs) referencedIds.add(ref);
  }

  // 移除该会话作为 source 的旧边
  graph.links = graph.links.filter((l) => l.source !== sessionId);

  // 添加新的出边
  for (const targetId of referencedIds) {
    // 只创建指向已存在会话的边（目标会话可能还没在图中，但不阻塞）
    graph.links.push({ source: sessionId, target: targetId, type: "references" });
  }

  // 去重边
  const linkSet = new Set<string>();
  graph.links = graph.links.filter((l) => {
    const key = `${l.source}->${l.target}`;
    if (linkSet.has(key)) return false;
    linkSet.add(key);
    return true;
  });

  // 写回
  await writeGraph(sessionsDir, graph);
}

/**
 * 全量重建图谱（用于定期修正、启动时初始化）
 * 遍历所有会话，构建完整图谱
 */
export async function rebuildSessionGraph(
  sessionsDir: string,
  sessionManager: {
    listSessions: () => Promise<Array<{ id: string; name: string; goal: string; lastMessageAt: string }>>;
    getMessages: (id: string, limit: number | null) => Promise<Array<{ role: string; content: string; timestamp: string }>>;
  }
): Promise<void> {
  const sessions = await sessionManager.listSessions();
  const nodes: GraphNode[] = [];
  const linkSet = new Set<string>();
  const links: GraphLink[] = [];

  for (const session of sessions) {
    nodes.push({
      id: session.id,
      name: session.name,
      goal: session.goal,
      type: "session",
      updatedAt: session.lastMessageAt,
    });

    const messages = await sessionManager.getMessages(session.id, null);
    const referencedIds = new Set<string>();
    for (const msg of messages) {
      const refs = extractAmpersandRefs(msg.content ?? "");
      for (const ref of refs) referencedIds.add(ref);
    }

    for (const targetId of referencedIds) {
      const key = `${session.id}->${targetId}`;
      if (!linkSet.has(key)) {
        linkSet.add(key);
        links.push({ source: session.id, target: targetId, type: "references" });
      }
    }
  }

  await writeGraph(sessionsDir, { nodes, links });
}