import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import {
  fetchPromaArchiveCandidates,
  fetchSourceJob,
  fetchSources,
  importPromaArchive,
  listSourceSessions,
  startSourceBackup,
  startSourceSync,
  type ArchiveCandidateView,
  type ExternalSourceView,
  type SourceJobView,
  type SourceOverviewView,
  type SourceSessionRowView,
  type SourcesView,
} from "../lib/api";
import { formatShortTime } from "../lib/tileContent";

const PAGE_SIZE = 50;
type RowFilter = "all" | "new" | "changed" | "imported";

/** 本地库构成里的固定展示顺序 */
const SOURCE_ORDER = ["moduty", "claude", "codex", "proma"] as const;

const SOURCE_HINT: Record<ExternalSourceView, string> = {
  claude: "读取 ~/.claude/projects 下的会话记录；只导入 user / assistant 记录，跳过 hook、快照与子代理侧链。",
  codex: "读取 ~/.codex/sessions 与 archived_sessions；跳过 Codex 自身的 developer 系统指令，只保留真实对话。",
  proma: "读取 ~/.proma 的会话索引与正文；也可直接吃 Proma「迁移」功能产出的整个 .proma 目录压缩包。",
};

const FILTER_LABELS: Array<{ key: RowFilter; label: string }> = [
  { key: "all", label: "全部" },
  { key: "new", label: "未导入" },
  { key: "changed", label: "有更新" },
  { key: "imported", label: "已导入" },
];

/**
 * 设置页「会话来源」面板。
 *
 * 每个外部来源一个区块：区块内可备份勾选的会话到 MoDuty 本地，也可 Sync 该来源的全部会话。
 * 同步是后台作业（codex 会话目录实测 1.1 GB），所以这里只负责启动 + 轮询进度，
 * 不把长任务塞进一次请求。
 */
export default function SourcePanel() {
  const [data, setData] = useState<SourcesView | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  const reload = useCallback(async () => {
    try {
      setData(await fetchSources());
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void reload();
  }, [reload]);

  const local = data?.local;
  const sources = useMemo(() => data?.sources ?? [], [data]);

  return (
    <>
      <h2 className="settings-main__title">会话来源</h2>
      <p className="settings-main__sub">
        每个来源是一个独立区块：可把选中的会话<b>备份</b>到 MoDuty 本地，也可 <b>Sync</b> 该来源的全部会话。
        导入结果是只读镜像（标明来源、不参与续聊），最终所有会话就是各来源的聚合。
      </p>
      {error ? <p className="source-panel__error">{error}</p> : null}
      {loading ? <p style={{ opacity: 0.6, fontSize: 13 }}>读取来源状态…</p> : null}

      <section className="settings-group">
        <h3 className="settings-group__title">MoDuty 本地库</h3>
        <div className="settings-card">
          <div className="source-local">
            <span className="source-local__total">
              共 <b>{local?.total ?? 0}</b> 个会话
            </span>
            {SOURCE_ORDER.map((key) => (
              <span key={key} className={`source-local__chip${key === "moduty" ? " source-local__chip--primary" : ""}`}>
                {key} {local?.by_source[key] ?? 0}
              </span>
            ))}
          </div>
          <div className="settings-row__desc" style={{ marginTop: 6 }}>
            在 MoDuty 内创建的会话来源是 moduty；其余为外部来源的只读镜像，两者一起构成完整的会话集合。
          </div>
        </div>
      </section>

      {sources.map((overview) => (
        <SourceRegion key={overview.source} overview={overview} onChanged={reload} />
      ))}
    </>
  );
}

function SourceRegion({ overview, onChanged }: { overview: SourceOverviewView; onChanged: () => Promise<void> }) {
  const source = overview.source;
  const [rows, setRows] = useState<SourceSessionRowView[]>([]);
  const [matched, setMatched] = useState(0);
  const [total, setTotal] = useState(0);
  const [offset, setOffset] = useState(0);
  const [query, setQuery] = useState("");
  const [draftQuery, setDraftQuery] = useState("");
  const [filter, setFilter] = useState<RowFilter>("all");
  const [selected, setSelected] = useState<string[]>([]);
  const [listing, setListing] = useState(false);
  const [job, setJob] = useState<SourceJobView | null>(overview.job);
  const [notice, setNotice] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [archivePath, setArchivePath] = useState("");
  const [archives, setArchives] = useState<ArchiveCandidateView[]>([]);
  const cancelled = useRef(false);
  const followedJobId = useRef<string | null>(null);

  useEffect(() => () => { cancelled.current = true; }, []);

  const loadList = useCallback(async () => {
    if (!overview.available) return;
    setListing(true);
    try {
      const page = await listSourceSessions(source, { query, filter, offset, limit: PAGE_SIZE });
      setRows(page.items);
      setMatched(page.matched);
      setTotal(page.total);
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setListing(false);
    }
  }, [overview.available, source, query, filter, offset]);

  useEffect(() => {
    void loadList();
  }, [loadList]);

  const running = job?.status === "running";

  /** 轮询后台作业直到结束；每轮都刷新进度数字。重复进入区块时靠 followedJobId 防止重复跟随 */
  const track = useCallback(async (first: SourceJobView) => {
    followedJobId.current = first.id;
    setJob(first);
    let current = first;
    while (current.status === "running") {
      await new Promise((resolve) => setTimeout(resolve, 700));
      if (cancelled.current) return;
      try {
        const { job: latest } = await fetchSourceJob(source);
        // 单飞：作业被新一个取代时不再跟随旧的
        if (!latest || latest.id !== current.id) break;
        current = latest;
        setJob(latest);
      } catch {
        break;
      }
    }
    setNotice(describeJob(current));
    await onChanged();
    await loadList();
  }, [source, onChanged, loadList]);

  // 进入设置页时如果该来源正有作业在跑，跟着它的进度
  useEffect(() => {
    const incoming = overview.job;
    if (!incoming || incoming.status !== "running") return;
    if (followedJobId.current === incoming.id) return;
    void track(incoming);
  }, [overview.job, track]);

  const runSync = useCallback(async () => {
    setError(null);
    setNotice(null);
    try {
      const { job: started } = await startSourceSync(source);
      await track(started);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }, [source, track]);

  const runBackup = useCallback(async () => {
    if (!selected.length) return;
    setError(null);
    setNotice(null);
    try {
      const { job: started } = await startSourceBackup(source, selected);
      setSelected([]);
      await track(started);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }, [source, selected, track]);

  const runArchiveImport = useCallback(async () => {
    const path = archivePath.trim();
    if (!path) return;
    setError(null);
    setNotice(null);
    try {
      const { job: started } = await importPromaArchive(path);
      await track(started);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }, [archivePath, track]);

  const openArchivePicker = useCallback(async () => {
    try {
      setArchives(await fetchPromaArchiveCandidates());
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }, []);

  const toggleRow = (externalId: string): void => {
    setSelected((current) =>
      current.includes(externalId) ? current.filter((id) => id !== externalId) : [...current, externalId],
    );
  };

  const pageStart = matched === 0 ? 0 : offset + 1;
  const pageEnd = Math.min(offset + rows.length, matched);
  const selectableIds = rows.filter((row) => row.needs_update || !row.imported).map((row) => row.external_id);

  return (
    <section className="settings-group">
      <h3 className="settings-group__title">
        {overview.label}
        <span className="source-badge">{source}</span>
        {overview.available ? null : <span className="source-badge source-badge--warn">不可用</span>}
      </h3>
      <div className="settings-card">
        <div className="settings-row">
          <div className="settings-row__grow">
            <div className="settings-row__label">
              {overview.available ? `数据目录：${overview.root}` : "数据目录不可用"}
            </div>
            <div className="settings-row__desc">{overview.reason ?? SOURCE_HINT[source]}</div>
          </div>
          <div className="source-actions">
            <button type="button" className="settings-btn" disabled={running || !overview.available} onClick={() => void runBackup()}>
              备份所选{selected.length ? `（${selected.length}）` : ""}
            </button>
            <button
              type="button"
              className="settings-btn settings-btn--primary"
              disabled={running || !overview.available}
              onClick={() => void runSync()}
            >
              {running ? "同步中…" : "Sync 全部"}
            </button>
          </div>
        </div>

        <div className="source-stats">
          <span>源内会话 <b>{total}</b></span>
          <span>已导入 <b>{overview.imported_count}</b></span>
          <span>筛选命中 <b>{matched}</b></span>
          <span>最近同步 {formatShortTime(overview.last_sync_at)}</span>
        </div>

        {running ? (
          <div className="source-progress">
            <div className="source-progress__bar">
              <div
                className="source-progress__fill"
                style={{ width: `${job.total ? Math.round((job.processed / job.total) * 100) : 0}%` }}
              />
            </div>
            <span className="source-progress__text">
              {job.kind === "archive" ? "从迁移压缩包导入" : job.kind === "sync" ? "Sync 全部" : "备份所选"}：
              {job.processed} / {job.total}
            </span>
          </div>
        ) : null}

        {notice ? <p className="source-note">{notice}</p> : null}
        {error ? <p className="source-panel__error">{error}</p> : null}

        {source === "proma" ? (
          <div className="source-archive">
            <div className="settings-row__label">从 Proma 迁移压缩包导入</div>
            <div className="settings-row__desc">
              Proma 的「迁移」只提供整目录 ZIP：先在 Proma 设置页打开数据文件夹、自行压缩，再把压缩包路径填到这里。
            </div>
            <div className="source-archive__row">
              <input
                className="source-archive__input"
                value={archivePath}
                placeholder="D:\\Downloads\\proma-backup.zip"
                onChange={(event) => setArchivePath(event.target.value)}
              />
              <button type="button" className="settings-btn settings-btn--small" onClick={() => void openArchivePicker()}>
                扫常见位置
              </button>
              <button
                type="button"
                className="settings-btn settings-btn--small settings-btn--primary"
                disabled={running || !archivePath.trim()}
                onClick={() => void runArchiveImport()}
              >
                导入
              </button>
            </div>
            {archives.length ? (
              <div className="source-archive__list">
                {archives.map((candidate) => (
                  <button
                    key={candidate.path}
                    type="button"
                    className="source-archive__item"
                    onClick={() => setArchivePath(candidate.path)}
                    title={candidate.path}
                  >
                    {candidate.name}
                    <span>{(candidate.size_bytes / 1024 / 1024).toFixed(1)} MB</span>
                  </button>
                ))}
              </div>
            ) : null}
          </div>
        ) : null}
      </div>

      <div className="settings-card">
        <div className="source-list__toolbar">
          <input
            className="source-list__search"
            value={draftQuery}
            placeholder="搜索标题 / 工作区 / 会话 id（Enter 开始）"
            onChange={(event) => setDraftQuery(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter") {
                setOffset(0);
                setQuery(draftQuery);
              }
            }}
          />
          <div className="source-list__filters">
            {FILTER_LABELS.map((option) => (
              <button
                key={option.key}
                type="button"
                className={`settings-badge${filter === option.key ? " settings-badge--active" : ""}`}
                onClick={() => {
                  setOffset(0);
                  setFilter(option.key);
                }}
              >
                {option.label}
              </button>
            ))}
          </div>
          <button
            type="button"
            className="settings-btn settings-btn--small"
            disabled={!selectableIds.length}
            onClick={() =>
              setSelected((current) => (current.length ? [] : selectableIds))
            }
          >
            {selected.length ? "清空选择" : "选择本页待导入"}
          </button>
        </div>

        {listing ? <p style={{ opacity: 0.6, fontSize: 13 }}>列取中…</p> : null}
        {!listing && !rows.length ? (
          <p style={{ opacity: 0.6, fontSize: 13, margin: "8px 0 0" }}>
            {overview.available ? "没有匹配的会话。" : "来源不可用，无法列出会话。"}
          </p>
        ) : null}

        {rows.map((row) => (
          <label key={row.external_id} className="source-row" title={row.external_id}>
            <input
              type="checkbox"
              checked={selected.includes(row.external_id)}
              onChange={() => toggleRow(row.external_id)}
            />
            <span className="source-row__title">{row.title}</span>
            <span className="source-row__meta">{formatShortTime(row.updated_at)}</span>
            <span className="source-row__meta">{row.message_count === null ? "—" : `${row.message_count} 条`}</span>
            <span className="source-row__workspace">{row.workspace ?? ""}</span>
            <span className={`source-tag${row.needs_update ? " source-tag--changed" : row.imported ? " source-tag--done" : " source-tag--new"}`}>
              {row.needs_update ? "有更新" : row.imported ? "已导入" : "未导入"}
            </span>
          </label>
        ))}

        {matched > PAGE_SIZE ? (
          <div className="source-list__pager">
            <button
              type="button"
              className="settings-btn settings-btn--small"
              disabled={offset === 0}
              onClick={() => setOffset(Math.max(0, offset - PAGE_SIZE))}
            >
              上一页
            </button>
            <span>
              {pageStart}–{pageEnd} / {matched}
            </span>
            <button
              type="button"
              className="settings-btn settings-btn--small"
              disabled={pageEnd >= matched}
              onClick={() => setOffset(offset + PAGE_SIZE)}
            >
              下一页
            </button>
          </div>
        ) : null}
      </div>
    </section>
  );
}

function describeJob(job: SourceJobView): string {
  if (job.status === "error") return `同步失败：${job.error ?? "未知错误"}`;
  const parts = [`新增 ${job.imported}`, `更新 ${job.updated}`, `跳过 ${job.skipped}`];
  if (job.failed.length) parts.push(`失败 ${job.failed.length}`);
  return `完成：${parts.join(" · ")}`;
}
