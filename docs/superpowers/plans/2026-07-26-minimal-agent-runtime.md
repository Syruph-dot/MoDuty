# Minimal Agent Runtime Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the LangGraph runtime and learning/evolution subsystems with a direct, readable agent service while retaining tools, approvals, trace, sessions, and selection feedback.

**Architecture:** `MomokaAgentCore` will call `modelClient.run` directly for chat and explicit feedback continuation. `SessionManager` remains the durable conversation/event store; a reduced `MemoryStore` keeps only outputs, judgments, and annotations required by selection feedback. Tool dispatch, approval, trace, HTTP contracts, and frontend remain at their existing boundaries.

**Tech Stack:** TypeScript, Node HTTP server, Zod, file-backed JSON, browser TypeScript.

---

### Task 1: Prove and preserve direct chat/tool behavior

**Files:**
- Modify: `src/agent.ts`, `src/types.ts`, `src/http.ts`
- Delete: `src/runtime.ts`, `src/runtime-context.ts`, `src/run-store.ts`
- Test: `tests-ts/core.test.ts`, `tests-ts/http.test.ts`, `tests-ts/tools-and-model.test.ts`

- [ ] Write failing tests that call `agent.chat` without `LangGraphMomokaRuntime`, preserve session history, tool execution, trace events, and HTTP `/api/chat` snake_case output.
- [ ] Run focused tests and confirm they fail after deleting the runtime import/contract.
- [ ] Move the minimal chat preparation, direct `modelClient.run`, trace finalization, session persistence, and run response construction into `MomokaAgentCore`.
- [ ] Remove runtime-only run lookup API and tests; run focused tests until they pass.

### Task 2: Keep selection feedback, remove learning/evolution

**Files:**
- Modify: `src/agent.ts`, `src/memory.ts`, `src/feedback.ts`, `src/types.ts`, `src/http.ts`, `src/frontend/chat.ts`
- Delete: `src/evolution.ts`, `src/skill-router.ts`, `src/replay.ts`
- Test: `tests-ts/core.test.ts`, `tests-ts/http.test.ts`, `tests-ts/frontend-build.test.ts`

- [ ] Write failing tests proving score/comment annotations still persist and `continue=true` still produces an explicit follow-up, while responses contain no preference/evolution/skill fields.
- [ ] Remove preference updates, skill feedback boosts, evolution proposal generation, replay writes, skill matching, and related UI elements/API serializers.
- [ ] Implement direct judge flow: record judgment, calculate reflection, optionally call `modelClient.run`, persist the continuation response and tool calls.
- [ ] Run focused tests until selection-feedback tests pass and removed fields are absent.

### Task 3: Remove now-unused dependencies and documentation paths

**Files:**
- Modify: `package.json`, `package-lock.json`, `src/config.ts`, `src/casing.ts`, `src/index.ts`, `prompts/AGENTS.md`
- Delete: now-unreferenced runtime/skill/evolution/replay exports and tests
- Test: `tests-ts/**/*.test.ts`

- [ ] Write or update dependency assertions so production code no longer imports `@langchain/langgraph`.
- [ ] Remove `@langchain/core` and `@langchain/langgraph`, clean imports/types/serializers, and retain only configuration needed by the direct runtime.
- [ ] Update prompt/UI wording to describe the retained tools and approval behavior without skills or learning claims.
- [ ] Run TypeScript compilation and full test suite.

### Task 4: Verify, graph, and commit only scoped changes

**Files:**
- Modify: `docs/superpowers/specs/2026-07-26-minimal-agent-runtime-design.md`, `docs/superpowers/plans/2026-07-26-minimal-agent-runtime.md`

- [ ] Run `npm test`, `npx tsc --noEmit`, `npm run build`, `npm audit --omit=dev --audit-level=high`, and `git diff --check`.
- [ ] Run `graphify update .`.
- [ ] Stage only source, tests, package files, generated frontend files, and the two scoped design/plan documents; exclude `memory/` runtime data.
- [ ] Commit with `refactor: reduce MOMOKA to direct agent runtime`.
