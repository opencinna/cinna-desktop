/**
 * What a change to how Claude signs in does to what is already running.
 * Core: no Electron. `drivers/index.ts` installs it with the production
 * services; it lives apart so the wiring can be tested without that module's
 * whole graph.
 *
 * **An auth change retires idle Claude processes.** A process froze its
 * environment — and so its key or login — at start. Switching Subscription /
 * API Token, picking another credential, or a key saved, removed or rotated by
 * an account sync moves `claudeAuthService`'s fingerprint; every idle Claude
 * process started under another one is stopped now, rather than serving the
 * next turn on the old account. One with a turn or background work running is
 * left to finish: the next acquire replaces it, because its environment (and so
 * its spec key) moved. The login probe forgets its answer too.
 *
 * **Choosing API Token cancels a `claude` login waiting on the browser.** The
 * turns no longer need it, and every surface reads the running flag from main,
 * so cancelling here is what makes them all agree. The other direction starts
 * nothing: a login is the user's to ask for.
 */
import type { ClaudeAuthMode } from '../../../../shared/claudeAuthMode'
import type { EngineLogin } from './engineLogin'

/** The settings whose change can move the fingerprint. */
export type ClaudeAuthSettingKey = 'claudeAuthMode' | 'claudeApiCredentialId' | 'localAgentsDefaultCredentialId'

export interface ClaudeAuthFollowDeps {
  /** Called after the setting was saved with a different value. Returns unsubscribe. */
  onSaved(key: ClaudeAuthSettingKey, listener: () => void): () => void
  /** Any AI credential row saved, removed or synced. Returns unsubscribe. */
  onCredentialsChanged(listener: () => void): () => void
  mode(): ClaudeAuthMode
  fingerprint(): string
  /** Drop the login probe's cached answer. */
  invalidateLoginAnswer(): void
  /** Stop idle Claude processes started under another fingerprint; returns what was stopped. */
  retireStaleAuth(current: string): string[]
  /** The in-app `claude` login. */
  login: Pick<EngineLogin, 'running' | 'cancel'>
  log(message: string, fields: Record<string, unknown>): void
}

/** Subscribe to every auth change. Returns the unsubscribe. */
export function installClaudeAuthFollowWith(deps: ClaudeAuthFollowDeps): () => void {
  // No remembered "last" fingerprint: nothing is decrypted at install, and the
  // pool compares each process with the current one, so a change that did not
  // move it stops nothing.
  const follow = (): void => {
    const current = deps.fingerprint()
    deps.invalidateLoginAnswer()
    const stopped = deps.retireStaleAuth(current)
    if (stopped.length > 0) deps.log('Claude auth changed; idle processes retired', { mode: deps.mode(), retired: stopped.length })
  }
  const modeChanged = (): void => {
    if (deps.mode() === 'api_key') {
      const phase = deps.login.running()
      if (phase !== null && deps.login.cancel()) deps.log('Claude auth set to API token; waiting login cancelled', { phase })
    }
    follow()
  }
  const off = [
    deps.onSaved('claudeAuthMode', modeChanged),
    deps.onSaved('claudeApiCredentialId', follow),
    // The Default AI credential is what an automatic pick prefers.
    deps.onSaved('localAgentsDefaultCredentialId', follow),
    deps.onCredentialsChanged(follow)
  ]
  return () => { for (const unsubscribe of off) unsubscribe() }
}
