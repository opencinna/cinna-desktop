import { describe, it, expect } from 'vitest'
import {
  isBlockedWriteError,
  isStaleWriteError,
  localAgentFailure,
  unwrapLocalAgentOutcome,
  type LocalAgentOutcome
} from '../../shared/localAgents'

/**
 * The failure **code** has to reach the renderer.
 *
 * **Two** boundaries drop non-standard error properties, which is why the first
 * attempt at this fix did not work either. `ipcMain.handle` serialises a
 * rejection as `{message, stack}`, and `contextBridge` then clones whatever
 * preload throws into the renderer's world as a fresh `Error`. `_wrap.ts`
 * attaches `code` faithfully and both crossings discard it — so for the whole
 * of Phase 3 `isStaleWriteError` answered `false` for a genuinely stale write
 * and the reload prompt it gates never fired. The banner users did see came
 * from the unrelated snapshot route, which covers the common case and hid it.
 *
 * The failure therefore travels as **data** all the way into the renderer,
 * where `useLocalAgents` turns it back into a throw that stays put.
 *
 * That is why the coded channels return the failure as a **value**. This drives
 * the two halves of that contract against each other using the **real**
 * functions each side calls — `localAgentFailure` is what `local_agent.ipc.ts`
 * builds its failure with, and `unwrapLocalAgentOutcome` is what the preload
 * bridge rebuilds the error with. Re-implementing either here would be a test
 * of a copy, which is how a broken contract passes.
 */

function withCode<T>(fn: () => T): LocalAgentOutcome<T> {
  try {
    return { ok: true, value: fn() }
  } catch (err) {
    return localAgentFailure(err as { code: string; name: string; message: string })
  }
}

const unwrap = unwrapLocalAgentOutcome

function domainError(code: string, message: string): Error & { code: string } {
  const err = new Error(message) as Error & { code: string }
  err.name = 'LocalAgentError'
  err.code = code
  return err
}

describe('a coded local-agent failure', () => {
  it('carries the code through to the caller', () => {
    let thrown: unknown = null
    try {
      unwrap(
        withCode(() => {
          throw domainError('manifest_modified', 'cinna-agent.json changed on disk.')
        })
      )
    } catch (err) {
      thrown = err
    }
    // The property the whole reload prompt hangs on.
    expect((thrown as { code?: string }).code).toBe('manifest_modified')
    expect(isStaleWriteError(thrown)).toBe(true)
  })

  it('tells a blocked write apart from a stale one', () => {
    const blocked = ((): unknown => {
      try {
        unwrap(
          withCode(() => {
            throw domainError('turn_in_progress', 'This agent is busy right now.')
          })
        )
      } catch (err) {
        return err
      }
      return null
    })()
    // Same transport, opposite handling: one keeps the text and retries, the
    // other discards it behind a reload prompt. Only the code separates them.
    expect(isBlockedWriteError(blocked)).toBe(true)
    expect(isStaleWriteError(blocked)).toBe(false)
  })

  it('keeps main’s own sentence, without the IPC wrapper around it', () => {
    let thrown: unknown = null
    try {
      unwrap(
        withCode(() => {
          throw domainError('not_found', 'That agent is no longer in your agents folder.')
        })
      )
    } catch (err) {
      thrown = err
    }
    // Not "Error invoking remote method 'local-agent:get': LocalAgentError: …",
    // which is a sentence about our IPC layer and was being shown to users.
    expect((thrown as Error).message).toBe('That agent is no longer in your agents folder.')
    expect((thrown as Error).message).not.toContain('invoking remote method')
  })

  it('passes a success straight through', () => {
    expect(unwrap(withCode(() => ({ id: 'folder:a' })))).toEqual({ id: 'folder:a' })
  })
})
