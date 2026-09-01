/**
 * 磁贴墙治理（A+B+D）—— 纯逻辑层。
 *
 * 视图层过滤/分组/归档派生全部在此实现，不依赖 React：
 * - A：搜索（Enter 提交后的 query）+ 工作区/时间段/状态筛选 + 排序
 * - B：按 workspace_dir 分组（供 grouped 视图使用）
 * - D：活跃/归档两层派生（pinned > 手动归档 > 自动归档阈值）
 *
 * 数据源仅为 Agent（desktop/src/types.ts），不改后端。
 */

import { pinyin } from "pinyin-pro";

import type { Agent, AgentState } from "../types";

/* ── 状态类型 ── */

export type TimeRangeKey = "all" | "today" | "week" | "month" | "older";

export type SortKey = "active" | "created" | "messages";

export type ViewMode = "free" | "grouped";

/** 分组键（方案 B）：默认拼音首字母；可切换 */
export type GroupByKey = "pinyin" | "name" | "workspace" | "state" | "month";

export const GROUP_BY_LABELS: Record<GroupByKey, string> = {
  pinyin: "拼音首字",
  name: "会话名称",
  workspace: "工作区",
  state: "状态",
  month: "时间",
};

export interface AgentFilters {
  /** 已提交（Enter 确认）的搜索词；输入框草稿不在此 */
  query: string;
  /** 多选：勾选的工作区（原始 workspace_dir 字符串）；空 = 全部 */
  workspaces: string[];
  /** 单选：时间段 */
  timeRange: TimeRangeKey;
  /** 多选：勾选的 Agent 状态；空 = 全部 */
  states: AgentState[];
  /** 单选：排序 */
  sort: SortKey;
}

export const DEFAULT_FILTERS: AgentFilters = {
  query: "",
  workspaces: [],
  timeRange: "all",
  states: [],
  sort: "active",
};

export const TIME_RANGE_LABELS: Record<TimeRangeKey, string> = {
  all: "全部",
  today: "今天",
  week: "本周",
  month: "本月",
  older: "更早",
};

export const SORT_LABELS: Record<SortKey, string> = {
  active: "最近活跃",
  created: "最新创建",
  messages: "消息最多",
};

export const STATE_LABELS: Record<AgentState, string> = {
  idle: "空闲",
  running: "运行中",
  waiting_approval: "等待审批",
  completed: "已完成",
  error: "错误",
};

/* ── 派生：工作区 ── */

const UNCATEGORIZED = "未分类";

/** 工作区 key（分组标识）：统一斜杠 + 去尾部分隔符；空 → 未分类 */
export function workspaceKey(dir: string): string {
  if (!dir) return UNCATEGORIZED;
  const norm = dir.replace(/\\/g, "/").replace(/\/+$/g, "");
  return norm || UNCATEGORIZED;
}

/** 工作区显示名：取最后一段目录名（如 D:/a/b → b）；根路径取盘符 */
export function workspaceLabel(dir: string): string {
  const key = workspaceKey(dir);
  if (key === UNCATEGORIZED) return key;
  const parts = key.split("/").filter(Boolean);
  const last = parts[parts.length - 1] ?? key;
  // Windows 盘符（C:）单独出现时显示为 "C:" 而非 "C"
  return last.endsWith(":") ? last : last;
}

/** 去重工作区 key 列表（保持首次出现顺序） */
export function uniqueWorkspaces(agents: Agent[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const agent of agents) {
    const key = workspaceKey(agent.workspace_dir);
    if (!seen.has(key)) {
      seen.add(key);
      out.push(key);
    }
  }
  // 未分类永远排最后
  const categorized = out.filter((key) => key !== UNCATEGORIZED);
  const uncategorized = out.filter((key) => key === UNCATEGORIZED);
  return [...categorized, ...uncategorized];
}

/* ── 派生：时间窗口 ── */

function startOfDay(now: Date): number {
  const d = new Date(now);
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}

function inTimeRange(iso: string, range: TimeRangeKey, now: number): boolean {
  if (range === "all") return true;
  const ts = new Date(iso).getTime();
  if (!Number.isFinite(ts)) return false;
  if (range === "today") return ts >= startOfDay(new Date(now));
  if (range === "week") return now - ts <= 7 * 86_400_000;
  if (range === "month") return now - ts <= 30 * 86_400_000;
  if (range === "older") return now - ts > 30 * 86_400_000;
  return true;
}

/* ── 匹配：搜索 + chips ── */

function matchQuery(agent: Agent, rawQuery: string): boolean {
  const q = rawQuery.trim().toLowerCase();
  if (!q) return true;
  const haystack = [
    agent.name,
    agent.role,
    agent.workspace_dir,
    agent.session?.goal ?? "",
    agent.session?.folder_path ?? "",
  ]
    .join(" \u0000 ")
    .toLowerCase();
  return haystack.includes(q);
}

function matchFilters(agent: Agent, filters: AgentFilters, now: number): boolean {
  if (!matchQuery(agent, filters.query)) return false;
  if (filters.workspaces.length > 0 && !filters.workspaces.includes(workspaceKey(agent.workspace_dir))) {
    return false;
  }
  if (filters.states.length > 0 && !filters.states.includes(agent.state)) return false;
  if (!inTimeRange(agent.last_active_at, filters.timeRange, now)) return false;
  return true;
}

/* ── 排序 ── */

export function sortAgents(agents: Agent[], sort: SortKey): Agent[] {
  const list = [...agents];
  const ts = (iso: string) => {
    const t = new Date(iso).getTime();
    return Number.isFinite(t) ? t : 0;
  };
  if (sort === "active") {
    list.sort((a, b) => ts(b.last_active_at) - ts(a.last_active_at));
  } else if (sort === "created") {
    list.sort((a, b) => ts(b.created_at) - ts(a.created_at));
  } else {
    list.sort(
      (a, b) => (b.session?.message_count ?? 0) - (a.session?.message_count ?? 0) ||
        ts(b.last_active_at) - ts(a.last_active_at),
    );
  }
  return list;
}

/* ── D：活跃 / 归档两层派生 ── */

export interface ArchivePolicy {
  pinnedIds: string[];
  archivedIds: string[];
  archiveDays: number;
}

export interface VisibleAgents {
  /** 墙内（活跃 + 钉住，经 filters 过滤后） */
  wall: Agent[];
  /** 归档（手动 + 超阈值自动，经 filters 过滤后） */
  archived: Agent[];
  /** 归档总数（未过滤，供横幅展示） */
  archivedTotal: number;
}

/**
 * 派生可见 Agent：
 * 1. pinned 永远在墙
 * 2. 手动 archivedIds 永远在归档
 * 3. 其余按 last_active_at 距现在 > archiveDays → 自动归档（不写死 archivedIds，活跃后自动回墙）
 * 4. 墙/归档再统一应用 filters（搜索/chips/时间段）
 */
export function deriveVisibleAgents(
  agents: Agent[],
  filters: AgentFilters,
  policy: ArchivePolicy,
  now: number = Date.now(),
): VisibleAgents {
  const pinned = new Set(policy.pinnedIds);
  const manualArchived = new Set(policy.archivedIds);
  const thresholdMs = policy.archiveDays > 0 ? policy.archiveDays * 86_400_000 : 0;

  const baseWall: Agent[] = [];
  const baseArchived: Agent[] = [];
  for (const agent of agents) {
    if (pinned.has(agent.id)) {
      baseWall.push(agent);
      continue;
    }
    if (manualArchived.has(agent.id)) {
      baseArchived.push(agent);
      continue;
    }
    const inactiveFor = now - new Date(agent.last_active_at).getTime();
    const autoArchived = thresholdMs > 0 && Number.isFinite(inactiveFor) && inactiveFor > thresholdMs;
    if (autoArchived) {
      baseArchived.push(agent);
    } else {
      baseWall.push(agent);
    }
  }

  const wall = sortAgents(
    baseWall.filter((agent) => matchFilters(agent, filters, now)),
    filters.sort,
  );
  const archived = sortAgents(
    baseArchived.filter((agent) => matchFilters(agent, filters, now)),
    filters.sort,
  );

  return { wall, archived, archivedTotal: baseArchived.length };
}

/* ── 分组（方案 B）：按首字拼音首字母（用户偏好）等维度归组 ── */

/** 汉字字符 → 拼音首字母（pinyin-pro 取首字母；非汉字/无法识别归 '#'） */
export function pinyinIndexChar(char: string | undefined): string {
  const ch = (char ?? "").trim();
  if (!ch) return "#";
  const first = ch[0] ?? "#";
  if (/[a-z]/.test(first)) return first.toUpperCase();
  if (/[A-Z]/.test(first)) return first;
  const py = pinyin(first, { pattern: "first", toneType: "none" }) ?? "";
  const letter = (py[0] ?? "").toUpperCase();
  return /[A-Z]/.test(letter) ? letter : "#";
}

/** 会话名第一个字符（取英文/数字/汉字的第一可见字符） */
function firstVisibleChar(name: string): string {
  const m = /[A-Za-z0-9\u4e00-\u9fff]/.exec(name);
  return m ? m[0] : "#";
}

/** 会话时间窗标签（归档用 30 天口径） */
export function monthKeyOf(iso: string, now: number = Date.now()): string {
  const ts = new Date(iso).getTime();
  if (!Number.isFinite(ts)) return "#";
  const diff = now - ts;
  if (diff <= 30 * 86_400_000) return "本月";
  if (diff <= 90 * 86_400_000) return "近 3 个月";
  if (diff <= 360 * 86_400_000) return "今年";
  return "更早";
}

/** 分组键值：agent → 组 key（拼音字母 / 名称 / 工作区 / 状态 / 时间窗） */
export function groupKeyOf(agent: Agent, mode: GroupByKey): string {
  if (mode === "pinyin") return pinyinIndexChar(firstVisibleChar(agent.name));
  if (mode === "name") return agent.name.trim() || "未命名";
  if (mode === "workspace") return workspaceKey(agent.workspace_dir);
  if (mode === "state") return agent.state;
  return monthKeyOf(agent.last_active_at);
}

/** 分组键显示名（拼音=字母；状态=中文；其它=键本身截断） */
export function groupLabelOf(key: string, mode: GroupByKey): string {
  if (mode === "state") return STATE_LABELS[key as AgentState] ?? key;
  if (mode === "pinyin") return key;
  return key.length > 24 ? `${key.slice(0, 22)}…` : key;
}

/** 组排序权重：拼音 A→Z + # 末尾；状态按既定顺序；其它自然序 */
function groupRank(key: string, mode: GroupByKey): [number, string] {
  if (mode === "pinyin") {
    if (key === "#") return [1, ""];
    return [0, key];
  }
  if (mode === "state") {
    const order = ["running", "waiting_approval", "idle", "completed", "error"];
    const idx = order.indexOf(key);
    return [idx === -1 ? 99 : idx, key];
  }
  if (mode === "month") {
    const order = ["本月", "近 3 个月", "今年", "更早", "#"];
    const idx = order.indexOf(key);
    return [idx === -1 ? 99 : idx, key];
  }
  return [0, key];
}

export interface WorkspaceGroup {
  key: string;
  label: string;
  agents: Agent[];
}

/** 通用分组（已排序的 agents → 组序列）；activeKey 为 "all" 或组 key */
export function groupByAgents(agents: Agent[], mode: GroupByKey, activeKey: string): WorkspaceGroup[] {
  const map = new Map<string, Agent[]>();
  for (const agent of agents) {
    const key = groupKeyOf(agent, mode);
    const bucket = map.get(key) ?? [];
    bucket.push(agent);
    map.set(key, bucket);
  }
  const keys = [...map.keys()].sort((a, b) => {
    const [ra, sa] = groupRank(a, mode);
    const [rb, sb] = groupRank(b, mode);
    if (ra !== rb) return ra - rb;
    return sa.localeCompare(sb, "zh");
  });
  return keys
    .filter((key) => activeKey === "all" || key === activeKey)
    .map((key) => ({ key, label: groupLabelOf(key, mode), agents: map.get(key) ?? [] }));
}

/* ── 命中高亮 ── */

export interface HighlightSegment {
  text: string;
  hit: boolean;
}

/** 把文本按 query 切分为 <mark> 命中段（大小写不敏感；query 空白时原样返回） */
export function splitHighlight(text: string, query: string): HighlightSegment[] {
  const q = query.trim();
  if (!q || !text) return [{ text, hit: false }];
  const lowerText = text.toLowerCase();
  const lowerQ = q.toLowerCase();
  const segments: HighlightSegment[] = [];
  let cursor = 0;
  let index = lowerText.indexOf(lowerQ, cursor);
  while (index !== -1) {
    if (index > cursor) segments.push({ text: text.slice(cursor, index), hit: false });
    segments.push({ text: text.slice(index, index + q.length), hit: true });
    cursor = index + q.length;
    index = lowerText.indexOf(lowerQ, cursor);
    if (segments.length > 40) break; // 防御超长文本
  }
  if (cursor < text.length) segments.push({ text: text.slice(cursor), hit: false });
  return segments.length > 0 ? segments : [{ text, hit: false }];
}