import { useEffect, useMemo, useRef, useState, type CSSProperties, type ReactNode } from "react";

import {
  useDrag,
  type DragMode,
  type ResizeDirection,
} from "../lib/dragController";
import { snapGeometry, type SnapGuide } from "../lib/snapController";
import type { TileGeometry } from "../types";
import { useSnapGuideStore } from "../state/snapGuideStore";
import { useContextMenuStore, type ContextMenuItem } from "../state/contextMenuStore";
import { useDialogStore } from "../state/dialogStore";
import { useAgentsStore } from "../state/agentsStore";

/**
 * 磁贴壳的交互模式：
 * - free     —— 无磁贴打开时：自由拖拽 + 8 方向 resize（现状）
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
  /** 当前几何（由 store 传入；拖动中是高频更新的值） */
  geometry: TileGeometry;
  /** 拖动中持续触发（仅改 store，不写 localStorage） */
  onMove: (next: TileGeometry) => void;
  /** 拖动结束 / 第一次挂载时触发（落盘 localStorage） */
  onCommit: (next: TileGeometry) => void;
  /** 父容器尺寸（用于 clamp，防止磁贴被拖出可见区） */
  bounds?: { width: number; height: number };
  /** z-index（用于选中置顶） */
  zIndex?: number;
  /** 其它磁贴的几何（用于边缘吸附） */
  others?: TileGeometry[];
  /** 是否禁用 resize（用于未来只读场景） */
  disableResize?: boolean;
  /** 交互模式（默认 free） */
  mode?: TileShellMode;
  /** expanded 模式下可拖拽的把手选择器（如 .agent-window__header）；未命中则不启动拖拽 */
  dragHandleSelector?: string;
  /** expanded 模式：松手时磁贴中心 x 小于该值 → onDropToDock（收起） */
  dockRightEdgeX?: number;
  /** expanded 模式：拖到左坞松手后触发（关闭该磁贴） */
  onDropToDock?: (id: string) => void;
  /** 第一显示态内容（未展开的小卡片正面） */
  children: ReactNode;
  /** 第二显示态内容（展开窗口背面，仅打开时挂载） */
  back?: ReactNode;
  /** 是否处于展开态 → 双面翻转 rotateY 0→180°（0~90° 显第一态，90~180° 显第二态） */
  flipped?: boolean;
  /** 自定义右键菜单项；传入时覆盖默认（agent）菜单。用于 widget 等非 agent 磁贴。 */
  contextMenuItems?: ContextMenuItem[];
}

/** 开合动画统一速度曲线：无加速仅减速（先快后慢） */
const ANIM_EASE = "cubic-bezier(0, 0, 0.2, 1)";
/** 开合动画统一时长（320ms → 速度降为 60% ≈ 533ms，取整 540） */
const ANIM_DURATION_MS = 540;

const MIN_W = 200;
const MIN_H = 120;
const MAX_W = 1200;
const MAX_H = 900;
const SCREEN_EDGE = 0;



/**
 * 根据拖拽模式把 delta 应用到原始 geometry 上：
 * - move: 整块平移
 * - resize-{dir}: 改边/角，根据方向调整 x/y/w/h
 * - 含 w 的方向：x += dx, w -= dx；含 e 的方向：w += dx
 * - 含 n 的方向：y += dy, h -= dy；含 s 的方向：h += dy
 * - 最小尺寸 MIN_W × MIN_H：达到后停止收缩，x/y 也保持稳定
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
 * 可拖拽 + 8 方向 resize + 实时吸附的磁贴壳。
 * - 拖动中本地 state 暂存位移，松手时把累积位移合并到 x/y
 * - clamp 到父容器内（至少留 32px 在屏内），避免磁贴被拖丢
 * - 实时 snap：与其它磁贴的边/中心吸附，按住 Shift 时只走网格吸附
 * - 松手 → onCommit 落盘 + 清辅助线
 */
export default function TileShell({
  id,
  agentName,
  geometry,
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
  children,
  back,
  flipped = false,
  contextMenuItems,
}: TileShellProps) {
  const showContextMenu = useContextMenuStore((state) => state.show);
  const openRename = useDialogStore((state) => state.openRename);
  const openConfirm = useDialogStore((state) => state.openConfirm);
  const deleteAgent = useAgentsStore((state) => state.deleteAgent);
  const originRef = useRef<TileGeometry | null>(null);
  const shiftRef = useRef(false);
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

  // 全局 shift 状态：拖动期间按 Shift = 强制网格吸附（不吸边）
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

  const otherGeoms = useMemo(() => others ?? [], [others]);

  const computeNext = (
    next: TileGeometry,
    shift: boolean,
  ): { snapped: TileGeometry; guides: SnapGuide[] } => {
    const result = snapGeometry(next, otherGeoms, { shift });
    return { snapped: result.geometry, guides: result.guides };
  };

  const { onMouseDown, isDragging, mode: dragMode } = useDrag({
    onMove: (dx, dy, dragMode) => {
      if (!originRef.current) return;
      const next = applyDelta(originRef.current, dx, dy, dragMode);
      const { snapped, guides } = computeNext(next, shiftRef.current);
      setSnapGuides(guides);
      // 拖动中只更新视觉偏移（四维：位置 + 尺寸）
      setDragOffset({
        x: snapped.x - geometry.x,
        y: snapped.y - geometry.y,
        w: snapped.w - geometry.w,
        h: snapped.h - geometry.h,
      });
      // expanded：检测是否进入左坞（中心 x < 分界）→ 给高亮反馈
      if (mode === "expanded") {
        const centerX = snapped.x + snapped.w / 2;
        setOverDock(dockRightEdgeX !== undefined && centerX < dockRightEdgeX);
      }
    },
    onEnd: (dx, dy, didMove, dragMode) => {
      if (didMove && originRef.current) {
        const next = applyDelta(originRef.current, dx, dy, dragMode);
        const { snapped } = computeNext(next, shiftRef.current);
        const finalGeom = clamp(snapped, bounds);
        if (mode === "expanded") {
          // 拖入左坞 → 收起；否则视觉回弹（不落盘、不污染 idle tiles）
          const centerX = finalGeom.x + finalGeom.w / 2;
          if (dockRightEdgeX !== undefined && centerX < dockRightEdgeX) {
            onDropToDock?.(id);
          }
        } else if (mode === "free") {
          onMove(finalGeom);
          onCommit(finalGeom);
        }
      }
      originRef.current = null;
      setDragOffset({ x: 0, y: 0, w: 0, h: 0 });
      setOverDock(false);
      clearSnapGuides();
    },
  });

  // 外部 geometry 变化（如 store 还原）时，清掉本地 drag offset
  useEffect(() => {
    if (!isDragging) {
      setDragOffset({ x: 0, y: 0, w: 0, h: 0 });
      setOverDock(false);
    }
  }, [geometry.x, geometry.y, geometry.w, geometry.h, isDragging]);

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
    onMouseDown(event, "move");
  };

  const startResize = (event: React.MouseEvent, dir: ResizeDirection) => {
    if (mode !== "free") return; // dock / expanded 均不 resize
    originRef.current = { ...geometry };
    onMouseDown(event, `resize-${dir}` as DragMode);
  };

  const visualX = geometry.x + dragOffset.x;
  const visualY = geometry.y + dragOffset.y;
  const visualW = geometry.w + dragOffset.w;
  const visualH = geometry.h + dragOffset.h;

  const style: CSSProperties = {
    position: "absolute",
    left: visualX,
    top: visualY,
    width: visualW,
    height: visualH,
    zIndex: isDragging ? 1000 : zIndex ?? 1,
    transition: isDragging ? "none" : ["left", "top", "width", "height"].map((prop) => `${prop} ${ANIM_DURATION_MS}ms ${ANIM_EASE}`).join(", "),
  };

  // 3D 翻转容器：rotateY 0（第一态）↔ 180（第二态），与位置/尺寸共用同一条减速曲线
  const flipStyle: CSSProperties = {
    position: "absolute",
    inset: 0,
    transform: `rotateY(${flipped ? 180 : 0}deg)`,
    transformStyle: "preserve-3d",
    willChange: "transform",
    transition: isDragging ? "none" : `transform ${ANIM_DURATION_MS}ms ${ANIM_EASE}`,
  };

  const shellModeClass =
    mode === "dock" ? " tile-shell--dock" : mode === "expanded" ? " tile-shell--expanded" : "";

  return (
    <div
      className={`tile-shell${isDragging ? " tile-shell--dragging" : ""}${overDock ? " tile-shell--over-dock" : ""}${shellModeClass}`}
      style={style}
      data-tile-id={id}
      data-drag-mode={dragMode ?? ""}
      data-tile-mode={mode}
      onMouseDown={startMove}
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

/** 把磁贴 clamp 到父容器内（顶部不限制、左右下边各留至少 32px 在屏内） */
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
