import test from "node:test";
import assert from "node:assert/strict";

import {
  lexicalRank,
  mmrSelect,
  oneHopExpand,
  pageRank,
  meanPairwiseSimilarity,
  type RankingDocument,
} from "../src/session-ranking-pilot.ts";

const docs: RankingDocument[] = [
  { id: "a", name: "会话检索优化", goal: "改进跨会话检索" },
  { id: "b", name: "会话检索优化副本", goal: "改进跨会话检索" },
  { id: "c", name: "会话关系图", goal: "用图查询相关会话" },
  { id: "d", name: "音频转码", goal: "处理 wav 文件" },
];

test("lexical ranking is query-sensitive, deterministic, and excludes zero matches", () => {
  const hits = lexicalRank("会话检索", docs);
  assert.deepEqual(hits.map((hit) => hit.id), ["a", "b", "c"]);
  assert.ok(hits[0]!.score > hits[2]!.score);
  assert.equal(lexicalRank("完全无关", docs).length, 0);
});

test("MMR keeps relevance while reducing near-duplicate selections", () => {
  const pool = [{ id: "a", score: 0.95 }, { id: "b", score: 0.9 }, { id: "c", score: 0.7 }];
  const selected = mmrSelect(pool, docs, 2, 0.5);
  assert.deepEqual(selected, ["a", "c"]);
  assert.ok(meanPairwiseSimilarity(selected, docs) < meanPairwiseSimilarity(["a", "b"], docs));
});

test("one-hop expansion adds graph neighbors without inventing other nodes", () => {
  const expanded = oneHopExpand(
    [{ id: "a", score: 1 }],
    [{ source: "a", target: "c" }, { source: "c", target: "d" }, { source: "missing", target: "d" }],
    docs,
  );
  assert.deepEqual([...expanded].sort(), ["a", "c"]);
});

test("PageRank promotes a node cited by independent sources", () => {
  const scores = pageRank(["a", "b", "c"], [
    { source: "a", target: "b" },
    { source: "c", target: "b" },
  ]);
  assert.ok(scores.get("b")! > scores.get("a")!);
  assert.ok(Math.abs([...scores.values()].reduce((sum, value) => sum + value, 0) - 1) < 1e-9);
});
