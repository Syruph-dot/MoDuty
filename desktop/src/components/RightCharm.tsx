import { useEffect, useRef, useState } from "react";
import { useAgentsStore } from "../state/agentsStore";
import { useBrowserStore } from "../state/browserStore";
import { useWindowManagerStore } from "../state/windowManagerStore";

/**
 * 右栏（45px，Windows 8 charms 风格，鼠标到右边缘唤出/移开收回）：
 * - 仅提供「打开/关闭模态」切换——视觉层面切换当前视图，不导航、不销毁数据
 * - off = 自由网格磁贴墙；on = 打开态分屏（左坞 + 右舞台 + 左栏列表）
 * - 尚无任何打开窗口时不允许进入空 on 模态
 *
 * 图标：直接嵌入 parametric_curve_clean.html 的 canvas 参数曲线。
 * - 所有参数与关键帧原样复原（KF / DURATION=8000 / easeTheta / easeB / easeTRange /
 *   getParams / calcXY / drawCurve：N=500、lineWidth=8、端点光晕 24、hsl(200,68%,…)）
 * - 内部缓冲 120×120（scale=120/6=20，与原稿 720 画布画面比例一致），CSS 缩放到按钮方形
 */

/* ── 参数曲线可调参数（原稿参数全部保留；按需调整这里）── */
const CURVE_CFG = {
  /* 动画节奏：progress 0→1 用时；原稿 8000ms，压到 300ms；减速缓动 ease-out cubic */
  DURATION_MS: 600,
  EASE_OUT_POWER: 3,
  /* 曲线几何：缩放到 90%，线宽加粗到 110%（8 → 8.8） */
  SCALE_RATIO: 0.9,
  LINE_WIDTH: 8.8,
  /* 关键帧（原文 KF 原样） */
  KF: {
    theta0: 17.66 - 2 * Math.PI,
    theta1: 13.15,
    b0: 0.5,
    b1: 2,
    p: -0.44,
    tStart0: Math.PI,
    tEnd0: Math.PI,
    tStart1: 2 * Math.PI,
    tEnd1: 4 * Math.PI,
  },
  /* 绘制亮度（原稿 hue 200 / sat 68 / light 12+63·t^0.7 / 光晕 0.4-0.6） */
  HUE: 200,
  SAT: 85,
  LIGHT_BASE: 30,
  LIGHT_RANGE: 70,
  /* 端点圆形光减亮 */
  GLOW_ALPHA_TAIL: 0.3,
  GLOW_ALPHA_TIP: 0.42,
  GLOW_RADIUS: 24,
};

export default function RightCharm() {
  const mode = useWindowManagerStore((state) => state.mode);
  const toggleMode = useWindowManagerStore((state) => state.toggleMode);
  const openAgentIds = useAgentsStore((state) => state.openAgentIds);
  const openBrowserIds = useBrowserStore((state) => state.openBrowserIds);
  const [open, setOpen] = useState(false);
  const opening = mode === "on";
  const hasOpen = openAgentIds.length + openBrowserIds.length > 0;
  const cvRef = useRef<HTMLCanvasElement | null>(null);

  const blockedByEmpty = !opening && !hasOpen;
  const label = blockedByEmpty
    ? "尚无打开的窗口（双击磁贴或从左栏打开）"
    : opening
      ? "关闭模态"
      : "打开模态";

  const onToggle = () => {
    if (blockedByEmpty) return;
    toggleMode();
  };

  /* ── 复原 parametric_curve_clean.html 全部参数与关键帧动画；右栏唤出时启动，收回停止 ── */
  useEffect(() => {
    if (!open) return; // 右栏收回时停（不运行）
    const cv = cvRef.current!;
    const ctx = cv.getContext("2d")!;

    const { KF, DURATION_MS, EASE_OUT_POWER, SCALE_RATIO, HUE, SAT, LIGHT_BASE, LIGHT_RANGE, GLOW_ALPHA_TAIL, GLOW_ALPHA_TIP, LINE_WIDTH, GLOW_RADIUS } =
      CURVE_CFG;
    let progress = 0;
    let lastTime = 0;

    function easeTheta(u: number) {
      return u < 0.5 ? 2 * u * u : 1 - 2 * (1 - u) * (1 - u);
    }
    function easeB(u: number) {
      if (u < 0.4) return (u / 0.4) ** 3 * 0.064;
      const v = (u - 0.4) / 0.6;
      return 0.064 + 0.936 * (1 - (1 - v) * (1 - v));
    }
    function easeTRange(u: number) {
      if (u < 0.3) return (u / 0.3) ** 2 * 0.3;
      const v = (u - 0.3) / 0.7;
      return 0.3 + 0.7 * v * (2 - v);
    }
    function lerp(a: number, b: number, t: number) {
      return a + (b - a) * t;
    }
    function getParams(u: number) {
      return {
        theta: lerp(KF.theta0, KF.theta1, easeTheta(u)),
        b: lerp(KF.b0, KF.b1, easeB(u)),
        p: KF.p,
        tMin: lerp(KF.tStart0, KF.tStart1, easeTRange(u)),
        tMax: lerp(KF.tEnd0, KF.tEnd1, easeTRange(u)),
      };
    }
    function calcXY(t: number, th: number, b: number, p: number) {
      const sb = Math.sqrt(b);
      return [
        sb * Math.sin(t - th),
        -sb * Math.sin(p) * Math.cos(t - th) +
          Math.cos(p) * (Math.sqrt(1 + b * Math.cos(t) ** 2) - Math.sqrt(1 + b * Math.sin(t) ** 2)),
      ];
    }
    function drawCurve(p: ReturnType<typeof getParams>, cx: number, cy: number, s: number) {
      if (p.tMax <= p.tMin) {
        const [x, y] = calcXY(0, p.theta, p.b, p.p);
        const g = ctx.createRadialGradient(cx + x * s, cy - y * s, 0, cx + x * s, cy - y * s, 8);
        g.addColorStop(0, `rgba(160,220,255,${GLOW_ALPHA_TAIL})`);
        g.addColorStop(1, "rgba(160,220,255,0)");
        ctx.fillStyle = g;
        ctx.beginPath();
        ctx.arc(cx + x * s, cy - y * s, GLOW_RADIUS, 0, Math.PI * 2);
        ctx.fill();
        return;
      }
      const N = 500;
      const dt = (p.tMax - p.tMin) / N;
      for (let i = 0; i < N; i++) {
        const t0 = p.tMin + i * dt;
        const t1 = p.tMin + (i + 1) * dt;
        const [x0, y0] = calcXY(t0, p.theta, p.b, p.p);
        const [x1, y1] = calcXY(t1, p.theta, p.b, p.p);
        const tn = (t0 - p.tMin) / (p.tMax - p.tMin);
        ctx.strokeStyle = `hsl(${HUE},${SAT}%,${LIGHT_BASE + LIGHT_RANGE * Math.pow(tn, 0.7)}%)`;
        ctx.lineWidth = LINE_WIDTH;
        ctx.beginPath();
        ctx.moveTo(cx + x0 * s, cy - y0 * s);
        ctx.lineTo(cx + x1 * s, cy - y1 * s);
        ctx.stroke();
      }
      const [lx, ly] = calcXY(p.tMax, p.theta, p.b, p.p);
      const g = ctx.createRadialGradient(cx + lx * s, cy - ly * s, 0, cx + lx * s, cy - ly * s, 24);
      g.addColorStop(0, `rgba(160,220,255,${GLOW_ALPHA_TIP})`);
      g.addColorStop(1, "rgba(160,220,255,0)");
      ctx.fillStyle = g;
      ctx.beginPath();
      ctx.arc(cx + lx * s, cy - ly * s, GLOW_RADIUS, 0, Math.PI * 2);
      ctx.fill();
    }
    function loop(now: number) {
      if (!lastTime) lastTime = now;
      const dt = now - lastTime;
      lastTime = now;
      progress += dt / DURATION_MS;
      const u = Math.min(1, progress);
      // 减速缓动：ease-out，先快后慢
      const eased = 1 - Math.pow(1 - u, EASE_OUT_POWER);
      const p = getParams(eased);
      const W = cv.width;
      const H = cv.height;
      const cx = W / 2;
      const cy = H / 2;
      const scale = (Math.min(W, H) / 6) * SCALE_RATIO;
      ctx.clearRect(0, 0, W, H);
      drawCurve(p, cx, cy, scale);
      if (u >= 1) return; // one-shot：0→1 播放一次后停在终点
      requestAnimationFrame(loop);
    }
    const raf = requestAnimationFrame(loop);
    return () => cancelAnimationFrame(raf);
  }, [open]);

  return (
    <>
      {/* 右缘热区：hover 滑出 charm 条 */}
      <div
        className="wm-right-hotzone"
        onMouseEnter={() => setOpen(true)}
        aria-hidden="true"
      />
      <div
        className={`wm-charm-bar${open ? " wm-charm-bar--open" : ""}${opening ? " wm-charm-bar--on" : ""}`}
        onMouseEnter={() => setOpen(true)}
        onMouseLeave={() => setOpen(false)}
      >
        <button
          type="button"
          className="wm-charm__btn"
          onClick={onToggle}
          title={label}
          aria-label={label}
        >
          {/* 直接嵌入:动态参数曲线 canvas（草稿全部参数/关键帧已复原） */}
          <canvas ref={cvRef} className="wm-charm__cv" width={120} height={120} aria-hidden="true" />
        </button>
      </div>
    </>
  );
}