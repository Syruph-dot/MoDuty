import { useCallback, useEffect, useRef } from "react";

import ApprovalPanel from "./components/ApprovalPanel";
import AgentFilterBar from "./components/AgentFilterBar";
import ArchivePanel from "./components/ArchivePanel";
import ContextMenu from "./components/ContextMenu";
import ControlBar from "./components/ControlBar";
import Desktop from "./components/Desktop";
import NewAgentDialog from "./components/NewAgentDialog";
import ConfirmDialog from "./components/ConfirmDialog";
import SettingsScreen from "./components/SettingsScreen";
import DutyScreen from "./components/widgets/DutyScreen";
import WallpaperDialog from "./components/WallpaperDialog";
import WidgetPickerCard from "./components/WidgetPickerCard";
import RenameWidgetDialog from "./components/RenameWidgetDialog";
import { useAgentsStore } from "./state/agentsStore";
import { useDialogStore } from "./state/dialogStore";
import { applyWallpaperTo } from "./state/wallpaperStore";
import { applyFontSourceLink } from "./state/tileThemeStore";

/**
 * MoDuty：
 * 全屏磁贴墙 + 浮动控制条；
 * 双击磁贴 → 打开（进入分屏：未打开磁贴收缩进左坞，该磁贴在右舞台展开，SSE 流式对话）；
 * 展开窗口 × / 拖到左坞 → 收起；
 * 任一 Agent 进入 waiting_approval 时浮出审批面板；
 * 桌面空白处右键 → 弹出菜单（New Agent / Add widget / Refresh / Change wallpaper）；
 * widget 磁贴（RingClock 等）永远 free 态，无 opened 生命周期；
 * 顶层的 NewAgentDialog / WidgetPickerCard / RenameWidgetDialog / ConfirmDialog / SettingsDialog / WallpaperDialog 与 ContextMenu 由 store 控制。
 */
export default function App() {
  const openAgent = useAgentsStore((state) => state.openAgent);
  const settingsOpen = useDialogStore((state) => state.settingsOpen);
  // 稳定回调：配合 Desktop/GroupedWall 内 AgentTile 的 memo，避免每次 App 渲染穿透更新全部磁贴
  const handleOpenAgent = useCallback(
    (candidate: { id: string }) => openAgent(candidate.id),
    [openAgent],
  );

  // 把当前 wallpaper 应用到 .desktop-shell 上，并订阅 store 变化
  const shellRef = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    return applyWallpaperTo(shellRef.current);
  }, []);

  // 外部字体资源（可配置）：有 fontSourceUrl 时注入 <link rel=stylesheet>
  useEffect(() => {
    return applyFontSourceLink();
  }, []);

  return (
    <div className="desktop-shell" ref={shellRef}>
      <ControlBar />
      {/* 治理栏仅限开始界面显示（设置页隐藏） */}
      {!settingsOpen ? <AgentFilterBar /> : null}
      <Desktop onOpen={handleOpenAgent} />
      <ArchivePanel />
      <ApprovalPanel />
      <ContextMenu />
      <NewAgentDialog />
      <WidgetPickerCard />
      <RenameWidgetDialog />
      <ConfirmDialog />
      <SettingsScreen />
      <DutyScreen />
      <WallpaperDialog />
    </div>
  );
}
