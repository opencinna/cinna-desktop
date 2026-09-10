import { describe, it, expect, vi } from 'vitest'
import type { AgentRow } from '../../db/agents'
import type { ClaudeAuthStatus } from '../../../shared/engine'
import type { ClaudeDriverDeps } from './claudeDriver'
import type { FolderView } from './folderDriver'

/**
 * The `claude` driver's readiness — the two rungs it adds after the folder's:
 * is there a `claude` on this machine, and is it logged in.
 *
 * The composer refuses a send on this answer, so the direction of every error
 * matters: only a *definite* absence or logout refuses. And a check the user
 * asked for (*Check again*) must go past the caches both probes keep, or a
 * login or install the user just fixed stays refused — which is why `fresh` is
 * asserted to reach both.
 */

vi.mock('../../logger/logger', () => ({
  createLogger: () => ({ debug: () => {}, info: () => {}, warn: () => {}, error: () => {} })
}))

const { createClaudeDriver } = await import('./claudeDriver')
const { describeEngineSkip } = await import('../../../shared/runtimeMessages')

const ROW = { id: 'folder:c', name: 'Claude agent', driver: 'claude', source: 'folder' } as AgentRow

const status = (state: ClaudeAuthStatus['state']): ClaudeAuthStatus => ({
  state,
  authMethod: null,
  subscriptionType: null,
  email: null
})

function folder(over: Partial<FolderView> = {}): FolderView {
  return {
    name: 'Claude agent',
    enabled: true,
    readiness: 'ok',
    readinessReason: null,
    runtime: { engine: 'claude' },
    ...over
  }
}

function driver(over: Partial<ClaudeDriverDeps> = {}): {
  readiness: ReturnType<typeof createClaudeDriver>['readiness']
  claudePath: ReturnType<typeof vi.fn>
  claudeAuth: ReturnType<typeof vi.fn>
} {
  const claudePath = vi.fn(async () => '/usr/local/bin/claude')
  const claudeAuth = vi.fn(async () => status('logged_in'))
  const d = createClaudeDriver({
    runner: { runTurn: vi.fn() },
    readFolder: () => folder(),
    rememberGrant: () => false,
    resolveRequest: () => false,
    claudePath,
    claudeAuth,
    ...over
  })
  return {
    readiness: d.readiness.bind(d),
    claudePath: (over.claudePath as ReturnType<typeof vi.fn>) ?? claudePath,
    claudeAuth: (over.claudeAuth as ReturnType<typeof vi.fn>) ?? claudeAuth
  }
}

describe('claude driver readiness', () => {
  it('is ready when the folder is, claude is installed and logged in', async () => {
    expect(await driver().readiness('u', ROW)).toEqual({ state: 'ok', reason: null })
  })

  it('is not installed when there is no claude, and never asks the login probe', async () => {
    // Mutation: drop the path rung fails this — the login probe would be asked
    // about a binary that does not exist, and answer `unknown`, which is ready.
    const d = driver({ claudePath: vi.fn(async () => null) })
    expect(await d.readiness('u', ROW)).toEqual({
      state: 'not_installed',
      reason: describeEngineSkip('claude_not_installed')
    })
    expect(d.claudeAuth).not.toHaveBeenCalled()
  })

  it('is not logged in only on a definite logout', async () => {
    const d = driver({ claudeAuth: vi.fn(async () => status('logged_out')) })
    expect(await d.readiness('u', ROW)).toEqual({
      state: 'not_logged_in',
      reason: describeEngineSkip('claude_not_logged_in')
    })
  })

  it('never refuses on a login probe that could not answer', async () => {
    // A readiness check that refuses a working engine on its own uncertainty is
    // worse than none. Mutation: `auth.state !== 'logged_in'` fails both.
    expect(await driver({ claudeAuth: vi.fn(async () => status('unknown')) }).readiness('u', ROW)).toEqual({
      state: 'ok',
      reason: null
    })
    expect(
      await driver({ claudeAuth: vi.fn(async () => Promise.reject(new Error('timed out'))) }).readiness(
        'u',
        ROW
      )
    ).toEqual({ state: 'ok', reason: null })
  })

  it('answers the folder first, and asks nothing of the CLI when the folder is not ready', async () => {
    const d = driver({
      readFolder: () => folder({ readiness: 'credentials_needed', readinessReason: 'VENDOR_TOKEN is not set.' })
    })
    expect(await d.readiness('u', ROW)).toEqual({
      state: 'credentials_needed',
      reason: 'VENDOR_TOKEN is not set.'
    })
    expect(d.claudePath).not.toHaveBeenCalled()
    expect(d.claudeAuth).not.toHaveBeenCalled()
  })

  it('asks both probes fresh when the user asked, and from their caches otherwise', async () => {
    // Mutation: drop `options` from either call in `claudeDriver.ts` (what the
    // driver first did) fails this — Check again after `claude login` kept
    // answering "not logged in" from the probe's 30-second window.
    const d = driver()
    await d.readiness('u', ROW, { fresh: true })
    expect(d.claudePath).toHaveBeenLastCalledWith({ fresh: true })
    expect(d.claudeAuth).toHaveBeenLastCalledWith({ fresh: true })

    await d.readiness('u', ROW)
    expect(d.claudePath).toHaveBeenLastCalledWith(undefined)
    expect(d.claudeAuth).toHaveBeenLastCalledWith(undefined)
  })
})
