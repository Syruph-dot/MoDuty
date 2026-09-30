/**
 * 记忆检索（P4）：混合打分 + 溯源 + 预算。
 *
 * 打分维度（每一项都能在 `why` 里说出理由，便于人工审计）：
 * - 词面命中：整串命中权重最高，分词命中逐项加分；
 * - 类型权重：偏好/决策比事件更值得复用；
 * - 置信度：合并会提升置信度，越高越靠前；
 * - 新近度：按半衰期指数衰减（默认 30 天）；
 * - 访问频次：被反复用到的记忆略微上浮。
 *
 * 预算：先按分数排序，再按 `limit` 与 `charBudget` 双约束贪心取用——
 * 超预算的条目直接不注入，而不是截断半条。
 *
 * 生命周期过滤：`superseded` / `rejected` 默认不参与检索（否则被取代的旧结论会一直污染提示词）。
 */

export type RecallableStatus = "candidate" | "active" | "superseded" | "rejected";

export interface RecallableEntry {
  content: string;
  /** 主题字段也参与词面打分（旧行为：内容或主题任一命中都算命中） */
  topic?: string;
  type?: string;
  status?: RecallableStatus;
  confidence?: number;
  accessCount?: number;
  lastAccessedAt?: string;
  createdAt?: string;
  sourceRefs?: string[];
  ownerScope?: string;
  scopeId?: string;
  [key: string]: unknown;
}

export interface RecallOptions {
  /** 最多取几条（默认 6） */
  limit?: number;
  /** 注入文本的总字符预算（默认 1200） */
  charBudget?: number;
  /** 新近度半衰期（天，默认 30） */
  halfLifeDays?: number;
  /** 注入当前时间（测试可注入） */
  now?: () => Date;
  /** 是否连被取代/被否决的条目一起返回（默认 false） */
  includeInactive?: boolean;
}

export interface ScoredMemory<T extends RecallableEntry> {
  entry: T;
  score: number;
  /** 为什么被召回（人类可读的理由列表） */
  why: string[];
}

const DEFAULT_LIMIT = 6;
const DEFAULT_CHAR_BUDGET = 1200;
const DEFAULT_HALF_LIFE_DAYS = 30;

/** 类型权重：越「可复用」的类型越靠前 */
const TYPE_WEIGHT: Record<string, number> = {
  preference: 0.6,
  decision: 0.6,
  procedure: 0.4,
  fact: 0.3,
  episode: 0.1,
};

export function isRecallable(entry: RecallableEntry, includeInactive: boolean): boolean {
  const status = entry.status ?? "active";
  if (includeInactive) return status !== "rejected";
  return status === "active" || status === "candidate";
}

function keywordsOf(topic: string): string[] {
  const lowered = topic.toLowerCase();
  const wholeTerms = lowered
    .split(/[\s,，。;；:：/\\]+/u)
    .map((word) => word.trim())
    .filter((word) => word.length >= 2);
  const stopBigrams = new Set(["如何", "怎样", "怎么", "是否", "时候", "什么", "这个", "那个", "可以", "请问"]);
  const runs = lowered.match(/[\u4e00-\u9fff]{2,}/gu) ?? [];
  const bigrams = runs.flatMap((run) => {
    const chars = [...run];
    return chars.slice(0, -1).map((char, index) => char + chars[index + 1]).filter((pair) => !stopBigrams.has(pair));
  });
  return [...new Set([...wholeTerms, ...bigrams])].slice(0, 32);
}

/**
 * 单条打分。返回 null 表示不含任何命中信号（不做「无关也塞一条」）。
 */
export function scoreEntry<T extends RecallableEntry>(
  entry: T,
  topic: string,
  options: RecallOptions = {},
): ScoredMemory<T> | null {
  const now = (options.now ?? (() => new Date()))();
  const halfLifeDays = options.halfLifeDays ?? DEFAULT_HALF_LIFE_DAYS;
  if (typeof entry.validUntil === "string" && Date.parse(entry.validUntil) <= now.getTime()) return null;
  const topicLower = topic.trim().toLowerCase();
  if (!topicLower) return null;

  const contentLower = entry.content.toLowerCase();
  const topicField = (entry.topic ?? "").toLowerCase();
  const cjkQuery = /[\u4e00-\u9fff]/u.test(topicLower);
  const compactTopic = cjkQuery ? topicLower.replace(/\s+/gu, "") : "";
  const compactContent = cjkQuery ? contentLower.replace(/\s+/gu, "") : "";
  const compactTopicField = cjkQuery ? topicField.replace(/\s+/gu, "") : "";
  const why: string[] = [];
  let score = 0;

  const hitContent = contentLower.includes(topicLower) || (cjkQuery && compactContent.includes(compactTopic));
  const hitTopicField = topicField.includes(topicLower) || (cjkQuery && compactTopicField.includes(compactTopic));
  if (hitContent || hitTopicField) {
    score += 3;
    why.push(`整串命中「${topic}」${hitContent ? "（内容）" : "（主题字段）"}`);
  }
  const keywordHits = keywordsOf(topicLower).filter((keyword) =>
    contentLower.includes(keyword)
      || topicField.includes(keyword)
      || (cjkQuery && (compactContent.includes(keyword.replace(/\s+/gu, "")) || compactTopicField.includes(keyword.replace(/\s+/gu, "")))),
  );
  if (keywordHits.length > 0) {
    score += keywordHits.length;
    why.push(`关键词命中：${keywordHits.join("/")}`);
  }
  if (score === 0) return null;

  const type = entry.type ?? "episode";
  const typeWeight = TYPE_WEIGHT[type] ?? 0;
  if (typeWeight > 0) {
    score += typeWeight;
    why.push(`类型 ${type}`);
  }

  const confidence = typeof entry.confidence === "number" ? entry.confidence : 0.5;
  score += confidence * 1.5;
  why.push(`置信度 ${confidence.toFixed(2)}`);

  const stamp = entry.lastAccessedAt ?? entry.createdAt;
  if (stamp) {
    const ageMs = now.getTime() - new Date(stamp).getTime();
    if (Number.isFinite(ageMs)) {
      const ageDays = Math.max(0, ageMs / 86_400_000);
      const recency = Math.exp(-ageDays / halfLifeDays);
      score += recency * 0.8;
      if (recency > 0.5) why.push(`近期活跃（${ageDays.toFixed(1)} 天前）`);
    }
  }

  const accessCount = typeof entry.accessCount === "number" ? entry.accessCount : 0;
  if (accessCount > 0) {
    score += Math.min(accessCount, 5) * 0.1;
    why.push(`被取用 ${accessCount} 次`);
  }

  return { entry, score: Number(score.toFixed(3)), why };
}

/**
 * 检索一批条目：过滤生命周期 → 打分 → 排序 → 按 limit 与 charBudget 贪心取用。
 */
export function recall<T extends RecallableEntry>(
  entries: T[],
  topic: string,
  options: RecallOptions = {},
): ScoredMemory<T>[] {
  const limit = options.limit ?? DEFAULT_LIMIT;
  const charBudget = options.charBudget ?? DEFAULT_CHAR_BUDGET;
  const includeInactive = options.includeInactive ?? false;

  const scored = entries
    .filter((entry) => isRecallable(entry, includeInactive))
    .map((entry) => scoreEntry(entry, topic, options))
    .filter((item): item is ScoredMemory<T> => item !== null)
    .sort((a, b) => b.score - a.score);

  const picked: ScoredMemory<T>[] = [];
  let used = 0;
  for (const item of scored) {
    if (picked.length >= limit) break;
    const cost = item.entry.content.length;
    if (used + cost > charBudget) continue;
    used += cost;
    picked.push(item);
  }
  return picked;
}

/** 渲染成注入文本的决策摘要（trace 用） */
export function recallDigest(items: ScoredMemory<RecallableEntry>[]): Array<{ content: string; score: number; why: string[]; type: string; status: string; refs: string[] }> {
  return items.map((item) => ({
    content: item.entry.content.slice(0, 120),
    score: item.score,
    why: item.why,
    type: item.entry.type ?? "episode",
    status: item.entry.status ?? "active",
    refs: item.entry.sourceRefs ?? [],
  }));
}

/**
 * 渲染为模型可读的注入块：每条带类型/作用域/置信度，并在末尾给出来源与召回理由。
 * 形如：`- [preference·agent/agt_x·0.90] 内容 ← 整串命中「产物」（来源 out:xxx）`
 */
export function formatRecallLines(items: ScoredMemory<RecallableEntry>[]): string[] {
  return items.map((item) => {
    const entry = item.entry;
    const head = `[${entry.type ?? "episode"}·${entry.ownerScope ?? "?"}/${entry.scopeId ?? "?"}·${(entry.confidence ?? 0.5).toFixed(2)}]`;
    const refs = (entry.sourceRefs ?? []).filter(Boolean);
    const refText = refs.length > 0 ? `（来源 ${refs.slice(0, 3).join(", ")}）` : "";
    return `- ${head} ${entry.content} ← ${item.why.join("；")}${refText}`;
  });
}
