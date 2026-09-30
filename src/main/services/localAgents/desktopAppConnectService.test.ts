import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { EngineLoginResult } from '../../../shared/engine'

/**
 * **Connecting a desktop app**: install the engine, ask whether it is signed
 * in, sign in only when it is not, then adopt it — and the rule for which chat
 * mode becomes the default when it is adopted.
 */

interface Mode {
  id: string
  name: string
  engine: string | null
  providerId: string | null
  managed: boolean
  isDefault: boolean
  modelId?: string | null
  systemPrompt?: string
  toolPolicy?: string
  mcpProviderIds?: string[]
  colorPreset?: string
}

const state = vi.hoisted(() => ({
  settings: {} as Record<string, unknown>,
  rescans: 0,
  modes: [] as Mode[],
  effective: null as Mode | null,
  prioritize: false,
  upserts: [] as unknown[]
}))

vi.mock('../appSettingsService', () => ({
  appSettingsService: { set: (key: string, value: unknown) => { state.settings[key] = value } }
}))
vi.mock('../../db/appSettings', () => ({
  appSettingsRepo: { get: (key: string) => (key === 'prioritizeAccountDefaults' ? state.prioritize : undefined) }
}))
vi.mock('../../auth/scope', () => ({ getSettingsScopeUserId: () => 'u1' }))
vi.mock('./localAgentService', () => ({ localAgentService: { rescan: () => { state.rescans++ } } }))
vi.mock('../chatModeService', () => ({
  chatModeService: {
    resolveEffectiveDefault: () => state.effective,
    list: () => state.modes,
    upsert: (_userId: string, input: unknown) => {
      state.upserts.push(input)
      return { id: (input as { id?: string }).id ?? 'new-mode' }
    }
  }
}))
vi.mock('../../agents/drivers', () => ({ claudeAuthProbe: {}, codexAuthProbe: {}, engineLogins: {} }))
vi.mock('../../engine/engineBinaryService', () => ({ claudeBinaryService: {}, codexBinaryService: {} }))
vi.mock('../../managed/managedAsset', () => ({ ManagedAssetError: class extends Error {} }))
vi.mock('../../agents/drivers/acp/acpLaunchers', () => ({ CLAUDE_NOT_INSTALLED: 'no claude' }))
vi.mock('../../agents/drivers/acp/codexLauncher', () => ({ CODEX_NOT_INSTALLED: 'no codex' }))
vi.mock('../../logger/logger', () => ({
  createLogger: () => ({ debug: () => {}, info: () => {}, warn: () => {}, error: () => {} })
}))

const { adoptDesktopEngine, createDesktopAppConnect } = await import('./desktopAppConnectService')

beforeEach(() => {
  state.settings = {}
  state.rescans = 0
  state.modes = []
  state.effective = null
  state.prioritize = false
  state.upserts = []
})

function deps(overrides: {
  auth?: string
  login?: EngineLoginResult | Promise<EngineLoginResult>
  ensure?: () => Promise<void>
} = {}) {
  const calls = { ensure: [] as string[], auth: [] as string[], login: [] as string[], adopt: [] as string[] }
  return {
    calls,
    deps: {
      ensureBinary: async (engine: 'claude' | 'codex') => {
        calls.ensure.push(engine)
        await overrides.ensure?.()
      },
      refreshAuth: async (engine: 'claude' | 'codex') => {
        calls.auth.push(engine)
        return { state: overrides.auth ?? 'logged_out' }
      },
      login: async (engine: 'claude' | 'codex') => {
        calls.login.push(engine)
        return overrides.login ?? { outcome: 'logged_in' as const, command: null }
      },
      adopt: (engine: 'claude' | 'codex') => {
        calls.adopt.push(engine)
      }
    }
  }
}

describe('connect', () => {
  it('adopts without a sign-in when the engine is already logged in', async () => {
    const { calls, deps: d } = deps({ auth: 'logged_in' })
    const service = createDesktopAppConnect(d)
    expect(await service.connect('chatgpt')).toEqual({ outcome: 'enabled' })
    expect(calls).toEqual({ ensure: ['codex'], auth: ['codex'], login: [], adopt: ['codex'] })
  })

  it('signs in when logged out, then adopts', async () => {
    const { calls, deps: d } = deps({ auth: 'logged_out' })
    const service = createDesktopAppConnect(d)
    expect(await service.connect('claude-desktop')).toEqual({ outcome: 'enabled' })
    expect(calls.login).toEqual(['claude'])
    expect(calls.adopt).toEqual(['claude'])
  })

  it('adopts nothing when the sign-in is cancelled', async () => {
    const { calls, deps: d } = deps({ login: { outcome: 'cancelled', command: null } })
    expect(await createDesktopAppConnect(d).connect('claude-desktop')).toEqual({ outcome: 'cancelled' })
    expect(calls.adopt).toEqual([])
  })

  it('adopts nothing when the sign-in fails, and says why', async () => {
    const { calls, deps: d } = deps({ login: { outcome: 'timeout', command: null } })
    expect(await createDesktopAppConnect(d).connect('claude-desktop')).toEqual({ outcome: 'failed', reason: 'Sign-in timed out.' })
    expect(calls.adopt).toEqual([])
  })

  it('fails with the install error and goes no further', async () => {
    const { calls, deps: d } = deps({ ensure: () => Promise.reject(new Error('download refused')) })
    expect(await createDesktopAppConnect(d).connect('chatgpt')).toEqual({ outcome: 'failed', reason: 'download refused' })
    expect(calls.auth).toEqual([])
    expect(calls.login).toEqual([])
  })

  it('refuses an unknown id without doing anything', async () => {
    const { calls, deps: d } = deps()
    expect((await createDesktopAppConnect(d).connect('../../etc')).outcome).toBe('failed')
    expect(calls.ensure).toEqual([])
  })

  it('joins a second call while one runs, and reports the phase meanwhile', async () => {
    let finishLogin!: (result: EngineLoginResult) => void
    const { calls, deps: d } = deps({ login: new Promise((resolve) => { finishLogin = resolve }) })
    const service = createDesktopAppConnect(d)
    expect(service.running()).toBeNull()
    const first = service.connect('claude-desktop')
    expect(service.running()).toEqual({ appId: 'claude-desktop', phase: 'installing' })
    const second = service.connect('claude-desktop')
    await vi.waitFor(() => expect(service.running()?.phase).toBe('signing-in'))
    expect(await service.connect('chatgpt')).toMatchObject({ outcome: 'failed' })
    finishLogin({ outcome: 'logged_in', command: null })
    expect(await first).toEqual({ outcome: 'enabled' })
    expect(await second).toEqual({ outcome: 'enabled' })
    expect(calls.ensure).toEqual(['claude'])
    expect(calls.adopt).toEqual(['claude'])
    expect(service.running()).toBeNull()
  })
})

describe('adoptDesktopEngine', () => {
  const apiDefault: Mode = { id: 'm-default', name: 'Default', engine: 'opencode', providerId: 'p1', managed: false, isDefault: true }

  it('writes the default runtime and re-indexes the agents', () => {
    adoptDesktopEngine('claude')
    expect(state.settings.localAgentsDefaultEngine).toBe('claude')
    expect(state.rescans).toBe(1)
  })

  it('makes a new engine mode the default when the default names another engine', () => {
    state.modes = [apiDefault]
    state.effective = apiDefault
    adoptDesktopEngine('claude')
    expect(state.upserts).toEqual([
      { name: 'Claude', engine: 'claude', providerId: null, colorPreset: 'amber', isDefault: true }
    ])
  })

  it('reuses a local mode on that engine with no credential, keeping its fields', () => {
    const existing: Mode = {
      id: 'm-codex', name: 'My Codex', engine: 'codex', providerId: null, managed: false, isDefault: false,
      modelId: 'gpt-x', systemPrompt: 'be brief', toolPolicy: 'none', mcpProviderIds: ['mcp1'], colorPreset: 'rose'
    }
    const withKey: Mode = { ...existing, id: 'm-codex-key', providerId: 'p2' }
    state.modes = [apiDefault, withKey, existing]
    state.effective = apiDefault
    adoptDesktopEngine('codex')
    expect(state.upserts).toEqual([
      {
        id: 'm-codex', name: 'My Codex', providerId: null, modelId: 'gpt-x', engine: 'codex', systemPrompt: 'be brief',
        toolPolicy: 'none', mcpProviderIds: ['mcp1'], colorPreset: 'rose', isDefault: true
      }
    ])
  })

  it('leaves a default that names no engine alone — it inherits the runtime', () => {
    state.effective = { ...apiDefault, engine: null }
    adoptDesktopEngine('claude')
    expect(state.upserts).toEqual([])
  })

  it('leaves things alone with no default mode, or one already on this engine', () => {
    adoptDesktopEngine('claude')
    state.effective = { ...apiDefault, engine: 'claude', providerId: null }
    adoptDesktopEngine('claude')
    expect(state.upserts).toEqual([])
  })

  it('leaves a prioritized account default alone, and overrides one that is not prioritized', () => {
    state.effective = { ...apiDefault, managed: true }
    state.prioritize = true
    adoptDesktopEngine('claude')
    expect(state.upserts).toEqual([])
    state.prioritize = false
    adoptDesktopEngine('claude')
    expect(state.upserts).toHaveLength(1)
  })
})
