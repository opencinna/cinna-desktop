import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createTestDatabase, type TestDatabase } from '../db/testSupport/nodeSqlite'

/** Runtime modes: materialised once per engine, guarded, resettable — against the real migration chain. */

const holder = vi.hoisted(() => ({ current: null as TestDatabase | null }))

vi.mock('../db/client', () => ({
  getDb: () => holder.current!.db,
  getRawSqlite: () => holder.current!.sqlite
}))
vi.mock('../auth/scope', () => ({
  getManagedResourceScopes: () => ['__default__'],
  getProfileScopeUserId: () => '__default__',
  getSettingsScopeUserId: () => '__default__'
}))
vi.mock('../logger/logger', () => ({
  createLogger: () => ({ debug: () => {}, info: () => {}, warn: () => {}, error: () => {} })
}))

const { chatModeService } = await import('./chatModeService')
const { chatModeRepo } = await import('../db/chatModes')

const USER = '__default__'

beforeEach(() => { holder.current = createTestDatabase() })
afterEach(() => { holder.current?.close(); holder.current = null })

const runtimeRows = () => chatModeService.list(USER).filter((mode) => mode.builtinEngine)
const runtimeMode = (engine: string) => runtimeRows().find((mode) => mode.builtinEngine === engine)!

/** The whole row back, as the settings card sends it. */
function save(row: ReturnType<typeof runtimeMode>, patch: Record<string, unknown> = {}) {
  return chatModeService.upsert(USER, {
    id: row.id, name: row.name, engine: row.engine, providerId: row.providerId, modelId: row.modelId,
    systemPrompt: row.systemPrompt, toolPolicy: row.toolPolicy, complexity: row.complexity,
    mcpProviderIds: row.mcpProviderIds ?? [], colorPreset: row.colorPreset, isDefault: row.isDefault, ...patch
  })
}

describe('ensureRuntimeModes', () => {
  it('creates one mode per engine with the defaults, never starred, and is idempotent', () => {
    chatModeService.ensureRuntimeModes(USER)
    chatModeService.ensureRuntimeModes(USER)
    const rows = runtimeRows()
    expect(rows.map((row) => [row.builtinEngine, row.engine, row.name, row.colorPreset]).sort()).toEqual([
      ['antigravity', 'antigravity', 'Antigravity', 'indigo'],
      ['claude', 'claude', 'Claude Agent', 'orange'],
      ['codex', 'codex', 'Codex', 'sky'],
      ['opencode', 'opencode', 'OpenCode', 'emerald']
    ])
    for (const row of rows) {
      // Every engine's workspace policy is verified (`WORKSPACE_POLICY_ENGINES`), so each runtime mode starts on it.
      expect(row).toMatchObject({ providerId: null, modelId: null, complexity: 'medium', toolPolicy: 'workspace', systemPrompt: '', mcpProviderIds: [], isDefault: false, managed: false })
    }
  })

  it('creates one row per engine when two calls race past the existence check', () => {
    // Both callers looked before either inserted: the unique index decides.
    const look = vi.spyOn(chatModeRepo, 'getRuntimeMode').mockReturnValue(undefined)
    chatModeService.ensureRuntimeModes(USER)
    chatModeService.ensureRuntimeModes(USER)
    look.mockRestore()
    expect(runtimeRows()).toHaveLength(4)
    expect(chatModeRepo.insertRuntimeModeIfMissing(USER, { name: 'x', builtinEngine: 'claude' })).toBe(false)
  })

  it('brings an existing runtime mode back to its engine’s current name, so the name guard never strands it', () => {
    chatModeService.ensureRuntimeModes(USER)
    chatModeRepo.setName(USER, runtimeMode('claude').id, 'Claude Code')
    chatModeService.ensureRuntimeModes(USER)
    expect(runtimeMode('claude').name).toBe('Claude Agent')
    expect(() => save(runtimeMode('claude'), { complexity: 'simple' })).not.toThrow()
  })

  it('keeps one runtime mode per user, not per database', () => {
    chatModeService.ensureRuntimeModes(USER)
    chatModeService.ensureRuntimeModes('someone-else')
    expect(runtimeRows()).toHaveLength(4)
    expect(chatModeService.list('someone-else').filter((mode) => mode.builtinEngine)).toHaveLength(4)
  })
})

describe('runtime mode guards', () => {
  beforeEach(() => chatModeService.ensureRuntimeModes(USER))

  it('refuses delete, rename and a change of engine', () => {
    const claude = runtimeMode('claude')
    expect(() => chatModeService.delete(USER, claude.id)).toThrow(/cannot be deleted/)
    expect(() => save(claude, { name: 'Mine' })).toThrow(/keeps its name/)
    expect(() => save(claude, { engine: 'codex' })).toThrow(/always runs Claude Agent/)
    expect(() => save(claude, { engine: null })).toThrow(/always runs Claude Agent/)
    expect(runtimeRows()).toHaveLength(4)
    expect(runtimeMode('claude')).toMatchObject({ name: 'Claude Agent', engine: 'claude' })
  })

  it('refuses a credential on a CLI runtime and allows one on OpenCode, whose engine stays', () => {
    expect(() => save(runtimeMode('codex'), { providerId: 'p1' })).toThrow(/does not use an AI credential/)
    save(runtimeMode('opencode'), { providerId: 'p1', modelId: 'gpt-x' })
    expect(runtimeMode('opencode')).toMatchObject({ providerId: 'p1', modelId: 'gpt-x', engine: 'opencode', builtinEngine: 'opencode' })
    expect(() => save(runtimeMode('opencode'), { engine: 'claude' })).toThrow(/always runs OpenCode/)
  })

  it('saves the editable fields, and an upsert never makes or unmakes a runtime mode', () => {
    save(runtimeMode('claude'), { complexity: 'complex', modelId: 'opus', systemPrompt: 'Be brief', toolPolicy: 'none', colorPreset: 'rose', mcpProviderIds: ['m1'] })
    expect(runtimeMode('claude')).toMatchObject({ complexity: 'complex', modelId: 'opus', systemPrompt: 'Be brief', toolPolicy: 'none', colorPreset: 'rose', mcpProviderIds: ['m1'], builtinEngine: 'claude' })
    const { id } = chatModeService.upsert(USER, { name: 'Sneaky', engine: 'claude', builtinEngine: 'claude' })
    expect(chatModeService.get(USER, id)?.builtinEngine).toBeNull()
    // A saved mode is still deleted as before.
    chatModeService.delete(USER, id)
    expect(chatModeService.get(USER, id)).toBeNull()
  })

  it('accepts Workspace on every runtime mode and on a saved mode on the Default runtime, and refuses an unknown effort', () => {
    for (const engine of ['claude', 'codex', 'antigravity', 'opencode']) {
      save(runtimeMode(engine), { toolPolicy: 'connectors' })
      expect(() => save(runtimeMode(engine), { toolPolicy: 'workspace' })).not.toThrow()
      expect(runtimeMode(engine).toolPolicy).toBe('workspace')
    }
    // Every engine supports it, so the Default runtime does too; the engine it
    // resolves to is checked when a chat starts (`applyConductorToolPolicy`).
    const { id } = chatModeService.upsert(USER, { name: 'Saved', toolPolicy: 'workspace' })
    expect(chatModeService.get(USER, id)?.toolPolicy).toBe('workspace')
    expect(() => chatModeService.upsert(USER, { name: 'Saved', complexity: 'high' as never })).toThrow(/Low, Medium or High/)
  })
})

describe('reset', () => {
  beforeEach(() => chatModeService.ensureRuntimeModes(USER))

  it('restores the defaults, clearing model, credential, MCPs and instructions, and keeps the star', () => {
    save(runtimeMode('opencode'), { providerId: 'p1', modelId: 'gpt-x', complexity: 'simple', toolPolicy: 'none', systemPrompt: 'Hi', colorPreset: 'rose', mcpProviderIds: ['m1'], isDefault: true })
    chatModeService.reset(USER, runtimeMode('opencode').id)
    expect(runtimeMode('opencode')).toMatchObject({
      name: 'OpenCode', engine: 'opencode', providerId: null, modelId: null, complexity: 'medium', toolPolicy: 'workspace',
      systemPrompt: '', colorPreset: 'emerald', mcpProviderIds: [], isDefault: true
    })
  })

  it('refuses a saved mode', () => {
    const { id } = chatModeService.upsert(USER, { name: 'Saved' })
    expect(() => chatModeService.reset(USER, id)).toThrow(/Only a runtime mode/)
  })
})

describe('single default across runtime and saved modes', () => {
  it('starring one clears the other, in both directions', () => {
    chatModeService.ensureRuntimeModes(USER)
    const { id: saved } = chatModeService.upsert(USER, { name: 'Saved', isDefault: true })
    save(runtimeMode('codex'), { isDefault: true })
    const defaults = () => chatModeService.list(USER).filter((mode) => mode.isDefault).map((mode) => mode.id)
    expect(defaults()).toEqual([runtimeMode('codex').id])
    const row = chatModeService.get(USER, saved)!
    chatModeService.upsert(USER, { id: saved, name: row.name, isDefault: true })
    expect(defaults()).toEqual([saved])
  })
})
