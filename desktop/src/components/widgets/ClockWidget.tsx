import { useEffect, useRef } from "react";

/**
 * RingClock —— 连续平滑圆环时钟（移植自 clock.html）。
 * 5 层同心圆环：月 / 日 / 时 / 分 / 秒，由外到内半径 1.25 倍递减。
 * 用 requestAnimationFrame 毫秒级连续渲染 + 指数平滑，使指针过渡顺滑
 * （月份保留 12→1 的循环跳变）。纯展示，无交互。
 */

const RINGS = [
  { key: "month", r: 210, max: 12, color: "#ff6b6b" },
  { key: "day", r: 168, max: 31, color: "#ffca3a" },
  { key: "hour", r: 134.4, max: 24, color: "#4ecdc4" },
  { key: "minute", r: 110, max: 60, color: "#55a6ff" },
  { key: "second", r: 86, max: 60, color: "#c77dff" },
] as const;

const STROKE_W = 12;
const SMOOTHING_PARAM = 0.1;

/** 圆环中心（与各 ring 共用 viewBox 0 0 480 480） */
const CENTER = 240;

export default function ClockWidget() {
  const ringRefs = useRef<Record<string, SVGCircleElement | null>>({});
  // 每环上一帧的平滑值（用于指数平滑）
  const prevRef = useRef<Record<string, number>>({});

  useEffect(() => {
    let raf = 0;

    const setRing = (key: string, r: number, max: number, val: number) => {
      const el = ringRefs.current[key];
      if (!el) return;
      const total = 2 * Math.PI * r;
      const prev = prevRef.current[key] ?? val;
      // 已修复无平滑问题
      const smoothed = (1 - SMOOTHING_PARAM) * prev + SMOOTHING_PARAM * val;
      prevRef.current[key] = smoothed;
      el.style.strokeDasharray = `${total}`;
      el.style.strokeDashoffset = `${total - (smoothed / max) * total}`;
    };

    const render = () => {
      const now = new Date();
      const ms = now.getMilliseconds();

      const month = now.getMonth() + 1;
      const dayFrac =
        now.getDate() - 1 +
        (now.getHours() * 3600 + now.getMinutes() * 60 + now.getSeconds() + ms / 1000) / 86400;
      const hourFrac = now.getHours() + now.getMinutes() / 60 + now.getSeconds() / 3600 + ms / 3600000;
      const minFrac = now.getMinutes() + now.getSeconds() / 60 + ms / 60000;
      const secFrac = now.getSeconds() + ms / 1000;
      
      setRing("month", 210, 12, month);
      setRing("day", 168, 31, dayFrac);
      setRing("hour", 134.4, 24, hourFrac);
      setRing("minute", 110, 60, minFrac);
      setRing("second", 86, 60, secFrac);

      raf = requestAnimationFrame(render);
    };

    raf = requestAnimationFrame(render);
    return () => cancelAnimationFrame(raf);
  }, []);

  return (
    <div className="clock-widget">
      <svg viewBox="0 0 480 480" className="clock-widget__svg" preserveAspectRatio="xMidYMid meet">
        <g transform={`rotate(-90 ${CENTER} ${CENTER})`}>
          {RINGS.map((ring) => (
            <g key={ring.key}>
              <circle
                ref={(el) => {
                  ringRefs.current[ring.key] = el;
                }}
                className="clock-widget__value"
                cx={CENTER}
                cy={CENTER}
                r={ring.r}
                style={{ stroke: ring.color, strokeWidth: STROKE_W }}
              />
            </g>
          ))}
        </g>
      </svg>
    </div>
  );
}
