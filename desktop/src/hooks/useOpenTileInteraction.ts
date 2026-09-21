/**
 * 打开态磁贴（expanded）的统一交互：拖动落位、Y 错位、置顶、边缘丢弃。
 *
 * 为什么抽出来：这套交互原本只写在 Agent 磁贴那一段 JSX 里（onWorldXCommit /
 * onWorldYCommit / onActivate / edgeViewportWidth / edgeScrollX + 世界几何），
 * 浏览器磁贴没接上，于是它的打开态走回了旧的「网格 snap」分支——松开手不提交世界 X，
 * TileShell 只能清掉拖拽偏移回到原 geometry，表现就是「拖动后平滑弹回原位」。
 *
 * 现在打开态是世界坐标草稿纸：X 自由、Y 锁默认、超阈值才解锁错位、拖到视口左右极端丢弃，
 * 并且「谁被点谁置顶」。agent 与 browser 只是内容不同，交互完全同路——由本 hook 一处产出。
 */
import { useCallback } from "react";

import type { TileGeometry } from "../types";

export interface OpenTileInteractionInput {
  /** 打开模式（右栏切换到打开态） */
  openMode: boolean;
  /** 打开态视口宽度（边缘丢弃的判定基准） */
  viewportWidth: number;
  /** 磁贴墙内容横向滚动量（与视口宽度一起换算屏幕中心） */
  scrollX: number;
  /** 打开态舞台（整墙）；未测量到时为 null */
  stage: { y: number; w: number; h: number } | null;
  /** 世界 X / Y 草稿（按磁贴 id 存；首次打开由调用方落位） */
  worldX: Record<string, number>;
  worldY: Record<string, number>;
  commitWorldX: (id: string, x: number) => void;
  commitWorldY: (id: string, y: number) => void;
  /** 点中即置顶 */
  raiseTile: (id: string) => void;
  /** 当前 z 序秩（越大越靠前） */
  zRankOf: (id: string) => number;
  /** 拖到视口左右极端松手 = 丢弃关闭 */
  closeTile: (id: string) => void;
}

export interface OpenTileShellProps {
  dragHandleSelector?: string;
  onWorldXCommit?: (x: number) => void;
  onWorldYCommit?: (y: number) => void;
  onActivate?: () => void;
  onDropToEdge?: () => void;
  edgeViewportWidth: number;
  edgeScrollX: number;
  zIndex: number;
}

export interface OpenTileInteraction {
  /** 打开卡的世界 X（渲染 / 居中滚动 / 内容宽度统一口径）；未落位返回 null */
  worldXOf: (id: string) => number | null;
  /** 打开态几何 = 世界 X/Y + 整屏舞台；非打开态回退调用方给的自由网格几何 */
  geometryOf: (id: string, isOpen: boolean, freeGeometry: TileGeometry) => TileGeometry;
  /**
   * 一份 props 直接展开给 TileShell。
   * dragHandle 是「窗口头栏」的选择器（Agent 窗口与浏览器窗口各有一个）。
   */
  shellPropsOf: (id: string, isOpen: boolean, dragHandle: string) => OpenTileShellProps;
}

/**
 * 打开态几何（纯函数）：打开模式 + 该磁贴已打开 + 舞台已测量 → 世界 X/Y + 整屏舞台；
 * 否则回退调用方给的自由网格几何。
 * 抽成纯函数的理由：这是「打开卡铺满整墙 + 世界坐标」这条规则的唯一定义处，
 * agent 与 browser 都必须走它（实测差异正是从这里来的：browser 曾用 layout.geometryOf 的半格几何）。
 */
export function resolveOpenTileGeometry(args: {
  openMode: boolean;
  isOpen: boolean;
  stage: { y: number; w: number; h: number } | null;
  worldX: Record<string, number>;
  worldY: Record<string, number>;
  id: string;
  freeGeometry: TileGeometry;
}): TileGeometry {
  const { openMode, isOpen, stage, worldX, worldY, id, freeGeometry } = args;
  if (!openMode || !isOpen || !stage) return freeGeometry;
  return {
    x: Number.isFinite(worldX[id]) ? worldX[id] : 0,
    y: Number.isFinite(worldY[id]) ? worldY[id] : stage.y,
    w: stage.w,
    h: stage.h,
  };
}

export function useOpenTileInteraction(input: OpenTileInteractionInput): OpenTileInteraction {
  const {
    openMode,
    viewportWidth,
    scrollX,
    stage,
    worldX,
    worldY,
    commitWorldX,
    commitWorldY,
    raiseTile,
    zRankOf,
    closeTile,
  } = input;

  const worldXOf = useCallback(
    (id: string): number | null => (Number.isFinite(worldX[id]) ? worldX[id] : null),
    [worldX],
  );

  const geometryOf = useCallback(
    (id: string, isOpen: boolean, freeGeometry: TileGeometry): TileGeometry =>
      resolveOpenTileGeometry({ openMode, isOpen, stage, worldX, worldY, id, freeGeometry }),
    [openMode, stage, worldX, worldY],
  );

  const shellPropsOf = useCallback(
    (id: string, isOpen: boolean, dragHandle: string): OpenTileShellProps => ({
      ...(isOpen ? { dragHandleSelector: dragHandle } : {}),
      ...(isOpen
        ? {
            onWorldXCommit: (x: number) => commitWorldX(id, x),
            onWorldYCommit: (y: number) => commitWorldY(id, y),
            onActivate: () => raiseTile(id),
            onDropToEdge: () => closeTile(id),
          }
        : {}),
      edgeViewportWidth: openMode ? viewportWidth : 0,
      edgeScrollX: openMode ? scrollX : 0,
      zIndex: isOpen ? 20 + zRankOf(id) : openMode ? 0 : 1,
    }),
    [openMode, viewportWidth, scrollX, commitWorldX, commitWorldY, raiseTile, zRankOf, closeTile],
  );

  return { worldXOf, geometryOf, shellPropsOf };
}
