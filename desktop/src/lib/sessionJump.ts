/**
 * 会话内命中跳转总线（跨窗口单例）。
 *
 * 场景：检索结果命中「其他会话」时，前端先 openAgent 打开对应窗口，
 * 再通过本模块登记跳转目标；目标 AgentWindow 在消息恢复完成后消费并滚动定位。
 */
export interface SessionJumpTarget {
  sessionId: string;
  /** transcript turn 序号（= 第 N 条用户消息） */
  turn: number;
}

let pending: SessionJumpTarget | null = null;

/** 登记一次跳转（后登记的覆盖先登记的） */
export function requestJump(target: SessionJumpTarget): void {
  pending = target;
}

/** 若存在且属于目标会话则消费并返回 turn，否则返回 null */
export function consumeJump(sessionId: string): number | null {
  if (pending && pending.sessionId === sessionId) {
    const turn = pending.turn;
    pending = null;
    return turn;
  }
  return null;
}

/** 主动清空（关闭窗口/取消检索时） */
export function clearJump(): void {
  pending = null;
}
