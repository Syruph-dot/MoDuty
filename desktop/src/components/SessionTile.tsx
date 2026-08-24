import type { SessionRecord } from "../types";

function formatActive(iso: string): string {
  if (!iso) return "—";
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return "—";
  return date.toLocaleString("zh-CN", { month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit" });
}

/** Legacy 会话磁贴（来自 /api/sessions，保留旧路径可见性） */
export default function SessionTile({ session }: { session: SessionRecord }) {
  return (
    <div className="session-tile" role="listitem">
      <div className="session-tile__dot" aria-hidden="true" />
      <div className="session-tile__body">
        <p className="session-tile__name" title={session.goal}>
          {session.goal}
        </p>
        <p className="session-tile__meta">
          {session.message_count} msgs · {formatActive(session.last_message_at)}
        </p>
      </div>
    </div>
  );
}