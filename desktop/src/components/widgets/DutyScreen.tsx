import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { useDispatchLedger, usePendingQuestions } from "../../hooks/useDutyData";
import { resolveDutyAgentId } from "../../lib/dutyAgent";
import { useAgentsStore } from "../../state/agentsStore";
import { useDialogStore } from "../../state/dialogStore";
import type { Agent, DispatchView } from "../../types";
import QuestionCard from "../ui/QuestionCard";
import { DutyChatPanel, useDutyChat } from "./DutyChat";
import DutyPortrait from "./DutyPortrait";

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

function LedgerCard({ view, onOpen }: { view: DispatchView; onOpen: (agentId: string) => void }) {
  const badge = view.stalled_at ? "停转" : STATE_LABEL[view.state];
  const tone = view.stalled_at ? "stalled" : view.state;
  return (
    <button
      type="button"
      className={`duty-ledger__card duty-ledger__card--${tone}`}
      onClick={() => onOpen(view.target.agent_id)}
      title={`打开执行者窗口：${view.target.name ?? view.target.agent_id}`}
    >
      <div className="duty-ledger__row">
        <span className={`duty-ledger__badge duty-ledger__badge--${tone}`}>{badge}</span>
        <span className="duty-ledger__name">{view.target.name ?? view.target.agent_id}</span>
        <span className="duty-ledger__time">{relativeTime(view.last_status_at ?? view.dispatched_at)}</span>
      </div>
      <p className="duty-ledger__task">
        {view.task}
        {view.task_truncated ? " …" : ""}
      </p>
      <div className="duty-ledger__meta">
        {view.continue_count > 0 ? <span className="duty-ledger__chip">返工 {view.continue_count}/3</span> : null}
        {view.last_verdict ? <span className="duty-ledger__chip">判读 {view.last_verdict}</span> : null}
        {view.linked_sessions.length > 0 ? (
          <span className="duty-ledger__chip">引用 {view.linked_sessions.length}</span>
        ) : null}
      </div>
    </button>
  );
}

export default function DutyScreen() {
  const open = useDialogStore((state) => state.dutyOpen);
  const closeDuty = useDialogStore((state) => state.closeDuty);
  const agents = useAgentsStore((state) => state.agents);
  const openAgentById = useAgentsStore((state) => state.openAgent);

  const [closing, setClosing] = useState(false);

  /** 值日生 = kind=dispatcher 的 agent（id 解析与磁贴侧同一份逻辑） */
  const dutyAgent: Agent | null = useMemo(() => {
    const id = resolveDutyAgentId(agents);
    return id ? agents.find((agent) => agent.id === id) ?? null : null;
  }, [agents]);
  const dutyAgentId = dutyAgent?.id ?? null;

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
    window.setTimeout(closeDuty, 250);
  }, [closing, closeDuty]);

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
  const closed = useMemo(() => ledger.dispatches.filter((view) => view.state === "done").slice(0, 8), [ledger.dispatches]);

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
          <div className="duty-screen__portrait duty-girl__portrait">
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
            {ledger.loading ? <span className="duty-screen__section-count">…</span> : null}
          </h3>
          {ledger.error ? (
            <p className="duty-screen__error">
              台账读取失败：{ledger.error}
              <br />
              <span className="duty-screen__hint">（后端若是旧进程，重启后才有 GET /api/dispatches）</span>
            </p>
          ) : null}
          {active.length === 0 && closed.length === 0 && !ledger.error ? (
            <p className="duty-screen__empty">还没派发过任务。对我说“帮我做…”，我会挑合适的执行者。</p>
          ) : null}
          {active.map((view) => (
            <LedgerCard key={view.id} view={view} onOpen={openAgentById} />
          ))}
          {closed.length > 0 ? <h4 className="duty-screen__sub-title">最近交付</h4> : null}
          {closed.map((view) => (
            <LedgerCard key={view.id} view={view} onOpen={openAgentById} />
          ))}
        </aside>
      </div>
    </div>
  );
}
