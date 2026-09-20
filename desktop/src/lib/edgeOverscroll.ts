import { useEffect, type RefObject } from "react";

/**
 * 边界越界效果（边界拖动反馈）：
 * - glow  ：滚到头继续拉 → 线性渐变光带从边缘长出来（贴边最实、向内线性变透明，无形状、内容不位移）
 * - stretch：滚到头继续拉 → 内容真的被拉出边界一段阻尼位移后弹回（橡皮筋位移，无填充条）
 *
 * 偏好持久化在 localStorage（纯界面观感，不进后端 settings.json）；
 * 设置页切换后通过模块内监听实时生效（attach 的 handler 每次滚轮事件都读当前模式）。
 */

export type EdgeOverscrollMode = "glow" | "stretch";

const STORAGE_KEY = "momoka:overscroll:effect";

function readPref(): EdgeOverscrollMode {
  try {
    return localStorage.getItem(STORAGE_KEY) === "stretch" ? "stretch" : "glow";
  } catch {
    return "glow";
  }
}

let current: EdgeOverscrollMode = typeof localStorage === "undefined" ? "glow" : readPref();
const listeners = new Set<(mode: EdgeOverscrollMode) => void>();

export function getOverscrollEffect(): EdgeOverscrollMode {
  return current;
}

export function setOverscrollEffect(mode: EdgeOverscrollMode): void {
  current = mode;
  try {
    localStorage.setItem(STORAGE_KEY, mode);
  } catch {
    // 存储不可用时仅本次会话生效
  }
  for (const listener of [...listeners]) {
    try {
      listener(mode);
    } catch {
      // 单个订阅者异常不影响其它订阅者
    }
  }
}

export function onOverscrollEffectChange(listener: (mode: EdgeOverscrollMode) => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/* ---------- attach 实现（原生 DOM，直接操作样式避免渲染抖动） ---------- */

const MAX_RAW_PX = 1600; // 原始拉量上限（数值保护）
const STRETCH_MAX_PX = 30; // stretch 模式最大位移（阻尼渐近线）
const GLOW_SCALE_PX = 420; // glow 强度的指数刻度（拉得越深弧越实）
const RELEASE_DELAY_MS = 160; // 滚轮停顿多久后弹回
const RELEASE_DURATION_MS = 320; // 弹回动画时长

interface PullState {
  top: number;
  bottom: number;
  releaseTimer: number | null;
  raf: number;
}

interface GlowLayer {
  el: HTMLDivElement;
  side: "top" | "bottom";
}

/**
 * 给一个垂直滚动容器挂上边界越界效果；返回清理函数。
 * getMode 在每次滚轮事件时读取（设置页切换后立即生效，无需重挂）。
 */
export function attachEdgeOverscroll(
  el: HTMLElement,
  getMode: () => EdgeOverscrollMode,
): () => void {
  const state: PullState = { top: 0, bottom: 0, releaseTimer: null, raf: 0 };
  const layers: GlowLayer[] = [];

  const ensureLayer = (side: "top" | "bottom"): HTMLDivElement => {
    const found = layers.find((layer) => layer.side === side);
    if (found) return found.el;
    const el2 = document.createElement("div");
    el2.setAttribute("aria-hidden", "true");
    el2.style.position = "fixed";
    el2.style.pointerEvents = "none";
    el2.style.zIndex = "60";
    el2.style.opacity = "0";
    el2.style.left = "0";
    el2.style.right = "0";
    document.body.appendChild(el2);
    const layer: GlowLayer = { el: el2, side };
    layers.push(layer);
    return el2;
  };
  ensureLayer("top");
  ensureLayer("bottom");

  const paintRect = (layer: GlowLayer): void => {
    const rect = el.getBoundingClientRect();
    const raw = layer.side === "top" ? state.top : state.bottom;
    const depth = 60 + 220 * intensityOf(raw);
    layer.el.style.left = `${rect.left}px`;
    layer.el.style.width = `${rect.width}px`;
    if (layer.side === "top") {
      layer.el.style.top = `${rect.top}px`;
      layer.el.style.bottom = "auto";
      // 贴边透明度最低（最实），向内线性铺开
      layer.el.style.background =
        "linear-gradient(to bottom, rgba(170, 200, 255, 0.38), rgba(170, 200, 255, 0.12) 45%, transparent 78%)";
    } else {
      layer.el.style.top = "auto";
      layer.el.style.bottom = `${Math.max(0, window.innerHeight - rect.bottom)}px`;
      layer.el.style.background =
        "linear-gradient(to top, rgba(170, 200, 255, 0.38), rgba(170, 200, 255, 0.12) 45%, transparent 78%)";
    }
    layer.el.style.height = `${depth}px`;
  };

  const intensityOf = (raw: number): number =>
    raw <= 0.01 ? 0 : 1 - Math.exp(-raw / GLOW_SCALE_PX);

  const paint = (): void => {
    const mode = getMode();
    if (mode === "stretch") {
      // Stretch：内容真的被拉出边界一段阻尼位移（橡皮筋），没有任何填充条/遮罩
      const dTop = STRETCH_MAX_PX * (1 - Math.exp(-state.top / 80));
      const dBottom = STRETCH_MAX_PX * (1 - Math.exp(-state.bottom / 80));
      el.style.transform = `translateY(${(dBottom - dTop).toFixed(2)}px)`;
      for (const layer of layers) layer.el.style.opacity = "0";
    } else {
      // Glow：简单线性渐变条，贴边透明度最低（最实）、向内线性铺开，无形状；内容不位移
      el.style.transform = "";
      for (const layer of layers) {
        const raw = layer.side === "top" ? state.top : state.bottom;
        const intensity = intensityOf(raw);
        if (intensity <= 0.001) {
          layer.el.style.opacity = "0";
          continue;
        }
        paintRect(layer);
        layer.el.style.opacity = (0.3 + 0.7 * intensity).toFixed(3);
      }
    }
  };

  const scheduleRelease = (): void => {
    if (state.releaseTimer !== null) window.clearTimeout(state.releaseTimer);
    state.releaseTimer = window.setTimeout(() => {
      state.releaseTimer = null;
      release();
    }, RELEASE_DELAY_MS);
  };

  const release = (): void => {
    const startTop = state.top;
    const startBottom = state.bottom;
    if (startTop <= 0.01 && startBottom <= 0.01) {
      clear();
      return;
    }
    if (state.raf) window.cancelAnimationFrame(state.raf);
    const start = performance.now();
    const step = (now: number): void => {
      const p = Math.min(1, (now - start) / RELEASE_DURATION_MS);
      const eased = 1 - Math.pow(1 - p, 3);
      state.top = startTop * (1 - eased);
      state.bottom = startBottom * (1 - eased);
      if (p < 1) {
        paint();
        state.raf = requestAnimationFrame(step);
      } else {
        clear();
      }
    };
    state.raf = requestAnimationFrame(step);
  };

  const clear = (): void => {
    if (state.releaseTimer !== null) {
      window.clearTimeout(state.releaseTimer);
      state.releaseTimer = null;
    }
    if (state.raf) {
      window.cancelAnimationFrame(state.raf);
      state.raf = 0;
    }
    state.top = 0;
    state.bottom = 0;
    el.style.transform = "";
    for (const layer of layers) layer.el.style.opacity = "0";
  };

  const pull = (side: "top" | "bottom", amount: number): void => {
    const other = side === "top" ? "bottom" : "top";
    state[other] = 0;
    state[side] = Math.max(0, Math.min(state[side] + Math.max(0, amount), MAX_RAW_PX));
    paint();
    scheduleRelease();
  };

  const onWheel = (event: WheelEvent): void => {
    // 横向滚动与缩放组合键不接管
    if (event.ctrlKey || Math.abs(event.deltaX) > Math.abs(event.deltaY)) return;
    const maxScroll = el.scrollHeight - el.clientHeight;
    if (maxScroll <= 0) return;
    const cur = el.scrollTop;
    const delta = event.deltaY;
    if (delta < 0) {
      if (cur <= 0) {
        event.preventDefault();
        pull("top", -delta);
        return;
      }
      const next = cur + delta;
      if (next < 0) {
        event.preventDefault();
        el.scrollTop = 0;
        pull("top", -next);
        return;
      }
      clear();
    } else if (delta > 0) {
      if (cur >= maxScroll) {
        event.preventDefault();
        pull("bottom", delta);
        return;
      }
      const next = cur + delta;
      if (next > maxScroll) {
        event.preventDefault();
        el.scrollTop = maxScroll;
        pull("bottom", next - maxScroll);
        return;
      }
      clear();
    }
  };

  const onResize = (): void => paint();
  // 模式切换瞬间清掉残留的拉取状态/图层（避免旧模式视觉滞留）
  const offModeChange = onOverscrollEffectChange(() => clear());
  el.addEventListener("wheel", onWheel, { passive: false });
  window.addEventListener("resize", onResize);
  return () => {
    offModeChange();
    el.removeEventListener("wheel", onWheel);
    window.removeEventListener("resize", onResize);
    clear();
    for (const layer of layers) layer.el.remove();
    layers.length = 0;
  };
}

/** React 封装：给滚动容器挂上当前偏好的边界效果（设置切换实时生效） */
export function useEdgeOverscroll(ref: RefObject<HTMLElement | null>): void {
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    return attachEdgeOverscroll(el, getOverscrollEffect);
  }, [ref]);
}
