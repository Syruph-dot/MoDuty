import { useEffect, useLayoutEffect, useMemo, useRef, useState, type CSSProperties, type ReactNode } from "react";
import { useTileAnimation } from "./desktop/AnimationProvider";

import {
  useDrag,
  type DragMode,
  type ResizeDirection,
} from "../lib/dragController";
import { snapGeometry, type SnapGuide } from "../lib/snapController";
import {
  gridToPixels,
  quantizeResize,
  type GridMetrics,
  type TileGridMap,
} from "../lib/gridLayout";
import type { TileGeometry, TileGrid } from "../types";
import { useSnapGuideStore } from "../state/snapGuideStore";
import { useGhostStore } from "../state/ghostStore";
import { useContextMenuStore, type ContextMenuItem } from "../state/contextMenuStore";
import { useDialogStore } from "../state/dialogStore";
import { useAgentsStore } from "../state/agentsStore";

/**
 * 磁贴壳的交互模式：
 * - free     —— 无磁贴打开时：Win8 网格拖动 + 量化缩放（现状自由态已去自由化）
 * - expanded —— 打开态右舞台窗口：仅拖拽把手（header）可拖、禁 resize；
 *               拖到屏幕左/右极端松手 → onDropToEdge（丢弃关闭），否则回弹到布局位置
 */
export type TileShellMode = "free" | "expanded";

interface TileShellProps {
  /** 唯一 id（用于 data-attr / 调试） */
  id: string;
  /** Agent 名称（卡片右键删除确认时用） */
  agentName?: string;
  /** 当前像素几何（free 模式由 gridToPixels 派生；open 模式由布局引擎计算） */
  geometry: TileGeometry;
  /** 当前网格几何（free 模式交互的事实来源） */
  grid?: TileGrid;
  /** 全量磁贴网格（free 模式冲突/量化用；含自身，引擎会排除 selfId） */
  gridMap?: TileGridMap;
  /** 网格度量（free 模式像素↔网格换算用） */
  metrics?: GridMetrics;
  /**
   * 拖动中上报「磁贴中心」（内容区坐标，已含滚动补偿）——
   * TileShell 只管像素跟手与上报，落点含义由 Desktop 解译灰框位置得出。
   */
  onDragMove?: (centerX: number, centerY: number) => void;
  /** 松手提交：移位由 Desktop 按灰框解译决定（次不回传）；缩放把壳内算好的量化网格回传 */
  onCommit: (next?: TileGrid) => void;
  /** z-index（用于选中置顶） */
  zIndex?: number;
  /** 其它磁贴的像素几何（expanded 模式的边吸附用） */
  others?: TileGeometry[];
  /** 是否禁用 resize */
  disableResize?: boolean;
  /** 交互模式（默认 free） */
  mode?: TileShellMode;
  /** expanded 模式下可拖拽的把手选择器（如 .agent-window__header）；未命中则不启动拖拽 */
  dragHandleSelector?: string;
  /** T5：打开卡拖到屏幕左/右极端 → 丢弃关闭（V2 左坞已删除，只剩这一个边缘行为） */
  onDropToEdge?: (id: string) => void;
  /** expanded 模式：拖到左坞松手后触发（关闭该磁贴） */
  /** T3 草稿纸模式：expanded 松手时把最终世界 X 交回父级（并做释放惯性） */
  onWorldXCommit?: (x: number) => void;
  /** Y 错位提交：解锁后松手把最终 Y（top）交回父级（与 X 一同提交） */
  onWorldYCommit?: (y: number) => void;
  /** T4 expanded 被点击激活（置顶） */
  onActivate?: () => void;
  /** T5 边缘丢弃：传给壳的视口宽（px）与当前内容滚动量，用于左右极端判定 */
  edgeViewportWidth?: number;
  edgeScrollX?: number;
  /** 统一打开回调（Tile 抽象）：双击磁贴（非拖动）触发；agent/browser 传入，widget 不传 */
  onOpenTile?: () => void;
  /** 第一显示态内容（未展开的小卡片正面） */
  children: ReactNode;
  /** 第二显示态内容（展开窗口背面，仅打开时挂载） */
  back?: ReactNode;
  /** 是否处于展开态 → 双面翻转 rotateY 0→180°（0~90° 显第一态，90~180° 显第二态） */
  flipped?: boolean;
  /** 自定义右键菜单项；传入时覆盖默认（agent）菜单。用于 widget 等非 agent 磁贴。 */
  contextMenuItems?: ContextMenuItem[];
  /** 灰框让位预览中：让位/恢复过渡用 240ms 快速动画（2.25×） */
  displacedPreview?: boolean;
  /** 落点目标高亮：灰框当前落在该磁贴上（Desktop 解译结果） */
  dropTarget?: boolean;
  /** 组带起始 X（px，内容区相对坐标）：缩放灰框像素派生时叠加 */
  bandX?: number;
  /** 打开态画布弱化层：未打开的磁贴以画布位置弱化显示（透明可见初始画布） */
  canvasGhost?: boolean;
}

/** 开合动画统一速度曲线：无加速仅减速（先快后慢） */
const ANIM_EASE = "cubic-bezier(0, 0, 0.2, 1)";
/** 开合动画统一时长（320ms → 速度降为 60% ≈ 533ms，取整 540） */
const ANIM_DURATION_MS = 540;
/** 灰框让位过渡：加速到 2.25 倍（540 / 2.25 = 240） */
const DISPLACE_DURATION_MS = 240;

const MIN_W = 200;
const MIN_H = 120;
const MAX_W = 1200;
const MAX_H = 900;
/** Y 锁定阈值 px：拖拽垂直位移未超此值前 Y 保持不动；一旦超过即解锁，XY 都跟手（进入错位） */
const Y_LOCK_PX = 25;

/**
 * 根据拖拽模式把 delta 应用到原始 geometry 上（像素跟手；free+resize 时仅用于视觉）：
 * - move: 整块平移
 * - resize-{dir}: 改边/角，根据方向调整 x/y/w/h
 */
const RESIZE_HANDLES: Array<{ dir: ResizeDirection; pos: CSSProperties; cursor: string }> = [
  { dir: "nw", pos: { top: 0, left: 0, width: 12, height: 12, cursor: "nwse-resize" }, cursor: "nwse-resize" },
  { dir: "n", pos: { top: 0, left: "50%", width: 24, height: 8, transform: "translateX(-50%)", cursor: "ns-resize" }, cursor: "ns-resize" },
  { dir: "ne", pos: { top: 0, right: 0, width: 12, height: 12, cursor: "nesw-resize" }, cursor: "nesw-resize" },
  { dir: "e", pos: { top: "50%", right: 0, width: 8, height: 24, transform: "translateY(-50%)", cursor: "ew-resize" }, cursor: "ew-resize" },
  { dir: "se", pos: { bottom: 0, right: 0, width: 14, height: 14, cursor: "nwse-resize" }, cursor: "nwse-resize" },
  { dir: "s", pos: { bottom: 0, left: "50%", width: 24, height: 8, transform: "translateX(-50%)", cursor: "ns-resize" }, cursor: "ns-resize" },
  { dir: "sw", pos: { bottom: 0, left: 0, width: 12, height: 12, cursor: "nesw-resize" }, cursor: "nesw-resize" },
  { dir: "w", pos: { top: "50%", left: 0, width: 8, height: 24, transform: "translateY(-50%)", cursor: "ew-resize" }, cursor: "ew-resize" },
];

function applyDelta(
  origin: TileGeometry,
  dx: number,
  dy: number,
  mode: DragMode,
): TileGeometry {
  if (mode === "move") {
    return { x: origin.x + dx, y: origin.y + dy, w: origin.w, h: origin.h };
  }
  const dir = mode.slice("resize-".length) as ResizeDirection;
  let { x, y, w, h } = origin;

  if (dir.includes("e")) {
    w = Math.min(MAX_W, Math.max(MIN_W, origin.w + dx));
  }
  if (dir.includes("w")) {
    const newW = Math.min(MAX_W, Math.max(MIN_W, origin.w - dx));
    if (newW !== origin.w) {
      x = origin.x + (origin.w - newW);
      w = newW;
    }
  }
  if (dir.includes("s")) {
    h = Math.min(MAX_H, Math.max(MIN_H, origin.h + dy));
  }
  if (dir.includes("n")) {
    const newH = Math.min(MAX_H, Math.max(MIN_H, origin.h - dy));
    if (newH !== origin.h) {
      y = origin.y + (origin.h - newH);
      h = newH;
    }
  }
  return { x, y, w, h };
}

/**
 * 可拖拽 + 8 方向量化缩放 + Win8 网格吸附的磁贴壳。
 *
 * free 模式（去自由化）：
 * - 拖动中：磁贴本体**像素跟手**（无量化、无 transition），同时计算“量化落点”
 *   （移动 → findDropTarget；缩放 → quantizeResize），经 ghost 提示框显示
 * - 松手：提交 ghost 网格 → store 更新 → 恢复 transition，本体自动动画过渡到落点
 * - 不支持自由像素位置：所有落点都在网格上、尺寸都在 TILE_SIZES 内
 *
 * expanded 模式沿用旧像素逻辑（snap + 左坞收起回弹）。
 */
export default function TileShell({
  id,
  agentName,
  geometry,
  grid,
  gridMap,
  metrics,
  onDragMove,
  onCommit,
  zIndex,
  others,
  disableResize,
  mode = "free",
  dragHandleSelector,
  onDropToEdge,
  onOpenTile,
  onWorldXCommit,
  onWorldYCommit,
  onActivate,
  edgeViewportWidth = 0,
  edgeScrollX = 0,
  children,
  back,
  flipped = false,
  contextMenuItems,
  displacedPreview = false,
  dropTarget = false,
  bandX = 0,
  canvasGhost = false,
}: TileShellProps) {
  const showContextMenu = useContextMenuStore((state) => state.show);
  const openRename = useDialogStore((state) => state.openRename);
  const openConfirm = useDialogStore((state) => state.openConfirm);
  const deleteAgent = useAgentsStore((state) => state.deleteAgent);
  const originRef = useRef<TileGeometry | null>(null);
  const originGridRef = useRef<TileGrid | null>(null);
  const ghostRef = useRef<TileGrid | null>(null);
  const shiftRef = useRef(false);
  // T3 草稿纸模式（onWorldXCommit 存在时启用）：释放瞬间速度 → 惯性滑动
  const paperLastMoveRef = useRef<{ time: number; clientX: number } | null>(null);
  const paperVelRef = useRef(0); // px/ms
  const paperInertiaRef = useRef<{ raf: number; offsetX: number; v: number; lastT: number; dragTotal: number } | null>(null);
  /** 惯性滑行中：关闭 CSS transition（避免松手后分段/滞后），由 rAF 接管位移 */
  const [paperGlide, setPaperGlide] = useState(false);
  const cancelPaperInertia = () => {
    const cur = paperInertiaRef.current;
    if (cur) {
      window.cancelAnimationFrame(cur.raf);
      paperInertiaRef.current = null;
    }
    setPaperGlide(false);
  };
  const paperMode = mode === "expanded" && !!onWorldXCommit;
  /** T5：拖拽进入屏幕左/右极端（中心越出视口）时置位，松手 → 复用现有关闭逻辑 */
  const [edgeSide, setEdgeSide] = useState<0 | 1 | -1>(0);
  const edgeSideRef = useRef<0 | 1 | -1>(0);
  /** Y 锁定状态：本次拖拽垂直位移未超 Y_LOCK_PX 前锁定（不产生 Y 位移），一旦超阈值即解锁（XY 都跟手） */
  const paperYUnlockRef = useRef(false);
  // 拖动/点击抑制：真实拖动（位移超阈值）后短暂抑制 click/双击，
  // 避免“拖一下没到位→松手”被浏览器合成 click/双击而意外打开磁贴
  const suppressClock = useRef<{ active: boolean; timer: number | null }>({ active: false, timer: null });
  const armSuppressClick = () => {
    suppressClock.current.active = true;
    if (suppressClock.current.timer !== null) {
      window.clearTimeout(suppressClock.current.timer);
    }
    suppressClock.current.timer = window.setTimeout(() => {
      suppressClock.current.active = false;
      suppressClock.current.timer = null;
    }, 500);
  };
  // 拖拽中的视觉偏移（四维：x/y 平移 + w/h 尺寸增量）——resize 时壳尺寸也要实时跟随鼠标
  const [dragOffset, setDragOffset] = useState({ x: 0, y: 0, w: 0, h: 0 });
  // expanded 模式：拖拽进入左坞区域时的反馈标志
  // 收拢（二态→一态）时保留最后一张背面，直到翻转动画完成再卸载——避免窗口"直接消失"
  const lastBackRef = useRef<ReactNode | null>(null);
  if (back) {
    lastBackRef.current = back;
  }
  const [retiredBack, setRetiredBack] = useState<ReactNode | null>(null);
  useEffect(() => {
    if (!flipped) {
      // 从展开转回未展开：把最后一张背面托住到退场翻转结束
      if (lastBackRef.current) {
        setRetiredBack(lastBackRef.current);
        const timer = setTimeout(() => setRetiredBack(null), ANIM_DURATION_MS + 100);
        return () => clearTimeout(timer);
      }
    }
    setRetiredBack(null);
    return undefined;
  }, [flipped]);
  const setSnapGuides = useSnapGuideStore((s) => s.setGuides);
  const clearSnapGuides = useSnapGuideStore((s) => s.clear);
  const setGhost = useGhostStore((s) => s.setGhost);
  const clearGhost = useGhostStore((s) => s.clearGhost);

  // 全局 shift 状态：expanded 拖动期间按 Shift = 强制网格吸附（不吸边）
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Shift") shiftRef.current = event.shiftKey;
    };
    window.addEventListener("keydown", onKey);
    window.addEventListener("keyup", onKey);
    return () => {
      window.removeEventListener("keydown", onKey);
      window.removeEventListener("keyup", onKey);
    };
  }, []);

  // 卸载时清理点击抑制计时器
  useEffect(() => {
    return () => {
      if (suppressClock.current.timer !== null) {
        window.clearTimeout(suppressClock.current.timer);
      }
    };
    // 仅挂载/卸载时执行一次
  }, []);

  const otherGeoms = useMemo(() => others ?? [], [others]);

  const computeSnap = (
    next: TileGeometry,
    shift: boolean,
  ): { snapped: TileGeometry; guides: SnapGuide[] } => {
    const result = snapGeometry(next, otherGeoms, { shift });
    return { snapped: result.geometry, guides: result.guides };
  };

  /**
   * free 模式缩放：由鼠标 delta 算出量化尺寸/位置。
   * 移动不再在这里判定——鼠标位置只用于“像素跟手”，灰框落点由 Desktop 解译。
   */
  const computeResizeGhost = (dx: number, dy: number, dragMode: DragMode): TileGrid | null => {
    if (!originGridRef.current || !metrics || !gridMap) return null;
    const dir = dragMode.slice("resize-".length) as ResizeDirection;
    return quantizeResize(gridMap, id, dir, originGridRef.current, dx, dy, metrics);
  };

  // 拖动中最后一次 delta（供画布边缘自动滚动时同步重算 ghost）
  const lastDeltaRef = useRef({ dx: 0, dy: 0 });
  // 画布自动滚动累计补偿（px）：滚动后 ghost 计算统一叠加，保持磁贴相对指针跟手
  const scrollCompRef = useRef(0);
  // free 拖动主体：由 useDrag.onMove 与画布滚动补偿共用（滚动时叠加 scrollComp → ghost 跟手）
  const applyFreeMoveRef = useRef<(dx: number, dy: number, dragMode: DragMode, event: { clientX: number; clientY: number }) => void>(() => {});
  applyFreeMoveRef.current = (dx, dy, dragMode, _event) => {
    if (!originRef.current || !metrics) return;
    const originPx = originRef.current;
    const effDx = dx + scrollCompRef.current;
    // 本体像素跟手（无量化）→ 视觉即时响应鼠标
    const nextPx = applyDelta(originPx, effDx, dy, dragMode);
    setDragOffset({
      x: nextPx.x - originPx.x,
      y: nextPx.y - originPx.y,
      w: nextPx.w - originPx.w,
      h: nextPx.h - originPx.h,
    });
    if (dragMode === "move") {
      // 落点判定全部交给 Desktop：上报磁贴中心（内容区坐标），由它解译灰框位置与含义
      onDragMove?.(nextPx.x + nextPx.w / 2, nextPx.y + nextPx.h / 2);
      return;
    }
    // 缩放：灰框仍在壳内算（尺寸量化不跨带）
    const ghost = computeResizeGhost(effDx, dy, dragMode);
    ghostRef.current = ghost;
    if (ghost) {
      setGhost(gridToPixels(ghost, metrics, bandX));
    }
  };

  // T3：草稿纸模式释放后的减速惯性动画（仅 X 平移，rAF 指数衰减；Y 已在松手瞬间落位）
  const startPaperInertia = (dragTotal: number, v0: number) => {
    cancelPaperInertia();
    const state = { raf: 0, offsetX: dragTotal, v: v0, lastT: performance.now(), dragTotal };
    paperInertiaRef.current = state;
    setPaperGlide(true);
    const step = () => {
      const cur = paperInertiaRef.current;
      if (!cur) return;
      const now = performance.now();
      const dtMs = Math.min(32, now - cur.lastT);
      cur.lastT = now;
      cur.v *= Math.pow(0.9, dtMs / 16.7);
      cur.offsetX += cur.v * dtMs;
      if (Math.abs(cur.v) < 0.06 || Math.abs(cur.offsetX - cur.dragTotal) > 2200) {
        paperInertiaRef.current = null;
        setPaperGlide(false);
        const base = originRef.current?.x ?? geometry.x;
        onWorldXCommit?.(base + cur.offsetX);
        setDragOffset({ x: 0, y: 0, w: 0, h: 0 });
        return;
      }
      setDragOffset((prev) => ({ x: cur.offsetX, y: prev.y, w: 0, h: 0 }));
      cur.raf = requestAnimationFrame(step);
    };
    state.raf = requestAnimationFrame(step);
  };

  const { onMouseDown, isDragging, mode: dragMode } = useDrag({
    onMove: (dx, dy, dragMode, event) => {
      if (mode === "free") {
        lastDeltaRef.current = { dx, dy };
        applyFreeMoveRef.current(dx, dy, dragMode, event);
        return;
      }
      // expanded：沿用旧像素 snap + 左坞检测
      if (!originRef.current) return;
      const next = applyDelta(originRef.current, dx, dy, dragMode);
      if (paperMode) {
        // T3 草稿纸：X 像素跟手；Y 在垂直位移阈值内锁定（dragOffset.y=0），超阈值后解锁并跟随（错位）
        const dyFromStart = next.y - geometry.y;
        if (!paperYUnlockRef.current && Math.abs(dyFromStart) > Y_LOCK_PX) {
          paperYUnlockRef.current = true;
        }
        setDragOffset({
          x: next.x - geometry.x,
          y: paperYUnlockRef.current ? dyFromStart : 0,
          w: 0,
          h: 0,
        });
        // T5：屏幕中心 = 世界 X − 内容滚动量；越出左右视口 → 丢弃意图
        let side: 0 | 1 | -1 = 0;
        if (edgeViewportWidth > 0) {
          const centerScreen = next.x + next.w / 2 - edgeScrollX;
          if (centerScreen < 0) side = -1;
          else if (centerScreen > edgeViewportWidth) side = 1;
        }
        edgeSideRef.current = side;
        setEdgeSide(side);
        const now = performance.now();
        const prev = paperLastMoveRef.current;
        if (prev) {
          const dtMs = Math.max(1, now - prev.time);
          paperVelRef.current = (event.clientX - prev.clientX) / dtMs;
        }
        paperLastMoveRef.current = { time: now, clientX: event.clientX };
        return;
      }
      const { snapped, guides } = computeSnap(next, shiftRef.current);
      setSnapGuides(guides);
      setDragOffset({
        x: snapped.x - geometry.x,
        y: snapped.y - geometry.y,
        w: snapped.w - geometry.w,
        h: snapped.h - geometry.h,
      });
    },
    onEnd: (dx, dy, didMove, _dragMode) => {
      // 真实拖动过：短暂抑制 click/双击，避免误打开
      if (didMove) {
        armSuppressClick();
      }
      if (mode === "free") {
        if (didMove) {
          // 移位：落点由 Desktop 按灰框解译决定（不回传网格）；缩放：回传壳内算好的量化网格
          onCommit(ghostRef.current ?? undefined);
        }
      } else if (didMove && originRef.current) {
        if (paperMode) {
          // T5：拖到屏幕左/右极端 → 丢弃关闭（复用父级现有关闭，不重写）
          if (edgeSideRef.current !== 0) {
            onDropToEdge?.(id);
          } else {
            // Y 错位：仅解锁后提交（锁定态 Y 保持原 top，不写）——松手瞬间提交，避免 Y 再独立滑动
            const finalY = originRef.current.y + (paperYUnlockRef.current ? dy : 0);
            if (paperYUnlockRef.current) {
              onWorldYCommit?.(finalY);
              setDragOffset((prev) => ({ ...prev, y: 0 }));
            }
            // T3：松手 → 速度足够时执行减速惯性（仅 X）；否则直接落位提交世界 X
            const vx = paperVelRef.current || 0;
            if (Math.abs(vx) > 0.5) {
              startPaperInertia(dx, vx);
            } else {
              onWorldXCommit?.(originRef.current.x + dx);
            }
          }
        } else {
          // 打开卡拖拽只移动位置（不落盘、不污染 idle tiles）
        }
      }
      originRef.current = null;
      originGridRef.current = null;
      ghostRef.current = null;
      scrollCompRef.current = 0;
      // 惯性进行中保留 dragOffset（rAF 接管）；否则清 0 回到 geometry
      if (!paperMode || paperInertiaRef.current === null) {
        setDragOffset({ x: 0, y: 0, w: 0, h: 0 });
      }
      edgeSideRef.current = 0;
      setEdgeSide(0);
      clearSnapGuides();
      clearGhost();
    },
  });

  // 外部 geometry 变化（如 store 还原）时，清掉本地 drag offset（惯性滑行中保留 X offset）
  useEffect(() => {
    if (!isDragging) {
      if (!paperGlide) {
        setDragOffset({ x: 0, y: 0, w: 0, h: 0 });
      }
      edgeSideRef.current = 0;
      setEdgeSide(0);
    }
  }, [geometry.x, geometry.y, geometry.w, geometry.h, isDragging, paperGlide]);

  // 拖动中的指针坐标由 Desktop 全局 mousemove 转发（.tile-shell--dragging）驱动 hover 状态机，TileShell 不介入

  // 画布边缘自动滚动补偿：Desktop 滚动时派发 momoka:wall-scroll，
  // 这里把滚动量叠加到累计补偿并立即重算 ghost（保持磁贴相对指针跟手）
  useEffect(() => {
    const onWallScroll = (event: Event) => {
      const detail = (event as CustomEvent).detail as { delta?: number; clientX?: number; clientY?: number } | undefined;
      const delta = detail?.delta;
      if (!delta || !isDragging || !originRef.current) return;
      if (dragMode === "move") {
        scrollCompRef.current += delta;
        const last = lastDeltaRef.current;
        applyFreeMoveRef.current(last.dx, last.dy, "move", {
          clientX: detail.clientX ?? 0,
          clientY: detail.clientY ?? 0,
        });
      }
    };
    window.addEventListener("momoka:wall-scroll", onWallScroll);
    return () => window.removeEventListener("momoka:wall-scroll", onWallScroll);
  }, [isDragging, dragMode]);

  // 进入/退出动画样式
  const { registerTile, unregisterTile, getTileAnimationStyle } = useTileAnimation();

  // 注册磁贴到动画系统：仅挂载时标记 isNew=true（触发进入动画），卸载时立即移除。
  // 注意不能放在渲染体里直接调用——registerTile 内部是 setState，渲染期更新会引发无限重渲染卡死。
  // 用 useLayoutEffect：注册必须在 paint 之前完成，否则首帧会以“最终形态”渲染一帧，
  // 随后状态变成 entering 才隐藏/播放动画，表现为磁贴先闪一下再消失重播。
  const isFirstRenderRef = useRef(true);
  useLayoutEffect(() => {
    registerTile(id, geometry, isFirstRenderRef.current);
    isFirstRenderRef.current = false;
    return () => unregisterTile(id, true);
  }, [id, registerTile, unregisterTile]);

  // 几何变化（布局/拖动/尺寸）时同步到动画系统，用于视口剔除判断。
  // registerTile 已幂等：几何内容未变时 bail out，不会触发额外渲染。
  useLayoutEffect(() => {
    registerTile(id, geometry, false);
  }, [id, geometry, registerTile]);

  // 墙的入场/退场动画只服务“磁贴墙上的磁贴”：
  // 展开态窗口（mode="expanded"）是“已经打开”的卡片，它靠翻转 + 几何过渡出现，
  // 不能等墙的扫描线扫到（否则首次挂载就恰好是展开态时会被卡在 scale(0)/opacity:0 的入场起点 →
  // 看起来“点了没反应”）。值日生窗口就是这种情况：它在空闲态被墙治理过滤、不挂载。
  const animStyle = mode === "expanded" ? null : getTileAnimationStyle?.(id) ?? null;

  const onTileContextMenu = (event: React.MouseEvent) => {
    // 展开态（打开的对话窗口）不弹卡片菜单，避免与窗口内交互冲突
    if (mode === "expanded") return;
    event.preventDefault();
    event.stopPropagation();
    // 调用方自定义菜单优先（widget 等非 agent 磁贴）
    if (contextMenuItems) {
      showContextMenu({ x: event.clientX, y: event.clientY }, contextMenuItems);
      return;
    }
    const items: ContextMenuItem[] = [
      {
        id: "rename-agent",
        label: "重命名 Agent",
        onClick: () => openRename(id),
      },
      {
        id: "delete-agent",
        label: "删除 Agent",
        onClick: () =>
          openConfirm({
            title: "删除 Agent",
            message: `确定删除 Agent「${agentName ?? id}」吗？该操作会一并删除其会话且不可恢复。`,
            confirmLabel: "删除",
            onConfirm: () => {
              // 失败时错误已写入 agentsStore.error（桌面顶部展示）；这里吞掉 rejection 避免未处理异常
              void deleteAgent(id).catch(() => undefined);
            },
          }),
      },
    ];
    showContextMenu({ x: event.clientX, y: event.clientY }, items);
  };

  const startMove = (event: React.MouseEvent) => {
    cancelPaperInertia();
    if (mode === "expanded") {
      // 展开窗口只有拖拽把手（header）可以拖动；其余区域（输入框/按钮）不触发
      if (
        dragHandleSelector &&
        !(event.target instanceof Element && event.target.closest(dragHandleSelector))
      ) {
        return;
      }
    }
    originRef.current = { ...geometry };
    paperVelRef.current = 0;
    paperLastMoveRef.current = null;
    paperYUnlockRef.current = false;
    edgeSideRef.current = 0;
    setEdgeSide(0);
    if (paperMode) {
      setDragOffset({ x: 0, y: 0, w: 0, h: 0 });
    }
    if (mode === "free") {
      originGridRef.current = grid ? { ...grid } : null;
    }
    onMouseDown(event, "move");
  };

  const startResize = (event: React.MouseEvent, dir: ResizeDirection) => {
    if (mode !== "free") return; // expanded（打开卡）不 resize
    originRef.current = { ...geometry };
    originGridRef.current = grid ? { ...grid } : null;
    onMouseDown(event, `resize-${dir}` as DragMode);
  };

  const visualX = geometry.x + dragOffset.x;
  const visualY = geometry.y + dragOffset.y;
  const visualW = geometry.w + dragOffset.w;
  const visualH = geometry.h + dragOffset.h;

  const animMs = displacedPreview ? DISPLACE_DURATION_MS : ANIM_DURATION_MS;
  const baseStyle: CSSProperties = {
    position: "absolute",
    left: visualX,
    top: visualY,
    width: visualW,
    height: visualH,
    zIndex: isDragging ? 1000 : zIndex ?? 1,
    transition: isDragging || paperGlide ? "none" : ["left", "top", "width", "height"].map((prop) => `${prop} ${animMs}ms ${ANIM_EASE}`).join(", "),
  };

  // 合并进入/退出动画样式
  const style: CSSProperties = animStyle ? { ...baseStyle, ...animStyle } : baseStyle;

  // 3D 翻转容器：rotateY 0（第一态）↔ 180（第二态），与位置/尺寸共用同一条减速曲线
  const flipStyle: CSSProperties = {
    position: "absolute",
    inset: 0,
    transform: `rotateY(${flipped ? 180 : 0}deg)`,
    transformStyle: "preserve-3d",
    willChange: "transform",
    transition: isDragging ? "none" : `transform ${animMs}ms ${ANIM_EASE}`,
  };

  const shellModeClass =
    mode === "expanded" ? " tile-shell--expanded" : "";
  const edgeClass = edgeSide === -1 ? " tile-shell--edge-left" : edgeSide === 1 ? " tile-shell--edge-right" : "";

  return (
    <div
      className={`tile-shell${isDragging ? " tile-shell--dragging" : ""}${shellModeClass}${edgeClass}${canvasGhost ? " tile-shell--canvas-ghost" : ""}${dropTarget ? " tile-shell--drop" : ""}`}
      style={style}
      data-tile-id={id}
      data-drag-mode={dragMode ?? ""}
      data-tile-mode={mode}
      onMouseDown={startMove}
      onDoubleClickCapture={(event) => {
        // capture 阶段拦截：拖动后的误双击不进入子组件
        if (suppressClock.current.active) {
          event.preventDefault();
          event.stopPropagation();
        }
      }}
      onClick={() => {
        // Tile 抽象统一的“单击 = 展示（打开）”；T4：打开态点击先把卡片提到最顶
        // 拖动（位移超阈值）松手后的 click 为误触，500ms 内忽略
        if (suppressClock.current.active) return;
        onActivate?.();
        onOpenTile?.();
      }}
      onContextMenu={onTileContextMenu}
    >
      <div className="tile-flip" style={flipStyle}>
        {/* 第一显示态：未展开小卡片 */}
        <div className="tile-flip__face tile-flip__face--front">{children}</div>
        {/* 第二显示态：展开窗口（只有打开时存在；rotateY 180 预转，容器转到 90° 后开始显现）
            收拢时用 retiredBack 把背面托到翻转结束，保留"翻回去"的视觉 */}
        {back ?? retiredBack ? <div className="tile-flip__face tile-flip__face--back">{back ?? retiredBack}</div> : null}
      </div>

      {disableResize || mode !== "free" ? null : RESIZE_HANDLES.map((handle) => (
        <span
          key={handle.dir}
          className={`tile-shell__handle tile-shell__handle--${handle.dir}`}
          style={handle.pos}
          role="presentation"
          onMouseDown={(event) => startResize(event, handle.dir)}
        />
      ))}
    </div>
  );
}
