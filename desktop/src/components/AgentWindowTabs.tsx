import { useCallback, useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";

import { IconAgent, IconBack, IconBrowser } from "./ui/icons";

/**
 * Agent 窗口头部的标签页条。
 *
 * 结构：首标签 = 当前显示对象的上一个层级（链条里更深时显示上级 Agent 的名字；在最上层且有上级时
 * 显示「← 返回上一级」；连上级都没有就是锁定的自身标签），其后是当前对象的出边子项
 * （下属 Agent / 它引用过的浏览器）。
 *
 * 交互：
 *   - 点击 = 同一个窗口内换内容（不新开窗口）；
 *   - 按住拖离标签条 → 半透明框跟随 → 松手创建它的窗口（原窗口内容不切换）；
 *   - 标签有最小宽度，塞不下时横向滚动（滚轮纵向量转横向）。
 */

/** 标签指向的对象（能拖出去建窗的都有 subject） */
export interface TabSubject {
  kind: "agent" | "browser";
  id: string;
  name: string;
  state?: string | null;
}

export interface TabItem {
  key: string;
  label: string;
  /** 图标语义：返回上一级 / 自身 / Agent / 浏览器 */
  icon: "back" | "self" | "agent" | "browser";
  state?: string | null;
  title?: string;
  /** 可否点击（自身标签在无上级时锁定：它表示「你就在这儿」，点了也没地方去） */
  selectable: boolean;
  /** 可拖出去建窗的对象；自身/返回标签没有 */
  subject?: TabSubject;
}

/** 位移超过它才算拖动（否则按点击处理） */
const DRAG_THRESHOLD = 6;

interface DragState {
  key: string;
  subject?: TabSubject;
  startX: number;
  startY: number;
  x: number;
  y: number;
  /** 已超过阈值，进入拖动 */
  active: boolean;
  /** 指针已离开标签条范围（此时显示半透明框） */
  outside: boolean;
}

function iconOf(item: TabItem) {
  if (item.icon === "back") return <IconBack size={14} />;
  if (item.icon === "browser") return <IconBrowser size={14} />;
  if (item.icon === "agent") return <IconAgent size={14} />;
  return <IconAgent size={14} />;
}

export default function AgentWindowTabs({
  items,
  activeKey,
  onSelect,
  onDetach,
}: {
  items: TabItem[];
  activeKey: string;
  onSelect: (item: TabItem) => void;
  onDetach: (subject: TabSubject) => void;
}) {
  const stripRef = useRef<HTMLDivElement | null>(null);
  const activeRef = useRef<HTMLButtonElement | null>(null);
  const dragRef = useRef<DragState | null>(null);
  const [drag, setDrag] = useState<DragState | null>(null);

  /** 切到别的对象后把当前标签滚回可见（标签多时它容易被挤到视野外） */
  useEffect(() => {
    activeRef.current?.scrollIntoView({ inline: "nearest", block: "nearest", behavior: "smooth" });
  }, [activeKey]);

  /** 滚轮纵向量转横向滚动：塞不下的标签要能左右滚 */
  const onWheel = useCallback((event: React.WheelEvent<HTMLDivElement>) => {
    const el = stripRef.current;
    if (!el || el.scrollWidth <= el.clientWidth) return;
    if (Math.abs(event.deltaY) <= Math.abs(event.deltaX)) return;
    el.scrollLeft += event.deltaY;
  }, []);

  const outsideStrip = (x: number, y: number): boolean => {
    const el = stripRef.current;
    if (!el) return false;
    const rect = el.getBoundingClientRect();
    const slack = 8;
    return y < rect.top - slack || y > rect.bottom + slack || x < rect.left - slack || x > rect.right + slack;
  };

  const begin = (event: React.PointerEvent<HTMLButtonElement>, item: TabItem): void => {
    if (event.button !== 0) return;
    const state: DragState = {
      key: item.key,
      subject: item.subject,
      startX: event.clientX,
      startY: event.clientY,
      x: event.clientX,
      y: event.clientY,
      active: false,
      outside: false,
    };
    dragRef.current = state;
    setDrag(state);
    try {
      event.currentTarget.setPointerCapture(event.pointerId);
    } catch {
      /* 某些内嵌 WebView 不支持指针捕获 */
    }
  };

  const move = (event: React.PointerEvent<HTMLButtonElement>): void => {
    const state = dragRef.current;
    if (!state) return;
    const active = state.active || Math.hypot(event.clientX - state.startX, event.clientY - state.startY) > DRAG_THRESHOLD;
    const next: DragState = {
      ...state,
      x: event.clientX,
      y: event.clientY,
      active,
      outside: active ? outsideStrip(event.clientX, event.clientY) : false,
    };
    dragRef.current = next;
    setDrag(next);
  };

  const end = (event: React.PointerEvent<HTMLButtonElement>, item: TabItem): void => {
    const state = dragRef.current;
    dragRef.current = null;
    setDrag(null);
    if (!state) return;
    try {
      if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId);
    } catch {
      /* 指针捕获可能已被浏览器释放 */
    }
    if (state.active) {
      // 拖离标签条后松手 = 为它新开窗口；拖动过就不当点击
      if (state.outside && item.subject) onDetach(item.subject);
      return;
    }
    if (item.selectable) onSelect(item);
  };

  const ghost =
    drag?.active && drag.outside && drag.subject
      ? createPortal(
          <div className="agent-window__tab-ghost" style={{ left: drag.x, top: drag.y }} aria-hidden="true">
            <span className="agent-window__tab-ghost-title">{drag.subject.name}</span>
            <span className="agent-window__tab-ghost-hint">
              {drag.subject.kind === "browser" ? "松开 → 新开浏览器窗口" : "松开 → 新开它的窗口"}
            </span>
          </div>,
          document.body,
        )
      : null;

  return (
    <div className="agent-window__tabs" ref={stripRef} role="tablist" aria-label="窗口标签" onWheel={onWheel}>
      {items.map((item) => (
        <button
          key={item.key}
          type="button"
          ref={item.key === activeKey ? activeRef : undefined}
          role="tab"
          className={`agent-window__tab${item.key === activeKey ? " agent-window__tab--active" : ""}${
            item.selectable ? "" : " agent-window__tab--locked"
          }${drag?.key === item.key ? " agent-window__tab--dragging" : ""}`}
          aria-selected={item.key === activeKey}
          title={item.title ?? item.label}
          onPointerDown={(event) => {
            event.stopPropagation();
            begin(event, item);
          }}
          onPointerMove={move}
          onPointerUp={(event) => end(event, item)}
          onPointerCancel={(event) => end(event, item)}
          onMouseDown={(event) => event.stopPropagation()}
          onClick={(event) => event.stopPropagation()}
          onDoubleClick={(event) => event.stopPropagation()}
        >
          <span className="agent-window__tab-icon">{iconOf(item)}</span>
          {item.state ? <span className={`state-dot state-dot--${item.state}`} aria-hidden="true" /> : null}
          <span className="agent-window__tab-label">{item.label}</span>
        </button>
      ))}
      {ghost}
    </div>
  );
}
