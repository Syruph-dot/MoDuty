import ControlBar from "./components/ControlBar";
import Desktop from "./components/Desktop";
import { useAgentsStore } from "./state/agentsStore";

/**
 * MOMOKA Agent Desktop：
 * 全屏磁贴墙 + 浮动控制条；双击磁贴选中 Agent（对话窗口由后续步骤接入）。
 */
export default function App() {
  const selectAgent = useAgentsStore((state) => state.selectAgent);
  return (
    <div className="desktop-shell">
      <ControlBar />
      <Desktop onOpen={(agent) => selectAgent(agent.id)} />
    </div>
  );
}