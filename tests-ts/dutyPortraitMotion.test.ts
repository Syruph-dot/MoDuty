import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { normalizedPointer, patOffset, approach } from "../desktop/src/components/widgets/dutyPortraitMotion";

describe("duty portrait motion", () => {
  it("normalizes pointer coordinates and clamps them to the host", () => {
    assert.deepEqual(normalizedPointer(150, 100, { left: 100, top: 50, width: 200, height: 100 }), { x: -0.5, y: 0 });
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
