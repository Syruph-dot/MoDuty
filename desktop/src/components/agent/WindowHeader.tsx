import type { Agent } from "../../types";

interface WindowHeaderProps {
  agent: Agent;
  onClose: () => void;
}

/** 窗口头部：state dot + 标题 + 关闭按钮（标题栏可拖拽，点击关闭不触发拖拽） */
export default function WindowHeader({ agent, onClose }: WindowHeaderProps) {
  return (
    <header className="agent-window__header" title="拖动标题栏到左栏可收起">
      <div className="agent-window__identity">
        <span className={`state-dot state-dot--${agent.state}`} aria-hidden="true" />
        <h2 className="agent-window__title">{agent.name}</h2>
        <span className="agent-window__state">{agent.state}{agent.phase ? ` · ${agent.phase}` : ""}</span>
      </div>
      <button
        type="button"
        className="agent-window__close"
        aria-label="关闭对话窗口"
        onClick={onClose}
        onMouseDown={(event) => event.stopPropagation()}
      >
        ×
      </button>
    </header>
  );
}