import React, { useMemo } from "react";
import { useTileAnimation, TileGeometry } from "./AnimationProvider";
import type { BrowserInfo } from "../../types";

interface TileRendererProps {
  id: string;
  kind: "agent" | "browser" | "widget";
  geometry: TileGeometry;
  grid?: { col: number; row: number; w: number; h: number };
  gridMap?: Record<string, { col: number; row: number; w: number; h: number }>;
  metrics?: { cellW: number; cellH: number; gap: number; padding: number; rows: number };
  bandX?: number;
  displacedGrid?: { col: number; row: number; w: number; h: number };
  mode: "free" | "dock" | "expanded";
  openMode: boolean;
  isOpen: boolean;
  inDock?: boolean;
  canvasGhost?: boolean;
  gridClamp?: { minCol: number; maxCol: number; minRow: number; maxRow: number };
  displacedPreview?: boolean;
  agent?: { id: string; name: string };
  browser?: BrowserInfo;
  widget?: { id: string; kind: string; title: string };
  widgetDef?: { renderBody: () => React.ReactNode; fixedSize?: boolean };
  onMove?: (next: { col: number; row: number; w: number; h: number }) => void;
  onCommit?: (next: { col: number; row: number; w: number; h: number }) => void;
  onCommitDisplaced?: (map: Record<string, { col: number; row: number; w: number; h: number }>) => void;
  onDropToDock?: () => void;
  onOpenTile?: () => void;
  contextMenuItems?: Array<{ id: string; label: string; onClick: () => void; divider?: boolean }>;
  zIndex?: number;
  back?: React.ReactNode;
  flipped?: boolean;
  dragHandleSelector?: string;
  dockRightEdgeX?: number;
}

/**
 * 统一磁贴渲染器 - 集成动画系统
 */
export function TileRenderer(props: TileRendererProps) {
  const { getTileAnimationStyle } = useTileAnimation();
  const {
    id,
    kind,
    agent,
    browser,
    widget,
    widgetDef,
  } = props;

  // 动画样式
  const animStyle = getTileAnimationStyle?.(id) ?? null;

  // 组合样式
  const style = useMemo(() => {
    if (!animStyle) return undefined;
    return { ...animStyle };
  }, [animStyle]);

  // 渲染内容
  const renderContent = () => {
    switch (kind) {
      case "agent":
        return agent ? (
          <div className="agent-tile" style={{ width: "100%", height: "100%" }}>
            <div className="agent-tile__name">{agent.name}</div>
          </div>
        ) : null;
      case "browser":
        return browser ? (
          <div className="browser-tile" style={{ width: "100%", height: "100%" }}>
            {browser.name}
          </div>
        ) : null;
      case "widget":
        return widget && widgetDef ? (
          <div className="widget-tile" style={{ width: "100%", height: "100%" }}>
            <div className="widget-tile__title">{widget.title}</div>
            <div className="widget-tile__body">{widgetDef.renderBody()}</div>
          </div>
        ) : null;
      default:
        return null;
    }
  };

  return (
    <div
      key={id}
      id={id}
      style={style}
    >
      {renderContent()}
    </div>
  );
}

export default TileRenderer;