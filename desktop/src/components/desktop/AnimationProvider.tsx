import React, { useMemo } from "react";
import { useTileAnimations } from "../../hooks/useTileAnimations";

export interface TileGeometry {
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface AnimationTile {
  id: string;
  geometry: TileGeometry;
}

interface AnimationContextValue {
  registerTile: (id: string, geometry: TileGeometry, isNew?: boolean) => void;
  unregisterTile: (id: string, immediate?: boolean) => void;
  getTileAnimationStyle: (id: string) => React.CSSProperties | null;
  registerTilesBatch: (tiles: AnimationTile[]) => void;
  /** 整墙重新进入：从设置等全屏界面返回时重播入场扫描 */
  replayEnter: () => void;
}

const AnimationContext = React.createContext<AnimationContextValue | null>(null);

/**
 * 动画上下文提供者
 * 管理所有磁贴的进入/退出动画状态
 */
export function AnimationProvider({
  children,
  bounds,
  enabled = true,
  scanSpeed = 4800,
  enterDuration = 600,
  exitDuration = 200,
  scanStartDelay = 0,
  viewportMargin = 1.5,
}: {
  children: React.ReactNode;
  bounds: { width: number; height: number } | null;
  enabled?: boolean;
  scanSpeed?: number;
  enterDuration?: number;
  exitDuration?: number;
  scanStartDelay?: number;
  viewportMargin?: number;
}) {
  const {
    registerTile,
    unregisterTile,
    registerTilesBatch,
    getTileAnimationStyle,
    replayEnter,
  } = useTileAnimations({
    bounds,
    scanSpeed,
    enterDuration,
    exitDuration,
    scanStartDelay,
    viewportMargin,
    enableScanner: enabled,
  });

  const contextValue = useMemo<AnimationContextValue>(
    () => ({
      registerTile,
      unregisterTile,
      getTileAnimationStyle,
      registerTilesBatch,
      replayEnter,
    }),
    [registerTile, unregisterTile, getTileAnimationStyle, registerTilesBatch, replayEnter]
  );

  return (
    <AnimationContext.Provider value={contextValue}>
      {children}
    </AnimationContext.Provider>
  );
}

/**
 * Hook：在组件中使用动画上下文
 */
export function useTileAnimation() {
  const context = React.useContext(AnimationContext);
  if (!context) {
    throw new Error("useTileAnimation must be used within AnimationProvider");
  }
  return context;
}

/**
 * Hook：为单个磁贴注册动画
 */
export function useRegisterTileAnimation(
  id: string,
  geometry: TileGeometry,
  isNew: boolean = false
) {
  const { registerTile, unregisterTile, getTileAnimationStyle } = useTileAnimation();
  
  React.useEffect(() => {
    registerTile(id, geometry, isNew);
    // immediate 移除：避免依赖变化（如 geometry 更新）时 cleanup 先置 exiting 导致磁贴闪烁消失
    return () => unregisterTile(id, true);
  }, [id, geometry, isNew, registerTile, unregisterTile]);

  return getTileAnimationStyle(id);
}