# Issue 13/14 Remediation Plan

## Branch decision

- Continue from `tauri-v2-browser-embed` at `9e313ea`; this is the clean branch on which both reports were tested, and it is four commits ahead of local `main` with no divergence.
- Do not merge `codex/agent-desktop-paradigm` wholesale. It has 14 commits after `4e34040`, while `main` has 42 commits after that base; its 196 changed paths span desktop state, dispatch, graph, prompts, prototypes, and assets.
- `codex/compact-handoff-impl` is already an ancestor of `main`; no merge is pending there. Keep the Tauri branch off `main` until its native shell path receives an experience check, since Issue 13 only exercised Vite.

## Implementation slices

### 1. Enforce per-request access and memory boundaries

Findings: UX-014-G, I, P, U.

- Derive a turn-scoped policy from the current request for project-file access, historical recall, and experience capture.
- Apply the policy both when constructing model context/tool schemas and at tool execution, so unavailable operations cannot run through an alternate call path.
- Skip long-term and experience recall when prohibited; skip automatic experience capture when saving is prohibited; write the decision and any blocked action to the run trace.
- Acceptance: explicit “do not read files,” “do not use history/memory,” and “do not save memory/experience” requests produce no corresponding tool call, recall event, or capture; ordinary requests keep current behavior.

### 2. Repair session search and provenance

Findings: UX-014-A, B, K, L, M, O, R.

- Rebuild stale/missing transcripts from canonical stored messages before search; de-duplicate turn ranges and choose the newest relevant snippet.
- Align `search_sessions` schema with its documented multi-keyword union behavior.
- Route tile-wall search to transcript search, normalize Chinese spacing/phrases, show workspace and archive state, and create graph relations only from explicit user/Agent references rather than inferred similarity.
- Include Compact sidecars as separately sourced searchable material without replacing the transcript.
- Acceptance: all turns in raw messages and Compact sidecars are discoverable; results have stable turn ranges and source/workspace/archive metadata; references remain explicit and auditable.

### 3. Add user-controlled memory governance

Findings: UX-014-D, E, F, H, J, T.

- Add long-term memory creation with scope and expiry; improve Chinese phrase matching; make cross-workspace experience recall an explicit opt-in with source and applicability shown.
- Connect rejected/superseded memory to derived experiences and prevent same-scope contradictory preferences from remaining silently active.
- Surface recalled experience records and provenance in the run UI.
- Acceptance: users can create and scope entries directly; cross-workspace recall is off until enabled; conflicting/rejected knowledge is visible and governed; every injected experience has user-visible provenance.

### 4. Fix desktop entry points and task-flow defects

Findings: UX-013-A, B, C; UX-014-C, Q, S, V.

- Add a persistent empty-state Agent creation action; make generic Agent address neutral; require plans to mark unresolved assumptions and keep dependency dates consistent unless parallel work is explicitly confirmed.
- Reuse the shared dynamic API-base resolver in GraphWidget and provide error/retry UI.
- Localize Compact empty-response errors and preserve retry; expose the canonical Redirect handoff path and missing-file status; align action-item state with owner/date completeness.
- Acceptance: the new-user path is visible; graph works on negotiated ports; Compact failures explain data preservation and retry; Redirect preparation is discoverable; generated plans distinguish assumptions and dependencies.

## Integration gates

- Keep each slice in a separate, revertible commit and do not merge to `main` in this task.
- Run type/build checks after code changes. The issue reports are browser/Vite evidence; a native Tauri experience check remains required before integrating the Tauri branch into `main`.
- Preserve the existing issue reports as evidence; update this plan with commit hashes and any deferred acceptance item before completing the work.

## Execution record — 2026-09-30

All findings listed in Issues 13 and 14 were addressed on `tauri-v2-browser-embed`; no findings were deferred in this implementation pass.

- `563984e` fixes GraphWidget API-base resolution.
- `4d64651` adds the empty-desktop Agent entry point.
- `add03e9` enforces per-request access/recall/capture boundaries and aligns the multi-keyword tool schema.
- `cd0bcd0` repairs transcript indexing and turn ranges; exposes body search, compact-summary hits, workspace/archive provenance, and source relations.
- `b053944` clarifies neutral address, assumptions, dependency dates, and action-item states.
- `1e0309b` adds scoped/expiring memory creation, Chinese recall, preference conflict handling, opt-in cross-workspace experience recall, rejected-memory links, and visible experience provenance.
- `ed28ecf` localizes/retries empty Compact handoffs and exposes the Redirect path/status.
- `b54e746` reports blocked tool attempts in the final answer.
- `0b0a930` shows experience excerpts and applicability in run status.

`npm run build:server` and `npm run desktop:build` passed after the final code changes. Tests were not run. The Tauri-native experience check is still required before merging this branch into `main`; no branch merge was performed here.
