import { describe, expect, it } from 'vitest'
import { unwrapIpcError } from './ipcError'

/**
 * The two regexes in `unwrapIpcError` now stand between six call sites and the
 * user, and until this file they had no test of their own — they were exercised
 * only through whichever component happened to import them.
 *
 * Both directions matter equally and the tests are grouped that way. Failing to
 * strip leaves `Error invoking remote method '<channel>': <Class>Error:` in
 * front of a sentence written for a human. Stripping too eagerly silently
 * truncates a real message, and nothing downstream can tell — the caller gets a
 * string either way, so an over-wide regex would ship looking like a fix.
 */

const WIRE = "Error invoking remote method 'job:execute': JobError: "

describe('unwrapIpcError strips the transport', () => {
  it('removes the remote-method prefix and the error class together', () => {
    expect(unwrapIpcError(new Error(WIRE + 'The workshop is not on this device.'))).toBe(
      'The workshop is not on this device.'
    )
  })

  it('removes the remote-method prefix on its own', () => {
    // A non-DomainError throw: `_wrap.ts` only sets `outbound.name` for a
    // DomainError, so a plain `Error` arrives with the prefix and no class.
    expect(
      unwrapIpcError(new Error("Error invoking remote method 'auth:get-startup': boom"))
    ).toBe('boom')
  })

  it('removes a leading error class on its own', () => {
    expect(unwrapIpcError(new Error('LocalAgentError: That agent is not indexed.'))).toBe(
      'That agent is not indexed.'
    )
  })

  it('accepts a bare string as well as an Error', () => {
    expect(unwrapIpcError(WIRE + 'Nope.')).toBe('Nope.')
  })

  it('is idempotent, so unwrapping an already-unwrapped message is safe', () => {
    const once = unwrapIpcError(new Error(WIRE + 'Only one agent is missing.'))
    expect(unwrapIpcError(once)).toBe(once)
  })
})

describe('unwrapIpcError strips nothing else', () => {
  it('leaves a message that never crossed IPC exactly as it is', () => {
    const clean = 'This job needs an agent that is not available on this device.'
    expect(unwrapIpcError(new Error(clean))).toBe(clean)
  })

  it('keeps a capitalised first word that is not an error class', () => {
    // The agent's own name leads several of our messages.
    expect(unwrapIpcError(new Error('Invoice Checker is not available here.'))).toBe(
      'Invoice Checker is not available here.'
    )
  })

  it('keeps a capitalised first word even when a colon follows it', () => {
    /*
      This is the case that pins the `Error` in `^[A-Z][A-Za-z]*Error:\s*`.
      Widening that pattern to `^[A-Z][A-Za-z]*:\s*` is the plausible
      "simplification" — it still passes every other test in this file, because
      the sibling case above has no colon and so never exercises the boundary.
      It was written first, it left the mutation alive, and only the mutation
      said so.

      What it would cost: any message whose first word is a capitalised label
      loses that label silently, and the caller still gets a plausible-looking
      string, so nothing downstream can notice.
    */
    expect(unwrapIpcError(new Error('Note: the workshop folder was moved.'))).toBe(
      'Note: the workshop folder was moved.'
    )
    expect(unwrapIpcError(new Error('Invoice Checker: not available here.'))).toBe(
      'Invoice Checker: not available here.'
    )
  })

  it('is anchored — it does not edit the middle of a sentence', () => {
    const quoted =
      "The agent reported: Error invoking remote method 'x': FooError: inner failure"
    expect(unwrapIpcError(new Error(quoted))).toBe(quoted)
  })

  it('does not strip a second class name that belongs to the message', () => {
    expect(unwrapIpcError(new Error('JobError: JobError: is a literal here'))).toBe(
      'JobError: is a literal here'
    )
  })
})

describe('unwrapIpcError falls back only when there is nothing to show', () => {
  it('uses the fallback for a non-Error, non-string throw', () => {
    expect(unwrapIpcError({ nope: true }, 'Could not save the job.')).toBe(
      'Could not save the job.'
    )
  })

  it('uses the fallback when the message is empty', () => {
    expect(unwrapIpcError(new Error(''), 'The app could not start.')).toBe(
      'The app could not start.'
    )
  })

  it('uses the fallback when unwrapping consumes the whole message', () => {
    // A wrapper with nothing behind it still has to say something.
    expect(unwrapIpcError(new Error(WIRE), 'The run could not be started.')).toBe(
      'The run could not be started.'
    )
  })

  it('has a default fallback so a caller cannot render an empty alert', () => {
    expect(unwrapIpcError(undefined)).toBe('Something went wrong')
  })
})
