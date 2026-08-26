import { useEffect, useRef, useState, type CSSProperties } from "react";

import type { Agent, AgentState } from "../types";
import { formatShortTime, roleLabel, tileFooter } from "../lib/tileContent";
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

/** 页2（结果页）的轮播间隔：running 时周期性预览最近结果 */
const ROTATE_MS = 8000;

interface AgentTileProps {
  agent: Agent;
  onOpen: (agent: Agent) => void;
  /** 内联重命名模式：名字区域变为白底黑框可编辑输入框（资源管理器风格，由右键菜单触发） */
  renaming?: boolean;
  /** 提交（Enter / 保存）；传入的名字已去空格 */
  onRenameCommit?: (name: string) => void;
  /** 取消（Esc） */
  onRenameCancel?: () => void;
}

/**
 * Agent 磁贴（设计稿 interactionv2 改造版）：
 * - 表面保留玻璃拟态 + 顶部状态条（不改为实色块）
 * - 正面 2 页结构：
 *   页1 = 状态 + 数据合并（role 类标 / name / big 数字 / 摘要 meta）
 *   页2 = 最近结果页（LAST RESULT / goal 摘要）
 * - running 页1↔页2 轮播（hover 暂停）；completed 固定页2；waiting/error/idle 固定页1
 * - footer = dot + 一句话状态（phase/state 文案）+ 最近活跃时间
 * - hover 浮现黑色 utility 条（OPEN ↵，单击进会话；双击磁贴同样打开）
 * - 字号 / 字体家族由 tileThemeStore 配置，经 CSS 变量注入
 */
export default function AgentTile({ agent, onOpen, renaming = false, onRenameCommit, onRenameCancel }: AgentTileProps) {
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

  // 数据驱动页切换：completed 停留结果页；running 轮播预览结果；其余固定页1
  useEffect(() => {
    if (agent.state === "completed") {
      setActivePage(1);
      return undefined;
    }
    setActivePage(0);
    if (agent.state !== "running") return undefined;
    const timer = window.setInterval(() => {
      if (hoveringRef.current) return; // hover 时暂停轮播，避免阅读被打断
      setActivePage((page) => (page === 0 ? 1 : 0));
    }, ROTATE_MS);
    return () => window.clearInterval(timer);
  }, [agent.state]);

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

  const messageCount = agent.session?.message_count ?? 0;
  const lastActive = formatShortTime(agent.last_active_at);
  const goal = agent.session?.goal?.trim();

  return (
    <button
      type="button"
      className={`agent-tile agent-tile--${agent.state}`}
      style={themeVars}
      onDoubleClick={() => onOpen(agent)}
      onMouseEnter={() => {
        hoveringRef.current = true;
        setHovering(true);
      }}
      onMouseLeave={() => {
        hoveringRef.current = false;
        setHovering(false);
      }}
      aria-label={`Agent ${agent.name}，状态 ${STATE_LABELS[agent.state]}，OPEN 或双击进入对话`}
      title="双击打开对话"
    >
      <div className="agent-tile__pages">
        {/* 页1：状态 + 数据合并（role 类标 / name / big 数字 / 摘要） */}
        <div
          className={`agent-tile__page agent-tile__page--status${activePage === 0 ? " agent-tile__page--active" : ""}`}
          aria-hidden={activePage !== 0}
        >
          <div className="agent-tile__role">{roleLabel(agent.role)}</div>
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
            <span className="agent-tile__name">{agent.name}</span>
          )}
          <div className="agent-tile__big">{messageCount}</div>
          <div className="agent-tile__sub">{messageCount === 0 ? "no messages yet" : "messages in session"}</div>
        </div>

        {/* 页2：最近结果（completed 停留；running 轮播预览） */}
        <div
          className={`agent-tile__page agent-tile__page--result${activePage === 1 ? " agent-tile__page--active" : ""}`}
          aria-hidden={activePage !== 1}
        >
          <div className="agent-tile__role">LAST RESULT</div>
          <div className="agent-tile__result">{goal || "No result yet"}</div>
        </div>
      </div>

      <div className="agent-tile__footer">
        <span className={`state-dot ${STATE_DOT_CLASS[agent.state]}`} aria-hidden="true" />
        <span className="agent-tile__footer-text" aria-live="polite">
          {tileFooter(agent)}
        </span>
        <span className="agent-tile__footer-time">{lastActive}</span>
      </div>

      {/* hover 浮现的黑色 utility 条（设计稿 .utility 的磁贴版）：单击 OPEN 进会话 */}
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