import { useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";

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
  role: "user" | "agent";
  content: string;
}

interface SessionCandidate {
  id: string;
  name?: string;
  goal?: string;
}

const DUTY_AGENT_NAME = "值日生";
const DUTY_AGENT_KEY = "momoka:duty:agentId";
const DUTY_WELCOME = "老师好～我是值日生。复杂的事情交给我来调度吧，直接说就好！";

/** 与后端 src/agent-registry.ts DISPATCHER_SYSTEM_PROMPT 保持一致的前端副本（创建走 /api/agents system 字段）。 */
const DUTY_SYSTEM_PROMPT = `你是「值日生」（Duty Girl）——MOMOKA 桌面的调度者 AI，外表设定为《蔚蓝档案》风格的学生，性格温柔可靠、乐于帮忙。

职责与行为：
1. 日常对话：保持角色扮演自然回应即可，不必呼叫工具。
2. 遇到复杂任务时切换到“调度模式”：
   - 先用 search_sessions / inspect_session / search_content 调查现有会话资源，确认有哪些可复用的上下文；
   - 用资源句柄 &ses_<id> / &tile_<agentId> 链接相关会话，并在下发给执行者的指令里带上句柄，让被调度者能引用（ampersand 链接）；
   - 通过 run_momoka_cli 调用 MOMOKA CLI 真实驱动其它 Agent：agent create 创建执行者、agent chat 向执行者下发含句柄的任务、agent reset / stop 管理执行者；
   - 汇报时给出使用的会话句柄，简要说明调度了谁、做了什么、结果如何。

安全边界：run_momoka_cli 只允许 MOMOKA 文档化的子命令；不要用它或其它工具触碰无关文件与服务端配置。`;

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
        body: JSON.stringify({ name: DUTY_AGENT_NAME, system: DUTY_SYSTEM_PROMPT }),
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

  const rootRef = useRef<HTMLDivElement | null>(null);
  const inputRef = useRef<HTMLInputElement | null>(null);
  const listRef = useRef<HTMLDivElement | null>(null);
  const liveRef = useRef<{ abort: () => void } | null>(null);

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
            <button type="button" className="duty-dialog__close" aria-label="关闭" onClick={toggle}>
              ×
            </button>
          </div>
          <div className="duty-dialog__list" ref={listRef}>
            {messages.length === 0 && !streaming ? (
              <div className="duty-dialog__welcome">{DUTY_WELCOME}</div>
            ) : null}
            {messages.map((m, index) => (
              <div key={index} className={`duty-dialog__msg duty-dialog__msg--${m.role}`}>
                {m.content || (m.role === "agent" && streaming && index === messages.length - 1 ? "…" : "")}
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
    </div>
  );
}