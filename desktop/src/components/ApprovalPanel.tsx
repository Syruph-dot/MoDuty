import { useEffect, useState } from "react";
import { useShallow } from "zustand/react/shallow";

import { awaitApiBase } from "../lib/api";
import { useAgentsStore } from "../state/agentsStore";

interface PendingApproval {
  id: string;
  toolName?: string;
  tool_name?: string;
  args?: Record<string, unknown> | string;
  status?: string;
  targetWorkspace?: string;
  requestedAt?: string;
}

const OPERATOR = "Desktop User";

function toolName(approval: PendingApproval): string {
  return approval.toolName ?? approval.tool_name ?? "tool";
}

function argsText(approval: PendingApproval): string {
  const raw = approval.args;
  if (typeof raw === "string") {
    return raw;
  }
  if (raw && typeof raw === "object") {
    return JSON.stringify(raw);
  }
  return "";
}

/**
 * 审批面板：任一 Agent 进入 waiting_approval 时浮出，
 * 列出该 Agent workspace 的 pending 审批（/api/approvals），
 * approved/rejected 走 /api/approvals/:id/decision；状态恢复由 SSE agent_state 驱动。
 */
export default function ApprovalPanel() {
  const waitingAgents = useAgentsStore(useShallow((state) => state.agents.filter((agent) => agent.state === "waiting_approval")));
  const [approvals, setApprovals] = useState<PendingApproval[]>([]);
  const [deciding, setDeciding] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const watchKey = waitingAgents.map((agent) => `${agent.id}:${agent.state}`).join(",");

  useEffect(() => {
    if (waitingAgents.length === 0) {
      setApprovals([]);
      return;
    }
    let cancelled = false;
    void (async () => {
      const base = await awaitApiBase();
      const found: PendingApproval[] = [];
      for (const agent of waitingAgents) {
        const params = new URLSearchParams({ work_dir: agent.workspace_dir });
        try {
          const res = await fetch(`${base}/api/approvals?${params.toString()}`);
          if (!res.ok) {
            continue;
          }
          const data = (await res.json()) as { approvals: PendingApproval[] };
          found.push(...data.approvals.filter((approval) => approval.status === "pending" || approval.status === undefined));
        } catch {
          // 后端不可达：下一次状态变化再试
        }
      }
      if (!cancelled) {
        setApprovals(found);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [watchKey, waitingAgents]);

  if (waitingAgents.length === 0) {
    return null;
  }

  const decide = async (approvalId: string, decision: "approved" | "rejected") => {
    setDeciding(approvalId);
    setError(null);
    try {
      const base = await awaitApiBase();
      const workspace = waitingAgents[0]?.workspace_dir ?? "";
      const res = await fetch(`${base}/api/approvals/${encodeURIComponent(approvalId)}/decision`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ decision, operator: OPERATOR, work_dir: workspace }),
      });
      if (!res.ok) {
        const body = await res.text();
        throw new Error(`decision failed: ${res.status} ${body.slice(0, 140)}`);
      }
      // 磁贴状态由 agent_state SSE 驱动翻转；本地先把该卡清掉防止重复决策
      setApprovals((prev) => prev.filter((approval) => approval.id !== approvalId));
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setDeciding(null);
    }
  };

  return (
    <aside className="approval-panel" role="dialog" aria-modal="false" aria-label="审批面板">
      <header className="approval-panel__head">
        <span className="state-dot state-dot--waiting" aria-hidden="true" />
        <h3 className="approval-panel__title">等待审批</h3>
        <span className="approval-panel__count">{approvals.length} pending</span>
      </header>

      {approvals.length === 0 ? (
        <p className="approval-panel__hint" role="status">
          正在加载审批…（状态由 Agent 实时事件驱动）
        </p>
      ) : (
        <ul className="approval-panel__list">
          {approvals.map((approval) => (
            <li key={approval.id} className="approval-card">
              <div className="approval-card__row">
                <span className="approval-card__tool">{toolName(approval)}</span>
                <code className="approval-card__args">{argsText(approval)}</code>
              </div>
              <div className="approval-card__actions">
                <button
                  type="button"
                  className="btn btn--ghost approval-card__reject"
                  disabled={deciding === approval.id}
                  onClick={() => void decide(approval.id, "rejected")}
                >
                  拒绝
                </button>
                <button
                  type="button"
                  className="btn btn--primary"
                  disabled={deciding === approval.id}
                  onClick={() => void decide(approval.id, "approved")}
                >
                  {deciding === approval.id ? "提交中…" : "批准"}
                </button>
              </div>
            </li>
          ))}
        </ul>
      )}

      {error ? <p className="approval-panel__error" role="alert">{error}</p> : null}
    </aside>
  );
}