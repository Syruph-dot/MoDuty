import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type MouseEvent as ReactMouseEvent } from "react";

import AgentTile from "./AgentTile";
import AgentWindow from "./AgentWindow";
import TileShell from "./TileShell";
import { awaitApiBase } from "../lib/api";
import { computeOpenLayout, isBoundsReady } from "../lib/layoutEngine";
import { DEFAULT_TILE_GEOMETRY } from "../lib/persistTiles";
import { startAgentEventStream, type AgentEventStreamControl } from "../lib/sseClient";
import { useAgentsStore } from "../state/agentsStore";
import { useContextMenuStore } from "../state/contextMenuStore";
import { useDialogStore } from "../state/dialogStore";
import { useSnapGuideStore } from "../state/snapGuideStore";
import type { Agent } from "../types";

/**
 * 全屏磁贴墙桌面（支持双几何分屏）。
 * - 挂载时加载 agents + 从 localStorage 还原磁贴几何
 * - 订阅实时状态 SSE，磁贴实时反映 Agent 状态
 * - 空白处右键 → 右键菜单（仅 New Agent 一项）
 * - 双击 Agent 磁贴 → 打开（进入 open 分屏模式）
 * - 无打开：磁贴自由摆放（idle geometry，持久化）
 * - 有打开：未打开磁贴收缩进左半屏坞，打开磁贴在右半屏舞台按 2n/2n+1 展开；
 *   展开窗口拖到左坞松手 → 收起；× 关闭 → 右上角收起
 */
export default function Desktop({ onOpen }: { onOpen: (agent: Agent) => void }) {
  const agents = useAgentsStore((state) => state.agents);
  const tiles = useAgentsStore((state) => state.tiles);
  const openAgentIds = useAgentsStore((state) => state.openAgentIds);
  const loading = useAgentsStore((state) => state.loading);
  const error = useAgentsStore((state) => state.error);
  const load = useAgentsStore((state) => state.load);
  const applyAgentEvent = useAgentsStore((state) => state.applyAgentEvent);
  const moveTile = useAgentsStore((state) => state.moveTile);
  const commitTile = useAgentsStore((state) => state.commitTile);
  const closeAgent = useAgentsStore((state) => state.closeAgent);
  const renameAgent = useAgentsStore((state) => state.renameAgent);
  const renameTarget = useDialogStore((state) => state.renameTarget);
  const closeRename = useDialogStore((state) => state.closeRename);
  const showContextMenu = useContextMenuStore((state) => state.show);
  const openNewAgent = useDialogStore((state) => state.openNewAgent);
  const openWallpaper = useDialogStore((state) => state.openWallpaper);
  const openSettings = useDialogStore((state) => state.openSettings);
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
    let stream: AgentEventStreamControl | undefined;
    let cancelled = false;
    void (async () => {
      try {
        await load();
        if (cancelled) return;
        const base = await awaitApiBase();
        if (cancelled) return;
        stream = startAgentEventStream(base, {
          onEvent: (event) => applyAgentEvent(event),
          onPolling: () => {
            // 降级轮询：状态仍会经 applyAgentEvent 反映到磁贴
          },
        });
      } catch (error) {
        // 端口解析 / load 失败：状态由 agentsStore.error 体现，事件流可由下次 mount 重试
        console.error("[desktop] init failed:", error);
      }
    })();
    return () => {
      cancelled = true;
      stream?.stop();
    };
  }, [load, applyAgentEvent]);

  // ---- 打开态布局：未打开磁贴 → 左坞；打开磁贴 → 右舞台 ----
  const openMode = openAgentIds.length > 0;
  const layout = useMemo(() => {
    if (!openMode || !isBoundsReady(bounds)) return null;
    return computeOpenLayout(bounds, openAgentIds, agents.map((agent) => agent.id));
  }, [openMode, openAgentIds, agents, bounds]);

  // 桌面空白处右键 → 弹出菜单（New Agent / Refresh / Change wallpaper）
  const onContextMenu = useCallback(
    (event: ReactMouseEvent<HTMLDivElement>) => {
      // 点在磁贴上不响应（按你定的"仅空白桌面"）
      if (event.target instanceof Element && event.target.closest(".tile-shell")) {
        return;
      }
      event.preventDefault();
      const items: Parameters<typeof showContextMenu>[1] = [
        {
          id: "new-agent",
          label: "New Agent",
          onClick: () => {
            const rect = wallRef.current?.getBoundingClientRect();
            openNewAgent({ x: event.clientX - (rect?.left ?? 0), y: event.clientY - (rect?.top ?? 0) });
          },
        },
        {
          id: "refresh-agents",
          label: "Refresh agents",
          onClick: () => {
            void load();
          },
        },
        {
          id: "change-wallpaper",
          label: "Change wallpaper",
          onClick: () => openWallpaper(),
        },
        {
          id: "divider-settings",
          label: "",
          onClick: () => {},
          divider: true,
        },
        {
          id: "settings",
          label: "Settings",
          onClick: () => openSettings(),
        },
      ];
      showContextMenu({ x: event.clientX, y: event.clientY }, items);
    },
    [showContextMenu, openNewAgent, openWallpaper, openSettings, load],
  );

  return (
    <div className={`tile-wall${openMode ? " tile-wall--open" : ""}`} ref={wallRef} onContextMenu={onContextMenu}>
      {error ? <p className="tile-wall__error" role="alert">{error}</p> : null}

      {loading && agents.length === 0 ? (
        <p className="tile-wall__hint" role="status" aria-busy="true">
          Loading agents…
        </p>
      ) : null}

      {/* 打开态：左半屏坞背景 + 拖入提示 */}
      {openMode && layout ? (
        <div className="dock-area" style={{ left: layout.dock.x, top: layout.dock.y, width: layout.dock.w, height: layout.dock.h }} aria-hidden="true">
          <span className="dock-area__label">DOCK · 双击打开</span>
          <span className="dock-area__hint">将展开窗口拖到此处可收起</span>
        </div>
      ) : null}

      {agents.map((agent) => {
        const isOpen = openAgentIds.includes(agent.id);
        // 双几何：无打开 → idle（用户摆放）；有打开 → 布局引擎计算（dock / stage）
        const geometry = openMode && layout ? layout.geometryOf[agent.id] ?? DEFAULT_TILE_GEOMETRY : tiles[agent.id] ?? DEFAULT_TILE_GEOMETRY;
        const tileMode = !openMode ? "free" : isOpen ? "expanded" : "dock";
        const others = tileMode === "free" ? buildOthers(tiles, agent.id) : [];

        return (
          <TileShell
            key={agent.id}
            id={agent.id}
            agentName={agent.name}
            geometry={geometry}
            bounds={bounds}
            others={others}
            mode={tileMode}
            dragHandleSelector={isOpen ? ".agent-window__header" : undefined}
            dockRightEdgeX={layout?.dockRightEdgeX}
            zIndex={isOpen ? 20 : 1}
            flipped={isOpen}
            back={isOpen ? <AgentWindow agent={agent} onClose={() => closeAgent(agent.id)} /> : undefined}
            onMove={(next) => moveTile(agent.id, next)}
            onCommit={(next) => commitTile(agent.id, next)}
            onDropToDock={isOpen ? () => closeAgent(agent.id) : undefined}
          >
            <AgentTile
              agent={agent}
              onOpen={onOpen}
              renaming={renameTarget === agent.id}
              onRenameCommit={(name) => {
                // 成功才退出内联编辑；失败保持编辑态，错误已写入 store.error（桌面顶部展示）
                void renameAgent(agent.id, name)
                  .then(() => closeRename())
                  .catch(() => undefined);
              }}
              onRenameCancel={() => closeRename()}
            />
          </TileShell>
        );
      })}

      {/* 对齐辅助线覆盖层（拖动 / resize 中可见） */}
      <SnapGuidesOverlay guides={snapGuides} wallRef={wallRef} />
    </div>
  );
}

/** 计算某磁贴"其它"集合（free 模式吸附用） */
function buildOthers(tiles: Record<string, { x: number; y: number; w: number; h: number }>, selfId: string) {
  const others: Array<{ x: number; y: number; w: number; h: number }> = [];
  for (const [id, geom] of Object.entries(tiles)) {
    if (id !== selfId) others.push(geom);
  }
  return others;
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