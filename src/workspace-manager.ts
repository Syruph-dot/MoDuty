import { stat } from "node:fs/promises";
import path from "node:path";

import { ApprovalStore } from "./approvals.js";
import { MomokaHttpError } from "./http-error.js";

/**
 * Workspace 运行时管理器。
 *
 * 现状：每个 Agent 的 workspace 只是 AgentRecord.workspaceDir 一个目录字符串，
 * 加上散落各处的 ApprovalStore(record.workspaceDir)。本模块把这些收敛成单一入口，
 * 为后续桌面端「每 workspace 的 skill / MCP / memory」扩展预留落点——
 * 在它还小的时候就抽出来，避免长成巨石模块。
 *
 * 边界：只负责 workspace 资源句柄与目录校验；业务编排（审批联动、续跑）
 * 属于 http/agent-orchestration，不在这里。
 */
export class WorkspaceManager {
  private readonly approvalStores = new Map<string, ApprovalStore>();

  /** 解析并校验 workspace 目录；不存在或不是目录时抛 400（对齐既有 HTTP 行为） */
  async resolve(workspaceDir: string): Promise<string> {
    const workspace = path.resolve(workspaceDir);
    const details = await stat(workspace).catch(() => null);
    if (!details?.isDirectory()) {
      throw new MomokaHttpError(400, `Directory does not exist: ${workspace}`);
    }
    return workspace;
  }

  /** 该 workspace 的审批存储（按目录缓存实例；目录必须存在） */
  async approvalStore(workspaceDir: string): Promise<ApprovalStore> {
    const workspace = await this.resolve(workspaceDir);
    let store = this.approvalStores.get(workspace);
    if (!store) {
      store = new ApprovalStore(workspace);
      this.approvalStores.set(workspace, store);
    }
    return store;
  }

  /** 是否存在待决审批；workspace 不可用（目录缺失/读取失败）时视为无 */
  async hasPendingApproval(workspaceDir: string): Promise<boolean> {
    try {
      const store = await this.approvalStore(workspaceDir);
      const approvals = await store.list();
      return approvals.some((approval) => approval.status === "pending");
    } catch {
      return false;
    }
  }
}
