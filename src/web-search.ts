/**
 * 网页检索（`web_search` 工具的实现）。
 *
 * 刻意**不经过受管浏览器**：这是一次简单的 HTTP 检索，与浏览器磁贴/内嵌毫无关系。
 * 原实现借道一个无痕浏览器实例，代价是让受管浏览器多背一个"没有磁贴的窗口"场景——
 * 而那正是内嵌路线最难解的问题（原生 webview 需要窗口）。
 *
 * 顺带修掉一个既有缺陷：原实现从 `snapshot.refs[ref]` 取结果 URL，但那里存的是
 * **CSS 选择器**（形如 `div > a:nth-child(1)`），永远不可能以 `http` 开头，
 * 所以它实际上一直返回"未找到相关结果"。
 *
 * 端点可用 `MOMOKA_SEARCH_ENDPOINT` 覆盖；默认用 cn.bing.com
 * （实测本机可达；DuckDuckGo 全系不可达）。
 */

export interface SearchHit {
  title: string;
  url: string;
}

const DEFAULT_ENDPOINT = "https://cn.bing.com/search";
const USER_AGENT =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/154.0.0.0 Safari/537.36";

/** 结果块：Bing 把每条自然结果放在 `<li class="b_algo">` 里 */
const RESULT_BLOCK_RE = /<li class="b_algo"[\s\S]*?<\/li>/gu;
/** 标题锚点 */
const ANCHOR_RE = /<h2[^>]*>\s*<a[^>]+href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/u;
/** 跳转包装（部分引擎会把真实地址放在 uddg 参数里） */
const UDDG_RE = /[?&]uddg=([^&]+)/u;

function decodeEntities(value: string): string {
  return value
    .replace(/&quot;/gu, "\"")
    .replace(/&#39;/gu, "'")
    .replace(/&lt;/gu, "<")
    .replace(/&gt;/gu, ">")
    .replace(/&nbsp;/gu, " ")
    .replace(/&amp;/gu, "&")
    .replace(/&#x([0-9a-f]+);/giu, (_, hex: string) => String.fromCodePoint(Number.parseInt(hex, 16)))
    .replace(/&#(\d+);/gu, (_, dec: string) => String.fromCodePoint(Number.parseInt(dec, 10)));
}

function stripTags(value: string): string {
  return decodeEntities(value.replace(/<[^>]+>/gu, "")).replace(/\s+/gu, " ").trim();
}

/** 从跳转包装里还原真实地址 */
function unwrapUrl(raw: string): string {
  const decoded = decodeEntities(raw);
  const match = UDDG_RE.exec(decoded);
  if (match) return decodeURIComponent(match[1]);
  return decoded;
}

export function searchEndpoint(): string {
  return process.env.MOMOKA_SEARCH_ENDPOINT?.trim() || DEFAULT_ENDPOINT;
}

export interface WebSearchOptions {
  maxResults?: number;
  /** 单次请求超时（默认 20s） */
  timeoutMs?: number;
  signal?: AbortSignal;
}

/** 检索网页。失败时抛错，由工具层转成可读文本（不静默返回空）。 */
export async function webSearch(query: string, options: WebSearchOptions = {}): Promise<SearchHit[]> {
  const trimmed = query.trim();
  if (!trimmed) return [];
  const maxResults = Math.min(Math.max(options.maxResults ?? 10, 1), 20);
  const timeoutMs = options.timeoutMs ?? 20_000;

  const endpoint = searchEndpoint();
  const url = `${endpoint}?q=${encodeURIComponent(trimmed)}&count=${maxResults * 2}`;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  const abortExternal = (): void => controller.abort();
  options.signal?.addEventListener("abort", abortExternal);

  let html: string;
  try {
    const response = await fetch(url, {
      signal: controller.signal,
      headers: {
        "user-agent": USER_AGENT,
        "accept-language": "zh-CN,zh;q=0.9,en;q=0.8",
        accept: "text/html,application/xhtml+xml",
      },
    });
    if (!response.ok) {
      throw new Error(`检索端点返回 ${response.status}（${endpoint}）`);
    }
    html = await response.text();
  } finally {
    clearTimeout(timer);
    options.signal?.removeEventListener("abort", abortExternal);
  }

  const hits: SearchHit[] = [];
  const seen = new Set<string>();
  for (const block of html.match(RESULT_BLOCK_RE) ?? []) {
    const anchor = ANCHOR_RE.exec(block);
    if (!anchor) continue;
    const title = stripTags(anchor[2]);
    const target = unwrapUrl(anchor[1]);
    if (!title || !/^https?:\/\//iu.test(target)) continue;
    // 引擎自身的导航/广告链接不进结果
    if (/(^|\.)bing\.com|(^|\.)microsoft\.com\/.*\/search/iu.test(target)) continue;
    if (seen.has(target)) continue;
    seen.add(target);
    hits.push({ title, url: target });
    if (hits.length >= maxResults) break;
  }
  return hits;
}

/** 把结果渲染成给模型看的文本（与工具既有输出格式一致） */
export function formatSearchHits(hits: SearchHit[]): string {
  if (!hits.length) return "未找到相关结果";
  return `搜索结果（前 ${hits.length} 条）：\n${hits.map((hit, index) => `${index + 1}. ${hit.title}\n   ${hit.url}`).join("\n\n")}`;
}
