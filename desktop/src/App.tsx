import AgentWindow from "./components/AgentWindow";
import ApprovalPanel from "./components/ApprovalPanel";
import ContextMenu from "./components/ContextMenu";
import ControlBar from "./components/ControlBar";
import Desktop from "./components/Desktop";
import NewAgentDialog from "./components/NewAgentDialog";
import { useAgentsStore } from "./state/agentsStore";

/**
 * MOMOKA Agent Desktop：
 * 全屏磁贴墙 + 浮动控制条；
 * 双击磁贴 → 打开该 Agent 的对话窗口（SSE 流式）；
 * 任一 Agent 进入 waiting_approval 时浮出审批面板；
 * 桌面空白处右键 → 弹出菜单（仅 New Agent 一项）；
 * 顶层的 NewAgentDialog 与 ContextMenu 由 store 控制，桌面只在事件点注入数据。
 */
export default function App() {
  const agent = useAgentsStore((state) => state.agents.find((candidate) => candidate.id === state.selectedAgentId) ?? null);
  const selectAgent = useAgentsStore((state) => state.selectAgent);
  return (
    <div className="desktop-shell">
      <ControlBar />
      <Desktop onOpen={(candidate) => selectAgent(candidate.id)} />
      <ApprovalPanel />
      <ContextMenu />
      <NewAgentDialog />
      {agent ? <AgentWindow key={agent.id} agent={agent} onClose={() => selectAgent(null)} /> : null}
    </div>
  );
}
