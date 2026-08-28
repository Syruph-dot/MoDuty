import { useEffect, useMemo, useRef, useState } from "react";

import { awaitApiBase } from "../lib/api";
import { runChatStream } from "../lib/chatStream";
import { useAgentsStore } from "../state/agentsStore";
import type { Agent } from "../types";

interface StoredMessage {
  role: string;
  content: string;
  timestamp: string;
  toolCalls?: Array<{ tool: string; args: string; result: string }>;
}

/** GET /api/sessions 返回的会话候选（& 提及弹窗数据源） */
interface SessionCandidate {
  id: string;
  name: string;
  goal: string;
  created_at: string;
  message_count: number;
  last_message_at: string;
}

/** & 提及状态：active 时吞噬导航键，Enter/Tab 选中后回插 &ses_<id> */
interface Mention {
  active: boolean;
  query: string; // & 之后、光标之前的过滤串
  start: number; // & 在 value 中的起始下标
  index: number; // 高亮项游标
}

interface DisplayMessage {
  key: string;
  role: "user" | "agent" | "tool";
  content: string;
  toolCard?: {
    name: string;
    args: string;
    status: "running" | "done";
    result?: string;
    collapsed: boolean;
  };
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

/** 嵌入分屏窗口：作为展开磁贴内容（由 TileShell 定位），header 可拖拽，× 或拖到左坞收起 */
export default function AgentWindow({ agent, onClose }: { agent: Agent; onClose: () => void }) {
  const [messages, setMessages] = useState<DisplayMessage[]>([]);
  const [streamError, setStreamError] = useState<string | null>(null);
  const [input, setInput] = useState("");
  const [streaming, setStreaming] = useState(false);
  const abortRef = useRef<AbortController | null>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const mirrorRef = useRef<HTMLSpanElement>(null);
  const [sessions, setSessions] = useState<SessionCandidate[]>([]);
  const [mention, setMention] = useState<Mention | null>(null);
  const [mentionX, setMentionX] = useState(0);
  const load = useAgentsStore((state) => state.load);

  const reloadMessages = async () => {
    const base = await awaitApiBase();
    const res = await fetch(`${base}/api/agents/${encodeURIComponent(agent.id)}/messages`);
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
    // 组件卸载时不再 abort 后端 chat 流（避免从展开态切回磁贴态时中止正在进行的任务）
    return undefined;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [agent.id]);

  // & 提及候选：GET /api/sessions（已存在，零后端新依赖）；排除当前 agent 自己的会话
  useEffect(() => {
    let alive = true;
    void (async () => {
      try {
        const base = await awaitApiBase();
        const res = await fetch(`${base}/api/sessions`);
        if (!res.ok) return;
        const data = (await res.json()) as { sessions?: SessionCandidate[] };
        if (alive) setSessions(data.sessions ?? []);
      } catch {
        // 候选不可用时静默降级：& 不弹窗，其余功能不受影响
      }
    })();
    return () => {
      alive = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [agent.id]);

  // 过滤候选：空 query 取最近 20 条（索引便宜）；带 query 才按 name/goal 过滤
  const candidates = useMemo(() => {
    if (!mention?.active || sessions.length === 0) return [];
    const base = sessions.filter((session) => session.id !== agent.session_id);
    if (!mention.query.trim()) return base.slice(0, 20);
    const needle = mention.query.toLowerCase();
    return base
      .filter((session) => `${session.name} ${session.goal ?? ""}`.toLowerCase().includes(needle))
      .slice(0, 20);
  }, [sessions, mention, agent.session_id]);

  /** 离屏 mirror 测 caret X：与 input 同字体/同字号，偏移量 = mirror 宽度 + input padding-left(14px) */
  const measureCaretX = (text: string): number => {
    const el = mirrorRef.current;
    if (!el) return 0;
    el.textContent = text;
    return el.offsetWidth + 14;
  };

  const onChange = (event: React.ChangeEvent<HTMLInputElement>) => {
    const value = event.target.value;
    setInput(value);
    const caret = event.target.selectionStart ?? value.length;
    const match = value.slice(0, caret).match(/&(\S*)$/);
    if (match) {
      setMention({ active: true, query: match[1] ?? "", start: caret - match[0].length, index: 0 });
      setMentionX(measureCaretX(value.slice(0, caret)));
    } else {
      setMention(null);
    }
  };

  /** 选中候选：把 value[start..caret] 替换为机器句柄 &ses_<id>，光标后置 */
  const applyMention = (sessionId: string) => {
    if (!mention) return;
    const value = input;
    const caret = inputRef.current?.selectionStart ?? value.length;
    setInput(`${value.slice(0, mention.start)}&ses_${sessionId} ${value.slice(caret)}`);
    setMention(null);
    inputRef.current?.focus();
  };

  const onKeyDown = (event: React.KeyboardEvent<HTMLInputElement>) => {
    if (mention?.active && candidates.length > 0) {
      const last = candidates.length - 1;
      if (event.key === "ArrowDown") {
        event.preventDefault();
        setMention((prev) => (prev ? { ...prev, index: prev.index >= last ? 0 : prev.index + 1 } : prev));
        return;
      }
      if (event.key === "ArrowUp") {
        event.preventDefault();
        setMention((prev) => (prev ? { ...prev, index: prev.index <= 0 ? last : prev.index - 1 } : prev));
        return;
      }
      if (event.key === "Enter" || event.key === "Tab") {
        event.preventDefault();
        const hit = candidates[mention.index];
        if (hit) applyMention(hit.id);
        return;
      }
      if (event.key === "Escape") {
        event.preventDefault();
        setMention(null);
        return;
      }
      return; // mention 活跃时其余键不发送
    }
    if (event.key === "Enter" && !event.shiftKey) {
      event.preventDefault();
      void send();
    }
  };

  useEffect(() => {
    listRef.current?.scrollTo({ top: listRef.current.scrollHeight });
  }, [messages, streaming]);

  // 切换 tool card 折叠/展开
  const toggleToolCollapsed = (key: string) => {
    setMessages((prev) =>
      prev.map((m) =>
        m.key === key && m.toolCard ? { ...m, toolCard: { ...m.toolCard, collapsed: !m.toolCard.collapsed } } : m,
      ),
    );
  };

  // tool result 到达后 3 秒自动折叠
  const collapseAfterDelay = (key: string) => {
    setTimeout(() => {
      setMessages((prev) =>
        prev.map((m) =>
          m.key === key && m.toolCard ? { ...m, toolCard: { ...m.toolCard, collapsed: true } } : m,
        ),
      );
    }, 3000);
  };

  const send = async () => {
    const text = input.trim();
    if (!text || streaming) {
      return;
    }
    setInput("");
    setStreamError(null);
    setMessages((prev) => [...prev, { key: `user-${Date.now()}`, role: "user", content: text }]);
    setStreaming(true);
    const controller = new AbortController();
    abortRef.current = controller;
    let currentAgentKey = `agent-${Date.now()}`;
    setMessages((prev) => [...prev, { key: currentAgentKey, role: "agent", content: "" }]);
    try {
      const base = await awaitApiBase();
      await runChatStream(
        base,
        agent.id,
        text,
        {
          onToken: (chunk) => {
            setMessages((prev) => prev.map((m) => (m.key === currentAgentKey ? { ...m, content: m.content + chunk } : m)));
          },
          onToolStart: (name, args) => {
            // 先结束当前 agent 消息（如果只有空 content 则删掉）
            setMessages((prev) => {
              const cleaned = prev.filter((m) => !(m.key === currentAgentKey && m.role === "agent" && m.content === ""));
              return [
                ...cleaned,
                {
                  key: `tool-${Date.now()}-${Math.random().toString(36).slice(2, 8)}-${name}`,
                  role: "tool" as const,
                  content: "",
                  toolCard: { name, args, status: "running" as const, collapsed: false },
                },
              ];
            });
            // 开始新的 agent 消息（用于 tool call 后的 token）
            currentAgentKey = `agent-${Date.now()}-${Math.random().toString(36).slice(2, 8)}-${name}`;
            setMessages((prev) => [...prev, { key: currentAgentKey, role: "agent", content: "" }]);
          },
          onToolResult: (name, result) => {
            setMessages((prev) => {
              let found = false;
              const next = prev.map((m) => {
                if (!found && m.toolCard && m.toolCard.name === name && m.toolCard.status === "running") {
                  found = true;
                  collapseAfterDelay(m.key);
                  return { ...m, toolCard: { ...m.toolCard, result, status: "done" as const, collapsed: false } };
                }
                return m;
              });
              return next;
            });
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
        setMessages((prev) => prev.filter((message) => message.key !== currentAgentKey || message.content !== ""));
      }
    } finally {
      setStreaming(false);
    }
  };

  return (
    <div className="agent-window" role="dialog" aria-label={`Agent ${agent.name} 对话窗口`}>
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

      <div className="agent-window__list" ref={listRef} aria-live="polite">
        {messages.length === 0 ? (
          <p className="agent-window__empty">还没有消息——发送第一条开始对话。</p>
        ) : (
          messages.map((message) => {
            // 跳过 tool call 之间创建的空 agent 消息（占位用，不应渲染）
            if (message.role === "agent" && message.content === "") {
              return null;
            }
            if (message.role === "tool" && message.toolCard) {
              const tc = message.toolCard;
              return (
                <div
                  key={message.key}
                  className={`tool-card${tc.collapsed ? " tool-card--collapsed" : ""}`}
                  onClick={() => toggleToolCollapsed(message.key)}
                  role="button"
                  tabIndex={0}
                  onKeyDown={(e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); toggleToolCollapsed(message.key); } }}
                >
                  <div className="tool-card__head">
                    <span className={`tool-card__dot tool-card__dot--${tc.status}`} aria-hidden="true" />
                    <span className="tool-card__name">{tc.name}</span>
                    <span className="tool-card__args">{shortArgs(tc.args)}</span>
                    <span className="tool-card__toggle" aria-hidden="true">{tc.collapsed ? "▶" : "▼"}</span>
                  </div>
                  <div className="tool-card__body">
                    {tc.result ? (
                      <pre className="tool-card__result">{tc.result.length > 500 ? `${tc.result.slice(0, 500)}…` : tc.result}</pre>
                    ) : null}
                  </div>
                </div>
              );
            }
            return (
              <div key={message.key} className={`msg msg--${message.role}`}>
                <div className="msg__bubble">{message.content}</div>
              </div>
            );
          })
        )}

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
        <span ref={mirrorRef} className="mention-popup__mirror" aria-hidden="true" />
        {mention?.active && candidates.length > 0 ? (
          <ul className="mention-popup" style={{ left: Math.min(mentionX, 380) }} role="listbox" aria-label="引用会话">
            {candidates.map((candidate, index) => (
              <li
                key={candidate.id}
                className={`mention-popup__item${index === mention.index ? " mention-popup__item--active" : ""}`}
                onMouseDown={(event) => {
                  event.preventDefault();
                  applyMention(candidate.id);
                }}
                role="option"
                aria-selected={index === mention.index}
              >
                <span className="mention-popup__name">{candidate.name}</span>
                <span className="mention-popup__meta">
                  {candidate.goal ? candidate.goal.slice(0, 44) : `${candidate.message_count} 条消息`}
                </span>
              </li>
            ))}
          </ul>
        ) : null}
        <input
          ref={inputRef}
          className="agent-window__input"
          value={input}
          onChange={onChange}
          onKeyDown={onKeyDown}
          placeholder="输入消息，Enter 发送；输入 & 可引用历史会话"
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