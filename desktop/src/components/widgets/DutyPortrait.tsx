import { useEffect, useRef, useState } from "react";
import { approach, normalizedPointer, worldDeltaToLocal } from "./dutyPortraitMotion";

declare global {
  interface Window {
    PIXI?: any;
  }
}

const SPINE_URL = "/spines/momoka_weekdungeon/Momoka_weekdungeon.skel";
const PIXI_URL = "/lib/pixi.js";
const PIXI_SPINE_URL = "/lib/pixi-spine.js";
const UI_ROOT_BONE = "UI_Con";
const UPPER_BODY_RATIO = 0.5;
const PAT_ZONE_RATIO = 0.4;
const OVERLAY_MIX = 0.18;
const TRACK_ATTACH = 1;
const TRACK_MOTION = 2;
const TRACK_HAIR = 3;
/**
 * 摸头驱动骨的“世界水平”行程上限（骨架单位）。
 * 幅度标定（实测，按修正后的换算）：驱动骨自身 ≈ 0.8×该值，头发/光环等约束目标 ≈ 0.24×；
 * 120 会让 Head_back 横移 96（≈ 半个头宽），太大；24 时驱动骨 ≈ 19、头发 ≈ 5，接近之前手感的可见幅度。
 */
const PAT_RANGE_WORLD = 24;
const PAT_DRIVER_SMOOTH = 14;
const GAZE_MAX_X = 10;
const GAZE_MAX_Y = 6;

type DutyMood = "idle" | "pat";

interface Reaction {
  a?: string;
  m?: string;
  hair?: string;
  endA?: string;
  endM?: string;
}

let runtimePromise: Promise<void> | null = null;

function loadScript(src: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const element = document.createElement("script");
    element.src = src;
    element.async = false;
    element.onload = () => resolve();
    element.onerror = () => reject(new Error(`Failed to load ${src}`));
    document.head.appendChild(element);
  });
}

function ensureSpineRuntime(): Promise<void> {
  if (!runtimePromise) {
    runtimePromise = (async () => {
      if (!window.PIXI?.Application) await loadScript(PIXI_URL);
      if (!window.PIXI?.spine?.Spine) await loadScript(PIXI_SPINE_URL);
      if (!window.PIXI?.spine?.Spine) throw new Error("pixi-spine runtime is unavailable");
    })().catch((error: unknown) => {
      runtimePromise = null;
      throw error;
    });
  }
  return runtimePromise;
}

function isUnderBone(bone: any, name: string): boolean {
  for (let current = bone; current; current = current.parent) {
    if (current.data?.name === name) return true;
  }
  return false;
}

function hideUiSlots(skeleton: any): void {
  for (const slot of skeleton.slots) {
    if (slot.bone && isUnderBone(slot.bone, UI_ROOT_BONE)) slot.color.a = 0;
  }
}

function visibleBounds(skeleton: any, yMax?: number): { x: number; y: number; width: number; height: number } | null {
  let minX = Infinity;
  let maxX = -Infinity;
  let minY = Infinity;
  let maxY = -Infinity;

  for (const slot of skeleton.slots) {
    if (slot.color.a === 0 || !slot.attachment) continue;
    const length = slot.attachment.worldVerticesLength || 8;
    if (length < 4) continue;
    const vertices = new Float32Array(length);
    try {
      slot.attachment.computeWorldVertices(slot, 0, length, vertices, 0, 2);
    } catch {
      continue;
    }
    for (let index = 0; index < vertices.length; index += 2) {
      const x = vertices[index];
      const y = vertices[index + 1];
      if (yMax !== undefined && y > yMax) continue;
      minX = Math.min(minX, x);
      maxX = Math.max(maxX, x);
      minY = Math.min(minY, y);
      maxY = Math.max(maxY, y);
    }
  }

  return Number.isFinite(minX) ? { x: minX, y: minY, width: maxX - minX, height: maxY - minY } : null;
}

export default function DutyPortrait() {
  const hostRef = useRef<HTMLSpanElement | null>(null);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    const box = (host.parentElement ?? host) as HTMLElement;
    const card = (host.closest(".tile-shell") as HTMLElement | null) ?? box;
    /** 在磁贴里吗：磁贴的容器就是格子本体（高度固定），整页的容器高度由排版决定（可能远高于角色） */
    const tileAnchored = card !== box;
    /**
     * 摸头判定（只看指针的纵向落点）。
     * - 磁贴：容器顶部 `PAT_ZONE_RATIO`，与「上方 2/5 只摸头、下方 3/5 打开/拖动」的约定一致；
     * - 整页：容器比角色高时，容器比例会落到角色头顶上方的空白里（摸不到头）；
     *   而且整页立绘没有「点击打开」这种竞争动作 ⇒ 按「角色可见部分的顶部 40%」判定。
     */
    const inPatZone = (clientY: number) => {
      const rect = card.getBoundingClientRect();
      if (rect.height <= 0) return false;
      if (tileAnchored || charHeightPx <= 0) return clientY - rect.top < rect.height * PAT_ZONE_RATIO;
      const charTop = rect.bottom - charHeightPx;
      return clientY >= charTop - 4 && clientY < charTop + charHeightPx * PAT_ZONE_RATIO;
    };
    const blockCardInPatZone = (event: MouseEvent) => {
      if (event.type === "mousedown" && event.button !== 0) return;
      if (inPatZone(event.clientY)) event.stopPropagation();
    };
    card.addEventListener("mousedown", blockCardInPatZone);
    card.addEventListener("click", blockCardInPatZone);

    let disposed = false;
    let app: any = null;
    let spine: any = null;
    let stage: any = null;
    let resizeObserver: ResizeObserver | null = null;
    let stateListener: any = null;
    let mood: DutyMood = "idle";
    let pat: Reaction = {};
    let patDriver: any = null;
    let gazeDriver: any = null;
    /** 角色可见部分在屏幕上的高度（CSS px；fit() 之后有效，用于整页里的摸头区判定） */
    let charHeightPx = 0;
    const pointer = { nx: 0, ny: 0, clientX: 0 };
    const gazeTarget = { x: 0, y: 0 };
    const gazeCurrent = { x: 0, y: 0 };
    const patOffsetCurrent = { x: 0, y: 0 };

    const measure = () => {
      const self = host.getBoundingClientRect();
      return self.width >= 2 && self.height >= 2 ? self : box.getBoundingClientRect();
    };

    const fit = () => {
      if (!app || !spine || !stage) return;
      const full = visibleBounds(spine.skeleton);
      if (!full?.width || !full.height) return;
      const band = visibleBounds(spine.skeleton, full.y + full.height * UPPER_BODY_RATIO);
      if (!band?.width || !band.height) return;
      const scale = app.screen.width / band.width;
      stage.scale.set(scale);
      stage.x = -band.x * scale;
      stage.y = app.screen.height - (band.y + band.height) * scale;
      charHeightPx = band.height * scale;
      /*
       * 整页的容器高度是排版决定的（`.duty-screen__portrait`），可能比角色高一大截，
       * 于是立绘贴着底部、头顶上方留白。把角色可见部分的真实比例汇报给容器（CSS 变量），
       * 让它按角色大小收缩；磁贴容器是满格，不使用这个变量。
       */
      if (!tileAnchored) {
        box.style.setProperty("--duty-portrait-aspect", (band.width / band.height).toFixed(4));
      }
    };

    const resize = () => {
      if (!app || disposed) return;
      const rect = measure();
      app.renderer.resize(Math.max(1, Math.round(rect.width)), Math.max(1, Math.round(rect.height)));
      fit();
    };

    let lastOverrideTime = performance.now();
    const applyOverrides = () => {
      const now = performance.now();
      const deltaSeconds = Math.min(0.05, Math.max(1 / 240, (now - lastOverrideTime) / 1000));
      lastOverrideTime = now;

      gazeCurrent.x = approach(gazeCurrent.x, gazeTarget.x, 14, deltaSeconds);
      gazeCurrent.y = approach(gazeCurrent.y, gazeTarget.y, 14, deltaSeconds);
      if (gazeDriver) {
        const local = worldDeltaToLocal(gazeDriver.parent?.matrix, gazeCurrent.x, gazeCurrent.y);
        gazeDriver.x += local.x;
        gazeDriver.y += local.y;
      }

      if (!patDriver) return;
      let targetLocal = { x: 0, y: 0 };
      if (mood === "pat" && stage && app) {
        const rect = host.getBoundingClientRect();
        const canvasX = Math.max(0, Math.min(app.screen.width, ((pointer.clientX - rect.left) / Math.max(1, rect.width)) * app.screen.width));
        const scale = Number(stage.scale?.x) || 1;
        const pointerWorldX = (canvasX - stage.x) / scale;
        // 只驱动“世界水平”一维：竖向留在 authored 位置（worldOffset 的 y 恒为 0）。
        // 注意：换算成局部后 x/y 两个分量都要写回 —— 父骨近乎旋转 90°，水平位移在局部里主要在 y 上，
        // 把局部 y 归零会让实际运动变成竖直（即“左右移动却上下动”）。详见 dutyPortraitMotion.worldDeltaToLocal。
        const worldOffset = Math.max(-PAT_RANGE_WORLD, Math.min(PAT_RANGE_WORLD, pointerWorldX - patDriver.worldX));
        targetLocal = worldDeltaToLocal(patDriver.parent?.matrix, worldOffset, 0);
      }
      patOffsetCurrent.x = approach(patOffsetCurrent.x, targetLocal.x, PAT_DRIVER_SMOOTH, deltaSeconds);
      patOffsetCurrent.y = approach(patOffsetCurrent.y, targetLocal.y, PAT_DRIVER_SMOOTH, deltaSeconds);
      patDriver.x += patOffsetCurrent.x;
      patDriver.y += patOffsetCurrent.y;
    };

    const onPointerMove = (event: PointerEvent) => {
      const rect = host.getBoundingClientRect();
      if (rect.width < 2 || rect.height < 2) return;
      const normalized = normalizedPointer(event.clientX, event.clientY, rect);
      pointer.nx = normalized.x;
      pointer.ny = normalized.y;
      pointer.clientX = event.clientX;
      gazeTarget.x = normalized.x * GAZE_MAX_X;
      gazeTarget.y = normalized.y * GAZE_MAX_Y;
    };
    const onPointerOut = () => {
      gazeTarget.x = 0;
      gazeTarget.y = 0;
    };

    const setOverlay = (track: number, name: string | undefined) => {
      if (!spine) return;
      if (name) spine.state.setAnimation(track, name, true);
      else spine.state.setEmptyAnimation(track, OVERLAY_MIX);
    };
    const applyPat = () => {
      if (!spine) return;
      setOverlay(TRACK_ATTACH, pat.a);
      setOverlay(TRACK_MOTION, pat.m);
      setOverlay(TRACK_HAIR, pat.hair);
    };
    const releasePat = () => {
      if (!spine) return;
      setOverlay(TRACK_HAIR, undefined);
      if (pat.endA) spine.state.setAnimation(TRACK_ATTACH, pat.endA, false);
      else setOverlay(TRACK_ATTACH, undefined);
      if (pat.endM) spine.state.setAnimation(TRACK_MOTION, pat.endM, false);
      else setOverlay(TRACK_MOTION, undefined);
    };
    const onStateComplete = (entry: any) => {
      if (disposed || mood !== "idle") return;
      const name = entry?.animation?.name;
      const endNames = [pat.endA, pat.endM].filter(Boolean);
      if (entry?.trackIndex !== 0 && endNames.includes(name)) {
        setOverlay(TRACK_ATTACH, undefined);
        setOverlay(TRACK_MOTION, undefined);
      }
    };
    const onPointerDown = (event: PointerEvent) => {
      if (event.button !== 0 || !inPatZone(event.clientY) || (!pat.a && !pat.m)) return;
      event.preventDefault();
      event.stopPropagation();
      onPointerMove(event);
      mood = "pat";
      applyPat();
      try {
        host.setPointerCapture(event.pointerId);
      } catch {
        /* Pointer capture is unavailable in some embedded WebViews. */
      }
    };
    const onPointerUp = (event: PointerEvent) => {
      if (mood !== "pat") return;
      onPointerMove(event);
      mood = "idle";
      releasePat();
      try {
        if (host.hasPointerCapture(event.pointerId)) host.releasePointerCapture(event.pointerId);
      } catch {
        /* Pointer capture may already have been released by the browser. */
      }
    };

    void ensureSpineRuntime()
      .then(() => {
        if (disposed) return;
        const PIXI = window.PIXI;
        const rect = measure();
        app = new PIXI.Application({
          width: Math.max(1, Math.round(rect.width)),
          height: Math.max(1, Math.round(rect.height)),
          transparent: true,
          antialias: true,
          resolution: Math.min(window.devicePixelRatio || 1, 2),
          autoDensity: true,
        });
        const view = app.view as HTMLCanvasElement;
        view.style.display = "block";
        view.style.width = "100%";
        view.style.height = "100%";
        host.appendChild(view);

        app.loader.add("momoka", SPINE_URL);
        app.loader.load((_loader: unknown, resources: Record<string, any>) => {
          if (disposed) return;
          const data = resources?.momoka?.spineData;
          if (!data) {
            setFailed(true);
            return;
          }
          spine = new PIXI.spine.Spine(data);
          stage = new PIXI.Container();
          stage.addChild(spine);
          app.stage.addChild(stage);

          const names: string[] = (data.animations ?? []).map((animation: { name: string }) => animation.name);
          const has = new Set(names);
          const pick = (...candidates: string[]): string | undefined => candidates.find((name) => has.has(name));
          const idle = pick("Idle_01", "Start01_Idle_01", names[0]);
          pat = {
            a: pick("Pat_01_A", "Dev_Pat_01_M"),
            m: pick("Pat_01_M"),
            hair: pick("Dev_Hair"),
            endA: pick("PatEnd_01_A"),
            endM: pick("PatEnd_01_M"),
          };
          patDriver = spine.skeleton.bones.find((bone: any) => bone.data?.name === "Touch_Point_Key");
          gazeDriver = spine.skeleton.bones.find((bone: any) => bone.data?.name === "Touch_Eye_Key");

          const skeleton = spine.skeleton;
          const originalUpdateWorldTransform = skeleton.updateWorldTransform.bind(skeleton);
          skeleton.updateWorldTransform = () => {
            originalUpdateWorldTransform();
            applyOverrides();
            originalUpdateWorldTransform();
          };

          if (spine.state.data) spine.state.data.defaultMix = OVERLAY_MIX;
          if (idle) spine.state.setAnimation(0, idle, true);
          spine.update(0);
          hideUiSlots(spine.skeleton);
          spine.skeleton.updateWorldTransform();
          fit();
          window.requestAnimationFrame(resize);
          window.setTimeout(resize, 150);

          stateListener = { complete: onStateComplete };
          spine.state.addListener(stateListener);
          resizeObserver = new ResizeObserver(resize);
          resizeObserver.observe(box);
          host.addEventListener("pointermove", onPointerMove);
          host.addEventListener("pointerleave", onPointerOut);
          host.addEventListener("pointerdown", onPointerDown);
          host.addEventListener("pointerup", onPointerUp);
          host.addEventListener("pointercancel", onPointerUp);
        });
      })
      .catch(() => {
        if (!disposed) setFailed(true);
      });

    return () => {
      disposed = true;
      resizeObserver?.disconnect();
      card.removeEventListener("mousedown", blockCardInPatZone);
      card.removeEventListener("click", blockCardInPatZone);
      try {
        if (stateListener) spine?.state?.removeListener(stateListener);
      } catch {
        /* Ignore teardown races with the runtime loader. */
      }
      host.removeEventListener("pointermove", onPointerMove);
      host.removeEventListener("pointerleave", onPointerOut);
      host.removeEventListener("pointerdown", onPointerDown);
      host.removeEventListener("pointerup", onPointerUp);
      host.removeEventListener("pointercancel", onPointerUp);
      try {
        app?.destroy(true, { children: true });
      } catch {
        /* Ignore renderer teardown races. */
      }
    };
  }, []);

  if (failed) return <span className="duty-girl__fallback">立绘待提供</span>;
  return <span className="duty-girl__portrait-stage" ref={hostRef} aria-hidden="true" />;
}
