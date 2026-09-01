import { useCallback, useEffect, useRef, useState } from "react";

export type ResizeDirection = "n" | "s" | "e" | "w" | "ne" | "nw" | "se" | "sw";
export type DragMode = "move" | `resize-${ResizeDirection}`;

export interface DragOptions {
  /** 拖拽中持续触发：deltaX/deltaY 相对 mousedown 起点；event 为原生 mousemove 事件（用于指针命中检测） */
  onMove?: (deltaX: number, deltaY: number, mode: DragMode, event: MouseEvent) => void;
  /** mouseup 时触发一次；didMove 表示是否真的移动过（超过 threshold） */
  onEnd?: (deltaX: number, deltaY: number, didMove: boolean, mode: DragMode) => void;
  /** 位移阈值（像素），避免点击误触发拖拽。默认 3 */
  threshold?: number;
}

export interface DragHandle {
  /** 挂到目标元素的 onMouseDown；mode 不传时默认 'move' */
  onMouseDown: (event: React.MouseEvent, mode?: DragMode) => void;
  /** 当前是否处于拖拽中（用于给壳加高亮 class） */
  isDragging: boolean;
  /** 当前拖拽模式（用于切换光标 / 调整 z-index / 调试） */
  mode: DragMode | null;
}

const DEFAULT_MODE: DragMode = "move";

/**
 * 鼠标拖拽 hook（move + 8 方向 resize 共用）：
 * - 调用方在 mousedown 时指定 mode（'move' | 'resize-{n,s,e,w,ne,nw,se,sw}'）
 * - 只响应左键（button === 0）
 * - mousedown 不会立即触发 onMove，要等累计位移超过 threshold 才算"真在拖"
 * - 拖拽期间给 body 加 cursor + userSelect，松手恢复
 * - 组件卸载时若还在拖，会自动解绑全局监听（不会有泄漏）
 * - mode 通过 stateRef 在 onMove/onEnd 中透传，调用方拿到 mode 后自己决定怎么 apply
 */
export function useDrag(options: DragOptions = {}): DragHandle {
  const [isDragging, setIsDragging] = useState(false);
  const [mode, setMode] = useState<DragMode | null>(null);
  const optsRef = useRef(options);
  optsRef.current = options;
  const stateRef = useRef<{ startX: number; startY: number; moved: boolean; mode: DragMode } | null>(null);

  useEffect(() => {
    if (!isDragging) return;
    const threshold = optsRef.current.threshold ?? 3;

    const handleMove = (event: MouseEvent) => {
      const state = stateRef.current;
      if (!state) return;
      const dx = event.clientX - state.startX;
      const dy = event.clientY - state.startY;
      if (!state.moved && Math.abs(dx) + Math.abs(dy) < threshold) {
        return;
      }
      state.moved = true;
      optsRef.current.onMove?.(dx, dy, state.mode, event);
    };

    const handleUp = (event: MouseEvent) => {
      const state = stateRef.current;
      stateRef.current = null;
      setMode(null);
      document.body.style.cursor = "";
      document.body.style.userSelect = "";
      if (state) {
        const dx = event.clientX - state.startX;
        const dy = event.clientY - state.startY;
        optsRef.current.onEnd?.(dx, dy, state.moved, state.mode);
      }
      setIsDragging(false);
    };

    document.addEventListener("mousemove", handleMove);
    document.addEventListener("mouseup", handleUp);
    return () => {
      document.removeEventListener("mousemove", handleMove);
      document.removeEventListener("mouseup", handleUp);
    };
  }, [isDragging]);

  const onMouseDown = useCallback((event: React.MouseEvent, nextMode: DragMode = DEFAULT_MODE) => {
    if (event.button !== 0) return;
    event.preventDefault();
    event.stopPropagation();
    stateRef.current = { startX: event.clientX, startY: event.clientY, moved: false, mode: nextMode };
    setMode(nextMode);
    document.body.style.cursor = cursorForMode(nextMode);
    document.body.style.userSelect = "none";
    setIsDragging(true);
  }, []);

  return { onMouseDown, isDragging, mode };
}

/** 拖拽模式 → 鼠标光标 */
export function cursorForMode(mode: DragMode): string {
  switch (mode) {
    case "move":
      return "move";
    case "resize-n":
    case "resize-s":
      return "ns-resize";
    case "resize-e":
    case "resize-w":
      return "ew-resize";
    case "resize-ne":
    case "resize-sw":
      return "nesw-resize";
    case "resize-nw":
    case "resize-se":
      return "nwse-resize";
  }
}
