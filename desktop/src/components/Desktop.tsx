import { useCallback, useEffect, useLayoutEffect, useRef, useState, type MouseEvent as ReactMouseEvent } from "react";

import AgentTile from "./AgentTile";
import TileShell from "./TileShell";
import { apiBase } from "../lib/api";
import { DEFAULT_TILE_GEOMETRY } from "../lib/persistTiles";
import { startAgentEventStream } from "../lib/sseClient";
import { useAgentsStore } from "../state/agentsStore";
import { useContextMenuStore } from "../state/contextMenuStore";
import { useDialogStore } from "../state/dialogStore";
import { useSnapGuideStore } from "../state/snapGuideStore";
import type { Agent } from "../types";

/**
 * 全屏磁贴墙桌面。
 * - 挂载时加载 agents + 从 localStorage 还原磁贴几何
 * - 订阅实时状态 SSE，磁贴实时反映 Agent 状态
 * - 空白处右键 → 右键菜单（仅 New Agent 一项）
 * - 双击 Agent 磁贴 → onOpen
 * - 拖动 / resize 时：实时边缘吸附，输出 SnapGuide 覆盖层
 */
export default function Desktop({ onOpen }: { onOpen: (agent: Agent) => void }) {
  const agents = useAgentsStore((state) => state.agents);
  const tiles = useAgentsStore((state) => state.tiles);
  const loading = useAgentsStore((state) => state.loading);
  const error = useAgentsStore((state) => state.error);
  const load = useAgentsStore((state) => state.load);
  const applyAgentEvent = useAgentsStore((state) => state.applyAgentEvent);
  const moveTile = useAgentsStore((state) => state.moveTile);
  const commitTile = useAgentsStore((state) => state.commitTile);
  const showContextMenu = useContextMenuStore((state) => state.show);
  const openNewAgent = useDialogStore((state) => state.openNewAgent);
  const snapGuides = useSnapGuideStore((state) => state.guides);

  // 父容器尺寸，用于 clamp（用 state 才能在 ResizeObserver 触发后让 TileShell 重新 clamp）
  const wallRef = useRef<HTMLDivElement | null>(null);
  const [bounds, setBounds] = useState<{ width: number; height: number }>({ width: 0, height: 0 });
  useLayoutEffect(() => {
    const el = wallRef.current;
    if (!el) return;
    const measure = () => {
      const rect = el.getBoundingClientRect();
      setBounds({ width: rect.width, height: rect.height });
    };
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  useEffect(() => {
    void load();
    const stream = startAgentEventStream(apiBase, {
      onEvent: (event) => applyAgentEvent(event),
      onPolling: () => {
        // 降级轮询：状态仍会经 applyAgentEvent 反映到磁贴
      },
    });
    return () => stream.stop();
  }, [load, applyAgentEvent]);

  // 桌面空白处右键 → 弹出菜单（仅「New Agent」一项）
  const onContextMenu = useCallback(
    (event: ReactMouseEvent<HTMLDivElement>) => {
      // 点在磁贴上不响应（按你定的"仅空白桌面"）
      if (event.target instanceof Element && event.target.closest(".tile-shell")) {
        return;
      }
      event.preventDefault();
      showContextMenu(
        { x: event.clientX, y: event.clientY },
        [
          {
            id: "new-agent",
            label: "New Agent",
            onClick: () => openNewAgent(),
          },
        ],
      );
    },
    [showContextMenu, openNewAgent],
  );

  return (
    <div className="tile-wall" ref={wallRef} onContextMenu={onContextMenu}>
      {error ? <p className="tile-wall__error" role="alert">{error}</p> : null}

      {loading && agents.length === 0 ? (
        <p className="tile-wall__hint" role="status" aria-busy="true">
          Loading agents…
        </p>
      ) : null}

      {/* 给每个磁贴预先算好「其它」集合（用于边缘吸附）。在 map 之外算避免 hooks 规则问题。 */}
      {agents.map((agent) => {
        const geometry = tiles[agent.id] ?? DEFAULT_TILE_GEOMETRY;
        const others: Array<{ x: number; y: number; w: number; h: number }> = [];
        for (const [id, geom] of Object.entries(tiles)) {
          if (id !== agent.id) others.push(geom);
        }
        return (
          <TileShell
            key={agent.id}
            id={agent.id}
            geometry={geometry}
            bounds={bounds}
            others={others}
            onMove={(next) => moveTile(agent.id, next)}
            onCommit={(next) => commitTile(agent.id, next)}
          >
            <AgentTile agent={agent} onOpen={onOpen} />
          </TileShell>
        );
      })}

      {/* 对齐辅助线覆盖层（拖动 / resize 中可见） */}
      <SnapGuidesOverlay guides={snapGuides} wallRef={wallRef} />
    </div>
  );
}

/** 把全局 SnapGuides 渲染为覆盖层线条。位置基于父容器 wallRef 的偏移。 */
function SnapGuidesOverlay({
  guides,
  wallRef,
}: {
  guides: ReturnType<typeof useSnapGuideStore.getState>["guides"];
  wallRef: React.RefObject<HTMLDivElement>;
}) {
  const [offset, setOffset] = useState({ x: 0, y: 0, width: 0, height: 0 });
  useLayoutEffect(() => {
    const el = wallRef.current;
    if (!el) return;
    const measure = () => {
      const rect = el.getBoundingClientRect();
      setOffset({ x: rect.left, y: rect.top, width: rect.width, height: rect.height });
    };
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    window.addEventListener("scroll", measure, true);
    return () => {
      ro.disconnect();
      window.removeEventListener("scroll", measure, true);
    };
  }, [wallRef]);

  if (guides.length === 0) return null;
  return (
    <div className="snap-guides" aria-hidden="true">
      {guides.map((guide, index) => {
        if (guide.axis === "v") {
          return (
            <span
              key={`v-${guide.position}-${index}`}
              className="snap-guides__line snap-guides__line--v"
              style={{
                left: offset.x + guide.position,
                top: offset.y,
                height: offset.height,
              }}
            />
          );
        }
        return (
          <span
            key={`h-${guide.position}-${index}`}
            className="snap-guides__line snap-guides__line--h"
            style={{
              top: offset.y + guide.position,
              left: offset.x,
              width: offset.width,
            }}
          />
        );
      })}
    </div>
  );
}
