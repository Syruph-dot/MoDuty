import { useEffect, useRef } from "react";

import ApprovalPanel from "./components/ApprovalPanel";
import ContextMenu from "./components/ContextMenu";
import ControlBar from "./components/ControlBar";
import Desktop from "./components/Desktop";
import NewAgentDialog from "./components/NewAgentDialog";
import ConfirmDialog from "./components/ConfirmDialog";
import SettingsDialog from "./components/SettingsDialog";
import WallpaperDialog from "./components/WallpaperDialog";
import { useAgentsStore } from "./state/agentsStore";
import { applyWallpaperTo } from "./state/wallpaperStore";

/**
 * Arona Chest：
 * 全屏磁贴墙 + 浮动控制条；
 * 双击磁贴 → 打开（进入分屏：未打开磁贴收缩进左坞，该磁贴在右舞台展开，SSE 流式对话）；
 * 展开窗口 × / 拖到左坞 → 收起；
 * 任一 Agent 进入 waiting_approval 时浮出审批面板；
 * 桌面空白处右键 → 弹出菜单（New Agent / Refresh / Change wallpaper）；
 * 顶层的 NewAgentDialog / WallpaperDialog 与 ContextMenu 由 store 控制。
 */
export default function App() {
  const openAgent = useAgentsStore((state) => state.openAgent);

  // 把当前 wallpaper 应用到 .desktop-shell 上，并订阅 store 变化
  const shellRef = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    return applyWallpaperTo(shellRef.current);
  }, []);

  return (
    <div className="desktop-shell" ref={shellRef}>
      <ControlBar />
      <Desktop onOpen={(candidate) => openAgent(candidate.id)} />
      <ApprovalPanel />
      <ContextMenu />
      <NewAgentDialog />
      <ConfirmDialog />
      <SettingsDialog />
      <WallpaperDialog />
    </div>
  );
}