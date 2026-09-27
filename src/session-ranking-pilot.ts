/** Pure, deterministic ranking primitives for an offline session-resource pilot. */

export interface RankingDocument {
  id: string;
  name: string;
  goal: string;
}

export interface RankedSession {
  id: string;
  score: number;
}

export interface SessionReference {
  source: string;
  target: string;
}

function grams(value: string): Set<string> {
  const normalized = value.toLowerCase().replace(/[\p{P}\p{S}\s]+/gu, "").trim();
  if (!normalized) return new Set();
  if ([...normalized].length < 2) return new Set([normalized]);
  const chars = [...normalized];
  const result = new Set<string>();
  for (let index = 0; index < chars.length - 1; index += 1) {
    result.add(chars[index]! + chars[index + 1]!);
  }
  return result;
}

export function characterSimilarity(left: string, right: string): number {
  const a = grams(left);
  const b = grams(right);
  if (a.size === 0 || b.size === 0) return 0;
  let intersection = 0;
  for (const gram of a) if (b.has(gram)) intersection += 1;
  return intersection / (a.size + b.size - intersection);
}

export function lexicalRank(query: string, documents: RankingDocument[]): RankedSession[] {
  return documents
    .map((document) => ({
      id: document.id,
      score: 0.65 * characterSimilarity(query, document.name) +
        0.35 * characterSimilarity(query, document.goal),
    }))
    .filter((hit) => hit.score > 0)
    .sort((a, b) => b.score - a.score || a.id.localeCompare(b.id));
}

export function mmrSelect(
  candidates: RankedSession[],
  documents: RankingDocument[],
  limit: number,
  lambda = 0.75,
): string[] {
  const byId = new Map(documents.map((document) => [document.id, document]));
  const remaining = candidates.filter((hit) => byId.has(hit.id));
  const selected: string[] = [];
  const weight = Math.min(1, Math.max(0, lambda));
  while (remaining.length > 0 && selected.length < limit) {
    let bestIndex = 0;
    let bestScore = -Infinity;
    for (let index = 0; index < remaining.length; index += 1) {
      const hit = remaining[index]!;
      const doc = byId.get(hit.id)!;
      const text = doc.name + " " + doc.goal;
      const redundancy = selected.reduce((max, id) => {
        const prior = byId.get(id)!;
        return Math.max(max, characterSimilarity(text, prior.name + " " + prior.goal));
      }, 0);
      const score = weight * hit.score - (1 - weight) * redundancy;
      if (score > bestScore) {
        bestScore = score;
        bestIndex = index;
      }
    }
    selected.push(remaining.splice(bestIndex, 1)[0]!.id);
  }
  return selected;
}

export function oneHopExpand(
  seeds: RankedSession[],
  links: SessionReference[],
  documents: RankingDocument[],
): Set<string> {
  const known = new Set(documents.map((document) => document.id));
  const seedIds = new Set(seeds.map((seed) => seed.id).filter((id) => known.has(id)));
  const expanded = new Set(seedIds);
  for (const link of links) {
    if (seedIds.has(link.source) && known.has(link.target)) expanded.add(link.target);
    if (seedIds.has(link.target) && known.has(link.source)) expanded.add(link.source);
  }
  return expanded;
}

export function meanPairwiseSimilarity(ids: string[], documents: RankingDocument[]): number {
  const byId = new Map(documents.map((document) => [document.id, document]));
  let total = 0;
  let pairs = 0;
  for (let left = 0; left < ids.length; left += 1) {
    for (let right = left + 1; right < ids.length; right += 1) {
      const a = byId.get(ids[left]!);
      const b = byId.get(ids[right]!);
      if (!a || !b) continue;
      total += characterSimilarity(a.name + " " + a.goal, b.name + " " + b.goal);
      pairs += 1;
    }
  }
  return pairs === 0 ? 0 : total / pairs;
}

export function pageRank(
  ids: string[],
  links: SessionReference[],
  damping = 0.85,
  iterations = 50,
): Map<string, number> {
  const nodes = [...new Set(ids)];
  const known = new Set(nodes);
  const scores = new Map(nodes.map((id) => [id, 1 / nodes.length]));
  if (nodes.length === 0) return scores;
  const out = new Map(nodes.map((id) => [id, new Set<string>()]));
  for (const link of links) {
    if (known.has(link.source) && known.has(link.target) && link.source !== link.target) {
      out.get(link.source)!.add(link.target);
    }
  }
  const weight = Math.min(1, Math.max(0, damping));
  for (let round = 0; round < iterations; round += 1) {
    const next = new Map(nodes.map((id) => [id, (1 - weight) / nodes.length]));
    let dangling = 0;
    for (const id of nodes) {
      const targets = out.get(id)!;
      const value = scores.get(id)!;
      if (targets.size === 0) {
        dangling += value;
      } else {
        const share = weight * value / targets.size;
        for (const target of targets) next.set(target, next.get(target)! + share);
      }
    }
    for (const id of nodes) next.set(id, next.get(id)! + weight * dangling / nodes.length);
    for (const id of nodes) scores.set(id, next.get(id)!);
  }
  return scores;
}
