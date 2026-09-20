import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { normalizedPointer, worldDeltaToLocal, approach } from "../desktop/src/components/widgets/dutyPortraitMotion";

/** 实测值：Momoka weekdungeon 的 Touch_Point / Touch_Eye 父骨世界矩阵（近乎旋转 90°） */
const TOUCH_PARENT_MATRIX = { a: 0.1095, b: -0.9185, c: -0.9185, d: -0.1095 };

describe("duty portrait motion", () => {
  it("normalizes pointer coordinates and clamps them to the host", () => {
    assert.deepEqual(normalizedPointer(150, 100, { left: 100, top: 50, width: 200, height: 100 }), { x: -0.5, y: 0 });
    assert.deepEqual(normalizedPointer(-20, 200, { left: 100, top: 50, width: 200, height: 100 }), { x: -1, y: 1 });
  });

  it("maps a world-horizontal delta onto the driver's local axes (mostly local y in this rig)", () => {
    const local = worldDeltaToLocal(TOUCH_PARENT_MATRIX, 100, 0);
    assert.ok(Math.abs(local.x - 12.8) < 0.05, `local.x ≈ 12.8，实际 ${local.x}`);
    assert.ok(Math.abs(local.y + 107.35) < 0.5, `local.y ≈ -107.35，实际 ${local.y}`);
    // 回归保护：这一栋断言防的是“把局部 y 归零只留 x”的老 bug —— 那会让水平拖动变成竖直运动。
    assert.ok(Math.abs(local.y) > Math.abs(local.x) * 5, "水平位移在局部里主要落在 y 上，不能丢掉 y");
  });

  it("round-trips a world delta through the local axes", () => {
    const local = worldDeltaToLocal(TOUCH_PARENT_MATRIX, -40, 0);
    const back = {
      x: TOUCH_PARENT_MATRIX.a * local.x + TOUCH_PARENT_MATRIX.b * local.y,
      y: TOUCH_PARENT_MATRIX.c * local.x + TOUCH_PARENT_MATRIX.d * local.y,
    };
    assert.ok(Math.abs(back.x + 40) < 0.001, `回代应得世界 x=-40，实际 ${back.x}`);
    assert.ok(Math.abs(back.y) < 0.2, `回代后世界 y 应几乎为 0，实际 ${back.y}`);
    // 只取局部 x（老实现）会得到几乎纯竖直的世界位移
    const onlyX = {
      x: TOUCH_PARENT_MATRIX.a * local.x,
      y: TOUCH_PARENT_MATRIX.c * local.x,
    };
    assert.ok(Math.abs(onlyX.y) > Math.abs(onlyX.x) * 5, "丢掉局部 y 后世界位移会变成竖直（正是被修的 bug）");
  });

  it("approaches the same target independent of frame rate", () => {
    let sixtyFps = 0;
    let thirtyFps = 0;
    for (let i = 0; i < 60; i++) sixtyFps = approach(sixtyFps, 80, 10, 1 / 60);
    for (let i = 0; i < 30; i++) thirtyFps = approach(thirtyFps, 80, 10, 1 / 30);
    assert.ok(Math.abs(sixtyFps - thirtyFps) < 0.01);
  });
});
