# Momoka Native Spine Headpat Design

**Status:** Approved in conversation on 2026-09-20

## Goal

Make Momoka’s `Momoka_weekdungeon.skel` respond to a continuous mouse stroke with its authored multi-component deformation, without procedurally rotating `Head` or `Neck`.

## Rig facts

The decoded Spine 3.8.99 asset contains the following authored interaction chain:

```text
pointer position
    -> Touch_Point_Key local translation
    -> transform constraints
    -> hair / eyebrows / halo / face components
```

The transform constraints target `Touch_Point_Key`. `Idle_01` keys `Touch_Point_Key`, so the runtime override must be applied after animation state application and before the final world-transform pass. `Pat_01_M` and `PatEnd_01_M` provide expression/color changes but contain no bone movement; they remain overlay layers rather than the motion driver.

`Touch_Eye_Key` is the analogous authored gaze driver. `R_Eye` and `L_Eye` are constraint outputs and must not be directly written by the interaction code.

## Interaction behavior

- A primary pointer-down in the portrait’s upper pat zone starts patting.
- Pointer capture keeps the stroke active while the pointer moves across the portrait.
- Pointer movement continuously updates the horizontal target of `Touch_Point_Key`.
- The target’s vertical coordinate remains at its authored position, matching the community Blue Archive viewer pattern.
- Horizontal movement is clamped to a small skeleton-space range around the current authored target.
- The driver moves toward the target with frame-independent exponential smoothing.
- Pointer-up or pointer-cancel releases patting, plays the authored pat-end overlays, and smoothly returns the driver offset to zero.
- No code writes `Head.rotation`, `Neck.rotation`, `R_Eye.x/y`, or `L_Eye.x/y` for this interaction.

## Runtime update order

The Spine update hook will perform:

1. Run the original `skeleton.updateWorldTransform()` once so animation-applied local values and parent matrices are current.
2. Apply procedural offsets to `Touch_Eye_Key` and `Touch_Point_Key` relative to the values produced by the current animation frame.
3. Run the original world-transform update again so the authored transform constraints consume the updated driver bones.

This avoids cumulative offsets and ensures the authored constraints, rather than ad-hoc component rotations, produce the visual motion.

## Scope boundaries

Only `desktop/src/components/widgets/DutyPortrait.tsx` and a small pure motion helper/test are in scope. Existing portrait cropping, UI-slot hiding, animation layering, and tile event blocking remain unchanged except where pointer-down/up handling is required for continuous patting.

## Verification

- Pure tests cover normalized pointer clamping, skeleton-space horizontal target clamping, and frame-rate-independent smoothing.
- Desktop TypeScript/Vite build must pass.
- Runtime inspection must confirm the decoded skeleton contains `Touch_Point_Key` and that pat motion changes constrained component bones without changing `Head.rotation` or `Neck.rotation`.
- Browser smoke verification must confirm no console errors and that pointer-down/move/up produces enter, follow, and return behavior.
