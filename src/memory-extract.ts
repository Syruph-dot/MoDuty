/**
 * 记忆抽取与合并（P3）：把「一段对话文本」变成「带类型、带来源、带状态的结构化条目」。
 *
 * 本模块是**纯逻辑**：不 import memory.ts，只吃普通对象、吐普通对象。
 * 存储侧的读写与落盘由 memory.ts 负责（单向依赖，避免循环）。
 *
 * 三件事：
 * 1. `extractFromJudgment` / `extractFromVerdict`：从批注与派发结局抽出候选记忆，判定类型与置信度；
 * 2. `consolidateEntry`：把候选并入已有条目集合——同内容合并、同主题相反结论则置旧条目 superseded；
 * 3. `normalizeContent` / `tokenize` / `overlapRatio`：可测的文本工具，供合并与检索复用。
 */

export type MemoryType = "episode" | "fact" | "preference" | "procedure" | "decision";
export type MemoryStatus = "candidate" | "active" | "superseded" | "rejected";

/** 参与合并的条目最小形状（真实条目比这个字段多，用泛型保留） */
export interface MemoryEntryLike {
  id: string;
  content: string;
  type?: MemoryType;
  status?: MemoryStatus;
  confidence?: number;
  sourceRefs?: string[];
  createdAt: string;
  lastAccessedAt?: string;
  supersededBy?: string;
  supersedes?: string;
  validUntil?: string;
  [key: string]: unknown;
}

export interface TypedMemoryInput {
  content: string;
  type: MemoryType;
  /** 0..1 */
  confidence: number;
  sourceRefs: string[];
  validFrom?: string;
  validUntil?: string;
}

export interface ConsolidateResult<T extends MemoryEntryLike> {
  /** 处理后的完整条目列表（顺序保持，新增项追加在末尾） */
  entries: T[];
  action: "inserted" | "merged" | "superseded";
  targetId: string;
}

/** 判定「生效中」的状态：只有这两种会被合并或取代 */
const LIVE_STATUS: ReadonlySet<MemoryStatus> = new Set(["active", "candidate"]);

/** 置信度达到该值即视为可长期使用（candidate → active 的晋级线） */
export const ACTIVE_CONFIDENCE = 0.5;
/** 合并时的置信度增益 */
const MERGE_CONFIDENCE_BONUS = 0.1;
/** 判为「同一主题但结论相反」的词面重合下限 */
const CONFLICT_OVERLAP = 0.5;

const NEGATION_PATTERN = /(不|别|不要|不用|无需|禁止|避免|停止|取消|废弃)/u;

const TYPE_RULES: Array<{ type: MemoryType; pattern: RegExp }> = [
  { type: "preference", pattern: /(偏好|喜欢|讨厌|习惯|默认|以后都|统一用|不要用|称呼)/u },
  { type: "procedure", pattern: /(步骤|流程|先.{0,12}再|命令|脚本|模板|规范|SOP|用 ?rg|用 ?npm)/iu },
  { type: "decision", pattern: /(决定|拍板|确认|定为|采用|敲定|结论是)/u },
  { type: "fact", pattern: /(路径|目录|端口|版本|仓库|位于|地址|账号|环境变量|依赖)/u },
];

/** 归一化：小写、去掉空白与常见标点，用于「同内容」判定 */
export function normalizeContent(text: string): string {
  return text
    .toLowerCase()
    .replace(/[\s\u3000]+/gu, "")
    .replace(/[，。；：、！？"'`（）()\[\]{}<>,.;:!?~～\-—_/\\|*#]/gu, "");
}

/**
 * 分词：中文取 2-gram（「记忆合并」→ 记忆/忆合/合并），英文按单词。
 * 中文没有空格，2-gram 是无需词典就能拿到可用粒度的做法。
 */
export function tokenize(text: string): string[] {
  const tokens = new Set<string>();
  const lower = text.toLowerCase();
  for (const word of lower.split(/[\s\u3000，。；：、！？"'`（）()\[\]{}<>,.;:!?~～\-—_/\\|*#]+/u)) {
    if (!word) continue;
    const cjk = /[\u4e00-\u9fff]/u.test(word);
    if (cjk) {
      const chars = [...word];
      if (chars.length === 1) tokens.add(word);
      for (let i = 0; i + 1 < chars.length; i += 1) tokens.add(`${chars[i]}${chars[i + 1]}`);
    } else if (word.length >= 2) {
      tokens.add(word);
    }
  }
  return [...tokens];
}

/** 词面重合度（Jaccard）：用于判断「像不像在说同一件事」 */
export function overlapRatio(a: string, b: string): number {
  const setA = new Set(tokenize(a));
  const setB = new Set(tokenize(b));
  if (setA.size === 0 || setB.size === 0) return 0;
  let shared = 0;
  for (const token of setA) if (setB.has(token)) shared += 1;
  return shared / (setA.size + setB.size - shared);
}

function hasNegation(text: string): boolean {
  return NEGATION_PATTERN.test(text);
}

function clamp01(value: number): number {
  return Math.max(0, Math.min(1, value));
}

/** 按关键词表判定记忆类型；都不命中时视为一次「事件」 */
export function classifyType(text: string): MemoryType {
  for (const rule of TYPE_RULES) {
    if (rule.pattern.test(text)) return rule.type;
  }
  return "episode";
}

/**
 * 从一次用户批注抽取候选记忆。
 * 置信度：基础 0.55，用户亲自写的批注 +0.2，高分（≥6）+0.15，低分（≤3）降到 0.3。
 */
export function extractFromJudgment(input: {
  comment?: string;
  quote?: string;
  score: number;
  topic?: string;
  outputId?: string;
  commentSource?: string;
}): TypedMemoryInput | null {
  const text = (input.comment?.trim() || input.quote?.trim() || "").trim();
  if (!text) return null;
  const userWritten = input.commentSource === "user_comment" || Boolean(input.comment?.trim());
  let confidence = 0.55;
  if (userWritten) confidence += 0.2;
  if (input.score >= 6) confidence += 0.15;
  if (input.score <= 3) confidence = 0.3;
  return {
    content: text.slice(0, 300),
    type: classifyType(text),
    confidence: clamp01(confidence),
    sourceRefs: input.outputId ? [`out:${input.outputId}${input.topic ? `#${input.topic}` : ""}`] : [],
  };
}

/**
 * 从一次派发结局抽取 episode 记忆：谁把什么任务交付了 / 返工了几次。
 * 交付置信度较高；仍在返工只作为弱信号（candidate 级）。
 */
export function extractFromVerdict(input: {
  verdict: "deliver" | "continue";
  task: string;
  targetLabel?: string;
  dispatchId?: string;
  continueCount?: number;
}): TypedMemoryInput | null {
  const task = input.task.replace(/\s+/gu, " ").trim();
  if (!task) return null;
  const who = input.targetLabel?.trim() || "执行者";
  const rounds = input.continueCount ?? 0;
  const content = input.verdict === "deliver"
    ? `派发给「${who}」的任务已交付${rounds > 0 ? `（返工 ${rounds} 次）` : ""}：${task.slice(0, 200)}`
    : `派发给「${who}」的任务第 ${rounds} 次返工中：${task.slice(0, 200)}`;
  return {
    content,
    type: "episode",
    confidence: input.verdict === "deliver" ? 0.7 : 0.35,
    sourceRefs: input.dispatchId ? [`dispatch:${input.dispatchId}`] : [],
  };
}

/**
 * 把一条候选并入条目集合。
 *
 * 规则（按优先级）：
 * 1. 同 type + 同归一化内容，且旧条目仍生效 → **合并**（置信度取高并加增益、sourceRefs 求并集、刷新访问时间）；
 * 2. 同 type + 词面重合 ≥ 0.5 + 极性相反 → **取代**（旧条目 superseded 并写 validUntil，新条目记 supersedes）；
 * 3. 其余 → 新增（置信度 ≥ 0.5 记 active，否则 candidate）。
 */
export function consolidateEntry<T extends MemoryEntryLike>(
  existing: T[],
  incoming: TypedMemoryInput,
  options: { idFactory: () => string; now?: () => string },
): ConsolidateResult<T> {
  const now = options.now ?? (() => new Date().toISOString());
  const at = now();
  const normalized = normalizeContent(incoming.content);
  if (!normalized) throw new Error("Cannot consolidate empty memory content");
  const incomingType = incoming.type;

  const live = existing.filter((entry) => LIVE_STATUS.has(entry.status ?? "active") && (entry.type ?? "episode") === incomingType);

  // 1) 同内容合并
  const duplicate = live.find((entry) => normalizeContent(entry.content) === normalized);
  if (duplicate) {
    const mergedConfidence = clamp01(Math.max(duplicate.confidence ?? 0.5, incoming.confidence) + MERGE_CONFIDENCE_BONUS);
    const refs = new Set([...(duplicate.sourceRefs ?? []), ...incoming.sourceRefs]);
    const merged = {
      ...duplicate,
      confidence: mergedConfidence,
      sourceRefs: [...refs],
      status: mergedConfidence >= ACTIVE_CONFIDENCE ? "active" : (duplicate.status ?? "candidate"),
      lastAccessedAt: at,
      updatedAt: at,
    } as T;
    return {
      entries: existing.map((entry) => (entry.id === duplicate.id ? merged : entry)),
      action: "merged",
      targetId: duplicate.id,
    };
  }

  // 2) 同主题相反结论 → 取代
  const conflict = live.find(
    (entry) =>
      overlapRatio(entry.content, incoming.content) >= CONFLICT_OVERLAP
      && hasNegation(entry.content) !== hasNegation(incoming.content),
  );
  const newId = options.idFactory();
  const created = {
    id: newId,
    content: incoming.content,
    type: incomingType,
    status: incoming.confidence >= ACTIVE_CONFIDENCE ? "active" : "candidate",
    confidence: incoming.confidence,
    sourceRefs: incoming.sourceRefs,
    createdAt: at,
    updatedAt: at,
    ...(incoming.validFrom ? { validFrom: incoming.validFrom } : {}),
    ...(incoming.validUntil ? { validUntil: incoming.validUntil } : {}),
    ...(conflict ? { supersedes: conflict.id } : {}),
  } as unknown as T;

  if (!conflict) {
    return { entries: [...existing, created], action: "inserted", targetId: newId };
  }
  const superseded = existing.map((entry) =>
    entry.id === conflict.id
      ? ({ ...entry, status: "superseded", supersededBy: newId, validUntil: at, updatedAt: at } as T)
      : entry,
  );
  return { entries: [...superseded, created], action: "superseded", targetId: newId };
}

/** 供调用方复用的 id 生成（与 memory.ts 的条目 id 前缀一致） */
export function newMemoryId(): string {
  return `mem_${crypto.randomUUID().replace(/-/g, "").slice(0, 12)}`;
}
