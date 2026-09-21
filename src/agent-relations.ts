import type { AgentRegistry } from "./agent-registry.js";
import { browserService } from "./browser-service.js";
import { normalizeSessionId, readSessionGraphEdges } from "./relation-graph.js";
import type { SessionManager } from "./session-manager.js";
import type { AgentRecord } from "./types.js";

/**
 * 窗口标签页条的数据源：某个 Agent 的「出边（下属）/ 入边（上级）」。
 *
 * 关系判定（与用户拍板一致：下属 = 出边，上级 = 入边）：
 *   - 出边（下属）：本会话消息里的 `&ses_…` 引用（最新、直接） ∪ 持久化会话图的出边
 *     ∪ 台账里「我派发过的人」（dispatcherId = 我）。浏览器子项 = 本会话消息里出现过的
 *     `brw_…`（工具调用参数里的 browser_id），再用浏览器 registry 校验是否还活着。
 *   - 入边（上级）：会话图的入边（谁引用了我） ∪ 台账里「谁派发了我」。
 *
 * 为什么三个来源要合并：会话图是增量落盘的（只有显式 `&ses_` 引用才有边，实测全库仅 4 条），
 * 台账则覆盖派发链（实测有数据）。三者并集才既有语义又当下可用；重复项按 id 去重并记来源。
 */

/** 关联对象（标签页用） */
export interface RelationRef {
  kind: "agent" | "browser";
  id: string;
  name: string;
  state: string | null;
  /** 关系来源，便于排查「这个标签为什么在这里」 */
  via: Array<"graph" | "session" | "dispatch">;
}

export interface AgentRelations {
  self: { id: string; name: string; state: string; sessionId: string };
  /** 入边：谁引用了本会话（上级）；无上级为 null */
  parent: RelationRef | null;
  /** 出边：本会话引用了谁 / 派发给了谁（下属）；Agent 在前、浏览器在后，各自按最近活动倒序 */
  children: RelationRef[];
}

const AGENT_REF = /&ses_[a-z0-9]+/gi;
const BROWSER_REF = /brw_[a-z0-9]+/gi;

const recency = (value: string | undefined): number => {
  const t = value ? Date.parse(value) : NaN;
  return Number.isFinite(t) ? t : 0;
};

export async function buildAgentRelations(options: {
  agentId: string;
  registry: AgentRegistry;
  sessionManager: SessionManager;
}): Promise<AgentRelations | null> {
  const { agentId, registry, sessionManager } = options;
  const self = await registry.getAgent(agentId);
  if (!self) return null;

  const agents = await registry.listAllAgents();
  const bySession = new Map<string, AgentRecord>();
  const byId = new Map<string, AgentRecord>();
  for (const record of agents) {
    if (record.sessionId) bySession.set(normalizeSessionId(record.sessionId), record);
    byId.set(record.id, record);
  }

  const agentChildren = new Map<string, RelationRef & { sortKey: number }>();
  const addAgentChild = (record: AgentRecord | undefined | null, via: RelationRef["via"][number]) => {
    if (!record || record.id === self.id || record.archived) return;
    const prev = agentChildren.get(record.id);
    if (prev) {
      if (!prev.via.includes(via)) prev.via.push(via);
      return;
    }
    agentChildren.set(record.id, {
      kind: "agent",
      id: record.id,
      name: record.name,
      state: record.state,
      via: [via],
      sortKey: recency(record.lastActiveAt),
    });
  };

  // ① 本会话消息里的引用（&ses_ → Agent；brw_ → 浏览器）
  const browserRefs = new Set<string>();
  try {
    const messages = await sessionManager.getMessages(self.sessionId, null);
    for (const message of messages) {
      const content = message.content ?? "";
      for (const ref of content.match(AGENT_REF) ?? []) {
        addAgentChild(bySession.get(normalizeSessionId(ref.slice(1))), "session");
      }
      for (const ref of content.match(BROWSER_REF) ?? []) browserRefs.add(ref.toLowerCase());
    }
  } catch {
    /* 会话读不到就退化为图谱 + 台账，不影响主流程 */
  }

  // ② 持久化会话图的出边/入边
  let graphParentSession: string | null = null;
  try {
    const edges = await readSessionGraphEdges(sessionManager.sessionsDir);
    for (const target of edges.out.get(normalizeSessionId(self.sessionId)) ?? []) {
      addAgentChild(bySession.get(target), "graph");
    }
    const inbound = edges.in.get(normalizeSessionId(self.sessionId)) ?? [];
    graphParentSession = inbound[0] ?? null;
  } catch {
    /* 图谱缺失/损坏：跳过 */
  }

  // ③ 台账：我派发过的人（出边） / 谁派发了我（入边）
  let ledgerParent: AgentRecord | null = null;
  try {
    const records = await registry.dispatches.listAll();
    for (const record of records) {
      if (record.dispatcherId === self.id) addAgentChild(byId.get(record.targetAgentId), "dispatch");
    }
    const inboundRecords = records
      .filter((record) => record.targetAgentId === self.id && record.dispatcherId !== self.id)
      .sort((a, b) => recency(b.dispatchedAt) - recency(a.dispatchedAt));
    const dispatcherId = inboundRecords[0]?.dispatcherId;
    if (dispatcherId) ledgerParent = byId.get(dispatcherId) ?? null;
  } catch {
    /* 台账不可用：跳过 */
  }

  // 浏览器子项：消息里出现过、且当下仍存活
  const browserChildren: Array<RelationRef & { sortKey: number }> = [];
  if (browserRefs.size > 0) {
    try {
      for (const info of await browserService.list()) {
        if (!browserRefs.has(info.id.toLowerCase())) continue;
        browserChildren.push({ kind: "browser", id: info.id, name: info.name, state: info.state, via: ["session"], sortKey: recency(info.lastActiveAt) });
      }
    } catch {
      /* 浏览器服务不可用：只返回 Agent 子项 */
    }
  }

  const sortDesc = (a: { sortKey: number }, b: { sortKey: number }) => b.sortKey - a.sortKey;
  const children: RelationRef[] = [
    ...[...agentChildren.values()].sort(sortDesc),
    ...browserChildren.sort(sortDesc),
  ].map(({ sortKey: _sortKey, ...ref }) => ref);

  // 上级：图入边优先（引用关系更贴近「上下文来源」），其次台账派发者
  const graphParent = graphParentSession ? bySession.get(graphParentSession) ?? null : null;
  const parentRecord = graphParent && graphParent.id !== self.id && !graphParent.archived ? graphParent : ledgerParent;
  const parent: RelationRef | null = parentRecord
    ? {
        kind: "agent",
        id: parentRecord.id,
        name: parentRecord.name,
        state: parentRecord.state,
        via: [graphParent && parentRecord.id === graphParent.id ? "graph" : "dispatch"],
      }
    : null;

  return {
    self: { id: self.id, name: self.name, state: self.state, sessionId: self.sessionId },
    parent,
    children,
  };
}
