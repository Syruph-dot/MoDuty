import { useCallback, useEffect, useMemo, useRef, useState } from "react";

/**
 * 磁贴进入/退出动画状态管理
 *
 * 进入态：
 * - 初始：scale=0, opacity=0, transform: translateX(-300px) translateY(40px)
 * - X轴扫描器：从左到右移动的扫描线，触发磁贴按 deceleration curve (ease-out) 回到原位
 * - 扫描速度：可配置，默认 800px/s
 *
 * 退出态：
 * - 线性：scale 100% → 0%，opacity 100% → 0%，无位移，无扫描器，所有同时
 * - 速度：快（200ms）
 *
 * 视口剔除：超出屏幕 150% 的磁贴不渲染动画效果
 */

export interface TileAnimationState {
  /** 磁贴 ID */
  id: string;
  /** 几何信息（用于视口判断） */
  geometry: { x: number; y: number; w: number; h: number };
  /** 动画阶段 */
  phase: "entering" | "entered" | "exiting" | "exited" | "idle";
  /** 进入进度 0-1 */
  enterProgress: number;
  /** 退出进度 0-1 */
  exitProgress: number;
  /** 扫描器触发时间戳 */
  scanTriggerTime: number | null;
}

export interface UseTileAnimationsOptions {
  /** 容器边界 */
  bounds: { width: number; height: number } | null;
  /** 扫描器速度 (px/s) */
  scanSpeed?: number;
  /** 进入动画时长 (ms) */
  enterDuration?: number;
  /** 退出动画时长 (ms) */
  exitDuration?: number;
  /** 扫描器起始延迟 (ms) */
  scanStartDelay?: number;
  /** 视口扩展倍数（1.5 = 150%） */
  viewportMargin?: number;
  /** 是否启用扫描器 */
  enableScanner?: boolean;
  /** easing 函数 */
  enterEasing?: (t: number) => number;
}

/** 默认进入缓动：cubic ease-out。模块级常量保证引用稳定，避免 rAF effect 因每次渲染新建函数而反复重启 */
const DEFAULT_ENTER_EASING = (t: number) => 1 - Math.pow(1 - t, 3);

export function useTileAnimations(options: UseTileAnimationsOptions) {
  const {
    bounds,
    scanSpeed = 4800,
    enterDuration = 600,
    exitDuration = 200,
    scanStartDelay = 0,
    viewportMargin = 1.5,
    enableScanner = true,
    enterEasing = DEFAULT_ENTER_EASING,
  } = options;

  const [tileStates, setTileStates] = useState<Map<string, TileAnimationState>>(new Map());
  const animationFrameRef = useRef<number | null>(null);
  const scanLineRef = useRef<number>(-Infinity);
  const lastTimeRef = useRef<number>(performance.now());
  const scannerStartTimeRef = useRef<number | null>(null);
  const mountedRef = useRef(true);

  // 视口扩展矩形（150%）
  const viewportRect = useMemo(() => {
    if (!bounds) return null;
    const margin = viewportMargin;
    return {
      left: -bounds.width * (margin - 1) / 2,
      top: -bounds.height * (margin - 1) / 2,
      right: bounds.width * margin,
      bottom: bounds.height * margin,
    };
  }, [bounds, viewportMargin]);

  // 检查磁贴是否在扩展视口内
  const isInExtendedViewport = useCallback((geometry: { x: number; y: number; w: number; h: number }) => {
    if (!viewportRect) return true;
    return !(
      geometry.x + geometry.w < viewportRect.left ||
      geometry.x > viewportRect.right ||
      geometry.y + geometry.h < viewportRect.top ||
      geometry.y > viewportRect.bottom
    );
  }, [viewportRect]);

  // 注册/更新磁贴。幂等：几何内容无变化时返回 prev（bail out），避免无意义的渲染循环
  const registerTile = useCallback((
    id: string,
    geometry: { x: number; y: number; w: number; h: number },
    isNew: boolean = false
  ) => {
    setTileStates((prev) => {
      const existing = prev.get(id);
      const sameGeo =
        !!existing &&
        existing.geometry.x === geometry.x &&
        existing.geometry.y === geometry.y &&
        existing.geometry.w === geometry.w &&
        existing.geometry.h === geometry.h;

      if (existing && sameGeo) {
        // 完全相同 → bail out，不产生新状态引用
        return prev;
      }
      if (existing && isNew && existing.phase !== "entering") {
        // 已注册但要求重新入场（如组件重挂载）→ 重置为 entering
        return new Map(prev).set(id, {
          ...existing,
          geometry,
          phase: "entering",
          enterProgress: 0,
          exitProgress: 0,
          scanTriggerTime: enableScanner ? null : performance.now(),
        });
      }
      if (existing) {
        // 更新几何，保持动画状态
        return new Map(prev).set(id, { ...existing, geometry });
      }
      // 新磁贴（此前不在动画系统内）：一律进入态。
      // 注意不能依赖 isNew 区分：React StrictMode 会二次执行 mount effect——
      // 首次 register(isNew=true) 后 cleanup 删除、二次 register(isNew=false) 时已无 existing，
      // 若按 isNew 建 idle 将导致磁贴永远不播进入动画（页面一直无入场效果）。
      return new Map(prev).set(id, {
        id,
        geometry,
        phase: "entering",
        enterProgress: 0,
        exitProgress: 0,
        scanTriggerTime: enableScanner ? null : performance.now(),
      });
    });
  }, [enableScanner]);

  // 标记磁贴退出
  const unregisterTile = useCallback((id: string, immediate = false) => {
    setTileStates((prev) => {
      const existing = prev.get(id);
      if (!existing) return prev;
      if (immediate) {
        const next = new Map(prev);
        next.delete(id);
        return next;
      }
      return new Map(prev).set(id, {
        ...existing,
        phase: "exiting",
        exitProgress: 0,
      });
    });
  }, []);

  // 动画循环
  useEffect(() => {
    mountedRef.current = true;
    lastTimeRef.current = performance.now();
    scannerStartTimeRef.current = enableScanner ? performance.now() + scanStartDelay : null;

    const tick = (now: number) => {
      if (!mountedRef.current) return;

      lastTimeRef.current = now;

      // 更新扫描线位置
      if (enableScanner && scannerStartTimeRef.current !== null && now >= scannerStartTimeRef.current) {
        scanLineRef.current = scanSpeed * (now - scannerStartTimeRef.current) / 1000;
      } else if (!enableScanner) {
        scanLineRef.current = Infinity; // 无扫描器 = 立即触发所有
      }

      // 兜底：扫描线越过扩展视口右边界后，仍未触发的 entering 磁贴全部强制开始，
      // 防止布局/bounds 抖动或 effect 重启导致磁贴永远停在 opacity:0
      const scanFinished = !!viewportRect && scanLineRef.current >= viewportRect.right;

      setTileStates((prev) => {
        const next = new Map(prev);
        let hasChanges = false;

        for (const [id, state] of prev) {
          const { phase, scanTriggerTime, geometry } = state;

          // 视口检查（exiting 分支用于直接移除视口外的磁贴）
          const inViewport = isInExtendedViewport(geometry);

          if (phase === "entering") {
            // 扫描器触发检查
            let shouldStart = false;
            if (enableScanner) {
              const tileRight = geometry.x + geometry.w;
              if (scanTriggerTime === null && (scanLineRef.current >= tileRight || scanFinished)) {
                shouldStart = true;
              }
            } else {
              shouldStart = true; // 无扫描器 = 立即开始
            }

            if (shouldStart) {
              next.set(id, { ...state, phase: "entering", scanTriggerTime: now, enterProgress: 0 });
              hasChanges = true;
            } else if (scanTriggerTime !== null) {
              // 已触发，更新进度
              const elapsed = (now - scanTriggerTime) / enterDuration;
              if (elapsed >= 1) {
                next.set(id, { ...state, phase: "entered", enterProgress: 1 });
              } else {
                next.set(id, { ...state, enterProgress: enterEasing(elapsed) });
              }
              hasChanges = true;
            }
          } else if (phase === "exiting") {
            if (!inViewport) {
              // 不在视口内，直接移除
              next.delete(id);
            } else {
              const elapsed = (now - (scanTriggerTime ?? now)) / exitDuration;
              if (elapsed >= 1) {
                next.delete(id);
              } else {
                next.set(id, { ...state, exitProgress: elapsed });
              }
              hasChanges = true;
            }
          } else if (phase === "idle" || phase === "entered") {
            // 几何变化由外部 registerTile 处理
          }

          // 清理 exited 状态
          if (phase === "exited") {
            next.delete(id);
            hasChanges = true;
          }
        }

        return hasChanges ? next : prev;
      });

      animationFrameRef.current = requestAnimationFrame(tick);
    };

    animationFrameRef.current = requestAnimationFrame(tick);
    return () => {
      mountedRef.current = false;
      if (animationFrameRef.current !== null) {
        cancelAnimationFrame(animationFrameRef.current);
      }
    };
  }, [bounds, enableScanner, enterDuration, exitDuration, scanSpeed, scanStartDelay, enterEasing, isInExtendedViewport, viewportRect]);

  // 获取磁贴动画样式
  const getTileAnimationStyle = useCallback((id: string): React.CSSProperties | null => {
    const state = tileStates.get(id);
    if (!state) return null;

    const { phase, enterProgress, exitProgress, geometry } = state;
    const inViewport = viewportRect ? isInExtendedViewport(geometry) : true;

    // 超出视口 150%：不应用动画，直接显示最终态
    if (!inViewport) {
      return {
        transform: "none",
        opacity: 1,
        pointerEvents: "auto",
      } as React.CSSProperties;
    }

    switch (phase) {
      case "entering": {
        const p = enterProgress;
        const scale = 0 + p * 1; // 0 → 1
        const opacity = 0 + p * 1; // 0 → 1
        const tx = -900 * (1 - p); // -900 → 0
        const ty = 20 * (1 - p);   // 20 → 0
        return {
          transform: `translate(${tx}px, ${ty}px) scale(${scale})`,
          opacity,
          transformOrigin: "center center",
          willChange: "transform, opacity",
          pointerEvents: p > 0.5 ? "auto" : "none",
        } as React.CSSProperties;
      }
      case "entered":
        return {
          transform: "none",
          opacity: 1,
          pointerEvents: "auto",
        } as React.CSSProperties;
      case "exiting": {
        const p = exitProgress; // 0 → 1
        const scale = 1 - p * 1; // 1 → 0
        const opacity = 1 - p * 1; // 1 → 0
        return {
          transform: `scale(${scale})`,
          opacity,
          transformOrigin: "center center",
          willChange: "transform, opacity",
          pointerEvents: "none",
        } as React.CSSProperties;
      }
      case "exited":
        return {
          transform: "scale(0)",
          opacity: 0,
          pointerEvents: "none",
        } as React.CSSProperties;
      default:
        return {
          transform: "none",
          opacity: 1,
          pointerEvents: "auto",
        } as React.CSSProperties;
    }
  }, [tileStates, viewportRect, isInExtendedViewport]);

  // 批量注册（初始化时）
  const registerTilesBatch = useCallback((
    tiles: Array<{ id: string; geometry: { x: number; y: number; w: number; h: number } }>
  ) => {
    setTileStates((prev) => {
      const next = new Map(prev);
      for (const tile of tiles) {
        if (!next.has(tile.id)) {
          next.set(tile.id, {
            id: tile.id,
            geometry: tile.geometry,
            phase: "entering",
            enterProgress: 0,
            exitProgress: 0,
            scanTriggerTime: enableScanner ? null : performance.now(),
          });
        }
      }
      return next;
    });
  }, [enableScanner]);

  /**
   * 整墙重新进入：把现有磁贴（entered/idle）重置为 entering，并从左端重启扫描线。
   * 用于从全屏设置返回初始页时重播“向右滑入放大淡入”入场。
   */
  const replayEnter = useCallback(() => {
    scanLineRef.current = -Infinity;
    scannerStartTimeRef.current = enableScanner ? performance.now() + scanStartDelay : null;
    setTileStates((prev) => {
      let changed = false;
      const next = new Map(prev);
      for (const [id, state] of prev) {
        if (state.phase === "exiting" || state.phase === "entering") {
          next.set(id, state);
          continue;
        }
        next.set(id, {
          ...state,
          phase: "entering",
          enterProgress: 0,
          exitProgress: 0,
          scanTriggerTime: enableScanner ? null : performance.now(),
        });
        changed = true;
      }
      return changed ? next : prev;
    });
  }, [enableScanner, scanStartDelay]);

  return {
    tileStates,
    registerTile,
    unregisterTile,
    registerTilesBatch,
    replayEnter,
    getTileAnimationStyle,
    isInExtendedViewport,
    scanLineX: scanLineRef.current,
  };
}