/**
 * 工具卡排布：把「工具调用卡片」从单列改成自适应网格。
 *
 * 规则（与需求一致）：
 * 1) 参考宽度 W_o = 满屏均分 5 张卡片时的单卡宽度（扣掉列间距）；
 * 2) 单卡宽度不得低于 0.8 × W_o，在此前提下列数尽可能多；
 * 3) 常规工具卡进网格流（从左往右、从上往下）；交互型卡（如问答卡）独占一整行。
 *
 * 全部是纯函数，可直接单测。实际列数由 CSS 的
 * `repeat(auto-fill, minmax(var(--tool-card-min), 1fr))` 按容器实际宽度取最大列数，
 * 口径与这里的 `toolCardColumns` 完全一致（组件只写 `--tool-card-min`，不写列数）。
 */

/** 卡片排布原则：flow=进网格流，从左往右/从上往下；full=独占一整行 */
export type ToolCardLayout = "flow" | "full";

/**
 * 需要独占一整行的工具（交互卡）。
 * 这类卡里有选项/按钮/多题导航，压进网格单列会看不到也点不到，必须跨满整行。
 */
export const FULL_ROW_TOOL_NAMES: readonly string[] = ["ask_question"];

/** 网格列间距（px）：必须与 `.agent-window__list` 的 gap 保持一致 */
export const TOOL_GRID_GAP_PX = 10;
/** 参考列数：满屏均分 5 张卡片 */
export const TOOL_GRID_REFERENCE_COLUMNS = 5;
/** 单卡宽度下限 = 参考宽度的 80% */
export const TOOL_GRID_MIN_RATIO = 0.8;
/** 兜底下限：窗口再窄也不让卡片细到读不了 */
export const TOOL_GRID_MIN_PX = 160;

/** 排布原则判定：按工具名决定这张卡进网格流还是独占一行 */
export function toolCardLayout(name: string): ToolCardLayout {
  return FULL_ROW_TOOL_NAMES.includes(name) ? "full" : "flow";
}

/** W_o：满屏均分 5 张卡片时的单卡宽度（扣掉 4 段列间距） */
export function toolCardReferenceWidthPx(viewportWidth: number, gap = TOOL_GRID_GAP_PX): number {
  const usable = viewportWidth - gap * (TOOL_GRID_REFERENCE_COLUMNS - 1);
  return Math.max(0, usable / TOOL_GRID_REFERENCE_COLUMNS);
}

/** 写进 CSS 的单卡最小宽度：0.8 × W_o（带兜底下限） */
export function toolCardMinWidthPx(viewportWidth: number, gap = TOOL_GRID_GAP_PX): number {
  return Math.max(TOOL_GRID_MIN_PX, Math.round(toolCardReferenceWidthPx(viewportWidth, gap) * TOOL_GRID_MIN_RATIO));
}

/**
 * 与 CSS auto-fill 同口径：在给定容器宽度下，「每列不低于 min」的最大列数。
 * 列宽 = (容器宽 - (列数-1) × gap) / 列数。
 */
export function toolCardColumns(containerWidth: number, viewportWidth: number, gap = TOOL_GRID_GAP_PX): number {
  if (!(containerWidth > 0)) return 1;
  const min = toolCardMinWidthPx(viewportWidth, gap);
  return Math.max(1, Math.floor((containerWidth + gap) / (min + gap)));
}
