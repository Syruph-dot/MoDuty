import { memo, useMemo } from "react";

import { renderMarkdown } from "../../lib/markdown";
import QuestionCard from "../ui/QuestionCard";
import type { DisplayMessage } from "./types";

/** 将工具参数简短化显示 */
export function shortArgs(args: string): string {
  if (!args || args === "{}") return "";
  try {
    const parsed = JSON.parse(args) as Record<string, unknown>;
    return Object.entries(parsed)
      .map(([key, value]) => `${key}=${String(value).slice(0, 60)}`)
      .join(" ");
  } catch {
    return args.slice(0, 80);
  }
}

/** 解析 ask_question 工具的参数 */
export function parseQuestionArgs(args: string) {
  try {
    const argsJson = JSON.parse(args) as { questions?: Array<{ prompt?: unknown; options?: unknown }> };
    const questions = argsJson.questions ?? [];
    const result: Array<{ prompt: string; options: string[] }> = [];
    for (const q of questions) {
      const prompt = String(q.prompt ?? "");
      const options = Array.isArray(q.options) ? q.options.map((o) => String(o)) : [];
      if (prompt && options.length >= 1) {
        result.push({ prompt, options });
      }
    }
    return result;
  } catch {
    return [];
  }
}

/**
 * 单条消息（memo 化）：流式 token 只更新流式那条消息的 content，
 * 历史消息 props 不变 → 跳过重渲染；markdown 解析按 content 缓存，每 token 只解析流式文本。
 */
export const MessageItem = memo(function MessageItem({
  message,
  agentId,
  agentState,
  onToggleTool,
  onQuestionAnswered,
}: {
  message: DisplayMessage;
  agentId: string;
  agentState: string;
  onToggleTool: (key: string) => void;
  onQuestionAnswered: (key: string) => void;
}) {
  // agent 消息才走 markdown；content 不变时复用上一次的解析结果
  const html = useMemo(
    () => (message.role === "agent" ? renderMarkdown(message.content) : ""),
    [message.role, message.content],
  );

  // 跳过 tool call 之间创建的空 agent 消息（占位用，不应渲染）
  if (message.role === "agent" && message.content === "") {
    return null;
  }

  if (message.role === "tool" && message.toolCard) {
    const tc = message.toolCard;
    // ask_question：渲染为可交互问答卡片（单选 + 自定义 + 上/下题切换 + 提交折叠）
    if (tc.name === "ask_question" && agentState === "requiring_input" && tc.result && /pending question: (qst_[A-Za-z0-9_]+)/.test(tc.result)) {
      const match = tc.result.match(/pending question: (qst_[A-Za-z0-9_]+)/);
      const setId = match ? match[1] : undefined;
      const parsedQuestions = parseQuestionArgs(tc.args);
      if (parsedQuestions.length > 0 && setId) {
        return (
          <div className={`tool-card tool-card--question${tc.collapsed ? " tool-card--collapsed" : ""}`}>
            <div
              className="tool-card__head"
              onClick={() => onToggleTool(message.key)}
              role="button"
              tabIndex={0}
              onKeyDown={(e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); onToggleTool(message.key); } }}
            >
              <span className={`tool-card__dot tool-card__dot--${tc.status}`} aria-hidden="true" />
              <span className="tool-card__name">ask_question</span>
              <span className="tool-card__args">{parsedQuestions.length} 题</span>
              <span className="tool-card__toggle" aria-hidden="true">{tc.collapsed ? "▶" : "▼"}</span>
            </div>
            {!tc.collapsed ? (
              <div className="tool-card__body">
                <QuestionCard
                  agentId={agentId}
                  setId={setId}
                  questions={parsedQuestions}
                  onAnswered={() => onQuestionAnswered(message.key)}
                />
              </div>
            ) : null}
          </div>
        );
      }
    }
    return (
      <div
        className={`tool-card${tc.collapsed ? " tool-card--collapsed" : ""}`}
        onClick={() => onToggleTool(message.key)}
        role="button"
        tabIndex={0}
        onKeyDown={(e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); onToggleTool(message.key); } }}
      >
        <div className="tool-card__head">
          <span className={`tool-card__dot tool-card__dot--${tc.status}`} aria-hidden="true" />
          <span className="tool-card__name">{tc.name}</span>
          <span className="tool-card__args">{shortArgs(tc.args)}</span>
          <span className="tool-card__toggle" aria-hidden="true">{tc.collapsed ? "▶" : "▼"}</span>
        </div>
        <div className="tool-card__body">
          {tc.result ? (
            <pre className="tool-card__result">{tc.result.length > 500 ? `${tc.result.slice(0, 500)}…` : tc.result}</pre>
          ) : null}
        </div>
      </div>
    );
  }

  // 用户消息 = 纯文本（保留换行，由 .msg__bubble 的 white-space: pre-wrap 呈现），
  // 不走 markdown：避免纯文本被 marked 包成 <p> 段落 + 尾随换行造成前后空行。
  if (message.role === "user") {
    return (
      <div className={`msg msg--${message.role}`}>
        <div className="msg__bubble">{message.content}</div>
      </div>
    );
  }

  return (
    <div className={`msg msg--${message.role}`}>
      <div className="msg__bubble" dangerouslySetInnerHTML={{ __html: html }} />
    </div>
  );
});