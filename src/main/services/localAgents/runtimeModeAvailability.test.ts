import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { EngineBinaryState } from '../../../shared/engine'

/**
 * Runtime modes' availability: read from what main already knows. A visit to
 * Settings or the composer must never start a download, a login or a probe.
 */

const state = vi.hoisted(() => ({
  binary: {} as Record<string, EngineBinaryState>,
  lastKnown: {} as Record<string, { state: string } | null>,
  providers: [] as { enabled: boolean; hasApiKey: boolean; type: string }[],
  running: { claude: null, codex: null, antigravity: null } as Record<string, string | null>,
  asked: [] as string[]
}))

const probe = (engine: string) => ({
  lastKnown: () => state.lastKnown[engine] ?? null,
  status: () => { state.asked.push(`status:${engine}`); throw new Error('must not probe') },
  refresh: () => { state.asked.push(`refresh:${engine}`); throw new Error('must not probe') }
})
const binary = (engine: string) => ({
  peek: async () => state.binary[engine] ?? { state: 'unresolved' },
  ensure: () => { state.asked.push(`ensure:${engine}`); throw new Error('must not download') },
  resolve: () => { state.asked.push(`resolve:${engine}`); throw new Error('must not download') }
})

vi.mock('../../agents/drivers', () => ({ claudeAuthProbe: probe('claude'), codexAuthProbe: probe('codex'), antigravityAuthProbe: probe('antigravity') }))
vi.mock('../../engine/engineBinaryService', () => ({
  claudeBinaryService: binary('claude'), codexBinaryService: binary('codex'), antigravityBinaryService: binary('antigravity')
}))
vi.mock('../providerService', () => ({ providerService: { listMerged: () => state.providers } }))
vi.mock('./runtimeSetupService', () => ({
  runtimeSetupService: {
    running: () => state.running,
    setup: () => { state.asked.push('setup'); throw new Error('must not set up') }
  }
}))
vi.mock('../chatModeService', () => ({
  chatModeService: {
    ensureRuntimeModes: (userId: string) => { state.asked.push(`ensure-modes:${userId}`) },
    listMerged: () => [
      { id: 'rt-claude', builtinEngine: 'claude', managed: false },
      { id: 'rt-opencode', builtinEngine: 'opencode', managed: false },
      { id: 'saved', builtinEngine: null, managed: false }
    ]
  }
}))
vi.mock('../../auth/scope', () => ({ getSettingsScopeUserId: () => '__default__' }))

const { runtimeModeAvailability, listChatModesWithRuntimes } = await import('./runtimeModeAvailability')

const READY: EngineBinaryState = { state: 'ready', path: '/bin/x', source: 'managed', version: '1' }

beforeEach(() => {
  state.binary = {}
  state.lastKnown = {}
  state.providers = []
  state.running = { claude: null, codex: null, antigravity: null }
  state.asked = []
})

describe('runtimeModeAvailability', () => {
  it.each([
    [{ state: 'unresolved' }, 'needs_install'],
    [{ state: 'resolving' }, 'installing'],
    [{ state: 'failed', error: 'no network' }, 'install_failed'],
    [READY, 'ready']
  ] as [EngineBinaryState, string][])('reads %j as %s for every CLI runtime', async (binaryState, expected) => {
    for (const engine of ['claude', 'codex', 'antigravity'] as const) {
      state.binary[engine] = binaryState
      expect(await runtimeModeAvailability(engine)).toBe(expected)
    }
    expect(state.asked).toEqual([])
  })

  it('says needs_login only from a kept logged_out answer, and never asks', async () => {
    state.binary.claude = READY
    expect(await runtimeModeAvailability('claude')).toBe('ready')
    state.lastKnown.claude = { state: 'unknown' }
    expect(await runtimeModeAvailability('claude')).toBe('ready')
    state.lastKnown.claude = { state: 'logged_out' }
    expect(await runtimeModeAvailability('claude')).toBe('needs_login')
    // Not on disk: the install comes first, whatever the login said.
    state.binary.claude = { state: 'unresolved' }
    expect(await runtimeModeAvailability('claude')).toBe('needs_install')
    expect(state.asked).toEqual([])
  })

  it('reports a running install from the setup run', async () => {
    state.running.codex = 'installing'
    expect(await runtimeModeAvailability('codex')).toBe('installing')
  })

  it('OpenCode is ready with a usable credential only', async () => {
    expect(await runtimeModeAvailability('opencode')).toBe('needs_credential')
    state.providers = [{ enabled: false, hasApiKey: true, type: 'openai' }, { enabled: true, hasApiKey: false, type: 'openai' }]
    expect(await runtimeModeAvailability('opencode')).toBe('needs_credential')
    state.providers.push({ enabled: true, hasApiKey: false, type: 'ollama' })
    expect(await runtimeModeAvailability('opencode')).toBe('ready')
    expect(state.asked).toEqual([])
  })
})

describe('listChatModesWithRuntimes', () => {
  it('makes the runtime modes first, and attaches availability to runtime rows only', async () => {
    state.binary.claude = READY
    const list = await listChatModesWithRuntimes()
    expect(state.asked).toEqual(['ensure-modes:__default__'])
    expect(list.map((item) => [item.id, item.runtime ?? null])).toEqual([
      ['rt-claude', { engine: 'claude', availability: 'ready' }],
      ['rt-opencode', { engine: 'opencode', availability: 'needs_credential' }],
      ['saved', null]
    ])
  })
})
