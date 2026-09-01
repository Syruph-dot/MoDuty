import { useEffect, useMemo, useRef, useState, type CSSProperties, type ReactNode } from "react";

import {
  useDrag,
  type DragMode,
  type ResizeDirection,
} from "../lib/dragController";
import { snapGeometry, type SnapGuide } from "../lib/snapController";
import {
  gridToPixels,
  displaceTiles,
  quantizeResize,
  type GridMetrics,
  type TileGridMap,
} from "../lib/gridLayout";
import type { TileGeometry, TileGrid } from "../types";
import { GRID_ROWS, GRID_START_ROW } from "../types";
import { useSnapGuideStore } from "../state/snapGuideStore";
import { useGhostStore } from "../state/ghostStore";
import { useContextMenuStore, type ContextMenuItem } from "../state/contextMenuStore";
import { useDialogStore } from "../state/dialogStore";
import { useAgentsStore } from "../state/agentsStore";

/**
 * 磁贴壳的交互模式：
 * - free     —— 无磁贴打开时：Win8 网格拖动 + 量化缩放（现状自由态已去自由化）
 * - dock     —— 打开态左坞小磁贴：位置由布局引擎决定，禁拖禁 resize
 * - expanded —— 打开态右舞台窗口：仅拖拽把手（header）可拖、禁 resize；
 *               拖入左坞松手 → onDropToDock（收起），否则回弹到布局位置
 */
export type TileShellMode = "free" | "dock" | "expanded";

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
  /** 拖动结束 / 第一次落盘（写 localStorage）：free 模式提交网格几何 */
  onMove: (next: TileGrid) => void;
  /** 拖动结束 / 第一次落盘（写 localStorage）：free 模式提交网格几何 */
  onCommit: (next: TileGrid) => void;
  /** 父容器尺寸（用于 clamp，防止磁贴被拖出可见区；expanded 模式用） */
  bounds?: { width: number; height: number };
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
  /** expanded 模式：松手时磁贴中心 x 小于该值 → onDropToDock（收起） */
  dockRightEdgeX?: number;
  /** expanded 模式：拖到左坞松手后触发（关闭该磁贴） */
  onDropToDock?: (id: string) => void;
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
  /** 松手时提交“被排斥（让位）磁贴”的最终网格（id → grid）；由父级落盘，使它们定格在临时位置 */
  onCommitDisplaced?: (map: Record<string, TileGrid>) => void;
  /** 网格坐标约束（拖拽成组：组带内的允许列/r行范围；free 拖动时 nextCol/nextRow 会被 clamp 到该矩形） */
  gridClamp?: { minCol: number; maxCol: number; minRow: number; maxRow: number };
  /** 组带起始 X（px，内容区相对坐标）：ghost/像素派生时叠加，让磁贴渲染在带内 */
  bandX?: number;
  /** 打开态画布弱化层：未打开且非 dock 的磁贴以画布位置弱化显示（透明可见初始画布） */
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
const SCREEN_EDGE = 0;

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
  onMove,
  onCommit,
  bounds,
  zIndex,
  others,
  disableResize,
  mode = "free",
  dragHandleSelector,
  dockRightEdgeX,
  onDropToDock,
  onOpenTile,
  children,
  back,
  flipped = false,
  contextMenuItems,
  displacedPreview = false,
  onCommitDisplaced,
  gridClamp,
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
  const [overDock, setOverDock] = useState(false);
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
  const setDisplaced = useGhostStore((s) => s.setDisplaced);
  const clearDisplaced = useGhostStore((s) => s.clearDisplaced);

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

  /** free 模式：由鼠标 delta 计算量化 ghost 落点（网格）。移动采用“灰框滞回”：
   *  磁贴中心越过当前灰框（吸附矩形）边缘才更新到相邻格，避免过线即跳（round/floor 感）。 */
  const computeGhost = (dx: number, dy: number, dragMode: DragMode): TileGrid | null => {
    if (!originGridRef.current || !metrics || !gridMap) return null;
    const originGrid = originGridRef.current;
    if (dragMode === "move") {
      const originPx = gridToPixels(originGrid, metrics);
      const centerX = originPx.x + originPx.w / 2 + dx;
      const centerY = originPx.y + originPx.h / 2 + dy;
      // 当前吸附目标（拖动初始 = 磁贴原位置）
      const current = ghostRef.current ?? originGrid;
      const ghostPx = gridToPixels(current, metrics);
      const inside =
        centerX >= ghostPx.x && centerX <= ghostPx.x + ghostPx.w &&
        centerY >= ghostPx.y && centerY <= ghostPx.y + ghostPx.h;
      if (inside) {
        return current;
      }
      // 越过边缘 → 相邻格推进（x/y 独立判定）：ghost 允许与其它磁贴重叠，
      // 重叠磁贴由 displaceTiles 临时让位（拖动中预览），松手时再合法化落点
      let nextCol = current.col;
      let nextRow = current.row;
      if (centerX < ghostPx.x) nextCol -= 1;
      else if (centerX > ghostPx.x + ghostPx.w) nextCol += 1;
      if (centerY < ghostPx.y) nextRow -= 1;
      else if (centerY > ghostPx.y + ghostPx.h) nextRow += 1;
      nextCol = Math.max(0, nextCol);
      nextRow = Math.max(GRID_START_ROW, Math.min(nextRow, GRID_ROWS - originGrid.h));
      // 拖拽成组：限制在组带内部（不越带拖出）
      if (gridClamp) {
        nextCol = Math.max(gridClamp.minCol, Math.min(nextCol, gridClamp.maxCol));
        nextRow = Math.max(gridClamp.minRow, Math.min(nextRow, gridClamp.maxRow));
      }
      return { ...originGrid, col: nextCol, row: nextRow };
    }
    const dir = dragMode.slice("resize-".length) as ResizeDirection;
    return quantizeResize(gridMap, id, dir, originGrid, dx, dy, metrics);
  };

  // 拖动中最后一次 delta（供画布边缘自动滚动时同步重算 ghost）
  const lastDeltaRef = useRef({ dx: 0, dy: 0 });
  // 画布自动滚动累计补偿（px）：滚动后 ghost 计算统一叠加，保持磁贴相对指针跟手
  const scrollCompRef = useRef(0);
  // free 拖动主体：由 useDrag.onMove 与画布滚动补偿共用（滚动时叠加 scrollComp → ghost 跟手）
  const applyFreeMoveRef = useRef<(dx: number, dy: number, dragMode: DragMode, event: { clientX: number; clientY: number }) => void>(() => {});
  applyFreeMoveRef.current = (dx, dy, dragMode, event) => {
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
    // 量化落点 → 灰色提示框
    const ghost = computeGhost(effDx, dy, dragMode);
    ghostRef.current = ghost;
    if (ghost && metrics) {
      setGhost(gridToPixels(ghost, metrics, bandX));
      // 灰框临时让位：被波及磁贴预览布局（离开后自动恢复）
      // 指针正悬停在其它磁贴/组名上 → 抑制让位（目标稳在原位，供 Desktop hover 成组/排斥检测）；
      // 指针在空白 → 照旧让位（带内自由排布 / 组内自由布局）
      if (gridMap) {
        let hoverTarget = false;
        try {
          for (const el of document.elementsFromPoint(event.clientX, event.clientY)) {
            const tileEl = el.closest?.("[data-tile-id]") as HTMLElement | null;
            if (tileEl && tileEl.dataset.tileId && tileEl.dataset.tileId !== id) {
              hoverTarget = true;
              break;
            }
            if (el.closest?.("[data-group-name]")) {
              hoverTarget = true;
              break;
            }
          }
        } catch {
          /* elementsFromPoint 偶发不可用：回退到让位照旧 */
        }
        if (hoverTarget) {
          clearDisplaced();
        } else {
          setDisplaced(displaceTiles(gridMap, ghost, id));
        }
      }
    }
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
      const { snapped, guides } = computeSnap(next, shiftRef.current);
      setSnapGuides(guides);
      setDragOffset({
        x: snapped.x - geometry.x,
        y: snapped.y - geometry.y,
        w: snapped.w - geometry.w,
        h: snapped.h - geometry.h,
      });
      if (mode === "expanded") {
        const centerX = snapped.x + snapped.w / 2;
        setOverDock(dockRightEdgeX !== undefined && centerX < dockRightEdgeX);
      }
    },
    onEnd: (dx, dy, didMove, dragMode) => {
      // 真实拖动过：短暂抑制 click/双击，避免误打开
      if (didMove) {
        armSuppressClick();
      }
      if (mode === "free") {
        if (didMove && ghostRef.current) {
          // 松手先把“被排斥磁贴”定格在临时让位位置（若存在），再清空预览 → 由父级落盘
          if (onCommitDisplaced) {
            const displacedNow = useGhostStore.getState().displaced;
            if (displacedNow && Object.keys(displacedNow).length > 0) {
              onCommitDisplaced(displacedNow);
            }
          }
          // 按用户要求：松手直接落到灰框位置（不做冲突合法化回跳）
          const final = ghostRef.current;
          onMove(final);
          onCommit(final);
        }
      } else if (didMove && originRef.current) {
        const next = applyDelta(originRef.current, dx, dy, dragMode);
        const { snapped } = computeSnap(next, shiftRef.current);
        const finalGeom = clamp(snapped, bounds);
        if (mode === "expanded") {
          // 拖入左坞 → 收起；否则视觉回弹（不落盘、不污染 idle tiles）
          const centerX = finalGeom.x + finalGeom.w / 2;
          if (dockRightEdgeX !== undefined && centerX < dockRightEdgeX) {
            onDropToDock?.(id);
          }
        }
      }
      originRef.current = null;
      originGridRef.current = null;
      ghostRef.current = null;
      scrollCompRef.current = 0;
      setDragOffset({ x: 0, y: 0, w: 0, h: 0 });
      setOverDock(false);
      clearSnapGuides();
      clearGhost();
      clearDisplaced();
    },
  });

  // 外部 geometry 变化（如 store 还原）时，清掉本地 drag offset
  useEffect(() => {
    if (!isDragging) {
      setDragOffset({ x: 0, y: 0, w: 0, h: 0 });
      setOverDock(false);
    }
  }, [geometry.x, geometry.y, geometry.w, geometry.h, isDragging]);

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
    if (mode === "dock") return; // 坞磁贴位置由布局计算，不响应拖拽
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
    if (mode === "free") {
      originGridRef.current = grid ? { ...grid } : null;
    }
    onMouseDown(event, "move");
  };

  const startResize = (event: React.MouseEvent, dir: ResizeDirection) => {
    if (mode !== "free") return; // dock / expanded 均不 resize
    originRef.current = { ...geometry };
    originGridRef.current = grid ? { ...grid } : null;
    onMouseDown(event, `resize-${dir}` as DragMode);
  };

  const visualX = geometry.x + dragOffset.x;
  const visualY = geometry.y + dragOffset.y;
  const visualW = geometry.w + dragOffset.w;
  const visualH = geometry.h + dragOffset.h;

  const animMs = displacedPreview ? DISPLACE_DURATION_MS : ANIM_DURATION_MS;
  const style: CSSProperties = {
    position: "absolute",
    left: visualX,
    top: visualY,
    width: visualW,
    height: visualH,
    zIndex: isDragging ? 1000 : zIndex ?? 1,
    transition: isDragging ? "none" : ["left", "top", "width", "height"].map((prop) => `${prop} ${animMs}ms ${ANIM_EASE}`).join(", "),
  };

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
    mode === "dock" ? " tile-shell--dock" : mode === "expanded" ? " tile-shell--expanded" : "";

  return (
    <div
      className={`tile-shell${isDragging ? " tile-shell--dragging" : ""}${overDock ? " tile-shell--over-dock" : ""}${shellModeClass}${canvasGhost ? " tile-shell--canvas-ghost" : ""}`}
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
        // Tile 抽象统一的“单击 = 展示（打开）”
        // 拖动（位移超阈值）松手后的 click 为误触，500ms 内忽略
        if (suppressClock.current.active) return;
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

/** 把磁贴 clamp 到父容器内（顶部不限制、左右下边各留至少 32px 在屏内；expanded 模式用） */
function clamp(geom: TileGeometry, bounds?: { width: number; height: number }): TileGeometry {
  if (!bounds) return geom;
  const maxX = Math.max(SCREEN_EDGE, bounds.width - 32);
  const maxY = Math.max(SCREEN_EDGE, bounds.height - 32);
  return {
    x: Math.min(Math.max(geom.x, -(geom.w - 32)), maxX),
    y: Math.min(Math.max(geom.y, SCREEN_EDGE), maxY),
    w: geom.w,
    h: geom.h,
  };
}