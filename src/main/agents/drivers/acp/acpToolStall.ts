/**
 * The stall watchdog: a tool call the agent opened and then never filled in.
 *
 * Pinned OpenCode (1.18.27, on gpt-4.1-mini) opened a `write` call — a
 * `tool_call` with no input — and then said nothing more, ever: its own
 * database held the part as `pending` with `input: {}` and `raw: ""`, with no
 * error and no finish, so `session/prompt` never came back. The only guard was
 * the turn ceiling, and a task sat In progress for eighty minutes.
 *
 * So one shape of silence is bounded much tighter than the ceiling: **a tool
 * call that is open and has never received anything** — no input on its
 * `tool_call`, and no `tool_call_update` carrying a `rawInput` field (even an
 * empty one), content or a status — with **no `session/update` of any kind**
 * for {@link ACP_TOOL_STALL_MS}. Every update for the session starts the clock
 * again.
 *
 * What it leaves alone, on purpose:
 * - a call that has received input or any update: it is really running, and a
 *   build or a test run may be silent for much longer; the ceiling covers it;
 * - a turn with a parked permission or question ask, or a Cinna tool call in
 *   flight: the wait is for somebody else;
 * - a turn with no call open: a model may think for minutes in silence.
 *
 * **Only for an engine whose launcher asks for it** (`AcpLauncher.toolStallMs`):
 * OpenCode does. Claude and Codex do not — Codex's tool calls always carry
 * `in_progress` and their input, and `claude-agent-acp` never sends
 * `in_progress`, so a running Claude tool with no arguments (an MCP tool that
 * takes none) would look exactly like a stall. Custom ACP agents do not either.
 * With no setting the watch is inert.
 *
 * Ten minutes, not less: a slow local model (an Ollama provider writing a large
 * file body) may stream a call's arguments in silence for minutes. The known
 * trade-off is that one silent for longer than that is stopped.
 *
 * Used by both turn paths — a prompted turn and a follow-up. When it fires, the
 * turn is stopped the way the ceiling stops it, and fails with
 * {@link toolStallMessage}; a follow-up's shared process is kept even when the
 * cancel goes unanswered (see `runFollowUp`).
 *
 * **A prompted turn retries once.** The freeze is intermittent (live, about one
 * report write in seven to ten), and a session whose prompt came back
 * `cancelled` inside the grace is still usable. So that turn sends one more
 * `session/prompt` — {@link TOOL_STALL_RETRY_PROMPT} — on the same session,
 * inside the same Cinna turn, says so in the transcript
 * ({@link TOOL_STALL_RETRY_NOTICE}), and takes the retry's outcome as the
 * turn's. A second stall fails with the message `retried`. No retry when the
 * cancel went unanswered (the process was retired), and none for a follow-up.
 */

import type { SessionNotification } from '@agentclientprotocol/sdk'

/** How long an input-less open tool call may go with no update at all, on an engine that sets the watch (OpenCode). */
export const ACP_TOOL_STALL_MS = 10 * 60 * 1000

/** The turn's error when the watchdog stopped it after `ms` of silence; `retried` once the one automatic retry stalled too. */
export function toolStallMessage(ms: number, retried = false): string {
  const minutes = Math.round(ms / 60_000)
  const span = minutes >= 1 ? `${minutes} minute${minutes === 1 ? '' : 's'}` : `${Math.max(1, Math.round(ms / 1000))} seconds`
  return `The agent stopped responding while preparing a tool call (no progress for ${span}), so it was stopped${retried ? ' (after one automatic retry)' : ''}.`
}

/** What a prompted turn sends on the same session after its first stall was cancelled cleanly. */
export const TOOL_STALL_RETRY_PROMPT =
  'Your last tool call stopped before its input arrived, so it was cancelled. Continue the task from where you left off; redo that step if it is still needed.'

/** The transcript's notice that the retry happened. */
export const TOOL_STALL_RETRY_NOTICE = 'The agent froze while preparing a tool call; Cinna asked it to continue.'

/** The turn's error at the default {@link ACP_TOOL_STALL_MS}. */
export const ACP_TOOL_STALL_MESSAGE = toolStallMessage(ACP_TOOL_STALL_MS)

/** The call the watchdog fired on, for the log line. */
export interface StalledToolCall {
  toolCallId: string
  kind: string | undefined
}

export interface ToolStallWatch {
  /** Anything arrived for the session (or an ask parked or settled): the clock starts again. */
  heard(): void
  /** A frame of the session's traffic, after {@link heard}; tool calls are tracked from it. */
  track(update: SessionNotification['update']): void
  /** The turn is over; nothing fires after this. */
  stop(): void
}

export interface ToolStallWatchOptions {
  /** The silence allowed; null for an engine without the watch, which then never arms a timer. */
  ms: number | null
  /** True while something else is being waited for: a parked ask, a Cinna tool call. */
  waiting(): boolean
  onStall(call: StalledToolCall): void
}

/** Input that says the call was filled in: anything but absent, null or an empty object. */
function hasInput(raw: unknown): boolean {
  if (raw === undefined || raw === null || raw === '') return false
  if (typeof raw === 'object' && !Array.isArray(raw)) return Object.keys(raw).length > 0
  return true
}

export function createToolStallWatch(options: ToolStallWatchOptions): ToolStallWatch {
  const ms = options.ms
  if (ms === null) return { heard: () => {}, track: () => {}, stop: () => {} }
  /** Open calls that have received nothing yet, with their kind. */
  const bare = new Map<string, string | undefined>()
  /** Calls that received something, or ended: never watched again. */
  const progressed = new Set<string>()
  let timer: NodeJS.Timeout | undefined
  let stopped = false

  const disarm = (): void => {
    if (timer) clearTimeout(timer)
    timer = undefined
  }
  const arm = (): void => {
    disarm()
    if (stopped || bare.size === 0) return
    timer = setTimeout(() => {
      timer = undefined
      if (stopped || bare.size === 0) return
      // An ask or a Cinna tool call is not silence; when it settles the clock
      // starts again, and this re-check covers one that settled unheard.
      if (options.waiting()) { arm(); return }
      const [toolCallId, kind] = bare.entries().next().value as [string, string | undefined]
      stopped = true
      options.onStall({ toolCallId, kind })
    }, ms)
    timer.unref?.()
  }

  return {
    heard: arm,
    track(update) {
      if (stopped) return
      if (update.sessionUpdate !== 'tool_call' && update.sessionUpdate !== 'tool_call_update') return
      const id = update.toolCallId
      if (progressed.has(id)) return
      const received = update.sessionUpdate === 'tool_call'
        ? hasInput(update.rawInput) || update.status === 'in_progress' || update.status === 'completed' || update.status === 'failed'
        // An update that carries `rawInput` at all — `{}` included — is the
        // engine completing the call's input: `claude-agent-acp` sends exactly
        // that for a tool that takes no arguments, and never `in_progress`.
        : update.rawInput !== undefined || (update.content?.length ?? 0) > 0 || update.status != null
      if (received) {
        progressed.add(id)
        bare.delete(id)
      } else if (update.sessionUpdate === 'tool_call') {
        bare.set(id, update.kind ?? undefined)
      }
      arm()
    },
    stop() {
      stopped = true
      disarm()
    }
  }
}
