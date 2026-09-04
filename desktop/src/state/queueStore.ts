import { create } from 'zustand'

import {
  createAgentQueuedMessage,
  moveQueuedMessage,
  removeQueuedMessage,
  type AgentQueuedMessage,
  type QueueDropPlacement,
} from '../lib/agent-message-queue'

interface QueueStore {
  /** 队列消息列表（按创建时间排序，越新越靠前） */
  items: AgentQueuedMessage[]
  /** 是否折叠 */
  collapsed: boolean
  /** 切换折叠状态 */
  toggleCollapsed: () => void
  /** 设置折叠状态 */
  setCollapsed: (collapsed: boolean) => void
  /** 添加消息到队列 */
  enqueue: (text: string, options?: {
    fileReferenceBlock?: string
    attachments?: Array<{ filename: string; mediaType: string; size: number; targetPath: string }>
    additionalDirectories?: string[]
  }) => string
  /** 移除消息 */
  remove: (messageId: string) => void
  /** 撤回到输入框（从队列移除并返回消息文本） */
  recall: (messageId: string) => AgentQueuedMessage | null
  /** 移动消息（拖拽排序） */
  move: (sourceId: string, targetId: string, placement: QueueDropPlacement) => void
  /** 清空队列 */
  clear: () => void
  /** 立即发送（由组件调用，实际发送逻辑在组件侧处理） */
  markSending: () => void
}

let messageSeq = 0
function generateId(): string {
  return `queue_${Date.now()}_${++messageSeq}`
}

export const useQueueStore = create<QueueStore>((set, get) => ({
  items: [],
  collapsed: false,

  toggleCollapsed: () => set((state) => ({ collapsed: !state.collapsed })),
  setCollapsed: (collapsed) => set({ collapsed }),

  enqueue: (text, options) => {
    const id = generateId()
    const message = createAgentQueuedMessage(text, id, Date.now(), options)
    set((state) => ({ items: [message, ...state.items] }))
    return id
  },

  remove: (messageId) => {
    set((state) => ({ items: removeQueuedMessage(state.items, messageId) }))
  },

  recall: (messageId) => {
    const message = get().items.find((item) => item.id === messageId) ?? null
    if (message) {
      set((state) => ({ items: removeQueuedMessage(state.items, messageId) }))
    }
    return message
  },

  move: (sourceId, targetId, placement) => {
    set((state) => ({ items: moveQueuedMessage(state.items, sourceId, targetId, placement) }))
  },

  clear: () => set({ items: [] }),

  markSending: () => {
    // 可选：标记正在发送状态，UI 可显示 loading
    // 当前不需要额外状态，发送成功后由组件调用 remove
  },
}))

/** 判断是否满足自动派发条件（供外部调度器调用） */
export function shouldAutoDispatchQueue(state: Pick<QueueStore, 'items'>, runtime: {
  running: boolean
  backgroundWaiting: boolean
  stoppedByUser: boolean
  hasBlockingRequests: boolean
  hasChannel: boolean
  hasAvailableModel: boolean
}): boolean {
  return (
    state.items.length > 0 &&
    !runtime.running &&
    !runtime.backgroundWaiting &&
    !runtime.stoppedByUser &&
    !runtime.hasBlockingRequests &&
    runtime.hasChannel &&
    runtime.hasAvailableModel
  )
}