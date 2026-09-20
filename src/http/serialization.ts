import { assessmentToSnake, evolutionProposalToSnake, reflectionToSnake } from "../casing.js";
import type { ContextStatsSnake } from "../agent-state.js";
import type { SessionRecord } from "../session-manager.js";
import type { AgentRecord, ChatResponse, ContextStats, JudgeResponse, RunRecord } from "../types.js";

/**
 * HTTP 对外 snake_case 序列化层：所有 camel 内存结构 → 对外 JSON 的转换集中在这里，
 * 路由模块不手写字段映射。
 */

export function chatToSnake(payload: ChatResponse): Record<string, unknown> {
  return {
    run_id: payload.runId,
    output_id: payload.outputId,
    topic: payload.topic,
    response: payload.response,
    annotation_runtime_context: payload.annotationRuntimeContext,
    output_assessment: assessmentToSnake(payload.outputAssessment),
    tool_calls: payload.toolCalls,
    matched_skills: payload.matchedSkills,
    skill_reasons: payload.skillReasons,
    session_id: payload.sessionId ?? null,
  };
}

export function judgeToSnake(payload: JudgeResponse): Record<string, unknown> {
  const out: Record<string, unknown> = {
    run_id: payload.runId,
    output_id: payload.outputId,
    score: payload.score,
    label: payload.label,
    analysis: payload.analysis,
    reflection: reflectionToSnake(payload.reflection),
    annotated_text: payload.annotatedText,
    comment: payload.comment,
    preference_update: payload.preferenceUpdate,
    evolution_proposals: payload.evolutionProposals.map(evolutionProposalToSnake),
  };
  if (payload.nextOutputId) {
    out.next_output_id = payload.nextOutputId;
    out.next_response = payload.nextResponse;
    out.next_annotation_runtime_context = payload.nextAnnotationRuntimeContext;
    out.next_output_assessment = payload.nextOutputAssessment
      ? assessmentToSnake(payload.nextOutputAssessment)
      : undefined;
    out.next_tool_calls = payload.nextToolCalls ?? [];
    out.next_skill_reasons = payload.nextSkillReasons ?? [];
  }
  return out;
}

export function runToSnake(run: RunRecord): Record<string, unknown> {
  return {
    run_id: run.runId,
    kind: run.kind,
    session_id: run.sessionId,
    output_id: run.outputId,
    response: run.response,
    created_at: run.createdAt,
    state: run.state,
  };
}

export function sessionToSnake(session: {
  id: string;
  name: string;
  goal: string;
  folderPath: string;
  createdAt: string;
  messageCount: number;
  lastMessageAt: string;
}): Record<string, unknown> {
  return {
    id: session.id,
    name: session.name,
    goal: session.goal,
    folder_path: session.folderPath,
    created_at: session.createdAt,
    message_count: session.messageCount,
    last_message_at: session.lastMessageAt,
  };
}

import type { PlanRecord, PlanStepRecord } from "../plan-store.js";

export function agentToSnake(record: AgentRecord, session: SessionRecord | null): Record<string, unknown> {
  return {
    id: record.id,
    name: record.name,
    ...(record.autoName ? { auto_name: true } : {}),
    role: record.role,
    ...(record.kind ? { kind: record.kind } : {}),
    roleplay: record.roleplay ?? null,
    capabilities: record.capabilities ?? [],
    ...(record.model ? { model: record.model } : {}),
    workspace_dir: record.workspaceDir,
    session_id: record.sessionId,
    state: record.state,
    phase: record.phase ?? null,
    last_run_duration_ms: record.lastRunDurationMs ?? null,
    ...(record.contextStats ? { context_stats: contextStatsToSnake(record.contextStats) } : {}),
    created_at: record.createdAt,
    last_active_at: record.lastActiveAt,
    session: session
      ? {
          goal: session.goal,
          folder_path: session.folderPath,
          message_count: session.messageCount,
          last_message_at: session.lastMessageAt,
        }
      : null,
  };
}

/** 计划步骤（camel 内存）→ 对外 snake 结构 */
export function planStepToSnake(step: PlanStepRecord): Record<string, unknown> {
  return {
    id: step.id,
    title: step.title,
    detail: step.detail ?? null,
    status: step.status,
    depends_on: step.dependsOn,
    owner_agent_id: step.ownerAgentId ?? null,
    capability: step.capability ?? null,
    acceptance_criteria: step.acceptanceCriteria,
    artifacts: step.artifacts,
    attempts: step.attempts,
    evidence: step.evidence.map((item) => ({
      at: item.at,
      kind: item.kind,
      summary: item.summary,
      source_refs: item.sourceRefs ?? [],
    })),
    dispatch_ids: step.dispatchIds,
    created_at: step.createdAt,
    updated_at: step.updatedAt,
    started_at: step.startedAt ?? null,
    finished_at: step.finishedAt ?? null,
    last_error: step.lastError ?? null,
  };
}

/** 计划（camel 内存）→ 对外 snake 结构；progress 是给 UI 直接用的派生进度 */
export function planToSnake(plan: PlanRecord): Record<string, unknown> {
  const count = (status: string) => plan.steps.filter((step) => step.status === status).length;
  return {
    id: plan.id,
    goal: plan.goal,
    status: plan.status,
    dispatcher_id: plan.dispatcherId ?? null,
    session_id: plan.sessionId ?? null,
    created_at: plan.createdAt,
    updated_at: plan.updatedAt,
    progress: {
      total: plan.steps.length,
      done: count("done"),
      running: count("running"),
      ready: count("ready"),
      blocked: count("blocked"),
      failed: count("failed"),
      skipped: count("skipped"),
      pending: count("pending"),
    },
    steps: plan.steps.map(planStepToSnake),
  };
}

/** 上下文占用指标（camel 内存）→ 对外 snake 结构 */
export function contextStatsToSnake(stats: ContextStats): ContextStatsSnake {
  return {
    prompt_tokens: stats.promptTokens,
    context_window: stats.contextWindow,
    cached_tokens: stats.cachedTokens,
    updated_at: stats.updatedAt,
  };
}
