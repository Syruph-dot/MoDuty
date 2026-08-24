import ControlBar from "./components/ControlBar";
import Desktop from "./components/Desktop";
import AgentWindow from "./components/AgentWindow";
import ApprovalPanel from "./components/ApprovalPanel";
import { useAgentsStore } from "./state/agentsStore";

/**
 * MOMOKA Agent Desktop：
 * 全屏磁贴墙 + 浮动控制条；双击磁贴 → 打开该 Agent 的对话窗口（SSE 流式）；
 * 任一 Agent 进入 waiting_approval 时浮出审批面板。
 */
export default function App() {
  const agent = useAgentsStore((state) => state.agents.find((candidate) => candidate.id === state.selectedAgentId) ?? null);
  const selectAgent = useAgentsStore((state) => state.selectAgent);
  return (
    <div className="desktop-shell">
      <ControlBar />
      <Desktop onOpen={(candidate) => selectAgent(candidate.id)} />
      <ApprovalPanel />
      {agent ? <AgentWindow key={agent.id} agent={agent} onClose={() => selectAgent(null)} /> : null}
    </div>
  );
}