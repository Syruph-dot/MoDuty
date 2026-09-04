import { memo, useCallback, useEffect, useMemo, useRef, useState } from "react";

import { awaitApiBase, cancelAgentChat, resetAgentChat } from "../lib/api";
import { runChatStream } from "../lib/chatStream";
import { renderMarkdown } from "../lib/markdown";
import { buildMessageSequence } from "../lib/sessionMessages";
import { useAgentsStore } from "../state/agentsStore";
import type { Agent } from "../types";

interface StoredMessage {
  role: string;
  content: string;
  timestamp: string;
  /** 流式消息状态：streaming / done / stopped / error（缺省 = 已完成的旧消息） */
  status?: string;
  /** 落盘工具调用（snake: tool_calls；兼容 camel: toolCalls） */
  toolCalls?: Array<{ tool: string; args: string; result: string }>;
  tool_calls?: Array<{ tool: string; args: string; result: string }>;
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
  status?: string;
  toolCard?: {
    name: string;
    args: string;
    status: "running" | "done";
    result?: string;
    collapsed: boolean;
  };
}

 

/**
 * 单条消息（memo 化）：流式 token 只更新流式那条消息的 content，
 * 历史消息 props 不变 → 跳过重渲染；markdown 解析按 content 缓存，每 token 只解析流式文本。
 */
const MessageItem = memo(function MessageItem({
  message,
  onToggleTool,
}: {
  message: DisplayMessage;
  onToggleTool: (key: string) => void;
}) {
  // agent 消息才走 markdown；content 不变时复用上一次的解析结果
  const html = useMemo(
    () => (message.role === "agent" ? renderMarkdown(message.content) : ""),
    [message.role, message.content],
  );

  // 跳过 tool call 之间创建的空 agent 消息（占位用，不应渲染）
  if (message.role === "agent" && message.content === "") {
    return null;
  }

  if (message.role === "tool" && message.toolCard) {
    const tc = message.toolCard;
    return (
      <div
        className={`tool-card${tc.collapsed ? " tool-card--collapsed" : ""}`}
        onClick={() => onToggleTool(message.key)}
        role="button"
        tabIndex={0}
        onKeyDown={(e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); onToggleTool(message.key); } }}
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

  // 用户消息 = 纯文本（保留换行，由 .msg__bubble 的 white-space: pre-wrap 呈现），
  // 不走 markdown：避免纯文本被 marked 包成 <p> 段落 + 尾随换行造成前后空行。
  if (message.role === "user") {
    return (
      <div className={`msg msg--${message.role}`}>
        <div className="msg__bubble">{message.content}</div>
      </div>
    );
  }

  return (
    <div className={`msg msg--${message.role}`}>
      <div className="msg__bubble" dangerouslySetInnerHTML={{ __html: html }} />
    </div>
  );
});

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
  const [copied, setCopied] = useState(false);
  const abortRef = useRef<AbortController | null>(null);
  /** 后台流式任务的轮询刷新器（重开窗口时跟随流式落盘） */
  const pollTimerRef = useRef<number | null>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const mirrorRef = useRef<HTMLSpanElement>(null);
  const [sessions, setSessions] = useState<SessionCandidate[]>([]);
  const [mention, setMention] = useState<Mention | null>(null);
  const [mentionX, setMentionX] = useState(0);
  /** 已选中的会话引用 chips（用于可视化，底层 input 仍存 &ses_<id>） */
  const [mentionChips, setMentionChips] = useState<Array<{ sessionId: string; name: string }>>([]);
  const load = useAgentsStore((state) => state.load);

  const reloadMessages = async (): Promise<StoredMessage[]> => {
    try {
      const base = await awaitApiBase();
      const res = await fetch(`${base}/api/agents/${encodeURIComponent(agent.id)}/messages`);
      if (!res.ok) {
        return [];
      }
      const data = (await res.json()) as { messages: StoredMessage[] };
      // 落盘消息 → 展示消息：按 timeline 还原工具卡片与文本段的真实交错顺序
      // （关闭重开 / onDone 全量重建时与实时 SSE 渲染保持一致；已完成工具默认折叠）
      const restored: DisplayMessage[] = [];
      data.messages.forEach((message, index) => {
        if (message.role !== "agent") {
          restored.push({
            key: `${message.timestamp}-${message.role}-${index}`,
            role: message.role === "user" ? "user" : "agent",
            content: message.content,
            status: message.status,
          });
          return;
        }
        const seq = buildMessageSequence(message);
        seq.forEach((item, seqIndex) => {
          if (item.kind === "tool") {
            restored.push({
              key: `tool-restored-${message.timestamp}-${index}-${seqIndex}`,
              role: "tool",
              content: "",
              toolCard: {
                name: item.name,
                args: item.args,
                // 流式进行中：无 result 的工具显示为运行中；完成后折叠
                status: item.result ? "done" : "running",
                result: item.result,
                collapsed: message.status === "streaming" ? false : !!item.result,
              },
            });
          } else {
            restored.push({
              key: `agent-restored-${message.timestamp}-${index}-${seqIndex}`,
              role: "agent",
              content: item.content,
              status: message.status,
            });
          }
        });
      });
      setMessages(restored);
      return data.messages;
    } catch {
      return [];
    }
  };

  const stopPolling = (): void => {
    if (pollTimerRef.current !== null) {
      window.clearInterval(pollTimerRef.current);
      pollTimerRef.current = null;
    }
  };

  /** 若有流式消息：显示停止按钮 + 开启轻量轮询，跟随后台流式写日志 */
  const followBackgroundStream = async (): Promise<void> => {
    const msgs = await reloadMessages();
    if (!msgs.some((message) => message.status === "streaming")) {
      return;
    }
    setStreaming(true);
    if (pollTimerRef.current !== null) {
      return;
    }
    pollTimerRef.current = window.setInterval(() => {
      void (async () => {
        const latest = await reloadMessages();
        if (!latest.some((message) => message.status === "streaming")) {
          stopPolling();
          setStreaming(false);
        }
      })();
    }, 2500);
  };

  useEffect(() => {
    void followBackgroundStream();
    // 收起磁贴（卸载）= 只释放本地连接，task 在服务端继续流式写日志、后台跑完；
    return () => {
      abortRef.current?.abort();
      abortRef.current = null;
      stopPolling();
    };
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
    // 检测用户手动删除了 &ses_<id>：同步移除对应 chip
    const sesIdsInInput = value.match(/&ses_([^\s]+)/g)?.map((s) => s.slice(6)) ?? [];
    setMentionChips((prev) => prev.filter((c) => sesIdsInInput.includes(c.sessionId)));
  };

  /** 选中候选：在输入框插入 &ses_<id>，同时在 chips 区显示可视化标签 */
  const applyMention = (sessionId: string) => {
    if (!mention) return;
    const candidate = candidates.find((c) => c.id === sessionId);
    const value = input;
    const caret = inputRef.current?.selectionStart ?? value.length;
    const newValue = `${value.slice(0, mention.start)}&ses_${sessionId} ${value.slice(caret)}`;
    setInput(newValue);
    if (candidate) {
      setMentionChips((prev) => [...prev, { sessionId, name: candidate.name }]);
    }
    setMention(null);
    inputRef.current?.focus();
  };

  /** 删除 mention chip：同步清理 chips 数组与 input 中的 &ses_<id> */
  const removeMentionChip = (sessionId: string) => {
    setMentionChips((prev) => prev.filter((c) => c.sessionId !== sessionId));
    setInput((val) => val.replace(new RegExp(`&ses_${sessionId}\s*`), ""));
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

  // 切换 tool card 折叠/展开（useCallback 保持稳定引用，配合 MessageItem memo）
  const toggleToolCollapsed = useCallback((key: string) => {
    setMessages((prev) =>
      prev.map((m) =>
        m.key === key && m.toolCard ? { ...m, toolCard: { ...m.toolCard, collapsed: !m.toolCard.collapsed } } : m,
      ),
    );
  }, []);

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

  /** 中止当前 chat（■ 停止按钮）：本地释放连接 + 通知后端停掉任务本体 */
  const cancelCurrent = () => {
    abortRef.current?.abort();
    abortRef.current = null;
    stopPolling();
    void cancelAgentChat(agent.id);
    setStreaming(false);
  };

  const send = () => {
    const t = input.trim();
    if (!t || streaming) {
      return;
    }
    setInput("");
    void sendText(t);
  };

  /** 无输入框依赖的发送入口（输入框 send 与重试按钮共用） */
  const sendText = async (text: string) => {
    const trimmed = text.trim();
    if (!trimmed || streaming) {
      return;
    }
    setStreamError(null);
    setMessages((prev) => [...prev, { key: `user-${Date.now()}`, role: "user", content: trimmed }]);
    setStreaming(true);
    stopPolling(); // 有后台轮询时先停掉，由 SSE 接管实时更新
    const controller = new AbortController();
    abortRef.current = controller;
    const TIMEOUT_MS = 5 * 60 * 1000; // 5 分钟无响应视为超时
    const combinedSignal = AbortSignal.any([controller.signal, AbortSignal.timeout(TIMEOUT_MS)]);
    let currentAgentKey = `agent-${Date.now()}`;
    setMessages((prev) => [...prev, { key: currentAgentKey, role: "agent", content: "" }]);
    // token 合帧：SSE token 到达频率远高于渲染需求（每 token 一次 setMessages/render/markdown），
    // 先积累到 buffer，由 requestAnimationFrame 每帧最多 flush 一次 → 渲染频率上限 60fps。
    // 注意：切换 currentAgentKey（tool call 分界）或流结束前必须 flush，否则尾部 token 会掉入下一条消息。
    let tokenBuffer = "";
    let tokenRaf: number | null = null;
    const flushTokens = (): void => {
      if (tokenRaf !== null) {
        cancelAnimationFrame(tokenRaf);
        tokenRaf = null;
      }
      if (!tokenBuffer) return;
      const chunk = tokenBuffer;
      tokenBuffer = "";
      setMessages((prev) => prev.map((m) => (m.key === currentAgentKey ? { ...m, content: m.content + chunk } : m)));
    };
    try {
      const base = await awaitApiBase();
      await runChatStream(
        base,
        agent.id,
        trimmed,
        {
          onToken: (chunk) => {
            tokenBuffer += chunk;
            if (tokenRaf === null) {
              tokenRaf = requestAnimationFrame(flushTokens);
            }
          },
          onToolStart: (name, args) => {
            // tool call 分界：先把缓冲 token 落进旧消息，再切换 currentAgentKey
            flushTokens();
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
            flushTokens();
            await reloadMessages();
            await load();
          },
          onError: (message) => {
            flushTokens();
            setStreamError(message);
            setMessages((prev) => prev.filter((m) => !(m.role === "agent" && m.content === "")));
          },
        },
        combinedSignal,
      );
    } catch (error) {
      if (error instanceof DOMException && error.name === "TimeoutError") {
        setStreamError("请求超时（5 分钟无响应），已取消");
        void cancelAgentChat(agent.id);
      } else if (!(error instanceof DOMException && error.name === "AbortError")) {
        setStreamError(error instanceof Error ? error.message : String(error));
        setMessages((prev) => prev.filter((message) => message.key !== currentAgentKey || message.content !== ""));
      }
    } finally {
      flushTokens(); // 兜底：abort/超时路径也要把缓冲 token 落定
      setStreaming(false);
      stopPolling();
      // 若连接异常但后端任务仍在流式落盘，重新接入轮询跟随（后台恢复场景）
      void followBackgroundStream();
    }
  };

  /** 重试：先显式复位非运行态（error/waiting/completed → idle），再重发最后一条用户消息 */
  const retry = async () => {
    if (streaming) {
      return;
    }
    const lastUser = [...messages].reverse().find((m) => m.role === "user" && m.content.trim());
    if (!lastUser) {
      return;
    }
    setStreamError(null);
    if (agent.state === "error" || agent.state === "waiting_approval" || agent.state === "completed") {
      await resetAgentChat(agent.id);
      await load();
    }
    void sendText(lastUser.content);
  };

  /** 复制窗口内最后一条 agent 输出（渲染后的纯文本） */
  const copyOutput = async () => {
    const lastAgent = [...messages].reverse().find((m) => m.role === "agent" && m.content.trim());
    if (!lastAgent) {
      return;
    }
    let text = lastAgent.content;
    try {
      const div = document.createElement("div");
      div.innerHTML = renderMarkdown(lastAgent.content);
      text = div.textContent ?? lastAgent.content;
    } catch {
      // 渲染异常时回落原始文本
    }
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1500);
    } catch {
      // 剪贴板不可用（非安全上下文等）时静默
    }
  };

  const formatDuration = (ms: number): string => {
    if (!Number.isFinite(ms) || ms < 0) {
      return "";
    }
    if (ms < 1000) {
      return `${ms}ms`;
    }
    const s = Math.round(ms / 1000);
    if (s < 60) {
      return `${s}s`;
    }
    return `${Math.floor(s / 60)}m ${s % 60}s`;
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
          messages.map((message) => (
            <MessageItem key={message.key} message={message} onToggleTool={toggleToolCollapsed} />
          ))
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

        {/* 非运行态操作条：重试 + 运行时间 + 复制输出（仅在有 agent 输出时显示） */}
        {!streaming && agent.state !== "running" && messages.some((m) => m.role === "agent" && m.content.trim()) ? (
          <div className="agent-window__actions" aria-label="输出操作">
            <button type="button" className="btn btn--ghost btn--sm" onClick={() => void retry()} aria-label="重试上一次任务">
              ⟳ 重试
            </button>
            <span className="agent-window__run-time">
              {typeof agent.last_run_duration_ms === "number" && agent.last_run_duration_ms > 0
                ? `运行时间 ${formatDuration(agent.last_run_duration_ms)}`
                : ""}
            </span>
            <span className="agent-window__actions-spacer" />
            <button type="button" className="btn btn--ghost btn--sm" onClick={() => void copyOutput()} aria-label="复制输出内容">
              {copied ? "✓ 已复制" : "⧉ 复制输出"}
            </button>
          </div>
        ) : null}

        {streamError ? <p className="agent-window__error" role="alert">{streamError}</p> : null}
      </div>

      <footer className="agent-window__composer">
        <span ref={mirrorRef} className="mention-popup__mirror" aria-hidden="true" />
        {/* 已选会话引用 chips：可视化标签，点击 × 删除 */}
        {mentionChips.length > 0 && (
          <div className="mention-chips" role="group" aria-label="已引用会话">
            {mentionChips.map((chip) => (
              <span
                key={chip.sessionId}
                className="mention-chip"
                onMouseDown={(e) => e.preventDefault()}
              >
                <span className="mention-chip__name">@{chip.name}</span>
                <button
                  type="button"
                  className="mention-chip__remove"
                  aria-label={`移除引用 ${chip.name}`}
                  onClick={() => removeMentionChip(chip.sessionId)}
                >
                  ×
                </button>
              </span>
            ))}
          </div>
        )}
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
        <button
          type="button"
          className={streaming ? "btn btn--stop" : "btn btn--primary"}
          onClick={streaming ? cancelCurrent : () => void send()}
          disabled={!streaming && !input.trim()}
          aria-label={streaming ? "停止生成" : "发送"}
          title={streaming ? "停止本次生成" : "发送"}
        >
          {streaming ? "■ 停止" : "发送"}
        </button>
      </footer>
    </div>
  );
}