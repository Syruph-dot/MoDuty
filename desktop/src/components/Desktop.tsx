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
import { computeBands, resolveDropIntent, UNGROUPED_BAND_ID, type Band, type DropIntent } from "../lib/bandLayout";
import { computeOpenLayout, isBoundsReady } from "../lib/layoutEngine";
import { computeMetrics, displaceTiles, gridToPixels } from "../lib/gridLayout";
import { startAgentEventStream, type AgentEventStreamControl } from "../lib/sseClient";
import { emitDutyEvent } from "../lib/dutyEvents";
import { useAgentAlerts } from "../hooks/useAgentAlerts";
import VerdictToasts from "./VerdictToasts";
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
  // 整页视图（设置页 / 值日生页）占屏时磁贴墙先退场，返回桌面时重播入场
  const settingsOpen = useDialogStore((state) => state.settingsOpen);
  const dutyPageOpen = useDialogStore((state) => state.dutyOpen);
  const pageOpen = settingsOpen || dutyPageOpen;
  const prevOpen = useRef(pageOpen);
  useLayoutEffect(() => {
    if (prevOpen.current && !pageOpen) {
      // 整页视图刚关闭：重播入场
      replayEnter();
    }
    prevOpen.current = pageOpen;
  }, [pageOpen, replayEnter]);
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
  const leaveGroup = useTileStore((state) => state.leaveGroup);
  const renameGroup = useTileStore((state) => state.renameGroup);
  const reorderGroups = useTileStore((state) => state.reorderGroups);

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
  const dutyPageOpen = useDialogStore((state) => state.dutyOpen);
  /** 整页视图（设置 / 值日生页）占屏：磁贴墙退场、左栏不显示 */
  const pageOpen = settingsOpen || dutyPageOpen;
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
  /** Y 错位：默认锁 Y（top=stage.y）；拖拽突破阈值后写入，右键归位清空 */
  const [openWorldY, setOpenWorldY] = useState<Record<string, number>>({});
  const resetOpenWorldY = useCallback(() => setOpenWorldY({}), []);
  const commitOpenWorldY = useCallback((id: string, y: number) => {
    setOpenWorldY((prev) => ({ ...prev, [id]: Math.round(y) }));
  }, []);
  /** T2：内容层当前横向滚动量（open 模式 dock 视口补偿用） */
  const [wallScrollX, setWallScrollX] = useState(0);
  /** T4：打开卡片 z 层级序（后位 = 顶层；点击激活置顶） */
  const [openZOrder, setOpenZOrder] = useState<string[]>([]);
  const raiseAgent = useCallback((id: string) => {
    setOpenZOrder((prev) => {
      const rest = prev.filter((x) => x !== id);
      if (rest.length === prev.length && prev[prev.length - 1] === id) return prev;
      return [...rest, id];
    });
  }, []);
  const commitOpenWorldX = useCallback((id: string, x: number) => {
    setOpenWorldX((prev) => ({ ...prev, [id]: Math.round(x) }));
  }, []);
  const zRankOf = (id: string): number => {
    const pos = openZOrder.indexOf(id);
    if (pos >= 0) return pos + 1;
    const idx = openAgentIds.indexOf(id);
    return idx >= 0 ? idx + 1 : 0;
  };

  // 墙可见集合（A 筛选 + D 活跃/归档派生）；grouped 与 free 共享同一口径
  const wallIds = useMemo(() => new Set(wallAgents.map((agent) => agent.id)), [wallAgents]);

  /**
   * 最近访问时间（epoch ms）：agent 用后端 last_active_at，browser 用 lastActiveAt。
   * 未分组带的自动排位用它（时间越大越近）；查不到的一律 0（排到最后）。
   */
  const visitTimes = useMemo(() => {
    const map: Record<string, number> = {};
    for (const agent of agents) map[agent.id] = Date.parse(agent.last_active_at) || 0;
    for (const browser of browsers) map[browser.id] = Date.parse(browser.lastActiveAt) || 0;
    return map;
  }, [agents, browsers]);
  const visitTimeOf = useCallback((id: string) => visitTimes[id] ?? 0, [visitTimes]);

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
      const inGroup = !!tileOfAgent && tileOfAgent.groupId !== UNGROUPED_BAND_ID;
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
          : [
              {
                // 拖动不再承担“建组”（灰框落在哪条带就归哪条带）→ 建组显式给出入口
                id: "new-group",
                label: "移入新组",
                onClick: () => createGroup([agent.id]),
              },
            ]),
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
    [pinnedIds, togglePin, toggleArchive, setArchiveOpen, openRename, openConfirm, deleteAgent, leaveGroup, createGroup],
  );

  const [bounds, setBounds] = useState<{ width: number; height: number }>({ width: 0, height: 0 });

  // Agent 需要介入（待答提问 / 待审批）时发 OS 级提醒；窗口已开且页面可见时不打扰
  useAgentAlerts();

  // 橡皮筋越界（混合版）：
  // - 内容层（.tile-wall__content）在停靠点之外由 overscrollRef 驱动 translateX 真实位移
  // - 第一段：raw 线性换成真实位移（拉一小段额外距离）；到 OVERSCROLL_FREE_PX 碰壁，位移锁死
  // - 碰壁后继续拉：位移不再增加，超出量转成 Glow——左右弧由淡变实、模糊增强（EdgeEffect Glow 式）
  // - 松手 / 滚轮停顿后 rAF 把 raw 衰减回 0（内容弹回停靠点、弧消散）
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
  const OVERSCROLL_FREE_PX = 40; // 混合版：碰壁前允许的真实位移（一小段额外距离）
  const GLOW_SCALE_PX = 300; // Glow 强度指数刻度（碰壁后继续拉的量越大弧越实）
  const MAX_RAW_PX = 4000; // 越界原始量上限（数值保护）
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
          onEvent: (event) => {
            applyAgentEvent(event);
            // 收尾单链：判读上报 toast / 值日生磁贴刷新都从这里扇出
            emitDutyEvent(event);
          },
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

  // ---- 打开态关联会话（&ses_ 图）：T7 改为「当前实例快照」----
  // 旧逻辑：收集全部已打开绘画取并集批量查询（代码保留于下方注释，便于恢复多绘画聚合）。
  // 本次：只在 openMode 由关→开的瞬间，以当时「最新打开的绘画」为当前实例单独查询一次；
  // 左右联动断开：右侧再打开/关闭/拖拽/置顶不再触发左侧面板重算（断/重联方案待后续设计）。
  useEffect(() => {
    if (!openMode) {
      setRelatedAgentIds([]);
      return;
    }
    // [旧实现——多绘画并集查询，保留不删] const sessionIds = openAgentIds.map(...)...ids=sessionIds.join(",")
    const currentId = openAgentIds[openAgentIds.length - 1];
    const sessionId = currentId ? agents.find((candidate) => candidate.id === currentId)?.session_id : undefined;
    if (!sessionId) {
      setRelatedAgentIds([]);
      return;
    }
    let cancelled = false;
    void (async () => {
      try {
        const base = await awaitApiBase();
        const res = await fetch(`${base}/api/sessions/related?ids=${sessionId}`);
        const data = (await res.json()) as { sessions?: Array<{ agentId: string }> };
        if (!cancelled) setRelatedAgentIds((data.sessions ?? []).map((s) => s.agentId));
      } catch {
        if (!cancelled) setRelatedAgentIds([]);
      }
    })();
    return () => {
      cancelled = true;
    };
    // 故意仅依赖 openMode：进入 open 时取一次快照，右侧后续变化不驱动左侧（断联动）
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [openMode]);
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
  // 用户组用存储的手动网格；未分组带由最近访问时间自动排位（widget 为障碍），见 bandLayout。
  /** 墙治理可见性：agent 受筛选集约束，widget/browser 恒可见（band 与拖动落点共用同一判定） */
  const isTileVisible = useCallback(
    (id: string) => {
      const tile = tiles[id];
      return tile ? tile.kind !== "agent" || wallIds.has(id) : true;
    },
    [tiles, wallIds],
  );
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
      isVisible: isTileVisible,
      visitTimeOf,
    });
    const m = Math.round(bounds.width * EDGE_RATIO);
    if (m <= 0) return raw;
    return {
      ...raw,
      contentWidth: raw.contentWidth + m * 2,
      bands: raw.bands.map((b) => ({ ...b, x: b.x + m })),
    };
  }, [metrics, tiles, groups, isTileVisible, visitTimeOf, bounds.width]);
  const bands = bandLayout?.bands ?? [];
  const bandOf = bandLayout?.bandOf ?? {};
  const bandById = useMemo(() => {
    const m: Record<string, Band> = {};
    for (const b of bands) m[b.id] = b;
    return m;
  }, [bands]);

  // T4：打开/关闭时维护 z 序（移除已关、追加新开）
  useEffect(() => {
    setOpenZOrder((prev) => {
      let next = prev.filter((id) => openAgentIds.includes(id));
      let changed = next.length !== prev.length;
      for (const id of openAgentIds) {
        if (!next.includes(id)) {
          next.push(id);
          changed = true;
        }
      }
      return changed ? next : prev;
    });
  }, [openAgentIds]);

  // 关闭卡片后清理其世界 X：重开时重新回退到磁贴当前自由网格 X
  useEffect(() => {
    setOpenWorldX((prev) => {
      let changed = false;
      const next: Record<string, number> = {};
      for (const id of openAgentIds) {
        if (Number.isFinite(prev[id])) next[id] = prev[id];
      }
      for (const key of Object.keys(prev)) {
        if (!openAgentIds.includes(key)) changed = true;
      }
      return changed ? next : prev;
    });
    // Y 错位同生命周期管理：关闭后丢弃，重新打开回到默认 top
    setOpenWorldY((prev) => {
      let changed = false;
      const next: Record<string, number> = {};
      for (const id of openAgentIds) {
        if (Number.isFinite(prev[id])) next[id] = prev[id];
      }
      for (const key of Object.keys(prev)) {
        if (!openAgentIds.includes(key)) changed = true;
      }
      return changed ? next : prev;
    });
  }, [openAgentIds]);

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

  // ---- 打开卡片后平滑滚动，使被打开的卡片在屏幕上水平居中 ----
  // 以前进入 open 模式时内容层会变窄（band 宽度 → 舞台宽度），浏览器会把 scrollLeft 立刻夹到新的
  // maxScroll，视觉上就是“突然跳到一个 X 位置”。现在两道保险：
  // 1) open 模式的内容宽度不窄于自由布局宽度（见 contentWidth），从根上避免被夹；
  // 2) 新打开一张卡片后，用 rAF 缓动把 scrollLeft 移到“该卡片水平居中”的目标位置。
  const scrollAnimRef = useRef<number | null>(null);
  const centerPendingRef = useRef<string | null>(null);
  const prevOpenIdsRef = useRef<string[]>([]);
  /** 自由布局的内容宽度（进 open 模式后不让内容层比它更窄，避免宽度收缩引发滚动夹取） */
  const freeContentWidthRef = useRef(0);

  useEffect(() => {
    if (!openMode) freeContentWidthRef.current = bandLayout?.contentWidth ?? 0;
  }, [openMode, bandLayout]);

  /** 平滑滚动到目标 scrollLeft（easeOutCubic；新目标会取消上一个动画） */
  const animateWallScrollTo = useCallback((target: number) => {
    const el = wallRef.current;
    if (!el) return;
    if (scrollAnimRef.current !== null) {
      cancelAnimationFrame(scrollAnimRef.current);
      scrollAnimRef.current = null;
    }
    const from = el.scrollLeft;
    const delta = target - from;
    if (Math.abs(delta) < 1) {
      el.scrollLeft = target;
      return;
    }
    const started = performance.now();
    const DURATION = Math.min(720, Math.max(240, Math.abs(delta) * 0.45)); // 距离越远缓动越久（有上下限）
    const tick = () => {
      const node = wallRef.current;
      if (!node) {
        scrollAnimRef.current = null;
        return;
      }
      const t = Math.min(1, (performance.now() - started) / DURATION);
      const eased = 1 - Math.pow(1 - t, 3);
      node.scrollLeft = from + delta * eased;
      scrollAnimRef.current = t < 1 ? requestAnimationFrame(tick) : null;
    };
    scrollAnimRef.current = requestAnimationFrame(tick);
  }, []);

  // 记录“这次新打开的那张”（等它的世界 X 就绪后再居中）
  useEffect(() => {
    const prev = prevOpenIdsRef.current;
    if (openMode) {
      const fresh = openIds.filter((id) => !prev.includes(id));
      if (fresh.length > 0) centerPendingRef.current = fresh[fresh.length - 1];
    } else {
      centerPendingRef.current = null;
    }
    prevOpenIdsRef.current = openIds;
  }, [openIds, openMode]);

  // 居中滚动：等一帧让内容层按新布局落地（scrollWidth 才是新的），再缓动过去
  useLayoutEffect(() => {
    const id = centerPendingRef.current;
    if (!id || !openMode || !layout) return;
    const geom = layout.geometryOf[id];
    // 与渲染保持一致：agent 用 openWorldX；browser 用舞台几何 X
    const worldX = Number.isFinite(openWorldX[id]) ? openWorldX[id] : id.startsWith("browser:") ? geom?.x : undefined;
    if (worldX === undefined || !Number.isFinite(worldX)) return;
    if (!wallRef.current) return;
    centerPendingRef.current = null;
    const raf = requestAnimationFrame(() => {
      const node = wallRef.current;
      if (!node) return;
      const cardW = layout.stage.w > 0 ? layout.stage.w : bounds.width;
      const maxScroll = Math.max(0, node.scrollWidth - node.clientWidth);
      // 目标：卡片中心对齐视口中心（左右两端夹到可滚动范围）
      const target = Math.max(0, Math.min(maxScroll, worldX + cardW / 2 - node.clientWidth / 2));
      animateWallScrollTo(target);
    });
    return () => cancelAnimationFrame(raf);
  }, [openMode, layout, bounds.width, openWorldX, animateWallScrollTo]);

  useEffect(
    () => () => {
      if (scrollAnimRef.current !== null) cancelAnimationFrame(scrollAnimRef.current);
    },
    [],
  );

  // ---- 拖拽落点：指针 → 灰框位置 → 含义（Desktop 是唯一落点权威）----
  //  鼠标指针 →（TileShell 像素跟手并上报磁贴中心）→ 灰框落在哪条带/哪个格 → 解译含义：
  //  - 同带 → 移位（占用了别人的格时由让位预览把对方推开，落盘再规范化）
  //  - 跨带进用户组 → 进组；跨带回未分组 → 退组
  //  预览（灰框 / 让位 / 高亮）与落点同源，不会再出现“灰框在 A 带、落点在 B 带”。
  const dropIntentRef = useRef<DropIntent | null>(null);
  const [dropHint, setDropHint] = useState<{ bandId: string; tileId: string | null } | null>(null);
  const [renamingGroupId, setRenamingGroupId] = useState<string | null>(null);
  const [groupNameDraft, setGroupNameDraft] = useState("");

  const setGhost = useGhostStore((s) => s.setGhost);
  const clearGhost = useGhostStore((s) => s.clearGhost);
  const setDisplacedPreview = useGhostStore((s) => s.setDisplaced);
  const clearDisplacedPreview = useGhostStore((s) => s.clearDisplaced);

  /** 「磁贴中心（内容区坐标）」→ 落点：目标带 + 带内格 + 含义 */
  const resolveIntent = useCallback(
    (id: string, centerX: number, centerY: number): DropIntent | null => {
      const store = useTileStore.getState();
      const tile = store.tiles[id];
      if (!metrics || !tile) return null;
      return resolveDropIntent({
        bands,
        metrics,
        sourceId: id,
        sourceBandId: bandOf[id] ?? null,
        centerX,
        centerY,
        w: tile.grid.w,
        h: tile.grid.h,
        // 未分组带：位置由最近访问时间自动排位决定（widget 仍按指针格 = 手动位）
        ungrouped: {
          tiles: store.tiles,
          visitTimeOf,
          isVisible: isTileVisible,
          sourceKind: tile.kind,
        },
      });
    },
    [bandOf, bands, isTileVisible, metrics, visitTimeOf],
  );

  /** 拖动中：解译落点 + 写预览（灰框像素 / 目标带让位 / 高亮） */
  const handleDragMove = useCallback(
    (id: string, centerX: number, centerY: number) => {
      const intent = resolveIntent(id, centerX, centerY);
      dropIntentRef.current = intent;
      if (!intent) {
        clearGhost();
        clearDisplacedPreview();
        setDropHint(null);
        return;
      }
      setGhost(intent.pixels);
      const band = bandById[intent.bandId] ?? null;
      if (intent.ungroupedLayout) {
        // 未分组是自动排位：预览不是“推开别人”，而是“插入后的整带重排”，
        // 所以直接把假想布局与当前布局的差异当作让位预览（预览即落点）。
        const current = band?.gridMap ?? {};
        const diff: Record<string, TileGrid> = {};
        for (const [tid, g] of Object.entries(intent.ungroupedLayout)) {
          if (tid === id) continue;
          const cur = current[tid];
          if (!cur || cur.col !== g.col || cur.row !== g.row || cur.w !== g.w || cur.h !== g.h) {
            diff[tid] = g;
          }
        }
        setDisplacedPreview(diff);
      } else {
        setDisplacedPreview(band ? displaceTiles(band.gridMap, intent.grid, id) : {});
      }
      setDropHint((prev) =>
        prev && prev.bandId === intent.bandId && prev.tileId === intent.targetTileId
          ? prev
          : { bandId: intent.bandId, tileId: intent.targetTileId },
      );
    },
    [bandById, clearDisplacedPreview, clearGhost, resolveIntent, setDisplacedPreview, setGhost],
  );

  // 指针在视口左右边缘时自动滚动画布（边缘 48px，越近越快）。拖拽落点不在这里判定。
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
      if (!document.querySelector(".tile-shell--dragging")) {
        stopEdgeScroll();
        return;
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
    };
    const onUp = () => stopEdgeScroll();
    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp);
    return () => {
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("mouseup", onUp);
      stopEdgeScroll();
    };
  }, []);

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
    if (groupedMode || !metrics) return "100%";
    if (openMode) {
      // 草稿纸桌面：内容层至少铺满视口；尾部留白 = 半个视口宽，保证任何一张打开的卡片
      // 都能被滚到屏幕正中（否则靠右的卡片永远居中不了）。
      const cardW = layout?.stage.w || bounds.width;
      let maxX = 0;
      for (const id of openIds) {
        const geom = layout?.geometryOf[id];
        const x = Number.isFinite(openWorldX[id]) ? openWorldX[id] : geom?.x;
        if (x !== undefined && Number.isFinite(x)) maxX = Math.max(maxX, x + cardW);
      }
      const stable = Math.ceil(Math.max(bounds.width, maxX + bounds.width / 2));
      // 不窄于自由布局：进入 open 模式时宽度收缩会让浏览器立刻夹掉当前滚动（表现为“瞬跳”）
      const need = Math.max(stable, Math.ceil(freeContentWidthRef.current));
      return `${need}px`;
    }
    const w = bandLayout?.contentWidth ?? 0;
    return `${Math.max(w, 1)}px`;
  }, [openMode, groupedMode, metrics, bandLayout, layout, bounds.width, openIds, openWorldX]);

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
    // 混合版：raw ≤ OVERSCROLL_FREE_PX 时线性位移（一小段额外距离）；
    // 到壁锁死后继续拉的量不再产生位移，转为 Glow——线性渐变条贴边由淡变实
    const d = Math.min(o.raw, OVERSCROLL_FREE_PX);
    const excess = Math.max(0, o.raw - OVERSCROLL_FREE_PX);
    const glow = 1 - Math.exp(-excess / GLOW_SCALE_PX);
    layer.style.transform = `translateX(${(o.side === -1 ? d : -d).toFixed(2)}px)`;
    const band = o.side === -1 ? leftArcRef.current : rightArcRef.current;
    const other = o.side === -1 ? rightArcRef.current : leftArcRef.current;
    if (band) band.style.opacity = glow.toFixed(3);
    if (other) other.style.opacity = "0";
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

  // 滚轮/触控板平移桌面（只认横向分量）；Ctrl+滚轮 → 缩放（仅 free 模式；open 模式不拦截窗口滚动）
  // 方向约定：横向滚动方向与桌面移动方向相反——
  //   向右滚 → scrollLeft 增大（桌面向左移）；向左滚 → scrollLeft 减小（桌面向右移）。
  // 纵向分量（deltaY）不再参与平移：磁贴墙是 overflow-y:hidden 的横向条带，
  // 上下滚不产生任何位移，也不 preventDefault，直接放行交还默认行为。
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
      // 只取横向分量：上下滚动不再平移桌面（纯纵向滚直接放行，不拦截）
      const delta = event.deltaX;
      if (delta === 0) return;
      if (openMode) {
        // T2：草稿纸桌面用容器 scrollLeft 直接平移，不做橡皮筋越界（free 模式的越界弹回逻辑保留在其后）
        event.preventDefault();
        // 用户自己开始滚就停掉“打开后居中”的缓动，避免两个滚动源互相抢
        if (scrollAnimRef.current !== null) {
          cancelAnimationFrame(scrollAnimRef.current);
          scrollAnimRef.current = null;
        }
        const maxScroll = el.scrollWidth - el.clientWidth;
        const cur = el.scrollLeft;
        el.scrollLeft = Math.min(maxScroll, Math.max(0, cur + delta));
        return;
      }
      event.preventDefault();
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
      // T2：open 模式同样支持抓手平移（无橡皮筋）
      if (openMode) {
        el.scrollLeft = Math.min(maxScroll, Math.max(0, rawScroll));
        return;
      }
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

  // T2：open 模式下跟踪容器 scrollLeft（dock 视口补偿）
  useEffect(() => {
    const el = wallRef.current;
    if (!el || !openMode) return;
    setWallScrollX(el.scrollLeft);
    const onScroll = () => setWallScrollX(el.scrollLeft);
    el.addEventListener("scroll", onScroll);
    return () => el.removeEventListener("scroll", onScroll);
  }, [openMode]);

  // 桌面空白处右键 → 弹出菜单（New Agent / Add widget / Refresh / Change wallpaper / Zoom）
  const onContextMenu = useCallback(
    (event: ReactMouseEvent<HTMLDivElement>) => {      // 点在磁贴上不响应（仅空白桌面）
      if (openMode) {
        event.preventDefault();
        // 有错位卡时右键整理：所有磁贴 Y 归位（回到默认 top），X 保留
        if (Object.keys(openWorldY).length > 0) {
          resetOpenWorldY();
        }
        return;
      }
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
    [showContextMenu, openNewAgent, openWidgetPicker, openWallpaper, openSettings, load, zoom, zoomIn, zoomOut, openMode, openWorldY, resetOpenWorldY],
  );

  // ---- 广义 Tile 统一落盘：所有类型（agent/widget/browser）唯一写路径 = tileStore ----
  //  落点完全来自 dropIntentRef（灰框解译结果），与拖动中的预览同源；
  //  缩放仍在 TileShell 内量化，直接把网格回传（resizeGrid）。
  const handleTileCommit = useCallback(
    (id: string, resizeGrid?: TileGrid) => {
      const store = useTileStore.getState();
      const tile = store.tiles[id];
      const displaced = useGhostStore.getState().displaced;
      const hasDisplaced = Object.keys(displaced).length > 0;
      if (resizeGrid) {
        // 先定格让位者、再落自身：与拖动中预览的次序一致（避免规范化先推先占位）
        if (hasDisplaced) store.commitDisplaced(displaced);
        store.commitTile(id, resizeGrid);
      } else {
        const intent = dropIntentRef.current;
        if (tile && intent && intent.sourceId === id) {
          if (intent.kind === "move") {
            if (hasDisplaced) store.commitDisplaced(displaced);
            store.commitTile(id, intent.grid);
          } else if (intent.kind === "ungroup") {
            store.repelDropToUngrouped(id, intent.grid.col, intent.grid.row, tile.grid.w, tile.grid.h, displaced);
          } else {
            store.repelDropIntoGroup(id, intent.bandId, intent.grid.col, intent.grid.row, tile.grid.w, tile.grid.h, displaced);
          }
        }
      }
      // 拖拽结束：清预览与高亮（灰框 / 让位 / 目标带）
      dropIntentRef.current = null;
      clearGhost();
      clearDisplacedPreview();
      setDropHint(null);
    },
    [clearDisplacedPreview, clearGhost],
  );

  return (
    <div className={`tile-wall${openMode ? " tile-wall--open" : ""}${pageOpen ? " tile-wall--settings-leaving" : ""}`} ref={wallRef} onContextMenu={onContextMenu}>
      {/* 橡皮筋越界 Glow：仅 free 模式；透明度由 overscrollRef 实时驱动。
          线性渐变条贴边铺开（碰壁后继续拉 → 由淡变实），无形状、无模糊 */}
      {!openMode && !groupedMode ? (
        <>
          <div
            ref={leftArcRef}
            className="tile-wall__tension-glow tile-wall__tension-glow--left"
            style={{ opacity: 0 }}
            aria-hidden="true"
          />
          <div
            ref={rightArcRef}
            className="tile-wall__tension-glow tile-wall__tension-glow--right"
            style={{ opacity: 0 }}
            aria-hidden="true"
          />
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
              className={`tile-group-name${renamingGroupId === band.id ? " tile-group-name--editing" : ""}${reorderSource === band.id ? " tile-group-name--dragging" : ""}${dropHint?.bandId === band.id ? " tile-group-name--drop" : ""}`}
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
                  y: Number.isFinite(openWorldY[agent.id]) ? openWorldY[agent.id] : layout.stage.y,
                  w: layout.stage.w,
                  h: layout.stage.h,
                }
              : {
                  // T2：dock 固定在视口（内容层随容器 scrollLeft 平移，这里反向补偿）
                  ...(layout.geometryOf[agent.id] ?? EMPTY_TILE),
                  x: (layout.geometryOf[agent.id]?.x ?? 0) + wallScrollX,
                }
            : metrics && sourceGrid
              ? gridToPixels(displacedGrid ?? sourceGrid, metrics, bandX)
              : EMPTY_TILE;
        const tileMode = !openMode ? "free" : isOpen ? "expanded" : inDock ? "dock" : "free";
        // 广义 Tile 统一拖放（agent 与 widget 同路径，见 handleDragMove / handleTileCommit）
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
            zIndex={isOpen ? 20 + zRankOf(agent.id) : openMode ? (inDock ? 1 : 0) : 1}
            displacedPreview={!!displacedGrid && tileMode === "free"}
            bandX={bandX}
            canvasGhost={canvasGhost}
            flipped={isOpen}
            back={isOpen ? <AgentWindow agent={agent} onClose={() => closeAgent(agent.id)} /> : undefined}
            onDragMove={(cx, cy) => handleDragMove(agent.id, cx, cy)}
            onCommit={(next) => handleTileCommit(agent.id, next)}
            dropTarget={dropHint?.tileId === agent.id}
            onDropToDock={isOpen ? () => closeAgent(agent.id) : undefined}
            onWorldXCommit={isOpen ? (x) => commitOpenWorldX(agent.id, x) : undefined}
            onWorldYCommit={isOpen ? (y) => commitOpenWorldY(agent.id, y) : undefined}
            onActivate={isOpen ? () => raiseAgent(agent.id) : undefined}
            edgeViewportWidth={openMode ? bounds.width : 0}
            edgeScrollX={openMode ? wallScrollX : 0}
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
        // 无系统带：browser 与 agent/widget 同权，几何来自所属带（默认未分组）
        const band = bandById[bandOf[browser.id]] ?? null;
        const bandX = band?.x ?? 0;
        const browserGrid = band?.gridMap[browser.id] ?? null;
        const geometry =
          openMode && layout
            ? (() => {
                const bGeom = layout.geometryOf[browser.id] ?? EMPTY_TILE;
                // T2：dock（非打开）固定在视口，反向补偿容器 scrollLeft
                if (!isOpen) {
                  return { ...bGeom, x: bGeom.x + wallScrollX };
                }
                return bGeom;
              })()
            : metrics && browserGrid
              ? gridToPixels(displacedGrid ?? browserGrid, metrics, bandX)
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
            gridMap={!openMode ? band?.gridMap : undefined}
            metrics={!openMode ? metrics ?? undefined : undefined}
            bounds={bounds}
            mode={tileMode}
            dragHandleSelector={isOpen ? ".browser-window__header" : undefined}
            dockRightEdgeX={layout?.dockRightEdgeX}
            zIndex={isOpen ? 21 : 1}
            displacedPreview={!!displacedGrid}
            bandX={bandX}
            flipped={isOpen}
            back={isOpen ? <BrowserWindow browser={browser} onClose={() => closeBrowser(browser.id)} /> : undefined}
            onDragMove={(cx, cy) => handleDragMove(browser.id, cx, cy)}
            onCommit={(next) => handleTileCommit(browser.id, next)}
            dropTarget={dropHint?.tileId === browser.id}
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
            contextMenuItems={widgetMenuItems}
            onDragMove={(cx, cy) => handleDragMove(widget.id, cx, cy)}
            onCommit={(next) => handleTileCommit(widget.id, next)}
            dropTarget={dropHint?.tileId === widget.id}
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
      {!pageOpen ? <LeftSidePanel /> : null}

      {/* 值日生判读上报（A6）：右下角 toast */}
      <VerdictToasts />
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