import type { Agent, AgentState } from "../types";

export const STATE_LABELS: Record<AgentState, string> = {
  idle: "idle",
  running: "running",
  waiting_approval: "waiting approval",
  completed: "completed",
  error: "error",
};

export const STATE_DOT_CLASS: Record<AgentState, string> = {
  idle: "state-dot--idle",
  running: "state-dot--running",
  waiting_approval: "state-dot--waiting",
  completed: "state-dot--completed",
  error: "state-dot--error",
};

function formatActive(iso: string): string {
  if (!iso) return "—";
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return "—";
  return date.toLocaleString("zh-CN", { month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit" });
}

export default function AgentTile({ agent, onOpen }: { agent: Agent; onOpen: (agent: Agent) => void }) {
  return (
    <button
      type="button"
      className={`agent-tile agent-tile--${agent.state}`}
      onDoubleClick={() => onOpen(agent)}
      aria-label={`Agent ${agent.name}，状态 ${STATE_LABELS[agent.state]}，双击打开对话`}
      title="双击打开对话"
    >
      <div className="agent-tile__head">
        <span className={`state-dot ${STATE_DOT_CLASS[agent.state]}`} aria-hidden="true" />
        <span className="agent-tile__name">{agent.name}</span>
      </div>

      <div className="agent-tile__badge" aria-live="polite">
        <span className="agent-tile__state">{STATE_LABELS[agent.state]}</span>
        {agent.phase && agent.state === "running" ? <span className="agent-tile__phase">{agent.phase}</span> : null}
      </div>

      <div className="agent-tile__meta">
        {agent.workspace_dir ? (
          <p className="agent-tile__row" title={agent.workspace_dir}>
            <span className="agent-tile__row-label">dir</span>
            <span className="agent-tile__row-value agent-tile__row-value--truncate">{agent.workspace_dir}</span>
          </p>
        ) : null}
        {agent.session ? (
          <>
            <p className="agent-tile__row" title={agent.session.goal}>
              <span className="agent-tile__row-label">goal</span>
              <span className="agent-tile__row-value agent-tile__row-value--truncate">{agent.session.goal}</span>
            </p>
            <p className="agent-tile__row">
              <span className="agent-tile__row-label">msgs</span>
              <span className="agent-tile__row-value">{agent.session.message_count}</span>
              <span className="agent-tile__row-label agent-tile__row-label--sep">last</span>
              <span className="agent-tile__row-value">{formatActive(agent.session.last_message_at)}</span>
            </p>
          </>
        ) : null}
      </div>
    </button>
  );
}