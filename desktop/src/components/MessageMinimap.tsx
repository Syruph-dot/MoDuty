/**
 * 消息导航（minimap）：右侧一列横杠 + 滚动进度条，替代浏览器原生滚动条。
 *
 * 结构对齐 Proma `components/ai-elements/scroll-minimap.tsx`：
 *   [展开面板（hover 时才出现，可搜索/跳转）] [横杠组，24px 宽] [进度条，8px 宽]
 * - 横杠把消息按数量分组成最多 20 根；当前视口可见的那组最亮，含用户消息的组稍亮；
 * - hover 横杠展开「消息导航」面板（标题 + 搜索 + 消息列表，点击跳转）；
 * - 进度条可点轨道跳转、可拖滑块；原生滚动条由 CSS 隐藏（.agent-window__list）。
 *
 * 与 Proma 的差别：不依赖 use-stick-to-bottom（MoDuty 用普通滚动容器），
 * 用 data-mk 定位消息节点。
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

export interface MinimapItem {
  /** 对应消息节点的 data-mk（或 tool-card 的 data-mk） */
  id: string;
  role: "user" | "agent" | "tool";
  /** 面板里显示的一行摘要 */
  preview: string;
}

interface MessageMinimapProps {
  items: MinimapItem[];
  scrollRef: React.RefObject<HTMLDivElement | null>;
  /** 点击面板条目后的跳转（缺省：把该消息滚到视野内） */
  onJump?: (id: string) => void;
}

/** 迷你地图最多渲染的横杠数 */
const MAX_BARS = 20;
/** 横杠垂直间距（px） */
const BAR_SPACING = 8;
/** 少于这么多条消息不显示导航 */
const MIN_ITEMS = 2;

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export function MessageMinimap({ items, scrollRef, onJump }: MessageMinimapProps): React.ReactElement | null {
  const [hovered, setHovered] = useState(false);
  const [visibleIds, setVisibleIds] = useState<Set<string>>(() => new Set());
  const [canScroll, setCanScroll] = useState(false);
  const [thumbHeightPct, setThumbHeightPct] = useState(100);
  const [dragging, setDragging] = useState(false);
  const [searchQuery, setSearchQuery] = useState("");

  const trackRef = useRef<HTMLDivElement>(null);
  const thumbRef = useRef<HTMLDivElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const searchInputRef = useRef<HTMLInputElement>(null);
  const visibleIdsRef = useRef<Set<string>>(new Set());
  const visibleElementsRef = useRef<Map<string, HTMLElement>>(new Map());
  const thumbHeightPctRef = useRef(100);
  const hoveredRef = useRef(hovered);
  hoveredRef.current = hovered;

  /** id 序列指纹：只有消息结构变了才重绑观察器（滚动时不重绑） */
  const itemIdsKey = useMemo(() => items.map((item) => item.id).join("\u0000"), [items]);

  // ── 可见消息追踪 + 进度条几何 ──
  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;

    const updateVisibleIds = (next: Set<string>): void => {
      const previous = visibleIdsRef.current;
      if (previous.size === next.size && [...previous].every((id) => next.has(id))) return;
      visibleIdsRef.current = next;
      setVisibleIds(next);
    };

    const updateThumb = (): void => {
      const { scrollTop, scrollHeight, clientHeight } = el;
      const scrollRange = scrollHeight - clientHeight;
      setCanScroll(scrollRange > 10);
      const nextThumbHeightPct = scrollHeight > 0
        ? Math.max(10, Math.min((clientHeight / scrollHeight) * 100, 100))
        : 100;
      if (Math.abs(thumbHeightPctRef.current - nextThumbHeightPct) >= 0.01) {
        thumbHeightPctRef.current = nextThumbHeightPct;
        setThumbHeightPct(nextThumbHeightPct);
      }
      const thumbTopPct = scrollRange > 0 ? (scrollTop / scrollRange) * (100 - nextThumbHeightPct) : 0;
      if (thumbRef.current) thumbRef.current.style.top = `${thumbTopPct}%`;
    };

    const visible = new Set<string>();
    const observer = new IntersectionObserver(
      (entries) => {
        let changed = false;
        for (const entry of entries) {
          const id = entry.target.getAttribute("data-mk");
          if (!id) continue;
          if (entry.isIntersecting) {
            visibleElementsRef.current.set(id, entry.target as HTMLElement);
            if (!visible.has(id)) {
              visible.add(id);
              changed = true;
            }
          } else {
            visibleElementsRef.current.delete(id);
            if (visible.delete(id)) changed = true;
          }
        }
        if (changed) updateVisibleIds(new Set(visible));
      },
      { root: el, threshold: 0 },
    );

    const observeNode = (node: Node): void => {
      if (node.nodeType !== Node.ELEMENT_NODE) return;
      const element = node as HTMLElement;
      if (element.matches("[data-mk]")) observer.observe(element);
      for (const child of element.querySelectorAll<HTMLElement>("[data-mk]")) observer.observe(child);
    };
    for (const node of el.querySelectorAll<HTMLElement>("[data-mk]")) observer.observe(node);

    const mutationObserver = new MutationObserver((mutations) => {
      let changed = false;
      for (const mutation of mutations) {
        for (const node of mutation.addedNodes) observeNode(node);
        for (const node of mutation.removedNodes) {
          if (node.nodeType !== Node.ELEMENT_NODE) continue;
          const element = node as HTMLElement;
          const removed = element.matches("[data-mk]")
            ? [element]
            : [...element.querySelectorAll<HTMLElement>("[data-mk]")];
          for (const message of removed) {
            observer.unobserve(message);
            const id = message.getAttribute("data-mk");
            if (id) visibleElementsRef.current.delete(id);
            if (id && visible.delete(id)) changed = true;
          }
        }
      }
      if (changed) updateVisibleIds(new Set(visible));
    });
    mutationObserver.observe(el, { childList: true, subtree: true });

    updateThumb();
    const onScroll = (): void => updateThumb();
    el.addEventListener("scroll", onScroll, { passive: true });
    const resizeObserver = new ResizeObserver(updateThumb);
    resizeObserver.observe(el);
    if (el.firstElementChild) resizeObserver.observe(el.firstElementChild);

    return () => {
      el.removeEventListener("scroll", onScroll);
      observer.disconnect();
      mutationObserver.disconnect();
      resizeObserver.disconnect();
      visibleIdsRef.current = new Set();
      visibleElementsRef.current.clear();
    };
  }, [itemIdsKey, scrollRef]);

  // 面板打开时聚焦搜索框
  useEffect(() => {
    if (!hovered) return;
    const timer = setTimeout(() => searchInputRef.current?.focus(), 80);
    return () => clearTimeout(timer);
  }, [hovered]);

  const jumpTo = useCallback(
    (id: string): void => {
      if (onJump) {
        onJump(id);
        return;
      }
      const el = scrollRef.current;
      if (!el) return;
      const target =
        el.querySelector<HTMLElement>(`[data-mk="${CSS.escape(id)}"]`) ??
        [...el.querySelectorAll<HTMLElement>("[data-mk]")].find((node) => node.getAttribute("data-mk") === id) ??
        null;
      target?.scrollIntoView({ block: "start", behavior: "smooth" });
    },
    [onJump, scrollRef],
  );

  /** 点轨道空白处：按点击位置跳转 */
  const handleTrackMouseDown = useCallback(
    (event: React.MouseEvent<HTMLDivElement>): void => {
      if (event.target !== event.currentTarget) return;
      const track = trackRef.current;
      const el = scrollRef.current;
      if (!track || !el) return;
      const rect = track.getBoundingClientRect();
      const ratio = (event.clientY - rect.top) / rect.height;
      el.scrollTo({ top: Math.max(0, ratio * (el.scrollHeight - el.clientHeight)), behavior: "smooth" });
    },
    [scrollRef],
  );

  /** 拖滑块 */
  const handleThumbMouseDown = useCallback(
    (event: React.MouseEvent<HTMLDivElement>): void => {
      event.preventDefault();
      event.stopPropagation();
      const el = scrollRef.current;
      const track = trackRef.current;
      if (!el || !track) return;
      const startY = event.clientY;
      const startTop = el.scrollTop;
      const range = el.scrollHeight - el.clientHeight;
      const trackHeight = Math.max(1, track.clientHeight);
      const onMove = (moveEvent: MouseEvent): void => {
        el.scrollTop = startTop + ((moveEvent.clientY - startY) / trackHeight) * range;
      };
      const onUp = (): void => {
        document.removeEventListener("mousemove", onMove);
        document.removeEventListener("mouseup", onUp);
        document.body.style.userSelect = "";
        setDragging(false);
      };
      document.body.style.userSelect = "none";
      document.addEventListener("mousemove", onMove);
      document.addEventListener("mouseup", onUp);
      setDragging(true);
    },
    [scrollRef],
  );

  const filtered = useMemo(() => {
    const query = searchQuery.trim().toLowerCase();
    if (!query) return items;
    return items.filter((item) => item.preview.toLowerCase().includes(query));
  }, [items, searchQuery]);

  if (items.length < MIN_ITEMS || !canScroll) return null;

  const barCount = Math.min(items.length, MAX_BARS);

  return (
    <div className="chat-minimap">
      {/* 展开面板 */}
      {hovered ? (
        <div
          className="chat-minimap__panel"
          onMouseEnter={() => setHovered(true)}
          onMouseLeave={() => setHovered(false)}
        >
          <div className="chat-minimap__panel-head">
            <span>消息导航</span>
            <span className="chat-minimap__panel-count">
              {visibleIds.size}/{items.length}
            </span>
          </div>
          <div className="chat-minimap__panel-search">
            <input
              ref={searchInputRef}
              value={searchQuery}
              placeholder="搜索消息…"
              onChange={(event) => setSearchQuery(event.target.value)}
            />
          </div>
          <div className="chat-minimap__panel-list" ref={listRef}>
            {filtered.length === 0 ? (
              <div className="chat-minimap__panel-empty">未找到匹配消息</div>
            ) : (
              filtered.map((item) => (
                <button
                  key={item.id}
                  type="button"
                  className={`chat-minimap__item${visibleIds.has(item.id) ? " chat-minimap__item--visible" : ""}`}
                  onClick={() => jumpTo(item.id)}
                >
                  <span className={`chat-minimap__item-dot chat-minimap__item-dot--${item.role}`} aria-hidden="true" />
                  <span className="chat-minimap__item-text">
                    <HighlightedPreview text={item.preview} query={searchQuery} />
                  </span>
                </button>
              ))
            )}
          </div>
        </div>
      ) : null}

      {/* 横杠组：只有这里触发面板展开 */}
      <div
        className="chat-minimap__bars"
        style={{ height: barCount * BAR_SPACING }}
        onMouseEnter={() => setHovered(true)}
        onMouseLeave={() => setHovered(false)}
      >
        {Array.from({ length: barCount }, (_, index) => {
          const start = Math.floor((index * items.length) / barCount);
          const end = Math.floor(((index + 1) * items.length) / barCount);
          const group = items.slice(start, end);
          const isVisible = group.some((item) => visibleIds.has(item.id));
          const hasUser = group.some((item) => item.role === "user");
          const top = ((index + 0.5) / barCount) * 100;
          return (
            <div
              key={index}
              className={`chat-minimap__bar${isVisible ? " chat-minimap__bar--visible" : hasUser ? " chat-minimap__bar--user" : ""}`}
              style={{ top: `${top}%` }}
            />
          );
        })}
      </div>

      {/* 滚动进度条 */}
      <div className="chat-minimap__track-wrap">
        <div className="chat-minimap__track" ref={trackRef} onMouseDown={handleTrackMouseDown}>
          <div
            ref={thumbRef}
            className={`chat-minimap__thumb${dragging ? " chat-minimap__thumb--active" : ""}`}
            style={{ height: `${thumbHeightPct}%`, top: "0%" }}
            onMouseDown={handleThumbMouseDown}
          />
        </div>
      </div>
    </div>
  );
}

/** 搜索命中高亮（无搜索时就是原文） */
function HighlightedPreview({ text, query }: { text: string; query: string }): React.ReactElement {
  if (!text) return <span className="chat-minimap__item-empty">（空消息）</span>;
  const trimmed = query.trim();
  if (!trimmed) return <>{text}</>;
  const parts = text.split(new RegExp(`(${escapeRegExp(trimmed)})`, "gi"));
  return (
    <>
      {parts.map((part, index) =>
        part.toLowerCase() === trimmed.toLowerCase() ? (
          <mark key={index} className="chat-minimap__mark">
            {part}
          </mark>
        ) : (
          part
        ),
      )}
    </>
  );
}
