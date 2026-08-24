import { useEffect } from "react";

import AgentTile from "./AgentTile";
import NewAgentTile from "./NewAgentTile";
import SessionTile from "./SessionTile";
import { apiBase } from "../lib/api";
import { startAgentEventStream } from "../lib/sseClient";
import { useAgentsStore } from "../state/agentsStore";
import type { Agent } from "../types";

/**
 * 全屏磁贴墙桌面。挂载时加载 agents/sessions 并订阅实时状态 SSE；
 * 双击磁贴 → onOpen（由上层决定是否打开对话窗口，ISS-08 接线）。
 */
export default function Desktop({ onOpen }: { onOpen: (agent: Agent) => void }) {
  const agents = useAgentsStore((state) => state.agents);
  const sessions = useAgentsStore((state) => state.sessions);
  const loading = useAgentsStore((state) => state.loading);
  const error = useAgentsStore((state) => state.error);
  const load = useAgentsStore((state) => state.load);
  const applyAgentEvent = useAgentsStore((state) => state.applyAgentEvent);

  useEffect(() => {
    void load();
    const stream = startAgentEventStream(apiBase, {
      onEvent: (event) => applyAgentEvent(event),
      onPolling: () => {
        // 降级轮询：状态仍会经 applyAgentEvent 反映到磁贴
      },
    });
    return () => stream.stop();
  }, [load, applyAgentEvent]);

  return (
    <div className="tile-wall">
      <header className="tile-wall__header">
        <div>
          <h1 className="tile-wall__title">MOMOKA</h1>
          <p className="tile-wall__subtitle">Agent Desktop — 双击磁贴进入对话</p>
        </div>
        {error ? <p className="tile-wall__error" role="alert">{error}</p> : null}
      </header>

      <main className="tile-wall__main">
        <section aria-label="Agents">
          {loading && agents.length === 0 ? (
            <div className="tile-wall__hint" role="status" aria-busy="true">
              Loading agents…
            </div>
          ) : (
            <div className="tile-grid">
              {agents.map((agent) => (
                <AgentTile key={agent.id} agent={agent} onOpen={onOpen} />
              ))}
              <NewAgentTile />
            </div>
          )}
        </section>

        {sessions.length > 0 ? (
          <section className="sessions-section" aria-label="Legacy sessions">
            <h2 className="sessions-section__title">Sessions</h2>
            <div className="sessions-grid" role="list">
              {sessions.map((session) => (
                <SessionTile key={session.id} session={session} />
              ))}
            </div>
          </section>
        ) : null}
      </main>
    </div>
  );
}