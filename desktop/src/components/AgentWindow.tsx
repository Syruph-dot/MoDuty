import { useEffect, useRef, useState } from "react";

import { apiBase } from "../lib/api";
import { runChatStream } from "../lib/chatStream";
import { useAgentsStore } from "../state/agentsStore";
import type { Agent } from "../types";

interface StoredMessage {
  role: string;
  content: string;
  timestamp: string;
  toolCalls?: Array<{ tool: string; args: string; result: string }>;
}

interface DisplayMessage {
  key: string;
  role: "user" | "agent";
  content: string;
}

interface ToolCard {
  id: string;
  name: string;
  args: string;
  result?: string;
  status: "running" | "done";
}

function shortArgs(args: string): string {
  if (!args || args === "{}") return "";
  try {
    const parsed = JSON.parse(args) as Record<string, unknown>;
    return Object.entries(parsed)
      .map(([key, value]) => `${key}=${String(value).slice(0, 60)}`)
      .join(" ");
  } catch {
    return args.slice(0, 80);
  }
}

/** 覆盖式对话窗口：历史消息 + /api/agents/:id/chat SSE 流式 */
export default function AgentWindow({ agent, onClose }: { agent: Agent; onClose: () => void }) {
  const [messages, setMessages] = useState<DisplayMessage[]>([]);
  const [toolCards, setToolCards] = useState<ToolCard[]>([]);
  const [input, setInput] = useState("");
  const [streaming, setStreaming] = useState(false);
  const [streamError, setStreamError] = useState<string | null>(null);
  const abortRef = useRef<AbortController | null>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const load = useAgentsStore((state) => state.load);

  const reloadMessages = async () => {
    const res = await fetch(`${apiBase}/api/agents/${encodeURIComponent(agent.id)}/messages`);
    if (!res.ok) {
      return;
    }
    const data = (await res.json()) as { messages: StoredMessage[] };
    setMessages(
      data.messages.map((message) => ({
        key: `${message.timestamp}-${message.role}`,
        role: message.role === "user" ? "user" : "agent",
        content: message.content,
      })),
    );
  };

  useEffect(() => {
    void reloadMessages();
    return () => {
      abortRef.current?.abort();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [agent.id]);

  useEffect(() => {
    listRef.current?.scrollTo({ top: listRef.current.scrollHeight });
  }, [messages, toolCards, streaming]);

  const send = async () => {
    const text = input.trim();
    if (!text || streaming) {
      return;
    }
    setInput("");
    setStreamError(null);
    setMessages((prev) => [...prev, { key: `user-${Date.now()}`, role: "user", content: text }]);
    setStreaming(true);
    const key = `agent-${Date.now()}`;
    setMessages((prev) => [...prev, { key, role: "agent", content: "" }]);
    const controller = new AbortController();
    abortRef.current = controller;
    try {
      await runChatStream(
        apiBase,
        agent.id,
        text,
        {
          onToken: (chunk) => {
            setMessages((prev) => prev.map((message) => (message.key === key ? { ...message, content: message.content + chunk } : message)));
          },
          onToolStart: (name, args) => {
            setToolCards((prev) => [...prev, { id: `tool-${Date.now()}`, name, args, status: "running" }]);
          },
          onToolResult: (name, result) => {
            setToolCards((prev) =>
              prev.map((card) => (card.name === name && card.status === "running" ? { ...card, result, status: "done" } : card)),
            );
          },
          onApprovalRequested: () => {
            // 审批联动由 ApprovalPanel（ISS-09）处理；磁贴会经 agent_state 事件转 waiting_approval
          },
          onDone: async () => {
            await reloadMessages();
            await load();
          },
          onError: (message) => {
            setStreamError(message);
            setMessages((prev) => prev.filter((m) => !(m.role === "agent" && m.content === "")));
          },
        },
        controller.signal,
      );
    } catch (error) {
      if (!(error instanceof DOMException && error.name === "AbortError")) {
        setStreamError(error instanceof Error ? error.message : String(error));
        setMessages((prev) => prev.filter((message) => message.key !== key || message.content !== ""));
      }
    } finally {
      setStreaming(false);
    }
  };

  return (
    <div className="agent-window" role="dialog" aria-modal="true" aria-label={`Agent ${agent.name} 对话窗口`}>
      <header className="agent-window__header">
        <div className="agent-window__identity">
          <span className={`state-dot state-dot--${agent.state}`} aria-hidden="true" />
          <h2 className="agent-window__title">{agent.name}</h2>
          <span className="agent-window__state">{agent.state}{agent.phase ? ` · ${agent.phase}` : ""}</span>
        </div>
        <button type="button" className="agent-window__close" aria-label="关闭对话窗口" onClick={onClose}>
          ×
        </button>
      </header>

      <div className="agent-window__list" ref={listRef} aria-live="polite">
        {messages.length === 0 ? (
          <p className="agent-window__empty">还没有消息——发送第一条开始对话。</p>
        ) : (
          messages.map((message) => (
            <div key={message.key} className={`msg msg--${message.role}`}>
              <div className="msg__bubble">{message.content}</div>
            </div>
          ))
        )}

        {toolCards.map((card) => (
          <div key={card.id} className="tool-card">
            <div className="tool-card__head">
              <span className={`tool-card__dot tool-card__dot--${card.status}`} aria-hidden="true" />
              <span className="tool-card__name">{card.name}</span>
              <span className="tool-card__args">{shortArgs(card.args)}</span>
            </div>
            {card.result ? (
              <pre className="tool-card__result">{card.result.length > 500 ? `${card.result.slice(0, 500)}…` : card.result}</pre>
            ) : null}
          </div>
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

        {streamError ? <p className="agent-window__error" role="alert">{streamError}</p> : null}
      </div>

      <footer className="agent-window__composer">
        <input
          ref={inputRef}
          className="agent-window__input"
          value={input}
          onChange={(event) => setInput(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Enter" && !event.shiftKey) {
              event.preventDefault();
              void send();
            }
          }}
          placeholder="输入消息，Enter 发送"
          disabled={streaming}
          aria-label="消息输入"
        />
        <button type="button" className="btn btn--primary" onClick={() => void send()} disabled={streaming || !input.trim()}>
          {streaming ? "…" : "发送"}
        </button>
      </footer>
    </div>
  );
}