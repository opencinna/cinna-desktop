import { describe, expect, it } from 'vitest'
import { ToolchainError } from '../errors'
import { fromCliOutcome, fromToolchainError, hostDirName, TASK_ORDER } from './localDevService'
import type { CliRunOutcome } from './cliRunner'

/**
 * The reconciler itself needs a database, a window and a Cinna server, so what
 * is tested here is the part that is a *contract* rather than a sequence: how a
 * toolchain code and a cinna-cli exit code become the thing the user is told.
 *
 * That mapping is worth pinning precisely because it is the one place where a
 * plausible-looking simplification does real damage — "any failure is a network
 * failure" produces a Try Again button for a condition no amount of trying
 * fixes, and "any failure is a toolchain failure" sends someone hunting through
 * Settings for a broken install when their wifi dropped.
 */
function outcome(patch: Partial<CliRunOutcome>): CliRunOutcome {
  return { exitCode: 0, result: null, stderr: '', stdout: '', timedOut: false, ...patch }
}

describe('hostDirName', () => {
  it('leaves an ordinary host alone', () => {
    expect(hostDirName('cinna.acme.com')).toBe('cinna.acme.com')
  })

  it('replaces the port separator, which is not legal in a path segment', () => {
    expect(hostDirName('localhost:8000')).toBe('localhost_8000')
  })
})

describe('fromToolchainError', () => {
  it('calls a failed download what it is — the network', () => {
    const state = fromToolchainError(new ToolchainError('download_failed', 'no route', 'uv'))
    expect(state).toEqual({ phase: 'attention', reason: 'network', detail: 'no route' })
  })

  it.each([
    'unsupported_platform',
    'unknown_mutagen_version',
    'checksum_mismatch',
    'extract_failed',
    'install_failed'
  ] as const)('reports %s as a toolchain problem, not a network one', (code) => {
    // Retrying fixes none of these, and the Settings copy for `toolchain` is
    // the only one that mentions updating the app — which is the actual answer
    // for `unknown_mutagen_version`.
    const state = fromToolchainError(new ToolchainError(code, 'nope', 'mutagen'))
    expect(state).toMatchObject({ phase: 'attention', reason: 'toolchain' })
  })
})

describe('fromCliOutcome', () => {
  it('maps exit 12 to the network', () => {
    expect(fromCliOutcome(outcome({ exitCode: 12 }), 'Setup')).toMatchObject({
      phase: 'attention',
      reason: 'network'
    })
  })

  it('maps a rejected setup token to token_expired, which Repair re-mints', () => {
    expect(fromCliOutcome(outcome({ exitCode: 10 }), 'Setup')).toMatchObject({
      phase: 'attention',
      reason: 'token_expired'
    })
  })

  it('maps an account mismatch to the workspace, because no retry fixes it', () => {
    const state = fromCliOutcome(outcome({ exitCode: 11 }), 'Setup')
    expect(state).toMatchObject({ phase: 'attention', reason: 'workspace' })
    expect(state.phase === 'attention' && state.detail).toContain('different Cinna account')
  })

  it('falls back to the workspace for an unclassified failure', () => {
    expect(fromCliOutcome(outcome({ exitCode: 1 }), 'Setup')).toMatchObject({
      phase: 'attention',
      reason: 'workspace'
    })
  })

  it('prefers cinna-cli’s own detail over our generic sentence', () => {
    const state = fromCliOutcome(
      outcome({ exitCode: 10, result: { result: 'error', code: 'setup_token', detail: 'token expired' } }),
      'Setup'
    )
    expect(state.phase === 'attention' && state.detail).toBe('token expired')
  })

  it('calls a timeout a network problem regardless of the exit code', () => {
    // A killed process has no exit code to classify, and the honest reading of
    // "it never finished" is that something upstream was not answering.
    expect(fromCliOutcome(outcome({ exitCode: null, timedOut: true }), 'Setup')).toMatchObject({
      phase: 'attention',
      reason: 'network'
    })
  })
})

describe('the checklist', () => {
  /**
   * Only the ordering rule is testable without a database and a server: that
   * reaching a step implies the ones before it finished. It is worth pinning
   * because the alternative — an explicit completion call per step — is exactly
   * the thing a later edit forgets, leaving a checklist that shows work as
   * pending after it demonstrably happened.
   */
  it('has one row per real step, in the order the reconciler does them', () => {
    expect(TASK_ORDER).toEqual([
      'uv',
      'mutagen',
      'cinna-cli',
      'engine',
      'workspace',
      'token'
    ])
  })
})
