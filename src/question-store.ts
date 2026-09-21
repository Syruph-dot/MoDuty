import { readFile } from "node:fs/promises";
import path from "node:path";

import { atomicWriteJson, withFileLock } from "./write-queue.js";

/**
 * 问答存储（Question Store）：持久化「Agent → 桌面用户」的结构化提问。
 *
 * 设计：
 * - 一次 ask_question 工具调用 = 一个 question set（含多题，单选，末位可自定义输入）；
 * - set 进入 pending；用户在桌面工具卡片内作答后提交 → answered；
 * - Agent 端由 pending 结果触发 requiring_input 状态，收到答案后由 orchestration 续跑；
 * - 持久化到 memory/.questions.json（原子写 + 文件锁），随 Agent 删除清理。
 *
 * 本模块只做数据层；「工具注册 / 状态转移 / 答案回写续跑」由调用方决定。
 */

export interface QuestionItem {
  prompt: string;
  options: string[];
}

/** 确认即执行的派发载荷：老师作答后系统自动派发，无需 Agent 再发起（2026-09-19 小微调拍板） */
export interface QuestionDispatchAction {
  /** 复用分支的目标执行者 */
  targetId: string;
  /** 任务书（老师确认后原样派发） */
  task: string;
  /** 老师选「新建」时使用该名字建执行者（缺省则新建分支回落旧续跑流程） */
  newName?: string;
}

export interface QuestionAnswer {
  questionIndex: number;
  /** 选中的选项下标；-1 表示"自定义" */
  choiceIndex: number;
  /** choiceIndex === -1 时用户输入的自定义文本 */
  customText?: string;
}

export interface QuestionSet {
  id: string; // qst_xxx
  agentId: string; // 归属 Agent
  sessionId: string; // 绑定会话（答案回写目标）
  createdAt: string;
  status: "pending" | "answered";
  questions: QuestionItem[];
  answers?: QuestionAnswer[];
  /** 复用确认载荷：单题集 + 老师 choiceIndex 0/1 时由答案路由自动派发 */
  dispatch?: QuestionDispatchAction;
}

function shortId(prefix: string): string {
  return `${prefix}_${crypto.randomUUID().replace(/-/g, "").slice(0, 12)}`;
}

export class QuestionStore {
  private readonly file: string;

  constructor(memoryDir: string) {
    this.file = path.join(memoryDir, ".questions.json");
  }

  async listAll(): Promise<QuestionSet[]> {
    try {
      const parsed = JSON.parse(await readFile(this.file, "utf8")) as unknown;
      return Array.isArray(parsed) ? (parsed as QuestionSet[]) : [];
    } catch {
      return [];
    }
  }

  /** 某 Agent 当前待回答的问题集（通常最多一条） */
  async pendingForAgent(agentId: string): Promise<QuestionSet[]> {
    const all = await this.listAll();
    return all.filter((set) => set.agentId === agentId && set.status === "pending");
  }

  /**
   * 待答 + 最近已答（给「作答后仍能原样回看题目与我的作答」用）。
   * 已答只取最近 answeredLimit 条：老会话里的问答卡不需要全量回看，避免把整个 question 文件推给前端。
   */
  async recentForAgent(agentId: string, answeredLimit = 20): Promise<QuestionSet[]> {
    const all = await this.listAll();
    const mine = all.filter((set) => set.agentId === agentId);
    const pending = mine.filter((set) => set.status === "pending");
    const answered = mine
      .filter((set) => set.status === "answered")
      .sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)))
      .slice(0, Math.max(0, answeredLimit));
    return [...pending, ...answered];
  }

  /** 记录一次提问（同一 Agent 已有 pending set 时复用同一组，追加新题不适用——直接报已存在由调用方处理） */
  async create(input: {
    agentId: string;
    sessionId: string;
    questions: QuestionItem[];
    dispatch?: QuestionDispatchAction;
  }): Promise<QuestionSet> {
    return await withFileLock(this.file, async () => {
      const all = await this.listAll();
      const set: QuestionSet = {
        ...input,
        id: shortId("qst"),
        createdAt: new Date().toISOString(),
        status: "pending",
      };
      await atomicWriteJson(this.file, [set, ...all]);
      return set;
    });
  }

  /** 提交答案：把 pending set 标记 answered；不存在 / 已答返回 null */
  async answer(setId: string, answers: QuestionAnswer[]): Promise<QuestionSet | null> {
    return await withFileLock(this.file, async () => {
      const all = await this.listAll();
      const index = all.findIndex((set) => set.id === setId);
      if (index < 0 || all[index].status !== "pending") {
        return null;
      }
      const updated: QuestionSet = { ...all[index], status: "answered", answers };
      const next = [...all];
      next[index] = updated;
      await atomicWriteJson(this.file, next);
      return updated;
    });
  }

  /** 清理某 Agent 的问题记录（Agent 删除时调用） */
  async dropByAgent(agentId: string): Promise<void> {
    return await withFileLock(this.file, async () => {
      const all = await this.listAll();
      const next = all.filter((set) => set.agentId !== agentId);
      if (next.length !== all.length) {
        await atomicWriteJson(this.file, next);
      }
    });
  }
}
