/** 落盘工具调用（snake: tool_calls；兼容 camel: toolCalls） */
export interface StoredToolCall {
  tool?: string;
  name?: string;
  args?: string;
  result?: string;
}

/** 落盘消息（从 /api/agents/:id/messages 返回） */
export interface StoredMessage {
  role: string;
  content: string;
  timestamp: string;
  /** 流式消息状态：streaming / done / stopped / error（缺省 = 已完成的旧消息） */
  status?: string;
  toolCalls?: StoredToolCall[];
  tool_calls?: StoredToolCall[];
}

/** GET /api/sessions 返回的会话候选（& 提及弹窗数据源） */
export interface SessionCandidate {
  id: string;
  name: string;
  goal: string;
  created_at: string;
  message_count: number;
  last_message_at: string;
}

/** & 提及状态：active 时吞噬导航键，Enter/Tab 选中后回插 &ses_<id> */
export interface Mention {
  active: boolean;
  query: string; // & 之后、光标之前的过滤串
  start: number; // & 在 value 中的起始下标
  index: number; // 高亮项游标
}

/** 已选中的会话引用 chip（可视化，底层 input 仍存 &ses_<id>） */
export interface MentionChip {
  sessionId: string;
  name: string;
}

/** 工具卡片数据（展示层） */
export interface ToolCardData {
  name: string;
  args: string;
  status: "running" | "done";
  result?: string;
  collapsed: boolean;
}

/** 展示消息：用户 / agent（文本或流式）/ 工具卡片 */
export interface DisplayMessage {
  key: string;
  role: "user" | "agent" | "tool";
  content: string;
  status?: string;
  toolCard?: ToolCardData;
}

/** & 提及状态 */
export interface Mention {
  active: boolean;
  query: string;
  start: number;
  index: number;
}

/** 已选中的会话引用 chip */
export interface MentionChip {
  sessionId: string;
  name: string;
}