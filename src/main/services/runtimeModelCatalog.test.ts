import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createTestDatabase, type TestDatabase } from '../db/testSupport/nodeSqlite'

const holder = vi.hoisted(() => ({ db: null as TestDatabase | null, codexHome: '' }))
vi.mock('../db/client', () => ({ getDb: () => holder.db!.db, getRawSqlite: () => holder.db!.sqlite }))
vi.mock('../shell/env', () => ({ getShellEnv: async () => ({ CODEX_HOME: holder.codexHome }) }))

const {
  getRuntimeModelCatalog,
  installRuntimeModelCatalogProbe,
  parseCodexModelsCache,
  readCodexModelsCache,
  recordRuntimeModelCatalog,
  refreshRuntimeModelCatalog,
  resetRuntimeModelCatalogsForTests
} = await import('./runtimeModelCatalog')

/** `session/new` configOptions as the pinned adapters answered on 2026-10-18 (trimmed). */
const CLAUDE_NEW = { configOptions: [
  { id: 'model', category: 'model', type: 'select', currentValue: 'default', options: [
    { value: 'default', name: 'Default (recommended)', description: 'Opus 5.5' },
    { value: 'opus', name: 'Opus 5.5' }, { value: 'sonnet', name: 'Sonnet 5' }, { value: 'haiku', name: 'Haiku 4.5' },
    { value: 'claude-opus-4-6', name: 'Opus 4.6' }
  ] },
  { id: 'effort', type: 'select', currentValue: 'default', options: [
    { value: 'default', name: 'Default' }, { value: 'low', name: 'Low' }, { value: 'high', name: 'High' }, { value: 'max', name: 'Max' }
  ] },
  { id: 'fast', type: 'boolean', currentValue: false }
] }
const CODEX_NEW = {
  configOptions: [
    { id: 'model', category: 'model', type: 'select', currentValue: 'gpt-6-luna', options: [
      { value: 'gpt-6-luna', name: 'GPT-6-Luna' }, { value: 'gpt-5.6-terra', name: 'GPT-5.6-Terra' }, { value: 'gpt-5.6-luna', name: 'GPT-5.6-Luna' }
    ] },
    { id: 'reasoning_effort', category: 'thought_level', type: 'select', currentValue: 'medium', options: [
      { value: 'low', name: 'Low' }, { value: 'medium', name: 'Medium' }, { value: 'xhigh', name: 'Extra high' }, { value: 'ultra', name: 'Ultra' }
    ] }
  ],
  // The legacy combos are ignored whenever configOptions exist.
  models: { currentModelId: 'gpt-6-luna[medium]', availableModels: [{ modelId: 'gpt-6-luna[medium]', name: 'GPT-6-Luna (medium)' }] }
}
const ANTIGRAVITY_NEW = { configOptions: [
  { id: 'model', type: 'select', currentValue: 'gemini-3.8-flash-high', options: [
    { value: 'gemini-3.8-flash-high', name: 'Gemini 3.8 Flash (High)' },
    { value: 'gemini-3.8-flash-medium', name: 'Gemini 3.8 Flash (Medium)' },
    { value: 'gemini-3.8-flash-low', name: 'Gemini 3.8 Flash (Low)' }
  ] },
  { id: 'mode', category: 'mode', type: 'select', currentValue: 'default', options: [{ value: 'default', name: 'Default' }] }
] }

let codexDir = ''
beforeEach(() => {
  holder.db = createTestDatabase()
  codexDir = mkdtempSync(join(tmpdir(), 'codex-home-'))
  holder.codexHome = codexDir
  resetRuntimeModelCatalogsForTests()
  installRuntimeModelCatalogProbe(null)
})
afterEach(() => {
  holder.db?.close()
  rmSync(codexDir, { recursive: true, force: true })
})

describe('runtime model catalog', () => {
  it('learns model config choices, including groups, and ignores unrelated updates', async () => {
    recordRuntimeModelCatalog('profile-config', 'claude', { configOptions: [
      { id: 'effort', options: [{ value: 'high', name: 'High' }] },
      { id: 'model', category: 'model', options: [
        { value: 'sonnet', name: 'Sonnet 5', description: 'Efficient' },
        { group: 'More', options: [{ value: 'new-plan-model', name: 'New model' }] }
      ] }
    ] })
    recordRuntimeModelCatalog('profile-config', 'claude', { configOptions: [{ id: 'mode', options: [] }] })
    expect(await getRuntimeModelCatalog('profile-config', 'claude')).toMatchObject({ source: 'session', models: [
      { id: 'sonnet', name: 'Sonnet 5', description: 'Efficient' },
      { id: 'new-plan-model', name: 'New model' }
    ] })
    // No current model named, so no model's efforts are known.
    expect((await getRuntimeModelCatalog('profile-config', 'claude')).effortsByModel).toBeUndefined()
    expect((await getRuntimeModelCatalog('other-profile', 'claude')).source).toBe('unavailable')
    expect((await getRuntimeModelCatalog('profile-config', 'codex')).source).toBe('unavailable')
  })

  it('learns the legacy models response and replaces models when the runtime changes it', async () => {
    recordRuntimeModelCatalog('profile-legacy', 'codex', { models: { availableModels: [{ modelId: 'plan-v1', name: 'Plan v1' }] } })
    expect((await getRuntimeModelCatalog('profile-legacy', 'codex')).models).toEqual([{ id: 'plan-v1', name: 'Plan v1' }])
    recordRuntimeModelCatalog('profile-legacy', 'codex', { configOptions: [{ category: 'model', options: [{ value: 'plan-v2', name: 'Plan v2' }] }] })
    expect((await getRuntimeModelCatalog('profile-legacy', 'codex')).models).toEqual([{ id: 'plan-v2', name: 'Plan v2' }])
  })

  it('parses each engine’s session/new: Claude and Codex efforts, Codex ignoring legacy combos, Antigravity with none', async () => {
    recordRuntimeModelCatalog('p', 'claude', CLAUDE_NEW)
    recordRuntimeModelCatalog('p', 'codex', CODEX_NEW)
    recordRuntimeModelCatalog('p', 'antigravity', ANTIGRAVITY_NEW)
    const claude = await getRuntimeModelCatalog('p', 'claude')
    expect(claude.models.map((m) => m.id)).toEqual(['default', 'opus', 'sonnet', 'haiku', 'claude-opus-4-6'])
    // Efforts are the current model's only.
    expect(Object.keys(claude.effortsByModel ?? {})).toEqual(['default'])
    expect(claude.effortsByModel?.default.map((e) => e.id)).toEqual(['default', 'low', 'high', 'max'])
    // A turn's session may sit on the agent's model: it never sets the default.
    expect(claude.defaultModelId).toBeUndefined()
    const codex = await getRuntimeModelCatalog('p', 'codex')
    expect(codex.models.map((m) => m.id)).toEqual(['gpt-6-luna', 'gpt-5.6-terra', 'gpt-5.6-luna'])
    expect(codex.effortsByModel).toEqual({ 'gpt-6-luna': [{ id: 'low', name: 'Low' }, { id: 'medium', name: 'Medium' }, { id: 'xhigh', name: 'Extra high' }, { id: 'ultra', name: 'Ultra' }] })
    const antigravity = await getRuntimeModelCatalog('p', 'antigravity')
    expect(antigravity.models.map((m) => m.id)).toEqual(['gemini-3.8-flash-high', 'gemini-3.8-flash-medium', 'gemini-3.8-flash-low'])
    // Config options with no effort option: the current model offers none.
    expect(antigravity.effortsByModel).toEqual({ 'gemini-3.8-flash-high': [] })
  })

  it('survives a restart: the persisted catalogue is read back per profile and runtime', async () => {
    recordRuntimeModelCatalog('p1', 'claude', CLAUDE_NEW, { defaultModel: true })
    recordRuntimeModelCatalog('p2', 'claude', ANTIGRAVITY_NEW)
    resetRuntimeModelCatalogsForTests()
    const restored = await getRuntimeModelCatalog('p1', 'claude')
    expect(restored).toMatchObject({ engine: 'claude', source: 'session', defaultModelId: 'default' })
    expect(restored.models.map((m) => m.id)).toEqual(['default', 'opus', 'sonnet', 'haiku', 'claude-opus-4-6'])
    expect(restored.effortsByModel?.default.length).toBe(4)
    expect(typeof restored.updatedAt).toBe('number')
    expect((await getRuntimeModelCatalog('p2', 'claude')).models[0].id).toBe('gemini-3.8-flash-high')
    expect((await getRuntimeModelCatalog('p1', 'codex')).source).toBe('unavailable')
  })

  it('a turn on a model with no effort option records only that model, keeping the others’ efforts', async () => {
    // Mutation: replace the whole map with the last answer's and one haiku turn kills every agent's effort select.
    recordRuntimeModelCatalog('p', 'claude', CLAUDE_NEW)
    const onHaiku = { configOptions: [{ ...CLAUDE_NEW.configOptions[0], currentValue: 'haiku' }] }
    recordRuntimeModelCatalog('p', 'claude', onHaiku)
    const catalog = await getRuntimeModelCatalog('p', 'claude')
    expect(catalog.effortsByModel?.default.map((e) => e.id)).toEqual(['default', 'low', 'high', 'max'])
    expect(catalog.effortsByModel?.haiku).toEqual([])
    expect(catalog.effortsByModel?.opus).toBeUndefined()
  })

  it('keeps the efforts and default it knew when a later answer has only the legacy models shape', async () => {
    recordRuntimeModelCatalog('p', 'codex', CODEX_NEW, { defaultModel: true })
    recordRuntimeModelCatalog('p', 'codex', { models: { availableModels: [{ modelId: 'gpt-6-luna', name: 'GPT-6-Luna' }] } })
    const catalog = await getRuntimeModelCatalog('p', 'codex')
    expect(catalog.effortsByModel?.['gpt-6-luna'].length).toBe(4)
    expect(catalog.defaultModelId).toBe('gpt-6-luna')
  })
})

describe('Codex models_cache.json', () => {
  const cache = {
    fetched_at: '2026-10-18T12:32:00.010302Z',
    models: [
      { slug: 'gpt-5.6-terra', display_name: 'GPT-5.6-Terra', visibility: 'list', priority: 8, supported_reasoning_levels: [{ effort: 'low' }, { effort: 'ultra' }] },
      { slug: 'gpt-reserve', display_name: 'GPT-Reserve', visibility: 'hide', priority: 1, supported_reasoning_levels: [{ effort: 'secret' }] },
      { slug: 'gpt-6-luna', display_name: 'GPT-6-Luna', description: 'Fast', visibility: 'list', priority: 4, supported_reasoning_levels: [{ effort: 'low' }, { effort: 'medium' }] }
    ]
  }

  it('lists only visible models, in priority order, with every offered effort and the first as default', () => {
    expect(parseCodexModelsCache(JSON.stringify(cache))).toEqual({
      engine: 'codex',
      models: [{ id: 'gpt-6-luna', name: 'GPT-6-Luna', description: 'Fast' }, { id: 'gpt-5.6-terra', name: 'GPT-5.6-Terra' }],
      effortsByModel: {
        'gpt-6-luna': [{ id: 'low', name: 'Low' }, { id: 'medium', name: 'Medium' }],
        'gpt-5.6-terra': [{ id: 'low', name: 'Low' }, { id: 'ultra', name: 'Ultra' }]
      },
      defaultModelId: 'gpt-6-luna',
      source: 'cli-cache',
      updatedAt: Date.parse('2026-10-18T12:32:00.010302Z')
    })
  })

  it('is null for a missing, malformed or empty file', () => {
    expect(readCodexModelsCache(join(codexDir, 'nowhere'))).toBeNull()
    expect(parseCodexModelsCache('{not json')).toBeNull()
    expect(parseCodexModelsCache(JSON.stringify({ models: [{ slug: 'x', visibility: 'hide' }] }))).toBeNull()
    expect(parseCodexModelsCache('null')).toBeNull()
  })

  it('backs the Codex catalogue from CODEX_HOME before any session, and a session replaces it', async () => {
    expect((await getRuntimeModelCatalog('p', 'codex')).source).toBe('unavailable')
    writeFileSync(join(codexDir, 'models_cache.json'), JSON.stringify(cache))
    expect(await getRuntimeModelCatalog('p', 'codex')).toMatchObject({ source: 'cli-cache', defaultModelId: 'gpt-6-luna' })
    // Never for another engine.
    expect((await getRuntimeModelCatalog('p', 'claude')).source).toBe('unavailable')
    recordRuntimeModelCatalog('p', 'codex', CODEX_NEW)
    expect((await getRuntimeModelCatalog('p', 'codex')).source).toBe('session')
  })
})

describe('on-demand refresh', () => {
  it('records the probe’s session as the catalogue, with its current model as the default and each set model’s efforts', async () => {
    const onTerra = { configOptions: [
      { ...CODEX_NEW.configOptions[0], currentValue: 'gpt-5.6-terra' },
      { ...CODEX_NEW.configOptions[1], options: [{ value: 'low', name: 'Low' }, { value: 'ultra', name: 'Ultra' }] }
    ] }
    let listedBeforeEfforts = false
    installRuntimeModelCatalogProbe(async (_userId, _engine, onAnswer) => {
      onAnswer(CODEX_NEW, true)
      // The model list is recorded before any effort walk answers.
      listedBeforeEfforts = (await getRuntimeModelCatalog('p', 'codex')).source === 'session'
      onAnswer(onTerra, false)
      return { ok: true }
    })
    const result = await refreshRuntimeModelCatalog('p', 'codex')
    expect(result.error).toBeNull()
    expect(result.catalog).toMatchObject({ source: 'session', defaultModelId: 'gpt-6-luna' })
    expect(result.catalog.effortsByModel?.['gpt-5.6-terra'].map((e) => e.id)).toEqual(['low', 'ultra'])
    expect(result.catalog.effortsByModel?.['gpt-6-luna'].map((e) => e.id)).toEqual(['low', 'medium', 'xhigh', 'ultra'])
    expect(listedBeforeEfforts).toBe(true)
  })

  it('is single-flight per profile and runtime: concurrent callers share one probe', async () => {
    const waiting: (() => void)[] = []
    const release = (): void => { for (const resolve of waiting) resolve() }
    const probe = vi.fn((_userId: string, _engine: string, onAnswer: (answer: unknown, first: boolean) => void) =>
      new Promise<{ ok: true }>((resolve) => { waiting.push(() => { onAnswer(CLAUDE_NEW, true); resolve({ ok: true }) }) }))
    installRuntimeModelCatalogProbe(probe)
    const first = refreshRuntimeModelCatalog('p', 'claude')
    const second = refreshRuntimeModelCatalog('p', 'claude')
    const other = refreshRuntimeModelCatalog('q', 'claude')
    expect(second).toBe(first)
    await Promise.resolve()
    expect(probe).toHaveBeenCalledTimes(2) // 'p' once, 'q' once
    release()
    await expect(first).resolves.toMatchObject({ error: null })
    // Done: the next refresh probes again.
    installRuntimeModelCatalogProbe(async (_userId, _engine, onAnswer) => { onAnswer(CLAUDE_NEW, true); return { ok: true } })
    await refreshRuntimeModelCatalog('p', 'claude')
    await other
  })

  it('returns a readable failure as data, keeping the catalogue it had', async () => {
    recordRuntimeModelCatalog('p', 'antigravity', ANTIGRAVITY_NEW)
    installRuntimeModelCatalogProbe(async () => ({ error: 'Antigravity is not logged in.' }))
    const result = await refreshRuntimeModelCatalog('p', 'antigravity')
    expect(result.error).toBe('Antigravity is not logged in.')
    expect(result.catalog.source).toBe('session')
    installRuntimeModelCatalogProbe(async () => { throw new Error('spawn ENOENT') })
    expect((await refreshRuntimeModelCatalog('p', 'claude'))).toMatchObject({ error: 'spawn ENOENT', catalog: { source: 'unavailable' } })
    installRuntimeModelCatalogProbe(null)
    expect((await refreshRuntimeModelCatalog('p', 'claude')).error).toMatch(/cannot be asked/)
    expect((await refreshRuntimeModelCatalog('p', 'opencode')).error).toMatch(/OpenCode/)
  })
})
