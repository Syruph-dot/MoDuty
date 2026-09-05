import type { ReactNode } from "react";

import ClockWidget from "../components/widgets/ClockWidget";
import DailyWidget from "../components/widgets/DailyWidget";
import DutyGirl from "../components/widgets/DutyGirl";
import GraphWidget from "../components/widgets/GraphWidget";
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
    defaultGrid: { col: 0, row: 0, w: 1, h: 1 },
    renderBody: (): ReactNode => <ClockWidget />,
  },
  daily: {
    kind: "daily",
    name: "日报",
    description: "日历视图 + 时间轴日报，点击生成调用低成本模型（MOMOKA CLI）",
    defaultTitle: "日报",
    defaultGrid: { col: 0, row: 0, w: 2, h: 2 },
    renderBody: (): ReactNode => <DailyWidget />,
  },
  duty: {
    kind: "duty",
    name: "值日生",
    description: "调度者 Agent · 调查会话并调用 MOMOKA CLI 驱动其它 Agent（固定 2×3）",
    defaultTitle: "值日生",
    defaultGrid: { col: 0, row: 1, w: 2, h: 3 },
    fixedSize: true,
    renderBody: (): ReactNode => <DutyGirl />,
  },
  graph: {
    kind: "graph",
    name: "关系图",
    description: "会话 & 引用关系力导向图（D3.js），可拖拽固定、点击跳转",
    defaultTitle: "关系图",
    defaultGrid: { col: 0, row: 0, w: 3, h: 3 },
    renderBody: (): ReactNode => <GraphWidget />,
  },
};

/** 选择卡用的有序列表 */
export const WIDGET_LIST: WidgetDefinition[] = Object.values(WIDGET_REGISTRY).sort((a, b) =>
  a.name.localeCompare(b.name),
);

export function getWidgetDef(kind: WidgetKind): WidgetDefinition | undefined {
  return WIDGET_REGISTRY[kind];
}
