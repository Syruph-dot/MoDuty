import path from "node:path";

import { isRecord, readJsonObject } from "./json-file.js";
import { atomicWriteJson, withFileLock } from "./write-queue.js";

/**
 * 计划存储（Plan Store）：把「要做什么」变成可持久化的一等结构。
 *
 * 背景：MoDuty 原先只有 `planning` 这个 UI 阶段标签，以及派发台账里的一条任务字符串。
 * 执行者做到哪、还差哪几步、谁来验、失败了重试几轮，都没有结构承载。
 *
 * 设计要点：
 * - 一个 Plan 是一张有向无环的步骤表；步骤靠 `dependsOn` 表达依赖，靠 `status` 表达进度；
 * - **派生的进度由 refresh 统一推导**：`pending ⇄ ready ⇄ blocked` 由依赖满足情况算出，
 *   `running / done / failed / skipped` 是执行侧写入的事实，refresh 不覆盖它们；
 * - `attempts / evidence / artifacts / dispatchIds` 是 P5（客观验收）与 P9（DAG 编排）的接口：
 *   验收读 acceptanceCriteria，编排读 dependsOn 与 dispatchIds。
 *
 * 存储：`<dataDir>/.plans.json`，整份原子写 + 文件锁（与其他 store 一致的落盘方式）。
 */

export type PlanStepStatus = "pending" | "ready" | "running" | "done" | "failed" | "skipped" | "blocked";
export type PlanStatus = "active" | "done" | "failed" | "cancelled";
export type PlanEvidenceKind = "attempt" | "verification" | "note";

/** 步骤的终态：不会再被 refresh 改动 */
const TERMINAL_STEP_STATUS: ReadonlySet<PlanStepStatus> = new Set(["done", "failed", "skipped"]);
/** 依赖被视为「已满足」的状态：只有 done 才算满足 */
const SATISFIED_STEP_STATUS: ReadonlySet<PlanStepStatus> = new Set(["done"]);
/** 前置处于这些状态时，后继无法继续 → blocked */
const BLOCKING_PREDECESSOR: ReadonlySet<PlanStepStatus> = new Set(["failed", "skipped"]);

const DEFAULT_MAX_PLANS = 200;

export interface PlanStepEvidence {
  at: string;
  kind: PlanEvidenceKind;
  summary: string;
  sourceRefs?: string[];
}

export interface PlanStepRecord {
  id: string; // pst_xxx
  title: string;
  detail?: string;
  status: PlanStepStatus;
  /** 前置步骤 id：全部 done 后本步才 ready */
  dependsOn: string[];
  /** 负责的执行者（P9 的能力匹配与预算都挂在这里） */
  ownerAgentId?: string;
  /** 期望能力标签（P9）：与执行者 capabilities 匹配 */
  capability?: string;
  /** 验收标准（P5 逐条检查） */
  acceptanceCriteria: string[];
  /** 期望产物路径（P5 的 fileExists 检查与 P9 的冲突串行化都用它） */
  artifacts: string[];
  attempts: number;
  evidence: PlanStepEvidence[];
  /** 关联的派发记录（P9 靠它把台账与计划对齐） */
  dispatchIds: string[];
  createdAt: string;
  updatedAt: string;
  startedAt?: string;
  finishedAt?: string;
  lastError?: string;
}

export interface PlanRecord {
  id: string; // pln_xxx
  goal: string;
  status: PlanStatus;
  /** 建计划的调度者（值日生） */
  dispatcherId?: string;
  sessionId?: string;
  steps: PlanStepRecord[];
  createdAt: string;
  updatedAt: string;
}

export interface NewPlanStepInput {
  title: string;
  detail?: string;
  dependsOn?: string[];
  ownerAgentId?: string;
  capability?: string;
  acceptanceCriteria?: string[];
  artifacts?: string[];
  /** 允许显式指定 id，便于把外部已存在的步骤引用进来 */
  id?: string;
}

export interface NewPlanInput {
  goal: string;
  steps?: NewPlanStepInput[];
  dispatcherId?: string;
  sessionId?: string;
}

export interface PlanStepPatch {
  status?: PlanStepStatus;
  acceptanceCriteria?: string[];
  artifacts?: string[];
  lastError?: string;
  ownerAgentId?: string;
  capability?: string;
  /** 追加一条证据（不覆盖已有证据） */
  evidence?: Omit<PlanStepEvidence, "at"> & { at?: string };
}

export interface RecordAttemptInput {
  status: Extract<PlanStepStatus, "done" | "failed" | "skipped" | "blocked">;
  summary: string;
  artifacts?: string[];
  sourceRefs?: string[];
  error?: string;
}

export interface PlanStoreOptions {
  /** 最多保留多少个计划（超出后丢最旧的终态计划） */
  maxPlans?: number;
}

/** 步骤级编辑的结果：notFound 不写盘并返回 null，error 抛出 */
type EditOutcome = { kind: "ok" } | { kind: "notFound" } | { kind: "error"; message: string };
type PlanEditor = (plan: PlanRecord) => EditOutcome | void;

function shortId(prefix: string): string {
  return `${prefix}_${crypto.randomUUID().replace(/-/g, "").slice(0, 12)}`;
}

function nowIso(): string {
  return new Date().toISOString();
}

/** 归一化 dependsOn：去重、剔除自引用 */
function normalizeDepends(dependsOn: string[] | undefined, selfId: string): string[] {
  const seen = new Set<string>();
  for (const dep of dependsOn ?? []) {
    const id = String(dep ?? "").trim();
    if (id && id !== selfId) seen.add(id);
  }
  return [...seen];
}

export interface AppendDispatchStepInput {
  dispatchId: string;
  task: string;
  ownerAgentId: string;
  dispatcherId?: string;
  /** 计划目标：缺省用任务书首句 */
  goal?: string;
}

/** 从任务书里抽验收要点（启发式：优先取含「验收/产物/标准/输出/路径」的行，最多 3 条） */
export function extractAcceptanceCriteria(task: string): string[] {
  const lines = task
    .split(/\r?\n|[；;。]/u)
    .map((line) => line.trim())
    .filter(Boolean);
  const KEY = /(验收|产物|标准|输出|保存到|路径)/u;
  const hits = lines.filter((line) => KEY.test(line));
  const picked = (hits.length > 0 ? hits : lines.slice(0, 1)).slice(0, 3);
  return picked.map((line) => (line.length > 120 ? `${line.slice(0, 120)}…` : line));
}

function titleFromTask(task: string): string {
  const first = task.split(/\r?\n/u).map((line) => line.trim()).find(Boolean) ?? "派发任务";
  return first.length > 60 ? `${first.slice(0, 60)}…` : first;
}

export class PlanStore {
  private readonly file: string;
  private readonly maxPlans: number;

  constructor(readonly dataDir: string, options: PlanStoreOptions = {}) {
    this.dataDir = path.resolve(dataDir);
    this.file = path.join(this.dataDir, ".plans.json");
    this.maxPlans = options.maxPlans ?? DEFAULT_MAX_PLANS;
  }

  plansPath(): string {
    return this.file;
  }

  // ---------------------------------------------------------------- 读写

  private async readAll(): Promise<PlanRecord[]> {
    const payload = await readJsonObject(this.file);
    const plans = Array.isArray(payload.plans) ? payload.plans : [];
    return plans.map(planFromDisk).filter((plan): plan is PlanRecord => plan !== null);
  }

  /**
   * 读-改-写整段持锁。注意 withFileLock 是 promise 队列、**不可重入**，
   * 所以锁内直接 atomicWriteJson，不能再用 writeJsonObject（会二次取同一把锁而自锁）。
   */
  private async withPlans<T>(editor: (plans: PlanRecord[]) => Promise<T> | T): Promise<T> {
    return await withFileLock(this.file, async () => await editor(await this.readAll()));
  }

  private async writeAll(plans: PlanRecord[]): Promise<void> {
    await atomicWriteJson(this.file, { plans: plans.map(planToDisk) });
  }

  // ---------------------------------------------------------------- CRUD

  async createPlan(input: NewPlanInput): Promise<PlanRecord> {
    const goal = input.goal.trim();
    if (!goal) throw new Error("Plan goal cannot be empty");
    const at = nowIso();
    const plan: PlanRecord = {
      id: shortId("pln"),
      goal,
      status: "active",
      ...(input.dispatcherId?.trim() ? { dispatcherId: input.dispatcherId.trim() } : {}),
      ...(input.sessionId?.trim() ? { sessionId: input.sessionId.trim() } : {}),
      steps: [],
      createdAt: at,
      updatedAt: at,
    };
    for (const step of input.steps ?? []) {
      plan.steps.push(this.makeStep(step));
    }
    const refreshed = refreshPlan(plan);
    return await this.withPlans(async (plans) => {
      plans.push(refreshed);
      await this.writeAll(this.trim(plans));
      return refreshed;
    });
  }

  async listPlans(filter: { status?: PlanStatus; dispatcherId?: string; limit?: number } = {}): Promise<PlanRecord[]> {
    const plans = await this.readAll();
    const matched = plans.filter((plan) => {
      if (filter.status && plan.status !== filter.status) return false;
      if (filter.dispatcherId && plan.dispatcherId !== filter.dispatcherId) return false;
      return true;
    });
    const limit = filter.limit ?? 50;
    // 新的在前
    return matched.reverse().slice(0, Math.max(1, limit));
  }

  async getPlan(planId: string): Promise<PlanRecord | null> {
    return (await this.readAll()).find((plan) => plan.id === planId) ?? null;
  }

  /** 按派发 id 反查它属于哪个计划的哪一步（P9 把台账与计划对齐时用） */
  async findByDispatch(dispatchId: string): Promise<{ plan: PlanRecord; step: PlanStepRecord } | null> {
    for (const plan of await this.readAll()) {
      const step = plan.steps.find((candidate) => candidate.dispatchIds.includes(dispatchId));
      if (step) return { plan, step };
    }
    return null;
  }

  // ---------------------------------------------------------------- 步骤变更

  async addStep(planId: string, input: NewPlanStepInput): Promise<PlanRecord | null> {
    return await this.mutate(planId, (plan) => {
      plan.steps.push(this.makeStep(input));
    });
  }

  async updateStep(planId: string, stepId: string, patch: PlanStepPatch): Promise<PlanRecord | null> {
    return await this.mutate(planId, (plan) => {
      const step = plan.steps.find((candidate) => candidate.id === stepId);
      if (!step) return { kind: "notFound" };
      if (patch.status) applyStatus(step, patch.status);
      if (patch.acceptanceCriteria) step.acceptanceCriteria = patch.acceptanceCriteria.map(String);
      if (patch.artifacts) step.artifacts = patch.artifacts.map(String);
      if (patch.ownerAgentId !== undefined) step.ownerAgentId = patch.ownerAgentId || undefined;
      if (patch.capability !== undefined) step.capability = patch.capability || undefined;
      if (patch.lastError !== undefined) step.lastError = patch.lastError || undefined;
      if (patch.evidence) {
        step.evidence.push({
          at: patch.evidence.at ?? nowIso(),
          kind: patch.evidence.kind,
          summary: String(patch.evidence.summary ?? ""),
          ...(patch.evidence.sourceRefs ? { sourceRefs: patch.evidence.sourceRefs.map(String) } : {}),
        });
      }
      step.updatedAt = nowIso();
    });
  }

  /** 记一次执行尝试：attempts+1、追加证据、写终态/中间态 */
  async recordAttempt(planId: string, stepId: string, input: RecordAttemptInput): Promise<PlanRecord | null> {
    return await this.mutate(planId, (plan) => {
      const step = plan.steps.find((candidate) => candidate.id === stepId);
      if (!step) return { kind: "notFound" };
      step.attempts += 1;
      applyStatus(step, input.status);
      if (input.artifacts?.length) {
        for (const artifact of input.artifacts.map(String)) {
          if (artifact && !step.artifacts.includes(artifact)) step.artifacts.push(artifact);
        }
      }
      if (input.error) step.lastError = input.error;
      step.evidence.push({
        at: nowIso(),
        kind: "attempt",
        summary: String(input.summary ?? ""),
        ...(input.sourceRefs?.length ? { sourceRefs: input.sourceRefs.map(String) } : {}),
      });
      step.updatedAt = nowIso();
    });
  }

  /** 关联一条派发记录 */
  async attachDispatch(planId: string, stepId: string, dispatchId: string): Promise<PlanRecord | null> {
    return await this.mutate(planId, (plan) => {
      const step = plan.steps.find((candidate) => candidate.id === stepId);
      if (!step) return { kind: "notFound" };
      const id = dispatchId.trim();
      if (id && !step.dispatchIds.includes(id)) step.dispatchIds.push(id);
      step.updatedAt = nowIso();
    });
  }

  /** 当前可派发的步骤（依赖全部 done 且自身 ready） */
  async readySteps(planId: string): Promise<PlanStepRecord[]> {
    const plan = await this.getPlan(planId);
    if (!plan) return [];
    return plan.steps.filter((step) => step.status === "ready");
  }

  /**
   * 为一次派发追加计划步（「派发即落计划」）。
   * 同一调度者只维护一个活动计划：已存在则追加步骤，否则新建。
   */
  async appendDispatchStep(input: AppendDispatchStepInput): Promise<{ planId: string; stepId: string }> {
    const task = input.task.trim();
    const at = nowIso();
    return await this.withPlans(async (plans) => {
      let plan = input.dispatcherId
        ? plans.find((candidate) => candidate.status === "active" && candidate.dispatcherId === input.dispatcherId)
        : undefined;
      if (!plan) {
        plan = {
          id: shortId("pln"),
          goal: input.goal?.trim() || titleFromTask(task),
          status: "active",
          ...(input.dispatcherId?.trim() ? { dispatcherId: input.dispatcherId.trim() } : {}),
          steps: [],
          createdAt: at,
          updatedAt: at,
        };
        plans.push(plan);
      }
      const step = this.makeStep({
        title: titleFromTask(task),
        detail: task.length > 4000 ? task.slice(0, 4000) : task,
        ownerAgentId: input.ownerAgentId,
        acceptanceCriteria: extractAcceptanceCriteria(task),
      });
      step.dispatchIds.push(input.dispatchId);
      plan.steps.push(step);
      plan.updatedAt = at;
      const refreshed = refreshPlan(plan);
      const index = plans.findIndex((candidate) => candidate.id === refreshed.id);
      if (index !== -1) plans[index] = refreshed;
      await this.writeAll(this.trim(plans));
      return { planId: refreshed.id, stepId: step.id };
    });
  }

  /** 重算派生状态（pending ⇄ ready ⇄ blocked 与整体 status） */
  async refresh(planId: string): Promise<PlanRecord | null> {
    return await this.mutate(planId, () => undefined);
  }

  // ---------------------------------------------------------------- 内部

  private makeStep(input: NewPlanStepInput): PlanStepRecord {
    const id = input.id?.trim() || shortId("pst");
    const at = nowIso();
    return {
      id,
      title: String(input.title ?? "").trim(),
      ...(input.detail?.trim() ? { detail: input.detail.trim() } : {}),
      status: "pending",
      dependsOn: normalizeDepends(input.dependsOn, id),
      ...(input.ownerAgentId?.trim() ? { ownerAgentId: input.ownerAgentId.trim() } : {}),
      ...(input.capability?.trim() ? { capability: input.capability.trim() } : {}),
      acceptanceCriteria: (input.acceptanceCriteria ?? []).map(String),
      artifacts: (input.artifacts ?? []).map(String),
      attempts: 0,
      evidence: [],
      dispatchIds: [],
      createdAt: at,
      updatedAt: at,
    };
  }

  /**
   * 读出 → 改 → 写回（整个读改写持同一把文件锁，避免并发丢更新）。
   * - 计划不存在或步骤不存在 → 返回 null（不写盘）；
   * - 编辑返回 error → 抛出，由 HTTP 层转 5xx。
   */
  private async mutate(planId: string, editor: PlanEditor): Promise<PlanRecord | null> {
    return await this.withPlans(async (plans) => {
      const index = plans.findIndex((plan) => plan.id === planId);
      if (index === -1) return null;
      const plan = plans[index]!;
      const outcome: EditOutcome = editor(plan) ?? { kind: "ok" };
      if (outcome.kind === "notFound") return null;
      if (outcome.kind === "error") throw new Error(outcome.message);
      plan.updatedAt = nowIso();
      const refreshed = refreshPlan(plan);
      plans[index] = refreshed;
      await this.writeAll(this.trim(plans));
      return refreshed;
    });
  }

  /** 上限保护：优先丢弃最旧的终态计划，活动中的计划不丢 */
  private trim(plans: PlanRecord[]): PlanRecord[] {
    if (plans.length <= this.maxPlans) return plans;
    const overflow = plans.length - this.maxPlans;
    const disposable = plans
      .map((plan, index) => ({ plan, index }))
      .filter((item) => item.plan.status !== "active")
      .slice(0, overflow)
      .map((item) => item.index)
      .sort((a, b) => b - a);
    for (const index of disposable) {
      plans.splice(index, 1);
      if (plans.length <= this.maxPlans) break;
    }
    return plans;
  }
}

/** 写入状态时同步维护 startedAt / finishedAt */
function applyStatus(step: PlanStepRecord, status: PlanStepStatus): void {
  step.status = status;
  if (status === "running" && !step.startedAt) step.startedAt = nowIso();
  if (TERMINAL_STEP_STATUS.has(status)) step.finishedAt = nowIso();
  else step.finishedAt = undefined;
}

/**
 * 推导派生状态：只动 pending / ready / blocked 三种，
 * running / done / failed / skipped 由执行侧写入，这里不覆盖。
 */
export function refreshPlan(plan: PlanRecord): PlanRecord {
  const byId = new Map(plan.steps.map((step) => [step.id, step]));
  for (const step of plan.steps) {
    if (TERMINAL_STEP_STATUS.has(step.status) || step.status === "running") continue;
    const deps = step.dependsOn.map((id) => byId.get(id)).filter((dep): dep is PlanStepRecord => Boolean(dep));
    const blocking = deps.find((dep) => BLOCKING_PREDECESSOR.has(dep.status));
    if (blocking) {
      step.status = "blocked";
      step.lastError = `前置步骤未完成（${blocking.id} → ${blocking.status}）`;
      continue;
    }
    const missing = deps.filter((dep) => !SATISFIED_STEP_STATUS.has(dep.status));
    step.status = missing.length === 0 ? "ready" : "pending";
    if (step.status === "ready" && step.lastError?.startsWith("前置步骤未完成")) step.lastError = undefined;
  }

  if (plan.status !== "cancelled") {
    // 能推进 = 有步在跑或可达；blocked 步骤自身无法推进，不算「活动」
    const canProgress = plan.steps.some((step) => step.status === "running" || step.status === "ready" || step.status === "pending");
    if (plan.steps.length === 0 || canProgress) plan.status = "active";
    else if (plan.steps.every((step) => step.status === "done" || step.status === "skipped")) plan.status = "done";
    else plan.status = "failed";
  }
  return plan;
}

function planToDisk(plan: PlanRecord): Record<string, unknown> {
  return { ...plan, steps: plan.steps.map((step) => ({ ...step })) };
}

function planFromDisk(value: unknown): PlanRecord | null {
  if (!isRecord(value)) return null;
  const id = typeof value.id === "string" ? value.id : "";
  const goal = typeof value.goal === "string" ? value.goal : "";
  if (!id || !goal) return null;
  const steps = Array.isArray(value.steps) ? value.steps.map(stepFromDisk).filter((step): step is PlanStepRecord => step !== null) : [];
  const status = typeof value.status === "string" && ["active", "done", "failed", "cancelled"].includes(value.status)
    ? (value.status as PlanStatus)
    : "active";
  return {
    id,
    goal,
    status,
    ...(typeof value.dispatcherId === "string" ? { dispatcherId: value.dispatcherId } : {}),
    ...(typeof value.sessionId === "string" ? { sessionId: value.sessionId } : {}),
    steps,
    createdAt: typeof value.createdAt === "string" ? value.createdAt : nowIso(),
    updatedAt: typeof value.updatedAt === "string" ? value.updatedAt : nowIso(),
  };
}

function stepFromDisk(value: unknown): PlanStepRecord | null {
  if (!isRecord(value)) return null;
  const id = typeof value.id === "string" ? value.id : "";
  if (!id) return null;
  const status = typeof value.status === "string"
    && ["pending", "ready", "running", "done", "failed", "skipped", "blocked"].includes(value.status)
    ? (value.status as PlanStepStatus)
    : "pending";
  return {
    id,
    title: typeof value.title === "string" ? value.title : "",
    ...(typeof value.detail === "string" ? { detail: value.detail } : {}),
    status,
    dependsOn: Array.isArray(value.dependsOn) ? value.dependsOn.map(String) : [],
    ...(typeof value.ownerAgentId === "string" ? { ownerAgentId: value.ownerAgentId } : {}),
    ...(typeof value.capability === "string" ? { capability: value.capability } : {}),
    acceptanceCriteria: Array.isArray(value.acceptanceCriteria) ? value.acceptanceCriteria.map(String) : [],
    artifacts: Array.isArray(value.artifacts) ? value.artifacts.map(String) : [],
    attempts: typeof value.attempts === "number" && Number.isFinite(value.attempts) ? value.attempts : 0,
    evidence: Array.isArray(value.evidence)
      ? value.evidence.filter(isRecord).map((item) => ({
          at: typeof item.at === "string" ? item.at : nowIso(),
          kind: (typeof item.kind === "string" && ["attempt", "verification", "note"].includes(item.kind) ? item.kind : "note") as PlanEvidenceKind,
          summary: typeof item.summary === "string" ? item.summary : "",
          ...(Array.isArray(item.sourceRefs) ? { sourceRefs: item.sourceRefs.map(String) } : {}),
        }))
      : [],
    dispatchIds: Array.isArray(value.dispatchIds) ? value.dispatchIds.map(String) : [],
    createdAt: typeof value.createdAt === "string" ? value.createdAt : nowIso(),
    updatedAt: typeof value.updatedAt === "string" ? value.updatedAt : nowIso(),
    ...(typeof value.startedAt === "string" ? { startedAt: value.startedAt } : {}),
    ...(typeof value.finishedAt === "string" ? { finishedAt: value.finishedAt } : {}),
    ...(typeof value.lastError === "string" ? { lastError: value.lastError } : {}),
  };
}
