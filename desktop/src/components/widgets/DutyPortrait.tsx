import { useEffect, useRef, useState } from "react";

/** 全局 pixi 运行时（vendored UMD，按需注入；不进主包） */
declare global {
  interface Window {
    PIXI?: any;
  }
}

/**
 * 值日生立绘资源：Momoka（桃香 · 蔚蓝档案 NPC）週間ダンジョン版 Spine。
 *
 * 这套骨架是「週間ダンジョン」整场景：左侧是角色，右侧挂了一整套 UI（按钮/能量条/背景线），
 * 所以渲染前要先把 UI 分支隐藏，再按角色包围盒取景；磁贴只要上半身，故再截角色高度的上一半。
 */
const SPINE_URL = "/spines/momoka_weekdungeon/Momoka_weekdungeon.skel";
const PIXI_URL = "/lib/pixi.js";
const PIXI_SPINE_URL = "/lib/pixi-spine.js";
/** UI 元素的根骨骼：其整棵子树的 slot 都不是立绘的一部分 */
const UI_ROOT_BONE = "UI_Con";
/** 立绘只取角色高度的上一半（上半身） */
const UPPER_BODY_RATIO = 0.5;
/**
 * 「卡片上方 2/5」= 摸头判定区。
 * 该区域只做摸头，不参与磁贴壳的「按住拖动」与「点击打开」；下半 3/5 反之。
 */
const PAT_ZONE_RATIO = 0.4;
/** 摸头入场动作播完后的保持时长（ms），之后收尾回站姿 */
const PAT_HOLD_MS = 1600;

/** 立绘情绪状态：站姿 / 看向（悬停）/ 摸头（点击） */
type DutyMood = "idle" | "look" | "pat";

interface AnimationChains {
  idle: string[];
  look: string[];
  lookEnd: string[];
  pat: string[];
  patEnd: string[];
}

let runtimePromise: Promise<void> | null = null;

function loadScript(src: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const el = document.createElement("script");
    el.src = src;
    el.async = false;
    el.onload = () => resolve();
    el.onerror = () => reject(new Error(`脚本加载失败: ${src}`));
    document.head.appendChild(el);
  });
}

/** 幂等注入 pixi.js + pixi-spine.js；失败时清空缓存以便下次重试 */
function ensureSpineRuntime(): Promise<void> {
  if (!runtimePromise) {
    runtimePromise = (async () => {
      if (!window.PIXI?.Application) await loadScript(PIXI_URL);
      if (!window.PIXI?.spine?.Spine) await loadScript(PIXI_SPINE_URL);
      if (!window.PIXI?.spine?.Spine) throw new Error("pixi-spine 运行时未就绪");
    })().catch((error: unknown) => {
      runtimePromise = null;
      throw error;
    });
  }
  return runtimePromise;
}

function isUnderBone(bone: any, name: string): boolean {
  for (let cursor = bone; cursor; cursor = cursor.parent) {
    if (cursor.data?.name === name) return true;
  }
  return false;
}

/** 把 UI 分支的 slot 全部设为透明（不参与渲染，也不计入取景） */
function hideUiSlots(skeleton: any): void {
  for (const slot of skeleton.slots) {
    if (slot.bone && isUnderBone(slot.bone, UI_ROOT_BONE)) slot.color.a = 0;
  }
}

/**
 * 可见槽位的世界顶点包围盒（alpha=0 的 UI 槽位不计入）。
 * yMax 非空时只统计该高度以内的顶点——用来裁出上半身。
 *
 * 不能用 spine.getLocalBounds()：它按几何算，会把透明掉的 UI 也框进去，角色因此被挤到角落。
 */
function visibleBounds(
  skeleton: any,
  yMax?: number,
): { x: number; y: number; width: number; height: number } | null {
  let minX = Infinity;
  let maxX = -Infinity;
  let minY = Infinity;
  let maxY = -Infinity;
  for (const slot of skeleton.slots) {
    if (slot.color.a === 0) continue;
    const attachment = slot.attachment;
    if (!attachment) continue;
    const length = attachment.worldVerticesLength || 8;
    if (length < 4) continue;
    const vertices = new Float32Array(length);
    try {
      attachment.computeWorldVertices(slot, 0, length, vertices, 0, 2);
    } catch {
      continue;
    }
    for (let i = 0; i < vertices.length; i += 2) {
      const y = vertices[i + 1];
      if (yMax !== undefined && y > yMax) continue;
      const x = vertices[i];
      if (x < minX) minX = x;
      if (x > maxX) maxX = x;
      if (y < minY) minY = y;
      if (y > maxY) maxY = y;
    }
  }
  return Number.isFinite(minX) ? { x: minX, y: minY, width: maxX - minX, height: maxY - minY } : null;
}

/**
 * 组装动作链（过滤掉资源里不存在的动画，缺失时整条链可能为空 → 调用方跳过）。
 * Spine 的惯例是 `X_01_A`（入）→ `X_01_M`（维持循环），`XEnd_01_*` 收尾。
 * idle 只取首个可用站姿动画（单节链 = 直接循环），不能把候选全接成链。
 */
function buildChains(names: string[]): AnimationChains {
  const has = new Set(names);
  const first = (...candidates: Array<string | undefined>): string | undefined =>
    candidates.find((name): name is string => !!name && has.has(name));
  const seq = (...candidates: string[]): string[] => candidates.filter((name) => has.has(name));
  const idle = first("Idle_01", "Start01_Idle_01", names[0]);
  return {
    idle: idle ? [idle] : [],
    look: seq("Look_01_A", "Look_01_M"),
    lookEnd: seq("LookEnd_01_A", "Idle_01"),
    pat: seq("Pat_01_A", "Pat_01_M"),
    patEnd: seq("PatEnd_01_A", "Idle_01"),
  };
}

/**
 * 值日生立绘（Spine 实时渲染）。
 *
 * - 运行时与资源都在 public/ 下按需加载，主包不引入 pixi；
 * - 隐藏週間ダンジョン场景自带的 UI 分支，只保留角色，并按「上一半」取景；
 * - 交互：悬停 → 看向（Look）；移开 → 收尾回站姿；摸头（Pat）只在卡片上方 2/5 生效，
 *   且该区域内不让事件冒泡到磁贴壳（不拖动、不打开面板）；下方 3/5 留给磁贴壳的拖动/打开；
 * - 容器变化（磁贴开合/缩放）用 ResizeObserver 跟随；
 * - 任一环节失败（脚本、资源、解码）都回落到「立绘待提供」占位，不影响磁贴其它功能。
 */
export default function DutyPortrait() {
  const hostRef = useRef<HTMLSpanElement | null>(null);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    // 以立绘区（带描边的外层）作为尺寸基准：外层尺寸确定，不依赖百分比高度链
    const box = (host.parentElement ?? host) as HTMLElement;

    /** 「卡片」= 磁贴壳（取不到就退回立绘区）；摸头判定区 = 卡片上方 2/5 */
    const card = (host.closest(".tile-shell") as HTMLElement | null) ?? box;
    const inPatZone = (clientY: number) => {
      const rect = card.getBoundingClientRect();
      return rect.height > 0 && clientY - rect.top < rect.height * PAT_ZONE_RATIO;
    };
    /**
     * 上 2/5 内不让事件冒泡到磁贴壳。
     * 磁贴壳的 onMouseDown（按住拖动）/ onClick（打开）是 React 合成事件，挂在内层根容器上；
     * 在卡片这一层用【冒泡阶段】拦住，既让本组件自己的 click 先完成摸头，又不会启动拖动/打开。
     * （若用捕获阶段，事件根本到不了立绘元素，摸头也会一并失效。）
     */
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
    let patTimer: number | null = null;
    let stateListener: any = null;
    let hovering = false;
    let mood: DutyMood = "idle";
    let chains: AnimationChains | null = null;

    /** 量取画布实际占据的盒子：优先立绘舞台自身（绝对定位后尺寸确定）；退化时回退到外层立绘区 */
    const measure = () => {
      const self = host.getBoundingClientRect();
      if (self.width >= 2 && self.height >= 2) return self;
      return box.getBoundingClientRect();
    };

    /**
     * 取景：宽度铺满 + 下边缘贴底。
     *
     * 用等比缩放（scale 单值），所以不会拉伸变形；只有磁贴比例与上半身框不一致时，
     * 多余的纵向部分从顶部裁掉（下缘对齐 = 上半身的“截断线”正好落在磁贴底边）。
     */
    const fit = () => {
      if (!app || !spine || !stage) return;
      const full = visibleBounds(spine.skeleton);
      if (!full || !full.width || !full.height) return;
      const band = visibleBounds(spine.skeleton, full.y + full.height * UPPER_BODY_RATIO);
      if (!band || !band.width || !band.height) return;
      const width = app.screen.width as number;
      const height = app.screen.height as number;
      const scale = width / band.width;
      stage.scale.set(scale);
      stage.x = -band.x * scale;
      stage.y = height - (band.y + band.height) * scale;
    };

    const resize = () => {
      if (!app || disposed) return;
      const rect = measure();
      app.renderer.resize(Math.max(1, Math.round(rect.width)), Math.max(1, Math.round(rect.height)));
      fit();
    };

    /** 播一条动作链：首节按需一次性播完，末节循环（单节链直接循环） */
    const playChain = (chain: string[]) => {
      if (!spine || chain.length === 0) return;
      spine.state.clearTracks();
      spine.state.setAnimation(0, chain[0], chain.length === 1);
      for (let i = 1; i < chain.length; i += 1) {
        spine.state.addAnimation(0, chain[i], i === chain.length - 1, 0);
      }
    };

    const clearPatTimer = () => {
      if (patTimer !== null) {
        window.clearTimeout(patTimer);
        patTimer = null;
      }
    };

    /** 摸头收尾：仍悬停就回「看向」，否则回站姿 */
    const schedulePatExit = () => {
      clearPatTimer();
      patTimer = window.setTimeout(() => {
        patTimer = null;
        if (!chains) return;
        if (hovering && chains.look.length > 0) {
          playChain(chains.look);
          mood = "look";
        } else {
          playChain(chains.patEnd.length > 0 ? chains.patEnd : chains.idle);
          mood = "idle";
        }
      }, PAT_HOLD_MS);
    };

    /**
     * 摸头入场（非循环）播完才开始保持计时。
     * 用状态机监听而不是写死入场时长，这样入场长短变化时不会被截断。
     */
    const onStateComplete = (entry: any) => {
      if (disposed || !chains) return;
      if (entry?.trackIndex !== 0) return;
      if (mood !== "pat" || chains.pat.length < 2) return;
      if (entry.animation?.name !== chains.pat[0]) return;
      schedulePatExit();
    };

    /** 悬停：看向（摸头进行中不打断） */
    const onEnter = () => {
      hovering = true;
      if (!chains || mood === "pat") return;
      if (chains.look.length === 0) return;
      playChain(chains.look);
      mood = "look";
    };

    /** 移开：仅打断「看向」，让它收尾回站姿；摸头等计时器自然收尾 */
    const onLeave = () => {
      hovering = false;
      if (!chains || mood !== "look") return;
      playChain(chains.lookEnd.length > 0 ? chains.lookEnd : chains.idle);
      mood = "idle";
    };

    /** 点击：摸头；仅在卡片上方 2/5 生效（下方 3/5 留给磁贴壳的打开/拖动） */
    const onClick = (event: MouseEvent) => {
      if (!chains || chains.pat.length === 0) return;
      if (!inPatZone(event.clientY)) return;
      clearPatTimer();
      playChain(chains.pat);
      mood = "pat";
      // 单节链（只有维持动作）不会触发 complete，直接计时收尾
      if (chains.pat.length === 1) schedulePatExit();
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

        // pixi-spine 的 loader 会把 .skel 同目录的 .atlas 自动作为依赖加载
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
          chains = buildChains(names);
          playChain(chains.idle);
          mood = "idle";
          spine.update(0); // 先把第一帧姿态算出来，再取景

          stateListener = { complete: onStateComplete };
          spine.state.addListener(stateListener);

          hideUiSlots(spine.skeleton);
          spine.skeleton.updateWorldTransform();
          fit();

          // 磁贴可能晚一拍才完成布局：下一帧与稍后再量一次，避免首帧尺寸偏小留下空档
          window.requestAnimationFrame(resize);
          window.setTimeout(resize, 150);

          resizeObserver = new ResizeObserver(resize);
          resizeObserver.observe(box);
          host.addEventListener("pointerenter", onEnter);
          host.addEventListener("pointerleave", onLeave);
          host.addEventListener("click", onClick);
        });
      })
      .catch(() => {
        if (!disposed) setFailed(true);
      });

    return () => {
      disposed = true;
      clearPatTimer();
      resizeObserver?.disconnect();
      card.removeEventListener("mousedown", blockCardInPatZone);
      card.removeEventListener("click", blockCardInPatZone);
      try {
        if (stateListener) spine?.state?.removeListener(stateListener);
      } catch {
        /* 已销毁的 state 忽略 */
      }
      host.removeEventListener("pointerenter", onEnter);
      host.removeEventListener("pointerleave", onLeave);
      host.removeEventListener("click", onClick);
      try {
        app?.destroy(true, { children: true });
      } catch {
        /* 卸载期渲染器可能已失效，忽略 */
      }
    };
  }, []);

  if (failed) return <span className="duty-girl__fallback">立绘待提供</span>;
  return <span className="duty-girl__portrait-stage" ref={hostRef} aria-hidden="true" />;
}
