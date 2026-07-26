import type {
  EvolutionProposal,
  JudgmentRecord,
  MatchedSkill,
  OutputAssessment,
  OutputRecord,
  Reflection,
  SkillMeta,
  ToolCall,
} from "./types.js";

export function skillMetaFromDisk(raw: Record<string, unknown>): SkillMeta {
  return {
    name: String(raw.name ?? ""),
    description: typeof raw.description === "string" ? raw.description : "",
    triggerKeywords: Array.isArray(raw.trigger_keywords)
      ? raw.trigger_keywords.map(String)
      : Array.isArray(raw.triggerKeywords)
        ? raw.triggerKeywords.map(String)
        : [],
    utilityScore: Number(raw.utility_score ?? raw.utilityScore ?? 0.5),
    version: typeof raw.version === "string" ? raw.version : undefined,
    path: String(raw.path ?? ""),
  };
}

export function outputFromDisk(raw: Record<string, unknown>): OutputRecord {
  return {
    outputId: String(raw.output_id ?? raw.outputId ?? ""),
    topic: String(raw.topic ?? ""),
    prompt: String(raw.prompt ?? ""),
    response: String(raw.response ?? ""),
    matchedSkills: Array.isArray(raw.matched_skills)
      ? raw.matched_skills.map(String)
      : Array.isArray(raw.matchedSkills)
        ? raw.matchedSkills.map(String)
        : [],
    toolCalls: Array.isArray(raw.tool_calls)
      ? raw.tool_calls.map(toolCallFromDisk)
      : Array.isArray(raw.toolCalls)
        ? raw.toolCalls.map(toolCallFromDisk)
        : [],
    sessionId: typeof raw.session_id === "string"
      ? raw.session_id
      : typeof raw.sessionId === "string"
        ? raw.sessionId
        : null,
    timestamp: String(raw.timestamp ?? ""),
  };
}

export function outputToDisk(record: OutputRecord): Record<string, unknown> {
  return {
    output_id: record.outputId,
    topic: record.topic,
    prompt: record.prompt,
    response: record.response,
    matched_skills: record.matchedSkills,
    tool_calls: record.toolCalls,
    session_id: record.sessionId ?? null,
    timestamp: record.timestamp,
  };
}

export function judgmentFromDisk(raw: Record<string, unknown>): JudgmentRecord {
  return {
    outputId: String(raw.output_id ?? raw.outputId ?? ""),
    score: Number(raw.score ?? 0),
    context: String(raw.context ?? ""),
    contextSource: raw.context_source === "selected_text" || raw.contextSource === "selected_text"
      ? "selected_text"
      : "full_output",
    quote: String(raw.quote ?? raw.selected_text ?? raw.context ?? ""),
    leftContext: String(raw.left_context ?? raw.leftContext ?? ""),
    rightContext: String(raw.right_context ?? raw.rightContext ?? ""),
    contextWindowChars: Number(raw.context_window_chars ?? raw.contextWindowChars ?? 20),
    comment: String(raw.comment ?? ""),
    commentSource: raw.comment_source === "user_comment" || raw.commentSource === "user_comment"
      ? "user_comment"
      : "none",
    topic: String(raw.topic ?? ""),
    matchedSkills: Array.isArray(raw.matched_skills)
      ? raw.matched_skills.map(String)
      : Array.isArray(raw.matchedSkills)
        ? raw.matchedSkills.map(String)
        : [],
    timestamp: String(raw.timestamp ?? ""),
  };
}

export function judgmentToDisk(record: JudgmentRecord): Record<string, unknown> {
  return {
    output_id: record.outputId,
    score: record.score,
    context: record.context,
    context_source: record.contextSource,
    quote: record.quote,
    left_context: record.leftContext,
    right_context: record.rightContext,
    context_window_chars: record.contextWindowChars,
    comment: record.comment,
    comment_source: record.commentSource,
    topic: record.topic,
    matched_skills: record.matchedSkills,
    timestamp: record.timestamp,
  };
}

export function reflectionToSnake(reflection: Reflection): Record<string, unknown> {
  return {
    stance: reflection.stance,
    next_guess_strategy: reflection.nextGuessStrategy,
    summary: reflection.summary,
    intent_hypothesis: reflection.intentHypothesis,
    next_guess_instruction: reflection.nextGuessInstruction,
  };
}

export function assessmentToSnake(assessment: OutputAssessment): Record<string, unknown> {
  return {
    action: assessment.action,
    reasons: assessment.reasons,
    revision_prompt: assessment.revisionPrompt,
  };
}

export function matchedSkillReason(skill: MatchedSkill): { name: string; score: number; reasons: string[] } {
  return {
    name: skill.meta.name,
    score: Math.round(skill.score * 1000) / 1000,
    reasons: skill.reasons,
  };
}

export function toolCallFromDisk(raw: unknown): ToolCall {
  const value = typeof raw === "object" && raw !== null ? raw as Record<string, unknown> : {};
  return {
    tool: String(value.tool ?? "unknown"),
    args: String(value.args ?? "{}"),
    result: String(value.result ?? ""),
  };
}

export function evolutionProposalToSnake(proposal: EvolutionProposal): Record<string, unknown> {
  return {
    id: proposal.id,
    key: proposal.key,
    type: proposal.type,
    skill: proposal.skill,
    status: proposal.status,
    created_at: proposal.createdAt,
    summary: proposal.summary,
    target_files: proposal.targetFiles,
    expected_diff: proposal.expectedDiff,
    apply_guardrails: proposal.applyGuardrails,
    evidence: proposal.evidence.map(judgmentToDisk),
  };
}
