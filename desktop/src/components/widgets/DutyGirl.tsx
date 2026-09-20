import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";

import { createDutyAgent, resolveDutyAgentId } from "../../lib/dutyAgent";
import { useAgentsStore } from "../../state/agentsStore";
import { DutyChatPanel, useDutyChat } from "./DutyChat";
import DutyPortrait from "./DutyPortrait";

/**
 * 值日生（Duty Girl）——调度者 Agent 的桌面形象（固定 2×3 磁贴）。
 *
 * 两个入口分工：
 * - 点立绘（上方 2/5 留在 DutyPortrait 里做摸头）→ 磁贴旁 330px 小对话框：一句话快捷指挥；
 * - 对话框里的「窗口 ↗」→ 打开值日生窗口（DutyWindow，走磁贴墙打开态：
 *   卡片进舞台、打开即居中、可拖、拖入左坞收起）。
 *
 * 对话框与窗口共用 DutyChat 的同一份消息状态与 SSE 逻辑。
 */

export default function DutyGirl() {
  const [agentId, setAgentId] = useState<string | null>(null);
  const [open, setOpen] = useState(false);
  const [dialogPos, setDialogPos] = useState<{ left: number; top: number } | null>(null);

  const rootRef = useRef<HTMLDivElement | null>(null);
  const agents = useAgentsStore((state) => state.agents);
  const openAgentById = useAgentsStore((state) => state.openAgent);
  const chat = useDutyChat(agentId);

  /*
   * 值日生 id 以“当前 agent 列表”为权威（kind=dispatcher），localStorage 只做辅助：
   * 缓存里的 id 必须能在列表里找到才用它。否则（旧库/已删除）走重建，
   * 避免出现“以为有值日生、点了却打不开任何卡片”。
   */
  const resolvedId = useMemo(() => resolveDutyAgentId(agents), [agents]);
  useEffect(() => {
    if (resolvedId) {
      setAgentId(resolvedId);
      return;
    }
    if (agents.length === 0) return; // 列表未就绪：先不创建，避免多开
    let alive = true;
    void createDutyAgent().then((id) => {
      if (alive && id) setAgentId(id);
    });
    return () => {
      alive = false;
    };
  }, [resolvedId, agents.length]);

  /* 对话框定位：贴磁贴右缘；视口放不下则放左缘。滚动/缩放时跟随。 */
  useEffect(() => {
    if (!open) return;
    const update = () => {
      const el = rootRef.current;
      if (!el) return;
      const rect = el.getBoundingClientRect();
      const W = 330;
      const side = rect.right + W + 12 <= window.innerWidth ? "right" : "left";
      const left = side === "right" ? rect.right + 12 : Math.max(8, rect.left - W - 12);
      const top = Math.max(8, Math.min(rect.top, window.innerHeight - 120));
      setDialogPos({ left, top });
    };
    update();
    const wall = document.querySelector(".tile-wall");
    wall?.addEventListener("scroll", update, { passive: true });
    window.addEventListener("resize", update);
    return () => {
      wall?.removeEventListener("scroll", update);
      window.removeEventListener("resize", update);
    };
  }, [open]);

  /* 打开其它磁贴（agent/browser/值日生窗口）时自动收起对话框 */
  useEffect(() => {
    const onTileOpened = () => {
      setOpen(false);
      setDialogPos(null);
    };
    window.addEventListener("momoka:tile-opened", onTileOpened);
    return () => window.removeEventListener("momoka:tile-opened", onTileOpened);
  }, []);

  const toggle = useCallback(() => {
    setOpen((prev) => {
      if (prev) {
        chat.abort();
        setDialogPos(null);
      }
      return !prev;
    });
  }, [chat]);

  /** 展开成值日生窗口：交给磁贴墙打开态（卡片进舞台、打开即居中） */
  const openWindow = useCallback(() => {
    setOpen(false);
    setDialogPos(null);
    if (agentId) openAgentById(agentId);
  }, [agentId, openAgentById]);

  const dialog =
    open && dialogPos
      ? createPortal(
          <div
            className="duty-dialog"
            style={{ left: dialogPos.left, top: dialogPos.top, width: 330, maxHeight: "min(60vh, 460px)" }}
            /* portal 的 React 合成事件会沿 React 树冒泡到 .tile-shell（onMouseDown=拖拽、onClick=展示），
               必须在此隔离，否则点 ×/输入框都会被磁贴壳层吞掉 */
            onMouseDown={(event) => event.stopPropagation()}
            onMouseUp={(event) => event.stopPropagation()}
            onClick={(event) => event.stopPropagation()}
            onDoubleClick={(event) => event.stopPropagation()}
            onPointerDown={(event) => event.stopPropagation()}
            onPointerUp={(event) => event.stopPropagation()}
            onKeyDown={(event) => event.stopPropagation()}
            onTouchStart={(event) => event.stopPropagation()}
          >
            <div className="duty-dialog__header">
              <span className="duty-dialog__title">值日生</span>
              <div className="duty-dialog__actions">
                <button
                  type="button"
                  className="duty-dialog__close"
                  aria-label="打开完整窗口"
                  title="打开值日生窗口（调度台账 / 待拍板 / 对话）"
                  disabled={!agentId}
                  onClick={openWindow}
                >
                  窗口 ↗
                </button>
                <button type="button" className="duty-dialog__close" aria-label="关闭" onClick={toggle}>
                  ×
                </button>
              </div>
            </div>
            <DutyChatPanel chat={chat} variant="dialog" onEscape={toggle} />
          </div>,
          document.body,
        )
      : null;

  return (
    <div className="duty-girl" ref={rootRef}>
      <button type="button" className="duty-girl__hit" onClick={toggle} aria-label="打开值日生对话框">
        <span className="duty-girl__portrait" aria-hidden="true">
          <DutyPortrait />
        </span>
        <span className="duty-girl__badge">值日生</span>
      </button>
      {dialog}
    </div>
  );
}
