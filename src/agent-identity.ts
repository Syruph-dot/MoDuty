/**
 * 自我身份块：把「你是谁」写进每轮动态上下文。
 *
 * 动机（实测 2026-09-21 MDG-BlogWebsite 任务）：执行者需要 id 才能用 read_session /
 * inspect_session / search_content，而它并不知道自己是谁、会话 id 是多少，
 * 于是一整轮都在猜（read_session ses_0b8042189ff1、inspect_session tile_0b8042189ff1、
 * tile_agt_0b8042189ff1…全是 Unknown），10 次工具调用换不来回一次有效读取，最后空响应报错。
 * 身份是稳定的、每轮都一样，但按既有约定不放 system（那会破坏上游前缀缓存），
 * 所以和其它的动态上下文一起，注入到末尾的 user 消息里。
 *
 * 纯函数、无依赖，便于单测。
 */

export interface SelfIdentityInput {
  id: string;
  name: string;
  sessionId: string;
  /** 值日生（调度者）会多说一句它能用什么 */
  isDispatcher: boolean;
  workspaceDir?: string;
}

/** 生成身份块；缺 id/sessionId 时返回 null（拿不到就不注入，别注入半截信息） */
export function describeSelfBlock(input: SelfIdentityInput): string | null {
  const id = (input.id ?? "").trim();
  const sessionId = (input.sessionId ?? "").trim();
  if (!id || !sessionId) return null;
  const name = (input.name ?? "").trim() || id;
  const lines = [
    "## 你是谁（这些 id 直接可用，不要猜测或试探）",
    `- 名字：${name}`,
    `- agent_id：${id}`,
    `- 你的会话 session_id：${sessionId}`,
    `- 角色：${input.isDispatcher ? "值日生（调度者）" : "执行者"}`,
  ];
  if (input.workspaceDir) lines.push(`- 工作目录：${input.workspaceDir}`);
  lines.push(
    `- 要看自己的历史：read_session ${sessionId}；inspect_session 也直接用它；`,
    "  需要按关键词在自己会话里找内容时用 search_content 并把 id 设成上面这个 session_id。",
  );
  return lines.join("\n");
}
