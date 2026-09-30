/**
 * **One click from "Claude Desktop is installed" to chats and agents running on
 * that subscription.**
 *
 * `connect(appId)` is the whole sequence, owned here in main so it finishes
 * even when the banner that started it unmounts:
 *
 * 1. `installing` — ensure the pinned CLI for the app's engine (downloads it
 *    when it is not here yet);
 * 2. `checking` — drop the login probe's cached answer and ask again. The
 *    ChatGPT app writes `~/.codex/auth.json`, which our `codex` reads, so a
 *    ChatGPT user is usually signed in already and sees no browser;
 * 3. `signing-in` — only when not logged in: the engine's own in-app login
 *    (the same one the agent panel runs; `local-tools:engine-login-cancel`
 *    stops it);
 * 4. adopt — {@link adoptDesktopEngine}.
 *
 * Every outcome is data, never a throw: a thrown error's code does not survive
 * IPC. A second call for the same app joins the one running.
 */

import { appSettingsService } from '../appSettingsService'
import { chatModeService } from '../chatModeService'
import { appSettingsRepo } from '../../db/appSettings'
import { getSettingsScopeUserId } from '../../auth/scope'
import { createLogger } from '../../logger/logger'
import { localAgentService } from './localAgentService'
import { claudeAuthProbe, codexAuthProbe, engineLogins } from '../../agents/drivers'
import { claudeBinaryService, codexBinaryService } from '../../engine/engineBinaryService'
import { ManagedAssetError } from '../../managed/managedAsset'
import { CLAUDE_NOT_INSTALLED } from '../../agents/drivers/acp/acpLaunchers'
import { CODEX_NOT_INSTALLED } from '../../agents/drivers/acp/codexLauncher'
import { DESKTOP_APP_SPECS } from './desktopAppsService'
import { loginFailureLead, type EngineLoginId, type EngineLoginResult } from '../../../shared/engine'
import {
  isDesktopAppId,
  type DesktopAppConnectPhase,
  type DesktopAppConnectResult,
  type DesktopAppConnectRunning,
  type DesktopAppId
} from '../../../shared/desktopApps'

const logger = createLogger('desktop-app-connect')

/** The mode a desktop app's engine gets when one has to be created. Colours as onboarding's providers. */
const ENGINE_MODE: Record<EngineLoginId, { name: string; colorPreset: string }> = {
  claude: { name: 'Claude', colorPreset: 'amber' },
  codex: { name: 'Codex', colorPreset: 'emerald' }
}

/**
 * Make `engine` what chats and agents run on.
 *
 * **The Default runtime** is written through `appSettingsService.set` — the same
 * validated write the Settings picker's `settings:set` makes — followed by the
 * same re-index: `driver_config.launcher` caches the answer per agent row.
 *
 * **Chat modes**, because a chat runs on its mode's engine before the Default
 * runtime: when the effective default mode names a *different* engine
 * explicitly (onboarding's API-key "Default" mode is `opencode`), a local mode
 * on this engine with no credential becomes the default — an existing one if
 * there is one, else a new "Claude" / "Codex". A default that names no engine
 * already inherits the Default runtime, and no default at all does too, so
 * both are left alone. An account default that wins because account defaults
 * are prioritized is the account's decision and is left alone as well.
 */
export function adoptDesktopEngine(engine: EngineLoginId): void {
  appSettingsService.set('localAgentsDefaultEngine', engine)
  const userId = getSettingsScopeUserId()
  try {
    localAgentService.rescan(userId)
  } catch (err) {
    // As `settings:set`: the setting is stored either way; the next rescan picks the rows up.
    logger.warn('could not re-index agents after adopting a desktop app', {
      error: err instanceof Error ? err.message : String(err)
    })
  }

  const current = chatModeService.resolveEffectiveDefault()
  if (!current || current.engine == null || current.engine === engine) return
  if (current.managed && appSettingsRepo.get('prioritizeAccountDefaults')) {
    logger.info('an account default chat mode wins; leaving it', { modeId: current.id })
    return
  }

  const reusable = chatModeService
    .list(userId)
    .find((mode) => !mode.managed && mode.engine === engine && !mode.providerId)
  if (reusable) {
    // `update` resets any field it is not given, so the row is passed back whole.
    chatModeService.upsert(userId, {
      id: reusable.id,
      name: reusable.name,
      providerId: null,
      modelId: reusable.modelId,
      engine,
      systemPrompt: reusable.systemPrompt,
      toolPolicy: reusable.toolPolicy,
      mcpProviderIds: reusable.mcpProviderIds ?? [],
      colorPreset: reusable.colorPreset,
      isDefault: true
    })
    logger.info('made an existing chat mode the default', { modeId: reusable.id, engine })
    return
  }
  const { id } = chatModeService.upsert(userId, {
    name: ENGINE_MODE[engine].name,
    engine,
    providerId: null,
    colorPreset: ENGINE_MODE[engine].colorPreset,
    isDefault: true
  })
  logger.info('created a default chat mode for a desktop app', { modeId: id, engine })
}

export interface DesktopAppConnectDeps {
  /** Ensure the pinned CLI; throws with a user-facing message on failure. */
  ensureBinary(engine: EngineLoginId): Promise<void>
  /** Drop the cached login answer and ask again. */
  refreshAuth(engine: EngineLoginId): Promise<{ state: string }>
  /** The engine's in-app login; never rejects. */
  login(engine: EngineLoginId): Promise<EngineLoginResult>
  adopt(engine: EngineLoginId): void | Promise<void>
}

export interface DesktopAppConnect {
  connect(appId: unknown): Promise<DesktopAppConnectResult>
  running(): DesktopAppConnectRunning | null
}

interface ConnectEntry {
  appId: DesktopAppId
  phase: DesktopAppConnectPhase
  done: Promise<DesktopAppConnectResult>
}

export function createDesktopAppConnect(deps: DesktopAppConnectDeps): DesktopAppConnect {
  let current: ConnectEntry | null = null

  async function run(appId: DesktopAppId, engine: EngineLoginId, setPhase: (phase: DesktopAppConnectPhase) => void): Promise<DesktopAppConnectResult> {
    setPhase('installing')
    try {
      await deps.ensureBinary(engine)
    } catch (err) {
      return { outcome: 'failed', reason: err instanceof Error ? err.message : String(err) }
    }

    setPhase('checking')
    let state = 'unknown'
    try {
      state = (await deps.refreshAuth(engine)).state
    } catch (err) {
      // An unanswered probe is not a login; the sign-in below settles it.
      logger.warn('login probe failed during connect', {
        appId,
        error: err instanceof Error ? err.message : String(err)
      })
    }

    if (state !== 'logged_in') {
      setPhase('signing-in')
      const login = await deps.login(engine)
      if (login.outcome === 'cancelled') return { outcome: 'cancelled' }
      if (login.outcome !== 'logged_in') {
        return { outcome: 'failed', reason: loginFailureLead(login) ?? "Sign-in didn't finish." }
      }
    }

    try {
      await deps.adopt(engine)
    } catch (err) {
      return { outcome: 'failed', reason: err instanceof Error ? err.message : String(err) }
    }
    return { outcome: 'enabled' }
  }

  return {
    connect(appId) {
      if (!isDesktopAppId(appId)) return Promise.resolve({ outcome: 'failed', reason: 'Unknown app.' })
      if (current) {
        if (current.appId === appId) return current.done
        return Promise.resolve({ outcome: 'failed', reason: 'Another app is being set up. Try again when it finishes.' })
      }
      const spec = DESKTOP_APP_SPECS.find((candidate) => candidate.id === appId)
      if (!spec) return Promise.resolve({ outcome: 'failed', reason: 'Unknown app.' })
      const entry: ConnectEntry = { appId, phase: 'installing', done: Promise.resolve({ outcome: 'failed' }) }
      current = entry
      entry.done = run(appId, spec.engine, (phase) => {
        entry.phase = phase
      })
        .catch((err: unknown): DesktopAppConnectResult => ({
          outcome: 'failed',
          reason: err instanceof Error ? err.message : String(err)
        }))
        .then((result) => {
          logger.info('desktop app connect finished', { appId, outcome: result.outcome })
          return result
        })
        .finally(() => {
          if (current === entry) current = null
        })
      return entry.done
    },

    running() {
      return current ? { appId: current.appId, phase: current.phase } : null
    }
  }
}

const BINARY: Record<EngineLoginId, { service: typeof claudeBinaryService; notInstalled: string }> = {
  claude: { service: claudeBinaryService, notInstalled: CLAUDE_NOT_INSTALLED },
  codex: { service: codexBinaryService, notInstalled: CODEX_NOT_INSTALLED }
}

const AUTH_PROBE: Record<EngineLoginId, typeof claudeAuthProbe | typeof codexAuthProbe> = {
  claude: claudeAuthProbe,
  codex: codexAuthProbe
}

/** The production wiring: the pinned binaries, the shared probes and logins the agent panel uses. */
export const desktopAppConnectService: DesktopAppConnect = createDesktopAppConnect({
  ensureBinary: async (engine) => {
    try {
      await BINARY[engine].service.ensure()
    } catch (err) {
      throw new Error(err instanceof ManagedAssetError ? err.message : BINARY[engine].notInstalled)
    }
  },
  refreshAuth: (engine) => {
    const probe = AUTH_PROBE[engine]
    probe.invalidate()
    return probe.refresh()
  },
  login: (engine) => engineLogins[engine].start(),
  adopt: adoptDesktopEngine
})
