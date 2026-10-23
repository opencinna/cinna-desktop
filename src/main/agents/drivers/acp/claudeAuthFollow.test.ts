import { describe, expect, it, vi } from 'vitest'
import { installClaudeAuthFollowWith, type ClaudeAuthFollowDeps, type ClaudeAuthSettingKey } from './claudeAuthFollow'
import type { ClaudeAuthMode } from '../../../../shared/claudeAuthMode'
import type { EngineLoginPhase } from '../../../../shared/engine'

/**
 * What a change to how Claude signs in does to running things: retire idle
 * processes on another fingerprint, forget the login answer, and — choosing API
 * Token — cancel a `claude` login still waiting on the browser, which the turns
 * no longer need.
 */
function harness(initial: { mode: ClaudeAuthMode; login: EngineLoginPhase | null }) {
  const saved = new Map<ClaudeAuthSettingKey, Set<() => void>>()
  const credentialListeners = new Set<() => void>()
  const state = { mode: initial.mode, login: initial.login, fingerprint: 'subscription' }
  const cancel = vi.fn(() => {
    if (state.login === null) return false
    // Like `EngineLogin`: a child that was spawned stays `waiting` until it exits.
    return true
  })
  const deps: ClaudeAuthFollowDeps = {
    onSaved: (key, listener) => {
      const set = saved.get(key) ?? new Set()
      saved.set(key, set)
      set.add(listener)
      return () => set.delete(listener)
    },
    onCredentialsChanged: (listener) => {
      credentialListeners.add(listener)
      return () => credentialListeners.delete(listener)
    },
    mode: () => state.mode,
    fingerprint: () => state.fingerprint,
    invalidateLoginAnswer: vi.fn(),
    retireStaleAuth: vi.fn(() => ['claude:a']),
    login: { running: () => state.login, cancel },
    log: vi.fn()
  }
  const save = (key: ClaudeAuthSettingKey): void => { for (const listener of saved.get(key) ?? []) listener() }
  const changeCredentials = (): void => { for (const listener of credentialListeners) listener() }
  return { deps, state, cancel, save, changeCredentials, saved }
}

describe('installClaudeAuthFollowWith', () => {
  it('cancels a waiting claude login when the mode switches to API Token', () => {
    const h = harness({ mode: 'subscription', login: 'waiting' })
    installClaudeAuthFollowWith(h.deps)
    h.state.mode = 'api_key'
    h.state.fingerprint = 'api_key:abc'
    h.save('claudeAuthMode')
    expect(h.cancel).toHaveBeenCalledTimes(1)
    // The rest of the follow still runs on the same change.
    expect(h.deps.invalidateLoginAnswer).toHaveBeenCalledTimes(1)
    expect(h.deps.retireStaleAuth).toHaveBeenCalledWith('api_key:abc')
  })

  it('cancels a login still preparing (its binary downloading) as well', () => {
    const h = harness({ mode: 'subscription', login: 'preparing' })
    installClaudeAuthFollowWith(h.deps)
    h.state.mode = 'api_key'
    h.save('claudeAuthMode')
    expect(h.cancel).toHaveBeenCalledTimes(1)
  })

  it('cancels nothing when no login is running', () => {
    const h = harness({ mode: 'subscription', login: null })
    installClaudeAuthFollowWith(h.deps)
    h.state.mode = 'api_key'
    h.save('claudeAuthMode')
    expect(h.cancel).not.toHaveBeenCalled()
    expect(h.deps.retireStaleAuth).toHaveBeenCalledTimes(1)
  })

  it('leaves a login alone when the mode switches back to Subscription', () => {
    const h = harness({ mode: 'api_key', login: 'waiting' })
    installClaudeAuthFollowWith(h.deps)
    h.state.mode = 'subscription'
    h.save('claudeAuthMode')
    expect(h.cancel).not.toHaveBeenCalled()
    expect(h.deps.invalidateLoginAnswer).toHaveBeenCalledTimes(1)
  })

  it('a credential change in API mode retires processes but cancels no login', () => {
    // A login started while already in API mode is the user's own choice; only the switch cancels.
    const h = harness({ mode: 'api_key', login: 'waiting' })
    installClaudeAuthFollowWith(h.deps)
    h.save('claudeApiCredentialId')
    h.save('localAgentsDefaultCredentialId')
    h.changeCredentials()
    expect(h.cancel).not.toHaveBeenCalled()
    expect(h.deps.retireStaleAuth).toHaveBeenCalledTimes(3)
    expect(h.deps.invalidateLoginAnswer).toHaveBeenCalledTimes(3)
  })

  it('unsubscribes every listener', () => {
    const h = harness({ mode: 'subscription', login: 'waiting' })
    const off = installClaudeAuthFollowWith(h.deps)
    off()
    h.state.mode = 'api_key'
    h.save('claudeAuthMode')
    h.changeCredentials()
    expect(h.cancel).not.toHaveBeenCalled()
    expect(h.deps.retireStaleAuth).not.toHaveBeenCalled()
  })
})
