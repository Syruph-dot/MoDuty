import { memo, useCallback, useEffect, useMemo, useRef, useState } from "react";

import { awaitApiBase, cancelAgentChat, resetAgentChat } from "../lib/api";
import { runChatStream } from "../lib/chatStream";
import { renderMarkdown } from "../lib/markdown";
import { consumeJump, requestJump } from "../lib/sessionJump";
import { buildMessageSequence, isContextOnlyMessage } from "../lib/sessionMessages";
import { useEdgeOverscroll } from "../lib/edgeOverscroll";
import { usePendingQuestions } from "../hooks/useDutyData";
import QuestionCard from "./ui/QuestionCard";
import QuestionRecap from "./ui/QuestionRecap";
import { IconClose, IconDownload, IconGear, IconSearch, IconThought } from "./ui/icons";
import AgentWindowTabs, { type TabItem, type TabSubject } from "./AgentWindowTabs";
import BrowserView from "./BrowserView";
import { MessageMinimap } from "./MessageMinimap";
import { useAgentRelations } from "../hooks/useAgentRelations";
import { useBrowserStore } from "../state/browserStore";
import { useAgentsStore } from "../state/agentsStore";
import type { Agent } from "../types";

interface StoredMessage {
  id?: string;
  role: string;
  content: string;
  timestamp: string;
  /** 流式消息状态：streaming / done / stopped / error（缺省 = 已完成的旧消息） */
  status?: string;
  /** 落盘工具调用（snake: tool_calls；兼容 camel: toolCalls） */
  toolCalls?: Array<{ tool: string; args: string; result: string }>;
  tool_calls?: Array<{ tool: string; args: string; result: string }>;
  /**
   * 仅作上下文注入：落盘给模型看，对话视图跳过。
   * 例：ask_question 的答案摘要（用户看到的是问答卡里的回看，不是“自己发的消息”）。
   */
  contextOnly?: boolean;
  /** 模型思考过程（上游 reasoning 累积，随消息落盘） */
  reasoning?: string;
  /** 产出这条消息的模型名（随消息落盘，消息头展示） */
  model?: string;
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

/** GET /api/sessions/search 返回的命中项（matchedTurns 为 transcript turn 区间） */
interface SessionSearchHit {
  id: string;
  name: string;
  score: number;
  matchedTurns: Array<[number, number]>;
  snippet: string;
  workspace: string;
  archived: boolean;
  compact_handoff_match?: boolean;
  compact_covered_turn_count?: number;
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
  /** 落盘消息 id（用户消息可编辑/截断分叉） */
  messageId?: string;
  /** 仅从磁盘恢复的历史用户消息可编辑 */
  userEditable?: boolean;
  /** 推理/思考内容（流式累积，独立于 content） */
  reasoning?: string;
  /** 消息时间（ISO；消息头展示 HH:MM） */
  timestamp?: string;
  /** 产出这条消息的模型名（消息头展示） */
  model?: string;
  toolCard?: {
    name: string;
    args: string;
    status: "running" | "done";
    result?: string;
    collapsed: boolean;
  };
}

interface CompactHandoffView {
  id: string;
  coveredThroughMessageId: string;
  coveredTurnCount: number;
  handoff: string;
  sourceRefs: string[];
  createdAt: string;
}


/** 消息头：模型名 + 时间（对齐 Proma 的 MessageHeader；用户消息不显示） */
function MessageMeta({ message }: { message: DisplayMessage }): React.ReactElement | null {
  if (message.role !== "agent") return null;
  const clock = formatClock(message.timestamp);
  if (!message.model && !clock) return null;
  return (
    <div className="msg__meta">
      {message.model ? <span className="msg__model">{message.model}</span> : null}
      {clock ? <span className="msg__time">{clock}</span> : null}
    </div>
  );
}

/** ISO 时间 → 本地 HH:MM（消息头用） */
function formatClock(iso?: string): string {
  if (!iso) return "";
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return "";
  return `${String(date.getHours()).padStart(2, "0")}:${String(date.getMinutes()).padStart(2, "0")}`;
}

/**
 * 单条消息（memo 化）：流式 token 只更新流式那条消息的 content，
 * 历史消息 props 不变 → 跳过重渲染；markdown 解析按 content 缓存，每 token 只解析流式文本。
 */
const MessageItem = memo(function MessageItem({
  message,
  onToggleTool,
  onStartEdit,
  isEditing,
  editDraft,
  onEditDraftChange,
  onEditSave,
  onEditCancel,
  jump = false,
  /** 该消息正在流式生成：思考过程自动展开 */
  reasoningLive = false,
  agentId,
  pendingQuestionSets,
  answeredQuestionSets,
  onQuestionAnswered,
}: {
  message: DisplayMessage;
  onToggleTool: (key: string) => void;
  /** hover 用户消息 → 编辑/从此截断重发 */
  onStartEdit: (message: DisplayMessage) => void;
  isEditing: boolean;
  editDraft: string;
  onEditDraftChange: (value: string) => void;
  onEditSave: () => void;
  onEditCancel: () => void;
  /** 检索命中闪动高亮 */
  jump?: boolean;
  /** 该消息正在流式生成（思考过程块自动展开） */
  reasoningLive?: boolean;
  /** 归属 Agent（提问卡提交答案需要） */
  agentId: string;
  /** 仍在等待作答的问题集：setId → 题目。命中时工具卡内渲染可交互问答 */
  pendingQuestionSets: Map<string, Array<{ prompt: string; options: string[] }>>;
  /** 已作答的问题集：setId → 题目 + 我的作答。命中时工具卡内渲染只读回看 */
  answeredQuestionSets: Map<string, { prompt: string; options: string[]; answers?: Array<{ questionIndex: number; choiceIndex: number; customText?: string }> }[]>;
  /** 作答成功后的收尾（折叠卡片 + 刷新问题集） */
  onQuestionAnswered: (key: string) => void;
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
    const isAskQuestion = tc.name === "ask_question";
    const parsedQuestions = isAskQuestion ? parseAskQuestionArgs(tc.args) : [];
    // args 是对象数组，shortArgs 只能得到 "questions=[object Object]"，这里换成可读的题数
    const argsLabel = isAskQuestion && parsedQuestions.length > 0
      ? `${parsedQuestions.length} 题`
      : shortArgs(tc.args);
    // 只有问题集仍在 pending 时才渲染可交互卡片（答过/已失效的退回普通工具卡）
    const questionSetId = isAskQuestion ? pendingQuestionSetId(tc.result) : undefined;
    const pendingQuestions = questionSetId ? pendingQuestionSets.get(questionSetId) : undefined;
    const answeredQuestions = questionSetId && !pendingQuestions ? answeredQuestionSets.get(questionSetId) : undefined;
    // 作答后仍按题目/作答原样回看：优先用服务端返回的已答集合，取不到才退回工具结果文本
    const recapQuestions = !pendingQuestions && answeredQuestions ? answeredQuestions : undefined;
    const statusLabel = isAskQuestion && !pendingQuestions && questionSetId ? " · 已作答" : "";
    // 交互/回看卡都要按内容自适应高度，不能被工具结果的 200px 折叠上限裁掉
    const interactiveBody = Boolean(pendingQuestions || recapQuestions);
    return (
      <div
        className={`tool-card${tc.collapsed ? " tool-card--collapsed" : ""}${jump ? " tool-card--jump" : ""}`}
        data-mk={message.key}
        onClick={() => onToggleTool(message.key)}
        role="button"
        tabIndex={0}
        onKeyDown={(e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); onToggleTool(message.key); } }}
      >
        <div className="tool-card__head">
          <span className={`tool-card__dot tool-card__dot--${tc.status}`} aria-hidden="true" />
          <span className="tool-card__name">{tc.name}</span>
          <span className="tool-card__args">{argsLabel}{statusLabel}</span>
          <span className="tool-card__toggle" aria-hidden="true">{tc.collapsed ? "▶" : "▼"}</span>
        </div>
        {/* 卡体内点击不能冒泡到卡头，否则会在作答时把卡片折叠掉 */}
        <div
          className={`tool-card__body${interactiveBody ? " tool-card__body--interactive" : ""}`}
          onClick={pendingQuestions ? (event) => event.stopPropagation() : undefined}
        >
          {pendingQuestions ? (
            <QuestionCard
              agentId={agentId}
              setId={questionSetId}
              questions={pendingQuestions}
              onAnswered={() => onQuestionAnswered(message.key)}
            />
          ) : recapQuestions ? (
            <QuestionRecap
              questions={recapQuestions.map((item) => ({ prompt: item.prompt, options: item.options }))}
              answers={recapQuestions.flatMap((item) => item.answers ?? [])}
            />
          ) : tc.result ? (
            <pre className="tool-card__result">{tc.result.length > 500 ? `${tc.result.slice(0, 500)}…` : tc.result}</pre>
          ) : null}
        </div>
      </div>
    );
  }

  // 用户消息 = 纯文本（保留换行，由 .msg__bubble 的 white-space: pre-wrap 呈现），
  // 不走 markdown：避免纯文本被 marked 包成 <p> 段落 + 尾随换行造成前后空行。
  if (message.role === "user") {
    if (isEditing) {
      const rowCount = Math.max(2, Math.min(10, editDraft.split("\n").length + 1));
      return (
        <div className={`msg msg--${message.role}`} data-mk={message.key}>
          <div className="msg__edit">
            <textarea
              className="msg__edit-input"
              value={editDraft}
              rows={rowCount}
              autoFocus
              onChange={(event) => onEditDraftChange(event.target.value)}
              onKeyDown={(event) => {
                if ((event.metaKey || event.ctrlKey) && event.key === "Enter") {
                  event.preventDefault();
                  onEditSave();
                }
              }}
            />
            <div className="msg__edit-actions">
              <button type="button" className="btn btn--ghost btn--sm" onClick={onEditCancel}>
                取消
              </button>
              <button type="button" className="btn btn--primary btn--sm" onClick={onEditSave} disabled={!editDraft.trim()}>
                保存并从此重发
              </button>
            </div>
            <span className="msg__edit-hint">保存后将截断此条及之后的所有内容，以新内容重新发送（分叉）</span>
          </div>
        </div>
      );
    }
    return (
      <div
        className={`msg msg--${message.role}${message.userEditable ? " msg--editable" : ""}${jump ? " msg--jump" : ""}`}
        data-mk={message.key}
      >
        <div className="msg__hover-actions">
          {message.userEditable ? (
            <button
              type="button"
              className="msg__edit-btn"
              onClick={() => onStartEdit(message)}
              aria-label="编辑此消息并从此截断重发"
            >
              ✎ 编辑/从此重发
            </button>
          ) : null}
        </div>
        <div className="msg__bubble">{message.content}</div>
      </div>
    );
  }

  return (
    <div className={`msg msg--${message.role}${jump ? " msg--jump" : ""}`} data-mk={message.key}>
      <MessageMeta message={message} />
      <div className="msg__bubble" dangerouslySetInnerHTML={{ __html: html }} />
      {message.reasoning ? (
        // 流式中自动展开（能看着它想），流完自动收起（点开可回看）
        <details className="msg__reasoning" {...(reasoningLive ? { open: true } : {})}>
          <summary className="msg__reasoning-summary">
            <IconThought />
            <span>思考过程{reasoningLive ? "（进行中…）" : ""}</span>
            <span className="msg__reasoning-toggle" aria-hidden="true" />
          </summary>
          <div className="msg__reasoning-content">{message.reasoning}</div>
        </details>
      ) : null}
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

/** 解析 ask_question 的工具参数（题干 + 选项）；解析不出返回空数组 */
function parseAskQuestionArgs(args: string): Array<{ prompt: string; options: string[] }> {
  try {
    const parsed = JSON.parse(args) as { questions?: Array<{ prompt?: unknown; options?: unknown }> };
    const list = Array.isArray(parsed.questions) ? parsed.questions : [];
    const result: Array<{ prompt: string; options: string[] }> = [];
    for (const item of list) {
      const prompt = String(item?.prompt ?? "").trim();
      const options = Array.isArray(item?.options) ? item.options.map((option) => String(option)) : [];
      if (prompt && options.length >= 1) result.push({ prompt, options });
    }
    return result;
  } catch {
    return [];
  }
}

/** 从 ask_question 的工具结果里取待答问题集 id（形如 qst_xxx） */
function pendingQuestionSetId(result?: string): string | undefined {
  if (!result) return undefined;
  return result.match(/pending question: (qst_[A-Za-z0-9_]+)/)?.[1];
}

/** 嵌入分屏窗口：作为展开磁贴内容（由 TileShell 定位），header 可拖拽，× 或拖到左坞收起 */
/**
 * 嵌入分屏窗口：作为展开磁贴内容（由 TileShell 定位），header 可拖拽，× 收起。
 *
 * 头部标签页条（AgentWindowTabs）替代了旧的「左坞列下属磁贴」：
 *   - 点击下属标签 = 在这个窗口里换内容（同窗口导航，不新开窗）；
 *   - 拖离标签条松手 = 为它另开一个窗口，本窗口内容不变；
 *   - 内容为浏览器时渲染 BrowserView；为别的 Agent 时嵌一个无外壳的自身实例（embedded）。
 */
export default function AgentWindow({
  agent,
  onClose,
  embedded = false,
  onHeaderDoubleClick,
}: {
  agent: Agent;
  onClose: () => void;
  /** 作为下钻内容嵌入别的窗口时：不画窗口外壳与标签条（由外层提供），仅保留操作按钮 */
  embedded?: boolean;
  /** 双击标题栏：把视口平滑滚到本窗口所在 X（多窗口横向铺开时用来定位） */
  onHeaderDoubleClick?: () => void;
}) {
  /** 用户是否贴着底部：贴着才自动跟随，否则不打扰他正在看的位置 */
  const userPinnedRef = useRef(true);
  useEffect(() => {
    const el = listRef.current;
    if (!el) return;
    const onScroll = (): void => {
      userPinnedRef.current = el.scrollHeight - el.scrollTop - el.clientHeight < 80;
    };
    el.addEventListener("scroll", onScroll, { passive: true });
    return () => el.removeEventListener("scroll", onScroll);
  }, []);
  const [messages, setMessages] = useState<DisplayMessage[]>([]);
  const [compactCheckpoint, setCompactCheckpoint] = useState<CompactHandoffView | null>(null);
  const [compactBusy, setCompactBusy] = useState(false);
  const [compactError, setCompactError] = useState<string | null>(null);
  const [compactErrorCanRetry, setCompactErrorCanRetry] = useState(false);
  const [redirectReady, setRedirectReady] = useState(false);
  const [redirectPath, setRedirectPath] = useState(`.momoka/handoffs/${agent.session_id}.md`);
  const [redirectBusy, setRedirectBusy] = useState(false);
  const [redirectPathCopied, setRedirectPathCopied] = useState(false);
  const [handoffExpanded, setHandoffExpanded] = useState(false);
  const [streamError, setStreamError] = useState<string | null>(null);
  const [policyNotice, setPolicyNotice] = useState<string | null>(null);
  const [experienceNotice, setExperienceNotice] = useState<string | null>(null);
  const [input, setInput] = useState("");
  const [streaming, setStreaming] = useState(false);
  const [copied, setCopied] = useState(false);
  const abortRef = useRef<AbortController | null>(null);
  /** 后台流式任务的轮询刷新器（重开窗口时跟随流式落盘） */
  const pollTimerRef = useRef<number | null>(null);
  const listRef = useRef<HTMLDivElement>(null);
  useEdgeOverscroll(listRef); // 消息列表滚到头继续拉：Glow/Stretch（设置页可切）
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const mirrorRef = useRef<HTMLDivElement>(null);
  const [sessions, setSessions] = useState<SessionCandidate[]>([]);
  const [mention, setMention] = useState<Mention | null>(null);
  const [mentionX, setMentionX] = useState(0);
  /** 已选中的会话引用 chips（用于可视化，底层 input 仍存 &ses_<id>） */
  const [mentionChips, setMentionChips] = useState<Array<{ sessionId: string; name: string }>>([]);
  const load = useAgentsStore((state) => state.load);
  const openAgent = useAgentsStore((state) => state.openAgent);
  const closeAgent = useAgentsStore((state) => state.closeAgent);
  const agents = useAgentsStore((state) => state.agents);
  const browsers = useBrowserStore((state) => state.browsers);
  const openBrowser = useBrowserStore((state) => state.openBrowser);
  /**
   * 当前显示对象栈。栈首恒为磁贴自己的 Agent：
   * 点下属标签 = 入栈（同窗口换内容）；首标签 = 出栈（返回上一级）；拖出标签 = 另开窗口（不动栈）。
   */
  const [subjectStack, setSubjectStack] = useState<Array<{ kind: "agent" | "browser"; id: string }>>([
    { kind: "agent", id: agent.id },
  ]);
  const subject = subjectStack[subjectStack.length - 1];
  const subjectAgent = subject.kind === "agent" ? agents.find((item) => item.id === subject.id) ?? null : null;
  const subjectBrowser = subject.kind === "browser" ? browsers.find((item) => item.id === subject.id) ?? null : null;
  // 嵌入实例不再自己拉关系（标签条由外层画），也避免下钻链上重复请求
  const { relations } = useAgentRelations(embedded || subject.kind !== "agent" ? null : subject.id, agents.length);
  /** 会话导出菜单开关（JSON/MD/TXT） */
  const [exportOpen, setExportOpen] = useState(false);

  const loadCompactHandoff = async (): Promise<void> => {
    try {
      const base = await awaitApiBase();
      const res = await fetch(`${base}/api/agents/${encodeURIComponent(agent.id)}/compact`);
      if (!res.ok) return;
      const data = (await res.json()) as { checkpoint: CompactHandoffView | null };
      setCompactCheckpoint(data.checkpoint);
    } catch {
      // The chat history remains usable when this optional lookup fails.
    }
  };

  const loadRedirectStatus = async (): Promise<void> => {
    try {
      const base = await awaitApiBase();
      const res = await fetch(`${base}/api/agents/${encodeURIComponent(agent.id)}/redirect`);
      const data = (await res.json()) as { ready?: boolean; relativePath?: string };
      setRedirectReady(res.ok && data.ready === true);
      if (typeof data.relativePath === "string" && data.relativePath) setRedirectPath(data.relativePath);
    } catch {
      setRedirectReady(false);
    }
  };

  const redirectConversation = async (): Promise<void> => {
    if (!redirectReady || redirectBusy || streaming) return;
    setRedirectBusy(true);
    setCompactError(null);
    setCompactErrorCanRetry(false);
    try {
      const base = await awaitApiBase();
      const res = await fetch(`${base}/api/agents/${encodeURIComponent(agent.id)}/redirect`, { method: "POST" });
      const data = (await res.json().catch(() => ({}))) as { agent?: Agent; error?: string };
      if (!res.ok || !data.agent) throw new Error(data.error || `Redirect 失败（HTTP ${res.status}）`);
      await load();
      closeAgent(agent.id);
      openAgent(data.agent.id);
    } catch (error) {
      setCompactError(error instanceof Error ? error.message : "Redirect 失败");
      void loadRedirectStatus();
    } finally {
      setRedirectBusy(false);
    }
  };

  const copyRedirectPath = async (): Promise<void> => {
    try {
      await navigator.clipboard.writeText(redirectPath);
      setRedirectPathCopied(true);
      window.setTimeout(() => setRedirectPathCopied(false), 1200);
    } catch {
      setCompactError("无法复制交接路径，请手动选中路径复制。");
      setCompactErrorCanRetry(false);
    }
  };

  const compactConversation = async (): Promise<void> => {
    if (compactBusy || streaming) return;
    setCompactBusy(true);
    setCompactError(null);
    setCompactErrorCanRetry(false);
    try {
      const base = await awaitApiBase();
      for (let attempt = 0; attempt < 2; attempt += 1) {
        const res = await fetch(`${base}/api/agents/${encodeURIComponent(agent.id)}/compact`, { method: "POST" });
        const data = (await res.json().catch(() => ({}))) as {
          checkpoint?: CompactHandoffView;
          error?: string;
        };
        if (!res.ok) {
          const message = data.error || `Compact 失败（HTTP ${res.status}）`;
          if (attempt === 0 && /returned an empty handoff/iu.test(message)) continue;
          throw new Error(localizeCompactError(message, attempt > 0));
        }
        if (!data.checkpoint) throw new Error("Compact 未返回摘要；原始 transcript 未修改，可重试。");
        setCompactCheckpoint(data.checkpoint);
        setHandoffExpanded(true);
        setCompactErrorCanRetry(false);
        return;
      }
    } catch (error) {
      setCompactError(localizeCompactError(error instanceof Error ? error.message : "Compact 失败", true));
      setCompactErrorCanRetry(true);
    } finally {
      setCompactBusy(false);
    }
  };

  const localizeCompactError = (message: string, retried: boolean): string => {
    if (/empty handoff/iu.test(message)) {
      return `压缩模型没有生成有效摘要。原始 transcript 未修改${retried ? "，系统已自动重试一次" : ""}；仍失败时可再次点击 Compact。`;
    }
    if (/transcript was left unchanged|no checkpoint was saved/iu.test(message)) {
      return `Compact 未保存摘要：${message}。原始 transcript 已保留，可重试。`;
    }
    return message;
  };

  /** 下载会话记录：GET /api/sessions/:id/export?format=… → Blob → 浏览器下载 */
  const exportSession = async (format: "json" | "md" | "txt"): Promise<void> => {
    setExportOpen(false);
    try {
      const base = await awaitApiBase();
      const res = await fetch(`${base}/api/sessions/${encodeURIComponent(agent.session_id)}/export?format=${format}`);
      if (!res.ok) {
        throw new Error(`导出失败（HTTP ${res.status}）`);
      }
      const data = (await res.json()) as { filename: string; content: string };
      const mime =
        format === "json"
          ? "application/json"
          : format === "md"
            ? "text/markdown;charset=utf-8"
            : "text/plain;charset=utf-8";
      const blob = new Blob([data.content], { type: mime });
      const url = URL.createObjectURL(blob);
      const anchor = document.createElement("a");
      anchor.href = url;
      anchor.download = data.filename;
      document.body.appendChild(anchor);
      anchor.click();
      anchor.remove();
      URL.revokeObjectURL(url);
    } catch (error) {
      setStreamError(error instanceof Error ? error.message : "导出失败");
    }
  };

  /** 用户消息原地编辑（截断分叉重发）状态 */
  const [editingMessageId, setEditingMessageId] = useState<string | null>(null);
  const [editDraft, setEditDraft] = useState("");
  /** 会话内检索（命中 → 跳转定位高亮） */
  const [searchOpen, setSearchOpen] = useState(false);
  const [searchQuery, setSearchQuery] = useState("");
  const [searching, setSearching] = useState(false);
  const [searchMsg, setSearchMsg] = useState("");
  const [searchHits, setSearchHits] = useState<SessionSearchHit[]>([]);
  /** 检索命中闪动高亮的消息 key 集合 */
  const [jumpKeys, setJumpKeys] = useState<ReadonlySet<string>>(() => new Set());
  /** per-agent System Prompt（role）编辑器 */
  const [roleOpen, setRoleOpen] = useState(false);
  const [roleDraft, setRoleDraft] = useState("");
  const [roleSaving, setRoleSaving] = useState(false);
  const [roleError, setRoleError] = useState("");
  /** 选中消息片段 → 生成 &msg_ 引用块 */
  const [quote, setQuote] = useState<{ x: number; y: number; text: string; messageId: string } | null>(null);

  const startEdit = (message: DisplayMessage): void => {
    if (!message.messageId || streaming) return;
    setEditingMessageId(message.messageId);
    setEditDraft(message.content);
  };

  const cancelEdit = (): void => {
    setEditingMessageId(null);
    setEditDraft("");
  };

  /** 保存编辑：截断到该用户消息（含删除该条）→ 重载历史 → 以新内容重发（分叉） */
  const saveEdit = async (): Promise<void> => {
    const messageId = editingMessageId;
    const content = editDraft.trim();
    cancelEdit();
    if (!messageId || !content) return;
    try {
      const base = await awaitApiBase();
      const res = await fetch(`${base}/api/agents/${encodeURIComponent(agent.id)}/messages/truncate`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ messageId }),
      });
      if (!res.ok) {
        throw new Error(`截断失败（HTTP ${res.status}）`);
      }
      await reloadMessages();
    } catch (error) {
      setStreamError(error instanceof Error ? error.message : "截断失败");
      return;
    }
    await sendText(content);
  };

  /** 滚动定位到第 turn 条用户消息并闪动高亮 */
  const jumpToTurn = (turn: number): void => {
    let count = 0;
    let target: DisplayMessage | null = null;
    for (const message of messages) {
      if (message.role === "user") {
        count += 1;
        if (count === turn) {
          target = message;
          break;
        }
      }
    }
    if (!target) return;
    const key = target.key;
    setJumpKeys((prev) => new Set(prev).add(key));
    window.setTimeout(() => {
      setJumpKeys((prev) => {
        const next = new Set(prev);
        next.delete(key);
        return next;
      });
    }, 2600);
    requestAnimationFrame(() => {
      const listEl = listRef.current;
      if (!listEl) return;
      const itemEl = listEl.querySelector(`[data-mk="${CSS.escape(key)}"]`);
      itemEl?.scrollIntoView({ block: "center", behavior: "smooth" });
    });
  };

  const toggleSearch = (): void => {
    setSearchOpen((open) => !open);
    setSearchHits([]);
    setSearchMsg("");
  };

  /** 打开 System Prompt 编辑器：拉取当前 role 作为草稿 */
  const openRoleEditor = async (): Promise<void> => {
    setRoleError("");
    if (!roleOpen) {
      try {
        const base = await awaitApiBase();
        const res = await fetch(`${base}/api/agents/${encodeURIComponent(agent.id)}/role`);
        if (!res.ok) {
          throw new Error(`读取失败（HTTP ${res.status}）`);
        }
        const data = (await res.json()) as { role: string };
        setRoleDraft(data.role ?? "");
      } catch (error) {
        setRoleError(error instanceof Error ? error.message : "读取 role 失败");
      }
    }
    setRoleOpen((open) => !open);
  };

  /** 保存 role：PUT /api/agents/:id/role → 刷新 agent 列表 */
  const saveRole = async (): Promise<void> => {
    const role = roleDraft.trim();
    if (!role || roleSaving) return;
    setRoleSaving(true);
    setRoleError("");
    try {
      const base = await awaitApiBase();
      const res = await fetch(`${base}/api/agents/${encodeURIComponent(agent.id)}/role`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ role }),
      });
      if (!res.ok) {
        throw new Error(`保存失败（HTTP ${res.status}）`);
      }
      setRoleOpen(false);
      await load();
    } catch (error) {
      setRoleError(error instanceof Error ? error.message : "保存 role 失败");
    } finally {
      setRoleSaving(false);
    }
  };

  /** 捕获消息列表中的选区：落在 [data-mk] 消息上且能解析出 messageId 才显示引用按钮 */
  const captureQuote = (event: React.MouseEvent<HTMLDivElement>): void => {
    const target = event.target as HTMLElement | null;
    if (target?.closest("textarea, input, .agent-window__composer")) {
      setQuote(null);
      return;
    }
    const selection = window.getSelection();
    if (!selection || selection.isCollapsed || selection.rangeCount === 0) {
      setQuote(null);
      return;
    }
    const text = selection.toString().trim();
    if (text.length < 2 || text.length > 600) {
      setQuote(null);
      return;
    }
    const anchorNode = selection.anchorNode?.nodeType === Node.TEXT_NODE ? selection.anchorNode.parentElement : (selection.anchorNode as HTMLElement | null);
    const mkEl = anchorNode?.closest?.("[data-mk]") as HTMLElement | null;
    if (!mkEl) return;
    const key = mkEl.dataset.mk ?? "";
    const message = messages.find((candidate) => candidate.key === key);
    const messageId = message?.messageId;
    if (!messageId) return;
    const rect = selection.getRangeAt(0).getBoundingClientRect();
    const vw = window.innerWidth;
    const vh = window.innerHeight;
    let x = Math.max(8, rect.right - 70);
    let y = Math.max(8, rect.bottom + 8);
    if (x + 150 > vw) x = vw - 158;
    if (y + 34 > vh) y = Math.max(8, rect.top - 42);
    setQuote({ x, y, text, messageId });
  };

  /** 把引用块追加到输入框：&msg_<短id> 「选中文本」；发送时由后端展开源消息全文 */
  const appendQuote = (): void => {
    if (!quote) return;
    const shortId = quote.messageId.startsWith("msg_") ? quote.messageId.slice(4) : quote.messageId;
    const block = `\n\n&msg_${shortId} 「${quote.text}」`;
    setInput((prev) => `${prev}${block}`.trimStart());
    setQuote(null);
    requestAnimationFrame(() => inputRef.current?.focus());
  };

  /** 检索全部会话 transcript（后端 /api/sessions/search 返回 matchedTurns） */
  const runSearch = async (): Promise<void> => {
    const query = searchQuery.trim();
    if (!query) {
      setSearchHits([]);
      setSearchMsg("");
      return;
    }
    setSearching(true);
    setSearchMsg("");
    try {
      const base = await awaitApiBase();
      const res = await fetch(`${base}/api/sessions/search?q=${encodeURIComponent(query)}`);
      if (!res.ok) {
        throw new Error(`检索失败（HTTP ${res.status}）`);
      }
      const data = (await res.json()) as { hits: SessionSearchHit[] };
      setSearchHits(data.hits);
      if (data.hits.length === 0) {
        setSearchMsg("无命中");
      }
    } catch (error) {
      setSearchMsg(error instanceof Error ? error.message : "检索失败");
    } finally {
      setSearching(false);
    }
  };

  /** 命中跳转：当前会话 → 原地滚动高亮；其他会话 → 打开对应 Agent 窗口后跳转 */
  const jumpFromHit = async (hit: SessionSearchHit): Promise<void> => {
    const latestTurn = hit.matchedTurns.length > 0 ? hit.matchedTurns[hit.matchedTurns.length - 1]![1] : 0;
    if (latestTurn <= 0 && !hit.compact_handoff_match) return;
    if (hit.id === agent.session_id) {
      setSearchOpen(false);
      setSearchQuery("");
      setSearchHits([]);
      if (latestTurn > 0) jumpToTurn(latestTurn);
      else {
        void loadCompactHandoff();
        setHandoffExpanded(true);
      }
      return;
    }
    let targetAgent = agents.find((candidate) => candidate.session_id === hit.id);
    if (!targetAgent) {
      // 本地列表可能落后（值日生/机器人刚在后端建了 Agent）→ 拉一次再找，别直接报找不到
      await useAgentsStore.getState().load();
      targetAgent = useAgentsStore.getState().agents.find((candidate) => candidate.session_id === hit.id);
    }
    if (!targetAgent) {
      setSearchMsg("未找到对应 Agent，无法跳转");
      return;
    }
    if (latestTurn > 0) requestJump({ sessionId: hit.id, turn: latestTurn });
    setSearchOpen(false);
    setSearchQuery("");
    setSearchHits([]);
    if (useAgentsStore.getState().openAgentIds.includes(targetAgent.id)) {
      // 目标窗口已打开：强制重载历史触发 consume 效果
      void reloadMessages();
    } else {
      openAgent(targetAgent.id);
    }
  };

  // 打开/恢复目标会话后消费一次跳转（配合 sessionJump 总线）
  useEffect(() => {
    if (messages.length === 0) return;
    const turn = consumeJump(agent.session_id);
    if (turn !== null) {
      jumpToTurn(turn);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [messages, agent.session_id]);

  const reloadMessages = async (): Promise<StoredMessage[]> => {
    try {
      const base = await awaitApiBase();
      const res = await fetch(`${base}/api/agents/${encodeURIComponent(agent.id)}/messages`);
      if (!res.ok) {
        return [];
      }
      const data = (await res.json()) as { messages: StoredMessage[] };
      void loadCompactHandoff();
      void loadRedirectStatus();
      // 落盘消息 → 展示消息：按 timeline 还原工具卡片与文本段的真实交错顺序
      // （关闭重开 / onDone 全量重建时与实时 SSE 渲染保持一致；已完成工具默认折叠）
      const restored: DisplayMessage[] = [];
      data.messages.forEach((message, index) => {
        // 仅上下文注入的消息（如 ask_question 的答案摘要）不进对话视图
        if (isContextOnlyMessage(message)) return;
        if (message.role !== "agent") {
          const isUser = message.role === "user";
          restored.push({
            key: `${message.timestamp}-${message.role}-${index}`,
            role: isUser ? "user" : "agent",
            content: message.content,
            status: message.status,
            timestamp: message.timestamp,
            ...(message.id ? { messageId: message.id } : {}),
            ...(isUser ? { userEditable: true } : {}),
          });
          return;
        }
        const seq = buildMessageSequence(message);
        // 思考过程属于「这一条消息」，但消息会被拆成多个展示项（工具卡 / 文本段）：
        // 挂在第一项上，避免重复渲染
        const reasoningPatch = message.reasoning ? { reasoning: message.reasoning } : {};
        seq.forEach((item, seqIndex) => {
          const attachReasoning = seqIndex === 0 ? reasoningPatch : {};
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
              ...(message.id ? { messageId: message.id } : {}),
              ...attachReasoning,
            });
          } else {
            restored.push({
              key: `agent-restored-${message.timestamp}-${index}-${seqIndex}`,
              role: "agent",
              content: item.content,
              status: message.status,
              timestamp: message.timestamp,
              ...(message.model ? { model: message.model } : {}),
              ...(message.id ? { messageId: message.id } : {}),
              ...attachReasoning,
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
    setRedirectReady(false);
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

  /** 离屏 mirror 测 caret X/Y：与 textarea 同字体/同字号/行高，支持多行 */
  const measureCaret = (text: string): { x: number; y: number } => {
    const el = mirrorRef.current;
    if (!el) return { x: 0, y: 0 };
    el.textContent = text;
    return { x: el.offsetWidth + 14, y: el.offsetHeight };
  };

  const onChange = (event: React.ChangeEvent<HTMLTextAreaElement>) => {
    const value = event.target.value;
    setInput(value);
    const caret = event.target.selectionStart ?? value.length;
    const match = value.slice(0, caret).match(/&(\S*)$/);
    if (match) {
      setMention({ active: true, query: match[1] ?? "", start: caret - match[0].length, index: 0 });
      const { x } = measureCaret(value.slice(0, caret));
      setMentionX(x);
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

  const onKeyDown = (event: React.KeyboardEvent<HTMLTextAreaElement>) => {
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
    // Shift+Enter 或 Ctrl+Enter：插入换行符
    if (event.key === "Enter" && (event.shiftKey || event.ctrlKey)) {
      return; // 允许默认行为：插入换行
    }
    // Enter（无修饰键）：发送
    if (event.key === "Enter") {
      event.preventDefault();
      void send();
    }
  };

  /**
   * 自动跟随：只在「多了消息」或「尾部正文变长（流式追加）」时贴到底部。
   * 展开/折叠工具卡既不加消息、也不改正文长度——视图必须留在原处。
   * （原实现依赖整个 messages 引用，展开工具卡会重建数组 ⇒ 每次都把视图拽到最底。）
   */
  const messageCount = messages.length;
  const tailContentLength = messages[messageCount - 1]?.content.length ?? 0;
  useEffect(() => {
    if (!userPinnedRef.current) return;
    const el = listRef.current;
    if (!el) return;
    el.scrollTo({ top: el.scrollHeight });
  }, [messageCount, tailContentLength, streaming]);

  /** 消息导航的数据源：每条消息一行摘要（工具卡用工具名） */
  const minimapItems = useMemo(
    () =>
      messages.map((message) => ({
        id: message.key,
        role: message.role,
        preview: (message.role === "tool" ? message.toolCard?.name ?? "工具调用" : message.content)
          .replace(/\s+/gu, " ")
          .trim()
          .slice(0, 160),
      })),
    [messages],
  );

  // 切换 tool card 折叠/展开（useCallback 保持稳定引用，配合 MessageItem memo）
  const toggleToolCollapsed = useCallback((key: string) => {
    setMessages((prev) =>
      prev.map((m) =>
        m.key === key && m.toolCard ? { ...m, toolCard: { ...m.toolCard, collapsed: !m.toolCard.collapsed } } : m,
      ),
    );
  }, []);

  // 待答桌面提问：以服务端问题集为准（已作答的不再可答），SSE 变化即刷新
  // includeAnswered：已作答的集合也要带回来，工具卡才能原样回看题目与作答
  const { sets: questionSets, refresh: refreshQuestions } = usePendingQuestions(agent.id, {
    includeAnswered: true,
  });
  // 依赖内容签名而非数组引用：20s 轮询返回同样内容时保持 Map 引用稳定，避免 MessageItem 全量重渲染
  const pendingQuestionSignature = useMemo(
    () =>
      questionSets
        .filter((set) => set.status === "pending")
        .map((set) => `${set.id}:${set.questions.map((question) => question.prompt).join("|")}`)
        .join("||"),
    [questionSets],
  );
  const pendingQuestionSets = useMemo(() => {
    const map = new Map<string, Array<{ prompt: string; options: string[] }>>();
    for (const set of questionSets) {
      if (set.status === "pending") map.set(set.id, set.questions);
    }
    return map;
  }, [pendingQuestionSignature]);

  // 已作答集合：setId → 题目（questions 与 answers 一一对应）
  const answeredQuestionSignature = useMemo(
    () =>
      questionSets
        .filter((set) => set.status === "answered")
        .map((set) => `${set.id}:${set.answers?.map((a) => `${a.questionIndex}=${a.choiceIndex}:${a.customText ?? ""}`).join(",") ?? ""}`)
        .join("||"),
    [questionSets],
  );
  const answeredQuestionSets = useMemo(() => {
    const map = new Map<
      string,
      Array<{ prompt: string; options: string[]; answers?: Array<{ questionIndex: number; choiceIndex: number; customText?: string }> }>
    >();
    for (const set of questionSets) {
      if (set.status !== "answered") continue;
      map.set(
        set.id,
        set.questions.map((question, index) => ({
          prompt: question.prompt,
          options: question.options,
          answers: set.answers?.filter((answer) => answer.questionIndex === index),
        })),
      );
    }
    return map;
  }, [answeredQuestionSignature]);

  // 作答完成：收起该工具卡并重拉问题集（已答的集合随之退出 pending）
  const onQuestionAnswered = useCallback((key: string) => {
    setMessages((prev) =>
      prev.map((m) => (m.key === key && m.toolCard ? { ...m, toolCard: { ...m.toolCard, collapsed: true } } : m)),
    );
    refreshQuestions();
  }, [refreshQuestions]);

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
    setPolicyNotice(null);
    setExperienceNotice(null);
    setMessages((prev) => [...prev, { key: `user-${Date.now()}`, role: "user", content: trimmed, timestamp: new Date().toISOString() }]);
    setRedirectReady(false);
    setStreaming(true);
    stopPolling(); // 有后台轮询时先停掉，由 SSE 接管实时更新
    const controller = new AbortController();
    abortRef.current = controller;
    const TIMEOUT_MS = 5 * 60 * 1000; // 5 分钟无响应视为超时
    const combinedSignal = AbortSignal.any([controller.signal, AbortSignal.timeout(TIMEOUT_MS)]);
    let currentAgentKey = `agent-${Date.now()}`;
    setMessages((prev) => [...prev, { key: currentAgentKey, role: "agent", content: "", timestamp: new Date().toISOString() }]);
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
          onReasoning: (chunk) => {
            // 推理内容直接追加到当前 agent 消息的 reasoning 字段
            setMessages((prev) =>
              prev.map((m) =>
                m.key === currentAgentKey
                  ? { ...m, reasoning: (m.reasoning ?? "") + chunk }
                  : m,
              ),
            );
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
          onPolicyNotice: (notice) => setPolicyNotice(notice),
          onExperienceRecall: (notice) => setExperienceNotice(notice),
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

  /* ---------------- 标签页条：首标签（返回/自身）+ 当前对象 + 出边子项 ---------------- */

  const labelOf = (kind: "agent" | "browser", id: string): string =>
    kind === "browser" ? browsers.find((item) => item.id === id)?.name ?? id : agents.find((item) => item.id === id)?.name ?? id;
  const stateOf = (kind: "agent" | "browser", id: string): string | null =>
    kind === "browser" ? browsers.find((item) => item.id === id)?.state ?? null : agents.find((item) => item.id === id)?.state ?? null;

  /** 首标签：出栈（更深）> 返回上级（最上层且有上级）> 锁定的自身标签 */
  const parentInStack = subjectStack.length > 1 ? subjectStack[subjectStack.length - 2] : null;
  const selfName = labelOf(subject.kind, subject.id) || agent.name;
  const leadTab: TabItem = parentInStack
    ? { key: "lead", label: labelOf(parentInStack.kind, parentInStack.id), icon: "back", title: "返回上一级", selectable: true }
    : relations?.parent
      ? { key: "lead", label: "返回上一级", icon: "back", title: `返回上级：${relations.parent.name}`, selectable: true }
      : {
          key: "lead",
          label: selfName,
          icon: subject.kind === "browser" ? "browser" : "self",
          state: stateOf(subject.kind, subject.id),
          title: `${selfName}（当前窗口）`,
          selectable: false,
        };
  /** 下钻或首标签是「返回」时，当前对象自己也算一个锁定标签——否则「我在看谁」只能靠内容猜 */
  const currentTab: TabItem | null = leadTab.selectable
    ? {
        key: "current",
        label: selfName,
        icon: subject.kind === "browser" ? "browser" : "agent",
        state: stateOf(subject.kind, subject.id),
        title: `${selfName}（当前显示）`,
        selectable: false,
      }
    : null;
  const tabItems: TabItem[] = [
    leadTab,
    ...(currentTab ? [currentTab] : []),
    ...(relations?.children ?? []).map((child) => ({
      key: child.id,
      label: child.name,
      icon: (child.kind === "browser" ? "browser" : "agent") as TabItem["icon"],
      state: child.state,
      title: `${child.name} · 关系来源 ${child.via.join("/")}`,
      selectable: true,
      subject: { kind: child.kind, id: child.id, name: child.name, state: child.state },
    })),
  ];

  /** 点标签：同窗口内换内容（入栈 / 出栈 / 跳到上级） */
  const selectTab = (item: TabItem): void => {
    if (item.key === "lead") {
      if (parentInStack) {
        setSubjectStack((stack) => stack.slice(0, -1));
        return;
      }
      const parent = relations?.parent;
      if (parent) setSubjectStack((stack) => [...stack, { kind: "agent", id: parent.id }]);
      return;
    }
    if (!item.subject) return;
    setSubjectStack((stack) => [...stack, { kind: item.subject!.kind, id: item.subject!.id }]);
  };

  /** 拖出标签条松手：为它另开一个窗口（本窗口内容不变） */
  const detachTab = (target: TabSubject): void => {
    if (target.kind === "browser") openBrowser(target.id);
    else openAgent(target.id);
  };

  /** 内容替换：浏览器 → BrowserView；别的 Agent → 嵌一个无外壳的自身实例；自己的 Agent → 原有内容 */
  const overrideContent =
    subject.kind === "browser" ? (
      subjectBrowser ? (
        <BrowserView browser={subjectBrowser} />
      ) : (
        <p className="agent-window__empty">这个浏览器已经不存在了（可点首标签返回）。</p>
      )
    ) : subject.id !== agent.id ? (
      subjectAgent ? (
        <AgentWindow key={subjectAgent.id} agent={subjectAgent} onClose={onClose} embedded />
      ) : (
        <p className="agent-window__empty">找不到这个 Agent（可能已被删除，可点首标签返回）。</p>
      )
    ) : null;

  return (
    <div className={`agent-window${embedded ? " agent-window--embedded" : ""}`} role="dialog" aria-label={`Agent ${agent.name} 对话窗口`}>
      <header
        className="agent-window__header"
        title="拖动标题栏到左栏可收起；双击可把视口滚到本窗口"
        onDoubleClick={onHeaderDoubleClick}
      >
        {embedded ? null : <AgentWindowTabs items={tabItems} activeKey={currentTab ? "current" : "lead"} onSelect={selectTab} onDetach={detachTab} />}
        <div className="agent-window__header-actions">
          <button
            type="button"
            className="agent-window__tool-btn"
            aria-label="编辑 System Prompt（人格）"
            aria-expanded={roleOpen}
            title="编辑 System Prompt（人格 role）"
            onClick={() => void openRoleEditor()}
            onMouseDown={(event) => event.stopPropagation()}
          >
            <IconGear />
          </button>
          <button
            type="button"
            className="agent-window__tool-btn"
            aria-label="会话内检索"
            aria-expanded={searchOpen}
            title="会话内检索（跨会话命中可跳转）"
            onClick={toggleSearch}
            onMouseDown={(event) => event.stopPropagation()}
          >
            <IconSearch />
          </button>
          {!embedded && subject.kind === "agent" && subject.id === agent.id ? (
            <button
              type="button"
              className="agent-window__compact-btn"
              aria-label="Compact 会话并生成任务交接摘要"
              title="整理较早的完整对话轮次；原始会话记录保留"
              disabled={streaming || agent.state === "running" || compactBusy || messages.length === 0}
              onClick={() => void compactConversation()}
              onMouseDown={(event) => event.stopPropagation()}
            >
              {compactBusy ? "整理中…" : "Compact"}
            </button>
          ) : null}
          {!embedded && subject.kind === "agent" && subject.id === agent.id ? (
            <button
              type="button"
              className="agent-window__compact-btn"
              aria-label="Redirect 到新会话"
              disabled={!redirectReady || redirectBusy || streaming || agent.state === "running"}
              onClick={() => void redirectConversation()}
              onMouseDown={(event) => event.stopPropagation()}
            >
              {redirectBusy ? "跳转中…" : "Redirect"}
            </button>
          ) : null}
          <div className="agent-window__export">
            <button
              type="button"
              className="agent-window__export-btn"
              aria-label="导出会话记录"
              aria-expanded={exportOpen}
              title="导出会话记录"
              onClick={() => setExportOpen((open) => !open)}
              onMouseDown={(event) => event.stopPropagation()}
            >
              <IconDownload />
            </button>
            {exportOpen ? (
              <div className="agent-window__export-menu" role="menu" aria-label="导出格式">
                <button type="button" role="menuitem" onClick={() => void exportSession("json")} onMouseDown={(event) => event.stopPropagation()}>
                  JSON
                </button>
                <button type="button" role="menuitem" onClick={() => void exportSession("md")} onMouseDown={(event) => event.stopPropagation()}>
                  Markdown
                </button>
                <button type="button" role="menuitem" onClick={() => void exportSession("txt")} onMouseDown={(event) => event.stopPropagation()}>
                  TXT
                </button>
              </div>
            ) : null}
          </div>
          <button
            type="button"
            className="agent-window__close"
            aria-label="关闭对话窗口"
            onClick={onClose}
            onMouseDown={(event) => event.stopPropagation()}
          >
            <IconClose />
          </button>
        </div>
      </header>

      {overrideContent ?? (
        <>
      {roleOpen ? (
        <div className="agent-window__role">
          <div className="agent-window__role-head">
            <span className="agent-window__role-title">System Prompt / 人格（role）</span>
            <span className="agent-window__role-hint">{roleDraft.length} 字符</span>
          </div>
          <textarea
            className="agent-window__role-input"
            value={roleDraft}
            onChange={(event) => setRoleDraft(event.target.value)}
            placeholder="（空 role 无法保存；修改 dispatcher 后将成为该 Agent 的自定义 role）"
            spellCheck={false}
          />
          {roleError ? <p className="agent-window__role-error">{roleError}</p> : null}
          <div className="agent-window__role-actions">
            <button type="button" className="btn btn--ghost btn--sm" onClick={() => setRoleOpen(false)}>
              取消
            </button>
            <button type="button" className="btn btn--primary btn--sm" onClick={() => void saveRole()} disabled={!roleDraft.trim() || roleSaving}>
              {roleSaving ? "保存中…" : "保存"}
            </button>
          </div>
        </div>
      ) : null}

      {searchOpen ? (
        <div className="agent-window__search" role="search">
          <div className="agent-window__search-row">
            <input
              className="agent-window__search-input"
              value={searchQuery}
              placeholder="检索全部会话 transcript（Enter 搜索）"
              onChange={(event) => setSearchQuery(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === "Enter") {
                  event.preventDefault();
                  void runSearch();
                }
                if (event.key === "Escape") {
                  toggleSearch();
                }
              }}
              autoFocus
            />
            <button type="button" className="btn btn--ghost btn--sm" onClick={() => void runSearch()} disabled={searching || !searchQuery.trim()}>
              {searching ? "检索中…" : "搜索"}
            </button>
          </div>
          {searchMsg ? <p className="agent-window__search-msg">{searchMsg}</p> : null}
          {searchHits.length > 0 ? (
            <ul className="agent-window__search-results">
              {searchHits.map((hit) => {
                const isCurrent = hit.id === agent.session_id;
                const latestTurn = hit.matchedTurns.length > 0 ? hit.matchedTurns[hit.matchedTurns.length - 1]![1] : 0;
                return (
                  <li key={hit.id} className="agent-window__search-hit">
                    <button
                      type="button"
                      className="agent-window__search-hit-main"
                      disabled={latestTurn <= 0 && !hit.compact_handoff_match}
                      onClick={() => jumpFromHit(hit)}
                    >
                      <span className="agent-window__search-hit-name">
                        {hit.name}
                        {isCurrent ? <em className="agent-window__search-hit-tag">当前会话</em> : null}
                        {hit.archived ? <em className="agent-window__search-hit-tag">已归档</em> : null}
                      </span>
                      <span className="agent-window__search-hit-meta">
                        {hit.workspace || "工作区未知"} · {hit.matchedTurns.length} 处命中 · {hit.message_count} 条消息
                        {latestTurn > 0 ? ` · 跳到 Turn ${latestTurn}` : ""}
                        {hit.compact_handoff_match ? ` · Compact 摘要命中（覆盖 ${hit.compact_covered_turn_count ?? "?"} 轮）` : ""}
                      </span>
                      {hit.snippet ? <span className="agent-window__search-hit-snippet">{hit.snippet}</span> : null}
                    </button>
                  </li>
                );
              })}
            </ul>
          ) : null}
        </div>
      ) : null}

      {quote ? (
        <button
          type="button"
          className="agent-window__quote-btn"
          style={{ left: quote.x, top: quote.y }}
          onClick={appendQuote}
          onMouseDown={(event) => event.preventDefault()}
        >
          ⤴ 引用到输入框
        </button>
      ) : null}

      {/* 消息区包一层定位容器：导航条要相对「消息区」定位，否则会盖到顶部工具栏上 */}
      <div className="agent-window__body">
      <div className="agent-window__list" ref={listRef} aria-live="polite" onMouseUp={captureQuote}>
        {compactCheckpoint ? (
          <section className="agent-window__handoff" aria-label="Compact Handoff 状态">
            <button
              type="button"
              className="agent-window__handoff-toggle"
              aria-expanded={handoffExpanded}
              onClick={() => setHandoffExpanded((expanded) => !expanded)}
            >
              <span>任务交接摘要 · 已覆盖 {compactCheckpoint.coveredTurnCount} 轮</span>
              <span>{handoffExpanded ? "收起" : "展开"}</span>
            </button>
            {handoffExpanded ? (
              <div className="agent-window__handoff-content">
                <div className="agent-window__handoff-meta">
                  边界 {compactCheckpoint.coveredThroughMessageId} · 来源 {compactCheckpoint.sourceRefs.length} 条 · {new Date(compactCheckpoint.createdAt).toLocaleString("zh-CN")}
                </div>
                <div className="agent-window__handoff-text">{compactCheckpoint.handoff}</div>
              </div>
            ) : null}
          </section>
        ) : null}
        {compactError ? (
          <div className="agent-window__compact-error" role="alert">
            <span>{compactError}</span>
            {compactErrorCanRetry ? <button type="button" disabled={compactBusy || streaming} onClick={() => void compactConversation()}>重试 Compact</button> : null}
          </div>
        ) : null}
        {!embedded && subject.kind === "agent" && subject.id === agent.id ? (
          <div className="agent-window__redirect-status" role="status">
            <span>{redirectReady ? "Redirect 交接文件已就绪" : "Redirect 等待交接文件"}</span>
            <code>{redirectPath}</code>
            <span>{redirectReady ? "可以创建接续会话" : "请写入非空文件后刷新状态"}</span>
            <button type="button" onClick={() => void copyRedirectPath()}>{redirectPathCopied ? "已复制" : "复制路径"}</button>
            <button type="button" onClick={() => void loadRedirectStatus()}>刷新状态</button>
          </div>
        ) : null}
        {messages.length === 0 ? (
          <p className="agent-window__empty">还没有消息——发送第一条开始对话。</p>
        ) : (
          (() => {
            const rendered: React.ReactNode[] = [];
            const boundaryIndex = compactCheckpoint
              ? messages.reduce((last, message, index) => message.messageId === compactCheckpoint.coveredThroughMessageId ? index : last, -1)
              : -1;
            messages.forEach((message, index) => {
              rendered.push(
                <MessageItem
                  key={message.key}
                  message={message}
                  onToggleTool={toggleToolCollapsed}
                  onStartEdit={startEdit}
                  isEditing={!!message.messageId && message.messageId === editingMessageId}
                  editDraft={editDraft}
                  onEditDraftChange={setEditDraft}
                  onEditSave={() => void saveEdit()}
                  onEditCancel={cancelEdit}
                  jump={jumpKeys.has(message.key)}
                  reasoningLive={streaming && message.key === messages[messages.length - 1]?.key}
                  agentId={agent.id}
                  pendingQuestionSets={pendingQuestionSets}
                  answeredQuestionSets={answeredQuestionSets}
                  onQuestionAnswered={onQuestionAnswered}
                />,
              );
              if (index === boundaryIndex) {
                rendered.push(
                  <div key="compact-boundary" className="agent-window__compact-boundary" role="separator">
                    <span />
                    <span>Compact Handoff 覆盖到此处；上方原始会话仍完整保留</span>
                    <span />
                  </div>,
                );
              }
            });
            return rendered;
          })()
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

        {policyNotice ? <p className="agent-window__policy-notice" role="status">{policyNotice}</p> : null}
        {experienceNotice ? <p className="agent-window__policy-notice" role="status">{experienceNotice}</p> : null}
        {streamError ? <p className="agent-window__error" role="alert">{streamError}</p> : null}
      </div>

      <MessageMinimap items={minimapItems} scrollRef={listRef} />
      </div>

      <footer className="agent-window__composer">
        <div ref={mirrorRef} className="agent-window__mirror" aria-hidden="true" />
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
        <textarea
          ref={inputRef}
          className="agent-window__input"
          value={input}
          onChange={onChange}
          onKeyDown={onKeyDown}
          placeholder="输入消息，Enter 发送；Shift+Enter 或 Ctrl+Enter 换行；输入 & 可引用历史会话"
          aria-label="消息输入"
          rows={1}
          style={{ resize: 'none', minHeight: '44px', maxHeight: '200px' }}
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
        </>
      )}
    </div>
  );
}
