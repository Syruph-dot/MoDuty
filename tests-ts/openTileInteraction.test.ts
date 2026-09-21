import { test } from "node:test";
import assert from "node:assert/strict";
import { resolveOpenTileGeometry } from "../desktop/src/hooks/useOpenTileInteraction.js";

/**
 * 回归：MDG 之后那条「浏览器打开态拖动后弹回」的修复。
 *
 * 规则只有一条：**打开态 = 世界 X/Y + 整屏舞台**，agent 与 browser 必须同路。
 * 之前的差异（browser 用 layout.geometryOf 的半格几何、且没接世界坐标提交）
 * 导致它拖完回到原位。这里把这个规则钉成纯函数单测。
 */

const STAGE = { y: 0, w: 992, h: 978 };
const FREE = { x: 120, y: 240, w: 240, h: 180 };

test("打开态：用世界 X/Y + 整屏舞台（agent / browser 同一条规则）", () => {
  const geometry = resolveOpenTileGeometry({
    openMode: true,
    isOpen: true,
    stage: STAGE,
    worldX: { "brw_1": 240, agt_1: 60 },
    worldY: { "brw_1": 30 },
    id: "brw_1",
    freeGeometry: FREE,
  });
  assert.deepEqual(geometry, { x: 240, y: 30, w: 992, h: 978 });
  // 浏览器与 Agent 同规则：只是 id 不同
  assert.deepEqual(
    resolveOpenTileGeometry({
      openMode: true,
      isOpen: true,
      stage: STAGE,
      worldX: { "brw_1": 240, agt_1: 60 },
      worldY: {},
      id: "agt_1",
      freeGeometry: FREE,
    }),
    { x: 60, y: 0, w: 992, h: 978 },
  );
});

test("未落位仍有几何（x 回退 0、y 回退舞台顶），不会 NaN", () => {
  const geometry = resolveOpenTileGeometry({
    openMode: true,
    isOpen: true,
    stage: STAGE,
    worldX: {},
    worldY: {},
    id: "brw_x",
    freeGeometry: FREE,
  });
  assert.deepEqual(geometry, { x: 0, y: 0, w: 992, h: 978 });
});

test("非打开态 / 舞台未测量：回退自由网格几何", () => {
  const base = { openMode: true, isOpen: false, stage: STAGE, worldX: {}, worldY: {}, id: "agt_1", freeGeometry: FREE };
  assert.deepEqual(resolveOpenTileGeometry(base), FREE);
  assert.deepEqual(resolveOpenTileGeometry({ ...base, isOpen: true, stage: null }), FREE);
  assert.deepEqual(resolveOpenTileGeometry({ ...base, openMode: false, isOpen: true }), FREE);
});
