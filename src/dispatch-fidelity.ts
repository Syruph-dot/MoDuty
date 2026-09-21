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
 * 生成补全说明：只补「原话里有、任务书里没有」的句柄，不改写任务书本身。
 * 没有缺失（或原话里本来就没有句柄）时返回空串，调用方拼接即可。
 */
export function buildDispatchFidelityNote(originalAsk: string, task: string): string {
  const handles = extractDispatchHandles(originalAsk ?? "");
  const missing = handles.filter((token) => !task.includes(token));
  if (missing.length === 0) return "";
  return [
    "",
    "（派发保真补全：老师原话里给了下面这些，任务书里没带上 → 一并按此处理）",
    ...missing.map((token) => `- ${token}`),
  ].join("\n");
}
