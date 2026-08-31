import type { ReactNode } from "react";

import ClockWidget from "../components/widgets/ClockWidget";
import type { WidgetDefinition, WidgetKind, WidgetRegistry } from "../types";

/**
 * widget 注册表：kind → 定义（metadata + 渲染工厂）。
 * 新增一种 widget 只需在这里加一条 + 在 components/widgets/ 下建组件，
 * 桌面渲染与「Add widget」选择卡都自动感知，无需改 Desktop。
 */
export const WIDGET_REGISTRY: WidgetRegistry = {
  ringclock: {
    kind: "ringclock",
    name: "RingClock",
    description: "连续平滑圆环时钟 · 月/日/时/分/秒",
    defaultTitle: "Ring Clock",
    defaultGeometry: { x: 64, y: 64, w: 220, h: 220 },
    renderBody: (): ReactNode => <ClockWidget />,
  },
};

/** 选择卡用的有序列表 */
export const WIDGET_LIST: WidgetDefinition[] = Object.values(WIDGET_REGISTRY).sort((a, b) =>
  a.name.localeCompare(b.name),
);

export function getWidgetDef(kind: WidgetKind): WidgetDefinition | undefined {
  return WIDGET_REGISTRY[kind];
}
