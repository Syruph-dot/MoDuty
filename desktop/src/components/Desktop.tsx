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
import { AnimationProvider, useTileAnimation } from "./desktop/AnimationProvider";
import { awaitApiBase } from "../lib/api";
import { computeBands, UNGROUPED_BAND_ID, SYSTEM_BAND_ID, type Band } from "../lib/bandLayout";
import { computeOpenLayout, isBoundsReady } from "../lib/layoutEngine";
import { computeMetrics, gridToPixels } from "../lib/gridLayout";
import { startAgentEventStream, type AgentEventStreamControl } from "../lib/sseClient";
import { startBrowserEventStream } from "../lib/browserEvents";
import { useAgentsStore, useVisibleAgents } from "../state/agentsStore";
import { useBrowserStore } from "../state/browserStore";
import { useTileStore } from "../state/tileStore";
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
/**
 * 全屏设置关闭后：重播整墙进入动画（从设置返回初始页时磁贴重新向右滑入放大淡入）。
 * 必须在 AnimationProvider 内渲染。useLayoutEffect 保证与墙 class 移除同帧生效，避免闪烁。
 */
function WallEnterReplay() {
  const { replayEnter } = useTileAnimation();
  const settingsOpen = useDialogStore((state) => state.settingsOpen);
  const prevOpen = useRef(settingsOpen);
  useLayoutEffect(() => {
    if (prevOpen.current && !settingsOpen) {
      // 设置页刚关闭：重播入场
      replayEnter();
    }
    prevOpen.current = settingsOpen;
  }, [settingsOpen, replayEnter]);
  return null;
}

export default function Desktop({ onOpen }: { onOpen: (agent: Agent) => void }) {
  const agents = useAgentsStore((state) => state.agents);
  const openAgentIds = useAgentsStore((state) => state.openAgentIds);
  const loading = useAgentsStore((state) => state.loading);
  const error = useAgentsStore((state) => state.error);
  const load = useAgentsStore((state) => state.load);
  const applyAgentEvent = useAgentsStore((state) => state.applyAgentEvent);
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

  // 磁贴几何/组属/组操作：统一 tileStore（单一事实源；agent/widget/browser 同一路径）
  const tiles = useTileStore((state) => state.tiles);
  const groups = useTileStore((state) => state.groups);
  const hydrateTiles = useTileStore((state) => state.hydrate);
  const createGroup = useTileStore((state) => state.createGroup);
  const joinGroup = useTileStore((state) => state.joinGroup);
  const leaveGroup = useTileStore((state) => state.leaveGroup);
  const repelDropIntoGroup = useTileStore((state) => state.repelDropIntoGroup);
  const repelDropToUngrouped = useTileStore((state) => state.repelDropToUngrouped);
  const renameGroup = useTileStore((state) => state.renameGroup);
  const reorderGroups = useTileStore((state) => state.reorderGroups);
  const commitDisplacedV3 = useTileStore((state) => state.commitDisplaced);

  // widget 磁贴状态（仅实例列表；几何在 tileStore）
  const widgets = useWidgetStore((state) => state.widgets);
  const displaced = useGhostStore((state) => state.displaced);
  const hydrateWidgets = useWidgetStore((state) => state.hydrate);
  const removeWidget = useWidgetStore((state) => state.removeWidget);

  // 受控浏览器磁贴（独立于 Agent 的实体）
  const browsers = useBrowserStore((state) => state.browsers);
  const openBrowserIds = useBrowserStore((state) => state.openBrowserIds);
  const hydrateBrowser = useBrowserStore((state) => state.hydrate);
  const createBrowser = useBrowserStore((state) => state.createBrowser);
  const deleteBrowser = useBrowserStore((state) => state.deleteBrowser);
  const openBrowser = useBrowserStore((state) => state.openBrowser);
  const closeBrowser = useBrowserStore((state) => state.closeBrowser);
  const applyBrowserEvent = useBrowserStore((state) => state.applyBrowserEvent);

  /** 把“被排斥（让位）磁贴”一键定格到预览位置（单一事实源，无类型路由） */
  const commitDisplacedTiles = useCallback(
    (map: Record<string, TileGrid>) => {
      commitDisplacedV3(map);
    },
    [commitDisplacedV3],
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
  const settingsOpen = useDialogStore((state) => state.settingsOpen);
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
  /** T1：打开卡片的世界 X（右舞台自由草稿坐标；首次打开时回退到该磁贴自由网格 X 并在此记录） */
  const [openWorldX, setOpenWorldX] = useState<Record<string, number>>({});

  // 墙可见集合（A 筛选 + D 活跃/归档派生）；grouped 与 free 共享同一口径
  const wallIds = useMemo(() => new Set(wallAgents.map((agent) => agent.id)), [wallAgents]);

  // 稳定回调（配合 AgentTile memo）：提交时从 dialogStore 读取当前重命名目标，避免 per-tile 闭包
  const handleRenameCommit = useCallback(
    (name: string) => {
      const id = useDialogStore.getState().renameTarget;
      if (!id) return;
      // 成功才退出内联编辑；失败保持编辑态，错误已写入 store.error（桌面顶部展示）
      void renameAgent(id, name)
        .then(() => closeRename())
        .catch(() => undefined);
    },
    [renameAgent, closeRename],
  );

  /** Agent 磁贴右键菜单（A/B/D）：钉住 / 归档 / 重命名 / 删除 */
  const buildAgentMenu = useCallback(
    (agent: Agent): ContextMenuItem[] => {
      const pinned = pinnedIds.includes(agent.id);
      const manualArchived = useAgentsStore.getState().archivedIds.includes(agent.id);
      const tileOfAgent = useTileStore.getState().tiles[agent.id];
      const inGroup = !!tileOfAgent && tileOfAgent.groupId !== UNGROUPED_BAND_ID && tileOfAgent.groupId !== SYSTEM_BAND_ID;
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

  // 橡皮筋越界（Android 式）：
  // - 内容层（.tile-wall__content）在停靠点之外由 overscrollRef 驱动 translateX 真实位移
  // - raw = 越过停靠点的“拖动/滚轮量”，经指数阻尼换算成有限位移 d（→ MAX_OVERSCROLL_PX）
  // - 松手 / 滚轮停顿后 rAF 把 raw 衰减回 0（内容平滑弹回停靠点）
  const overscrollRef = useRef<{ raw: number; side: -1 | 0 | 1; raf: number; wheelTimer: number | null }>({
    raw: 0,
    side: 0,
    raf: 0,
    wheelTimer: null,
  });
  const contentRef = useRef<HTMLDivElement | null>(null);
  const leftArcRef = useRef<HTMLDivElement | null>(null);
  const rightArcRef = useRef<HTMLDivElement | null>(null);

  // 常量
  const EDGE_RATIO = 0.2; // 停靠点留白 = 1/5 屏宽（磁贴阵列首/尾距屏幕边缘的空档）
  const MAX_OVERSCROLL_PX = 150; // 越界最大位移 px（指数阻尼渐近线）
  const MAX_RAW_PX = 4000; // 越界原始量上限（数值保护，位移仍被阻尼在 MAX_OVERSCROLL_PX）
  const SPRING_BACK_DURATION = 340; // 弹回动画时长 ms
  const WHEEL_RELEASE_DELAY = 160; // 滚轮停顿多久后自动弹回 ms

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
        hydrateTiles(); // 单一事实源先行：几何/组属迁移 + 还原，再供各实体 store 对账
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
  }, [load, applyAgentEvent, hydrateTiles, hydrateWidgets, hydrateBrowser, applyBrowserEvent]);

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
  // 所有 tile（agent/widget/browser）几何与组属统一来自 tileStore；bandLayout 纯派生。
  // 可见性：agent 受墙治理筛选（wallIds），widget/browser 恒可见
  // 额外做一次坐标平移：内容左右各留 1/5 屏宽“停靠留白”（stopMargin），使磁贴阵列首/尾
  // 在自然停靠（scrollLeft=0 / maxScroll）时距屏幕边缘正好约 1/5 屏宽，而不是铺满。
  const bandLayout = useMemo(() => {
    if (!metrics) return null;
    const raw = computeBands({
      tiles,
      groups,
      metrics,
      isVisible: (id) => {
        const tile = tiles[id];
        return tile ? tile.kind !== "agent" || wallIds.has(id) : true;
      },
    });
    const m = Math.round(bounds.width * EDGE_RATIO);
    if (m <= 0) return raw;
    return {
      ...raw,
      contentWidth: raw.contentWidth + m * 2,
      bands: raw.bands.map((b) => ({ ...b, x: b.x + m })),
    };
  }, [metrics, tiles, groups, wallIds, bounds.width]);
  const bands = bandLayout?.bands ?? [];
  const bandOf = bandLayout?.bandOf ?? {};
  const bandById = useMemo(() => {
    const m: Record<string, Band> = {};
    for (const b of bands) m[b.id] = b;
    return m;
  }, [bands]);

  // T1：打开卡片首次落位 → 世界 X 取该磁贴自由网格 X（gridToPixels）；此后由拖拽/打开列表驱动，不做田字格重排
  useEffect(() => {
    if (!openMode || openAgentIds.length === 0) return;
    const missing = openAgentIds.filter((id) => !Number.isFinite(openWorldX[id]));
    if (missing.length === 0) return;
    const next = { ...openWorldX };
    for (const id of missing) {
      const band = bandById[bandOf[id]] ?? null;
      const sourceGrid = band?.gridMap[id] ?? null;
      if (metrics && sourceGrid) {
        next[id] = gridToPixels(sourceGrid, metrics, band?.x ?? 0).x;
      } else {
        next[id] = 0;
      }
    }
    setOpenWorldX(next);
  }, [openMode, openAgentIds, openWorldX, metrics, bandById, bandOf]);

  // ---- 拖拽成组：hover 计时状态机（ref 驱动）----
  //  仅当 hover 到另一个磁贴（非组名、非空网格）时启动计时：
  //  0～500ms  计时（目标磁贴亮起中）
  //  500～1000ms  成组就绪（--drop 蓝亮，松手 = 建组/移组）
  //  >1000ms      排斥就绪（--repel 橙亮，松手 = 排斥落位，目标带内让位 → 最终无重叠）
  //  hover 到组名或空网格时：不启动计时，仅记录目标带（供跨组移动）
  const dragHoverRef = useRef<{
    sourceAgentId: string | null;
    sourceGroupId: string | null;
    targetGroupId: string | null;
    targetAgentId: string | null;
    activated: boolean;
    mode: "group" | "repel";
    timer: number | null;
    guard: number;
    /** 空网格跨组移动：指针所在目标带 + 带内局部网格（不激活 hover，仅供落位） */
    targetGrid: TileGrid | null;
  }>({ sourceAgentId: null, sourceGroupId: null, targetGroupId: null, targetAgentId: null, activated: false, mode: "group", timer: null, guard: 0, targetGrid: null });
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
    h.targetGrid = null;
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
        // 空网格：带区域命中 → 跨组移动到该带（记录目标带 + 带内局部网格，不激活 hover）
        const el = wallRef.current;
        const bandAt =
          metrics && el
            ? (() => {
                const rect = el.getBoundingClientRect();
                const x = clientX - rect.left - metrics.padding + el.scrollLeft;
                let bestId: string | null = null;
                let bestDist = Infinity;
                for (const b of bands) {
                  const dist = x < b.x ? b.x - x : x > b.x + b.width ? x - (b.x + b.width) : 0;
                  if (dist < bestDist) {
                    bestDist = dist;
                    bestId = b.id;
                  }
                }
                return bestId;
              })()
            : null;
        if (bandAt && bandAt !== h.sourceGroupId && bandAt !== SYSTEM_BAND_ID) {
          // 先清除占用计时（空网格不启动 hover 判定）
          if (h.timer !== null) window.clearTimeout(h.timer);
          h.timer = null;
          h.activated = false;
          document.querySelectorAll(".tile-group-name--drop,.tile-shell--drop,.tile-group-name--repel,.tile-shell--repel").forEach((el) => {
            el.classList.remove("tile-group-name--drop", "tile-shell--drop", "tile-group-name--repel", "tile-shell--repel");
          });
          const band = bandById[bandAt] ?? null;
          const step = metrics ? metrics.cellW + metrics.gap : 0;
          const rect = el!.getBoundingClientRect();
          const x = clientX - rect.left - metrics!.padding + el!.scrollLeft;
          const y = clientY - rect.top - metrics!.padding;
          h.targetGroupId = bandAt;
          h.targetAgentId = null;
          h.activated = false;
          h.targetGrid =
            band && metrics
              ? {
                  col: Math.max(0, Math.round((x - band.x - step / 2) / step)),
                  row: Math.max(GRID_START_ROW, Math.min(Math.round((y - (metrics.cellH + metrics.gap) / 2) / (metrics.cellH + metrics.gap)), metrics.rows - 1)),
                  w: 1,
                  h: 1,
                }
              : null;
          return;
        }
        clearDragHover();
        return;
      }
      if (targetGroupId === SYSTEM_BAND_ID) {
        clearDragHover();
        return;
      }
      // 仅当 hover 到另一个磁贴时启动计时（hover 到组名不启动计时，仅记录目标组）
      if (!targetAgentId) {
        // hover 到组名：记录目标组但不启动计时
        if (h.targetGroupId !== targetGroupId || h.targetAgentId !== targetAgentId) {
          h.targetGroupId = targetGroupId;
          h.targetAgentId = null;
          h.activated = false;
          h.mode = "group";
        }
        // 清除已有高亮
        document.querySelectorAll(".tile-group-name--drop,.tile-group-name--repel,.tile-shell--drop,.tile-shell--repel").forEach((el) => {
          el.classList.remove("tile-group-name--drop", "tile-shell--drop", "tile-group-name--repel", "tile-shell--repel");
        });
        // 组名高亮（轻微提示，不需要计时）
        if (h.timer !== null) window.clearTimeout(h.timer);
        h.timer = null;
        if (targetGroupId) {
          document.querySelector(`[data-group-name="${targetGroupId}"]`)?.classList.add("tile-group-name--drop");
        }
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
    if (openMode || groupedMode || !metrics) return "100%";
    const w = bandLayout?.contentWidth ?? 0;
    return `${Math.max(w, 1)}px`;
  }, [openMode, groupedMode, metrics, bandLayout]);

  // 把 overscrollRef 的 raw/side 画到内容层与左右弧上
  const paintOverscroll = useCallback(() => {
    const layer = contentRef.current;
    const o = overscrollRef.current;
    if (!layer) {
      o.raw = 0;
      o.side = 0;
      return;
    }
    if (o.side === 0 || o.raw <= 0.01) {
      layer.style.transform = "";
      if (leftArcRef.current) leftArcRef.current.style.opacity = "0";
      if (rightArcRef.current) rightArcRef.current.style.opacity = "0";
      return;
    }
    // 指数阻尼：raw 越大阻力越大，位移趋近 MAX_OVERSCROLL_PX（Android 橡皮筋手感）
    const d = MAX_OVERSCROLL_PX * (1 - Math.exp(-o.raw / MAX_OVERSCROLL_PX));
    const t = Math.max(0, Math.min(1, d / MAX_OVERSCROLL_PX)).toFixed(3);
    layer.style.transform = `translateX(${(o.side === -1 ? d : -d).toFixed(2)}px)`;
    if (o.side === -1) {
      if (leftArcRef.current) leftArcRef.current.style.opacity = t;
      if (rightArcRef.current) rightArcRef.current.style.opacity = "0";
    } else {
      if (leftArcRef.current) leftArcRef.current.style.opacity = "0";
      if (rightArcRef.current) rightArcRef.current.style.opacity = t;
    }
  }, []);

  // 清除越界：transform/弧归零，取消回弹动画与滚轮计时器
  const clearOverscroll = useCallback(() => {
    const o = overscrollRef.current;
    if (o.wheelTimer !== null) {
      window.clearTimeout(o.wheelTimer);
      o.wheelTimer = null;
    }
    if (o.raf) {
      window.cancelAnimationFrame(o.raf);
      o.raf = 0;
    }
    o.raw = 0;
    o.side = 0;
    paintOverscroll();
  }, [paintOverscroll]);

  // 松手 / 停顿：把 raw 平滑衰减到 0（内容从越界处弹回停靠点）
  const releaseOverscroll = useCallback(() => {
    const o = overscrollRef.current;
    if (o.side === 0 || o.raw <= 0.01) {
      clearOverscroll();
      return;
    }
    if (o.wheelTimer !== null) {
      window.clearTimeout(o.wheelTimer);
      o.wheelTimer = null;
    }
    if (o.raf) window.cancelAnimationFrame(o.raf);
    const startRaw = o.raw;
    const start = performance.now();
    const step = (now: number) => {
      const p = Math.min(1, (now - start) / SPRING_BACK_DURATION);
      const eased = 1 - Math.pow(1 - p, 3); // easeOutCubic：先快后慢
      if (p < 1) {
        o.raw = startRaw * (1 - eased);
        paintOverscroll();
        o.raf = requestAnimationFrame(step);
      } else {
        clearOverscroll();
      }
    };
    o.raf = requestAnimationFrame(step);
  }, [paintOverscroll, clearOverscroll]);

  // 设一次越界状态（拖动画布路径用）
  const setOverscroll = useCallback(
    (side: -1 | 1, raw: number) => {
      const o = overscrollRef.current;
      o.side = side;
      o.raw = Math.max(0, Math.min(raw, MAX_RAW_PX));
      paintOverscroll();
    },
    [paintOverscroll],
  );

  // 滚轮越界累加：连续滚动持续拉出，停顿 WHEEL_RELEASE_DELAY 后自动弹回
  const bumpOverscroll = useCallback(
    (side: -1 | 1, amount: number) => {
      const o = overscrollRef.current;
      o.side = side;
      o.raw = Math.max(0, Math.min(o.raw + Math.max(0, amount), MAX_RAW_PX));
      paintOverscroll();
      if (o.wheelTimer !== null) window.clearTimeout(o.wheelTimer);
      o.wheelTimer = window.setTimeout(() => {
        o.wheelTimer = null;
        releaseOverscroll();
      }, WHEEL_RELEASE_DELAY);
    },
    [paintOverscroll, releaseOverscroll],
  );

  // 滚轮：上=左、下=右 水平滑动；Ctrl+滚轮 → 缩放（仅 free 模式；open 模式不拦截窗口滚动）
  // 范围内自由滚动；贴住停靠点（scrollLeft=0 / maxScroll）后继续往外的量转为橡皮筋越界
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
      if (openMode) return;
      event.preventDefault();
      const delta = event.deltaY;
      const maxScroll = el.scrollWidth - el.clientWidth;
      const cur = el.scrollLeft;
      if (delta < 0) {
        // 向左（回起点）：已贴住起点 → 转左越界；跨过起点 → 余量也进越界
        if (cur <= 0) {
          bumpOverscroll(-1, -delta);
          return;
        }
        const next = cur + delta;
        if (next < 0) {
          el.scrollLeft = 0;
          bumpOverscroll(-1, -next);
          return;
        }
        clearOverscroll();
        el.scrollLeft = next;
      } else if (delta > 0) {
        // 向右（往终点）
        if (cur >= maxScroll) {
          bumpOverscroll(1, delta);
          return;
        }
        const next = cur + delta;
        if (next > maxScroll) {
          el.scrollLeft = maxScroll;
          bumpOverscroll(1, next - maxScroll);
          return;
        }
        clearOverscroll();
        el.scrollLeft = next;
      }
    };
    el.addEventListener("wheel", onWheel, { passive: false });
    return () => {
      el.removeEventListener("wheel", onWheel);
      clearOverscroll();
    };
  }, [openMode, zoomIn, zoomOut, bumpOverscroll, clearOverscroll]);

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
      clearOverscroll(); // 清除可能残留的滚轮越界/回弹动画
      startX = event.clientX;
      startScroll = el.scrollLeft;
      el.classList.add("tile-wall--panning");
      document.body.style.cursor = "grabbing";
      document.body.style.userSelect = "none";
    };
    const onMove = (event: MouseEvent) => {
      if (!panning) return;
      const rawScroll = startScroll - (event.clientX - startX);
      const maxScroll = el.scrollWidth - el.clientWidth;
      // 越过停靠点：scrollLeft 已夹死，余量转成内容层橡皮筋位移
      if (rawScroll < 0) {
        el.scrollLeft = 0;
        setOverscroll(-1, -rawScroll);
        return;
      }
      if (rawScroll > maxScroll) {
        el.scrollLeft = maxScroll;
        setOverscroll(1, rawScroll - maxScroll);
        return;
      }
      // 回到范围内：直接跟随，同时清掉残留越界
      clearOverscroll();
      el.scrollLeft = rawScroll;
    };
    const onUp = () => {
      if (!panning) return;
      panning = false;
      el.classList.remove("tile-wall--panning");
      document.body.style.cursor = "";
      document.body.style.userSelect = "";
      // 松手：在越界中 → 平滑弹回停靠点；否则清残留
      if (overscrollRef.current.side !== 0 && overscrollRef.current.raw > 0.01) {
        releaseOverscroll();
      } else {
        clearOverscroll();
      }
    };
    el.addEventListener("mousedown", onDown);
    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp);
    return () => {
      el.removeEventListener("mousedown", onDown);
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("mouseup", onUp);
      clearOverscroll();
    };
  }, [openMode, wallRef, setOverscroll, clearOverscroll, releaseOverscroll]);

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
      // 根据鼠标 X 位置推断落在哪个组带（仅 free 模式下的用户组）
      let contextGroupId: string | undefined;
      if (!openMode && !groupedMode && bandLayout && wallRect && metrics) {
        const scrollLeft = wallRef.current?.scrollLeft ?? 0;
        const contentX = event.clientX - wallRect.left + scrollLeft;
        for (const band of bandLayout.bands) {
          if (band.editable && contentX >= band.x + metrics.padding && contentX <= band.x + metrics.padding + band.width) {
            contextGroupId = band.id;
            break;
          }
        }
      }
      const items: ContextMenuItem[] = [
        {
          id: "new-agent",
          label: "New Agent",
          onClick: () => {
            openNewAgent(spawn, contextGroupId);
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
          label: "New Browser",
          onClick: () => {
            void createBrowser({ mode: "persistent" }).then((browser) => {
              if (browser) openBrowser(browser.id);
            });
          },
        },
        {
          id: "new-browser-incognito",
          label: "New Browser(incognito)",
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

  // ---- 广义 Tile 统一拖放：所有类型（agent/widget/browser）唯一写路径 = tileStore ----
  const handleTileMove = useCallback((id: string, next: TileGrid) => {
    useTileStore.getState().moveTile(id, next);
  }, []);
  const handleTileDrop = useCallback(
    (id: string, next: TileGrid) => {
      const h = dragHoverRef.current;
      // 预览即落盘：排斥/让位的 displaced 结果直接作为最终布局（与动中预览同一算法）
      const previewDisplaced = useGhostStore.getState().displaced;
      // hover 就绪（占用 Tile 判定）→ 成组/移组/排斥
      if (h.activated && h.sourceAgentId === id) {
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
              repelDropIntoGroup(id, h.targetGroupId, col, row, w, th, previewDisplaced);
            } else {
              repelDropToUngrouped(id, col, row, w, th, previewDisplaced);
            }
          } else if (h.targetGroupId === UNGROUPED_BAND_ID && h.sourceGroupId === UNGROUPED_BAND_ID) {
            createGroup([id, target]);
          } else if (h.targetGroupId === UNGROUPED_BAND_ID) {
            repelDropToUngrouped(id, col, row, w, th, previewDisplaced);
          } else if (h.targetGroupId) {
            joinGroup(id, h.targetGroupId);
          }
        } else if (h.targetGroupId && h.targetGroupId !== UNGROUPED_BAND_ID) {
          joinGroup(id, h.targetGroupId);
        }
        clearDragHover();
        return;
      }
      // 空网格跨组移动：目标带 ≠ 源带 → 直接移入目标带（进入组/回未分组），不必拖到磁贴上
      if (h.targetGroupId && h.targetGroupId !== bandOf[id]) {
        const g = h.targetGrid ?? next;
        if (h.targetGroupId !== UNGROUPED_BAND_ID) {
          repelDropIntoGroup(id, h.targetGroupId, g.col, g.row, next.w, next.h, previewDisplaced);
        } else {
          repelDropToUngrouped(id, g.col, g.row, next.w, next.h, previewDisplaced);
        }
        clearDragHover();
        return;
      }
      clearDragHover();
      // 普通移动：统一落盘（类型无关）
      useTileStore.getState().commitTile(id, next);
    },
    [bandById, bandOf, clearDragHover, createGroup, joinGroup, repelDropIntoGroup, repelDropToUngrouped],
  );

  return (
    <div className={`tile-wall${openMode ? " tile-wall--open" : ""}${settingsOpen ? " tile-wall--settings-leaving" : ""}`} ref={wallRef} onContextMenu={onContextMenu}>
      {/* 橡皮筋越界弧：仅 free 模式；透明度由 overscrollRef 实时驱动（无发光边缘）
          凸向朝屏幕内侧：左弧向右凸、右弧向左凸（对称于越界露出的内容边缘） */}
      {!openMode && !groupedMode ? (
        <>
          <div
            ref={leftArcRef}
            className="tile-wall__tension-arc tile-wall__tension-arc--left"
            style={{ opacity: 0 }}
            aria-hidden="true"
          >
            <svg viewBox="0 0 60 100" preserveAspectRatio="none" style={{ width: 60, height: "100%" }}>
              <path
                d="M0,0 Q60,50 0,100"
                stroke="currentColor"
                strokeWidth="3"
                fill="none"
                strokeLinecap="round"
              />
            </svg>
          </div>
          <div
            ref={rightArcRef}
            className="tile-wall__tension-arc tile-wall__tension-arc--right"
            style={{ opacity: 0 }}
            aria-hidden="true"
          >
            <svg viewBox="0 0 60 100" preserveAspectRatio="none" style={{ width: 60, height: "100%" }}>
              <path
                d="M60,0 Q0,50 60,100"
                stroke="currentColor"
                strokeWidth="3"
                fill="none"
                strokeLinecap="round"
              />
            </svg>
          </div>
        </>
      ) : null}
      {error ? <p className="tile-wall__error" role="alert">{error}</p> : null}

      {loading && agents.length === 0 ? (
        <p className="tile-wall__hint" role="status" aria-busy="true">
          Loading agents…
        </p>
      ) : null}

      {/* free 模式内容层见下方 .tile-wall__content（同时承担撑宽 + 橡皮筋位移） */}
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

      {/* ---- 内容层 .tile-wall__content：滚动内容 + 橡皮筋位移载体（越界时整体 translateX） ---- */}
      <div ref={contentRef} className="tile-wall__content" style={{ width: contentWidth, height: "100%" }}>
      {/* 拖拽成组：组名层（组带顶部保留行左对齐，Segoe UI Light；用户组双击可编辑） */}
      {!openMode && !groupedMode && bandLayout && metrics
        ? bandLayout.bands.map((band) => (
            <div
              key={band.id}
              data-group-name={band.id}
              className={`tile-group-name${renamingGroupId === band.id ? " tile-group-name--editing" : ""}${reorderSource === band.id ? " tile-group-name--dragging" : ""}`}
              style={{ left: metrics.padding + band.x, top: metrics.padding + metrics.cellH - 30, width: band.width }}
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
              <button
                type="button"
                className="tile-group-name__add"
                title="在该组创建 Agent"
                aria-label="在该组创建 Agent"
                onClick={(e) => {
                  e.stopPropagation();
                  openNewAgent(undefined, band.id);
                }}
              >
                +
              </button>
            </div>
          ))
        : null}

      {/* ---- 广义 Tile 统一拖放：agent / widget 完全同一路径（不特殊化到 session） ---- */}
      <AnimationProvider bounds={bounds}>
        <WallEnterReplay />
        {agents.map((agent) => {
        // 分组视图：Agent 磁贴由 GroupedWall 统一渲染（非自由网格）
        if (groupedMode) return null;
        const isOpen = openAgentIds.includes(agent.id);
        const inDock = openMode && !isOpen && relatedSet.has(agent.id);
        const canvasGhost = openMode && !isOpen && !relatedSet.has(agent.id);
        // 墙治理（A+D）：空闲态只渲染墙内可见；打开态的画布弱化层同样只显示墙内可见（归档/筛选外不显示）
        if (!openMode && !wallIds.has(agent.id)) return null;
        if (openMode && canvasGhost && !wallIds.has(agent.id)) return null;
        // 双几何：打开态 → 打开卡使用“世界 X + 右舞台尺寸”（T1，不再田字格强排）／dock 仍走布局引擎；
        //         空闲态 → band 局部网格派生像素（灰框让位时用 displaced 覆盖）
        const displacedGrid = displaced[agent.id];
        const band = bandById[bandOf[agent.id]] ?? null;
        const sourceGrid = band?.gridMap[agent.id] ?? null;
        const bandX = band?.x ?? 0;
        const geometry =
          openMode && layout && (isOpen || inDock)
            ? isOpen
              ? {
                  x: Number.isFinite(openWorldX[agent.id]) ? openWorldX[agent.id] : 0,
                  y: layout.stage.y,
                  w: layout.stage.w,
                  h: layout.stage.h,
                }
              : layout.geometryOf[agent.id] ?? EMPTY_TILE
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
        // 广义 Tile 统一拖放（agent 与 widget 同路径，见 handleTileMove / handleTileDrop）
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
            onMove={(next) => handleTileMove(agent.id, next)}
            onCommit={(next) => handleTileDrop(agent.id, next)}
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
              onRenameCommit={handleRenameCommit}
              onRenameCancel={closeRename}
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
        // 几何唯一事实源：tileStore → bandLayout 系统带 gridMap
        const browserGrid = systemBand?.gridMap[browser.id] ?? null;
        const geometry =
          openMode && layout
            ? layout.geometryOf[browser.id] ?? EMPTY_TILE
            : metrics && browserGrid
              ? gridToPixels(displacedGrid ?? browserGrid, metrics, systemBandX)
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
            grid={!openMode ? browserGrid ?? undefined : undefined}
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
            onMove={(next) => handleTileMove(browser.id, next)}
            onCommit={(next) => handleTileDrop(browser.id, next)}
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
        // 统一事实源：所属带（用户组/未分组带）的局部网格；widget 入 hydration 后必有 tile，无 1×1 fallback
        const band = bandById[bandOf[widget.id]] ?? null;
        const bandX = band?.x ?? 0;
        const sourceGrid = band?.gridMap[widget.id] ?? null;
        if (!sourceGrid) return null; // 无磁贴记录 = 数据未就绪，不渲染（不再画 1×1 假位）
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
            onMove={(next) => handleTileMove(widget.id, next)}
            onCommit={(next) => handleTileDrop(widget.id, next)}
            onCommitDisplaced={commitDisplacedTiles}
          >
            <div className="widget-tile">
              <div className="widget-tile__title">{title}</div>
              <div className="widget-tile__body">{def.renderBody()}</div>
            </div>
          </TileShell>
        );
      })}
      </AnimationProvider>

      {/* 拖动中的量化灰色提示框（Win8 ghost） */}
      <GhostPreview />
      </div>

      {/* 对齐辅助线覆盖层（expanded 拖动中可见） */}
      <SnapGuidesOverlay guides={snapGuides} wallRef={wallRef} />

      {/* D：归档横幅——防止用户以为会话丢了 */}
      {!openMode && archivedTotal > 0 ? (
        <button type="button" className="wall-footer-banner" onClick={() => setArchiveOpen(true)}>
          另有 {archivedTotal} 个归档会话 — 点击查看
        </button>
      ) : null}

      {/* Win8 左右栏：右缘 45px 模态切换 + 左缘 240px hover 滑出分类卡片
          全屏设置页打开时停用左栏（其左缘热区会干扰设置页左侧导航），右栏保留 */}
      <RightCharm />
      {!settingsOpen ? <LeftSidePanel /> : null}
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