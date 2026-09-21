/**
 * 问答卡回看（ask_question 已作答后原样展示「题目 + 我选了什么」）。
 *
 * 为什么单独一个组件：作答后这张工具卡不该退回成一坨 JSON/结果文本——
 * 题目与作答是这次决策的凭据，展开时应能原样读回。数据来自
 * GET /api/agents/:id/questions?include=answered 的 answers 字段（服务端权威）；
 * 取不到（历史数据/接口旧版）时外层会退回原来的结果文本。
 */
export interface QuestionRecapItem {
  prompt: string;
  options: string[];
}

export interface QuestionRecapAnswer {
  questionIndex: number;
  choiceIndex: number;
  customText?: string;
}

export default function QuestionRecap({
  questions,
  answers,
}: {
  questions: QuestionRecapItem[];
  answers?: QuestionRecapAnswer[];
}) {
  return (
    <div className="question-recap">
      {questions.map((question, index) => {
        const answer = answers?.find((item) => item.questionIndex === index);
        const customText = answer && answer.choiceIndex < 0 ? (answer.customText ?? "").trim() : "";
        const chosenIndex = answer && answer.choiceIndex >= 0 ? answer.choiceIndex : -1;
        const answered = chosenIndex >= 0 || customText.length > 0;
        return (
          <div key={index} className="question-recap__item">
            <div className="question-recap__head">
              <span className="question-recap__index">Q{index + 1}</span>
              <span className="question-recap__prompt">{question.prompt}</span>
            </div>
            <div className="question-recap__options">
              {question.options.map((option, optionIndex) => (
                <div
                  key={optionIndex}
                  className={`question-recap__option${
                    optionIndex === chosenIndex ? " question-recap__option--chosen" : ""
                  }`}
                >
                  <span className="question-recap__mark" aria-hidden="true">
                    {optionIndex === chosenIndex ? "✓" : "·"}
                  </span>
                  <span>{option}</span>
                </div>
              ))}
              {customText ? (
                <div className="question-recap__option question-recap__option--chosen question-recap__option--custom">
                  <span className="question-recap__mark" aria-hidden="true">
                    ✓
                  </span>
                  <span>自定义：{customText}</span>
                </div>
              ) : null}
              {answered ? null : <div className="question-recap__unanswered">（未作答）</div>}
            </div>
          </div>
        );
      })}
    </div>
  );
}
