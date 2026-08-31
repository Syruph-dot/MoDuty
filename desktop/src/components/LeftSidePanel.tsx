import { useMemo, useState } from "react";
import { useAgentsStore } from "../state/agentsStore";
import { useBrowserStore } from "../state/browserStore";
import {
  useWindowManagerStore,
  type WindowSortKey,
} from "../state/windowManagerStore";
import type { Agent, BrowserInfo } from "../types";

/**
 * 左栏（240px，Windows 8 侧栏风格）：
 * - 鼠标移到左边缘滑出，移开收回
 * - 分类：Agent / Browser 两组
 * - 排序：最近打开（openedAt）/ 最近完成（lastCompletedAt）可切换
 * - 卡片：名称 + 类型 + 状态/阶段徽标 + 相对时间；单击打开该窗口（自动进入打开模态）
 */
export default function LeftSidePanel() {
  const agents = useAgentsStore((state) => state.agents);
  const openAgentIds = useAgentsStore((state) => state.openAgentIds);
  const openAgent = useAgentsStore((state) => state.openAgent);
  const browsers = useBrowserStore((state) => state.browsers);
  const openBrowserIds = useBrowserStore((state) => state.openBrowserIds);
  const openBrowser = useBrowserStore((state) => state.openBrowser);
  const sortBy = useWindowManagerStore((state) => state.sortBy);
  const setSortBy = useWindowManagerStore((state) => state.setSortBy);
  const openedAtMap = useWindowManagerStore((state) => state.openedAtMap);
  const lastCompletedAtMap = useWindowManagerStore((state) => state.lastCompletedAtMap);

  const [open, setOpen] = useState(false);

  const sortItems = useMemo(() => {
    const byKey = (getKey: (id: string) => number) => (
      a: { id: string; name: string },
      b: { id: string; name: string },
    ) => {
      const ka = getKey(a.id);
      const kb = getKey(b.id);
      if (ka !== kb) return kb - ka; // 有时间戳者优先，靠后的大
      return (a.name || "").localeCompare(b.name || "");
    };
    const agentKey =
      sortBy === "openedAt"
        ? (id: string) => openedAtMap[`agent:${id}`] ?? 0
        : (id: string) => lastCompletedAtMap[`agent:${id}`] ?? openedAtMap[`agent:${id}`] ?? 0;
    const browserKey =
      sortBy === "openedAt"
        ? (id: string) => openedAtMap[`browser:${id}`] ?? 0
        : (id: string) => lastCompletedAtMap[`browser:${id}`] ?? openedAtMap[`browser:${id}`] ?? 0;
    return {
      agents: [...agents].sort(byKey(agentKey) as (a: Agent, b: Agent) => number),
      browsers: [...browsers].sort(byKey(browserKey) as (a: BrowserInfo, b: BrowserInfo) => number),
    };
  }, [agents, browsers, sortBy, openedAtMap, lastCompletedAtMap]);

  const onPickAgent = (agent: Agent) => {
    openAgent(agent.id);
  };
  const onPickBrowser = (browser: BrowserInfo) => {
    openBrowser(browser.id);
  };

  // 按打开状态分层：打开中的（登记集合内）在分组顶部，未打开的排在下方
  const agentOpened = sortItems.agents.filter((agent) => openAgentIds.includes(agent.id));
  const agentUnopened = sortItems.agents.filter((agent) => !openAgentIds.includes(agent.id));
  const browserOpened = sortItems.browsers.filter((browser) => openBrowserIds.includes(browser.id));
  const browserUnopened = sortItems.browsers.filter((browser) => !openBrowserIds.includes(browser.id));

  const renderCard = (kind: "agent" | "browser", id: string, name: string, phase: string, state: string, time: string, isOpen: boolean, onPick: () => void) => {
    return (
      <button
        key={id}
        type="button"
        className={`wm-card wm-card--${kind}${isOpen ? " wm-card--open" : " wm-card--closed"}`}
        onClick={onPick}
        title={`${isOpen ? "回到" : "打开"} ${name}`}
      >
        <span className="wm-card__name">{name}</span>
        <span className="wm-card__meta">
          <StatusDot state={state} />
          <span className="wm-card__phase">{phase}</span>
          <span className="wm-card__time">{time}</span>
        </span>
      </button>
    );
  };

  const renderSubgroup = (title: string, cards: React.ReactNode[]) => {
    if (cards.length === 0) return null;
    return (
      <div className="wm-subgroup">
        <h4 className="wm-subgroup__title">{title}</h4>
        {cards}
      </div>
    );
  };
  return (
    <>
      {/* 左缘热区：hover 滑出 */}
      <div
        className="wm-left-hotzone"
        onMouseEnter={() => setOpen(true)}
        aria-hidden="true"
      />
      <aside
        className={`wm-side${open ? " wm-side--open" : ""}`}
        onMouseEnter={() => setOpen(true)}
        onMouseLeave={() => setOpen(false)}
      >
        <div className="wm-side__head">
          <span className="wm-side__title">窗口</span>
          <div className="wm-side__sort" role="tablist" aria-label="排序方式">
            {(["openedAt", "lastCompletedAt"] as WindowSortKey[]).map((key) => (
              <button
                key={key}
                type="button"
                role="tab"
                aria-selected={sortBy === key}
                className={`wm-side__sort-btn${sortBy === key ? " wm-side__sort-btn--active" : ""}`}
                onClick={() => setSortBy(key)}
              >
                {key === "openedAt" ? "最近打开" : "最近完成"}
              </button>
            ))}
          </div>
        </div>

        <div className="wm-side__groups">
          {(agentOpened.length > 0 || agentUnopened.length > 0) ? (
            <section className="wm-group">
              <h3 className="wm-group__title">Agent</h3>
              {renderSubgroup(
                `打开中（${agentOpened.length}）`,
                agentOpened.map((agent) =>
                  renderCard("agent", agent.id, agent.name, agent.phase ?? agent.state, agent.state, relativeTime(agent.last_active_at), true, () => onPickAgent(agent)),
                ),
              )}
              {renderSubgroup(
                `未打开（${agentUnopened.length}）`,
                agentUnopened.map((agent) =>
                  renderCard("agent", agent.id, agent.name, agent.phase ?? agent.state, agent.state, relativeTime(agent.last_active_at), false, () => onPickAgent(agent)),
                ),
              )}
            </section>
          ) : null}

          {(browserOpened.length > 0 || browserUnopened.length > 0) ? (
            <section className="wm-group">
              <h3 className="wm-group__title">Browser</h3>
              {renderSubgroup(
                `打开中（${browserOpened.length}）`,
                browserOpened.map((browser) =>
                  renderCard("browser", browser.id, browser.name, browser.state, browserStateKey(browser.state), relativeTime(browser.lastActiveAt), true, () => onPickBrowser(browser)),
                ),
              )}
              {renderSubgroup(
                `未打开（${browserUnopened.length}）`,
                browserUnopened.map((browser) =>
                  renderCard("browser", browser.id, browser.name, browser.state, browserStateKey(browser.state), relativeTime(browser.lastActiveAt), false, () => onPickBrowser(browser)),
                ),
              )}
            </section>
          ) : null}

          {agentOpened.length === 0 && agentUnopened.length === 0 && browserOpened.length === 0 && browserUnopened.length === 0 ? (
            <p className="wm-side__empty">暂无 Agent / Browser</p>
          ) : null}
        </div>
      </aside>
    </>
  );
}

function browserStateKey(state: string): "running" | "idle" | "error" {
  if (state === "ready") return "running";
  if (state === "error") return "error";
  return "idle";
}

/** 状态徽标（Win8 磁贴色点） */
function StatusDot({ state }: { state: string }) {
  return <span className={`wm-card__dot wm-card__dot--${state}`} aria-hidden="true" />;
}

/** ISO 时间 → 相对时间文案 */
function relativeTime(iso: string | null | undefined): string {
  if (!iso) return "—";
  const then = new Date(iso).getTime();
  if (!Number.isFinite(then)) return "—";
  const diff = Date.now() - then;
  if (diff < 60_000) return "刚刚";
  if (diff < 3_600_000) return `${Math.floor(diff / 60_000)} 分钟前`;
  if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)} 小时前`;
  return `${Math.floor(diff / 86_400_000)} 天前`;
}