import type { TileGeometry } from "../types";

/** 网格吸附的步长（px） */
export const SNAP_GRID = 8;

/** 边缘吸附的距离阈值（px）—— 中心 / 边 / 角 在此范围内会被吸过去 */
export const SNAP_THRESHOLD = 6;

export interface SnapResult {
  /** 吸附后的几何（已与其它磁贴 / 网格对齐） */
  geometry: TileGeometry;
  /** 吸附过程中产生的可视化参考线（用于 UI 显示"对齐辅助线"） */
  guides: SnapGuide[];
}

export type SnapGuideAxis = "v" | "h";
export type SnapGuideKind = "edge" | "center";

export interface SnapGuide {
  axis: SnapGuideAxis;
  /** 像素位置（vertical 模式为 x，horizontal 模式为 y） */
  position: number;
  kind: SnapGuideKind;
}

interface Candidate {
  value: number;
  kind: SnapGuideKind;
}

function buildVerticalCandidates(others: TileGeometry[]): Candidate[] {
  const out: Candidate[] = [{ value: 0, kind: "edge" }];
  for (const o of others) {
    out.push({ value: o.x, kind: "edge" });
    out.push({ value: o.x + o.w, kind: "edge" });
    out.push({ value: o.x + o.w / 2, kind: "center" });
  }
  return out;
}

function buildHorizontalCandidates(others: TileGeometry[]): Candidate[] {
  const out: Candidate[] = [{ value: 0, kind: "edge" }];
  for (const o of others) {
    out.push({ value: o.y, kind: "edge" });
    out.push({ value: o.y + o.h, kind: "edge" });
    out.push({ value: o.y + o.h / 2, kind: "center" });
  }
  return out;
}

function pickClosest(value: number, candidates: Candidate[], threshold: number): Candidate | null {
  let best: { candidate: Candidate; delta: number } | null = null;
  for (const c of candidates) {
    const delta = Math.abs(c.value - value);
    if (delta > threshold) continue;
    if (best === null || delta < best.delta) {
      best = { candidate: c, delta };
    }
  }
  return best?.candidate ?? null;
}

/** 按步长量化 */
export function snapValue(value: number, step: number = SNAP_GRID): number {
  return Math.round(value / step) * step;
}

/**
 * 把 geom 与其它磁贴的边/中心做边缘吸附；返回吸附后的几何 + 用于 UI 提示的 guides。
 * - shift 为 true 时强制只走网格吸附（不吸边）
 * - others 是同一桌面里所有其它磁贴的几何（不包含自身）
 *
 * 吸附策略：每个轴（X/Y）独立做 3 轮候选对齐 —— 左/右/中心边。
 * 中心对齐优先级最低（只有当边没有落入阈值内时才退而求其次）。
 */
export function snapGeometry(
  geom: TileGeometry,
  others: TileGeometry[],
  options: { shift?: boolean; grid?: number; threshold?: number } = {},
): SnapResult {
  const grid = options.grid ?? SNAP_GRID;
  const threshold = options.threshold ?? SNAP_THRESHOLD;

  // 1) 网格吸附（永远做，无论 shift 与否；shift 模式仅跳过边缘吸附）
  const snapped: TileGeometry = {
    x: snapValue(geom.x, grid),
    y: snapValue(geom.y, grid),
    w: snapValue(geom.w, grid),
    h: snapValue(geom.h, grid),
  };

  if (options.shift) {
    return { geometry: snapped, guides: [] };
  }

  const guides: SnapGuide[] = [];
  const verticals = buildVerticalCandidates(others);
  const horizontals = buildHorizontalCandidates(others);

  // 2) X 轴吸附
  const leftMatch = pickClosest(snapped.x, verticals, threshold);
  const rightMatch = pickClosest(snapped.x + snapped.w, verticals, threshold);
  if (leftMatch) {
    snapped.x = leftMatch.value;
    guides.push({ axis: "v", position: leftMatch.value, kind: leftMatch.kind });
  } else if (rightMatch) {
    snapped.x = rightMatch.value - snapped.w;
    guides.push({ axis: "v", position: rightMatch.value, kind: rightMatch.kind });
  } else {
    // 中心二次吸附
    const centerMatch = pickClosest(snapped.x + snapped.w / 2, verticals, threshold);
    if (centerMatch && centerMatch.kind === "center") {
      snapped.x = centerMatch.value - snapped.w / 2;
      guides.push({ axis: "v", position: centerMatch.value, kind: "center" });
    }
  }

  // 3) Y 轴吸附
  const topMatch = pickClosest(snapped.y, horizontals, threshold);
  const bottomMatch = pickClosest(snapped.y + snapped.h, horizontals, threshold);
  if (topMatch) {
    snapped.y = topMatch.value;
    guides.push({ axis: "h", position: topMatch.value, kind: topMatch.kind });
  } else if (bottomMatch) {
    snapped.y = bottomMatch.value - snapped.h;
    guides.push({ axis: "h", position: bottomMatch.value, kind: bottomMatch.kind });
  } else {
    const centerMatch = pickClosest(snapped.y + snapped.h / 2, horizontals, threshold);
    if (centerMatch && centerMatch.kind === "center") {
      snapped.y = centerMatch.value - snapped.h / 2;
      guides.push({ axis: "h", position: centerMatch.value, kind: "center" });
    }
  }

  // dedupe guides
  const seen = new Set<string>();
  const uniqueGuides: SnapGuide[] = [];
  for (const g of guides) {
    const key = `${g.axis}:${g.position}:${g.kind}`;
    if (seen.has(key)) continue;
    seen.add(key);
    uniqueGuides.push(g);
  }

  return { geometry: snapped, guides: uniqueGuides };
}
