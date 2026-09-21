/**
 * 派发保真：任务书里不能丢老师给的「关键输入句柄」（URL / 绝对路径）。
 *
 * 实测教训（2026-09-21 MDG-BlogWebsite 任务）：
 * 老师消息是「https://github.com/…  研究一下别人给我的资产…给出方案」，
 * 值日生派发时把任务概括成一句话，**链接没进任务书**；执行者从头到尾拿不到仓库地址，
 * 只能反问 + 全局乱搜（猜自己的会话 id、翻值日生会话），最后一轮工具调用后空响应报错，
 * 任务白跑、台账卡在等判读。派发者是人（模型），把她的概括当成唯一事实源不可靠——
 * 所以由系统兜一层：原话里有、任务书里没有的句柄，自动补进任务书尾部。
 *
 * 纯函数、无依赖：便于单测（tests-ts/dispatch-fidelity.test.ts）。
 */

/** 结尾要剥掉的标点/引号（中英文混排时句尾经常粘着标点） */
const TRAILING_NOISE = /[\s，。；、）)】》"'`]+$/u;
/** 开头要剥掉的左引号 */
const LEADING_NOISE = /^[（(【《"'`]+/u;

/** 句柄内的终止字符：空白 + 中文标点 + 常见右引号 */
const STOP = '\\s，。；、）)】》"\'`';

const URL_RE = new RegExp(`https?://[^${STOP}]+`, "gu");
/** Windows 盘符路径：`D:\…` 与 `C:/…` 两种写法都要认（实测有人两种混用）。
 *  负向后顾排除 URL 里的 `s:/`（`https://` 会被 [A-Za-z]:[/] 误当成盘符） */
const WIN_PATH_RE = new RegExp(`(?<![A-Za-z0-9])[A-Za-z]:[\\\\/][^${STOP}]+`, "gu");
const HOME_PATH_RE = new RegExp(`~/[^${STOP}]+`, "gu");

/**
 * 从一段文本里抽「关键输入句柄」：http(s) URL、Windows 盘符路径（\ 或 / 分隔）、~/ 开头路径。
 * 去重、剥首尾标点、上限 12 条（防止把整段话当成句柄列表）。
 */
export function extractDispatchHandles(text: string): string[] {
  const out: string[] = [];
  const push = (raw: string): void => {
    const token = raw.replace(TRAILING_NOISE, "").replace(LEADING_NOISE, "").trim();
    if (!token || out.includes(token)) return;
    out.push(token);
  };
  const source = text ?? "";
  for (const match of source.matchAll(URL_RE)) push(match[0]);
  for (const match of source.matchAll(WIN_PATH_RE)) push(match[0]);
  for (const match of source.matchAll(HOME_PATH_RE)) push(match[0]);
  return out.slice(0, 12);
}

/**
 * 任务书与老师原话的一致性体检。
 *
 * 为什么要体检而不是只补全（2026-09-21 实测）：老师在同一条会话里发了**新任务**
 * （TypeSafe AI / Jev 的博客解读，原话带 3 个 typesafe.ai 链接），值日生却把历史里
 * 那条「研究一下别人给我的资产…网站服务器到期…」的**旧任务书原文**当成任务书派了出去，
 * 还顺手把新执行者命名为「网站迁移」；系统随后把老师原话里的 3 个新链接「保真补全」
 * 贴到那条旧任务书上——旧任务 + 新链接拼成了一条谁都没要过的任务，执行者拿到的输入是错的。
 *
 * 补全只能补“漏”，補不了“错”：任务书与老师原话完全脉节时，补全反而掩盖了错误。
 * 所以那条路径改成拒绝派发：让派发者拿着老师这条最新消息重写任务书。
 */
export interface DispatchFidelityCheck {
  /** 老师原话里的句柄 */
  askHandles: string[];
  /** 任务书里的句柄 */
  taskHandles: string[];
  /** 老师原话里有、任务书里没有的 */
  missing: string[];
  /** 指令与老师原话的二元组重合度（0–1） */
  overlap: number;
  /** 完全脉节：指令与老师原话几乎没有任何共同文本（不是在说同一件事） */
  disconnected: boolean;
}

/** 重合度低于这个值就认为指令与老师原话说的不是同一件事 */
export const DISCONNECTED_OVERLAP = 0.2;

/**
 * 老师原话与指令的文本重合度（CJK/任意字符的二元组包含率，0–1）。
 *
 * 用来判断「值日生写的指令到底是不是在说老师这件事」——不能再用「句柄有没有带上」
 * 当判据（那只能看出“漏”，看不出“错”），而且原话现在每单必带，句柄缺失已经无害。
 */
export function textOverlapRatio(originalAsk: string, task: string): number {
  const flat = (text: string): string => (text ?? "").replace(/\s+/gu, "");
  const grams = (text: string): string[] => {
    const s = flat(text);
    const out: string[] = [];
    for (let i = 0; i + 1 < s.length; i += 1) out.push(s.slice(i, i + 2));
    return out;
  };
  const taskGrams = grams(task);
  if (taskGrams.length === 0) return 1;
  const askGrams = new Set(grams(originalAsk));
  return taskGrams.filter((gram) => askGrams.has(gram)).length / taskGrams.length;
}

export function checkDispatchFidelity(originalAsk: string, task: string): DispatchFidelityCheck {
  const ask = (originalAsk ?? "").trim();
  const body = (task ?? "").trim();
  const askHandles = extractDispatchHandles(ask);
  const taskHandles = extractDispatchHandles(body);
  const missing = askHandles.filter((token) => !body.includes(token));
  const overlap = body ? textOverlapRatio(ask, body) : 1;
  return {
    askHandles,
    taskHandles,
    missing,
    overlap,
    disconnected: body.length > 0 && ask.length > 0 && overlap < DISCONNECTED_OVERLAP,
  };
}

/**
 * 原话随行的信封（不做拒绝、不改写任务书）。
 *
 * 为什么不做硬拒绝（2026-09-21 复盘）：拒绝会把**模型的笔误升级成对老师的阻塞**——
 * 老师发一句话，因为模型写错参数，任务根本没发出去；也会误伤「老师顺带提了个链接、
 * 任务确实用不到」这种正常派发。而系统手里本来就有老师的原话：正确做法是**带上它**，
 * 让执行者永远拿得到真话，老师的任务永远发得出去，笔误不再有致命后果。
 *
 * 什么时候用：**每单都这么发**。老师原话是执行者唯一拿得到的权威任务文本，
 * 不依赖任何「分歧迹象」判断——判据本身也会错，而原话永远是对的。
 */
export interface DispatchMessage {
  /** 实际下发给执行者的消息正文 */
  message: string;
  /** 分歧留痕描述（不阻断派发，只用于会话留痕与工具返回，让派发者看见） */
  mismatch: string | null;
}

/** 老师原话截断上限（原话是权威文本，但也不能让单条消息无限长） */
export const ASK_MAX_CHARS = 2000;

/** 指令行的固定提示：值日生写的任务书是补充要求，冲突时以老师原话为准 */
const INSTRUCTION_LABEL = "指令（值日生的补充要求；与总体任务冲突时以总体任务为准）";

/**
 * 执行者侧的关键输入层：把本次任务里的 URL / 路径单独拎出来列一层。
 *
 * 理由：这些东西原本埋在任务书散文里，模型要么漏用、要么反复去猜（实测 MDG 任务：
 * 执行者从头到尾拿不到仓库地址）。单独成层后它们是“字段”而不是“叙述”。
 * 无句柄时返回空串（不占 token）。
 */
export function buildTaskInputBlock(message: string): string {
  const handles = extractDispatchHandles(message ?? "");
  if (handles.length === 0) return "";
  return ["## 本次任务的关键输入（务必用上）", ...handles.map((token) => `- ${token}`)].join("\n");
}

/**
 * 构造下发消息：`总体任务：<老师原话>` + `指令：<值日生给的说明，可为空>`。
 *
 * 顺序与措辞由用户拍板（2026-09-21）：总体任务在前且必须是原话；指令是值日生
 * 生成（或可能不生成）的补充说明。这样即使值日生把指令写错（实测把历史里的旧任务书
 * 抄成了新指令），执行者手里也一定有老师这次真正说的话。
 */
export function buildDispatchMessage(input: { ask?: string; task: string }): DispatchMessage {
  const ask = (input.ask ?? "").trim();
  const task = (input.task ?? "").trim();
  // 拿不到老师原话（例如调用者不是会话）：退回只发任务文本，不编造
  if (!ask) return { message: task, mismatch: null };

  const askText = ask.length > ASK_MAX_CHARS
    ? `${ask.slice(0, ASK_MAX_CHARS)}\n…（老师原话过长已截断，完整原话见老师会话）`
    : ask;
  // 值日生把原话原样当作指令时不必重复一遍
  const instruction = task && task !== ask ? task : "";
  const message = instruction
    ? `总体任务：${askText}\n\n${INSTRUCTION_LABEL}：${instruction}`
    : `总体任务：${askText}`;

  const check = checkDispatchFidelity(ask, task);
  const mismatch = check.disconnected
    ? `值日生的指令与老师原话说的不是同一件事（文本重合度 ${(check.overlap * 100).toFixed(0)}%）——已按「总体任务 = 老师原话」下发，指令仅作补充；若指令本身写错了，请用老师这条最新消息重派一条并取消本条`
    : null;
  return { message, mismatch };
}
