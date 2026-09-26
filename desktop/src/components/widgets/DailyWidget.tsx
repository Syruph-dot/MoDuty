import { useEffect, useState } from "react";
import { dailyApi, DailyApiError } from "../../lib/api";

/**
 * DailyWidget —— 日报 Widget（Phase 1 完整版）
 *
 * 三态：
 * 1. 日历视图：月历网格，标记有日报的日期
 * 2. 时间轴视图：点击日期展开，按时段渲染日报条目
 * 3. 生成中/结果态：调用后端 API，轮询进度
 */

interface DailyEntry {
  period: string;
  sessions: Array<{ id: string; name: string; summary: string }>;
}

export default function DailyWidget() {
  const [view, setView] = useState<"calendar" | "timeline" | "generating">("calendar");
  const [selectedDate, setSelectedDate] = useState<string | null>(null);
  const [dailyEntries, setDailyEntries] = useState<DailyEntry[]>([]);
  const [generating, setGenerating] = useState(false);
  const [lastGenAt, setLastGenAt] = useState<string | null>(null);
  const [metaLoaded, setMetaLoaded] = useState(false);
  const [generationSince, setGenerationSince] = useState<string | null>(null);
  const [generationRunId, setGenerationRunId] = useState<string | null>(null);
  const [generationStatus, setGenerationStatus] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  // 从后端加载元数据
  useEffect(() => {
    dailyApi.getMeta().then((meta: { lastGenAt: string | null }) => {
      setLastGenAt(meta.lastGenAt);
      setMetaLoaded(true);
    }).catch((loadError: unknown) => {
      setError(loadError instanceof Error ? loadError.message : "无法读取日报生成记录");
      setMetaLoaded(true);
    });
  }, []);

  const daysInMonth = (date: Date) => new Date(date.getFullYear(), date.getMonth() + 1, 0).getDate();
  const firstDayOfMonth = (date: Date) => new Date(date.getFullYear(), date.getMonth(), 1).getDay();
  const currentMonth = new Date();

  // 模拟：从本地存储读取已有日报日期（后续可改为后端查询）
  const [dailyDates, setDailyDates] = useState<string[]>(() => {
    try {
      return JSON.parse(localStorage.getItem("momoka:daily:dates") ?? "[]");
    } catch {
      return [];
    }
  });

  useEffect(() => {
    localStorage.setItem("momoka:daily:dates", JSON.stringify(dailyDates));
  }, [dailyDates]);

  const handleGenerate = async () => {
    if (!selectedDate || !metaLoaded || generating) return;
    const since = lastGenAt ?? new Date(`${selectedDate}T00:00:00`).toISOString();
    setGenerating(true);
    setGenerationSince(since);
    setGenerationRunId(null);
    setGenerationStatus("正在提交日报生成任务…");
    setError(null);
    setView("generating");
    try {
      const started = await dailyApi.generate(since, "low");
      setGenerationRunId(started.runId);
      setGenerationStatus(`生成中 · 任务 ${started.runId}`);
      setLastGenAt(started.generatedAt);

      for (let attempt = 0; attempt < 30; attempt += 1) {
        await new Promise((resolve) => window.setTimeout(resolve, 2000));
        const status = await dailyApi.getRunStatus(started.runId);
        if (status.status === "generating") {
          setGenerationStatus(`生成中 · 任务 ${status.runId} · 汇总自 ${new Date(status.since).toLocaleString("zh-CN")}`);
          continue;
        }
        if (status.status === "failed") {
          setLastGenAt(status.since);
          throw new Error(status.error || `日报生成失败（任务 ${status.runId}）`);
        }

        const reportDate = status.reportDate;
        const content = await dailyApi.getDaily(reportDate);
        if (!content?.trim()) throw new Error(`任务 ${status.runId} 已完成，但 ${reportDate} 没有日报文件`);
        setSelectedDate(reportDate);
        setDailyEntries(parseDailyContent(content));
        setDailyDates((prev) => prev.includes(reportDate) ? prev : [...prev, reportDate].sort());
        setGenerationStatus(`已完成 · ${reportDate} · 汇总自 ${new Date(status.since).toLocaleString("zh-CN")}`);
        setGenerating(false);
        setView("timeline");
        return;
      }
      throw new Error(`等待日报超时；任务 ${started.runId} 可能仍在后台运行，可稍后重新打开日报查看。`);
    } catch (e) {
      setGenerating(false);
      setGenerationStatus(null);
      setError(e instanceof Error ? e.message : "生成失败");
      setView("timeline");
    }
  };

  const handleDayClick = async (day: number) => {
    const dateStr = `${currentMonth.getFullYear()}-${String(currentMonth.getMonth() + 1).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
    setSelectedDate(dateStr);
    setError(null);
    setGenerationStatus(null);
    setGenerationRunId(null);
    setGenerationSince(null);
    try {
      const content = await dailyApi.getDaily(dateStr);
      if (content) {
        setDailyEntries(parseDailyContent(content));
      } else {
        setDailyEntries([]);
      }
    } catch (loadError) {
      setDailyEntries([]);
      if (!(loadError instanceof DailyApiError && loadError.status === 404)) {
        setError(loadError instanceof Error ? loadError.message : "加载日报失败");
      }
    }
    setView("timeline");
  };

  const parseDailyContent = (content: string): DailyEntry[] => {
    // 简易解析：按 #### 时段 分割
    const entries: DailyEntry[] = [];
    const sections = content.split(/####\s+/);
    for (const section of sections) {
      if (!section.trim()) continue;
      const lines = section.trim().split("\n");
      const period = lines[0].trim();
      const sessions: DailyEntry["sessions"] = [];
      for (const line of lines.slice(1)) {
        const match = line.match(/-\s*\*\*(.+?)\*\*\s*\(&ses_(.+?)\):\s*(.+)/);
        if (match) {
          sessions.push({ id: match[2], name: match[1], summary: match[3] });
        }
      }
      if (sessions.length > 0) entries.push({ period, sessions });
    }
    return entries;
  };

  const renderCalendar = () => {
    const year = currentMonth.getFullYear();
    const month = currentMonth.getMonth();
    const days = daysInMonth(currentMonth);
    const firstDay = firstDayOfMonth(currentMonth);
    const weeks: (number | null)[][] = [];
    let week: (number | null)[] = new Array(firstDay).fill(null);

    for (let d = 1; d <= days; d++) {
      week.push(d);
      if (week.length === 7) {
        weeks.push(week);
        week = [];
      }
    }
    if (week.length > 0) {
      while (week.length < 7) week.push(null);
      weeks.push(week);
    }

    return (
      <div className="daily-widget__calendar">
        <div className="daily-widget__calendar-header">
          <button onClick={() => currentMonth.setMonth(currentMonth.getMonth() - 1)} aria-label="上月">‹</button>
          <span>{year} 年 {month + 1} 月</span>
          <button onClick={() => currentMonth.setMonth(currentMonth.getMonth() + 1)} aria-label="下月">›</button>
        </div>
        <div className="daily-widget__weekdays">
          {["日", "一", "二", "三", "四", "五", "六"].map((d) => <div key={d}>{d}</div>)}
        </div>
        <div className="daily-widget__grid">
          {weeks.map((w, wi) => (
            <div key={wi} className="daily-widget__week">
              {w.map((day, di) => (
                <button
                  key={di}
                  className={`daily-widget__day${day === new Date().getDate() && month === new Date().getMonth() ? " daily-widget__day--today" : ""}${dailyDates.includes(`${year}-${String(month + 1).padStart(2, "0")}-${String(day).padStart(2, "0")}`) ? " daily-widget__day--has-daily" : ""}`}
                  disabled={day === null}
                  onClick={() => day && handleDayClick(day)}
                  aria-label={day ? `${year}-${String(month + 1).padStart(2, "0")}-${String(day).padStart(2, "0")}` : undefined}
                >
                  {day ?? ""}
                </button>
              ))}
            </div>
          ))}
        </div>
        {lastGenAt && (
          <div className="daily-widget__last-gen">
            上次生成：{new Date(lastGenAt).toLocaleString("zh-CN")}
          </div>
        )}
      </div>
    );
  };

  const renderTimeline = () => (
    <div className="daily-widget__timeline">
      <div className="daily-widget__timeline-header">
        <button onClick={() => setView("calendar")} className="daily-widget__back" aria-label="返回日历">
          ← 返回日历
        </button>
        <h3>{selectedDate} 的日报</h3>
      </div>
      {error && <div className="daily-widget__error">{error}</div>}
      {generationStatus ? <p className="daily-widget__hint">{generationStatus}</p> : null}
      {dailyEntries.length === 0 ? (
        <div className="daily-widget__empty">
        <p>暂无日报内容</p>
          <p className="daily-widget__hint">
            汇总起点：{lastGenAt ? new Date(lastGenAt).toLocaleString("zh-CN") : selectedDate ? `${selectedDate} 00:00（首次生成）` : "选择日期后确定"}
          </p>
          <button onClick={handleGenerate} disabled={generating || !metaLoaded || !selectedDate}>
            {generating ? "生成中…" : lastGenAt ? "生成日报" : "首次生成日报"}
          </button>
        </div>
      ) : (
        <div className="daily-widget__entries">
          {dailyEntries.map((entry, i) => (
            <div key={i} className="daily-widget__period">
              <h4>{entry.period}</h4>
              <ul>
                {entry.sessions.map((s, j) => (
                  <li key={j}>
                    <strong>{s.name}</strong> <code>&ses_{s.id}</code>
                    <p>{s.summary}</p>
                  </li>
                ))}
              </ul>
            </div>
          ))}
        </div>
      )}
    </div>
  );

  const renderGenerating = () => (
    <div className="daily-widget__generating" role="status" aria-live="polite">
      <div className="daily-widget__spinner" aria-hidden="true" />
      <p>正在生成 {selectedDate} 的日报…</p>
      {generationSince ? <p className="daily-widget__hint">汇总起点：{new Date(generationSince).toLocaleString("zh-CN")}</p> : null}
      {generationRunId ? <p className="daily-widget__hint">任务：{generationRunId}</p> : null}
      <p className="daily-widget__hint">{generationStatus ?? "调用低成本模型分析会话变更"}</p>
    </div>
  );

  return (
    <div className="daily-widget">
      {view === "calendar" && renderCalendar()}
      {view === "timeline" && renderTimeline()}
      {view === "generating" && renderGenerating()}
    </div>
  );
}
