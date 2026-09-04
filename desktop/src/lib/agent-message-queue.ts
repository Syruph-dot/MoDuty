/**
 * Agent 消息队列库（参考 Proma agent-message-queue）
 * - AgentQueuedMessage：排队待发送的消息
 * - 解析 @file / /skill / #mcp / &session / &todo / &calendar_event / &quote 引用
 * - 拖拽排序、撤回、删除、立即发送
 * - 自动派发判断（running / backgroundWaiting / stoppedByUser 等）
 */

import { ENCODED_MENTION_VALUE_PATTERN, PLAIN_MENTION_VALUE_PATTERN } from './mention-patterns'

export type QueueDropPlacement = 'before' | 'after'

export interface AgentQueuedAttachment {
  filename: string
  mediaType: string
  size: number
  targetPath: string
}

export interface AgentQueuedMessage {
  id: string
  text: string
  createdAt: number
  fileReferenceBlock?: string
  attachments?: AgentQueuedAttachment[]
  additionalDirectories?: string[]
}

/** 是否满足自动派发条件（队列有消息且非运行/后台等待/用户停止/有阻塞请求/有渠道/有可用模型） */
export function shouldAutoDispatchQueuedMessage(options: {
  queueLength: number
  running: boolean
  backgroundWaiting: boolean
  stoppedByUser: boolean
  hasBlockingRequests: boolean
  hasChannel: boolean
  hasAvailableModel: boolean
}): boolean {
  return (
    options.queueLength > 0 &&
    !options.running &&
    !options.backgroundWaiting &&
    !options.stoppedByUser &&
    !options.hasBlockingRequests &&
    options.hasChannel &&
    options.hasAvailableModel
  )
}

/** 创建队列消息 */
export function createAgentQueuedMessage(
  text: string,
  id: string,
  createdAt: number,
  options?: {
    fileReferenceBlock?: string
    attachments?: AgentQueuedAttachment[]
    additionalDirectories?: string[]
  },
): AgentQueuedMessage {
  const message: AgentQueuedMessage = {
    id,
    text: text.trim(),
    createdAt,
  }
  if (options?.fileReferenceBlock) message.fileReferenceBlock = options.fileReferenceBlock
  if (options?.attachments && options.attachments.length > 0) message.attachments = options.attachments
  if (options?.additionalDirectories && options.additionalDirectories.length > 0) {
    message.additionalDirectories = options.additionalDirectories
  }
  return message
}

/** 移除队列消息 */
export function removeQueuedMessage(
  queue: AgentQueuedMessage[],
  messageId: string,
): AgentQueuedMessage[] {
  return queue.filter((item) => item.id !== messageId)
}

/** 撤回到队首（用于撤回到输入框后重新编辑） */
export function restoreQueuedMessageToFront(
  queue: AgentQueuedMessage[],
  message: AgentQueuedMessage,
): AgentQueuedMessage[] {
  if (queue.some((item) => item.id === message.id)) return queue
  return [message, ...queue]
}

/** 拖拽移动队列消息 */
export function moveQueuedMessage(
  queue: AgentQueuedMessage[],
  sourceId: string,
  targetId: string,
  placement: QueueDropPlacement,
): AgentQueuedMessage[] {
  if (sourceId === targetId) return queue

  const source = queue.find((item) => item.id === sourceId)
  if (!source) return queue

  const withoutSource = queue.filter((item) => item.id !== sourceId)
  const targetIndex = withoutSource.findIndex((item) => item.id === targetId)
  if (targetIndex === -1) return queue

  const insertIndex = placement === 'after' ? targetIndex + 1 : targetIndex
  return [
    ...withoutSource.slice(0, insertIndex),
    source,
    ...withoutSource.slice(insertIndex),
  ]
}

export interface ParsedQueuedMessageMentions {
  cleanedText: string
  mentionedSkills: string[]
  mentionedMcpServers: string[]
  mentionedSessionIds: string[]
  mentionedTodoIds: string[]
  mentionedCalendarEventIds: string[]
}

export interface QueuedMessageSendPayload {
  rawText: string
  sdkText: string
  mentions: ParsedQueuedMessageMentions
}

export type QueuedMessageReferenceType =
  | 'file'
  | 'skill'
  | 'mcp'
  | 'session'
  | 'todo'
  | 'calendar_event'
  | 'quote'

export type QueuedMessageDisplayPart =
  | { type: 'text'; value: string }
  | {
      type: 'reference'
      referenceType: 'file' | 'skill' | 'mcp' | 'session' | 'todo' | 'calendar_event' | 'quote'
      id: string
      label: string
    }

const REF_PATTERN = new RegExp(
  String.raw`/skill:(?<skill>${PLAIN_MENTION_VALUE_PATTERN})|#mcp:(?<mcp>${PLAIN_MENTION_VALUE_PATTERN})|&session:(?<session>[A-Za-z0-9-]+)(?:(?:~|::)${ENCODED_MENTION_VALUE_PATTERN})?|&todo:(?<todo>[A-Za-z0-9-]+)(?:(?:~|::)${ENCODED_MENTION_VALUE_PATTERN})?|&calendar_event:(?<calendarEvent>[A-Za-z0-9-]+)(?:(?:~|::${ENCODED_MENTION_VALUE_PATTERN})?`,
  'gu',
)

const DISPLAY_REFERENCE_PATTERN = new RegExp(
  String.raw`&quote:(?<quote>[A-Za-z0-9%_.!~*'()-]+)|@file:(?<file>${ENCODED_MENTION_VALUE_PATTERN})|/skill:(?<skill>${PLAIN_MENTION_VALUE_PATTERN})|#mcp:(?<mcp>${PLAIN_MENTION_VALUE_PATTERN})|&session:(?<session>[A-Za-z0-9-]+)(?:(?:~|::)(?<sessionLabel>${ENCODED_MENTION_VALUE_PATTERN}))?|&todo:(?<todo>[A-Za-z0-9-]+)(?:(?:~|::)(?<todoLabel>${ENCODED_MENTION_VALUE_PATTERN}))?|&calendar_event:(?<calendarEvent>[A-Za-z0-9-]+)(?:(?:~|::)(?<calendarEventLabel>${ENCODED_MENTION_VALUE_PATTERN}))?`,
  'gu',
)

/** 将队列消息中的引用转换为展示片段（用于预览渲染芯片） */
export function getQueuedMessageDisplayParts(text: string): Array<
  | { type: 'text'; value: string }
  | {
      type: 'reference'
      referenceType: 'file' | 'skill' | 'mcp' | 'session' | 'todo' | 'calendar_event' | 'quote'
      id: string
      label: string
    }
> {
  const parts: Array<
    | { type: 'text'; value: string }
    | {
        type: 'reference'
        referenceType: 'file' | 'skill' | 'mcp' | 'session' | 'todo' | 'calendar_event' | 'quote'
        id: string
        label: string
      }
  > = []
  let lastIndex = 0

  for (const match of text.matchAll(DISPLAY_REFERENCE_PATTERN)) {
    if (match.index > lastIndex) {
      parts.push({ type: 'text', value: text.slice(lastIndex, match.index) })
    }

    const groups = match.groups ?? {}
    if (groups.quote) {
      parts.push({
        type: 'reference',
        referenceType: 'quote',
        id: groups.quote,
        label: `引用 ${groups.quote}`,
      })
      lastIndex = match.index + match[0].length
      continue
    }

    let referenceType: 'file' | 'skill' | 'mcp' | 'session' | 'todo' | 'calendar_event' | 'quote'
    let id: string
    let rawLabel: string | undefined

    if (groups.file) {
      referenceType = 'file'
      id = groups.file
    } else if (groups.skill) {
      referenceType = 'skill'
      id = groups.skill
    } else if (groups.mcp) {
      referenceType = 'mcp'
      id = groups.mcp
    } else if (groups.session) {
      referenceType = 'session'
      id = groups.session
      rawLabel = groups.sessionLabel
    } else if (groups.todo) {
      referenceType = 'todo'
      id = groups.todo
      rawLabel = groups.todoLabel
    } else if (groups.calendarEvent) {
      referenceType = 'calendar_event'
      id = groups.calendarEvent
      rawLabel = groups.calendarEventLabel
    } else {
      continue
    }

    const label = rawLabel
      ? decodeURIComponent(rawLabel)
      : referenceType === 'file'
        ? id.split(/[\\/]/).pop() || id
        : referenceType === 'session'
          ? `会话 ${id.slice(0, 8)}`
          : referenceType === 'todo'
            ? `Todo ${id.slice(0, 8)}`
            : referenceType === 'calendar_event'
              ? `日程 ${id.slice(0, 8)}`
              : id

    parts.push({ type: 'reference', referenceType, id, label })
    lastIndex = match.index + match[0].length
  }

  if (lastIndex < text.length) {
    parts.push({ type: 'text', value: text.slice(lastIndex) })
  }

  return parts.length > 0 ? parts : [{ type: 'text', value: text }]
}

/** 解析队列消息中的引用（用于发送时提取 ID） */
export function parseQueuedMessageMentions(text: string): {
  cleanedText: string
  mentionedSkills: string[]
  mentionedMcpServers: string[]
  mentionedSessionIds: string[]
  mentionedTodoIds: string[]
  mentionedCalendarEventIds: string[]
} {
  const mentionedSkills: string[] = []
  const mentionedMcpServers: string[] = []
  const mentionedSessionIds: string[] = []
  const mentionedTodoIds: string[] = []
  const mentionedCalendarEventIds: string[] = []

  for (const match of text.matchAll(REF_PATTERN)) {
    const { skill, mcp, session, todo, calendarEvent } = match.groups ?? {}
    if (skill) mentionedSkills.push(skill)
    else if (mcp) mentionedMcpServers.push(mcp)
    else if (session) mentionedSessionIds.push(session)
    else if (todo) mentionedTodoIds.push(todo)
    else if (calendarEvent) mentionedCalendarEventIds.push(calendarEvent)
  }

  return {
    cleanedText: text
      .replace(REF_PATTERN, '')
      .replace(
        new RegExp(String.raw`@file:(${ENCODED_MENTION_VALUE_PATTERN})`, 'gu'),
        (full, encodedPath: string) =>
          /%[0-9A-Fa-f]{2}/.test(encodedPath)
            ? `@file:${decodeURIComponent(encodedPath)}`
            : full,
      )
      .trim(),
    mentionedSkills,
    mentionedMcpServers,
    mentionedSessionIds,
    mentionedTodoIds,
    mentionedCalendarEventIds,
  }
}

/** 构建发送载荷（包含原始文本、SDK 文本、解析出的引用） */
export interface QueuedMessageSendPayload {
  rawText: string
  sdkText: string
  mentions: {
    cleanedText: string
    mentionedSkills: string[]
    mentionedMcpServers: string[]
    mentionedSessionIds: string[]
    mentionedTodoIds: string[]
    mentionedCalendarEventIds: string[]
  }
}

export function buildQueuedMessageSendPayload(message: AgentQueuedMessage): {
  rawText: string
  sdkText: string
  mentions: {
    cleanedText: string
    mentionedSkills: string[]
    mentionedMcpServers: string[]
    mentionedSessionIds: string[]
    mentionedTodoIds: string[]
    mentionedCalendarEventIds: string[]
  }
} {
  const text = message.text.trim()
  const mentions = parseQueuedMessageMentions(text)
  return {
    rawText: text,
    sdkText: text,
    mentions,
  }
}