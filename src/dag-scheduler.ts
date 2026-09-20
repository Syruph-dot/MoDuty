/**
 * DAG 编排（P9）：把 P1 的计划步依赖关系变成可调度的一组决策。
 *
 * 现状对照：原先只有 `值日生 → 执行者 → 值日生判读` 的单链，没有依赖图、没有并行、没有 join、
 * 没有产物冲突处理、没有能力匹配、也没有升级策略。本模块只做**决策**（谁是就绪的、谁能并发、
 * 谁被谁挡住、谁该升级），实际派发仍由编排层按决策结果调用既有 dispatch 通路——
 * 这样调度逻辑可以纯函数测试，不会为了加编排去动派发链路。
 *
 * 关键规则：
 * 1. 就绪 = `status === "ready"`（P1 的 refreshPlan 已按依赖推导过）；
 * 2. join：后继只有在全部前置 done 后才 ready，因此天然满足「等所有分支汇合」；
 * 3. 并发上限 `maxParallel`，额度 = maxParallel - 正在跑的步数；
 * 4. 产物冲突：两个步声明了同一个 artifact（含目录前缀关系）时**串行化**——后者不进本轮调度；
 * 5. 依赖失败传播：前置 failed/skipped → 后继 skipped（带原因），不会被误派；
 * 6. 返工上限用尽 → 升级（escalated），由上层交给人/值日生，不静默丢弃；
 * 7. 能力匹配：步声明 `capability`，在候选执行者里挑具备该能力的；都没有则回落（返回 undefined）。
 */

export type DagStepStatus = "pending" | "ready" | "running" | "done" | "failed" | "skipped" | "blocked";

export interface DagStep {
  id: string;
  title?: string;
  status: DagStepStatus;
  dependsOn: string[];
  ownerAgentId?: string;
  /** 期望的能力标签（与执行者的 capabilities 对应） */
  capability?: string;
  artifacts: string[];
  attempts: number;
}

export interface DagPlan {
  id: string;
  steps: DagStep[];
}

export interface ExecutorCandidate {
  id: string;
  name?: string;
  /** 缺省视为「无声明能力」——只在没有更强候选时才可能被选中 */
  capabilities?: string[];
  /** 该执行者当前是否已有在跑的任务（有则不再并发给它，避免同一 Agent 自我竞争） */
  busy?: boolean;
}

export interface SchedulingOptions {
  /** 同时最多几个步骤在跑（默认 2） */
  maxParallel?: number;
  /** 返工上限：步的 attempts 达到该值即升级（默认 3） */
  maxAttempts?: number;
}

export interface DispatchDecision {
  stepId: string;
  agentId: string;
  reason: string;
}

export interface SkippedStep {
  stepId: string;
  reason: string;
}

export interface ScheduleResult {
  /** 本轮可以派发的（已选定执行者） */
  dispatch: DispatchDecision[];
  /** 因并发额度不足而排队的就绪步 */
  queued: string[];
  /** 因产物冲突而必须串行的 */
  serialized: Array<{ stepId: string; conflictsWith: string[] }>;
  /** 因前置失败/跳过而作废的 */
  skipped: SkippedStep[];
  /** 返工用尽需要升级的 */
  escalated: Array<{ stepId: string; attempts: number }>;
  /** 就绪但没有可用执行者（需要人指定或新建） */
  unschedulable: Array<{ stepId: string; reason: string }>;
  capacity: number;
}

/** 产物是否冲突：完全相同，或一方是另一方的目录前缀 */
export function artifactsConflict(a: string, b: string): boolean {
  const left = a.replace(/\\/gu, "/").replace(/\/+$/u, "").toLowerCase();
  const right = b.replace(/\\/gu, "/").replace(/\/+$/u, "").toLowerCase();
  if (!left || !right) return false;
  if (left === right) return true;
  return left.startsWith(`${right}/`) || right.startsWith(`${left}/`);
}

/** 候选步的产物与在跑步的产物冲突列表 */
export function conflictingArtifacts(candidate: DagStep, running: DagStep[]): string[] {
  const conflicts: string[] = [];
  for (const other of running) {
    for (const artifact of candidate.artifacts) {
      if (other.artifacts.some((existing) => artifactsConflict(artifact, existing))) {
        if (!conflicts.includes(other.id)) conflicts.push(other.id);
      }
    }
  }
  return conflicts;
}

/**
 * 能力匹配选执行者：优先「声明了该能力且不忙」的候选；都没有则回落不忙的任意候选（reason 会写明回落原因）。
 * 步没有声明 capability 时，直接选第一个不忙的候选。
 */
export function pickExecutor(
  step: DagStep,
  candidates: ExecutorCandidate[],
): { agentId: string; reason: string } | undefined {
  const idle = candidates.filter((candidate) => !candidate.busy);
  if (idle.length === 0) return undefined;
  // 已绑定的 owner 优先（计划里指定过谁做）
  if (step.ownerAgentId) {
    const owner = idle.find((candidate) => candidate.id === step.ownerAgentId);
    if (owner) return { agentId: owner.id, reason: "沿用计划里指定的 owner" };
  }
  if (step.capability) {
    const matched = idle.find((candidate) => (candidate.capabilities ?? []).includes(String(step.capability)));
    if (matched) return { agentId: matched.id, reason: `能力匹配 ${step.capability}` };
    return { agentId: idle[0]!.id, reason: `没有声明「${step.capability}」的执行者，回落到空闲执行者` };
  }
  return { agentId: idle[0]!.id, reason: "无能力要求，取空闲执行者" };
}

/**
 * 主调度入口：纯函数，吃计划 + 候选执行者，吐本轮该做什么。
 * 不修改入参（返回的是决策，状态变更仍由 PlanStore 落盘）。
 */
export function schedulePlan(
  plan: DagPlan,
  candidates: ExecutorCandidate[],
  options: SchedulingOptions = {},
): ScheduleResult {
  const maxParallel = Math.max(1, options.maxParallel ?? 2);
  const maxAttempts = Math.max(1, options.maxAttempts ?? 3);
  const byId = new Map(plan.steps.map((step) => [step.id, step]));
  const running = plan.steps.filter((step) => step.status === "running");

  const skipped: SkippedStep[] = [];
  const escalated: Array<{ stepId: string; attempts: number }> = [];
  const serialized: Array<{ stepId: string; conflictsWith: string[] }> = [];
  const queued: string[] = [];
  const unschedulable: Array<{ stepId: string; reason: string }> = [];
  const dispatch: DispatchDecision[] = [];

  // 依赖失败传播：前置 failed/skipped 的后继直接作废（P1 会标 blocked，这里给出可读原因）
  for (const step of plan.steps) {
    if (step.status !== "ready" && step.status !== "pending" && step.status !== "blocked") continue;
    const broken = step.dependsOn
      .map((id) => byId.get(id))
      .find((dep) => dep && (dep.status === "failed" || dep.status === "skipped"));
    if (broken) skipped.push({ stepId: step.id, reason: `前置 ${broken.id} 处于 ${broken.status}` });
  }
  const skippedIds = new Set(skipped.map((item) => item.stepId));

  let capacity = Math.max(0, maxParallel - running.length);
  // 在跑的步也要占住产物，避免同产物并发写
  const occupied: DagStep[] = [...running];

  for (const step of plan.steps) {
    if (step.status !== "ready" || skippedIds.has(step.id)) continue;

    if (step.attempts >= maxAttempts) {
      escalated.push({ stepId: step.id, attempts: step.attempts });
      continue;
    }

    const conflicts = conflictingArtifacts(step, occupied);
    if (conflicts.length > 0) {
      serialized.push({ stepId: step.id, conflictsWith: conflicts });
      continue;
    }

    if (capacity <= 0) {
      queued.push(step.id);
      continue;
    }

    const executor = pickExecutor(step, candidates);
    if (!executor) {
      unschedulable.push({ stepId: step.id, reason: "没有空闲执行者" });
      continue;
    }

    dispatch.push({ stepId: step.id, agentId: executor.agentId, reason: executor.reason });
    // 本轮内也要互相避让：同产物不并发
    occupied.push(step);
    capacity -= 1;
  }

  return { dispatch, queued, serialized, skipped, escalated, unschedulable, capacity };
}
