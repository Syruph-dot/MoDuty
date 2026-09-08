import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";

import { useAgentsStore } from "../../state/agentsStore";
import AgentWindow from "../AgentWindow";

/**
 * 值日生（Duty Girl）——调度者 Agent 的桌面形象（固定 2×3 磁贴）。
 *
 * - 外表：BA 风格学生立绘（开发期占位；用户放置 desktop/public/duty/<name>.png 后自动覆盖）。
 * - 交互：点击立绘 → 在磁贴旁弹出对话框输入指令（非打开窗口）。
 * - 调用：对话框消息经 /api/agents/:id/chat 发给「值日生」调度者 Agent（角色扮演 + 调度专家，
 *   后端预置 DISPATCHER_SYSTEM_PROMPT；它会调查会话、输出 &ses_<id> 句柄、调 MOMOKA CLI 驱动其它 Agent）。
 * - 输入框支持 & 会话候选（插入 &ses_<id> 链接）。
 */

interface DutyMessage {
  /** user=老师；agent=值日生；system=系统投递（如执行者完成/出错链接通知） */
  role: "user" | "agent" | "system";
  content: string;
}

interface SessionCandidate {
  id: string;
  name?: string;
  goal?: string;
}

/** 把消息里的 &ses_<id> / &tile_<id> 句柄拆成 [普通文本|资源引用] 片段，供 chip 渲染。 */
function tokenizeLinkRefs(content: string): Array<{ text: string; ref?: { kind: "ses" | "tile"; raw: string } }> {
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

const DUTY_AGENT_NAME = "值日生";
const DUTY_AGENT_KEY = "momoka:duty:agentId";
const DUTY_WELCOME = "老师好～我是值日生。复杂的事情交给我来调度吧，直接说就好！";


function baseUrl(): string {
  const known = (globalThis as { __MOMOKA_BASE__?: string }).__MOMOKA_BASE__;
  return known ?? "http://localhost:8888";
}

/** 创建锁：多个 DutyGirl 实例/StrictMode 双挂载时只发一次创建请求 */
let dutyCreateLock: Promise<string | null> | null = null;

function ensureDutyAgentId(): Promise<string | null> {
  const cached = localStorage.getItem(DUTY_AGENT_KEY);
  if (cached) return Promise.resolve(cached);
  if (dutyCreateLock) return dutyCreateLock;
  dutyCreateLock = (async () => {
    try {
      const res = await fetch(`${baseUrl()}/api/agents`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ name: DUTY_AGENT_NAME, kind: "dispatcher" }),
      });
      const data = (await res.json()) as { agent?: { id: string } };
      const id = data.agent?.id ?? null;
      if (id) localStorage.setItem(DUTY_AGENT_KEY, id);
      return id;
    } finally {
      dutyCreateLock = null;
    }
  })();
  return dutyCreateLock;
}

/** 与 AgentWindow 相同的 & 会话候选逻辑（数据源 GET /api/sessions） */
function useSessionCandidates(excludeSessionId?: string) {
  const [sessions, setSessions] = useState<SessionCandidate[]>([]);
  useEffect(() => {
    let alive = true;
    fetch(`${baseUrl()}/api/sessions`)
      .then((res) => res.json())
      .then((data: { sessions?: SessionCandidate[] }) => {
        if (alive) setSessions((data.sessions ?? []).filter((s) => s.id !== excludeSessionId));
      })
      .catch(() => undefined);
    return () => {
      alive = false;
    };
  }, [excludeSessionId]);
  return sessions;
}

function parseSSEChunk(chunk: string, onToken: (t: string) => void, onTool: (n: string, s: string) => void, onDone: (d: unknown) => void, onError: (m: string) => void) {
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

export default function DutyGirl() {
  const [agentId, setAgentId] = useState<string | null>(null);
  const [open, setOpen] = useState(false);
  const [messages, setMessages] = useState<DutyMessage[]>([]);
  const [input, setInput] = useState("");
  const [streaming, setStreaming] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [mentionAt, setMentionAt] = useState<{ query: string; start: number; index: number; caret: number } | null>(null);
  const [dialogPos, setDialogPos] = useState<{ left: number; top: number; side: "left" | "right" } | null>(null);
  /** DutyWindow：以完整 AgentWindow 打开值日生会话（portal 到 body，不占磁贴墙） */
  const [showWindow, setShowWindow] = useState(false);

  const rootRef = useRef<HTMLDivElement | null>(null);
  const inputRef = useRef<HTMLInputElement | null>(null);
  const listRef = useRef<HTMLDivElement | null>(null);
  const liveRef = useRef<{ abort: () => void } | null>(null);
  const openedAtRef = useRef(0);
  const streamingRef = useRef(false);

  /* 打开 agent 磁贴窗口（chip 点击）：把 &ses_/&tile_ 目标解析成 agentId 后 openAgent */
  const agents = useAgentsStore((state) => state.agents);
  const openAgentById = useAgentsStore((state) => state.openAgent);
  /** 值日生 agent 记录（DutyWindow 用） */
  const dutyAgent = useMemo(() => agents.find((candidate) => candidate.id === agentId) ?? null, [agents, agentId]);
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

  const sessions = useSessionCandidates();
  const candidates = useMemo(() => {
    if (!mentionAt) return [];
    const needle = mentionAt.query.trim().toLowerCase();
    const base = needle ? sessions.filter((s) => `${s.name ?? ""} ${s.goal ?? ""}`.toLowerCase().includes(needle)) : sessions;
    return base.slice(0, 20);
  }, [sessions, mentionAt]);

  /* 首次挂载：确保调度者 Agent 存在（幂等——localStorage 缓存 + 模块级锁防 StrictMode 双创建） */
  useEffect(() => {
    let alive = true;
    const cached = localStorage.getItem(DUTY_AGENT_KEY);
    if (cached) {
      setAgentId(cached);
      return;
    }
    let cancelled = false;
    void ensureDutyAgentId()
      .then((id) => {
        if (alive && !cancelled && id) setAgentId(id);
      })
      .catch(() => undefined);
    return () => {
      alive = false;
      cancelled = true;
      liveRef.current?.abort();
    };
  }, []);

  /* 打开对话框时恢复历史（值日生会话含系统投递消息 &ses_，需拉取渲染 chip）。
     也做一次轻轮询：对话框打开且非流式时，若后端有新投递消息则增量刷新列表。 */
  useEffect(() => {
    if (!open || !agentId) return;
    openedAtRef.current = Date.now();
    let alive = true;
    const loadHistory = async () => {
      try {
        const res = await fetch(`${baseUrl()}/api/agents/${encodeURIComponent(agentId)}/messages`);
        if (!res.ok || !alive) return;
        const data = (await res.json()) as { messages?: Array<{ role: string; content: string; status?: string }> };
        if (!alive || !data.messages) return;
        // 过滤掉进行中（status=streaming）占位与空 agent 消息；保留 system 投递
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
          // 当前有正在进行的对话流（新消息）时不覆盖；否则以服务端为准恢复/同步
          if (prev.some((m) => m.role === "agent" && m.content === "") && Date.now() - openedAtRef.current < 15000) {
            return prev;
          }
          if (next.length === 0) return prev;
          if (prev.length === 0) return next;
          // 增量同步：保留本地已有尾部消息，追加服务端更新的系统投递（按内容去重）
          const known = new Set(prev.map((m) => `${m.role}:${m.content}`));
          const additions = next.filter((m) => !known.has(`${m.role}:${m.content}`));
          return additions.length > 0 ? [...prev, ...additions] : prev;
        });
      } catch {
        // 静默：打开失败不阻塞对话框
      }
    };
    void loadHistory();
    const timer = window.setInterval(() => {
      if (!streamingRef.current) void loadHistory();
    }, 4000);
    return () => {
      alive = false;
      window.clearInterval(timer);
    };
  }, [open, agentId]);

  /* 对话框定位：贴磁贴右缘；视口放不下则放左缘。滚动/缩放时跟随。 */
  useEffect(() => {
    if (!open) return;
    const update = () => {
      const el = rootRef.current;
      if (!el) return;
      const rect = el.getBoundingClientRect();
      const W = 330;
      const side: "right" | "left" = rect.right + W + 12 <= window.innerWidth ? "right" : "left";
      const left = side === "right" ? rect.right + 12 : Math.max(8, rect.left - W - 12);
      const top = Math.max(8, Math.min(rect.top, window.innerHeight - 120));
      setDialogPos({ left, top, side });
    };
    update();
    const wall = document.querySelector(".tile-wall");
    wall?.addEventListener("scroll", update, { passive: true });
    window.addEventListener("resize", update);
    return () => {
      wall?.removeEventListener("scroll", update);
      window.removeEventListener("resize", update);
    };
  }, [open]);

  /* 自动滚动到最新消息 */
  useEffect(() => {
    listRef.current?.scrollTo({ top: listRef.current.scrollHeight });
  }, [messages, streaming]);

  const toggle = () => {
    if (open) {
      liveRef.current?.abort();
      setStreaming(false);
      setDialogPos(null);
    }
    setOpen((prev) => !prev);
    setError(null);
    // 关闭时清空提及状态
    setMentionAt(null);
  };

  /* 打开其它磁贴（agent/browser）时自动收起对话框 */
  useEffect(() => {
    const onTileOpened = () => {
      setOpen(false);
      setDialogPos(null);
      setMentionAt(null);
    };
    window.addEventListener("momoka:tile-opened", onTileOpened);
    return () => window.removeEventListener("momoka:tile-opened", onTileOpened);
  }, []);

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
      const res = await fetch(`${baseUrl()}/api/agents/${agentId}/chat`, {
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
            setMessages((prev) => {
              const next = [...prev];
              const last = next[next.length - 1];
              if (last?.role === "agent") next[next.length - 1] = { ...last, content: last.content || "" };
              return next;
            });
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
      return;
    }
    if (event.key === "Enter" && !event.shiftKey) {
      event.preventDefault();
      void sendInner(input);
    }
    if (event.key === "Escape" && !mentionAt) {
      toggle();
    }
  };

  const dialog = open && dialogPos
    ? createPortal(
        <div
          className="duty-dialog"
          style={{ left: dialogPos.left, top: dialogPos.top, width: 330, maxHeight: "min(60vh, 460px)" }}
          ref={(el) => el?.focus()}
          /* 治本：portal 的 React 合成事件会沿 React 树冒泡到 .tile-shell（onMouseDown=拖拽、onClick=展示），
             必须在此隔离，否则点 ×/输入框都会被磁贴壳层吞掉（无法关闭/无法聚焦输入） */
          onMouseDown={(event) => event.stopPropagation()}
          onMouseUp={(event) => event.stopPropagation()}
          onClick={(event) => event.stopPropagation()}
          onDoubleClick={(event) => event.stopPropagation()}
          onPointerDown={(event) => event.stopPropagation()}
          onPointerUp={(event) => event.stopPropagation()}
          onKeyDown={(event) => event.stopPropagation()}
          onTouchStart={(event) => event.stopPropagation()}
        >
          <div className="duty-dialog__header">
            <span className="duty-dialog__title">值日生</span>
            <div className="duty-dialog__actions">
              <button
                type="button"
                className="duty-dialog__close"
                aria-label="打开完整窗口"
                title="打开完整窗口（DutyWindow）"
                disabled={!dutyAgent}
                onClick={() => {
                  setOpen(false);
                  setShowWindow(true);
                }}
              >
                窗口 ↗
              </button>
              <button type="button" className="duty-dialog__close" aria-label="关闭" onClick={toggle}>
                ×
              </button>
            </div>
          </div>
          <div className="duty-dialog__list" ref={listRef}>
            {messages.length === 0 && !streaming ? (
              <div className="duty-dialog__welcome">{DUTY_WELCOME}</div>
            ) : null}
            {messages.map((m, index) => (
              <div key={index} className={`duty-dialog__msg duty-dialog__msg--${m.role}`}>
                {m.content || (m.role === "agent" && streaming && index === messages.length - 1 ? "…" : "") ? (
                  tokenizeLinkRefs(m.content || (m.role === "agent" && streaming && index === messages.length - 1 ? "…" : "")).map((part, partIndex) =>
                    part.ref ? (
                      <button
                        key={partIndex}
                        type="button"
                        className="duty-dialog__link"
                        title="点击打开会话"
                        onClick={(event) => {
                          event.stopPropagation();
                          openRefTarget(part.ref!.raw, part.ref!.kind);
                        }}
                      >
                        <span className="duty-dialog__link-icon">↗</span>
                        {part.ref.kind === "ses" ? "会话" : "Agent"}·{part.ref.raw.slice(4).slice(0, 6)}
                      </button>
                    ) : (
                      <span key={partIndex}>{part.text}</span>
                    ),
                  )
                ) : null}
              </div>
            ))}
            {streaming ? <div className="duty-dialog__typing">值日生正在调度…</div> : null}
            {error ? <div className="duty-dialog__error">{error}</div> : null}
          </div>
          <div className="duty-dialog__composer">
            <input
              ref={inputRef}
              className="duty-dialog__input"
              value={input}
              onChange={onInputChange}
              onKeyDown={onKeyDown}
              disabled={!agentId}
              placeholder={agentId ? "输入指令，& 引用会话…" : "正在唤醒值日生…"}
            />
            {mentionAt && candidates.length > 0 ? (
              <ul className="duty-dialog__mention" role="listbox" aria-label="引用会话">
                {candidates.map((session, index) => (
                  <li
                    key={session.id}
                    role="option"
                    aria-selected={index === mentionAt.index}
                    className={`duty-dialog__mention-item${index === mentionAt.index ? " duty-dialog__mention-item--active" : ""}`}
                    onMouseDown={(event) => {
                      event.preventDefault();
                      applyMention(session.id);
                    }}
                  >
                    <span className="duty-dialog__mention-name">{session.name ?? session.id}</span>
                    <span className="duty-dialog__mention-goal">{session.goal ?? ""}</span>
                  </li>
                ))}
              </ul>
            ) : null}
            <button type="button" className="duty-dialog__send" disabled={!agentId || streaming || !input.trim()} onClick={() => void sendInner(input)}>
              {streaming ? "·" : "发送"}
            </button>
          </div>
        </div>,
        document.body,
      )
    : null;

  return (
    <div className="duty-girl" ref={rootRef}>
      <button type="button" className="duty-girl__hit" onClick={toggle} aria-label="打开值日生对话框">
        <span className="duty-girl__portrait" aria-hidden="true">
          <span className="duty-girl__fallback">立绘待提供</span>
        </span>
        <span className="duty-girl__badge">值日生</span>
      </button>
      {dialog}
      {showWindow && dutyAgent
        ? createPortal(
            <div
              className="duty-window-overlay"
              onMouseDown={(event) => event.stopPropagation()}
              onMouseUp={(event) => event.stopPropagation()}
              onClick={(event) => event.stopPropagation()}
            >
              <AgentWindow agent={dutyAgent} onClose={() => setShowWindow(false)} />
            </div>,
            document.body,
          )
        : null}
    </div>
  );
}