/**
 * **Runtime setup** — what picking a runtime card asks for: the pinned binary on
 * disk, then a signed-in engine.
 *
 * `setup(engine, { install })` is the whole chain, owned here in main so it
 * finishes when the screen that started it is left, and so every surface that
 * mounts mid-run sees the same run:
 *
 * 1. Not on disk (`peek` finds nothing, or the last install failed) and
 *    `install` false → `needs_install`, **nothing downloaded**. Clicking through
 *    the cards must never start a 100–300 MB download; only the card's Install
 *    chip passes `install: true`.
 * 2. `installing` — ensure the binary. Progress reaches the renderer over each
 *    binary's own push channel, as it always did.
 * 3. `checking` — drop the login probe's cached answer and ask again.
 * 4. `signing_in` — **only on a definite `logged_out`**. An `unknown` probe is
 *    not a reason to open a browser on the user, so it ends `auth_unknown`.
 *
 * That the chain runs at all is the gesture: the renderer calls it only after
 * the user picked a card, pressed a chip, or picked an engine on an agent page —
 * never on a visit. Every outcome is data; a second call for the same engine
 * joins the one running. `cancel` stops the login (if one runs) and ends the run.
 */

import { publishEvent } from '../../host/events'
import { createLogger } from '../../logger/logger'
import { antigravityAuthProbe, claudeAuthProbe, codexAuthProbe, engineLogins } from '../../agents/drivers'
import { antigravityBinaryService, claudeBinaryService, codexBinaryService } from '../../engine/engineBinaryService'
import { ManagedAssetError } from '../../managed/managedAsset'
import { CLAUDE_NOT_INSTALLED } from '../../agents/drivers/acp/acpLaunchers'
import { CODEX_NOT_INSTALLED } from '../../agents/drivers/acp/codexLauncher'
import { ANTIGRAVITY_NOT_INSTALLED } from '../../agents/drivers/acp/antigravityEnv'
import {
  RUNTIME_SETUP_CHANNEL,
  isEngineLoginId,
  type EngineBinaryState,
  type EngineLoginId,
  type EngineLoginResult,
  type RuntimeSetupEvent,
  type RuntimeSetupPhase,
  type RuntimeSetupResult,
  type RuntimeSetupRunning
} from '../../../shared/engine'

const logger = createLogger('runtime-setup')

export interface RuntimeSetupDeps {
  /** The binary's state after a look that never downloads. */
  peek(engine: EngineLoginId): Promise<EngineBinaryState>
  /** Ensure the binary (downloading when needed); throws with a user-facing sentence. */
  ensure(engine: EngineLoginId): Promise<void>
  /** Drop the cached login answer and ask again. */
  refreshAuth(engine: EngineLoginId): Promise<{ state: string }>
  /** The engine's in-app login; never rejects, joins one already running. */
  login(engine: EngineLoginId): Promise<EngineLoginResult>
  /** Stop that login; false when none ran. */
  cancelLogin(engine: EngineLoginId): boolean
  /** Phase changes and run ends, for the renderer. */
  publish(event: RuntimeSetupEvent): void
}

export interface RuntimeSetupOptions {
  /** Download the binary when it is not on disk. Only an explicit Install passes it. */
  install?: boolean
  /**
   * `force`: the user pressed Log in, so log in unless the probe says
   * `logged_in` — an `unknown` answer is not a reason to do nothing visible.
   * Default `auto`: log in only on a definite `logged_out`.
   */
  login?: 'auto' | 'force'
}

export interface RuntimeSetup {
  setup(engine: unknown, options?: RuntimeSetupOptions): Promise<RuntimeSetupResult>
  running(): RuntimeSetupRunning
  cancel(engine: unknown): boolean
}

interface Entry {
  phase: RuntimeSetupPhase
  cancelled: boolean
  /** OR-ed in by every caller that joins: a later Install must not be dropped. */
  install: boolean
  forceLogin: boolean
  done: Promise<RuntimeSetupResult>
}

const ENGINES: readonly EngineLoginId[] = ['claude', 'codex', 'antigravity']

export function createRuntimeSetup(deps: RuntimeSetupDeps): RuntimeSetup {
  const entries = new Map<EngineLoginId, Entry>()

  const running = (): RuntimeSetupRunning => {
    const out = { claude: null, codex: null, antigravity: null } as RuntimeSetupRunning
    for (const engine of ENGINES) out[engine] = entries.get(engine)?.phase ?? null
    return out
  }

  const publish = (ended?: RuntimeSetupEvent['ended']): void => {
    try {
      deps.publish(ended ? { running: running(), ended } : { running: running() })
    } catch (err) {
      logger.warn('could not publish a runtime setup event', { error: String(err) })
    }
  }

  async function run(engine: EngineLoginId, entry: Entry): Promise<RuntimeSetupResult> {
    const setPhase = (phase: RuntimeSetupPhase): void => {
      entry.phase = phase
      publish()
    }

    const binary = await deps.peek(engine)
    // `resolving` is a download someone else already started: waiting for it
    // starts nothing new, so it does not need the user's Install.
    // Read after the look: a caller that joined meanwhile may have asked to install.
    if (!entry.install && binary.state !== 'ready' && binary.state !== 'resolving') {
      return { outcome: 'needs_install' }
    }

    setPhase('installing')
    try {
      await deps.ensure(engine)
    } catch (err) {
      return { outcome: 'install_failed', reason: err instanceof Error ? err.message : String(err) }
    }
    if (entry.cancelled) return { outcome: 'cancelled' }

    setPhase('checking')
    let state = 'unknown'
    try {
      state = (await deps.refreshAuth(engine)).state
    } catch (err) {
      logger.warn('login probe failed during runtime setup', {
        engine,
        error: err instanceof Error ? err.message : String(err)
      })
    }
    if (entry.cancelled) return { outcome: 'cancelled' }
    if (state === 'logged_in') return { outcome: 'ready' }
    // Only a definite "signed out" opens a browser. A probe that could not
    // answer is not one, and a login nobody needed is a tab the user must close.
    // The user's own Log in is the exception: they asked for the login.
    if (state !== 'logged_out' && !entry.forceLogin) return { outcome: 'auth_unknown' }

    setPhase('signing_in')
    const login = await deps.login(engine)
    if (login.outcome === 'logged_in') return { outcome: 'ready' }
    if (login.outcome === 'cancelled') return { outcome: 'cancelled' }
    return { outcome: 'login_failed', login }
  }

  return {
    setup(engine, options = {}) {
      if (!isEngineLoginId(engine)) return Promise.resolve({ outcome: 'install_failed', reason: 'Unknown runtime.' })
      const install = options.install === true
      const forceLogin = options.login === 'force'
      const existing = entries.get(engine)
      if (existing) {
        existing.install ||= install
        existing.forceLogin ||= forceLogin
        return existing.done
      }
      // `checking` until the first real phase: a surface asking meanwhile sees
      // a run, not nothing, and the peek is a stat away from either answer.
      const entry: Entry = { phase: 'checking', cancelled: false, install, forceLogin, done: Promise.resolve({ outcome: 'cancelled' }) }
      entries.set(engine, entry)
      entry.done = run(engine, entry)
        .catch((err: unknown): RuntimeSetupResult => ({
          outcome: 'install_failed',
          reason: err instanceof Error ? err.message : String(err)
        }))
        .then((result) => {
          if (entries.get(engine) === entry) entries.delete(engine)
          logger.info('runtime setup finished', { engine, install: entry.install, outcome: result.outcome })
          publish({ engine, result })
          return result
        })
      return entry.done
    },

    running,

    cancel(engine) {
      if (!isEngineLoginId(engine)) return false
      const entry = entries.get(engine)
      if (entry) entry.cancelled = true
      const stoppedLogin = deps.cancelLogin(engine)
      return stoppedLogin || entry !== undefined
    }
  }
}

const BINARY: Record<EngineLoginId, { service: typeof claudeBinaryService; notInstalled: string }> = {
  claude: { service: claudeBinaryService, notInstalled: CLAUDE_NOT_INSTALLED },
  codex: { service: codexBinaryService, notInstalled: CODEX_NOT_INSTALLED },
  antigravity: { service: antigravityBinaryService, notInstalled: ANTIGRAVITY_NOT_INSTALLED }
}

const AUTH_PROBE: Record<EngineLoginId, typeof claudeAuthProbe | typeof codexAuthProbe | typeof antigravityAuthProbe> = {
  claude: claudeAuthProbe,
  codex: codexAuthProbe,
  antigravity: antigravityAuthProbe
}

/** The production wiring: the pinned binaries, probes and logins every runtime surface shares. */
export const runtimeSetupService: RuntimeSetup = createRuntimeSetup({
  peek: (engine) => BINARY[engine].service.peek(),
  ensure: async (engine) => {
    try {
      await BINARY[engine].service.ensure()
    } catch (err) {
      // The resolver's own sentence (a download refused, a configured path that
      // is not a binary) is what the binary's status line already shows.
      throw new Error(err instanceof ManagedAssetError || err instanceof Error ? err.message : BINARY[engine].notInstalled)
    }
  },
  refreshAuth: (engine) => {
    const probe = AUTH_PROBE[engine]
    probe.invalidate()
    return probe.refresh()
  },
  login: (engine) => engineLogins[engine].start(),
  cancelLogin: (engine) => engineLogins[engine].cancel(),
  publish: (event) => publishEvent(RUNTIME_SETUP_CHANNEL, event)
})
