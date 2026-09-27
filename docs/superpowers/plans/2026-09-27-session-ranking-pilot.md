# Session Ranking Pilot Implementation Plan

> **For agentic workers:** Execute inline in this session. The experiment must not modify the dispatcher, session search API, or runtime data.

**Goal:** Measure whether classic retrieval diversification and local graph expansion offer useful signals for MoDuty session resources.

**Architecture:** Read JSON sessions/messages without writing to the runtime directory. Build a temporary in-memory explicit-reference graph, compare metadata lexical ranking with MMR and one-hop expansion, and report topology plus weak-label results separately. Historical dispatcher links are weak labels, not ground truth.

**Tech Stack:** TypeScript, Node.js built-ins, existing test runner.

---

### Task 1: Pure ranking functions

**Files**
- Create: src/session-ranking-pilot.ts
- Test: tests-ts/session-ranking-pilot.test.ts

- [x] Write tests for stable lexical ranking, MMR diversity, graph expansion, and PageRank on small directed fixtures.
- [x] Run node --import tsx --test tests-ts/session-ranking-pilot.test.ts and verify the new tests fail before implementation.
- [x] Implement deterministic character n-gram similarity, MMR selection, one-hop candidate expansion, and PageRank. Return scores and IDs only.
- [x] Run the same test command and verify all cases pass.

### Task 2: Read-only corpus runner

**Files**
- Create: scripts/session-ranking-pilot.ts

- [x] Require an explicit --data-dir; read .sessions/sessions.json, per-session messages.json, and .dispatches.json using read-only filesystem calls.
- [x] Extract only explicit ampersand session links from the same message fields as the SQLite graph. Ignore links to missing sessions and self-links.
- [x] Run three fixed project-topic queries through metadata-only lexical ranking, MMR, and one-hop graph expansion. Compute pairwise redundancy and candidate-set changes without printing session text.
- [x] Treat dispatcher linkedSessions only as weak reference labels; report sample count and recall descriptively when available.
- [x] Confirm that running the script does not create session-graph.db or modify JSON source timestamps.

### Task 3: Evidence and delivery

**Files**
- Create: docs/reviews/2026-09-27-session-ranking-pilot.md

- [x] Record corpus scope, graph topology, ranking deltas, weak-label limitations, and a recommendation about live integration.
- [x] Run npm run build:server, targeted tests, and git diff --check.
- [x] Run graphify update . for the code change.
- [x] Commit only the pilot files, preserving unrelated workspace changes.

