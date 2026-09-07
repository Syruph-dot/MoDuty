import { forwardRef } from "react";

import type { MentionChip, SessionCandidate } from "./types";

/** 渲染在消息输入区下方的 & 提及弹窗 */
function MentionPopup({
  candidates,
  index,
  x,
  onPick,
}: {
  candidates: SessionCandidate[];
  index: number;
  x: number;
  onPick: (sessionId: string) => void;
}) {
  if (candidates.length === 0) return null;
  return (
    <ul className="mention-popup" style={{ left: Math.min(x, 380) }} role="listbox" aria-label="引用会话">
      {candidates.map((candidate, idx) => (
        <li
          key={candidate.id}
          className={`mention-popup__item${idx === index ? " mention-popup__item--active" : ""}`}
          onMouseDown={(event) => {
            event.preventDefault();
            onPick(candidate.id);
          }}
          role="option"
          aria-selected={idx === index}
        >
          <span className="mention-popup__name">{candidate.name}</span>
          <span className="mention-popup__meta">
            {candidate.goal ? candidate.goal.slice(0, 44) : `${candidate.message_count} 条消息`}
          </span>
        </li>
      ))}
    </ul>
  );
}

interface MentionEditorProps {
  value: string;
  onChange: (value: string) => void;
  onKeyDown: (event: React.KeyboardEvent<HTMLTextAreaElement>) => void;
  mention: { active: boolean; query: string; start: number; index: number } | null;
  mentionX: number;
  candidates: SessionCandidate[];
  /** 引用 chip 集合（可视化标签；底层 input 仍存 &ses_<id>） */
  chips: MentionChip[];
  onApplyMention: (sessionId: string) => void;
  onRemoveChip: (sessionId: string) => void;
  streaming: boolean;
  onSend: () => void;
  onCancel: () => void;
}

/** 输入框 + 引用 chips + & 提及弹窗（含离屏 mirror 测 caret 位置） */
export const MentionEditor = forwardRef<HTMLTextAreaElement, MentionEditorProps>(function MentionEditor(
  {
    value,
    onChange,
    onKeyDown,
    mention,
    mentionX,
    candidates,
    chips,
    onApplyMention,
    onRemoveChip,
    streaming,
    onSend,
    onCancel,
  },
  inputRef,
) {
  return (
    <footer className="agent-window__composer">
      {/* 已选会话引用 chips：可视化标签，点击 × 删除 */}
      {chips.length > 0 && (
        <div className="mention-chips" role="group" aria-label="已引用会话">
          {chips.map((chip) => (
            <span key={chip.sessionId} className="mention-chip" onMouseDown={(e) => e.preventDefault()}>
              <span className="mention-chip__name">@{chip.name}</span>
              <button
                type="button"
                className="mention-chip__remove"
                aria-label={`移除引用 ${chip.name}`}
                onClick={() => onRemoveChip(chip.sessionId)}
              >
                ×
              </button>
            </span>
          ))}
        </div>
      )}
      {mention?.active && candidates.length > 0 ? (
        <MentionPopup candidates={candidates} index={mention.index} x={mentionX} onPick={onApplyMention} />
      ) : null}
      <textarea
        ref={inputRef}
        className="agent-window__input"
        value={value}
        onChange={(event) => onChange(event.target.value)}
        onKeyDown={onKeyDown}
        placeholder="输入消息，Enter 发送；Shift+Enter 或 Ctrl+Enter 换行；输入 & 可引用历史会话"
        aria-label="消息输入"
        rows={1}
        style={{ resize: "none", minHeight: "44px", maxHeight: "200px" }}
      />
      <button
        type="button"
        className={streaming ? "btn btn--stop" : "btn btn--primary"}
        onClick={streaming ? onCancel : onSend}
        disabled={!streaming && !value.trim()}
        aria-label={streaming ? "停止生成" : "发送"}
        title={streaming ? "停止本次生成" : "发送"}
      >
        {streaming ? "■ 停止" : "发送"}
      </button>
    </footer>
  );
});

/** 从输入串中剔除指定 &ses_<id>（删除 chip 时同步清理 input） */
export function stripSesRef(value: string, sessionId: string): string {
  return value.replace(new RegExp(`&ses_${sessionId}\\s*`), "");
}

/** 插入 &ses_<id> 到光标位置（返回新 value；start 为 & 起始下标） */
export function insertSesRef(value: string, start: number, caret: number, sessionId: string): string {
  return `${value.slice(0, start)}&ses_${sessionId} ${value.slice(caret)}`;
}

/** 从输入串中提取所有 &ses_<id> 的 sessionId 列表（用于同步 chips） */
export function extractSesIds(value: string): string[] {
  return value.match(/&ses_([^\s]+)/g)?.map((s) => s.slice(6)) ?? [];
}