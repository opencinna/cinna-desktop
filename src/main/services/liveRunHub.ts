import type { RunEvent } from '../../shared/runEvents'
import type { RunWatchMessage } from '../../shared/runWatch'
import { continuesPart } from '../../shared/partMerge'
import { QUESTION_TOOL_NAME, isPermissionRequestTool } from '../../shared/localAgentRequests'
import { createLogger } from '../logger/logger'

const logger = createLogger('live-run')

type Sink = (message: RunWatchMessage) => void
interface LiveRecord {
  id: string
  sequence: number
  agentId: string | null
  baseline: string[]
  events: RunEvent[]
  /** Accounted bytes of each retained event, parallel to `events`. */
  sizes: number[]
  bytes: number
  replayAvailable: boolean
}

/** Tool output kept per stream once the cache must shrink. */
const TOOL_OUTPUT_TAIL = 4 * 1024
/** Longest tool-input string kept once the cache must shrink, ellipsis included. */
const TOOL_INPUT_STRING = 2 * 1024
const TRUNCATED_OUTPUT_MARKER = '…[earlier output truncated]\n'

const size = (value: unknown): number => Buffer.byteLength(JSON.stringify(value))
/** Bytes `,"key":value` adds to an object that already has a member. */
const memberSize = (key: string, value: unknown): number => value === undefined ? 0 : size({ [key]: value }) - 1

/** A later watcher's projection ignores `status`, nested or not; it only splits mergeable deltas. */
const retainable = (event: RunEvent): boolean => event.type === 'child' ? retainable(event.event) : event.type !== 'status'

const ADOPTED = ['toolInput', 'toolId', 'commandInvocation'] as const

/** The renderer's own match for both request blocks (`askUserQuestion.ts`), separator- and case-insensitive. */
const isRequestTool = (toolName?: string): boolean =>
  isPermissionRequestTool(toolName) || toolName?.toLowerCase().replace(/[^a-z]/g, '') === QUESTION_TOOL_NAME

function merge(last: RunEvent, next: RunEvent): { event: RunEvent; growth: number } | null {
  // A `newPart` delta opens a part of its own, so it is never folded into the one before.
  if (last.type === 'delta' && next.type === 'delta' && !next.newPart && continuesPart(last, next)) {
    // An adopted input is copied: its size is measured once, here, so a caller
    // that later mutated its own object must not grow the cache unaccounted.
    const event = { ...last, text: last.text + next.text,
      toolInput: last.toolInput ?? (next.toolInput && structuredClone(next.toolInput)), toolId: last.toolId ?? next.toolId,
      commandInvocation: last.commandInvocation ?? next.commandInvocation }
    // JSON escaping is per character, so the joined text costs the fragment's
    // escaped bytes minus its quotes — exact, or an overcount when the join
    // completes a surrogate pair. A repeated field that is kept costs nothing;
    // only a field the last fragment lacked is measured, once.
    let growth = size(next.text) - 2
    for (const key of ADOPTED) {
      if (last[key] == null && event[key] != null) growth += memberSize(key, event[key]) - memberSize(key, last[key])
    }
    return { event, growth }
  }
  if (last.type === 'child' && next.type === 'child' && last.toolCallId === next.toolCallId && last.agentId === next.agentId) {
    const inner = merge(last.event, next.event)
    return inner ? { event: { ...last, event: inner.event }, growth: inner.growth } : null
  }
  return null
}

function head(text: string, length: number): string {
  const kept = text.slice(0, length)
  const code = kept.charCodeAt(kept.length - 1)
  return code >= 0xd800 && code <= 0xdbff ? kept.slice(0, -1) : kept
}

function tail(text: string, length: number): string {
  const kept = text.slice(-length)
  const code = kept.charCodeAt(0)
  return code >= 0xdc00 && code <= 0xdfff ? kept.slice(1) : kept
}

/** Shortens long strings anywhere in a tool input; returns the same value when nothing changed. */
function compactInput(value: unknown): unknown {
  if (typeof value === 'string') return value.length > TOOL_INPUT_STRING ? head(value, TOOL_INPUT_STRING - 1) + '…' : value
  if (Array.isArray(value)) {
    const items = value.map(compactInput)
    return items.some((item, i) => item !== value[i]) ? items : value
  }
  if (value && typeof value === 'object') {
    const entries = Object.entries(value).map(([key, item]) => [key, compactInput(item)] as const)
    return entries.some(([key, item]) => item !== (value as Record<string, unknown>)[key]) ? Object.fromEntries(entries) : value
  }
  return value
}

/**
 * Keeps which tools ran and drops what a re-attached view least needs: the
 * head of long tool output and the body of long tool arguments. Narration
 * (`text`, `thinking`, `tool`) is never shortened. The persisted row at turn
 * end carries the full content. Returns the same event when nothing changed.
 */
function compactEvent(event: RunEvent): RunEvent {
  if (event.type === 'child') {
    const inner = compactEvent(event.event)
    return inner === event.event ? event : { ...event, event: inner }
  }
  if (event.type !== 'delta') return event
  let result = event
  if (event.kind === 'tool_result' && event.text.length > TOOL_OUTPUT_TAIL + TRUNCATED_OUTPUT_MARKER.length) {
    result = { ...result, text: TRUNCATED_OUTPUT_MARKER + tail(event.text, TOOL_OUTPUT_TAIL) }
  }
  // A permission ask or question renders its block from this input and is
  // answerable on replay; the user must never decide on a shortened request.
  if (event.toolInput && !isRequestTool(event.toolName)) {
    const toolInput = compactInput(event.toolInput) as Record<string, unknown>
    if (toolInput !== event.toolInput) result = { ...result, toolInput }
  }
  return result
}

function typeCounts(events: RunEvent[]): Record<string, number> {
  const counts: Record<string, number> = {}
  const keyOf = (event: RunEvent): string => event.type === 'child' ? `child:${keyOf(event.event)}`
    : event.type === 'delta' ? `delta:${event.kind}` : event.type
  for (const event of events) counts[keyOf(event)] = (counts[keyOf(event)] ?? 0) + 1
  return counts
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
    try { sink(message) } catch {
      watchers.get(key)?.delete(sink)
      try { sink({ type: 'watch_error', runId: message.runId ?? '', sequence: message.sequence, agentId: message.agentId }) } catch { /* Port already closed. */ }
    }
  }
  const publish = (key: string, message: RunWatchMessage): void => {
    for (const sink of watchers.get(key) ?? []) send(key, sink, message)
  }
  /** Existing watchers keep receiving every live event; later ones poll saved messages. */
  const unavailable = (run: LiveRecord, reason: 'baseline' | 'bytes' | 'events' | 'serialization'): void => {
    const detail = { runId: run.id, reason, bytes: run.bytes, events: run.events.length,
      types: typeCounts(run.events), maxBytes, maxEvents }
    run.replayAvailable = false
    run.events = []
    run.sizes = []
    run.baseline = []
    try { logger.warn('live replay unavailable; later watchers fall back to saved messages', detail) } catch { /* Logging cannot stop the producer. */ }
  }
  const compact = (run: LiveRecord): void => {
    for (let i = 0; i < run.events.length; i++) {
      const event = compactEvent(run.events[i]!)
      if (event === run.events[i]) continue
      const bytes = size(event)
      run.bytes += bytes - run.sizes[i]!
      run.sizes[i] = bytes
      run.events[i] = event
    }
  }
  const retain = (run: LiveRecord, event: RunEvent): void => {
    const index = run.events.length - 1
    const last = run.events[index]
    const merged = last && merge(last, event)
    if (merged) {
      run.events[index] = merged.event
      run.sizes[index]! += merged.growth
      run.bytes += merged.growth
    } else {
      if (run.events.length >= maxEvents) return unavailable(run, 'events')
      const bytes = size(event)
      const copy = structuredClone(event)
      run.events.push(copy)
      run.sizes.push(bytes)
      run.bytes += bytes
    }
    if (run.bytes > maxBytes) {
      compact(run)
      if (run.bytes > maxBytes) unavailable(run, 'bytes')
    }
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
      const run: LiveRecord = { id, sequence: 0, agentId: null, baseline: [...baseline],
        events: [], sizes: [], bytes, replayAvailable: true }
      if (bytes > maxBytes) unavailable(run, 'baseline')
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
            // Bytes track what is retained: a merged fragment adds only its
            // growth, so a part repeating its full tool input is counted once.
            // `status` is not retained (a later projection ignores it). Over
            // the byte cap the cache first sheds tool output heads and long
            // tool arguments; only if it is still over, or over the entry cap,
            // is replay dropped. Existing watchers still receive every event.
            if (run.replayAvailable && retainable(event)) retain(run, event)
          } catch {
            unavailable(run, 'serialization')
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
