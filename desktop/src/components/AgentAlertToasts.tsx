import { useEffect, useState } from "react";
import { createPortal } from "react-dom";

import {
  openAgentFromAlert,
  subscribeAgentAlerts,
  type AgentAlert,
} from "../lib/agentAlerts";

/**
 * 「Agent 在等你」桌面提示（右下角 toast）。
 *
 * 为什么除了 OS 通知还要一个应用内提示：OS 通知会被系统勿扰/通知权限挡住，
 * 浏览器里权限还得靠用户手势才能拿到，静默失败时用户完全无感——
 * 于是「明明有待答提问却什么都没弹」。应用内 toast 不依赖任何系统权限，一定看得见。
 * 点「打开窗口」直接跳到那个 Agent 的问答卡。
 */

const AUTO_DISMISS_MS = 20_000;

const tone = {
  border: "rgba(255, 176, 84, 0.6)",
  badge: "rgb(255, 205, 138)",
  badgeBg: "rgba(120, 78, 24, 0.92)",
  buttonBg: "rgba(79, 140, 255, 0.9)",
};

export default function AgentAlertToasts() {
  const [alerts, setAlerts] = useState<AgentAlert[]>([]);

  useEffect(() => {
    const timers = new Map<string, number>();
    const unsubscribe = subscribeAgentAlerts((event) => {
      if (event.type === "dismiss") {
        setAlerts((prev) => prev.filter((item) => item.agentId !== event.agentId));
        for (const [id, timer] of timers) {
          if (id.startsWith(`${event.agentId}:`)) {
            window.clearTimeout(timer);
            timers.delete(id);
          }
        }
        return;
      }
      const alert = event.alert;
      setAlerts((prev) => (prev.some((item) => item.id === alert.id) ? prev : [...prev.slice(-2), alert]));
      if (!timers.has(alert.id)) {
        timers.set(
          alert.id,
          window.setTimeout(() => {
            timers.delete(alert.id);
            setAlerts((prev) => prev.filter((item) => item.id !== alert.id));
          }, AUTO_DISMISS_MS),
        );
      }
    });
    return () => {
      unsubscribe();
      for (const timer of timers.values()) window.clearTimeout(timer);
    };
  }, []);

  if (alerts.length === 0) return null;

  return createPortal(
    <div
      style={{
        position: "fixed",
        right: 18,
        // 让开右下角的判读 toast（VerdictToasts 也在 bottom: 18）
        bottom: 18,
        marginBottom: 96,
        display: "flex",
        flexDirection: "column",
        gap: 10,
        zIndex: 9998,
      }}
    >
      {alerts.map((alert) => (
        <div
          key={alert.id}
          role="alert"
          style={{
            width: 330,
            padding: "11px 13px",
            borderRadius: 10,
            background: "rgba(22, 26, 38, 0.96)",
            border: `1px solid ${tone.border}`,
            boxShadow: "0 10px 26px rgba(0, 0, 0, 0.42)",
            display: "flex",
            flexDirection: "column",
            gap: 8,
          }}
        >
          <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
            <span
              style={{
                fontSize: 10,
                fontWeight: 700,
                letterSpacing: 0.4,
                padding: "2px 7px",
                borderRadius: 999,
                background: tone.badgeBg,
                color: tone.badge,
              }}
            >
              {alert.state === "requiring_input" ? "等你回答" : "等你审批"}
            </span>
            <strong style={{ fontSize: 13, color: "#e8edf7" }}>{alert.name}</strong>
          </div>
          <p style={{ margin: 0, fontSize: 12, lineHeight: 1.55, color: "rgba(232, 237, 247, 0.72)" }}>
            {alert.state === "requiring_input"
              ? "有一条提问等你作答，打开窗口选一项或输入自定义答案。"
              : "有一条待审批的操作，打开窗口即可处理。"}
          </p>
          <div style={{ display: "flex", gap: 8, justifyContent: "flex-end" }}>
            <button
              type="button"
              onClick={() => setAlerts((prev) => prev.filter((item) => item.id !== alert.id))}
              style={{
                padding: "4px 10px",
                borderRadius: 7,
                border: "1px solid rgba(255,255,255,0.16)",
                background: "transparent",
                color: "rgba(232,237,247,0.7)",
                fontSize: 12,
                cursor: "pointer",
              }}
            >
              知道了
            </button>
            <button
              type="button"
              onClick={() => openAgentFromAlert(alert.agentId)}
              style={{
                padding: "4px 12px",
                borderRadius: 7,
                border: "none",
                background: tone.buttonBg,
                color: "#fff",
                fontSize: 12,
                fontWeight: 600,
                cursor: "pointer",
              }}
            >
              打开窗口
            </button>
          </div>
        </div>
      ))}
    </div>,
    document.body,
  );
}
