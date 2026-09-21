import { readFile } from "node:fs/promises";
import path from "node:path";

import { atomicWriteJson, withFileLock } from "./write-queue.js";

/**
 * 派发台账（Dispatch Ledger）：记录「值日生 → 执行者」的派发关系与跟踪状态。
 *
 * 台账条目是收尾链路的**唯一事实源**（用户设计：值日生发现台账状态变化 → 判读 → 返工/上报）：
 *
 *   tracking（执行中）──执行者终态/停转──▶ awaiting_verdict（等待值日生判读）
 *   awaiting_verdict ──判「继续」──▶ tracking（continueCount+1，≤ DISPATCH_MAX_CONTINUE）
 *   awaiting_verdict ──判「交付/不可救」──▶ done（停止跟踪）
 *
 * agent 状态机只是它的传感器之一（执行者终态事件）+ 停转扫描器合成 stalled；
 * 所有状态写操作必须走本类的方法（转移合法性在此校验），调用方不得直改字段。
 *
 * 持久化到 memory/.dispatches.json（原子写 + 文件锁）。本模块只做数据层。
 */

export type DispatchEntryState = "tracking" | "awaiting_verdict" | "done";
/** 触发判读的原因：执行者正常完成 / 出错 / 停转扫描器合成 */
export type DispatchTrigger = "completed" | "error" | "stalled" | "verdict_unsettled";
/** 值日生判读出口：交付（上报用户）/ 继续（返工） */
export type DispatchVerdict = "deliver" | "continue";

/** 台账条目的终态判定（含系统强制交付与人工放弃） */
export type DispatchOutcome = DispatchVerdict | "deliver_forced" | "cancelled";

/** 「继续」轮次上限（2026-09-10 拍板决策 2） */
export const DISPATCH_MAX_CONTINUE = 3;

/**
 * 台账里保存的任务书上限（字符）。
 * 以前是 500，导致值日生页“展开台账”看不到完整任务书；提到与执行者输出上限（4000）一致。
 * 旧记录仍是写入时的长度（不会回填）。
 */
export const LEDGER_TASK_MAX_CHARS = 4000;

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
  state: DispatchEntryState;
  /** 最近一次触发判读的原因 / 最近进展（completed | error | stalled） */
  lastStatus?: DispatchTrigger;
  lastStatusAt?: string;
  /** 已执行「继续」的轮次数 */
  continueCount?: number;
  /** 最近一次判读的结论（deliver | continue | deliver_forced …） */
  lastVerdict?: DispatchOutcome;
  /** 老师原话（发起这次派发时的最新一条用户消息）——判读与状态卡的口径都以它为准，
   *  不是值日生概括的任务书 */
  askExcerpt?: string;
  /** 停转标记（写明检出时间；「继续」后清除） */
  stalledAt?: string;
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

  /** 目标执行者的 active（未 done）派发记录；通常每个执行者最多一条 */
  async activeForTarget(targetAgentId: string): Promise<DispatchRecord[]> {
    const all = await this.listAll();
    return all.filter((record) => record.targetAgentId === targetAgentId && record.state !== "done");
  }

  /** 记录一次派发；同 dispatcher→target 已有 active 记录时复用（重置回 tracking，追加轮次信息） */
  async record(input: Omit<DispatchRecord, "id" | "state" | "dispatchedAt">): Promise<DispatchRecord> {
    return await withFileLock(this.file, async () => {
      const all = await this.listAll();
      const now = new Date().toISOString();
      const existing = all.find(
        (record) =>
          record.dispatcherId === input.dispatcherId &&
          record.targetAgentId === input.targetAgentId &&
          record.state !== "done",
      );
      if (existing) {
        const updated: DispatchRecord = {
          ...existing,
          task: input.task || existing.task,
          linkedSessions: [...new Set([...existing.linkedSessions, ...input.linkedSessions])],
          state: "tracking",
          lastStatus: undefined,
          lastStatusAt: undefined,
          stalledAt: undefined,
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

  /** tracking → awaiting_verdict：执行者终态 / 停转检出后，等待值日生判读 */
  async markAwaitingVerdict(dispatchId: string, trigger: DispatchTrigger): Promise<DispatchRecord | null> {
    return await withFileLock(this.file, async () => {
      const all = await this.listAll();
      let updated: DispatchRecord | null = null;
      const next = all.map((record) => {
        if (record.id !== dispatchId || record.state !== "tracking") {
          return record;
        }
        updated = {
          ...record,
          state: "awaiting_verdict",
          lastStatus: trigger,
          lastStatusAt: new Date().toISOString(),
          ...(trigger === "stalled" ? { stalledAt: new Date().toISOString() } : {}),
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

  /** awaiting_verdict → tracking：值日生判「继续」，执行者返工 */
  async continueTracking(dispatchId: string): Promise<DispatchRecord | null> {
    return await withFileLock(this.file, async () => {
      const all = await this.listAll();
      let updated: DispatchRecord | null = null;
      const next = all.map((record) => {
        if (record.id !== dispatchId || record.state !== "awaiting_verdict") {
          return record;
        }
        updated = {
          ...record,
          state: "tracking",
          continueCount: (record.continueCount ?? 0) + 1,
          lastVerdict: "continue",
          stalledAt: undefined,
          lastStatusAt: new Date().toISOString(),
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

  /** awaiting_verdict → done：值日生判「交付」（或达上限强制上报），停止跟踪 */
  async markDone(dispatchId: string, verdict: DispatchOutcome): Promise<DispatchRecord | null> {
    return await withFileLock(this.file, async () => {
      const all = await this.listAll();
      let updated: DispatchRecord | null = null;
      const next = all.map((record) => {
        if (record.id !== dispatchId || record.state === "done") {
          return record;
        }
        updated = {
          ...record,
          state: "done",
          lastVerdict: verdict,
          lastStatusAt: new Date().toISOString(),
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

  /** 刷新 lastStatusAt（判读重唤醒的防抖：唤醒一次即刷新，下轮扫描重新计时） */
  async touch(dispatchId: string): Promise<DispatchRecord | null> {
    return await withFileLock(this.file, async () => {
      const all = await this.listAll();
      let updated: DispatchRecord | null = null;
      const next = all.map((record) => {
        if (record.id !== dispatchId) {
          return record;
        }
        updated = { ...record, lastStatusAt: new Date().toISOString() };
        return updated;
      });
      if (!updated) {
        return null;
      }
      await atomicWriteJson(this.file, next);
      return updated;
    });
  }

  /** 清理指定执行者的未完成记录（Agent 删除/重置时调用） */
  async dropByTarget(targetAgentId: string): Promise<void> {
    return await withFileLock(this.file, async () => {
      const all = await this.listAll();
      const next = all.filter((record) => !(record.targetAgentId === targetAgentId && record.state !== "done"));
      if (next.length !== all.length) {
        await atomicWriteJson(this.file, next);
      }
    });
  }
}
