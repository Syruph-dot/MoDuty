import { useEffect, useMemo, useRef } from "react";

import { useAgentsStore } from "../../state/agentsStore";
import { useDispatchLedger, usePendingQuestions } from "../../hooks/useDutyData";
import type { Agent, DispatchView } from "../../types";
import QuestionCard from "../ui/QuestionCard";
import { DutyChatPanel, useDutyChat } from "./DutyChat";
import DutyPortrait from "./DutyPortrait";

/**
 * 值日生窗口（DutyWindow）—— duty 磁贴“展开”后的形态，作为 AgentWindow 的替代背面。
 *
 * 为什么不是第二个聊天窗：AgentWindow 已经能聊天，值日生窗口的差异化价值是
 * ① 待老师拍板的结构化问答（答完系统自动派发）② 调度台账（谁在做、第几轮、上次判读、是否停转）
 * ③ 立绘的在场感。所以排成三区：
 *
 *   ┌ 状态带：值日生 · state/phase · 进行中 / 等判读 / 今日交付 ─────────────┐
 *   │ 左：立绘 + 待老师拍板      │ 中：对话（DutyChatPanel） │ 右：调度台账      │
 *   └──────────────────────────────────────────────────────────────────┘
 *
 * 打开/关闭沿用磁贴墙的打开态（openAgent(dutyId) → 舞台卡片 → 本组件为 back 面），
 * 所以 z 序、打开即居中、拖拽标题栏、拖入左坞收起都不需要在这里实现。
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

export default function DutyWindow({ agent, onClose }: { agent: Agent; onClose: () => void }) {
  const chat = useDutyChat(agent.id);
  const ledger = useDispatchLedger(agent.id);
  const questions = usePendingQuestions(agent.id);
  const openAgentById = useAgentsStore((state) => state.openAgent);

  // 收起窗口时中断流式回复（用 ref 拿最新的 abort，避免每次渲染都触发清理）
  const abortRef = useRef(chat.abort);
  abortRef.current = chat.abort;
  useEffect(() => () => abortRef.current(), []);

  const stats = useMemo(() => {
    let tracking = 0;
    let awaiting = 0;
    let deliveredToday = 0;
    for (const view of ledger.dispatches) {
      if (view.stalled_at) tracking += 1;
      else if (view.state === "tracking") tracking += 1;
      else if (view.state === "awaiting_verdict") awaiting += 1;
      if (view.state === "done" && isToday(view.last_status_at)) deliveredToday += 1;
    }
    return { tracking, awaiting, deliveredToday };
  }, [ledger.dispatches]);

  const pendingSets = useMemo(() => questions.sets.filter((set) => set.status === "pending"), [questions.sets]);
  const active = useMemo(() => ledger.dispatches.filter((view) => view.state !== "done"), [ledger.dispatches]);
  const closed = useMemo(() => ledger.dispatches.filter((view) => view.state === "done").slice(0, 5), [ledger.dispatches]);

  return (
    <div className="duty-window" role="dialog" aria-label="值日生调度窗口">
      <header className="duty-window__header" title="拖动标题栏可移动卡片；拖到左栏可收起">
        <span className="duty-window__title">值日生</span>
        <span className="duty-window__state">
          {agent.state}
          {agent.phase ? ` · ${agent.phase}` : ""}
        </span>
        <span className="duty-window__stats">
          <span className="duty-window__stat duty-window__stat--tracking">进行中 {stats.tracking}</span>
          <span className="duty-window__stat duty-window__stat--awaiting">等判读 {stats.awaiting}</span>
          <span className="duty-window__stat duty-window__stat--done">今日交付 {stats.deliveredToday}</span>
        </span>
        <button type="button" className="agent-window__close" aria-label="收起值日生窗口" onClick={onClose}>
          ×
        </button>
      </header>

      <div className="duty-window__body">
        <aside className="duty-window__aside">
          <div className="duty-window__portrait duty-girl__portrait">
            <DutyPortrait />
          </div>
          <section className="duty-window__todo" aria-label="待老师拍板">
            <h3 className="duty-window__section-title">
              待老师拍板
              {pendingSets.length > 0 ? <span className="duty-window__section-count">{pendingSets.length}</span> : null}
            </h3>
            {pendingSets.length === 0 ? (
              <p className="duty-window__empty">暂时没有需要拍板的事。</p>
            ) : (
              pendingSets.map((set) => (
                <div key={set.id} className="duty-window__question">
                  <QuestionCard
                    agentId={agent.id}
                    setId={set.id}
                    questions={set.questions.map((q) => ({ prompt: q.prompt, options: q.options }))}
                    onAnswered={() => questions.refresh()}
                  />
                </div>
              ))
            )}
          </section>
        </aside>

        <section className="duty-window__chat" aria-label="与值日生的对话">
          <DutyChatPanel chat={chat} variant="window" />
        </section>

        <aside className="duty-window__ledger" aria-label="调度台账">
          <h3 className="duty-window__section-title">
            调度台账
            {ledger.loading ? <span className="duty-window__section-count">…</span> : null}
          </h3>
          {ledger.error ? <p className="duty-window__error">{ledger.error}</p> : null}
          {active.length === 0 && closed.length === 0 && !ledger.error ? (
            <p className="duty-window__empty">还没派发过任务。对我说“帮我做…”，我会挑合适的执行者。</p>
          ) : null}
          {active.map((view) => (
            <LedgerCard key={view.id} view={view} onOpen={openAgentById} />
          ))}
          {closed.length > 0 ? <h4 className="duty-window__sub-title">最近交付</h4> : null}
          {closed.map((view) => (
            <LedgerCard key={view.id} view={view} onOpen={openAgentById} />
          ))}
        </aside>
      </div>
    </div>
  );
}
