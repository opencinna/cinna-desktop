/**
 * The "no reply yet" notice: a prompted turn whose engine has said nothing at all.
 *
 * Antigravity's server, with `generativelanguage.googleapis.com` unreachable,
 * sends no `session/update` and never answers `session/prompt`: it retries
 * internally every forty seconds or so, for as long as the turn lasts. The user
 * watched a spinner with nothing under it until the ceiling. The stall watch
 * (`acpToolStall.ts`) does not cover it — there is no open tool call — and the
 * ceiling is long on purpose.
 *
 * So one shape of silence gets a word in the transcript: **from the moment the
 * turn's first `session/prompt` is sent, nothing at all heard for the session**
 * — no `session/update` of any kind (a chunk, a thought, a tool call, a plan, a
 * usage, mode, config or commands update), no extension notification naming
 * it, no permission or question ask — for {@link ACP_SILENT_TURN_NOTICE_MS}.
 * Then the turn gets one notice ({@link silentTurnNotice}) and nothing else.
 *
 * What it leaves alone, on purpose:
 * - **the turn itself**: it is never stopped or failed here. A model may think
 *   for minutes in silence, and the engine may yet reach its provider; Stop
 *   and the ceiling are what end a turn;
 * - **silence after anything was heard**: the engine is talking, and a quiet
 *   stretch mid-turn is a thinking model or a long tool. The watch is over for
 *   the turn at the first thing heard — a parked ask included, since that wait
 *   is for the user;
 * - **follow-up turns**, and the prompts a prompted turn sends after its first
 *   (the stall retry, a continuation after a refusal): only the turn's first
 *   response is watched.
 *
 * It fires at most once, and never after {@link SilentTurnWatch.stop}, which
 * every exit of the turn calls, as well as a Stop or the ceiling asking the
 * agent to stop.
 */

import type { AcpLauncherId } from './types'
import type { VaultEngine } from '../../../../shared/vault/protocol'
import { RUNTIME_MODE_NAMES } from '../../../../shared/chatModeRuntime'

/** How long a prompted turn may go with nothing at all from its engine before the transcript says so. */
export const ACP_SILENT_TURN_NOTICE_MS = 90 * 1000

/** "90 seconds", "2 minutes": whole minutes only when the span is whole minutes. */
function span(ms: number): string {
  if (ms >= 60_000 && ms % 60_000 === 0) {
    const minutes = ms / 60_000
    return `${minutes} minute${minutes === 1 ? '' : 's'}`
  }
  const seconds = Math.max(1, Math.round(ms / 1000))
  return `${seconds} second${seconds === 1 ? '' : 's'}`
}

/** The transcript's notice, naming the engine (see {@link silentTurnEngineName}). */
export function silentTurnNotice(engine: string, ms = ACP_SILENT_TURN_NOTICE_MS): string {
  return `No reply from ${engine} after ${span(ms)}. It may not be reaching its provider.`
}

/**
 * The user-facing name of the engine a turn runs on: a vault agent's engine,
 * else the launcher's runtime name, and for a custom ACP agent its own name.
 */
export function silentTurnEngineName(launcherId: AcpLauncherId, vaultEngine: VaultEngine | undefined, customName: string | null | undefined): string {
  if (vaultEngine) return RUNTIME_MODE_NAMES[vaultEngine]
  switch (launcherId) {
    case 'claude':
    case 'codex':
    case 'antigravity':
    case 'opencode':
      return RUNTIME_MODE_NAMES[launcherId]
    case 'gemini':
      return 'Gemini'
    default:
      return customName?.trim() || 'the agent'
  }
}

export interface SilentTurnWatch {
  /** The turn's first prompt is on the wire: the clock starts. Only the first call counts. */
  start(): void
  /** Anything arrived for the session, or an ask parked: the watch is over. Ignored before {@link start}. */
  heard(): void
  /** The turn is over, or is being stopped; nothing fires after this. */
  stop(): void
}

export interface SilentTurnWatchOptions {
  /** The silence before the notice. */
  ms: number
  /** Called at most once, when nothing was heard for `ms` after {@link SilentTurnWatch.start}. */
  onSilent(): void
}

export function createSilentTurnWatch(options: SilentTurnWatchOptions): SilentTurnWatch {
  let state: 'idle' | 'watching' | 'done' = 'idle'
  let timer: NodeJS.Timeout | undefined
  const finish = (): void => {
    state = 'done'
    if (timer) clearTimeout(timer)
    timer = undefined
  }
  return {
    start() {
      if (state !== 'idle') return
      state = 'watching'
      timer = setTimeout(() => {
        timer = undefined
        if (state !== 'watching') return
        state = 'done'
        options.onSilent()
      }, options.ms)
      timer.unref?.()
    },
    heard() {
      if (state === 'watching') finish()
    },
    stop: finish
  }
}
