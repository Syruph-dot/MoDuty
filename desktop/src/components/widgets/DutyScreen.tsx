import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { CSSProperties } from "react";

import { useDispatchLedger, usePendingQuestions } from "../../hooks/useDutyData";
import { resolveDutyAgentId } from "../../lib/dutyAgent";
import { ensureAgentInList, useAgentsStore } from "../../state/agentsStore";
import { useDialogStore } from "../../state/dialogStore";
import type { Agent, DispatchView } from "../../types";
import QuestionCard from "../ui/QuestionCard";
import { DutyChatPanel, useDutyChat } from "./DutyChat";
import DutyPortrait, { dutyPortraitAspect } from "./DutyPortrait";

/**
 * 值日生页（DutyScreen）—— 与设置页同构的整页视图（z-index 300，左右浮入浮出）。
 *
 * 为什么不做成磁贴展开的窗口：值日生是“全局调度视图”，需要整屏看台账与对话；
 * 而磁贴展开的卡片宽度受舞台限制（0.7 屏），且它对应的 agent 在空闲态被墙治理过滤、
 * 不在墙上挂载，会额外引入动画/入场问题。整页视图和设置页一样：一个开关 + 一次浮入。
 *
 * 三区：
 *   左：立绘（摸头/视线跟随保留）+ 状态 + 「待老师拍板」（结构化问答就地作答）
 *   中：与值日生的对话（DutyChatPanel，与小对话框共用同一份消息状态）
 *   右：调度台账（进行中 / 等判读 / 已交付 / 停转，点击跳执行者窗口）
 */

/** 判读结论 → 中文标签（含系统强制交付与人工取消） */
const VERDICT_LABEL: Record<NonNullable<DispatchView["last_verdict"]>, string> = {
  deliver: "已交付",
  continue: "返工",
  deliver_forced: "强制交付",
  cancelled: "已取消",
};

/** 相对时间（分钟粒度） */
function relativeTime(iso: string | null): string {
  if (!iso) return "";
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return "";
  const deltaMin = Math.round((Date.now() - t) / 60000);
  if (deltaMin < 1) return "刚刚";
  if (deltaMin < 60) return `${deltaMin} 分钟前`;
  const hours = Math.round(deltaMin / 60);
  if (hours < 24) return `${hours} 小时前`;
  return `${Math.round(hours / 24)} 天前`;
}

const STATE_LABEL: Record<DispatchView["state"], string> = {
  tracking: "进行中",
  awaiting_verdict: "等判读",
  done: "已交付",
};

/** 与后端 dispatch-ledger.ts 的 DISPATCH_MAX_CONTINUE 保持一致（仅用于展示 x/3） */
const DISPATCH_MAX_CONTINUE = 3;

/** 退页浮出动画时长，与 momoka-settings-out 关键帧一致（到点后才真正卸载） */
const EXIT_MS = 250;

function isToday(iso: string | null): boolean {
  if (!iso) return false;
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return false;
  const now = new Date();
  const then = new Date(t);
  return (
    now.getFullYear() === then.getFullYear() && now.getMonth() === then.getMonth() && now.getDate() === then.getDate()
  );
}

/**
 * 台账卡片：默认折叠（任务书两行截断），点标题展开 → 全文任务书 + 元数据 + 引用会话 + 打开执行者。
 * 展开不抢导航：点标题只开合，“打开执行者窗口”是展开区里的独立动作。
 */
function LedgerCard({
  view,
  expanded,
  onToggle,
  onOpenAgent,
  onOpenSession,
}: {
  view: DispatchView;
  expanded: boolean;
  onToggle: () => void;
  onOpenAgent: (agentId: string) => void;
  onOpenSession: (sessionId: string) => void;
}) {
  const badge = view.stalled_at ? "停转" : STATE_LABEL[view.state];
  const tone = view.stalled_at ? "stalled" : view.state;
  const lastStatusText =
    view.last_status === "completed" ? "执行者完成" : view.last_status === "error" ? "执行者出错" : view.last_status === "stalled" ? "检出停转" : null;
  return (
    <div className={`duty-ledger__card duty-ledger__card--${tone}${expanded ? " duty-ledger__card--expanded" : ""}`}>
      <button type="button" className="duty-ledger__head" onClick={onToggle} aria-expanded={expanded}>
        <span className={`duty-ledger__badge duty-ledger__badge--${tone}`}>{badge}</span>
        <span className="duty-ledger__name">{view.target.name ?? view.target.agent_id}</span>
        <span className="duty-ledger__time">{relativeTime(view.last_status_at ?? view.dispatched_at)}</span>
        <span className="duty-ledger__fold" aria-hidden="true">
          {expanded ? "▾" : "▸"}
        </span>
      </button>
      <p className={`duty-ledger__task${expanded ? " duty-ledger__task--full" : ""}`}>
        {view.task}
        {view.task_truncated ? " …" : ""}
      </p>
      <div className="duty-ledger__meta">
        {view.continue_count > 0 ? <span className="duty-ledger__chip">返工 {view.continue_count}/3</span> : null}
        {view.last_verdict ? <span className="duty-ledger__chip">判读 {VERDICT_LABEL[view.last_verdict]}</span> : null}
        {view.linked_sessions.length > 0 ? (
          <span className="duty-ledger__chip">引用 {view.linked_sessions.length}</span>
        ) : null}
        {view.target.state ? <span className="duty-ledger__chip">执行者 {view.target.state}</span> : null}
      </div>
      {expanded ? (
        <div className="duty-ledger__detail">
          <div className="duty-ledger__facts">
            <span>派发 {relativeTime(view.dispatched_at)}</span>
            <span>台账 {view.id}</span>
            {lastStatusText ? <span>最近 {lastStatusText}</span> : null}
            {view.stalled_at ? <span className="duty-ledger__warn">停转于 {relativeTime(view.stalled_at)}</span> : null}
            <span>
              返工 {view.continue_count}/{DISPATCH_MAX_CONTINUE}
            </span>
            {view.last_verdict ? <span>上次判读 {VERDICT_LABEL[view.last_verdict]}</span> : null}
          </div>
          <div className="duty-ledger__facts">
            <span>执行者会话 {view.target.session_id}</span>
            {view.target.phase ? <span>阶段 {view.target.phase}</span> : null}
          </div>
          {view.linked_sessions.length > 0 ? (
            <div className="duty-ledger__links">
              <span className="duty-ledger__links-label">派发携带的会话</span>
              {view.linked_sessions.map((session) => (
                <button
                  key={session}
                  type="button"
                  className="duty-dialog__link"
                  title={`打开会话 ${session} 对应的 Agent`}
                  onClick={() => onOpenSession(session)}
                >
                  <span className="duty-dialog__link-icon">↗</span>
                  会话·{session.replace(/^ses_/, "").slice(0, 6)}
                </button>
              ))}
            </div>
          ) : null}
          <button type="button" className="duty-ledger__open" onClick={() => onOpenAgent(view.target.agent_id)}>
            打开执行者窗口 →
          </button>
        </div>
      ) : null}
    </div>
  );
}

export default function DutyScreen() {
  const open = useDialogStore((state) => state.dutyOpen);
  const closeDuty = useDialogStore((state) => state.closeDuty);
  const closeSettings = useDialogStore((state) => state.closeSettings);
  const agents = useAgentsStore((state) => state.agents);
  const openAgentById = useAgentsStore((state) => state.openAgent);

  const [closing, setClosing] = useState(false);
  /** 展开的台账卡片 id（展开看完整任务书与细节） */
  const [expandedId, setExpandedId] = useState<string | null>(null);

  /** 值日生 = kind=dispatcher 的 agent（id 解析与磁贴侧同一份逻辑） */
  const dutyAgent: Agent | null = useMemo(() => {
    const id = resolveDutyAgentId(agents);
    return id ? agents.find((agent) => agent.id === id) ?? null : null;
  }, [agents]);
  const dutyAgentId = dutyAgent?.id ?? null;

  /**
   * 立绘容器的高度基准（宽高比）。只在挂载时取一次：
   * 缓存值会随立绘实测微调（0.6504 vs 0.65014 这种量级），若让它跟着重渲染改写，
   * 容器高度就会在页面停稳后被推着微动 —— 没有必要，首帧值已经足够准。
   */
  const portraitStyle = useMemo(
    () => ({ "--duty-portrait-aspect": String(dutyPortraitAspect()) }) as CSSProperties,
    [],
  );

  const chat = useDutyChat(open ? dutyAgentId : null);
  const ledger = useDispatchLedger(open ? dutyAgentId : null);
  const questions = usePendingQuestions(open ? dutyAgentId : null);

  // 关闭时中断流式回复（用 ref 取最新 abort，避免每次渲染都跑清理）
  const abortRef = useRef(chat.abort);
  abortRef.current = chat.abort;
  useEffect(() => () => abortRef.current(), []);

  useEffect(() => {
    if (open) setClosing(false);
  }, [open]);

  // 关闭动画：整页向左浮出后再真正卸载（与设置页一致）
  const requestClose = useCallback(() => {
    if (closing) return;
    setClosing(true);
    window.setTimeout(closeDuty, EXIT_MS);
  }, [closing, closeDuty]);

  /**
   * 从值日生页“跳出去”做一件事：先退页（浮出动画）再执行。
   * 整页是 `position: fixed; z-index: 300` 的覆盖层，而磁贴墙在 pageOpen 时整体退场（不挂载），
   * 所以直接 openAgent 会“点了没反应”——桌面看不见、页还盖在上面。
   * 设置页共用同一套 pageOpen 逻辑，一并关掉，保证磁贴墙真的回来。
   */
  const leaveFor = useCallback(
    (act: () => void) => {
      if (closing) return;
      setClosing(true);
      window.setTimeout(() => {
        closeDuty();
        closeSettings();
        act();
      }, EXIT_MS);
    },
    [closing, closeDuty, closeSettings],
  );

  /** 打开执行者窗口 = 退页 + 打开对方磁贴（新开卡片会由桌面自动缓动居中）
   *  先 ensureAgentInList：值日生/机器人刚在后端建的 Agent 可能还没进前端列表，
   *  直接 openAgent 只会改「打开集合」、没有磁贴承载 → 点了什么都不发生（2026-09-22 实测）。 */
  const openAgentAndLeave = useCallback(
    (agentId: string) =>
      leaveFor(() => {
        void (async () => {
          await ensureAgentInList(agentId);
          openAgentById(agentId);
        })();
      }),
    [leaveFor, openAgentById],
  );

  useEffect(() => {
    if (!open) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") requestClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, requestClose]);

  const stats = useMemo(() => {
    let tracking = 0;
    let awaiting = 0;
    let deliveredToday = 0;
    for (const view of ledger.dispatches) {
      if (view.stalled_at || view.state === "tracking") tracking += 1;
      else if (view.state === "awaiting_verdict") awaiting += 1;
      if (view.state === "done" && isToday(view.last_status_at)) deliveredToday += 1;
    }
    return { tracking, awaiting, deliveredToday };
  }, [ledger.dispatches]);

  const pendingSets = useMemo(() => questions.sets.filter((set) => set.status === "pending"), [questions.sets]);
  const active = useMemo(() => ledger.dispatches.filter((view) => view.state !== "done"), [ledger.dispatches]);
  const closed = useMemo(() => ledger.dispatches.filter((view) => view.state === "done"), [ledger.dispatches]);

  /** 「派给了哪些 Agent」：按执行者去重汇总（含派发次数），点击直接打开对方窗口 */
  const targets = useMemo(() => {
    const map = new Map<string, { id: string; name: string; state: string | null; count: number }>();
    for (const view of ledger.dispatches) {
      const key = view.target.agent_id;
      const prev = map.get(key);
      map.set(key, {
        id: key,
        name: view.target.name ?? key,
        state: view.target.state,
        count: (prev?.count ?? 0) + 1,
      });
    }
    return [...map.values()].sort((a, b) => b.count - a.count);
  }, [ledger.dispatches]);

  /** 引用会话（&ses_…）→ 反查绑定 agent 并打开窗口（与对话 chip 同一套解析） */
  const openSession = useCallback(
    (sessionId: string) => {
      const bare = sessionId.replace(/^ses_/, "");
      const bound = agents.find((agent) => agent.session_id === sessionId || agent.session_id === bare || agent.session_id === `ses_${bare}`);
      if (bound) openAgentAndLeave(bound.id);
    },
    [agents, openAgentAndLeave],
  );

  if (!open) return null;

  return (
    <div className={`duty-screen${closing ? " duty-screen--exit" : ""}`} role="dialog" aria-label="值日生">
      <header className="duty-screen__top">
        <span className="duty-screen__title">值日生</span>
        <span className="duty-screen__state">
          {dutyAgent ? `${dutyAgent.state}${dutyAgent.phase ? ` · ${dutyAgent.phase}` : ""}` : "未就绪"}
        </span>
        <span className="duty-screen__stats">
          <span className="duty-screen__stat duty-screen__stat--tracking">进行中 {stats.tracking}</span>
          <span className="duty-screen__stat duty-screen__stat--awaiting">等判读 {stats.awaiting}</span>
          <span className="duty-screen__stat duty-screen__stat--done">今日交付 {stats.deliveredToday}</span>
        </span>
        <button type="button" className="duty-screen__back" onClick={requestClose}>
          ← 返回桌面（Esc）
        </button>
      </header>

      <div className="duty-screen__body">
        <aside className="duty-screen__aside">
          {/* 高度用缓存/实测比例首帧就位：等立绘量完再改会让 aside 在浮入缓动中跳一次 */}
          <div className="duty-screen__portrait duty-girl__portrait" style={portraitStyle}>
            <DutyPortrait />
          </div>
          <section className="duty-screen__todo" aria-label="待老师拍板">
            <h3 className="duty-screen__section-title">
              待老师拍板
              {pendingSets.length > 0 ? <span className="duty-screen__section-count">{pendingSets.length}</span> : null}
            </h3>
            {pendingSets.length === 0 ? (
              <p className="duty-screen__empty">暂时没有需要拍板的事。</p>
            ) : (
              pendingSets.map((set) => (
                <div key={set.id} className="duty-screen__question">
                  <QuestionCard
                    agentId={dutyAgentId ?? ""}
                    setId={set.id}
                    questions={set.questions.map((q) => ({ prompt: q.prompt, options: q.options }))}
                    onAnswered={() => questions.refresh()}
                  />
                </div>
              ))
            )}
          </section>
        </aside>

        <section className="duty-screen__chat" aria-label="与值日生的对话">
          <DutyChatPanel chat={chat} variant="window" />
        </section>

        <aside className="duty-screen__ledger" aria-label="调度台账">
          <h3 className="duty-screen__section-title">
            调度台账
            <span className="duty-screen__section-count">{ledger.dispatches.length}</span>
            {ledger.loading ? <span className="duty-screen__section-count">…</span> : null}
          </h3>
          {ledger.error ? (
            <p className="duty-screen__error">
              台账读取失败：{ledger.error}
              <br />
              <span className="duty-screen__hint">（后端若是旧进程，重启后才有 GET /api/dispatches）</span>
            </p>
          ) : null}
          {targets.length > 0 ? (
            <div className="duty-screen__targets">
              <span className="duty-screen__targets-label">派给过 {targets.length} 个 Agent</span>
              <div className="duty-screen__targets-chips">
                {targets.map((target) => (
                  <button
                    key={target.id}
                    type="button"
                    className="duty-screen__target-chip"
                    title={`打开执行者窗口：${target.name}`}
                    onClick={() => openAgentAndLeave(target.id)}
                  >
                    {target.name}
                    {target.count > 1 ? <span className="duty-screen__target-count">×{target.count}</span> : null}
                  </button>
                ))}
              </div>
            </div>
          ) : null}
          {active.length === 0 && closed.length === 0 && !ledger.error ? (
            <p className="duty-screen__empty">还没派发过任务。对我说“帮我做…”，我会挑合适的执行者。</p>
          ) : null}
          {active.map((view) => (
            <LedgerCard
              key={view.id}
              view={view}
              expanded={expandedId === view.id}
              onToggle={() => setExpandedId((prev) => (prev === view.id ? null : view.id))}
              onOpenAgent={openAgentAndLeave}
              onOpenSession={openSession}
            />
          ))}
          {closed.length > 0 ? <h4 className="duty-screen__sub-title">已交付 {closed.length}</h4> : null}
          {closed.map((view) => (
            <LedgerCard
              key={view.id}
              view={view}
              expanded={expandedId === view.id}
              onToggle={() => setExpandedId((prev) => (prev === view.id ? null : view.id))}
              onOpenAgent={openAgentAndLeave}
              onOpenSession={openSession}
            />
          ))}
        </aside>
      </div>
    </div>
  );
}
