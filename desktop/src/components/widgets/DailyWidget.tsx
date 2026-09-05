import { useEffect, useState } from "react";
import { dailyApi } from "../../lib/api";

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
  const [error, setError] = useState<string | null>(null);

  // 从后端加载元数据
  useEffect(() => {
    dailyApi.getMeta().then((meta: { lastGenAt: string | null }) => {
      setLastGenAt(meta.lastGenAt);
    }).catch(() => undefined);
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
    if (!selectedDate || !lastGenAt) return;
    setGenerating(true);
    setError(null);
    setView("generating");
    try {
      await dailyApi.generate(lastGenAt, "low");
      // 轮询检查生成结果（简化：每 2 秒检查一次本地存储的日报文件）
      const checkResult = setInterval(async () => {
        try {
          const content = await dailyApi.getDaily(selectedDate);
          if (content && content.trim()) {
            clearInterval(checkResult);
            setGenerating(false);
            // 解析日报内容为 entries（简化：按时段分组）
            setDailyEntries(parseDailyContent(content));
            if (!dailyDates.includes(selectedDate)) {
              setDailyDates((prev) => [...prev, selectedDate].sort());
            }
            setView("timeline");
          }
        } catch {
          // 忽略轮询错误
        }
      }, 2000);

      // 超时保护
      setTimeout(() => clearInterval(checkResult), 60000);
    } catch (e) {
      setGenerating(false);
      setError(e instanceof Error ? e.message : "生成失败");
      setView("timeline");
    }
  };

  const handleDayClick = async (day: number) => {
    const dateStr = `${currentMonth.getFullYear()}-${String(currentMonth.getMonth() + 1).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
    setSelectedDate(dateStr);
    setError(null);
    try {
      const content = await dailyApi.getDaily(dateStr);
      if (content) {
        setDailyEntries(parseDailyContent(content));
      } else {
        setDailyEntries([]);
      }
    } catch {
      setDailyEntries([]);
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
      {dailyEntries.length === 0 ? (
        <div className="daily-widget__empty">
          <p>暂无日报内容</p>
          <button onClick={handleGenerate} disabled={generating || !lastGenAt}>
            {generating ? "生成中…" : lastGenAt ? "生成日报" : "无上次生成记录，请先点击生成"}
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
      <p className="daily-widget__hint">调用低成本模型分析会话变更，预计 10-30 秒</p>
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