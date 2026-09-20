# Momoka Native Spine Headpat Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace direct head/eye manipulation with continuous pointer-driven translation of Momoka’s authored Spine interaction drivers.

**Architecture:** Keep `DutyPortrait` responsible for Pixi/Spine lifecycle, pointer events, and bone integration. Put normalized pointer math, horizontal pat offset clamping, and frame-rate-independent smoothing in a DOM-free helper so the behavior can be unit-tested without loading the binary skeleton. Run Spine’s original world-transform pass, add offsets to the animation-produced driver values, then run the pass again so transform constraints render the deformation.

**Tech Stack:** React, TypeScript, PixiJS 7 UMD, pixi-spine, Node test runner via `tsx`, Vite.

---

### Task 1: Add pure pointer-motion math with tests

**Files:**
- Create: `desktop/src/components/widgets/dutyPortraitMotion.ts`
- Test: `tests-ts/dutyPortraitMotion.test.ts`

- [ ] **Step 1: Write the failing tests**

Add tests for these exported behaviors:

```ts
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { normalizedPointer, patOffset, approach } from "../desktop/src/components/widgets/dutyPortraitMotion";

describe("duty portrait motion", () => {
  it("normalizes pointer coordinates and clamps them to the host", () => {
    assert.deepEqual(normalizedPointer(50, 100, { left: 100, top: 50, width: 200, height: 100 }), { x: -0.5, y: 0 });
    assert.deepEqual(normalizedPointer(-20, 200, { left: 100, top: 50, width: 200, height: 100 }), { x: -1, y: 1 });
  });

  it("returns only a clamped horizontal pat offset", () => {
    assert.deepEqual(patOffset(-2, 80), { x: -80, y: 0 });
    assert.deepEqual(patOffset(0.25, 80), { x: 20, y: 0 });
    assert.deepEqual(patOffset(2, 80), { x: 80, y: 0 });
  });

  it("approaches the same target independent of frame rate", () => {
    let sixtyFps = 0;
    let thirtyFps = 0;
    for (let i = 0; i < 60; i++) sixtyFps = approach(sixtyFps, 80, 10, 1 / 60);
    for (let i = 0; i < 30; i++) thirtyFps = approach(thirtyFps, 80, 10, 1 / 30);
    assert.ok(Math.abs(sixtyFps - thirtyFps) < 0.01);
  });
});
```

- [ ] **Step 2: Run the focused test and verify it fails**

Run:

```powershell
npx tsx --test tests-ts/dutyPortraitMotion.test.ts
```

Expected: FAIL because `dutyPortraitMotion.ts` does not exist yet.

- [ ] **Step 3: Implement the minimal helper**

Export `normalizedPointer`, `patOffset`, and `approach`; use clamped `[-1, 1]` normalized coordinates and `1 - exp(-rate * deltaSeconds)` smoothing.

- [ ] **Step 4: Run the focused test and verify it passes**

Run the same command. Expected: all three tests pass with zero failures.

- [ ] **Step 5: Commit the pure motion slice**

```powershell
git add desktop/src/components/widgets/dutyPortraitMotion.ts tests-ts/dutyPortraitMotion.test.ts
git commit -m "test: cover Momoka pointer motion math"
```

### Task 2: Integrate authored Spine driver bones

**Files:**
- Modify: `desktop/src/components/widgets/DutyPortrait.tsx`

- [ ] **Step 1: Remove the incorrect procedural rotation path**

Delete `PAT_TILT_MAX`, `PAT_TILT_BONES`, `PAT_TILT_SMOOTH`, `keyedBoneIndices`, `tiltBones`, `followAmount`, and every write to `Head.rotation`, `Neck.rotation`, `R_Eye.x/y`, or `L_Eye.x/y`.

- [ ] **Step 2: Add driver-bone state and coordinate conversion**

Resolve `Touch_Point_Key` and `Touch_Eye_Key` after loading. Store the pointer’s normalized coordinates, pointer client X, current pat offset, and the current driver bones. Convert client X to skeleton space using the fitted stage transform, then convert the horizontal world delta into the driver parent’s local coordinates using the inverse 2x2 parent matrix.

- [ ] **Step 3: Apply animation-relative offsets in a two-pass world-transform hook**

Replace the current wrapper with this sequence:

```ts
skeleton.updateWorldTransform = () => {
  originalUpdateWorldTransform();
  applyOverrides();
  originalUpdateWorldTransform();
};
```

`applyOverrides` must add the current gaze offset to `Touch_Eye_Key`, compute a clamped horizontal pat target for `Touch_Point_Key`, smooth the pat offset toward that target, and add the offset to the current animation-produced local values. It must never rotate a head/neck bone or write an eye output bone.

- [ ] **Step 4: Replace fixed click timing with continuous pointer capture**

Register `pointerdown`, `pointerup`, and `pointercancel` on the portrait host. A primary pointer-down inside the existing upper pat zone starts the pat overlays and captures the pointer. Pointer-up/cancel releases the overlays and lets the driver return smoothly. Remove the fixed `PAT_HOLD_MS` timer and the click-triggered pat path.

- [ ] **Step 5: Run TypeScript and focused tests**

Run:

```powershell
npx tsx --test tests-ts/dutyPortraitMotion.test.ts
npm run build --prefix desktop
```

Expected: focused tests pass and the desktop Vite build exits 0.

- [ ] **Step 6: Commit the integration slice**

```powershell
git add desktop/src/components/widgets/DutyPortrait.tsx
git commit -m "feat: drive Momoka headpat through Spine touch target"
```

### Task 3: Verify the decoded rig and browser behavior

**Files:**
- No source changes expected.

- [ ] **Step 1: Run the full project test suite**

```powershell
npm test
```

Expected: exit 0 with no failed tests.

- [ ] **Step 2: Run a runtime skeleton assertion**

Load the `.skel` through the vendored Pixi runtime and assert that `Touch_Point_Key` and `Touch_Eye_Key` exist, `Head` and `Neck` rotations remain unchanged while the driver is offset, and at least one constrained component position changes.

- [ ] **Step 3: Browser smoke-test the desktop page**

Use the local desktop Vite page at `http://127.0.0.1:5173/`, open the Momoka portrait, and check pointer-down/move/up. Capture console output and a screenshot. Expected: no new console errors; the pat state follows horizontal pointer movement, uses the authored multi-component deformation, and returns to the authored idle pose after release.

- [ ] **Step 4: Review scope and commit verification evidence**

Run `git diff --check`, inspect `git diff HEAD~2`, and verify only the design, helper/test, and portrait integration files changed. Report any browser/runtime limitation honestly.
