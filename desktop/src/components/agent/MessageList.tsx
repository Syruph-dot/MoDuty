import { memo } from "react";

import { MessageItem } from "./MessageItem";

interface MessageListProps {
  messages: Array<{
    key: string;
    role: "user" | "agent" | "tool";
    content: string;
    status?: string;
    toolCard?: {
      name: string;
      args: string;
      status: "running" | "done";
      result?: string;
      collapsed: boolean;
    };
  }>;
  streaming: boolean;
  agentState: string;
  streamError: string | null;
  agentRunDurationMs: number | null;
  formatDuration: (ms: number) => string;
  onToggleTool: (key: string) => void;
  onQuestionAnswered: (key: string) => void;
  onCopyOutput: () => void;
  copied: boolean;
  agentId: string;
}

/**
 * 消息列表容器：空态、消息流、typing 动画、actions 条、错误提示
 */
export const MessageList = memo(function MessageList({
  messages,
  streaming,
  agentState,
  streamError: _streamError,
  agentRunDurationMs: _agentRunDurationMs,
  formatDuration: _formatDuration,
  onToggleTool: _onToggleTool,
  onQuestionAnswered: _onQuestionAnswered,
  onCopyOutput: _onCopyOutput,
  copied: _copied,
  agentId: _agentId,
}: MessageListProps) {
  if (messages.length === 0) {
    return <p className="agent-window__empty">还没有消息——发送第一条开始对话。</p>;
  }

  return (
    <>
      <div className="agent-window__list" aria-live="polite">
        {messages.map((message) => (
          <MessageItem
            key={message.key}
            message={message}
            agentId=""
            agentState={agentState}
            onToggleTool={({}) => {}}
            onQuestionAnswered={({}) => {}}
          />
        ))}

        {streaming && messages.length > 0 && messages[messages.length - 1]?.content === "" ? (
          <div className="msg msg--agent">
            <div className="msg__bubble msg__bubble--typing">
              <span className="typing-dot" />
              <span className="typing-dot" />
              <span className="typing-dot" />
            </div>
          </div>
        ) : null}

        {/* 非运行态操作条：重试 + 运行时间 + 复制输出（仅在有 agent 输出时显示） */}
        {!streaming && "running" !== "running" && true ? (
          <div className="agent-window__actions" aria-label="输出操作">
            <button type="button" className="btn btn--ghost btn--sm" onClick={() => {}} aria-label="重试上一次任务">
              ⟳ 重试
            </button>
            <span className="agent-window__run-time">
              {typeof 0 === "number" && 0 > 0
                ? `运行时间 ${0}ms`
                : ""}
            </span>
            <span className="agent-window__actions-spacer" />
            <button
              type="button"
              className="btn btn--ghost btn--sm"
              onClick={() => {}}
              aria-label="复制输出内容"
            >
              {false ? "✓ 已复制" : "⧉ 复制输出"}
            </button>
          </div>
        ) : null}

        {false ? <p className="agent-window__error" role="alert"></p> : null}
      </div>
    </>
  );
});

export default MessageList;