/**
 * Read-only, aggregate-only pilot. Never writes into --data-dir or prints session text.
 *
 * Run: node --import tsx scripts/session-ranking-pilot.ts --data-dir <path>
 */
import { readFile } from "node:fs/promises";
import path from "node:path";

import { SessionManager } from "../src/session-manager.js";
import { extractSessionReferenceTargets, normalizeSessionId } from "../src/relation-graph.js";
import {
  lexicalRank,
  meanPairwiseSimilarity,
  mmrSelect,
  oneHopExpand,
  pageRank,
  type RankingDocument,
  type SessionReference,
} from "../src/session-ranking-pilot.js";

interface WeakDispatch {
  askExcerpt?: string;
  linkedSessions?: string[];
}

const dataFlag = process.argv.indexOf("--data-dir");
const dataDir = dataFlag >= 0 ? process.argv[dataFlag + 1] : undefined;
if (!dataDir || dataDir.startsWith("--")) {
  throw new Error("Pass an explicit --data-dir; this pilot reads JSON and prints aggregates only.");
}

const manager = new SessionManager(path.resolve(dataDir));
const sessions = await manager.listSessions();
const documents: RankingDocument[] = sessions.map((session) => ({
  id: session.id,
  name: session.name,
  goal: session.goal,
}));
const known = new Set(documents.map((document) => document.id));
const links: SessionReference[] = [];
const linkedNodes = new Set<string>();
for (const session of sessions) {
  const messages = await manager.getMessages(session.id, null);
  for (const target of extractSessionReferenceTargets(messages)) {
    if (target === session.id || !known.has(target)) continue;
    links.push({ source: session.id, target });
    linkedNodes.add(session.id);
    linkedNodes.add(target);
  }
}

const adjacency = new Map(documents.map((document) => [document.id, new Set<string>()]));
const incoming = new Map(documents.map((document) => [document.id, 0]));
for (const link of links) {
  adjacency.get(link.source)!.add(link.target);
  adjacency.get(link.target)!.add(link.source);
  incoming.set(link.target, incoming.get(link.target)! + 1);
}
const seen = new Set<string>();
const components: number[] = [];
for (const document of documents) {
  if (seen.has(document.id)) continue;
  const queue = [document.id];
  seen.add(document.id);
  let size = 0;
  for (let index = 0; index < queue.length; index += 1) {
    const id = queue[index]!;
    size += 1;
    for (const neighbor of adjacency.get(id) ?? []) {
      if (seen.has(neighbor)) continue;
      seen.add(neighbor);
      queue.push(neighbor);
    }
  }
  components.push(size);
}

const rank = pageRank(documents.map((document) => document.id), links);
const topTenMass = [...rank.values()].sort((a, b) => b - a).slice(0, 10).reduce((sum, value) => sum + value, 0);
const fixedQueries = ["会话检索", "值日生调度", "SQLite关系图"];
const documentById = new Map(documents.map((document) => [document.id, document]));
const distinctMetadata = (ids: string[]): number => new Set(ids.map((id) => {
  const document = documentById.get(id)!;
  return document.name + "\u0000" + document.goal;
})).size;
const queryPilot = fixedQueries.map((query) => {
  const hits = lexicalRank(query, documents);
  const baseline = hits.slice(0, 5).map((hit) => hit.id);
  const diverse = mmrSelect(hits.slice(0, 20), documents, 5);
  const broad = mmrSelect(hits.slice(0, 50), documents, 5, 0.5);
  const scoreById = new Map(hits.map((hit) => [hit.id, hit.score]));
  const meanRelevance = (ids: string[]): number => ids.length
    ? ids.reduce((sum, id) => sum + (scoreById.get(id) ?? 0), 0) / ids.length
    : 0;
  const expanded = oneHopExpand(hits.slice(0, 10), links, documents);
  return {
    query,
    metadataCandidates: hits.length,
    distinctMetadataInTop20: distinctMetadata(hits.slice(0, 20).map((hit) => hit.id)),
    distinctMetadataInTop50: distinctMetadata(hits.slice(0, 50).map((hit) => hit.id)),
    baselineTop5DistinctMetadata: distinctMetadata(baseline),
    baselineTop5MeanRelevance: meanRelevance(baseline),
    baselineTop5MeanSimilarity: meanPairwiseSimilarity(baseline, documents),
    mmrTop5MeanSimilarity: meanPairwiseSimilarity(diverse, documents),
    mmrNewTop5Items: diverse.filter((id) => !baseline.includes(id)).length,
    broadMmrTop5MeanSimilarity: meanPairwiseSimilarity(broad, documents),
    broadMmrTop5MeanRelevance: meanRelevance(broad),
    broadMmrNewTop5Items: broad.filter((id) => !baseline.includes(id)).length,
    graphExpandedFromTop10: expanded.size,
    graphAddedCandidates: expanded.size - Math.min(10, hits.length),
  };
});

let dispatches: WeakDispatch[] = [];
try {
  const parsed = JSON.parse(await readFile(path.join(path.resolve(dataDir), ".dispatches.json"), "utf8")) as unknown;
  if (Array.isArray(parsed)) dispatches = parsed as WeakDispatch[];
} catch {
  // The dispatch ledger is optional for this descriptive pilot.
}
const weakHistory = {
  usableRecords: 0,
  existingLinkedLabels: 0,
  baselineTop5Hits: 0,
  mmrTop5Hits: 0,
  graphExpandedHits: 0,
  graphExpandedCandidates: 0,
};
for (const record of dispatches) {
  if (!record.askExcerpt?.trim() || !record.linkedSessions?.length) continue;
  const labels = new Set(record.linkedSessions.map(normalizeSessionId).filter((id) => known.has(id)));
  if (labels.size === 0) continue;
  const query = record.askExcerpt
    .replace(/https?:\/\/\S+/giu, " ")
    .replace(/&?ses_[a-z0-9]+/giu, " ")
    .trim();
  if (!query) continue;
  const hits = lexicalRank(query, documents);
  const baseline = new Set(hits.slice(0, 5).map((hit) => hit.id));
  const diverse = new Set(mmrSelect(hits.slice(0, 20), documents, 5));
  const expanded = oneHopExpand(hits.slice(0, 20), links, documents);
  weakHistory.usableRecords += 1;
  weakHistory.existingLinkedLabels += labels.size;
  weakHistory.graphExpandedCandidates += expanded.size;
  for (const id of labels) {
    if (baseline.has(id)) weakHistory.baselineTop5Hits += 1;
    if (diverse.has(id)) weakHistory.mmrTop5Hits += 1;
    if (expanded.has(id)) weakHistory.graphExpandedHits += 1;
  }
}

console.log(JSON.stringify({
  scope: "read-only JSON source; metadata-only lexical proxy; no live search or dispatch changes",
  sessions: documents.length,
  graph: {
    validDirectedLinks: links.length,
    nodesWithAnyLink: linkedNodes.size,
    nodesWithInboundLinks: [...incoming.values()].filter((count) => count > 0).length,
    components: components.length,
    largestComponent: Math.max(0, ...components),
    pageRankTop10Mass: topTenMass,
    uniformTop10Mass: documents.length ? Math.min(10, documents.length) / documents.length : 0,
  },
  queryPilot,
  weakHistory,
  limitations: [
    "Historical linked sessions are prior selections, not verified relevance labels.",
    "Metadata-only character similarity is a proxy, not the current transcript search implementation.",
    "Graph expansion uses a larger candidate set than top-5 reranking; its hit count is not directly comparable.",
  ],
}, null, 2));
