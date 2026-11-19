/**
 * Antigravity's own transcript, read for the provider errors it never sends:
 * the file IO and the per-turn watch. What a line means, the redaction and the
 * note's words are the shared half (`src/shared/antigravityProviderErrors.ts`),
 * which cinna-vaultd's `engine.providerErrors` parses with too.
 *
 * A host Antigravity turn reads its transcript here
 * (`<home>/antigravity-acp/brain/<ACP sessionId>/.system_generated/logs/
 * transcript_full.jsonl`); a vault Antigravity turn asks vaultd, which reads
 * the guest's as the agent user ({@link vaultProviderErrorReader}).
 */

import { open } from 'node:fs/promises'
import { join } from 'node:path'
import type { AcpConnection } from './types'
import {
  ANTIGRAVITY_SERVER_LOG_TAIL_BYTES,
  antigravityTranscriptSegments,
  checkedVaultProviderErrors,
  parseProviderErrors,
  plainAntigravitySessionId,
  providerErrorKey,
  type AntigravityProviderError
} from '../../../../shared/antigravityProviderErrors'

export {
  ANTIGRAVITY_PROVIDER_ERROR_MAX_CHARS,
  ANTIGRAVITY_PROVIDER_ERROR_SHOWN_CHARS,
  ANTIGRAVITY_SERVER_LOG_TAIL_BYTES,
  classifyProviderError,
  cleanProviderErrorMessage,
  parseProviderErrors,
  providerErrorKey,
  providerErrorNotice,
  type AntigravityProviderError,
  type ProviderErrorKind
} from '../../../../shared/antigravityProviderErrors'

/**
 * Reads the provider errors of the session's current turn: those after the
 * transcript's last USER_INPUT step, or (no USER_INPUT in the tail) those
 * logged from `since` (epoch ms) on. Never throws. Null: this reader cannot
 * answer for this connection at all (a vault guest without
 * `engine.providerErrors`), so the watch stops polling.
 */
export type AntigravityServerLogReader = (home: string, sessionId: string, since: number) => Promise<AntigravityProviderError[] | null>

/** The transcript of `sessionId` under the Antigravity `home`, or null for an id that is not a plain id. */
export function antigravityTranscriptPath(home: string, sessionId: string): string | null {
  if (!plainAntigravitySessionId(sessionId)) return null
  return join(home, ...antigravityTranscriptSegments(sessionId))
}

/** The last `maxBytes` of a file as text, a cut first line dropped; null when it cannot be read. */
async function readTail(path: string, maxBytes: number): Promise<string | null> {
  let handle: import('node:fs/promises').FileHandle | undefined
  try {
    handle = await open(path, 'r')
    const { size } = await handle.stat()
    const length = Math.min(size, maxBytes)
    const start = size - length
    const buffer = Buffer.alloc(length)
    let read = 0
    while (read < length) {
      const { bytesRead } = await handle.read(buffer, read, length - read, start + read)
      if (bytesRead === 0) break
      read += bytesRead
    }
    const text = buffer.subarray(0, read).toString('utf8')
    if (start === 0) return text
    const firstBreak = text.indexOf('\n')
    return firstBreak === -1 ? '' : text.slice(firstBreak + 1)
  } catch {
    return null
  } finally {
    await handle?.close().catch(() => {})
  }
}

/** The real reader: the transcript's tail, parsed. A missing file, a bad id or a partial line is no error. */
export const readAntigravityProviderErrors = async (home: string, sessionId: string, since: number): Promise<AntigravityProviderError[]> => {
  const path = antigravityTranscriptPath(home, sessionId)
  if (!path) return []
  const text = await readTail(path, ANTIGRAVITY_SERVER_LOG_TAIL_BYTES)
  return text ? parseProviderErrors(text, since) : []
}

/**
 * The reader of a **vault** Antigravity turn: vaultd's `engine.providerErrors`
 * for the connection's engine stream (`vaultAcpConnection.ts`), its answer
 * checked and redacted again here. `home` is unused: the guest knows its own.
 * Null when the connection cannot ask (an older guest, or no vault stream):
 * the watch then stops and the generic silent-turn note stays.
 */
export function vaultProviderErrorReader(connection: () => Pick<AcpConnection, 'providerErrors'> | undefined): AntigravityServerLogReader {
  return async (_home, sessionId, since) => {
    const ask = connection()?.providerErrors
    if (!ask) return null
    const answer = await ask(sessionId, since)
    return answer === null ? null : checkedVaultProviderErrors(answer)
  }
}

/** How often a silent Antigravity turn's transcript is read. */
export const ANTIGRAVITY_SERVER_LOG_POLL_MS = 5_000

export interface ProviderErrorWatch {
  /** The turn's first prompt is on the wire: polling starts. Only the first call counts. */
  start(): void
  /** Anything arrived for the session: the watch is over. */
  heard(): void
  /** The turn is over, or is being stopped; nothing is reported after this. */
  stop(): void
}

export interface ProviderErrorWatchOptions {
  pollMs: number
  read: AntigravityServerLogReader
  home: string
  /** The session prompted, read at each poll. */
  sessionId(): string | null
  /** A new provider error (once per distinct code and message), while the watch is on. */
  onError(error: AntigravityProviderError): void
  /** A later step repeating an error already reported (a server retry). */
  onRepeat?(error: AntigravityProviderError): void
  now?: () => number
}

/**
 * Polls the transcript from the first prompt until anything is heard or the
 * turn ends, or the reader answers null (it cannot read for this connection).
 * A failed read is a quiet poll; one poll at a time; timers never keep the
 * process alive.
 */
export function createProviderErrorWatch(options: ProviderErrorWatchOptions): ProviderErrorWatch {
  let state: 'idle' | 'watching' | 'done' = 'idle'
  let timer: NodeJS.Timeout | undefined
  let polling = false
  let since = 0
  const seenSteps = new Set<number>()
  const seenErrors = new Set<string>()
  const finish = (): void => {
    state = 'done'
    if (timer) clearInterval(timer)
    timer = undefined
  }
  const poll = async (): Promise<void> => {
    if (state !== 'watching' || polling) return
    const sessionId = options.sessionId()
    if (!sessionId) return
    polling = true
    try {
      const errors = await options.read(options.home, sessionId, since)
      // The reader cannot answer for this connection: nothing to poll for.
      if (errors === null) {
        finish()
        return
      }
      for (const error of errors) {
        if (state !== 'watching') return
        if (seenSteps.has(error.stepIndex)) continue
        seenSteps.add(error.stepIndex)
        const key = providerErrorKey(error)
        if (seenErrors.has(key)) {
          options.onRepeat?.(error)
          continue
        }
        seenErrors.add(key)
        options.onError(error)
      }
    } catch {
      // A read that failed is a poll that found nothing.
    } finally {
      polling = false
    }
  }
  return {
    start() {
      if (state !== 'idle') return
      state = 'watching'
      since = (options.now ?? Date.now)()
      timer = setInterval(() => void poll(), options.pollMs)
      timer.unref?.()
    },
    heard() {
      if (state === 'watching') finish()
    },
    stop: finish
  }
}
