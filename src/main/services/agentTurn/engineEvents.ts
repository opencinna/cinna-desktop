/**
 * The slice of OpenCode's event vocabulary this desktop consumes.
 *
 * Transcribed from the OpenAPI document served by pinned `opencode` 1.18.27 at
 * `GET /doc` — 162 paths, and a `V2Event` union of **88** variants on the
 * global stream. Only the variants a turn actually needs are typed here; the
 * rest are matched by their `type` string and ignored, which is why
 * {@link EngineEvent} keeps an open `type: string` fallback rather than a
 * closed union. A new event variant in a later OpenCode must not crash a turn.
 *
 * ## Which stream carries what — this is the load-bearing fact
 *
 * There are two streams and they are **not** interchangeable:
 *
 * - `GET /api/event` — global, all 88 variants, and the **only** source of
 *   `session.next.text.delta`, `session.next.reasoning.delta`,
 *   `session.next.tool.input.delta`, `permission.v2.*`, `question.v2.*`,
 *   `session.idle` and `session.error`. It takes **no query parameters at all**
 *   (verified against the spec: `"parameters": []`), so it is **not resumable**
 *   — a dropped connection loses the gap permanently, and the `durable.seq`
 *   these events carry has nowhere to be sent back to.
 * - `GET /api/session/{id}/event?after=<seq>` — per-session and **durable**,
 *   but only 28 variants: exactly the global set minus every `*.delta`, minus
 *   permission and question, and minus `session.idle` and `session.error`.
 *
 * ## How a turn actually ends, observed against the real binary
 *
 * **`session.idle` is never emitted by 1.18.27.** Three real turns were watched
 * on both `/api/event` and the legacy `/event`; every one stopped at
 * `session.next.step.ended` and nothing followed. And `POST
 * /api/session/{id}/wait` — the documented "wait for idle" endpoint — answers
 * **503 `{"_tag":"ServiceUnavailableError","message":"Session wait is not
 * available yet","service":"session.wait"}`** in about 16ms. It is declared in
 * the OpenAPI document and not implemented. Both documented completion signals
 * are therefore dead, and a runner built on them hangs forever.
 *
 * The real terminal signal is **`session.next.step.ended` with
 * `finish === 'stop'`**: a plain answer emits exactly one, and a tool-calling
 * turn emits `finish: 'tool-calls'` per tool round and `'stop'` last.
 *
 * That is a better position than it sounds, and it reverses what this comment
 * used to say. `session.next.step.ended` **is** one of the 28 durable variants,
 * so the completion signal now rides the *resumable* stream. A dropped
 * subscription is repaired by replaying `?after=<seq>` alone — the same call
 * restores the missing content and delivers the end of the turn. There is no
 * longer any need for a third endpoint, and `/wait` is not called at all.
 *
 * ## Attribution
 *
 * One `opencode serve` backs every folder agent, so the global stream carries
 * every session's events and the runner fans out by `data.sessionID`. Note that
 * `SessionError.data` declares **no required properties** — `sessionID` is
 * optional there, so an error can arrive attributable to no session at all.
 * Anything unattributable is logged and dropped rather than broadcast to every
 * listener, which would end unrelated turns.
 */

/** `durable:{aggregateID, seq, version}` — carried on most events. */
export interface EngineEventDurable {
  aggregateID: string
  seq: number
  version: number
}

/**
 * One event off either stream, narrowed only as far as fan-out needs.
 *
 * `data` is deliberately loose: the runner reads it through per-variant
 * accessors that validate as they go, because this JSON crossed a socket from
 * a separately-versioned binary and a field the schema calls required can still
 * be absent from a build we have not tested against.
 */
export interface EngineEvent {
  type: string
  id?: string
  durable?: EngineEventDurable
  location?: { directory?: string; workspaceID?: string }
  data?: Record<string, unknown>
}

/** Event type strings, so a typo is a compile error rather than a dead branch. */
export const ENGINE_EVENT = {
  textStarted: 'session.next.text.started',
  textDelta: 'session.next.text.delta',
  textEnded: 'session.next.text.ended',
  reasoningDelta: 'session.next.reasoning.delta',
  toolCalled: 'session.next.tool.called',
  toolSuccess: 'session.next.tool.success',
  toolFailed: 'session.next.tool.failed',
  stepEnded: 'session.next.step.ended',
  stepFailed: 'session.next.step.failed',
  permissionAsked: 'permission.v2.asked',
  permissionReplied: 'permission.v2.replied',
  questionAsked: 'question.v2.asked',
  questionReplied: 'question.v2.replied',
  questionRejected: 'question.v2.rejected',
  idle: 'session.idle',
  error: 'session.error'
} as const

/**
 * The session an event belongs to, or null when it names none.
 *
 * Total by construction: this runs on every event off a stream shared by every
 * agent, so a malformed or unattributed event has to be a `null`, never a
 * throw and never a wrong id.
 */
export function eventSessionId(event: EngineEvent): string | null {
  const raw = event.data?.sessionID
  return typeof raw === 'string' && raw.startsWith('ses') ? raw : null
}

/** Parse one SSE payload into an {@link EngineEvent}, or null if it is not one. */
export function parseEngineEvent(payload: string): EngineEvent | null {
  let raw: unknown
  try {
    raw = JSON.parse(payload)
  } catch {
    return null
  }
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null
  const obj = raw as Record<string, unknown>
  if (typeof obj.type !== 'string') return null
  const data =
    obj.data && typeof obj.data === 'object' && !Array.isArray(obj.data)
      ? (obj.data as Record<string, unknown>)
      : undefined
  const durableRaw = obj.durable
  let durable: EngineEventDurable | undefined
  if (durableRaw && typeof durableRaw === 'object' && !Array.isArray(durableRaw)) {
    const d = durableRaw as Record<string, unknown>
    if (typeof d.aggregateID === 'string' && typeof d.seq === 'number') {
      durable = {
        aggregateID: d.aggregateID,
        seq: d.seq,
        version: typeof d.version === 'number' ? d.version : 0
      }
    }
  }
  return {
    type: obj.type,
    id: typeof obj.id === 'string' ? obj.id : undefined,
    durable,
    location:
      obj.location && typeof obj.location === 'object' && !Array.isArray(obj.location)
        ? (obj.location as { directory?: string; workspaceID?: string })
        : undefined,
    data
  }
}
