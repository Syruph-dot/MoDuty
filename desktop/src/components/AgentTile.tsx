import { memo, useEffect, useRef, useState, type CSSProperties } from "react";

import type { Agent, AgentState } from "../types";
import { formatShortTime } from "../lib/tileContent";
import { splitHighlight } from "../lib/agentFilter";
import { useTileThemeStore } from "../state/tileThemeStore";

export const STATE_LABELS: Record<AgentState, string> = {
  idle: "idle",
  running: "running",
  waiting_approval: "waiting approval",
  completed: "completed",
  error: "error",
};

export const STATE_DOT_CLASS: Record<AgentState, string> = {
  idle: "state-dot--idle",
  running: "state-dot--running",
  waiting_approval: "state-dot--waiting",
  completed: "state-dot--completed",
  error: "state-dot--error",
};

/** 两页轮播间隔（hover 浏览 / running 轮滚共用） */
const PAGE_MS = 2700;

/** 千分位格式化器：提升为模块级单例，避免每个磁贴每次渲染重建 Intl.NumberFormat */
const nf = new Intl.NumberFormat("en-US");

/** running 时边框扫描两档速度：LLM 推理快、等待工具执行慢 */
export const SCAN_FAST_MS = 1000;
export const SCAN_SLOW_MS = 3200;

interface AgentTileProps {
  agent: Agent;
  onOpen: (agent: Agent) => void;
  /** 内联重命名模式：名字区域变为白底黑框可编辑输入框（资源管理器风格，由右键菜单触发） */
  renaming?: boolean;
  /** 提交（Enter / 保存）；传入的名字已去空格 */
  onRenameCommit?: (name: string) => void;
  /** 取消（Esc） */
  onRenameCancel?: () => void;
  /** 钉住标记（方案 D）：显示角标，表示永远留在磁贴墙 */
  pinned?: boolean;
  /** 搜索命中词（方案 A）：name/goal 命中处 <mark> 高亮 */
  highlight?: string;
}

/**
 * Agent 磁贴（interactionv2 对齐版，两页结构）：
 * - 名称常驻顶部（内联重命名在其上进行）；删除状态行
 * - 2 页翻页结构（纵向 track 滚动）：
 *   页1 = 最近结果（LAST RESULT / goal 摘要）
 *   页2 = 上下文指标（上下文长度/窗口 + 占用率/缓存命中率）
 * - 翻页行为：
 *   running = 恒定轮滚 页1↔页2（hover 暂停）
 *   其余状态（idle/waiting/completed/error）= 常态停在页2；hover 时轮滚两页，离开 hover 回页2
 * - running 时磁贴边框显示 interactionv2 扫描动画：
 *   LLM 推理（planning/verifying/无 phase）快档；等待工具执行（searching/reading/executing）慢档
 * - footer = dot + 最近活跃时间；hover 浮现黑色 utility 条（OPEN ↵）
 * - 字号 / 字体家族由 tileThemeStore 配置，经 CSS 变量注入
 */
function AgentTile({
  agent,
  onOpen,
  renaming = false,
  onRenameCommit,
  onRenameCancel,
  pinned = false,
  highlight = "",
}: AgentTileProps) {
  const theme = useTileThemeStore();
  const [draft, setDraft] = useState(agent.name);
  const inputRef = useRef<HTMLInputElement>(null);
  const [activePage, setActivePage] = useState<0 | 1>(0);
  const hoveringRef = useRef(false);
  const [hovering, setHovering] = useState(false);
  // Enter 提交成功后输入框会因关闭而卸载并触发 blur；压制紧接着的那次 blur，避免重复提交
  const suppressBlurRef = useRef(false);

  // 进入重命名模式：同步当前名字、聚焦并全选（资源管理器 F2 行为）
  useEffect(() => {
    if (renaming) {
      setDraft(agent.name);
      const timer = window.setTimeout(() => {
        inputRef.current?.focus();
        inputRef.current?.select();
      }, 0);
      return () => window.clearTimeout(timer);
    }
    return undefined;
  }, [renaming, agent.name]);

  // 翻页驱动：
  // - running：恒定轮滚（hover 暂停）
  // - hover（非 running）：轮滚两页
  // - 非 running 非 hover：先短暂展示页1（Last Result），随后翻到页2 停住
  useEffect(() => {
    if (agent.state === "running") {
      setActivePage(0);
      const timer = window.setInterval(() => {
        if (hoveringRef.current) return; // hover 时暂停翻页，避免阅读被打断
        setActivePage((page) => (page === 1 ? 0 : 1));
      }, PAGE_MS);
      return () => window.clearInterval(timer);
    }
    if (hovering) {
      setActivePage(0);
      const timer = window.setInterval(() => {
        setActivePage((page) => (page === 1 ? 0 : 1));
      }, PAGE_MS);
      return () => window.clearInterval(timer);
    }
    setActivePage(0);
    const settle = window.setTimeout(() => setActivePage(1), PAGE_MS);
    return () => window.clearTimeout(settle);
  }, [agent.state, hovering]);

  // 字体主题 → CSS 变量（可配置项：字号 + 字体家族）
  const themeVars = {
    "--tile-font-family": theme.fontFamily.trim() || undefined,
    "--tile-name-size": `${theme.nameSize}px`,
    "--tile-big-size": `${theme.bigSize}px`,
    "--tile-meta-size": `${theme.metaSize}px`,
    "--tile-footer-size": `${theme.footerSize}px`,
  } as CSSProperties;

  const commit = () => {
    const trimmed = draft.trim();
    if (!trimmed) {
      onRenameCancel?.();
      return;
    }
    onRenameCommit?.(trimmed);
  };

  const messageGoal = agent.session?.goal?.trim() ?? "";
  const stats = agent.context_stats ?? null;

  // 上下文两行指标：{长度 / 窗口} + {占用率 / 缓存命中率}
  const ctxLine1 = stats ? `${nf.format(stats.prompt_tokens)} / ${nf.format(stats.context_window)}` : "-- / --";
  const usagePct = stats && stats.context_window > 0
    ? `${((stats.prompt_tokens / stats.context_window) * 100).toFixed(1)}%`
    : "--";
  const hitPct = stats && typeof stats.cached_tokens === "number"
    ? stats.prompt_tokens > 0
      ? `${((stats.cached_tokens / stats.prompt_tokens) * 100).toFixed(1)}%`
      : "0.0%"
    : "--";
  const ctxLine2 = `${usagePct} / ${hitPct}`;

  // running 边框扫描档位：planning/verifying（或无 phase）= LLM 推理（快）；searching/reading/executing（及未知）= 等待工具（慢）
  const scanKind = agent.state === "running"
    ? agent.phase === "planning" || agent.phase === "verifying" || agent.phase == null
      ? "fast"
      : "slow"
    : null;

  // 命中高亮渲染（方案 A）：切分为 <mark>/纯文本段
  const renderHighlighted = (text: string) =>
    highlight.trim() ? (
      splitHighlight(text, highlight).map((segment, i) =>
        segment.hit ? <mark key={i} className="agent-tile__mark">{segment.text}</mark> : <span key={i}>{segment.text}</span>,
      )
    ) : (
      text
    );

  return (
    <button
      type="button"
      className={`agent-tile agent-tile--${agent.state}${scanKind ? ` agent-tile--scan-${scanKind}` : ""}`}
      style={themeVars}
      onMouseEnter={() => {
        hoveringRef.current = true;
        setHovering(true);
      }}
      onMouseLeave={() => {
        hoveringRef.current = false;
        setHovering(false);
      }}
      aria-label={`Agent ${agent.name}，状态 ${STATE_LABELS[agent.state]}，单击进入对话`}
      title="单击打开对话"
    >
      {/* 名称常驻顶部（重命名在其上展开） */}
      <div className="agent-tile__header">
        {renaming ? (
          <input
            ref={inputRef}
            className="agent-tile__rename-input"
            value={draft}
            aria-label="重命名 Agent"
            onChange={(event) => setDraft(event.target.value)}
            // 阻止冒泡，避免点击输入框时触发磁贴拖拽
            onMouseDown={(event) => event.stopPropagation()}
            onKeyDown={(event) => {
              if (event.key === "Enter") {
                event.preventDefault();
                commit();
                // 提交后输入框多半会因关闭而卸载并触发 blur，压制该次 blur
                suppressBlurRef.current = true;
              } else if (event.key === "Escape") {
                event.preventDefault();
                onRenameCancel?.();
              }
            }}
            onBlur={() => {
              // 失焦保存（资源管理器行为）；若刚由 Enter 提交则跳过这次 blur
              if (suppressBlurRef.current) {
                suppressBlurRef.current = false;
                return;
              }
              commit();
            }}
          />
        ) : (
          <span className="agent-tile__name">{renderHighlighted(agent.name)}</span>
        )}
        {pinned ? (
          <span className="agent-tile__pin" aria-label="已钉住" title="已钉住（始终在墙）">
            📌
          </span>
        ) : null}
      </div>

      <div className="agent-tile__pages">
        {/* 翻页轨道：translateY 按页索引纵向滚动 */}
        <div className="agent-tile__track" style={{ transform: `translateY(-${activePage * 100}%)` }}>
          {/* 页1：最近结果 */}
          <div className="agent-tile__page" aria-hidden={activePage !== 0}>
            <div className="agent-tile__role">LAST RESULT</div>
            <div className="agent-tile__result">{renderHighlighted(messageGoal) || "No result yet"}</div>
          </div>

          {/* 页2：上下文指标（长度/窗口 + 占用率/缓存命中率） */}
          <div className="agent-tile__page" aria-hidden={activePage !== 1}>
            <div className="agent-tile__role">CONTEXT</div>
            <div className="agent-tile__ctx-line">{ctxLine1}</div>
            <div className="agent-tile__ctx-line agent-tile__ctx-line--dim">{ctxLine2}</div>
          </div>
        </div>
      </div>

      <div className="agent-tile__footer">
        <span className={`state-dot ${STATE_DOT_CLASS[agent.state]}`} aria-hidden="true" />
        <span className="agent-tile__footer-time">{formatShortTime(agent.last_active_at)}</span>
      </div>

      {/* running 边框扫描层（interactionv2 .pre 边框滚动效果；快慢由 phase 驱动） */}
      {scanKind ? <span className="agent-tile__scan" aria-hidden="true" /> : null}

      {/* hover 浮现的黑色 utility 条：单击 OPEN 进会话 */}
      <div
        className={`agent-tile__utility${hovering ? " agent-tile__utility--visible" : ""}`}
        role="button"
        tabIndex={0}
        onClick={(event) => {
          event.stopPropagation();
          onOpen(agent);
        }}
        onKeyDown={(event) => {
          if (event.key === "Enter" || event.key === " ") {
            event.preventDefault();
            event.stopPropagation();
            onOpen(agent);
          }
        }}
      >
        OPEN <span className="agent-tile__utility-key">↵</span>
      </div>
    </button>
  );
}

// memo：SSE agent_state 事件只改动单个 agent 对象，`agents` 数组里其余元素引用不变，
// 配合父级稳定的回调 props（useCallback / store action），未变化的磁贴全部跳过重渲染。
export default memo(AgentTile);