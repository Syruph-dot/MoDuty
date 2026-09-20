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
 *
 * 动画分层：该资源的反应动画是 A / M 两层设计——`X_01_A` 只键少量附件（表情/眼睛贴图），
 * `X_01_M` 只键骨骼位移，两者都是 0 时长单帧姿势，必须叠在常驻的 Idle 之上同时播放。
 * 若把它们放到 0 轨（clearTracks），Idle 会被停掉，表现为整只人冻住。
 *
 * 视线：资源里的 `Look_*` 只是「眼球朝某个固定方向」的单帧姿势（把 R_Eye / L_Eye 骨平移几单位），
 * 不会跟随鼠标。要跟随鼠标只能自己驱动这两根眼骨：每帧在 `state.apply` 之后、`updateWorldTransform`
 * 之前按指针位置叠加位移。
 *
 * 摸头：资源里的 `Pat_*` 是**纯表情**（腮红/眉毛/眼睑，0 根骨骼），本身不跟随任何东西；
 * “跟随鼠标”是叠加实现的——保持期内把 Neck / Head 朝鼠标方向偏一点（同视线那套换基），
 * 并额外叠一层 `Dev_Hair`（73 根头发/光环骨）让反应更生动。
 */
const SPINE_URL = "/spines/momoka_weekdungeon/Momoka_weekdungeon.skel";
const PIXI_URL = "/lib/pixi.js";
const PIXI_SPINE_URL = "/lib/pixi-spine.js";
/** UI 元素的根骨骼：其整棵子树的 slot 都不是立绘的一部分 */
const UI_ROOT_BONE = "UI_Con";
/** 视线骨骼（瞳孔/眼球），父级是 Head_Rot */
const EYE_BONE_NAMES = ["R_Eye", "L_Eye"];
/** 立绘只取角色高度的上一半（上半身） */
const UPPER_BODY_RATIO = 0.5;
/**
 * 「卡片上方 2/5」= 摸头判定区。
 * 该区域只做摸头，不参与磁贴壳的「按住拖动」与「点击打开」；下半 3/5 反之。
 */
const PAT_ZONE_RATIO = 0.4;
/** 摸头姿势保持时长（ms），到点收尾 */
const PAT_HOLD_MS = 2200;
/** overlay 轨道的进出混入时长（秒）：姿势层是单帧，直接切会跳，混合一下更自然 */
const OVERLAY_MIX = 0.18;
/** 0 轨 = 常驻站姿；1 轨 = 附件姿势层(A)；2 轨 = 骨骼动作层(M)；3 轨 = 摸头期间的头发/光环摆动 */
const TRACK_ATTACH = 1;
const TRACK_MOTION = 2;
const TRACK_HAIR = 3;
/** 摸头期间头/颈朝鼠标方向偏转：最大约 9°，颈只跟一部分 */
const PAT_TILT_MAX = 0.16;
const PAT_TILT_BONES: Array<{ name: string; weight: number }> = [
  { name: "Neck", weight: 0.45 },
  { name: "Head", weight: 1 },
];
/** 摸头偏转的进出平滑系数（松手后也靠它缓回去，不硬跳） */
const PAT_TILT_SMOOTH = 0.18;
/** 视线最大偏转（spine 世界单位，y 向下）；资源自带的 Look 姿势约 7 单位 */
const GAZE_MAX_X = 10;
const GAZE_MAX_Y = 6;
/** 视线平滑系数（每帧向目标插值），越小越黏 */
const GAZE_SMOOTH = 0.22;

/** 立绘情绪状态：站姿 / 摸头（点击上方 2/5） */
type DutyMood = "idle" | "pat";

/** 一组反应动画：A=附件层，M=动作层，hair=附加的头发层，End*=收尾层 */
interface Reaction {
  a?: string;
  m?: string;
  hair?: string;
  endA?: string;
  endM?: string;
}

/** 某动画键了哪些骨骼（rotate/translate/scale/shear 四类 timeline 的低 24 位是骨骼下标） */
function keyedBoneIndices(animation: any): Set<number> {
  const indices = new Set<number>();
  for (const timeline of animation?.timelines ?? []) {
    let id: unknown;
    try {
      id = timeline.getPropertyId?.();
    } catch {
      continue;
    }
    if (typeof id !== "number" || !Number.isFinite(id)) continue;
    const type = id >>> 24;
    if (type <= 3) indices.add(id - (type << 24));
  }
  return indices;
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
 * 值日生立绘（Spine 实时渲染）。
 *
 * - 运行时与资源都在 public/ 下按需加载，主包不引入 pixi；
 * - 隐藏週間ダンジョン场景自带的 UI 分支，只保留角色，并按「上一半」取景；
 * - 动画分层：Idle 常驻 0 轨；摸头的 A（附件）与 M（动作）分别叠到 1 / 2 轨，头发叠到 3 轨，
 *   收尾用 End* 播一遍再清轨；
 * - 视线：每帧驱动 R_Eye / L_Eye 两根眼骨跟随鼠标（资源自带的 Look 只是固定方向的单帧姿势）；
 * - 摸头跟随：保持期内 Neck / Head 朝鼠标方向偏转（进出都平滑），并叠头发摆动；
 * - 交互：摸头只在卡片上方 2/5 生效，且该区域内不让事件冒泡到磁贴壳（不拖动、不打开面板）；
 *   下方 3/5 留给磁贴壳的拖动/打开；
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
    let mood: DutyMood = "idle";
    let pat: Reaction = {};
    let eyeBones: any[] = [];
    /** 视线目标 / 当前（spine 世界单位，y 向下）；离开立绘时回中 */
    const gazeTarget = { x: 0, y: 0 };
    const gazeCurrent = { x: 0, y: 0 };
    /** 指针横向归一化位置（-1..1），摸头跟随时用 */
    let pointerNx = 0;
    /** 摸头跟随的强度（0..1）：进入/退出都插值，避免切状态时头硬跳 */
    let followAmount = 0;
    /** 摸头时朝鼠标偏转的骨骼（只收 Idle 自己也键了的，保证叠加不累积） */
    let tiltBones: Array<{ bone: any; weight: number }> = [];

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

    /**
     * 每帧覆盖层（在 state.apply 之后、updateWorldTransform 之前跑）：
     * 1) 视线：把「世界方向」的偏移换算到眼骨的父骨局部坐标系后写回骨骼。
     *    眼骨父级是 Head_Rot（带旋转），不能把鼠标方向直接当局部方向用，必须用父骨世界矩阵的逆换基。
     * 2) 摸头跟随：保持期内让 Neck / Head 朝鼠标方向偏转。旋转是世界量，只有父级线性部分手性为负时
     *    才需要反号；且只对「Idle 也键了的骨骼」叠加，否则 Idle 不写回时会逐帧累积。
     */
    const applyOverrides = () => {
      gazeCurrent.x += (gazeTarget.x - gazeCurrent.x) * GAZE_SMOOTH;
      gazeCurrent.y += (gazeTarget.y - gazeCurrent.y) * GAZE_SMOOTH;
      for (const bone of eyeBones) {
        const parent = bone.parent;
        if (!parent) continue;
        // 注意：a/b/c/d 在 bone.matrix 上（PIXI.Matrix），Bone 本身没有这四个直属性
        const m = parent.matrix;
        const det = m.a * m.d - m.b * m.c;
        if (!Number.isFinite(det) || Math.abs(det) < 1e-6) continue;
        bone.x = bone.data.x + (m.d * gazeCurrent.x - m.c * gazeCurrent.y) / det;
        bone.y = bone.data.y + (-m.b * gazeCurrent.x + m.a * gazeCurrent.y) / det;
      }

      followAmount += ((mood === "pat" ? 1 : 0) - followAmount) * PAT_TILT_SMOOTH;
      if (followAmount < 0.002) followAmount = 0;
      if (followAmount === 0) return;
      const worldTilt = pointerNx * PAT_TILT_MAX * followAmount;
      for (const item of tiltBones) {
        const m = item.bone.parent?.matrix;
        const det = m ? m.a * m.d - m.b * m.c : 1;
        if (!Number.isFinite(det) || Math.abs(det) < 1e-6) continue;
        item.bone.rotation += worldTilt * item.weight * (det < 0 ? -1 : 1);
      }
    };

    /** 指针移动 → 归一化到 -1..1 → 换算成最大偏转内的世界偏移 */
    const onPointerMove = (event: PointerEvent) => {
      const rect = host.getBoundingClientRect();
      if (rect.width < 2 || rect.height < 2) return;
      const nx = Math.max(-1, Math.min(1, ((event.clientX - rect.left) / rect.width) * 2 - 1));
      const ny = Math.max(-1, Math.min(1, ((event.clientY - rect.top) / rect.height) * 2 - 1));
      pointerNx = nx;
      gazeTarget.x = nx * GAZE_MAX_X;
      gazeTarget.y = ny * GAZE_MAX_Y;
    };
    const onPointerOut = () => {
      gazeTarget.x = 0;
      gazeTarget.y = 0;
    };

    /** 把一条 overlay 轨设成指定动画（0 时长姿势用 loop 保持住）；name 为空则淡出清轨 */
    const setOverlay = (track: number, name: string | undefined) => {
      if (!spine) return;
      if (!name) {
        spine.state.setEmptyAnimation(track, OVERLAY_MIX);
        return;
      }
      spine.state.setAnimation(track, name, true);
    };

    /** 进入摸头：A（附件：腮红/眉毛/眼睑）与 M（动作）分层叠加，另外叠一层头发摆动 */
    const applyPat = () => {
      if (!spine) return;
      setOverlay(TRACK_ATTACH, pat.a);
      setOverlay(TRACK_MOTION, pat.m);
      setOverlay(TRACK_HAIR, pat.hair);
    };

    /** 摸头收尾：先播 PatEnd_*（若资源提供），播完由状态机监听清轨；没有就淡出 */
    const releasePat = () => {
      if (!spine) return;
      setOverlay(TRACK_HAIR, undefined);
      if (!pat.endA && !pat.endM) {
        setOverlay(TRACK_ATTACH, undefined);
        setOverlay(TRACK_MOTION, undefined);
        return;
      }
      if (pat.endA) spine.state.setAnimation(TRACK_ATTACH, pat.endA, false);
      else setOverlay(TRACK_ATTACH, undefined);
      if (pat.endM) spine.state.setAnimation(TRACK_MOTION, pat.endM, false);
      else setOverlay(TRACK_MOTION, undefined);
    };

    const clearPatTimer = () => {
      if (patTimer !== null) {
        window.clearTimeout(patTimer);
        patTimer = null;
      }
    };

    /** 收尾动画播完 → 清空 overlay 轨，完全交回 Idle */
    const onStateComplete = (entry: any) => {
      if (disposed) return;
      const name: string | undefined = entry?.animation?.name;
      if (!name || entry.trackIndex === 0) return;
      const endNames = [pat.endA, pat.endM].filter(Boolean) as string[];
      if (!endNames.includes(name)) return;
      if (mood !== "idle") return; // 收尾途中又被摸头接管，交给新的反应
      setOverlay(TRACK_ATTACH, undefined);
      setOverlay(TRACK_MOTION, undefined);
    };

    /** 点击：摸头；仅在卡片上方 2/5 生效（下方 3/5 留给磁贴壳的打开/拖动） */
    const onClick = (event: MouseEvent) => {
      if (!pat.a && !pat.m) return;
      if (!inPatZone(event.clientY)) return;
      clearPatTimer();
      mood = "pat";
      applyPat();
      patTimer = window.setTimeout(() => {
        patTimer = null;
        mood = "idle";
        releasePat();
      }, PAT_HOLD_MS);
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
          const has = new Set(names);
          const pick = (...candidates: string[]): string | undefined => candidates.find((name) => has.has(name));
          const idle = pick("Idle_01", "Start01_Idle_01", names[0]);
          const idleAnimation = data.animations.find((animation: { name: string }) => animation.name === idle);
          pat = {
            a: pick("Pat_01_A", "Dev_Pat_01_M"),
            m: pick("Pat_01_M"),
            hair: pick("Dev_Hair"),
            endA: pick("PatEnd_01_A"),
            endM: pick("PatEnd_01_M"),
          };
          eyeBones = spine.skeleton.bones.filter((bone: any) => EYE_BONE_NAMES.includes(bone.data?.name));
          // 头/颈只对「Idle 自己也键了的骨骼」做叠加，否则 Idle 不写回时会逐帧累积
          const idleKeyed = keyedBoneIndices(idleAnimation);
          tiltBones = PAT_TILT_BONES.map((item) => {
            const index = spine.skeleton.bones.findIndex((bone: any) => bone.data?.name === item.name);
            if (index < 0 || !idleKeyed.has(index)) return null;
            return { bone: spine.skeleton.bones[index], weight: item.weight };
          }).filter(Boolean) as Array<{ bone: any; weight: number }>;

          // 视线注入点：Spine.update 的顺序是 state.update → state.apply → skeleton.updateWorldTransform
          // → slot 同步。包一层 updateWorldTransform，就能在「动画写回骨骼之后、算世界矩阵之前」改眼骨。
          const skeleton = spine.skeleton;
          const originalUpdateWorldTransform = skeleton.updateWorldTransform.bind(skeleton);
          skeleton.updateWorldTransform = () => {
            applyOverrides();
            originalUpdateWorldTransform();
          };

          // overlay 层是单帧姿势，切换时混合一下，避免硬跳
          if (spine.state.data) spine.state.data.defaultMix = OVERLAY_MIX;
          if (idle) spine.state.setAnimation(0, idle, true);
          spine.update(0); // 先把第一帧姿态算出来，再取景

          hideUiSlots(spine.skeleton);
          spine.skeleton.updateWorldTransform();
          fit();

          // 磁贴可能晚一拍才完成布局：下一帧与稍后再量一次，避免首帧尺寸偏小留下空档
          window.requestAnimationFrame(resize);
          window.setTimeout(resize, 150);

          stateListener = { complete: onStateComplete };
          spine.state.addListener(stateListener);
          resizeObserver = new ResizeObserver(resize);
          resizeObserver.observe(box);
          host.addEventListener("pointermove", onPointerMove);
          host.addEventListener("pointerleave", onPointerOut);
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
      host.removeEventListener("pointermove", onPointerMove);
      host.removeEventListener("pointerleave", onPointerOut);
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
