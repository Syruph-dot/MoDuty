import { useCallback, useEffect, useRef, useState } from "react";

export interface DragOptions {
  /** 拖拽中持续触发：deltaX/deltaY 相对 mousedown 起点 */
  onMove?: (deltaX: number, deltaY: number) => void;
  /** mouseup 时触发一次；didMove 表示是否真的移动过（超过 threshold） */
  onEnd?: (deltaX: number, deltaY: number, didMove: boolean) => void;
  /** 位移阈值（像素），避免点击误触发拖拽。默认 3 */
  threshold?: number;
}

export interface DragHandle {
  /** 挂到目标元素的 onMouseDown */
  onMouseDown: (event: React.MouseEvent) => void;
  /** 当前是否处于拖拽中（用于给壳加高亮 class） */
  isDragging: boolean;
}

/**
 * 鼠标拖拽 hook：
 * - 只响应左键（button === 0）
 * - mousedown 不会立即触发 onMove，要等累计位移超过 threshold 才算"真在拖"
 * - 拖拽期间给 body 加 cursor:move + user-select:none，松手恢复
 * - 组件卸载时若还在拖，会自动解绑全局监听（不会有泄漏）
 */
export function useDrag(options: DragOptions = {}): DragHandle {
  const [isDragging, setIsDragging] = useState(false);
  const optsRef = useRef(options);
  optsRef.current = options;
  const stateRef = useRef<{ startX: number; startY: number; moved: boolean } | null>(null);

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
      optsRef.current.onMove?.(dx, dy);
    };

    const handleUp = (event: MouseEvent) => {
      const state = stateRef.current;
      stateRef.current = null;
      document.body.style.cursor = "";
      document.body.style.userSelect = "";
      if (state) {
        const dx = event.clientX - state.startX;
        const dy = event.clientY - state.startY;
        optsRef.current.onEnd?.(dx, dy, state.moved);
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

  const onMouseDown = useCallback((event: React.MouseEvent) => {
    if (event.button !== 0) return;
    // 防止内部 button / 文本被选中
    event.preventDefault();
    stateRef.current = { startX: event.clientX, startY: event.clientY, moved: false };
    document.body.style.cursor = "move";
    document.body.style.userSelect = "none";
    setIsDragging(true);
  }, []);

  return { onMouseDown, isDragging };
}
