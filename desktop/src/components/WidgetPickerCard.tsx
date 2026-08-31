import { useEffect, useRef } from "react";

import { useDialogStore } from "../state/dialogStore";
import { useWidgetStore } from "../state/widgetStore";
import { WIDGET_LIST } from "../state/widgetRegistry";
import type { WidgetKind } from "../types";

/**
 * 「Add widget」通用选择器卡片。
 * 设计要点（按需求）：
 * - 非前景：没有全屏 backdrop 遮罩，不拦截桌面其它点击；
 * - 非阻挡式：卡片浮在光标附近，桌面磁贴仍可拖拽 / 右键；
 * - 点卡片外部 / 按 Esc 关闭。
 */
export default function WidgetPickerCard() {
  const open = useDialogStore((state) => state.widgetPickerOpen);
  const close = useDialogStore((state) => state.closeWidgetPicker);
  const spawn = useDialogStore((state) => state.widgetPickerSpawn);
  const addWidget = useWidgetStore((state) => state.addWidget);
  const cardRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (!open) return;
    const onMouseDown = (event: MouseEvent) => {
      const target = event.target as HTMLElement | null;
      if (target?.closest(".widget-picker")) return;
      close();
    };
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") close();
    };
    // 用 capture 阶段，避免在卡片上 mousedown 又立刻触发 document 关闭
    document.addEventListener("mousedown", onMouseDown, true);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onMouseDown, true);
      document.removeEventListener("keydown", onKey);
    };
  }, [open, close]);

  if (!open) return null;

  // 卡片定位在光标附近，并 clamp 到视口内
  const cardW = 240;
  const cardH = 160;
  const left = Math.min(Math.max(8, (spawn?.x ?? 0)), window.innerWidth - cardW - 8);
  const top = Math.min(Math.max(8, (spawn?.y ?? 0)), window.innerHeight - cardH - 8);

  const choose = (kind: WidgetKind) => {
    close();
    addWidget(kind, spawn ?? undefined);
  };

  return (
    <div
      className="widget-picker"
      role="menu"
      aria-label="Add widget"
      style={{ left, top }}
      ref={cardRef}
    >
      <div className="widget-picker__title">Add widget</div>
      <div className="widget-picker__list">
        {WIDGET_LIST.map((def) => (
          <button
            key={def.kind}
            type="button"
            role="menuitem"
            className="widget-picker__item"
            onClick={() => choose(def.kind)}
          >
            <span className="widget-picker__name">{def.name}</span>
            <span className="widget-picker__desc">{def.description}</span>
          </button>
        ))}
      </div>
    </div>
  );
}
