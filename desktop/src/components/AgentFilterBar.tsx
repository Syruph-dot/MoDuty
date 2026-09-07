import { useEffect, useRef, useState } from "react";

import { useAgentsStore } from "../state/agentsStore";
import {
  GROUP_BY_LABELS,
  SORT_LABELS,
  STATE_LABELS,
  TIME_RANGE_LABELS,
  uniqueWorkspaces,
  type AgentFilters,
  type GroupByKey,
  type SortKey,
  type TimeRangeKey,
} from "../lib/agentFilter";
import type { AgentState } from "../types";

const STATE_KEYS: AgentState[] = ["idle", "running", "waiting_approval", "requiring_input", "completed", "error"];
const TIME_RANGE_KEYS: TimeRangeKey[] = ["all", "today", "week", "month", "older"];
const SORT_KEYS: SortKey[] = ["active", "created", "messages"];
const GROUP_BY_KEYS: GroupByKey[] = ["pinyin", "name", "workspace", "state", "month"];

/**
 * 顶部治理栏（方案 A）：搜索 + 筛选 chips + 排序。
 * - 搜索框：本地草稿，按 Enter 提交后才生效（防止输入即检索爆炸），Esc 清空草稿
 * - chips：工作区（多选）、时间段（单选）、状态（多选）、排序（单选）
 * - 用户偏好：治理控件全部使用直角（border-radius: 0，Windows 8 Metro 风格，不用圆角矩形）
 * - 开关由 agentsStore.filterBarOpen 控制（ControlBar / 归档面板可触发）
 */
export default function AgentFilterBar() {
  const open = useAgentsStore((state) => state.filterBarOpen);
  const agents = useAgentsStore((state) => state.agents);
  const filters = useAgentsStore((state) => state.filters);
  const groupBy = useAgentsStore((state) => state.groupBy);
  const setGroupBy = useAgentsStore((state) => state.setGroupBy);
  const toggleWorkspaceFilter = useAgentsStore((state) => state.toggleWorkspaceFilter);
  const setTimeRange = useAgentsStore((state) => state.setTimeRange);
  const toggleStateFilter = useAgentsStore((state) => state.toggleStateFilter);
  const setSort = useAgentsStore((state) => state.setSort);
  const setFilterQuery = useAgentsStore((state) => state.setFilterQuery);
  const clearFilters = useAgentsStore((state) => state.clearFilters);
  const toggleFilterBar = useAgentsStore((state) => state.toggleFilterBar);

  const [draft, setDraft] = useState(filters.query);
  const inputRef = useRef<HTMLInputElement>(null);

  // 打开时同步草稿并聚焦
  useEffect(() => {
    if (open) {
      setDraft(filters.query);
      requestAnimationFrame(() => inputRef.current?.focus());
    }
  }, [open, filters.query]);

  if (!open) return null;

  const workspaces = uniqueWorkspaces(agents);

  const isDefault =
    filters.query === "" &&
    filters.workspaces.length === 0 &&
    filters.timeRange === "all" &&
    filters.states.length === 0 &&
    filters.sort === "active";

  return (
    <div
      className="filter-bar"
      role="search"
      aria-label="磁贴墙搜索与筛选"
      onKeyDown={(event) => {
        if (event.key === "Escape") toggleFilterBar();
      }}
    >
      <div className="filter-bar__row">
        {/* 搜索：Enter 提交（直角矩形输入框） */}
        <input
          ref={inputRef}
          className="filter-bar__search"
          value={draft}
          placeholder="搜索名称 / 角色 / 工作区 / 目标（Enter 开始）"
          aria-label="搜索会话（Enter 开始）"
          onChange={(event) => setDraft(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Enter") {
              event.preventDefault();
              setFilterQuery(draft.trim());
            } else if (event.key === "Escape") {
              setDraft("");
            }
          }}
        />

        {/* 排序（单选） */}
        <div className="filter-bar__group" role="group" aria-label="排序">
          {SORT_KEYS.map((key) => (
            <button
              key={key}
              type="button"
              className={`filter-chip${filters.sort === key ? " filter-chip--active" : ""}`}
              aria-pressed={filters.sort === key}
              onClick={() => setSort(key)}
            >
              {SORT_LABELS[key]}
            </button>
          ))}
        </div>

        <button
          type="button"
          className="filter-bar__close"
          aria-label="关闭筛选栏"
          onClick={toggleFilterBar}
        >
          ×
        </button>
      </div>

      <div className="filter-bar__row">
        {/* 时间段（单选） */}
        <div className="filter-bar__group" role="group" aria-label="时间段">
          <span className="filter-bar__label">时间</span>
          {TIME_RANGE_KEYS.map((key) => (
            <button
              key={key}
              type="button"
              className={`filter-chip${filters.timeRange === key ? " filter-chip--active" : ""}`}
              aria-pressed={filters.timeRange === key}
              onClick={() => setTimeRange(key)}
            >
              {TIME_RANGE_LABELS[key]}
            </button>
          ))}
        </div>

        {/* 状态（多选） */}
        <div className="filter-bar__group" role="group" aria-label="状态">
          <span className="filter-bar__label">状态</span>
          {STATE_KEYS.map((key) => {
            const active = filters.states.includes(key);
            return (
              <button
                key={key}
                type="button"
                className={`filter-chip${active ? " filter-chip--active" : ""}`}
                aria-pressed={active}
                onClick={() => toggleStateFilter(key)}
              >
                {STATE_LABELS[key]}
              </button>
            );
          })}
        </div>
      </div>

      <div className="filter-bar__row">
        {/* 分组键（单选）：拼音首字（默认）/ 名称 / 工作区 / 状态 / 时间 */}
        <div className="filter-bar__group" role="group" aria-label="分组键">
          <span className="filter-bar__label">分组</span>
          {GROUP_BY_KEYS.map((key) => (
            <button
              key={key}
              type="button"
              className={`filter-chip${groupBy === key ? " filter-chip--active" : ""}`}
              aria-pressed={groupBy === key}
              title={key === "workspace" ? "按工作区目录（迁移会话无有效工作区，多为 1 会话/组）" : undefined}
              onClick={() => setGroupBy(key)}
            >
              {GROUP_BY_LABELS[key]}
            </button>
          ))}
        </div>
      </div>

      {/* 工作区（多选）：去重列表；空 = 全部 */}
      {workspaces.length > 0 ? (
        <div className="filter-bar__row">
          <div className="filter-bar__group" role="group" aria-label="工作区">
            <span className="filter-bar__label">工作区</span>
            <button
              type="button"
              className={`filter-chip${filters.workspaces.length === 0 ? " filter-chip--active" : ""}`}
              aria-pressed={filters.workspaces.length === 0}
              onClick={() => {
                // 点「全部」清空多选
                if (filters.workspaces.length > 0) {
                  filters.workspaces.forEach((ws) => toggleWorkspaceFilter(ws));
                }
              }}
            >
              全部
            </button>
            {workspaces.map((ws) => {
              const active = filters.workspaces.includes(ws);
              return (
                <button
                  key={ws}
                  type="button"
                  className={`filter-chip filter-chip--ws${active ? " filter-chip--active" : ""}`}
                  aria-pressed={active}
                  title={ws}
                  onClick={() => toggleWorkspaceFilter(ws)}
                >
                  {shortWs(ws)}
                </button>
              );
            })}
          </div>

          {!isDefault ? (
            <button type="button" className="filter-bar__reset" onClick={clearFilters}>
              清除全部
            </button>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}

/** 工作区 chip 显示名：太长时截断中间 */
function shortWs(key: string): string {
  const label = key.split("/").filter(Boolean).pop() ?? key;
  return label.length > 18 ? `${label.slice(0, 16)}…` : label;
}

/** 仅供类型引用，避免未使用导入告警（AgentFilters 类型由 component 间接引用） */
export type { AgentFilters };