import { useEffect, useState } from "react";

import { awaitApiBase } from "../lib/api";

/**
 * 窗口标签页条的数据源：`GET /api/agents/:id/relations`（后端 src/agent-relations.ts）。
 *
 * 出边 = 下属（引用过的人 + 派发过的人 + 浏览器），入边 = 上级。
 * refreshKey 变化时重取——传 agent 列表长度即可覆盖「新派发/新建 Agent 后标签变了」。
 */

export interface RelationRef {
  kind: "agent" | "browser";
  id: string;
  name: string;
  state: string | null;
  /** 关系来源：graph（会话图）/ session（本会话引用）/ dispatch（派发台账） */
  via: string[];
}

export interface AgentRelations {
  self: { id: string; name: string; state: string; sessionId: string };
  parent: RelationRef | null;
  children: RelationRef[];
}

export function useAgentRelations(
  agentId: string | null,
  refreshKey: unknown = null,
): { relations: AgentRelations | null; error: string | null } {
  const [relations, setRelations] = useState<AgentRelations | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!agentId) {
      setRelations(null);
      return;
    }
    let alive = true;
    void (async () => {
      try {
        const base = await awaitApiBase();
        const res = await fetch(`${base}/api/agents/${encodeURIComponent(agentId)}/relations`);
        if (!res.ok) throw new Error(`关系读取失败: ${res.status}`);
        const data = (await res.json()) as { relations?: AgentRelations };
        if (!alive) return;
        setRelations(data.relations ?? null);
        setError(null);
      } catch (err) {
        if (!alive) return;
        setError(err instanceof Error ? err.message : String(err));
      }
    })();
    return () => {
      alive = false;
    };
  }, [agentId, refreshKey]);

  return { relations, error };
}
