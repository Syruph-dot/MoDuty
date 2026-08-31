// Arona Chest 前后端共享数据形状（与后端 snake_case 对齐）

export type AgentState = "idle" | "running" | "waiting_approval" | "completed" | "error";
export type AgentPhase = "planning" | "searching" | "reading" | "executing" | "verifying";

/** 磁贴在桌面上的几何（绝对定位），持久化到 localStorage */
export interface TileGeometry {
  x: number;
  y: number;
  w: number;
  h: number;
}

/* ============================================================
 * Win8 磁贴网格模型（布局去自由化）
 * - 网格是唯一事实来源：5 行固定、列数不限、单位尺寸 ∈ TILE_SIZES
 * - 像素几何由 gridLayout.gridToPixels() 从 grid × cellSize 派生
 * ============================================================ */

export const GRID_ROWS = 5;

/** 磁贴可放置的起始行：第 0 行保留给其它 UI（不放置磁贴），可放置行 = 1..GRID_ROWS-1 */
export const GRID_START_ROW = 1;

/** 允许的量化尺寸集合（w/h 均为网格单位） */
export const TILE_SIZES: ReadonlyArray<{ w: number; h: number }> = [
  { w: 1, h: 1 },
  { w: 2, h: 1 },
  { w: 3, h: 1 },
  { w: 1, h: 2 },
  { w: 2, h: 2 },
  { w: 1, h: 3 },
  { w: 2, h: 3 },
  { w: 3, h: 2 },
  { w: 3, h: 3 },
];

/** Win8 磁贴网格坐标（canonical，持久化） */
export interface TileGrid {
  col: number; // 列（单位格，0..∞）
  row: number; // 行（单位格，0..GRID_ROWS-1）
  w: number; // 列跨度（∈ TILE_SIZES.w）
  h: number; // 行跨度（∈ TILE_SIZES.h）
}

export function isTileGrid(value: unknown): value is TileGrid {
  if (!value || typeof value !== "object") return false;
  const raw = value as Record<string, unknown>;
  return typeof raw.col === "number" && typeof raw.row === "number" && typeof raw.w === "number" && typeof raw.h === "number";
}

export interface SessionSummary {
  goal: string;
  folder_path: string;
  message_count: number;
  last_message_at: string;
}

/** 上下文占用指标（后端 contextStats 的 snake 化，磁贴第二页数据） */
export interface ContextStats {
  prompt_tokens: number;
  context_window: number;
  cached_tokens: number | null;
  updated_at: string;
}

export interface Agent {
  id: string;
  name: string;
  role: string;
  model?: string;
  workspace_dir: string;
  session_id: string;
  state: AgentState;
  phase: AgentPhase | null;
  last_run_duration_ms?: number | null;
  context_stats?: ContextStats | null;
  created_at: string;
  last_active_at: string;
  session: SessionSummary | null;
}

export interface AgentStateEvent {
  type: "agent_state";
  agent_id: string;
  state: AgentState;
  phase?: AgentPhase;
  context_stats?: ContextStats | null;
}
/* ============================================================
   桌面 widget（HTML 组件磁贴）：RingClock 等
   - 与 agent 磁贴平级，但永远 free 态、无 opened 生命周期、无 back
   - 几何复用 persistTiles（key 用 widget: 前缀）
   ============================================================ */

/** 已注册的 widget 种类 id */
export type WidgetKind = "ringclock" | "duty";

/** 单个 widget 实例（磁贴墙上的一个具体卡片） */
export interface WidgetInstance {
  id: string;
  kind: WidgetKind;
  title: string;
  grid: TileGrid;
}

/** widget 静态定义（注册表条目）：展示用 metadata + 渲染器工厂 */
export interface WidgetDefinition {
  kind: WidgetKind;
  /** 选择卡上显示的名字 */
  name: string;
  /** 选择卡上显示的一行描述 */
  description: string;
  /** 新建实例的默认标题（可被用户改名） */
  defaultTitle: string;
  /** 默认网格几何（首次落位用；像素由布局引擎派生） */
  defaultGrid: TileGrid;
  /** 固定尺寸：true 时 TileShell 禁用 resize（如值日生固定 2×3） */
  fixedSize?: boolean;
  /** 渲染「磁贴正面内容」的工厂（返回 React 节点） */
  renderBody: () => import("react").ReactNode;
}

/** kind → WidgetDefinition 的注册表 */
export type WidgetRegistry = Record<WidgetKind, WidgetDefinition>;

/* ============================================================
 * 受控浏览器（Browser 磁贴）
 * 浏览器是独立实体，与 Agent 解耦；Agent 经 browse_* 工具引用 browser_id。
 * ============================================================ */

export type BrowserMode = "persistent" | "incognito";
export type BrowserInstanceState = "closed" | "launching" | "ready" | "error";

export interface BrowserInfo {
  id: string;
  name: string;
  mode: BrowserMode;
  state: BrowserInstanceState;
  url: string | null;
  title: string | null;
  tabs: number;
  createdAt: string;
  lastActiveAt: string;
  profileDir: string | null;
  error?: string;
}
