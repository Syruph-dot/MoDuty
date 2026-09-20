import { useEffect, useState } from "react";
import { createPortal } from "react-dom";

import { subscribeDutyEvents, type DispatchVerdictEvent } from "../lib/dutyEvents";

/**
 * 值日生判读上报（A6，拍板：桌面弹窗）：收到 dispatch_verdict 事件时弹出右下角 toast。
 * 会话内的 system 留痕与桌面 toast 双通道——toast 会被自动关掉，留痕永久可查。
 */

interface Toast {
  id: string;
  title: string;
  body: string;
  tone: "deliver" | "continue";
}

function toastFor(event: DispatchVerdictEvent): Toast {
  if (event.verdict === "deliver") {
    return {
      id: `${event.dispatch_id}-deliver-${Date.now()}`,
      title: "值日生上报：任务可交付",
      body: `${event.task}${event.note ? ` — ${event.note}` : ""}`,
      tone: "deliver",
    };
  }
  return {
    id: `${event.dispatch_id}-continue-${event.continue_count}-${Date.now()}`,
    title: `值日生：已安排返工（${event.continue_count}/3）`,
    body: `${event.task}${event.note ? ` — ${event.note}` : ""}`,
    tone: "continue",
  };
}

const toneStyle: Record<Toast["tone"], { border: string; badge: string; badgeBg: string }> = {
  deliver: { border: "rgba(94, 196, 130, 0.55)", badge: "rgb(126, 231, 165)", badgeBg: "rgba(38, 92, 60, 0.92)" },
  continue: { border: "rgba(240, 180, 90, 0.55)", badge: "rgb(250, 208, 122)", badgeBg: "rgba(112, 82, 30, 0.92)" },
};

export default function VerdictToasts() {
  const [toasts, setToasts] = useState<Toast[]>([]);

  useEffect(() => {
    return subscribeDutyEvents((event) => {
      if (event.type !== "dispatch_verdict") return;
      const toast = toastFor(event);
      setToasts((prev) => [...prev.slice(-3), toast]);
      setTimeout(() => {
        setToasts((prev) => prev.filter((item) => item.id !== toast.id));
      }, 9000);
    });
  }, []);

  if (toasts.length === 0) return null;

  return createPortal(
    <div
      style={{
        position: "fixed",
        right: 18,
        bottom: 18,
        display: "flex",
        flexDirection: "column",
        gap: 10,
        zIndex: 9999,
      }}
    >
      {toasts.map((toast) => {
        const tone = toneStyle[toast.tone];
        return (
          <div
            key={toast.id}
            style={{
              width: 320,
              padding: "12px 14px",
              borderRadius: 12,
              background: "rgba(18, 22, 30, 0.96)",
              border: `1px solid ${tone.border}`,
              boxShadow: "0 12px 32px rgba(0, 0, 0, 0.45)",
              color: "rgba(232, 237, 247, 0.94)",
              fontSize: 13,
              lineHeight: 1.5,
              wordBreak: "break-all",
            }}
          >
            <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 6 }}>
              <span
                style={{
                  padding: "2px 8px",
                  borderRadius: 999,
                  fontSize: 11,
                  color: tone.badge,
                  background: tone.badgeBg,
                  whiteSpace: "nowrap",
                }}
              >
                {toast.tone === "deliver" ? "可交付" : "返工"}
              </span>
              <strong style={{ fontSize: 13 }}>{toast.title}</strong>
            </div>
            <div style={{ color: "rgba(232, 237, 247, 0.72)" }}>{toast.body}</div>
          </div>
        );
      })}
    </div>,
    document.body,
  );
}
