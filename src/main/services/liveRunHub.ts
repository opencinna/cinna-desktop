import type { RunEvent } from '../../shared/runEvents'
import type { RunWatchMessage } from '../../shared/runWatch'
import { continuesPart } from '../../shared/partMerge'

type Sink = (message: RunWatchMessage) => void
interface LiveRecord {
  id: string
  sequence: number
  agentId: string | null
  baseline: string[]
  events: RunEvent[]
  bytes: number
  replayAvailable: boolean
}

function merge(last: RunEvent, next: RunEvent): RunEvent | null {
  if (last.type === 'delta' && next.type === 'delta' && continuesPart(last, next)) {
    return { ...last, text: last.text + next.text,
      toolInput: last.toolInput ?? next.toolInput, toolId: last.toolId ?? next.toolId,
      commandInvocation: last.commandInvocation ?? next.commandInvocation }
  }
  if (last.type === 'child' && next.type === 'child' && last.toolCallId === next.toolCallId && last.agentId === next.agentId) {
    const event = merge(last.event, next.event)
    return event ? { ...last, event } : null
  }
  return null
}

/** No database or renderer lifetime: one owner produces events; views only watch. */
export function createLiveRunHub(maxBytes = 8 * 1024 * 1024, maxEvents = 5_000) {
  const runs = new Map<string, LiveRecord>()
  const watchers = new Map<string, Set<Sink>>()
  const keyOf = (userId: string, chatId: string): string => JSON.stringify([userId, chatId])
  const snapshot = (run?: LiveRecord): RunWatchMessage => ({
    type: 'snapshot', runId: run?.id ?? null, sequence: run?.sequence ?? 0,
    active: !!run, agentId: run?.agentId ?? null, replayAvailable: run?.replayAvailable ?? true,
    baselineMessageIds: run?.replayAvailable ? [...run.baseline] : [],
    events: run?.replayAvailable ? structuredClone(run.events) : []
  })
  const send = (key: string, sink: Sink, message: RunWatchMessage): void => {
    try { sink(message) } catch { watchers.get(key)?.delete(sink) }
  }
  const publish = (key: string, message: RunWatchMessage): void => {
    for (const sink of watchers.get(key) ?? []) send(key, sink, message)
  }
  return {
    watch(userId: string, chatId: string, sink: Sink): () => void {
      const key = keyOf(userId, chatId)
      let listeners = watchers.get(key)
      if (!listeners) { listeners = new Set(); watchers.set(key, listeners) }
      listeners.add(sink)
      send(key, sink, snapshot(runs.get(key)))
      return () => {
        listeners.delete(sink)
        if (!listeners.size) watchers.delete(key)
      }
    },
    begin(userId: string, chatId: string, id: string, baseline: string[]) {
      const key = keyOf(userId, chatId)
      if (runs.has(key)) throw new Error('This chat already has a live run.')
      const bytes = Buffer.byteLength(JSON.stringify(baseline))
      const run: LiveRecord = { id, sequence: 0, agentId: null, baseline: bytes <= maxBytes ? [...baseline] : [],
        events: [], bytes, replayAvailable: bytes <= maxBytes }
      runs.set(key, run)
      publish(key, snapshot(run))
      const current = (): boolean => runs.get(key) === run
      return {
        setAgentId(agentId: string | null): void { if (current()) run.agentId = agentId },
        accepted(): void {
          if (current()) publish(key, { type: 'accepted', runId: id, sequence: ++run.sequence, agentId: run.agentId })
        },
        push(event: RunEvent): void {
          if (!current()) return
          try {
            if (run.replayAvailable) {
              // Conservative byte accounting includes nested text, tool arguments
              // and results. Existing watchers still receive every live event if
              // the replay cache fills; later attachments use saved-message polling.
              run.bytes += Buffer.byteLength(JSON.stringify(event))
              if (run.bytes > maxBytes || run.events.length >= maxEvents) {
                run.replayAvailable = false
                run.events = []
                run.baseline = []
              } else {
                const last = run.events.at(-1)
                const combined = last && merge(last, event)
                if (combined) run.events[run.events.length - 1] = combined
                else run.events.push(structuredClone(event))
              }
            }
          } catch {
            run.replayAvailable = false
            run.events = []
            run.baseline = []
          }
          publish(key, { type: 'event', runId: id, sequence: ++run.sequence, agentId: run.agentId, event })
        },
        close(): void {
          if (!current()) return
          runs.delete(key)
          publish(key, { type: 'closed', runId: id, sequence: ++run.sequence, agentId: run.agentId })
        }
      }
    }
  }
}

export const liveRunHub = createLiveRunHub()
