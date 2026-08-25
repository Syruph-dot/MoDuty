import { useEffect, useRef, useState, type CSSProperties, type ReactNode } from "react";

import { useDrag } from "../lib/dragController";
import type { TileGeometry } from "../types";

interface TileShellProps {
  /** 唯一 id（用于 data-attr / 调试） */
  id: string;
  /** 当前几何（由 store 传入；拖动中是高频更新的值） */
  geometry: TileGeometry;
  /** 拖动中持续触发（仅改 store，不写 localStorage） */
  onMove: (next: TileGeometry) => void;
  /** 拖动结束 / 第一次挂载时触发（落盘 localStorage） */
  onCommit: (next: TileGeometry) => void;
  /** 拖动结束回调（用于把 z-index 复位等） */
  onDragEnd?: () => void;
  /** 父容器尺寸（用于 clamp，防止磁贴被拖出可见区） */
  bounds?: { width: number; height: number };
  /** z-index（用于选中置顶） */
  zIndex?: number;
  children: ReactNode;
}

/**
 * 可拖拽磁贴壳：把任意子内容包成一个绝对定位的窗口式磁贴。
 * - 鼠标在壳上 mousedown → 拖拽；body 内 button 的 dblclick 仍可触发（不冲突）
 * - 拖动中用本地 state 暂存位移，松手时把累积位移合并到 x/y
 * - clamp 到父容器内（至少留 32px 在屏内），避免磁贴被拖丢
 */
export default function TileShell({
  id,
  geometry,
  onMove,
  onCommit,
  onDragEnd,
  bounds,
  zIndex,
  children,
}: TileShellProps) {
  // 拖拽中用 ref 暂存基准 x/y，避免 setDragOffset 期间再读 stale closure
  const originRef = useRef<{ x: number; y: number } | null>(null);
  const [dragOffset, setDragOffset] = useState({ x: 0, y: 0 });

  const { onMouseDown, isDragging } = useDrag({
    onMove: (dx, dy) => {
      if (!originRef.current) return;
      const { x: ox, y: oy } = originRef.current;
      const next = clamp(
        { x: ox + dx, y: oy + dy, w: geometry.w, h: geometry.h },
        bounds,
      );
      // 拖动中只更新视觉偏移，不写 store
      setDragOffset({ x: next.x - ox, y: next.y - oy });
    },
    onEnd: (dx, dy, didMove) => {
      if (didMove && originRef.current) {
        const { x: ox, y: oy } = originRef.current;
        const next = clamp(
          { x: ox + dx, y: oy + dy, w: geometry.w, h: geometry.h },
          bounds,
        );
        onMove(next);
        onCommit(next);
      }
      originRef.current = null;
      setDragOffset({ x: 0, y: 0 });
      onDragEnd?.();
    },
  });

  // 外部 geometry 变化（如 store 还原）时，清掉本地 drag offset
  useEffect(() => {
    if (!isDragging) {
      setDragOffset({ x: 0, y: 0 });
    }
  }, [geometry.x, geometry.y, isDragging]);

  const startDrag = (event: React.MouseEvent) => {
    originRef.current = { x: geometry.x, y: geometry.y };
    onMouseDown(event);
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
    transition: isDragging ? "none" : "left 160ms ease, top 160ms ease",
  };

  return (
    <div
      className={`tile-shell${isDragging ? " tile-shell--dragging" : ""}`}
      style={style}
      data-tile-id={id}
      onMouseDown={startDrag}
    >
      {children}
    </div>
  );
}

/** 把磁贴 clamp 到父容器内（顶部不限制、左右下边各留至少 32px 在屏内） */
function clamp(geom: TileGeometry, bounds?: { width: number; height: number }): TileGeometry {
  if (!bounds) return geom;
  const maxX = Math.max(0, bounds.width - 32);
  const maxY = Math.max(0, bounds.height - 32);
  return {
    x: Math.min(Math.max(geom.x, -(geom.w - 32)), maxX),
    y: Math.min(Math.max(geom.y, 0), maxY),
    w: geom.w,
    h: geom.h,
  };
}
