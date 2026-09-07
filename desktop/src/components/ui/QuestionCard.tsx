import { useCallback, useEffect, useMemo, useState } from "react";

import { submitQuestionAnswers } from "../../lib/api";

export interface QuestionCardDraft {
  /** 每题的作答：choiceIndex=-1 表示自定义；customText 为自定义文本 */
  answers: Array<{ choiceIndex: number; customText: string }>;
}

/**
 * 工具卡片内的桌面问答（ask_question）：
 * - 单选选项 + 末尾固定“自定义”输入项；
 * - ◀ ▶ 切换上一题 / 下一题；
 * - 全部答完才可提交；提交成功后回调 onAnswered 让外层折叠卡片。
 */
export default function QuestionCard({
  agentId,
  setId,
  questions,
  onAnswered,
}: {
  agentId: string;
  setId?: string;
  questions: Array<{ prompt: string; options: string[] }>;
  onAnswered?: () => void;
}) {
  const [index, setIndex] = useState(0);
  const [answers, setAnswers] = useState<QuestionCardDraft["answers"]>(() =>
    questions.map(() => ({ choiceIndex: -1, customText: "" })),
  );
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState(false);

  const total = questions.length;
  const current = questions[index];
  const currentAnswer = answers[index] ?? { choiceIndex: -1, customText: "" };
  const allAnswered = useMemo(
    () =>
      answers.every((answer, i) => {
        const q = questions[i];
        return (
          answer.choiceIndex >= 0 &&
          (answer.choiceIndex < q.options.length || answer.customText.trim().length > 0)
        );
      }),
    [answers, questions],
  );

  const setChoice = (choiceIndex: number) => {
    if (done) return;
    setAnswers((prev) => {
      const next = [...prev];
      next[index] = { choiceIndex, customText: next[index]?.customText ?? "" };
      return next;
    });
  };

  const setCustomText = (text: string) => {
    if (done) return;
    setAnswers((prev) => {
      const next = [...prev];
      next[index] = { choiceIndex: -1, customText: text };
      return next;
    });
  };

  const goPrev = useCallback(() => setIndex((i) => Math.max(0, i - 1)), []);
  const goNext = useCallback(() => setIndex((i) => Math.min(total - 1, i + 1)), [total]);

  const submit = async () => {
    if (!allAnswered || submitting || done) return;
    if (!setId) {
      setError("缺少问题 ID，无法提交（可能是尚未生成）。");
      return;
    }
    setSubmitting(true);
    setError(null);
    try {
      await submitQuestionAnswers(
        agentId,
        setId,
        answers.map((answer, i) => ({
          questionIndex: i,
          choiceIndex: answer.choiceIndex,
          ...(answer.choiceIndex === -1 ? { customText: answer.customText } : {}),
        })),
      );
      setDone(true);
      onAnswered?.();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setSubmitting(false);
    }
  };

  // 题目数变化（流式过程中先拿到部分题）时保证 index 不越界
  useEffect(() => {
    if (index > total - 1) setIndex(Math.max(0, total - 1));
  }, [total, index]);

  if (total === 0) {
    return <div className="question-card question-card--empty">（提问加载中…）</div>;
  }

  return (
    <div className="question-card" onClick={(e) => e.stopPropagation()}>
      {done ? (
        <div className="question-card__done">✓ 已提交你的回答，Agent 将继续处理。</div>
      ) : (
        <>
          <div className="question-card__head">
            <span className="question-card__counter">
              问题 {index + 1} / {total}
            </span>
            <span className="question-card__prompt">{current.prompt}</span>
          </div>

          <div className="question-card__options" role="radiogroup" aria-label={current.prompt}>
            {current.options.map((option, i) => {
              const checked = currentAnswer.choiceIndex === i;
              return (
                <label key={i} className={`question-card__option${checked ? " question-card__option--checked" : ""}`}>
                  <input
                    type="radio"
                    name={`question-${index}`}
                    checked={checked}
                    onChange={() => setChoice(i)}
                  />
                  <span>{option}</span>
                </label>
              );
            })}
            {/* 末位固定“自定义”输入项 */}
            <label className={`question-card__option${currentAnswer.choiceIndex === -1 ? " question-card__option--checked" : ""}`}>
              <input
                type="radio"
                name={`question-${index}`}
                checked={currentAnswer.choiceIndex === -1}
                onChange={() => setChoice(-1)}
              />
              <span className="question-card__custom-label">自定义…</span>
            </label>
            {currentAnswer.choiceIndex === -1 ? (
              <input
                className="question-card__custom-input"
                type="text"
                value={currentAnswer.customText}
                onChange={(e) => setCustomText(e.target.value)}
                placeholder="输入你的回答…"
                autoFocus
              />
            ) : null}
          </div>

          <div className="question-card__nav">
            <button type="button" className="question-card__nav-btn" onClick={goPrev} disabled={index === 0}>
              ◀ 上一题
            </button>
            <button type="button" className="question-card__nav-btn" onClick={goNext} disabled={index === total - 1}>
              下一题 ▶
            </button>
          </div>

          {error ? <div className="question-card__error" role="alert">{error}</div> : null}

          <div className="question-card__actions">
            <button
              type="button"
              className="question-card__submit"
              onClick={() => void submit()}
              disabled={!allAnswered || submitting}
            >
              {submitting ? "提交中…" : allAnswered ? `提交答案（${total} 题）` : "还有题目未作答"}
            </button>
          </div>
        </>
      )}
    </div>
  );
}
