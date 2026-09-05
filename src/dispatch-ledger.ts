import { readFile } from "node:fs/promises";
import path from "node:path";

import { atomicWriteJson, withFileLock } from "./write-queue.js";

/**
 * 派发台账（Dispatch Ledger）：记录「值日生 → 执行者」的派发关系与跟踪状态。
 *
 * 设计：
 * - 一次派发 = 值日生（dispatcher）通过 MOMOKA CLI 向某执行 Agent 下发任务；
 * - 每条记录进入 tracking；执行者 completed 时标记 done（投递成功并停止跟踪）；
 * - 执行者 error 时保留 tracking，持续跟踪后续状态变化，直到最终 completed；
 * - 持久化到 memory/.dispatches.json（原子写 + 文件锁）。
 *
 * 本模块只做数据层；「何时记录 / 何时投递」由调用方（tools / orchestration）决定。
 */

export interface DispatchRecord {
  id: string;
  /** 派发者 Agent（值日生） */
  dispatcherId: string;
  /** 派发者绑定的会话（投递消息写入目标） */
  dispatcherSessionId: string;
  /** 执行者 Agent */
  targetAgentId: string;
  /** 执行者绑定的会话（&ses_ 链接对象） */
  targetSessionId: string;
  /** 任务书（截断保存，仅溯源用） */
  task: string;
  /** 派发携带的择优资源句柄（&ses_…） */
  linkedSessions: string[];
  dispatchedAt: string;
  /** tracking=等待终态；done=已成功收尾（停止投递） */
  state: "tracking" | "done";
  lastStatus?: "completed" | "error";
  lastStatusAt?: string;
}

function shortId(prefix: string): string {
  return `${prefix}_${crypto.randomUUID().replace(/-/g, "").slice(0, 12)}`;
}

export class DispatchLedger {
  private readonly file: string;

  constructor(memoryDir: string) {
    this.file = path.join(memoryDir, ".dispatches.json");
  }

  async listAll(): Promise<DispatchRecord[]> {
    try {
      const parsed = JSON.parse(await readFile(this.file, "utf8")) as unknown;
      return Array.isArray(parsed) ? (parsed as DispatchRecord[]) : [];
    } catch {
      return [];
    }
  }

  /** 目标执行者的 active（tracking）派发记录；通常每个执行者最多一条 */
  async activeForTarget(targetAgentId: string): Promise<DispatchRecord[]> {
    const all = await this.listAll();
    return all.filter((record) => record.targetAgentId === targetAgentId && record.state === "tracking");
  }

  /** 记录一次派发；同 dispatcher→target 已有 tracking 记录时复用（追加轮次信息） */
  async record(input: Omit<DispatchRecord, "id" | "state" | "dispatchedAt">): Promise<DispatchRecord> {
    return await withFileLock(this.file, async () => {
      const all = await this.listAll();
      const now = new Date().toISOString();
      const existing = all.find(
        (record) =>
          record.dispatcherId === input.dispatcherId &&
          record.targetAgentId === input.targetAgentId &&
          record.state === "tracking",
      );
      if (existing) {
        const updated: DispatchRecord = {
          ...existing,
          task: input.task || existing.task,
          linkedSessions: [...new Set([...existing.linkedSessions, ...input.linkedSessions])],
          lastStatus: undefined,
          lastStatusAt: undefined,
        };
        await atomicWriteJson(this.file, all.map((record) => (record.id === existing.id ? updated : record)));
        return updated;
      }
      const record: DispatchRecord = {
        ...input,
        id: shortId("dsp"),
        state: "tracking",
        dispatchedAt: now,
      };
      await atomicWriteJson(this.file, [record, ...all]);
      return record;
    });
  }

  /** 更新某条派发的跟踪状态；返回更新后的记录（不存在返回 null） */
  async updateStatus(dispatchId: string, status: "completed" | "error", done = false): Promise<DispatchRecord | null> {
    return await withFileLock(this.file, async () => {
      const all = await this.listAll();
      let updated: DispatchRecord | null = null;
      const next = all.map((record) => {
        if (record.id !== dispatchId) {
          return record;
        }
        updated = {
          ...record,
          lastStatus: status,
          lastStatusAt: new Date().toISOString(),
          ...(done ? { state: "done" as const } : {}),
        };
        return updated;
      });
      if (!updated) {
        return null;
      }
      await atomicWriteJson(this.file, next);
      return updated;
    });
  }

  /** 清理指定执行者的 tracking 记录（Agent 删除/重置时调用） */
  async dropByTarget(targetAgentId: string): Promise<void> {
    return await withFileLock(this.file, async () => {
      const all = await this.listAll();
      const next = all.filter((record) => !(record.targetAgentId === targetAgentId && record.state === "tracking"));
      if (next.length !== all.length) {
        await atomicWriteJson(this.file, next);
      }
    });
  }
}
