import { useEffect, useRef, useState } from "react";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { useAgentsStore } from "../state/agentsStore";
import { useBrowserStore } from "../state/browserStore";
import { useWindowManagerStore } from "../state/windowManagerStore";
import { useDialogStore } from "../state/dialogStore";
import {
  IconArchive,
  IconClose,
  IconLayoutGrid,
  IconLayoutList,
  IconMinimize,
  IconPower,
  IconRefresh,
  IconSearch,
} from "./ui/icons";

/**
 * 右栏（45px，Windows 8 charms 风格，鼠标到右边缘唤出/移开收回）：
 * - 模态开关：off = 自由网格磁贴墙；on = 打开态整屏分屏（V2 左坞已删除）
 * - 磁贴墙治理入口（原左上角控制条那一组）：搜索筛选 / 归档库 / 视图切换
 * - 底部按钮族：应用窗口控制（hover 向左辐出扇面 = 检查更新 / 最小化 / 关闭）
 *   原来在屏幕右上角的浮动控制条（ControlBar）已删掉，窗口控制统一收在这里。
 * - 尚无任何打开窗口时不允许进入空 on 模态
 *
 * 图标：直接嵌入 parametric_curve_clean.html 的 canvas 参数曲线 + 自绘线性 SVG。
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
  /* 磁贴墙治理入口（原来在左上角控制条那一组，现挂在右栏） */
  const filterBarOpen = useAgentsStore((state) => state.filterBarOpen);
  const toggleFilterBar = useAgentsStore((state) => state.toggleFilterBar);
  const setArchiveOpen = useAgentsStore((state) => state.setArchiveOpen);
  const viewMode = useAgentsStore((state) => state.viewMode);
  const toggleViewMode = useAgentsStore((state) => state.toggleViewMode);
  const settingsOpen = useDialogStore((state) => state.settingsOpen);
  const dutyOpen = useDialogStore((state) => state.dutyOpen);
  const memoryOpen = useDialogStore((state) => state.memoryOpen);
  /** 页面（设置/值日生/记忆）打开时隐藏治理入口，与旧控制条行为一致 */
  const pageOpen = settingsOpen || dutyOpen || memoryOpen;
  const [open, setOpen] = useState(false);
  /** 窗口控制扇面：JS 控制开合（纯 CSS hover 在“从触发钮移到辐出钮”的路程中间会闪断） */
  const [sysFanOpen, setSysFanOpen] = useState(false);
  const sysFanTimer = useRef<number | null>(null);
  const openSysFan = () => {
    if (sysFanTimer.current !== null) {
      window.clearTimeout(sysFanTimer.current);
      sysFanTimer.current = null;
    }
    setSysFanOpen(true);
  };
  const closeSysFanSoon = () => {
    if (sysFanTimer.current !== null) window.clearTimeout(sysFanTimer.current);
    // 220ms 缓冲：足够指针从触发钮跨过空隙落到辐出钮上；落到就取消收合
    sysFanTimer.current = window.setTimeout(() => {
      sysFanTimer.current = null;
      setSysFanOpen(false);
    }, 220);
  };
  useEffect(() => () => {
    if (sysFanTimer.current !== null) window.clearTimeout(sysFanTimer.current);
  }, []);
  // 整个右栏收回时，扇面也跟着收（否则鼠标离开后扇面还会停在空中）
  useEffect(() => {
    if (!open) setSysFanOpen(false);
  }, [open]);

  /** v2 注入 __TAURI_INTERNALS__；v1 是 __TAURI__ */
  const inTauri =
    typeof window !== "undefined" &&
    ("__TAURI_INTERNALS__" in (window as unknown as Record<string, unknown>) || "__TAURI__" in window);

  /**
   * 检查更新：功能留空（占位，尚未接入更新源）。
   * 三个动作都先收扇面，避免点完最小化/关闭后扇面还留在屏上（窗口被最小化时收不到 mouseleave）。
   */
  const onCheckUpdate = () => {
    setSysFanOpen(false);
    // TODO(check-update): 留空——后续接 updater 后再实现
  };
  const minimizeWindow = () => {
    setSysFanOpen(false);
    if (inTauri) void getCurrentWindow().minimize();
  };
  const closeWindow = () => {
    setSysFanOpen(false);
    if (inTauri) void getCurrentWindow().close();
  };
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

        {/* 磁贴墙治理：从左上方控制条移过来（页面打开时隐藏） */}
        {pageOpen ? null : (
          <>
            <button
              type="button"
              className="wm-charm__btn wm-charm__btn--tool"
              aria-label="搜索与筛选（切换治理栏）"
              aria-pressed={filterBarOpen}
              title="搜索 / 筛选 / 排序"
              onClick={toggleFilterBar}
            >
              <IconSearch size={38} />
            </button>
            <button
              type="button"
              className="wm-charm__btn wm-charm__btn--tool"
              aria-label="打开归档库"
              title="归档库"
              onClick={() => setArchiveOpen(true)}
            >
              <IconArchive size={38} />
            </button>
            <button
              type="button"
              className="wm-charm__btn wm-charm__btn--tool"
              aria-label={viewMode === "grouped" ? "切换到桌面视图（自由磁贴）" : "切换到分组视图（按工作区）"}
              aria-pressed={viewMode === "grouped"}
              title={viewMode === "grouped" ? "桌面视图" : "分组视图"}
              onClick={toggleViewMode}
            >
              {viewMode === "grouped" ? <IconLayoutGrid size={38} /> : <IconLayoutList size={38} />}
            </button>
          </>
        )}

        {/* 底部按钮族：应用窗口控制（右上角那组已并入这里）。
            hover → 向左辐出扇面：左上=检查更新 / 左=最小化 / 左下=关闭。
            非 Tauri（纯浏览器 dev）也保留：便于调界面；两个窗口动作在非 Tauri 下为空操作。 */}
        <div
          className={`wm-charm__family${sysFanOpen ? " wm-charm__family--open" : ""}`}
          onMouseEnter={openSysFan}
          onMouseLeave={closeSysFanSoon}
          onFocus={openSysFan}
          onBlur={closeSysFanSoon}
        >
          <button
            type="button"
            className="wm-charm__btn wm-charm__btn--family"
            aria-label="窗口控制（检查更新 / 最小化 / 关闭）"
            aria-expanded={sysFanOpen}
            aria-haspopup="menu"
            title="窗口控制"
          >
            <IconPower size={40} />
          </button>
          <div className="wm-charm__fan" role="menu" aria-label="窗口控制">
            <button
              type="button"
              role="menuitem"
              className="wm-charm__fan-btn wm-charm__fan-btn--ul"
              title="检查更新"
              aria-label="检查更新"
              onClick={onCheckUpdate}
            >
              <IconRefresh size={20} />
            </button>
            <button
              type="button"
              role="menuitem"
              className="wm-charm__fan-btn wm-charm__fan-btn--l"
              title="最小化窗口"
              aria-label="最小化窗口"
              onClick={minimizeWindow}
            >
              <IconMinimize size={20} />
            </button>
            <button
              type="button"
              role="menuitem"
              className="wm-charm__fan-btn wm-charm__fan-btn--dl"
              title="关闭 MoDuty"
              aria-label="关闭 MoDuty"
              onClick={closeWindow}
            >
              <IconClose size={20} />
            </button>
          </div>
        </div>
      </div>
    </>
  );
}