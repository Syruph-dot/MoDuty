import { useEffect, useRef, useState } from "react";

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

interface AgentTileProps {
  agent: Agent;
  onOpen: (agent: Agent) => void;
  /** 内联重命名模式：名字区域变为白底黑框可编辑输入框（资源管理器风格，由右键菜单触发） */
  renaming?: boolean;
  /** 提交（Enter / 保存）；传入的名字已去空格 */
  onRenameCommit?: (name: string) => void;
  /** 取消（Esc） */
  onRenameCancel?: () => void;
}

export default function AgentTile({ agent, onOpen, renaming = false, onRenameCommit, onRenameCancel }: AgentTileProps) {
  const [draft, setDraft] = useState(agent.name);
  const inputRef = useRef<HTMLInputElement>(null);
  // Enter 提交成功后输入框会因关闭而卸载并触发 blur；压制紧接着的那次 blur，避免重复提交
  const suppressBlurRef = useRef(false);

  // 进入重命名模式：同步当前名字、聚焦并全选（资源管理器 F2 行为）
  useEffect(() => {
    if (renaming) {
      setDraft(agent.name);
      const timer = window.setTimeout(() => {
        inputRef.current?.focus();
        inputRef.current?.select();
      }, 0);
      return () => window.clearTimeout(timer);
    }
    return undefined;
  }, [renaming, agent.name]);

  const commit = () => {
    const trimmed = draft.trim();
    if (!trimmed) {
      onRenameCancel?.();
      return;
    }
    onRenameCommit?.(trimmed);
  };

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
        {renaming ? (
          <input
            ref={inputRef}
            className="agent-tile__rename-input"
            value={draft}
            aria-label="重命名 Agent"
            onChange={(event) => setDraft(event.target.value)}
            // 阻止冒泡，避免点击输入框时触发磁贴拖拽
            onMouseDown={(event) => event.stopPropagation()}
            onKeyDown={(event) => {
              if (event.key === "Enter") {
                event.preventDefault();
                commit();
                // 提交后输入框多半会因关闭而卸载并触发 blur，压制该次 blur
                suppressBlurRef.current = true;
              } else if (event.key === "Escape") {
                event.preventDefault();
                onRenameCancel?.();
              }
            }}
            onBlur={() => {
              // 失焦保存（资源管理器行为）；若刚由 Enter 提交则跳过这次 blur
              if (suppressBlurRef.current) {
                suppressBlurRef.current = false;
                return;
              }
              commit();
            }}
          />
        ) : (
          <span className="agent-tile__name">{agent.name}</span>
        )}
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