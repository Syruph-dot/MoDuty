import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { awaitApiBase } from "../../lib/api";
import { subscribeDutyEvents } from "../../lib/dutyEvents";
import { useAgentsStore } from "../../state/agentsStore";

/**
 * 值日生对话内核（从 DutyGirl 的对话框里抽出，供两种壳共用）：
 * - 小对话框（磁贴旁 330px，快捷指令）；
 * - 值日生页（DutyScreen，整页调度视图）。
 *
 * 两者共用同一份消息状态与同一套 SSE 解析、& 会话候选、&ses_/&tile_ chip 跳转，
 * 避免出现“对话框里有、窗口里没有”的行为差异。
 */

export interface DutyMessage {
  /** user=老师；agent=值日生；system=系统投递（如执行者完成/出错链接通知） */
  role: "user" | "agent" | "system";
  content: string;
}

interface SessionCandidate {
  id: string;
  name?: string;
  goal?: string;
}

export const DUTY_WELCOME = "老师好～我是值日生。复杂的事情交给我来调度吧，直接说就好！";

/** 把消息里的 &ses_<id> / &tile_<id> 句柄拆成 [普通文本|资源引用] 片段，供 chip 渲染。 */
export function tokenizeLinkRefs(content: string): Array<{ text: string; ref?: { kind: "ses" | "tile"; raw: string } }> {
  const parts: Array<{ text: string; ref?: { kind: "ses" | "tile"; raw: string } }> = [];
  const re = /&(ses_[A-Za-z0-9]+|tile_[A-Za-z0-9]+)/g;
  let last = 0;
  let match: RegExpExecArray | null;
  while ((match = re.exec(content)) !== null) {
    if (match.index > last) parts.push({ text: content.slice(last, match.index) });
    const raw = match[1];
    parts.push({ text: "", ref: { kind: raw.startsWith("ses_") ? "ses" : "tile", raw } });
    last = match.index + match[0].length;
  }
  if (last < content.length) parts.push({ text: content.slice(last) });
  return parts.length === 0 ? [{ text: content }] : parts;
}

function parseSSEChunk(
  chunk: string,
  onToken: (t: string) => void,
  onTool: (n: string, s: string) => void,
  onDone: (d: unknown) => void,
  onError: (m: string) => void,
): void {
  const lines = chunk.split("\n");
  for (const line of lines) {
    if (!line.startsWith("data:")) continue;
    const raw = line.slice(5).trim();
    if (!raw) continue;
    let evt: Record<string, unknown>;
    try {
      evt = JSON.parse(raw) as Record<string, unknown>;
    } catch {
      continue;
    }
    const type = evt.type;
    if (type === "token" && typeof evt.text === "string") onToken(evt.text);
    else if (type === "tool_start" && typeof evt.name === "string") onTool(evt.name, "running");
    else if (type === "tool_result" && typeof evt.name === "string") onTool(evt.name, "done");
    else if (type === "done") onDone(evt);
    else if (type === "error") onError(typeof evt.error === "string" ? evt.error : String(evt.error ?? "未知错误"));
  }
}

/** 与 AgentWindow 相同的 & 会话候选逻辑（数据源 GET /api/sessions） */
function useSessionCandidates(excludeSessionId?: string): SessionCandidate[] {
  const [sessions, setSessions] = useState<SessionCandidate[]>([]);
  useEffect(() => {
    let alive = true;
    void (async () => {
      try {
        const base = await awaitApiBase();
        const res = await fetch(`${base}/api/sessions`);
        const data = (await res.json()) as { sessions?: SessionCandidate[] };
        if (alive) setSessions((data.sessions ?? []).filter((s) => s.id !== excludeSessionId));
      } catch {
        /* 候选拉取失败不影响对话 */
      }
    })();
    return () => {
      alive = false;
    };
  }, [excludeSessionId]);
  return sessions;
}

export interface DutyChatApi {
  messages: DutyMessage[];
  input: string;
  setInput: (value: string) => void;
  streaming: boolean;
  error: string | null;
  /** 值日生 agent 已就绪（未就绪时输入框禁用） */
  ready: boolean;
  send: (text?: string) => void;
  /** 中断当前流式回复（关闭对话框/窗口时调用） */
  abort: () => void;
  /** 提及候选（输入 & 时） */
  mention: { candidates: SessionCandidate[]; index: number } | null;
  onInputChange: (event: React.ChangeEvent<HTMLInputElement>) => void;
  onKeyDown: (event: React.KeyboardEvent<HTMLInputElement>) => void;
  applyMention: (sessionId: string) => void;
  /** chip 点击：解析 &ses_/&tile_ 并打开对应窗口 */
  openRefTarget: (raw: string, kind: "ses" | "tile") => void;
  inputRef: React.RefObject<HTMLInputElement>;
  listRef: React.RefObject<HTMLDivElement>;
}

/**
 * 值日生对话状态机：历史加载（含 system 投递）、事件驱动增量刷新、SSE 流式发送、
 * & 会话候选与按键导航。agentId 为空时只做占位（输入禁用）。
 */
export function useDutyChat(agentId: string | null): DutyChatApi {
  const [messages, setMessages] = useState<DutyMessage[]>([]);
  const [input, setInput] = useState("");
  const [streaming, setStreaming] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [mentionAt, setMentionAt] = useState<{ query: string; start: number; index: number; caret: number } | null>(null);

  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const liveRef = useRef<{ abort: () => void } | null>(null);
  const openedAtRef = useRef(0);
  const streamingRef = useRef(false);

  const agents = useAgentsStore((state) => state.agents);
  const openAgentById = useAgentsStore((state) => state.openAgent);

  const sessions = useSessionCandidates();
  const candidates = useMemo(() => {
    if (!mentionAt) return [];
    const needle = mentionAt.query.trim().toLowerCase();
    const base = needle ? sessions.filter((s) => `${s.name ?? ""} ${s.goal ?? ""}`.toLowerCase().includes(needle)) : sessions;
    return base.slice(0, 20);
  }, [sessions, mentionAt]);

  /** chip 点击：把 &ses_/&tile_ 目标解析成 agentId 后打开窗口 */
  const openRefTarget = useCallback(
    (raw: string, kind: "ses" | "tile") => {
      const id = raw.replace(/^(ses|tile)_/, "");
      if (kind === "tile") {
        if (agents.some((agent) => agent.id === id)) openAgentById(id);
        return;
      }
      // ses_：通过 sessionId 反查绑定 agent；绑定失败则尝试把 id 当裸 agent id（兼容 &ses_<agt> 手误）
      const bound = agents.find((agent) => agent.session_id === `ses_${id}` || agent.session_id === id);
      if (bound) {
        openAgentById(bound.id);
      } else if (agents.some((agent) => agent.id === id)) {
        openAgentById(id);
      }
    },
    [agents, openAgentById],
  );

  /* 历史加载 + 事件驱动增量刷新（替代轮询）：
     值日生终态（判读/被唤醒轮结束）或台账判读结论到达时同步一次；流式进行中不覆盖。 */
  useEffect(() => {
    if (!agentId) return;
    openedAtRef.current = Date.now();
    let alive = true;
    const loadHistory = async () => {
      try {
        const base = await awaitApiBase();
        const res = await fetch(`${base}/api/agents/${encodeURIComponent(agentId)}/messages`);
        if (!res.ok || !alive) return;
        const data = (await res.json()) as { messages?: Array<{ role: string; content: string; status?: string }> };
        if (!alive || !data.messages) return;
        const next = data.messages
          .filter((m) => {
            if (m.role === "agent" && m.content === "") return false;
            if (m.status === "streaming") return false;
            return true;
          })
          .map((m) => ({
            role: (m.role === "user" || m.role === "agent" || m.role === "system" ? m.role : "agent") as DutyMessage["role"],
            content: m.content ?? "",
          }));
        setMessages((prev) => {
          if (prev.some((m) => m.role === "agent" && m.content === "") && Date.now() - openedAtRef.current < 15000) {
            return prev;
          }
          if (next.length === 0) return prev;
          if (prev.length === 0) return next;
          const known = new Set(prev.map((m) => `${m.role}:${m.content}`));
          const additions = next.filter((m) => !known.has(`${m.role}:${m.content}`));
          return additions.length > 0 ? [...prev, ...additions] : prev;
        });
      } catch {
        // 静默：历史拉取失败不阻塞对话
      }
    };
    void loadHistory();
    const unsubscribe = subscribeDutyEvents((event) => {
      if (!alive || streamingRef.current) return;
      const relevant =
        (event.type === "agent_state" &&
          event.agent_id === agentId &&
          (event.state === "completed" || event.state === "error")) ||
        (event.type === "dispatch_verdict" && event.dispatcher_agent_id === agentId);
      if (relevant) void loadHistory();
    });
    return () => {
      alive = false;
      unsubscribe();
      liveRef.current?.abort();
    };
  }, [agentId]);

  /* 自动滚动到最新消息 */
  useEffect(() => {
    listRef.current?.scrollTo({ top: listRef.current.scrollHeight });
  }, [messages, streaming]);

  const sendInner = async (text: string) => {
    if (!agentId || !text.trim() || streaming) return;
    const message = text.trim();
    setInput("");
    setMentionAt(null);
    setMessages((prev) => [...prev, { role: "user", content: message }, { role: "agent", content: "" }]);
    setStreaming(true);
    streamingRef.current = true;
    setError(null);
    const controller = new AbortController();
    liveRef.current = controller;
    try {
      const base = await awaitApiBase();
      const res = await fetch(`${base}/api/agents/${agentId}/chat`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ message }),
        signal: controller.signal,
      });
      if (!res.ok || !res.body) {
        const textBody = await res.text().catch(() => "");
        throw new Error(`HTTP ${res.status} ${textBody.slice(0, 120)}`);
      }
      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";
      let appendToken = "";
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split("\n");
        buffer = lines.pop() ?? "";
        parseSSEChunk(
          lines.join("\n"),
          (token) => {
            appendToken += token;
            setMessages((prev) => {
              const next = [...prev];
              const last = next[next.length - 1];
              if (last?.role === "agent") next[next.length - 1] = { ...last, content: last.content + token };
              return next;
            });
          },
          (name, status) => {
            setMessages((prev) => {
              const next = [...prev];
              const last = next[next.length - 1];
              if (last?.role === "agent") {
                next[next.length - 1] = {
                  ...last,
                  content: `${last.content}${appendToken ? "\n" : ""}[工具 ${name} ${status === "running" ? "执行中…" : "完成"}]${appendToken ? "" : "\n"}`,
                };
              }
              appendToken = "";
              return next;
            });
          },
          () => undefined,
          (m) => {
            setError(m);
          },
        );
      }
      if (buffer) {
        parseSSEChunk(
          buffer,
          (token) => setMessages((prev) => {
            const next = [...prev];
            const last = next[next.length - 1];
            if (last?.role === "agent") next[next.length - 1] = { ...last, content: last.content + token };
            return next;
          }),
          () => undefined,
          () => undefined,
          (m) => setError(m),
        );
      }
      setMessages((prev) => prev.filter((m) => !(m.role === "agent" && m.content === "")));
    } catch (err) {
      if (!(err instanceof DOMException && err.name === "AbortError")) {
        setError(err instanceof Error ? err.message : String(err));
        setMessages((prev) => prev.filter((m) => !(m.role === "agent" && m.content === "")));
      }
    } finally {
      setStreaming(false);
      streamingRef.current = false;
      liveRef.current = null;
    }
  };

  const send = useCallback(
    (text?: string) => {
      void sendInner(text ?? input);
    },
    // sendInner 依赖 streaming/input/agentId：用最新值即可（每次渲染重建）
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [input, agentId, streaming],
  );

  const abort = useCallback(() => {
    liveRef.current?.abort();
    liveRef.current = null;
    setStreaming(false);
    streamingRef.current = false;
  }, []);

  const onInputChange = (event: React.ChangeEvent<HTMLInputElement>) => {
    const value = event.target.value;
    setInput(value);
    const caret = event.target.selectionStart ?? value.length;
    const match = value.slice(0, caret).match(/&(\S*)$/);
    if (match) {
      setMentionAt({ query: match[1] ?? "", start: caret - match[0].length, index: 0, caret });
    } else {
      setMentionAt(null);
    }
  };

  const applyMention = (sessionId: string) => {
    if (!mentionAt) return;
    const caret = inputRef.current?.selectionStart ?? input.length;
    setInput(`${input.slice(0, mentionAt.start)}&ses_${sessionId} ${input.slice(caret)}`);
    setMentionAt(null);
    inputRef.current?.focus();
  };

  const onKeyDown = (event: React.KeyboardEvent<HTMLInputElement>) => {
    if (mentionAt && candidates.length > 0) {
      const last = candidates.length - 1;
      if (event.key === "ArrowDown") {
        event.preventDefault();
        setMentionAt((prev) => (prev ? { ...prev, index: prev.index >= last ? 0 : prev.index + 1 } : prev));
        return;
      }
      if (event.key === "ArrowUp") {
        event.preventDefault();
        setMentionAt((prev) => (prev ? { ...prev, index: prev.index <= 0 ? last : prev.index - 1 } : prev));
        return;
      }
      if (event.key === "Enter" || event.key === "Tab") {
        event.preventDefault();
        const hit = candidates[mentionAt.index];
        if (hit) applyMention(hit.id);
        return;
      }
      if (event.key === "Escape") {
        event.preventDefault();
        setMentionAt(null);
        return;
      }
    }
    if (event.key === "Enter" && !event.shiftKey) {
      event.preventDefault();
      send(input);
    }
  };

  return {
    messages,
    input,
    setInput,
    streaming,
    error,
    ready: !!agentId,
    send,
    abort,
    mention: mentionAt ? { candidates, index: mentionAt.index } : null,
    onInputChange,
    onKeyDown,
    applyMention,
    openRefTarget,
    inputRef,
    listRef,
  };
}

/**
 * 对话面板（消息列表 + composer）：两种壳共用。
 * variant="dialog" 走小对话框尺寸/间距；variant="window" 在大窗口里铺开。
 * 内部仍沿用 duty-dialog__* 类名（避免为一套消息气泡维护两份 CSS），
 * 差异只在根部的 .duty-chat--dialog / .duty-chat--window。
 */
export function DutyChatPanel({
  chat,
  variant,
  onEscape,
}: {
  chat: DutyChatApi;
  variant: "dialog" | "window";
  /** 对话框形态下 Esc 关闭（窗口形态不传） */
  onEscape?: () => void;
}) {
  const { messages, streaming, error, mention } = chat;
  return (
    <div className={`duty-chat duty-chat--${variant}`}>
      <div className="duty-dialog__list" ref={chat.listRef} aria-live="polite">
        {messages.length === 0 && !streaming ? <div className="duty-dialog__welcome">{DUTY_WELCOME}</div> : null}
        {messages.map((m, index) => {
          const isTrailingStream = m.role === "agent" && streaming && index === messages.length - 1;
          const text = m.content || (isTrailingStream ? "…" : "");
          if (!text) return null;
          return (
            <div key={index} className={`duty-dialog__msg duty-dialog__msg--${m.role}`}>
              {tokenizeLinkRefs(text).map((part, partIndex) =>
                part.ref ? (
                  <button
                    key={partIndex}
                    type="button"
                    className="duty-dialog__link"
                    title="点击打开会话"
                    onClick={(event) => {
                      event.stopPropagation();
                      chat.openRefTarget(part.ref!.raw, part.ref!.kind);
                    }}
                  >
                    <span className="duty-dialog__link-icon">↗</span>
                    {part.ref.kind === "ses" ? "会话" : "Agent"}·{part.ref.raw.slice(4).slice(0, 6)}
                  </button>
                ) : (
                  <span key={partIndex}>{part.text}</span>
                ),
              )}
            </div>
          );
        })}
        {streaming ? <div className="duty-dialog__typing">值日生正在调度…</div> : null}
        {error ? <div className="duty-dialog__error">{error}</div> : null}
      </div>
      <div className="duty-dialog__composer">
        <input
          ref={chat.inputRef}
          className="duty-dialog__input"
          value={chat.input}
          onChange={chat.onInputChange}
          onKeyDown={(event) => {
            if (event.key === "Escape" && !chat.mention) {
              onEscape?.();
              return;
            }
            chat.onKeyDown(event);
          }}
          disabled={!chat.ready}
          placeholder={chat.ready ? "输入指令，& 引用会话…" : "正在唤醒值日生…"}
        />
        {mention && mention.candidates.length > 0 ? (
          <ul className="duty-dialog__mention" role="listbox" aria-label="引用会话">
            {mention.candidates.map((session, index) => (
              <li
                key={session.id}
                role="option"
                aria-selected={index === mention.index}
                className={`duty-dialog__mention-item${index === mention.index ? " duty-dialog__mention-item--active" : ""}`}
                onMouseDown={(event) => {
                  event.preventDefault();
                  chat.applyMention(session.id);
                }}
              >
                <span className="duty-dialog__mention-name">{session.name ?? session.id}</span>
                <span className="duty-dialog__mention-goal">{session.goal ?? ""}</span>
              </li>
            ))}
          </ul>
        ) : null}
        <button
          type="button"
          className="duty-dialog__send"
          disabled={!chat.ready || streaming || !chat.input.trim()}
          onClick={() => chat.send()}
        >
          {streaming ? "·" : "发送"}
        </button>
      </div>
    </div>
  );
}
