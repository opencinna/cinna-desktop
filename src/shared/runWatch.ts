import { isRunEvent, type RunEvent } from './runEvents'

export type RunWatchMessage = {
  type: 'snapshot'
  runId: string | null
  sequence: number
  active: boolean
  agentId: string | null
  replayAvailable: boolean
  baselineMessageIds: string[]
  events: RunEvent[]
} | {
  type: 'event'
  runId: string
  sequence: number
  agentId: string | null
  event: RunEvent
} | {
  type: 'accepted' | 'closed'
  runId: string
  sequence: number
  agentId: string | null
}

export function isRunWatchMessage(value: unknown): value is RunWatchMessage {
  if (!value || typeof value !== 'object') return false
  const message = value as Partial<RunWatchMessage>
  if (!Number.isSafeInteger(message.sequence) || message.sequence! < 0 ||
    !(message.agentId === null || typeof message.agentId === 'string')) return false
  if (message.type === 'snapshot') return (message.runId === null || typeof message.runId === 'string') &&
    typeof message.active === 'boolean' && typeof message.replayAvailable === 'boolean' &&
    Array.isArray(message.baselineMessageIds) && message.baselineMessageIds.every((id) => typeof id === 'string') &&
    Array.isArray(message.events) && message.events.every(isRunEvent)
  if (typeof message.runId !== 'string') return false
  return message.type === 'accepted' || message.type === 'closed' ||
    (message.type === 'event' && isRunEvent(message.event))
}
