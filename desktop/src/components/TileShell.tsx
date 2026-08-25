import { useEffect, useMemo, useRef, useState, type CSSProperties, type ReactNode } from "react";

import {
  useDrag,
  type DragMode,
  type ResizeDirection,
} from "../lib/dragController";
import { snapGeometry, type SnapGuide } from "../lib/snapController";
import type { TileGeometry } from "../types";
import { useSnapGuideStore } from "../state/snapGuideStore";

interface TileShellProps {
  /** 唯一 id（用于 data-attr / 调试） */
  id: string;
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
  children: ReactNode;
}

const MIN_W = 200;
const MIN_H = 120;
const MAX_W = 1200;
const MAX_H = 900;
const SCREEN_EDGE = 0;

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

/**
 * 根据拖拽模式把 delta 应用到原始 geometry 上：
 * - move: 整块平移
 * - resize-{dir}: 改边/角，根据方向调整 x/y/w/h
 * - 含 w 的方向：x += dx, w -= dx；含 e 的方向：w += dx
 * - 含 n 的方向：y += dy, h -= dy；含 s 的方向：h += dy
 * - 最小尺寸 MIN_W × MIN_H：达到后停止收缩，x/y 也保持稳定
 */
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
  geometry,
  onMove,
  onCommit,
  bounds,
  zIndex,
  others,
  disableResize,
  children,
}: TileShellProps) {
  const originRef = useRef<TileGeometry | null>(null);
  const shiftRef = useRef(false);
  const [dragOffset, setDragOffset] = useState({ x: 0, y: 0 });
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

  const { onMouseDown, isDragging, mode } = useDrag({
    onMove: (dx, dy, dragMode) => {
      if (!originRef.current) return;
      const next = applyDelta(originRef.current, dx, dy, dragMode);
      const { snapped, guides } = computeNext(next, shiftRef.current);
      setSnapGuides(guides);
      // 拖动中只更新视觉偏移
      setDragOffset({ x: snapped.x - geometry.x, y: snapped.y - geometry.y });
    },
    onEnd: (dx, dy, didMove, dragMode) => {
      if (didMove && originRef.current) {
        const next = applyDelta(originRef.current, dx, dy, dragMode);
        const { snapped } = computeNext(next, shiftRef.current);
        const finalGeom = clamp(snapped, bounds);
        onMove(finalGeom);
        onCommit(finalGeom);
      }
      originRef.current = null;
      setDragOffset({ x: 0, y: 0 });
      clearSnapGuides();
    },
  });

  // 外部 geometry 变化（如 store 还原）时，清掉本地 drag offset
  useEffect(() => {
    if (!isDragging) {
      setDragOffset({ x: 0, y: 0 });
    }
  }, [geometry.x, geometry.y, geometry.w, geometry.h, isDragging]);

  const startMove = (event: React.MouseEvent) => {
    originRef.current = { ...geometry };
    onMouseDown(event, "move");
  };

  const startResize = (event: React.MouseEvent, dir: ResizeDirection) => {
    originRef.current = { ...geometry };
    onMouseDown(event, `resize-${dir}` as DragMode);
  };

  const visualX = geometry.x + dragOffset.x;
  const visualY = geometry.y + dragOffset.y;

  const style: CSSProperties = {
    position: "absolute",
    left: visualX,
    top: visualY,
    width: geometry.w,
    height: geometry.h,
    zIndex: isDragging ? 1000 : zIndex ?? 1,
    transition: isDragging ? "none" : "left 160ms ease, top 160ms ease, width 160ms ease, height 160ms ease",
  };

  return (
    <div
      className={`tile-shell${isDragging ? " tile-shell--dragging" : ""}`}
      style={style}
      data-tile-id={id}
      data-drag-mode={mode ?? ""}
      onMouseDown={startMove}
    >
      {children}

      {disableResize ? null : RESIZE_HANDLES.map((handle) => (
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
