import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type MouseEvent as ReactMouseEvent } from "react";

import AgentTile from "./AgentTile";
import AgentWindow from "./AgentWindow";
import BrowserTile from "./BrowserTile";
import BrowserWindow from "./BrowserWindow";
import GhostPreview from "./GhostPreview";
import LeftSidePanel from "./LeftSidePanel";
import RightCharm from "./RightCharm";
import TileShell from "./TileShell";
import { awaitApiBase } from "../lib/api";
import { computeOpenLayout, isBoundsReady } from "../lib/layoutEngine";
import { computeMetrics, gridToPixels, maxContentCol, type TileGridMap } from "../lib/gridLayout";
import { DEFAULT_TILE_GRID } from "../lib/persistTiles";
import { startAgentEventStream, type AgentEventStreamControl } from "../lib/sseClient";
import { startBrowserEventStream } from "../lib/browserEvents";
import { useAgentsStore } from "../state/agentsStore";
import { useBrowserStore } from "../state/browserStore";
import { useWidgetStore } from "../state/widgetStore";
import { useContextMenuStore, type ContextMenuItem } from "../state/contextMenuStore";
import { useDialogStore } from "../state/dialogStore";
import { useGhostStore } from "../state/ghostStore";
import { useSnapGuideStore } from "../state/snapGuideStore";
import { useWindowManagerStore } from "../state/windowManagerStore";
import { useZoomStore } from "../state/zoomStore";
import { getWidgetDef } from "../state/widgetRegistry";
import type { Agent, TileGeometry, TileGrid } from "../types";

const EMPTY_TILE: TileGeometry = { x: 0, y: 0, w: 0, h: 0 };

/**
 * 全屏磁贴墙桌面（Win8 网格 + 双几何分屏）。
 * - free 模式：5 行网格（列不限），拖动/缩放严格量化吸附，灰色 ghost 提示，松手动画过渡
 * - 滚轮：上下 → 左右水平滑动（上=左、下=右）；Ctrl+滚轮 → 画布缩放
 * - open 模式（右栏切换“打开/关闭模态”，纯视觉、不导航）：双击磁贴翻转打开
 *   （AgentWindow / BrowserWindow），未打开磁贴收缩进左坞，展开窗口拖回左坞松手 → 收起
 * - 左栏（240px，左缘 hover 滑出）：Agent/Browser 分类 + 排序 + 卡片，单击打开
 * - 新建 Agent / widget / browser 都经 insertTile 在鼠标 X 轴列插入并重排
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

  // widget 磁贴状态
  const widgets = useWidgetStore((state) => state.widgets);
  const displaced = useGhostStore((state) => state.displaced);
  const hydrateWidgets = useWidgetStore((state) => state.hydrate);
  const moveWidget = useWidgetStore((state) => state.moveWidget);
  const commitWidget = useWidgetStore((state) => state.commitWidget);
  const removeWidget = useWidgetStore((state) => state.removeWidget);

  // 受控浏览器磁贴（独立于 Agent 的实体）
  const browsers = useBrowserStore((state) => state.browsers);
  const browserTiles = useBrowserStore((state) => state.tiles);
  const openBrowserIds = useBrowserStore((state) => state.openBrowserIds);
  const hydrateBrowser = useBrowserStore((state) => state.hydrate);
  const createBrowser = useBrowserStore((state) => state.createBrowser);
  const deleteBrowser = useBrowserStore((state) => state.deleteBrowser);
  const openBrowser = useBrowserStore((state) => state.openBrowser);
  const closeBrowser = useBrowserStore((state) => state.closeBrowser);
  const applyBrowserEvent = useBrowserStore((state) => state.applyBrowserEvent);
  const moveBrowserTile = useBrowserStore((state) => state.moveTile);
  const commitBrowserTile = useBrowserStore((state) => state.commitTile);

  /** 把“被排斥（让位）磁贴”按类型路由到对应 store 落盘，使松手后定格在临时位置 */
  const commitDisplacedTiles = useCallback(
    (map: Record<string, TileGrid>) => {
      for (const [id, grid] of Object.entries(map)) {
        if (agents.some((agent) => agent.id === id)) {
          commitTile(id, grid);
        } else if (browsers.some((browser) => browser.id === id)) {
          commitBrowserTile(id, grid);
        } else if (widgets.some((widget) => widget.id === id)) {
          commitWidget(id, grid);
        }
      }
    },
    [agents, browsers, widgets, commitTile, commitBrowserTile, commitWidget],
  );

  const renameTarget = useDialogStore((state) => state.renameTarget);
  const closeRename = useDialogStore((state) => state.closeRename);
  const showContextMenu = useContextMenuStore((state) => state.show);
  const openNewAgent = useDialogStore((state) => state.openNewAgent);
  const openWidgetPicker = useDialogStore((state) => state.openWidgetPicker);
  const openWallpaper = useDialogStore((state) => state.openWallpaper);
  const openSettings = useDialogStore((state) => state.openSettings);
  const openRenameWidget = useDialogStore((state) => state.openRenameWidget);
  const snapGuides = useSnapGuideStore((state) => state.guides);
  const zoom = useZoomStore((state) => state.level);
  const zoomIn = useZoomStore((state) => state.zoomIn);
  const zoomOut = useZoomStore((state) => state.zoomOut);
  const wmMode = useWindowManagerStore((state) => state.mode);
  const setWmMode = useWindowManagerStore((state) => state.setMode);

  // 父容器尺寸（用于度量网格）；ResizeObserver 驱动
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
    let browserStream: ReturnType<typeof startBrowserEventStream> | undefined;
    let cancelled = false;
    void (async () => {
      try {
        await load();
        if (cancelled) return;
        hydrateWidgets();
        if (cancelled) return;
        await hydrateBrowser();
        if (cancelled) return;
        const base = await awaitApiBase();
        if (cancelled) return;
        stream = startAgentEventStream(base, {
          onEvent: (event) => applyAgentEvent(event),
          onPolling: () => {
            // 降级轮询：状态仍会经 applyAgentEvent 反映到磁贴
          },
        });
        browserStream = startBrowserEventStream(base, applyBrowserEvent);
      } catch (err) {
        // 端口解析 / load 失败：状态由 agentsStore.error 体现，事件流可由下次 mount 重试
        console.error("[desktop] init failed:", err);
      }
    })();
    return () => {
      cancelled = true;
      stream?.stop();
      browserStream?.stop();
    };
  }, [load, applyAgentEvent, hydrateWidgets, hydrateBrowser, applyBrowserEvent]);

  // ---- 打开态布局：Agent + 浏览器磁贴统一进入 open 分屏；widget 永远自由摆放 ----
  const openIds = [...openAgentIds, ...openBrowserIds];
  // 模态由右栏切换（on=打开态；off=磁贴墙）。打开/收起窗口仍驱动 openIds。
  const openMode = wmMode === "on";
  // 最后一个窗口收起后自动回到磁贴墙（模态保持 user 可手动切回 on）
  useEffect(() => {
    if (wmMode === "on" && openIds.length === 0) {
      setWmMode("off");
    }
  }, [wmMode, openIds.length, setWmMode]);
  const layout = useMemo(() => {
    if (!openMode || !isBoundsReady(bounds)) return null;
    const allIds = [
      ...agents.map((agent) => agent.id),
      ...browsers.map((browser) => browser.id),
    ];
    return computeOpenLayout(bounds, openIds, allIds);
  }, [openMode, openIds, agents, browsers, bounds]);

  // ---- Win8 网格：度量 + free 模式统一 gridMap + 画布宽度 ----
  const metrics = useMemo(
    () =>
      bounds.width > 0 && bounds.height > 0
        ? computeMetrics(bounds.width, bounds.height, { zoom })
        : null,
    [bounds, zoom],
  );

  const freeGridMap: TileGridMap = useMemo(() => {
    if (openMode) return {};
    const map: TileGridMap = {};
    for (const agent of agents) {
      if (tiles[agent.id]) map[agent.id] = tiles[agent.id];
    }
    for (const browser of browsers) {
      if (browserTiles[browser.id]) map[browser.id] = browserTiles[browser.id];
    }
    for (const widget of widgets) {
      map[widget.id] = widget.grid;
    }
    return map;
  }, [openMode, agents, browsers, widgets, tiles, browserTiles]);

  const contentWidth = useMemo(() => {
    if (openMode || !metrics) return "100%";
    const maxCol = maxContentCol(freeGridMap);
    const needed = metrics.padding * 2 + maxCol * (metrics.cellW + metrics.gap) - metrics.gap;
    return `${Math.max(needed, 1)}px`;
  }, [openMode, metrics, freeGridMap]);

  // 滚轮：上=左、下=右 水平滑动；Ctrl+滚轮 → 缩放（仅 free 模式；open 模式不拦截窗口滚动）
  useEffect(() => {
    const el = wallRef.current;
    if (!el) return;
    const onWheel = (event: WheelEvent) => {
      if (event.ctrlKey) {
        event.preventDefault();
        if (event.deltaY < 0) zoomIn();
        else if (event.deltaY > 0) zoomOut();
        return;
      }
      if (!openMode) {
        event.preventDefault();
        el.scrollLeft += event.deltaY;
      }
    };
    el.addEventListener("wheel", onWheel, { passive: false });
    return () => el.removeEventListener("wheel", onWheel);
  }, [openMode, zoomIn, zoomOut]);

  // 桌面空白处右键 → 弹出菜单（New Agent / Add widget / Refresh / Change wallpaper / Zoom）
  const onContextMenu = useCallback(
    (event: ReactMouseEvent<HTMLDivElement>) => {      // 点在磁贴上不响应（仅空白桌面）
      if (event.target instanceof Element && event.target.closest(".tile-shell")) {
        return;
      }
      event.preventDefault();
      const wallRect = wallRef.current?.getBoundingClientRect();
      const spawn = wallRect
        ? { x: event.clientX - wallRect.left, y: event.clientY - wallRect.top }
        : undefined;
      const items: ContextMenuItem[] = [
        {
          id: "new-agent",
          label: "New Agent",
          onClick: () => {
            openNewAgent(spawn);
          },
        },
        {
          id: "add-widget",
          label: "Add widget",
          onClick: () => {
            openWidgetPicker(spawn);
          },
        },
        {
          id: "new-browser-normal",
          label: "🔒 New Browser（正常·持久登录）",
          onClick: () => {
            void createBrowser({ mode: "persistent" }).then((browser) => {
              if (browser) openBrowser(browser.id);
            });
          },
        },
        {
          id: "new-browser-incognito",
          label: "🕶 New Browser（无痕）",
          onClick: () => {
            void createBrowser({ mode: "incognito" }).then((browser) => {
              if (browser) openBrowser(browser.id);
            });
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
          id: "divider-zoom",
          label: "",
          onClick: () => {},
          divider: true,
        },
        {
          id: "zoom-in",
          label: `放大（当前 ${Math.round(zoom * 100)}%）`,
          onClick: () => zoomIn(),
        },
        {
          id: "zoom-out",
          label: "缩小",
          onClick: () => zoomOut(),
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
    [showContextMenu, openNewAgent, openWidgetPicker, openWallpaper, openSettings, load, zoom, zoomIn, zoomOut],
  );

  return (
    <div className={`tile-wall${openMode ? " tile-wall--open" : ""}`} ref={wallRef} onContextMenu={onContextMenu}>
      {error ? <p className="tile-wall__error" role="alert">{error}</p> : null}

      {loading && agents.length === 0 ? (
        <p className="tile-wall__hint" role="status" aria-busy="true">
          Loading agents…
        </p>
      ) : null}

      {/* free 模式：内容撑宽（水平滚动区），磁贴 absolute 相对墙 */}
      {!openMode ? (
        <div className="tile-wall__sizer" style={{ width: contentWidth, height: "100%" }} aria-hidden="true" />
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
        // 双几何：无打开 → idle（grid 派生像素，灰框让位时用 displaced 覆盖）；有打开 → 布局引擎计算（dock / stage）
        const displacedGrid = displaced[agent.id];
        const geometry =
          openMode && layout
            ? layout.geometryOf[agent.id] ?? EMPTY_TILE
            : metrics && tiles[agent.id]
              ? gridToPixels(displacedGrid ?? tiles[agent.id], metrics)
              : EMPTY_TILE;
        const tileMode = !openMode ? "free" : isOpen ? "expanded" : "dock";

        return (
          <TileShell
            key={agent.id}
            id={agent.id}
            agentName={agent.name}
            geometry={geometry}
            grid={!openMode ? tiles[agent.id] : undefined}
            gridMap={!openMode ? freeGridMap : undefined}
            metrics={!openMode ? metrics ?? undefined : undefined}
            bounds={bounds}
            mode={tileMode}
            dragHandleSelector={isOpen ? ".agent-window__header" : undefined}
            dockRightEdgeX={layout?.dockRightEdgeX}
            zIndex={isOpen ? 20 : 1}
            displacedPreview={!!displacedGrid && tileMode === "free"}
            flipped={isOpen}
            back={isOpen ? <AgentWindow agent={agent} onClose={() => closeAgent(agent.id)} /> : undefined}
            onMove={(next) => moveTile(agent.id, next)}
            onCommit={(next) => commitTile(agent.id, next)}
            onCommitDisplaced={commitDisplacedTiles}
            onDropToDock={isOpen ? () => closeAgent(agent.id) : undefined}
            onOpenTile={tileMode === "expanded" ? undefined : () => onOpen(agent)}
          >
            <AgentTile
              agent={agent}
              onOpen={onOpen}
              renaming={renameTarget === agent.id}
              onRenameCommit={(agentName) => {
                // 成功才退出内联编辑；失败保持编辑态，错误已写入 store.error（桌面顶部展示）
                void renameAgent(agent.id, agentName)
                  .then(() => closeRename())
                  .catch(() => undefined);
              }}
              onRenameCancel={() => closeRename()}
            />
          </TileShell>
        );
      })}

      {/* 受控浏览器磁贴：与 Agent 一样参与 open 分屏（independent entity） */}
      {browsers.map((browser) => {
        const isOpen = openBrowserIds.includes(browser.id);
        const displacedGrid = displaced[browser.id];
        const geometry =
          openMode && layout
            ? layout.geometryOf[browser.id] ?? EMPTY_TILE
            : metrics && browserTiles[browser.id]
              ? gridToPixels(displacedGrid ?? browserTiles[browser.id], metrics)
              : metrics
                ? gridToPixels(DEFAULT_TILE_GRID, metrics)
                : EMPTY_TILE;
        const tileMode = !openMode ? "free" : isOpen ? "expanded" : "dock";
        const browserMenuItems: ContextMenuItem[] = [
          {
            id: "open-browser",
            label: "打开浏览器",
            onClick: () => openBrowser(browser.id),
          },
          {
            id: "remove-browser",
            label: "删除浏览器（无痕同时销毁数据）",
            onClick: () => void deleteBrowser(browser.id),
          },
        ];
        return (
          <TileShell
            key={browser.id}
            id={browser.id}
            agentName={browser.name}
            geometry={geometry}
            grid={!openMode ? browserTiles[browser.id] ?? DEFAULT_TILE_GRID : undefined}
            gridMap={!openMode ? freeGridMap : undefined}
            metrics={!openMode ? metrics ?? undefined : undefined}
            bounds={bounds}
            mode={tileMode}
            dragHandleSelector={isOpen ? ".browser-window__header" : undefined}
            dockRightEdgeX={layout?.dockRightEdgeX}
            zIndex={isOpen ? 21 : 1}
            displacedPreview={!!displacedGrid}
            flipped={isOpen}
            back={isOpen ? <BrowserWindow browser={browser} onClose={() => closeBrowser(browser.id)} /> : undefined}
            onMove={(next) => moveBrowserTile(browser.id, next)}
            onCommit={(next) => commitBrowserTile(browser.id, next)}
            onCommitDisplaced={commitDisplacedTiles}
            onDropToDock={isOpen ? () => closeBrowser(browser.id) : undefined}
            contextMenuItems={browserMenuItems}
            onOpenTile={tileMode === "expanded" ? undefined : () => openBrowser(browser.id)}
          >
            <BrowserTile browser={browser} />
          </TileShell>
        );
      })}

      {/* Widget 磁贴：永远 free、无 opened 生命周期、无 back */}
      {widgets.map((widget) => {
        const def = getWidgetDef(widget.kind);
        if (!def) return null;
        const geometry = metrics
          ? gridToPixels((displaced[widget.id] ?? widget.grid), metrics)
          : EMPTY_TILE;
        const widgetMenuItems: ContextMenuItem[] = [
          {
            id: "rename-widget",
            label: "重命名 Widget",
            onClick: () => openRenameWidget(widget.id),
          },
          {
            id: "remove-widget",
            label: "移除 Widget",
            onClick: () => removeWidget(widget.id),
          },
        ];
        const title = widget.title;
        return (
          <TileShell
            key={widget.id}
            id={widget.id}
            geometry={geometry}
            grid={widget.grid}
            gridMap={freeGridMap}
            metrics={metrics ?? undefined}
            bounds={bounds}
            mode="free"
            zIndex={1}
            disableResize={def.fixedSize}
            displacedPreview={!!displaced[widget.id]}
            contextMenuItems={widgetMenuItems}
            onMove={(next) => moveWidget(widget.id, next)}
            onCommit={(next) => commitWidget(widget.id, next)}
            onCommitDisplaced={commitDisplacedTiles}
          >
            <div className="widget-tile">
              <div className="widget-tile__title">{title}</div>
              <div className="widget-tile__body">{def.renderBody()}</div>
            </div>
          </TileShell>
        );
      })}

      {/* 拖动中的量化灰色提示框（Win8 ghost） */}
      <GhostPreview />

      {/* 对齐辅助线覆盖层（expanded 拖动中可见） */}
      <SnapGuidesOverlay guides={snapGuides} wallRef={wallRef} />

      {/* Win8 左右栏：右缘 45px 模态切换 + 左缘 240px hover 滑出分类卡片 */}
      <RightCharm />
      <LeftSidePanel />
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