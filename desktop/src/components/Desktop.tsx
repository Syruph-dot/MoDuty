import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type MouseEvent as ReactMouseEvent } from "react";

import AgentTile from "./AgentTile";
import AgentWindow from "./AgentWindow";
import BrowserTile from "./BrowserTile";
import BrowserWindow from "./BrowserWindow";
import GhostPreview from "./GhostPreview";
import GroupedWall from "./GroupedWall";
import LeftSidePanel from "./LeftSidePanel";
import RightCharm from "./RightCharm";
import TileShell from "./TileShell";
import { awaitApiBase } from "../lib/api";
import { computeBands, UNGROUPED_BAND_ID, SYSTEM_BAND_ID, type Band } from "../lib/bandLayout";
import { computeOpenLayout, isBoundsReady } from "../lib/layoutEngine";
import { computeMetrics, gridToPixels } from "../lib/gridLayout";
import { DEFAULT_TILE_GRID } from "../lib/persistTiles";
import { startAgentEventStream, type AgentEventStreamControl } from "../lib/sseClient";
import { startBrowserEventStream } from "../lib/browserEvents";
import { useAgentsStore, useVisibleAgents } from "../state/agentsStore";
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
import { GRID_ROWS, GRID_START_ROW } from "../types";

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
  const deleteAgent = useAgentsStore((state) => state.deleteAgent);

  // 磁贴墙治理（A+B+D）：视图模式 / 筛选 / 归档 / 钉住
  const viewMode = useAgentsStore((state) => state.viewMode);
  const filters = useAgentsStore((state) => state.filters);
  const pinnedIds = useAgentsStore((state) => state.pinnedIds);
  const togglePin = useAgentsStore((state) => state.togglePin);
  const toggleArchive = useAgentsStore((state) => state.toggleArchive);
  const setArchiveOpen = useAgentsStore((state) => state.setArchiveOpen);
  const { wall: wallAgents, archivedTotal } = useVisibleAgents();

  // 拖拽成组（手动画组）：组带数据与动作
  const groups = useAgentsStore((state) => state.groups);
  const groupMembers = useAgentsStore((state) => state.groupMembers);
  const createGroup = useAgentsStore((state) => state.createGroup);
  const joinGroup = useAgentsStore((state) => state.joinGroup);
  const leaveGroup = useAgentsStore((state) => state.leaveGroup);
  const moveGroupMember = useAgentsStore((state) => state.moveGroupMember);
  const repelDropIntoGroup = useAgentsStore((state) => state.repelDropIntoGroup);
  const repelDropToUngrouped = useAgentsStore((state) => state.repelDropToUngrouped);
  const renameGroup = useAgentsStore((state) => state.renameGroup);
  const reorderGroups = useAgentsStore((state) => state.reorderGroups);

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
  const openRename = useDialogStore((state) => state.openRename);
  const openConfirm = useDialogStore((state) => state.openConfirm);
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

  // ---- 打开态关联会话（&ses_ 图）：右半屏打开的 session 的出/入边邻居（最多 12，时间倒序）----
  const [relatedAgentIds, setRelatedAgentIds] = useState<string[]>([]);

  // 墙可见集合（A 筛选 + D 活跃/归档派生）；grouped 与 free 共享同一口径
  const wallIds = useMemo(() => new Set(wallAgents.map((agent) => agent.id)), [wallAgents]);

  /** Agent 磁贴右键菜单（A/B/D）：钉住 / 归档 / 重命名 / 删除 */
  const buildAgentMenu = useCallback(
    (agent: Agent): ContextMenuItem[] => {
      const pinned = pinnedIds.includes(agent.id);
      const manualArchived = useAgentsStore.getState().archivedIds.includes(agent.id);
      const inGroup = !!useAgentsStore.getState().groupMembers[agent.id];
      return [
        {
          id: pinned ? "unpin" : "pin",
          label: pinned ? "取消钉住" : "钉住（始终在墙）",
          onClick: () => togglePin(agent.id),
        },
        {
          id: manualArchived ? "unarchive" : "archive",
          label: manualArchived ? "从归档恢复" : "移至归档",
          onClick: () => {
            toggleArchive(agent.id);
            if (!manualArchived) setArchiveOpen(true);
          },
        },
        ...(inGroup
          ? [
              {
                id: "leave-group",
                label: "移出分组",
                onClick: () => leaveGroup(agent.id),
              },
            ]
          : []),
        { id: "divider-mgmt", label: "", onClick: () => {}, divider: true },
        {
          id: "rename-agent",
          label: "重命名 Agent",
          onClick: () => openRename(agent.id),
        },
        {
          id: "delete-agent",
          label: "删除 Agent（含会话）",
          onClick: () => {
            openConfirm({
              title: "删除 Agent",
              message: `确定删除 Agent「${agent.name}」吗？该操作会一并删除其会话且不可恢复。`,
              confirmLabel: "删除",
              onConfirm: () => {
                void deleteAgent(agent.id).catch(() => undefined);
              },
            });
          },
        },
      ];
    },
    [pinnedIds, togglePin, toggleArchive, setArchiveOpen, openRename, openConfirm, deleteAgent, leaveGroup],
  );

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
  // 打开态关联会话集合（渲染过滤 + dock 布局共用）
  const relatedSet = useMemo(() => new Set(relatedAgentIds), [relatedAgentIds]);
  // 模态由右栏切换（on=打开态；off=磁贴墙）。打开/收起窗口仍驱动 openIds。
  const openMode = wmMode === "on";

  // 分组视图（方案 B）：仅空闲墙且 viewMode=grouped 时启用
  const groupedMode = viewMode === "grouped" && !openMode;

  // ---- 打开态关联会话（&ses_ 图）：右半屏打开的 session 的出/入边邻居（最多 12，时间倒序）----
  useEffect(() => {
    if (!openMode) {
      setRelatedAgentIds([]);
      return;
    }
    const sessionIds = openAgentIds
      .map((id) => agents.find((a) => a.id === id)?.session_id)
      .filter((sid): sid is string => !!sid);
    if (sessionIds.length === 0) {
      setRelatedAgentIds([]);
      return;
    }
    let cancelled = false;
    void (async () => {
      try {
        const base = await awaitApiBase();
        const res = await fetch(`${base}/api/sessions/related?ids=${sessionIds.join(",")}`);
        const data = (await res.json()) as { sessions?: Array<{ agentId: string }> };
        if (!cancelled) setRelatedAgentIds((data.sessions ?? []).map((s) => s.agentId));
      } catch {
        if (!cancelled) setRelatedAgentIds([]);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [openMode, openAgentIds, agents]);
  // 最后一个窗口收起后自动回到磁贴墙（模态保持 user 可手动切回 on）
  useEffect(() => {
    if (wmMode === "on" && openIds.length === 0) {
      setWmMode("off");
    }
  }, [wmMode, openIds.length, setWmMode]);
  const layout = useMemo(() => {
    if (!openMode || !isBoundsReady(bounds)) return null;
    // 左坞只放：关联会话（最多 12）+ 全部 browser（用户确认 A：browser 保留续排）
    const allIds = [
      ...agents.filter((a) => openAgentIds.includes(a.id) || relatedSet.has(a.id)).map((a) => a.id),
      ...browsers.map((b) => b.id),
    ];
    return computeOpenLayout(bounds, openIds, allIds);
  }, [openMode, openIds, agents, browsers, bounds, relatedSet]);

  // ---- Win8 网格：度量 + free 模式统一 gridMap + 画布宽度 ----
  const metrics = useMemo(
    () =>
      bounds.width > 0 && bounds.height > 0
        ? computeMetrics(bounds.width, bounds.height, { zoom })
        : null,
    [bounds, zoom],
  );

  // ---- Band（组带）布局：打破全局网格 —— 组带序列（x 累加，组间 120px）+ 组内局部网格 ----
  const bandLayout = useMemo(() => {
    if (!metrics) return null;
    return computeBands({
      agents: wallAgents,
      groups,
      groupMembers,
      tiles,
      browsers,
      browserTiles,
      widgets,
      metrics,
    });
  }, [metrics, wallAgents, groups, groupMembers, tiles, browsers, browserTiles, widgets]);
  const bands = bandLayout?.bands ?? [];
  const bandOf = bandLayout?.bandOf ?? {};
  const bandById = useMemo(() => {
    const m: Record<string, Band> = {};
    for (const b of bands) m[b.id] = b;
    return m;
  }, [bands]);

  // ---- 拖拽成组：hover 单计时状态机（ref 驱动）----
  //  0～0.5s  计时（目标磁贴/组名亮起中）
  //  0.5～1s  成组就绪（--drop 蓝亮，松手 = 建组/移组）
  //  >1s      排斥就绪（--repel 橙亮，松手 = 排斥落位，目标带内让位 → 最终无重叠）
  const dragHoverRef = useRef<{
    sourceAgentId: string | null;
    sourceGroupId: string | null;
    targetGroupId: string | null;
    targetAgentId: string | null;
    activated: boolean;
    mode: "group" | "repel";
    timer: number | null;
    guard: number;
  }>({ sourceAgentId: null, sourceGroupId: null, targetGroupId: null, targetAgentId: null, activated: false, mode: "group", timer: null, guard: 0 });
  const [renamingGroupId, setRenamingGroupId] = useState<string | null>(null);
  const [groupNameDraft, setGroupNameDraft] = useState("");

  const clearDragHover = useCallback(() => {
    const h = dragHoverRef.current;
    if (h.timer !== null) window.clearTimeout(h.timer);
    document.querySelectorAll(".tile-group-name--drop,.tile-group-name--repel,.tile-shell--drop,.tile-shell--repel").forEach((el) => {
      el.className = el.className.replace(/ tile-group-name--(drop|repel)| tile-shell--(drop|repel)/g, "");
    });
    h.timer = null;
    h.targetGroupId = null;
    h.targetAgentId = null;
    h.activated = false;
    h.mode = "group";
    h.sourceAgentId = null;
    h.sourceGroupId = null;
  }, []);

  const handleDragCursor = useCallback(
    (clientX: number, clientY: number) => {
      const h = dragHoverRef.current;
      if (!h.sourceAgentId) return;
      // 目标检测：磁贴优先（带内局部 id），组名/组带次之
      let targetAgentId: string | null = null;
      let targetGroupId: string | null = null;
      const els = document.elementsFromPoint(clientX, clientY);
      for (const el of els) {
        const tile = el.closest?.("[data-tile-id]") as HTMLElement | null;
        if (tile && tile.dataset.tileId && tile.dataset.tileId !== h.sourceAgentId) {
          targetAgentId = tile.dataset.tileId;
          targetGroupId = bandOf[targetAgentId] ?? null;
          break;
        }
        const gname = el.closest?.("[data-group-name]") as HTMLElement | null;
        if (gname && gname.dataset.groupName) {
          targetGroupId = gname.dataset.groupName;
          break;
        }
      }
      // 无目标 / 系统带（browser/widget，不参与成组）→ 清除
      // 同带磁贴也激活 hover：<1s 同组→落位（resolve）、未分组↔未分组→建组；≥1s→排斥落位
      if (!targetAgentId && !targetGroupId) {
        clearDragHover();
        return;
      }
      if (targetGroupId === SYSTEM_BAND_ID) {
        clearDragHover();
        return;
      }
      // 目标未变化且已就绪：保持
      if (h.targetGroupId === targetGroupId && h.targetAgentId === targetAgentId && (h.activated || h.mode === "repel")) return;
      // 重启单计时：0.5s 成组就绪 → 再过 0.5s 排斥就绪
      if (h.timer !== null) window.clearTimeout(h.timer);
      h.targetGroupId = targetGroupId;
      h.targetAgentId = targetAgentId;
      h.activated = false;
      h.mode = "group";
      const guard = ++h.guard;
      const clearAllHighlights = () => {
        document.querySelectorAll(".tile-group-name--drop,.tile-shell--drop,.tile-group-name--repel,.tile-shell--repel").forEach((el) => {
          el.classList.remove("tile-group-name--drop", "tile-shell--drop", "tile-group-name--repel", "tile-shell--repel");
        });
      };
      h.timer = window.setTimeout(() => {
        if (h.guard !== guard) return;
        h.activated = true;
        h.mode = "group";
        clearAllHighlights();
        if (targetGroupId) {
          document.querySelector(`[data-group-name="${targetGroupId}"]`)?.classList.add("tile-group-name--drop");
        }
        if (targetAgentId) {
          document.querySelector(`[data-tile-id="${targetAgentId}"]`)?.closest(".tile-shell")?.classList.add("tile-shell--drop");
        }
        h.timer = window.setTimeout(() => {
          if (h.guard !== guard) return;
          h.mode = "repel";
          clearAllHighlights();
          if (targetGroupId) {
            document.querySelector(`[data-group-name="${targetGroupId}"]`)?.classList.add("tile-group-name--repel");
          }
          if (targetAgentId) {
            document.querySelector(`[data-tile-id="${targetAgentId}"]`)?.closest(".tile-shell")?.classList.add("tile-shell--repel");
          }
        }, 500);
      }, 500);
    },
    [clearDragHover, bandOf],
  );

  // 全局拖拽光标转发：墙上有磁贴处于拖拽态（.tile-shell--dragging）时，把指针坐标喂给 hover 状态机；
  // 指针在视口左右边缘时自动滚动画布（边缘 48px，越近越快）
  useEffect(() => {
    const el = wallRef.current;
    const EDGE = 48;
    const edgeScrollRef = { raf: 0, dir: 0, lastX: 0, lastY: 0 };
    const stopEdgeScroll = () => {
      if (edgeScrollRef.raf) {
        cancelAnimationFrame(edgeScrollRef.raf);
        edgeScrollRef.raf = 0;
      }
      edgeScrollRef.dir = 0;
    };
    const onMove = (event: MouseEvent) => {
      edgeScrollRef.lastX = event.clientX;
      edgeScrollRef.lastY = event.clientY;
      const draggingShell = document.querySelector(".tile-shell--dragging");
      if (!draggingShell) {
        stopEdgeScroll();
        return;
      }
      const src = draggingShell.closest("[data-tile-id]") as HTMLElement | null;
      const sourceId = src?.dataset.tileId;
      if (!sourceId) return;
      const h = dragHoverRef.current;
      if (h.sourceAgentId !== sourceId) {
        h.sourceAgentId = sourceId;
        h.sourceGroupId = bandOf[sourceId] ?? null;
      }
      // 边缘自动滚动：进入 48px 边缘区即持续滚动，越靠边越快（线性 8→22 px/帧）
      const edge = event.clientX < EDGE ? -1 : event.clientX > window.innerWidth - EDGE ? 1 : 0;
      if (edge !== 0) {
        if (edgeScrollRef.dir !== edge || !edgeScrollRef.raf) {
          edgeScrollRef.dir = edge;
          stopEdgeScroll();
          const step = () => {
            if (!el) return;
            const dist = edge < 0 ? Math.max(0, edgeScrollRef.lastX) : Math.max(0, window.innerWidth - edgeScrollRef.lastX);
            const speed = 8 + Math.max(0, (EDGE - dist)) * 0.35;
            const prev = el.scrollLeft;
            el.scrollLeft += edge * speed;
            const delta = el.scrollLeft - prev;
            if (delta !== 0) {
              window.dispatchEvent(new CustomEvent("momoka:wall-scroll", { detail: { delta, clientX: edgeScrollRef.lastX, clientY: edgeScrollRef.lastY } }));
            }
            edgeScrollRef.raf = requestAnimationFrame(step);
          };
          edgeScrollRef.raf = requestAnimationFrame(step);
        }
      } else {
        stopEdgeScroll();
      }
      handleDragCursor(event.clientX, event.clientY);
    };
    const onUp = () => stopEdgeScroll();
    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp);
    return () => {
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("mouseup", onUp);
      stopEdgeScroll();
    };
  }, [handleDragCursor, bandOf]);

  // ---- 组标题拖拽排序：拖动组名 → 高亮目标组 → 松手调整组间顺序 ----
  const [reorderSource, setReorderSource] = useState<string | null>(null);
  const reorderRef = useRef<{ sourceId: string | null; startX: number; moved: boolean; targetId: string | null }>({
    sourceId: null,
    startX: 0,
    moved: false,
    targetId: null,
  });
  const onGroupNameMouseDown = useCallback(
    (groupId: string) => (event: ReactMouseEvent) => {
      if (renamingGroupId === groupId) return;
      if (event.button !== 0) return;
      event.stopPropagation(); // 不触发画布平移
      reorderRef.current = { sourceId: groupId, startX: event.clientX, moved: false, targetId: null };
    },
    [renamingGroupId],
  );
  useEffect(() => {
    const onMove = (event: MouseEvent) => {
      const r = reorderRef.current;
      if (!r.sourceId) return;
      if (!r.moved && Math.abs(event.clientX - r.startX) > 4) {
        r.moved = true;
        setReorderSource(r.sourceId);
      }
      if (!r.moved) return;
      let target: string | null = null;
      for (const el of document.elementsFromPoint(event.clientX, event.clientY)) {
        const g = el.closest?.("[data-group-name]") as HTMLElement | null;
        if (g && g.dataset.groupName && g.dataset.groupName !== r.sourceId) {
          target = g.dataset.groupName;
          break;
        }
      }
      document.querySelectorAll(".tile-group-name--reorder-drop").forEach((el) => el.classList.remove("tile-group-name--reorder-drop"));
      if (target) {
        document.querySelector(`[data-group-name="${target}"]`)?.classList.add("tile-group-name--reorder-drop");
      }
      r.targetId = target;
    };
    const onUp = () => {
      const r = reorderRef.current;
      if (r.moved && r.sourceId && r.targetId) {
        reorderGroups(r.sourceId, r.targetId);
      }
      document.querySelectorAll(".tile-group-name--reorder-drop").forEach((el) => el.classList.remove("tile-group-name--reorder-drop"));
      reorderRef.current = { sourceId: null, startX: 0, moved: false, targetId: null };
      setReorderSource(null);
    };
    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp);
    return () => {
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("mouseup", onUp);
    };
  }, [reorderGroups]);

  const contentWidth = useMemo(() => {
    if (openMode || !metrics) return "100%";
    const w = bandLayout?.contentWidth ?? 0;
    return `${Math.max(w, 1)}px`;
  }, [openMode, metrics, bandLayout]);

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

  // 鼠标左键拖拽空白 → 水平平移画布（free 模式的“抓手”平移；磁贴/浮层/控件不触发）
  useEffect(() => {
    const el = wallRef.current;
    if (!el) return;
    let panning = false;
    let startX = 0;
    let startScroll = 0;
    const IGNORE_SELECTOR =
      ".tile-shell, .tile-group-name, .wm-side, .wm-left-hotzone, .wm-right-hotzone, .wm-charm-bar, .wm-charm__btn, .wall-footer-banner, button, input, textarea, [data-context-menu]";
    const onDown = (event: MouseEvent) => {
      if (openMode) return;
      if (event.button !== 0) return;
      if (event.target instanceof Element && event.target.closest(IGNORE_SELECTOR)) return;
      panning = true;
      startX = event.clientX;
      startScroll = el.scrollLeft;
      el.classList.add("tile-wall--panning");
      document.body.style.cursor = "grabbing";
      document.body.style.userSelect = "none";
    };
    const onMove = (event: MouseEvent) => {
      if (!panning) return;
      el.scrollLeft = startScroll - (event.clientX - startX);
    };
    const onUp = () => {
      if (!panning) return;
      panning = false;
      el.classList.remove("tile-wall--panning");
      document.body.style.cursor = "";
      document.body.style.userSelect = "";
    };
    el.addEventListener("mousedown", onDown);
    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp);
    return () => {
      el.removeEventListener("mousedown", onDown);
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("mouseup", onUp);
    };
  }, [openMode, wallRef]);

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
      {!openMode && !groupedMode ? (
        <div className="tile-wall__sizer" style={{ width: contentWidth, height: "100%" }} aria-hidden="true" />
      ) : null}

      {/* grouped 视图（方案 B）：按工作区分组，X 轴分列布局 */}
      {!openMode && groupedMode ? <GroupedWall onOpen={onOpen} /> : null}

      {/* A+B 空态：墙内无命中（free 视图） */}
      {!openMode && !groupedMode && !loading && agents.length > 0 && wallAgents.length === 0 ? (
        <div className="tile-wall__filter-empty" role="status">
          <p>没有符合筛选条件的 Agent</p>
          <button
            type="button"
            className="btn btn--ghost"
            onClick={() => useAgentsStore.getState().clearFilters()}
          >
            清除筛选
          </button>
        </div>
      ) : null}

      {/* 打开态：左半屏坞背景（无文字提示） */}
      {openMode && layout ? (
        <div className="dock-area" style={{ left: layout.dock.x, top: layout.dock.y, width: layout.dock.w, height: layout.dock.h }} aria-hidden="true" />
      ) : null}

      {/* 拖拽成组：组名层（组带顶部保留行左对齐，Segoe UI Light；用户组双击可编辑） */}
      {!openMode && !groupedMode && bandLayout && metrics
        ? bandLayout.bands.map((band) => (
            <div
              key={band.id}
              data-group-name={band.id}
              className={`tile-group-name${renamingGroupId === band.id ? " tile-group-name--editing" : ""}${reorderSource === band.id ? " tile-group-name--dragging" : ""}`}
              style={{ left: metrics.padding + band.x, top: Math.max(2, metrics.padding - 10), width: band.width }}
              onMouseDown={onGroupNameMouseDown(band.id)}
            >
              {renamingGroupId === band.id && band.editable ? (
                <input
                  className="tile-group-name__edit"
                  value={groupNameDraft}
                  autoFocus
                  onChange={(event) => setGroupNameDraft(event.target.value)}
                  onMouseDown={(event) => event.stopPropagation()}
                  onBlur={() => {
                    const v = groupNameDraft.trim();
                    if (v) renameGroup(band.id, v);
                    setRenamingGroupId(null);
                  }}
                  onKeyDown={(event) => {
                    event.stopPropagation();
                    if (event.key === "Enter") {
                      const v = groupNameDraft.trim();
                      if (v) renameGroup(band.id, v);
                      setRenamingGroupId(null);
                    } else if (event.key === "Escape") {
                      setRenamingGroupId(null);
                    }
                  }}
                />
              ) : (
                <span
                  className="tile-group-name__text"
                  title={band.editable ? "双击重命名组" : undefined}
                  onDoubleClick={band.editable ? () => { setGroupNameDraft(band.name); setRenamingGroupId(band.id); } : undefined}
                >
                  {band.name}
                </span>
              )}
              <span className="tile-group-name__count">{band.ids.length}</span>
            </div>
          ))
        : null}

      {agents.map((agent) => {
        // 分组视图：Agent 磁贴由 GroupedWall 统一渲染（非自由网格）
        if (groupedMode) return null;
        const isOpen = openAgentIds.includes(agent.id);
        const inDock = openMode && !isOpen && relatedSet.has(agent.id);
        const canvasGhost = openMode && !isOpen && !relatedSet.has(agent.id);
        // 墙治理（A+D）：空闲态只渲染墙内可见；打开态的画布弱化层同样只显示墙内可见（归档/筛选外不显示）
        if (!openMode && !wallIds.has(agent.id)) return null;
        if (openMode && canvasGhost && !wallIds.has(agent.id)) return null;
        // 双几何：打开态 → stage/dock（布局引擎）或画布弱化层（band 局部网格，透明可见初始画布）；
        //         空闲态 → band 局部网格派生像素（灰框让位时用 displaced 覆盖）
        const displacedGrid = displaced[agent.id];
        const band = bandById[bandOf[agent.id]] ?? null;
        const sourceGrid = band?.gridMap[agent.id] ?? null;
        const bandX = band?.x ?? 0;
        const geometry =
          openMode && layout && (isOpen || inDock)
            ? layout.geometryOf[agent.id] ?? EMPTY_TILE
            : metrics && sourceGrid
              ? gridToPixels(displacedGrid ?? sourceGrid, metrics, bandX)
              : EMPTY_TILE;
        const tileMode = !openMode ? "free" : isOpen ? "expanded" : inDock ? "dock" : "free";
        // 组带内拖动：clamp 在带内（允许向右扩展一列；行不出可放置区）
        const gridClamp =
          !openMode && band && !band.isSystem
            ? {
                minCol: 0,
                maxCol: Math.max(0, band.maxCol),
                minRow: GRID_START_ROW,
                maxRow: GRID_ROWS - 1,
              }
            : undefined;
        // 组内拖动落点 → 组内局部坐标；未分组 → 未分组带局部坐标（tiles）
        const onTileMove = (next: TileGrid) => {
          const m = useAgentsStore.getState().groupMembers[agent.id];
          if (m) moveGroupMember(agent.id, next.col, next.row, next.w, next.h);
          else moveTile(agent.id, next);
        };
        const onTileCommit = (next: TileGrid) => {
          const h = dragHoverRef.current;
          // 跨带/同带 hover 就绪后松手：<1s 成组/落位，≥1s 排斥落位
          if (h.activated && h.sourceAgentId === agent.id) {
            const target = h.targetAgentId;
            if (target) {
              const tBand = h.targetGroupId ? bandById[h.targetGroupId] : null;
              const tGrid = tBand?.gridMap[target];
              const col = tGrid?.col ?? 0;
              const row = tGrid?.row ?? GRID_START_ROW;
              const w = tGrid?.w ?? next.w;
              const th = tGrid?.h ?? next.h;
              const sameUserGroup = h.targetGroupId && h.targetGroupId === h.sourceGroupId && h.targetGroupId !== UNGROUPED_BAND_ID;
              if (h.mode === "repel" || sameUserGroup) {
                // ≥1s 排斥落位；或 <1s 同组拖动 → 落目标位置 + 组内 resolve（无重叠）
                if (h.targetGroupId && h.targetGroupId !== UNGROUPED_BAND_ID) {
                  repelDropIntoGroup(agent.id, h.targetGroupId, col, row, w, th);
                } else {
                  repelDropToUngrouped(agent.id, col, row, w, th);
                }
              } else if (h.targetGroupId === UNGROUPED_BAND_ID && h.sourceGroupId === UNGROUPED_BAND_ID) {
                // 未分组 ↔ 未分组（<1s）→ 建新组
                createGroup([agent.id, target]);
              } else if (h.targetGroupId === UNGROUPED_BAND_ID) {
                // 组内 → 未分组磁贴（<1s）→ 回未分组并落目标位置（无重叠）
                repelDropToUngrouped(agent.id, col, row, w, th);
              } else if (h.targetGroupId) {
                // 未分组/其它组 → 目标组磁贴（<1s）→ 移入目标组
                joinGroup(agent.id, h.targetGroupId);
              }
            } else if (h.targetGroupId && h.targetGroupId !== UNGROUPED_BAND_ID) {
              // 拖到组名/组带空白：移入该组
              joinGroup(agent.id, h.targetGroupId);
            }
            clearDragHover();
            return;
          }
          clearDragHover();
          const m = useAgentsStore.getState().groupMembers[agent.id];
          if (m) moveGroupMember(agent.id, next.col, next.row, next.w, next.h);
          else commitTile(agent.id, next);
        };
        // 拖动指针回调已改为 Desktop 全局 mousemove 机制（见下方 useEffect）：
        // 只要墙上有磁贴处于 .tile-shell--dragging，全局监听即转发坐标并驱动 hover 状态机

        return (
          <TileShell
            key={agent.id}
            id={agent.id}
            agentName={agent.name}
            geometry={geometry}
            grid={!openMode ? sourceGrid ?? undefined : undefined}
            gridMap={!openMode ? band?.gridMap : undefined}
            metrics={!openMode ? metrics ?? undefined : undefined}
            bounds={bounds}
            mode={tileMode}
            dragHandleSelector={isOpen ? ".agent-window__header" : undefined}
            dockRightEdgeX={layout?.dockRightEdgeX}
            zIndex={isOpen ? 20 : openMode ? (inDock ? 1 : 0) : 1}
            displacedPreview={!!displacedGrid && tileMode === "free"}
            gridClamp={gridClamp}
            bandX={bandX}
            canvasGhost={canvasGhost}
            flipped={isOpen}
            back={isOpen ? <AgentWindow agent={agent} onClose={() => closeAgent(agent.id)} /> : undefined}
            onMove={onTileMove}
            onCommit={onTileCommit}
            onCommitDisplaced={commitDisplacedTiles}
            onDropToDock={isOpen ? () => closeAgent(agent.id) : undefined}
            contextMenuItems={!openMode ? buildAgentMenu(agent) : undefined}
            onOpenTile={tileMode === "expanded" ? undefined : () => onOpen(agent)}
          >
            <AgentTile
              agent={agent}
              onOpen={onOpen}
              pinned={pinnedIds.includes(agent.id)}
              highlight={filters.query}
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
        if (groupedMode) return null; // 分组视图仅展示 Agent 分组
        const isOpen = openBrowserIds.includes(browser.id);
        const displacedGrid = displaced[browser.id];
        const systemBand = bandById[SYSTEM_BAND_ID] ?? null;
        const systemBandX = systemBand?.x ?? 0;
        const geometry =
          openMode && layout
            ? layout.geometryOf[browser.id] ?? EMPTY_TILE
            : metrics && browserTiles[browser.id]
              ? gridToPixels(displacedGrid ?? browserTiles[browser.id], metrics, systemBandX)
              : metrics
                ? gridToPixels(DEFAULT_TILE_GRID, metrics, systemBandX)
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
            gridMap={!openMode ? systemBand?.gridMap : undefined}
            metrics={!openMode ? metrics ?? undefined : undefined}
            bounds={bounds}
            mode={tileMode}
            dragHandleSelector={isOpen ? ".browser-window__header" : undefined}
            dockRightEdgeX={layout?.dockRightEdgeX}
            zIndex={isOpen ? 21 : 1}
            displacedPreview={!!displacedGrid}
            bandX={systemBandX}
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

      {/* Widget 磁贴：并入未分组带（不再固定进系统组），可自由排布 */}
      {widgets.map((widget) => {
        if (groupedMode) return null; // 分组视图仅展示 Agent 分组
        const def = getWidgetDef(widget.kind);
        if (!def) return null;
        // 广义 Tile：widget 也可成组 → 渲染位置 = 所属带（用户组/未分组带）的局部网格
        const band = bandById[bandOf[widget.id]] ?? null;
        const bandX = band?.x ?? 0;
        const sourceGrid = band?.gridMap[widget.id] ?? widget.grid;
        const geometry = metrics
          ? gridToPixels((displaced[widget.id] ?? sourceGrid), metrics, bandX)
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
        // widget 与 agent 一样参与拖拽成组/排斥（hover 状态机；未分组落位走 widgetStore）
        const widgetTileCommit = (next: TileGrid) => {
          const h = dragHoverRef.current;
          if (h.activated && h.sourceAgentId === widget.id) {
            const target = h.targetAgentId;
            if (target) {
              const tBand = h.targetGroupId ? bandById[h.targetGroupId] : null;
              const tGrid = tBand?.gridMap[target];
              const col = tGrid?.col ?? 0;
              const row = tGrid?.row ?? GRID_START_ROW;
              const w = tGrid?.w ?? next.w;
              const th = tGrid?.h ?? next.h;
              const sameUserGroup = h.targetGroupId && h.targetGroupId === h.sourceGroupId && h.targetGroupId !== UNGROUPED_BAND_ID;
              if (h.mode === "repel" || sameUserGroup) {
                if (h.targetGroupId && h.targetGroupId !== UNGROUPED_BAND_ID) {
                  repelDropIntoGroup(widget.id, h.targetGroupId, col, row, w, th);
                } else {
                  repelDropToUngrouped(widget.id, col, row, w, th);
                }
              } else if (h.targetGroupId === UNGROUPED_BAND_ID && h.sourceGroupId === UNGROUPED_BAND_ID) {
                createGroup([widget.id, target]);
              } else if (h.targetGroupId === UNGROUPED_BAND_ID) {
                repelDropToUngrouped(widget.id, col, row, w, th);
              } else if (h.targetGroupId) {
                joinGroup(widget.id, h.targetGroupId);
              }
            } else if (h.targetGroupId && h.targetGroupId !== UNGROUPED_BAND_ID) {
              joinGroup(widget.id, h.targetGroupId);
            }
            clearDragHover();
            return;
          }
          clearDragHover();
          const m = useAgentsStore.getState().groupMembers[widget.id];
          if (m) moveGroupMember(widget.id, next.col, next.row, next.w, next.h);
          else commitWidget(widget.id, next);
        };
        return (
          <TileShell
            key={widget.id}
            id={widget.id}
            geometry={geometry}
            grid={sourceGrid}
            gridMap={band?.gridMap}
            metrics={metrics ?? undefined}
            bounds={bounds}
            mode="free"
            zIndex={1}
            disableResize={def.fixedSize}
            displacedPreview={!!displaced[widget.id]}
            bandX={bandX}
            gridClamp={
              band && !band.isSystem
                ? {
                    minCol: 0,
                    maxCol: Math.max(0, band.maxCol),
                    minRow: GRID_START_ROW,
                    maxRow: GRID_ROWS - 1,
                  }
                : undefined
            }
            contextMenuItems={widgetMenuItems}
            onMove={(next) => {
              const m = useAgentsStore.getState().groupMembers[widget.id];
              if (m) moveGroupMember(widget.id, next.col, next.row, next.w, next.h);
              else moveWidget(widget.id, next);
            }}
            onCommit={widgetTileCommit}
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

      {/* D：归档横幅——防止用户以为会话丢了 */}
      {!openMode && archivedTotal > 0 ? (
        <button type="button" className="wall-footer-banner" onClick={() => setArchiveOpen(true)}>
          另有 {archivedTotal} 个归档会话 — 点击查看
        </button>
      ) : null}

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