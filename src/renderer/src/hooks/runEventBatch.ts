import type { RunEvent } from '../../../shared/runEvents'

/**
 * The longest queued run events wait when no animation frame comes: a hidden
 * window runs no frames, and its transcript must still keep up.
 */
export const RUN_EVENT_FLUSH_FALLBACK_MS = 50

/**
 * Whether a run event may wait for the next frame. Streamed output (text and
 * tool chunks, tool calls and their ends, a nested agent's output) arrives
 * many times a frame and only grows what is drawn. Everything else — a turn
 * starting or ending, an ask raised or settled, a message taken into the turn
 * — is applied at once, after whatever is queued, because other code reads the
 * store right after it (`useLiveRunWatch`'s settle, the composer, the asks).
 */
export function coalescesRunEvent(event: RunEvent): boolean {
  switch (event.type) {
    case 'delta':
    case 'tool_use':
    case 'tool_result':
    case 'tool_error':
    case 'status':
      return true
    case 'child':
      return event.event.type !== 'needs_input' && event.event.type !== 'input_resolved'
    default:
      return false
  }
}

export interface RunEventBatch {
  /** Queue `event`, or apply it now — after everything queued — when it must not wait. */
  push: (event: RunEvent) => void
  /** Apply everything queued, in arrival order. */
  flush: () => void
  /** Drop what is queued and any scheduled flush. */
  dispose: () => void
}

/**
 * Applies streamed run events once per animation frame instead of once per
 * port message. Every message is a task of its own, and every store update a
 * task makes is a render of the transcript: a fast stream drew the whole chat
 * many times a frame. Queued here, a frame's events are applied in one task,
 * so React renders once for all of them. Order is exactly arrival order.
 */
export function createRunEventBatch(apply: (event: RunEvent) => void): RunEventBatch {
  let queue: RunEvent[] = []
  let frame: number | null = null
  let timer: ReturnType<typeof setTimeout> | null = null

  const cancelScheduled = (): void => {
    if (frame !== null && typeof cancelAnimationFrame === 'function') cancelAnimationFrame(frame)
    if (timer !== null) clearTimeout(timer)
    frame = null
    timer = null
  }

  const flush = (): void => {
    cancelScheduled()
    if (queue.length === 0) return
    const events = queue
    queue = []
    for (const event of events) apply(event)
  }

  const schedule = (): void => {
    if (frame !== null || timer !== null) return
    // Both, whichever comes first: no frame runs in a hidden window, and a
    // window hidden after the frame was asked for would never get it.
    if (typeof requestAnimationFrame === 'function') frame = requestAnimationFrame(flush)
    timer = setTimeout(flush, RUN_EVENT_FLUSH_FALLBACK_MS)
  }

  return {
    push(event) {
      if (coalescesRunEvent(event)) {
        queue.push(event)
        schedule()
        return
      }
      flush()
      apply(event)
    },
    flush,
    dispose() {
      cancelScheduled()
      queue = []
    }
  }
}
