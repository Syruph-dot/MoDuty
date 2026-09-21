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
  /** 完全脉节：老师原话有句柄，任务书一个都没沾上 */
  disconnected: boolean;
}

export function checkDispatchFidelity(originalAsk: string, task: string): DispatchFidelityCheck {
  const askHandles = extractDispatchHandles(originalAsk ?? "");
  const taskHandles = extractDispatchHandles(task ?? "");
  const missing = askHandles.filter((token) => !(task ?? "").includes(token));
  const shared = askHandles.some((token) => (task ?? "").includes(token));
  return {
    askHandles,
    taskHandles,
    missing,
    disconnected: askHandles.length > 0 && !shared,
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
 * 什么时候附：任务书与老师原话出现任何分歧迹象（句柄缺失，或完全脱节）时才附，
 * 两边一致时不附，避免每单都塞一段冗余长文。
 */
export interface DispatchEnvelope {
  /** 任务书尾巴要追加的文本（可能为空串） */
  note: string;
  /** 分歧留痕描述（不阻断派发，只用于会话留痕与工具返回，让派发者看见） */
  mismatch: string | null;
}

/** 附在任务书尾部的老师原话块（截断上限见 ASK_BLOCK_MAX_CHARS） */
const ASK_BLOCK_MAX_CHARS = 1200;

export function buildDispatchEnvelope(originalAsk: string, task: string): DispatchEnvelope {
  const ask = (originalAsk ?? '').trim();
  if (!ask) return { note: '', mismatch: null };
  const check = checkDispatchFidelity(ask, task);
  if (check.missing.length === 0) return { note: '', mismatch: null };

  const lines = ['', '（老师原话·任务书以此为准）', ask.slice(0, ASK_BLOCK_MAX_CHARS)];
  if (check.missing.length > 0) {
    lines.push('', '其中这些输入务必用上：', ...check.missing.map((token) => `- ${token}`));
  }
  const mismatch = check.disconnected
    ? `任务书与老师原话完全脱节（老师原话里的 ${check.missing.length} 个输入任务书一条都没带）——系统已把老师原话附在任务书尾部，任务书本身未改写`
    : null;
  return { note: lines.join("\n"), mismatch };
}

/**
 * 兼容入口：只要「要追加的文本」，不关心留痕。
 */
export function buildDispatchFidelityNote(originalAsk: string, task: string): string {
  return buildDispatchEnvelope(originalAsk, task).note;
}
