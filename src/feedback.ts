import type { JudgmentRecord, Reflection } from "./types.js";

export function analyzeJudgment(input: {
  score: number;
  label: string;
  annotatedText: string;
  topic?: string;
  userComment?: string;
}): Reflection {
  const evidence = input.annotatedText.trim();
  const comment = (input.userComment ?? "").trim();
  const evidenceLabel = evidence || "整段输出";
  const commentNote = comment ? ` 用户文字批注：${comment}` : "";
  const topicText = (input.topic ?? "").trim() || "当前会话主题";
  const commentHypothesis = comment ? `用户明确补充的判断标准是：${comment}` : "";

  if (input.score <= 2) {
    return {
      stance: "reject",
      nextGuessStrategy: "pivot",
      summary: `用户明确不认可被批注内容：${evidenceLabel}。${commentNote}`,
      intentHypothesis: commentHypothesis || `用户可能认为当前回答偏离了「${topicText}」的真实重点。`,
      nextGuessInstruction: "不要沿用上一轮角度，换一个解释框架重新猜用户意图。",
    };
  }
  if (input.score === 3) {
    return {
      stance: "weak_reject",
      nextGuessStrategy: "adjust",
      summary: `用户认为被批注内容接近但不足：${evidenceLabel}。${commentNote}`,
      intentHypothesis: commentHypothesis || `用户可能认可「${topicText}」的大方向，但觉得表达或重点不够准。`,
      nextGuessInstruction: "保留上一轮少量有效部分，收窄问题并重新组织重点。",
    };
  }
  if (input.score === 4) {
    return {
      stance: "ambivalent",
      nextGuessStrategy: "diverge",
      summary: `用户对被批注内容保持中立：${evidenceLabel}。${commentNote}`,
      intentHypothesis: commentHypothesis || `用户可能有一个不冲突但尚未显式说出的「${topicText}」并行想法。可能在回答的文本里面，但用户也可能并没有回答。`,
      nextGuessInstruction: "如果用户没有发文字消息，或文字消息中并没有隐含相关内容，提出并行假设，探索另一条可能的用户意图，不要要求用户解释。",
    };
  }
  if (input.score === 5) {
    return {
      stance: "weak_endorse",
      nextGuessStrategy: "refine",
      summary: `用户轻度认可被批注内容：${evidenceLabel}。${commentNote}`,
      intentHypothesis: commentHypothesis || `用户认为「${topicText}」方向基本正确，但还需要更贴近他的判断标准。`,
      nextGuessInstruction: "沿着当前方向继续，但要更具体、更可执行。",
    };
  }
  return {
    stance: "endorse",
    nextGuessStrategy: "deepen",
    summary: `用户高度认可被批注内容：${evidenceLabel}。${commentNote}`,
    intentHypothesis: commentHypothesis || `用户希望继续深化「${topicText}」里被认可的判断路径。`,
    nextGuessInstruction: "深化被认可方向，把它发展成下一步更强的判断或行动建议。",
  };
}

export function buildFollowupPrompt(input: {
  topic: string;
  outputText: string;
  judgment: JudgmentRecord & { label?: string };
  reflection: Reflection;
}): string {
  const comment = input.judgment.comment.trim();
  let lead = "用户这次通过划选/回复块评分给出反馈。";
  if (comment) {
    lead += "用户还填写了文字批注，文字批注比单独评分携带更明确的意图信号。";
  } else {
    lead += "用户没有填写文字批注，不要要求用户补充文字或解释评分原因。";
  }

  return [
    lead,
    "请根据批注信号继续主动揣摩用户意图并输出下一轮猜测。",
    "",
    `会话主题: ${input.topic || "未命名主题"}`,
    "",
    "上一轮输出:",
    input.outputText.trim() || "(空)",
    "",
    "用户批注:",
    `- 评分: ${input.judgment.score}/7 (${input.judgment.label ?? ""})`,
    `- 被评文本: ${input.judgment.context || "整条输出"}`,
    `- 文字批注: ${comment || "无"}`,
    "",
    "结构化反思:",
    `- 立场: ${input.reflection.stance}`,
    `- 策略: ${input.reflection.nextGuessStrategy}`,
    `- 意图假设: ${input.reflection.intentHypothesis}`,
    `- 下一轮指令: ${input.reflection.nextGuessInstruction}`,
  ].join("\n");
}
