import { useCallback, useEffect, useState } from "react";

import { awaitApiBase, fetchAgentQuestions } from "../lib/api";
import { subscribeDutyEvents } from "../lib/dutyEvents";
import type { DispatchView, QuestionSetView } from "../types";

/**
 * 值日生窗口的数据源：
 * - 调度台账（GET /api/dispatches，按 dispatcherId 过滤）；
 * - 待老师拍板的结构化问答（GET /api/agents/:id/questions）。
 *
 * 两者都靠 dutyEvents 增量刷新（值日生终态 / 判读结论到达），另加一个低速兜底轮询，
 * 避免事件漏接时窗口停在旧数据。
 */

const FALLBACK_POLL_MS = 20000;

export interface DutyLedgerState {
  dispatches: DispatchView[];
  loading: boolean;
  error: string | null;
  refresh: () => void;
}

export function useDispatchLedger(dispatcherId: string | null): DutyLedgerState {
  const [dispatches, setDispatches] = useState<DispatchView[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [tick, setTick] = useState(0);
  const refresh = useCallback(() => setTick((value) => value + 1), []);

  useEffect(() => {
    if (!dispatcherId) {
      setDispatches([]);
      return;
    }
    let alive = true;
    const load = async () => {
      setLoading(true);
      try {
        const base = await awaitApiBase();
        const res = await fetch(`${base}/api/dispatches?dispatcherId=${encodeURIComponent(dispatcherId)}`);
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const data = (await res.json()) as { dispatches?: DispatchView[] };
        if (!alive) return;
        setDispatches(data.dispatches ?? []);
        setError(null);
      } catch (err) {
        if (alive) setError(err instanceof Error ? err.message : String(err));
      } finally {
        if (alive) setLoading(false);
      }
    };
    void load();
    const timer = window.setInterval(() => void load(), FALLBACK_POLL_MS);
    const unsubscribe = subscribeDutyEvents((event) => {
      if (!alive) return;
      const relevant =
        event.type === "dispatch_verdict"
          ? event.dispatcher_agent_id === dispatcherId
          : event.agent_id === dispatcherId && (event.state === "completed" || event.state === "error");
      if (relevant) void load();
    });
    return () => {
      alive = false;
      window.clearInterval(timer);
      unsubscribe();
    };
  }, [dispatcherId, tick]);

  return { dispatches, loading, error, refresh };
}

export interface PendingQuestionsState {
  sets: QuestionSetView[];
  refresh: () => void;
}

export function usePendingQuestions(
  agentId: string | null,
  options?: { includeAnswered?: boolean; answeredLimit?: number },
): PendingQuestionsState {
  const [sets, setSets] = useState<QuestionSetView[]>([]);
  const [tick, setTick] = useState(0);
  const refresh = useCallback(() => setTick((value) => value + 1), []);

  useEffect(() => {
    if (!agentId) {
      setSets([]);
      return;
    }
    let alive = true;
    const load = () => {
      void fetchAgentQuestions(agentId, options)
        .then((all) => {
          if (alive) setSets(all);
        })
        .catch(() => undefined);
    };
    load();
    const timer = window.setInterval(load, FALLBACK_POLL_MS);
    const unsubscribe = subscribeDutyEvents((event) => {
      if (!alive) return;
      // 问题集的产生（requiring_input）与作答后的状态回落都要立刻刷新，不能只等 20s 轮询
      if (event.type === "agent_state" && event.agent_id === agentId) load();
    });
    return () => {
      alive = false;
      window.clearInterval(timer);
      unsubscribe();
    };
  }, [agentId, tick, options?.includeAnswered, options?.answeredLimit]);

  return { sets, refresh };
}
