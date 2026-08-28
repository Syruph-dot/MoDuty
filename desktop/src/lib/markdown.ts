// Markdown 渲染：聊天气泡展示 agent 回复。
// 安全策略：禁用 raw HTML（转义显示），其余交给 marked（GFM）。
import { marked } from "marked";

function escapeHtml(input: string): string {
  return input
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

const renderer = new marked.Renderer();

// marked 默认把源文本中的原始 HTML 透传出来（含 <script>），这里转义成可见文本。
renderer.html = ({ text }: { text: string }): string => escapeHtml(text);

export function renderMarkdown(source: string): string {
  if (!source) return "";
  return marked.parse(source, {
    renderer,
    gfm: true,
    breaks: true, // 聊天场景：单换行即换行
  }) as string;
}