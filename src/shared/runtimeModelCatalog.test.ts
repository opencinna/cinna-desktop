import { describe, expect, it } from 'vitest'
import {
  catalogDefaultModel,
  catalogNeedsRefresh,
  effortsFor,
  cliModelTier,
  isModelOffered,
  matchOfferedModel,
  RUNTIME_MODEL_CATALOG_MAX_AGE_MS,
  type RuntimeModelCatalog
} from './runtimeModelCatalog'

const claude: RuntimeModelCatalog = {
  engine: 'claude',
  source: 'session',
  updatedAt: 1,
  models: [
    { id: 'default', name: 'Default (recommended)', description: 'Opus 5.5' },
    { id: 'opus', name: 'Opus 5.5' }, { id: 'sonnet', name: 'Sonnet 5' }, { id: 'haiku', name: 'Haiku 4.5' },
    { id: 'claude-haiku-4-5-20251001', name: 'Haiku 4.5' }, { id: 'claude-opus-4-6', name: 'Opus 4.6' }, { id: 'opus[1m]', name: 'Opus (1M)' }
  ]
}
const codex: RuntimeModelCatalog = {
  engine: 'codex', source: 'session', updatedAt: 1, defaultModelId: 'gpt-6-luna',
  models: [{ id: 'gpt-6-luna', name: 'GPT-6-Luna' }, { id: 'gpt-5.6-terra', name: 'GPT-5.6-Terra' }]
}

describe('isModelOffered', () => {
  it('matches exactly, ignoring case or a context hint, and by family with the version guard — like the driver', () => {
    expect(isModelOffered(claude, 'opus')).toBe(true)
    expect(isModelOffered(claude, 'OPUS')).toBe(true)
    expect(isModelOffered(claude, 'claude-haiku-4-5')).toBe(true) // family + version 4.5
    expect(isModelOffered(claude, 'claude-opus-4-6')).toBe(true)
    // Named a version the catalogue no longer lists: stale.
    expect(isModelOffered(claude, 'claude-opus-4-1')).toBe(false)
    expect(isModelOffered(claude, 'claude-sonnet-4-5')).toBe(false)
    expect(isModelOffered(claude, 'mythos-9')).toBe(false)
  })

  it('never judges against a catalogue it does not have', () => {
    expect(isModelOffered(undefined, 'opus')).toBeNull()
    expect(isModelOffered({ engine: 'claude', models: [], source: 'unavailable', updatedAt: null }, 'opus')).toBeNull()
  })

  it('never matches `default` by family', () => {
    expect(matchOfferedModel([{ value: 'default', name: 'Default', description: 'Opus 5.5' }], 'opus')).toBeNull()
  })
})

describe('cliModelTier', () => {
  it('Claude: haiku / sonnet / opus aliases and ids convert, others and an effort do not', () => {
    expect(cliModelTier('claude', 'haiku', null, claude)).toEqual({ tier: 'simple' })
    expect(cliModelTier('claude', 'claude-sonnet-5', null, claude)).toEqual({ tier: 'medium' })
    expect(cliModelTier('claude', 'claude-opus-4-6', null, claude)).toEqual({ tier: 'complex' })
    expect(cliModelTier('claude', 'fable', null, claude)).toBeNull()
    expect(cliModelTier('claude', 'opus', 'high', claude)).toBeNull()
  })

  it('Antigravity: the thinking-level suffix names the tier', () => {
    expect(cliModelTier('antigravity', 'gemini-3.8-flash-low', null, null)).toEqual({ tier: 'simple' })
    expect(cliModelTier('antigravity', 'gemini-3.8-flash-medium', null, null)).toEqual({ tier: 'medium' })
    expect(cliModelTier('antigravity', 'gemini-3.8-flash-high', null, null)).toEqual({ tier: 'complex' })
    expect(cliModelTier('antigravity', 'gemini-3.8-pro', null, null)).toBeNull()
  })

  it('Codex: only the default model, at low / medium / high effort or none', () => {
    expect(cliModelTier('codex', 'gpt-6-luna', 'low', codex)).toEqual({ tier: 'simple' })
    expect(cliModelTier('codex', 'gpt-6-luna', 'high', codex)).toEqual({ tier: 'complex' })
    expect(cliModelTier('codex', 'gpt-6-luna', null, codex)).toEqual({ tier: null })
    expect(cliModelTier('codex', 'gpt-6-luna', 'xhigh', codex)).toBeNull()
    expect(cliModelTier('codex', 'gpt-5.6-terra', 'low', codex)).toBeNull()
    expect(cliModelTier('codex', 'gpt-6-luna', 'low', null)).toBeNull()
    // Codex's cache ignores the model config.toml names, so its "default" is not one to convert by.
    expect(cliModelTier('codex', 'gpt-6-luna', 'low', { ...codex, source: 'cli-cache' })).toBeNull()
  })
})

describe('catalogue helpers', () => {
  it('the default is the recorded one when listed, else the first that is not `default`', () => {
    expect(catalogDefaultModel(codex)).toBe('gpt-6-luna')
    expect(catalogDefaultModel({ ...codex, defaultModelId: 'gone' })).toBe('gpt-6-luna')
    expect(catalogDefaultModel(claude)).toBe('opus')
    expect(catalogDefaultModel(undefined)).toBeNull()
  })

  it('needs a refresh when missing, unavailable or older than a day', () => {
    const now = 10 * RUNTIME_MODEL_CATALOG_MAX_AGE_MS
    expect(catalogNeedsRefresh(undefined, now)).toBe(true)
    expect(catalogNeedsRefresh({ engine: 'claude', models: [], source: 'unavailable', updatedAt: null }, now)).toBe(true)
    expect(catalogNeedsRefresh({ ...claude, updatedAt: now - RUNTIME_MODEL_CATALOG_MAX_AGE_MS - 1 }, now)).toBe(true)
    expect(catalogNeedsRefresh({ ...claude, updatedAt: now - 1000 }, now)).toBe(false)
    expect(catalogNeedsRefresh({ ...codex, source: 'cli-cache', updatedAt: now - 1000 }, now)).toBe(true)
  })

  it('reads a model’s own efforts: listed, none, or never seen', () => {
    const catalog = { ...codex, effortsByModel: { 'gpt-6-luna': [{ id: 'low', name: 'Low' }], 'gpt-5.6-terra': [] } }
    expect(effortsFor(catalog, 'gpt-6-luna')).toEqual([{ id: 'low', name: 'Low' }])
    expect(effortsFor(catalog, 'gpt-5.6-terra')).toEqual([])
    expect(effortsFor(catalog, 'unseen')).toBeUndefined()
    expect(effortsFor(catalog, null)).toBeUndefined()
  })

  it('finds the efforts of a model offered under another value, by the driver’s matching', () => {
    // Mutation: look up by exact id only and `claude-haiku-4-5` (offered as `haiku`) has no effort choices.
    const withEfforts = { ...claude, effortsByModel: { haiku: [{ id: 'low', name: 'Low' }], 'opus[1m]': [{ id: 'max', name: 'Max' }] } }
    expect(effortsFor(withEfforts, 'claude-haiku-4-5')).toEqual([{ id: 'low', name: 'Low' }])
    expect(effortsFor(withEfforts, 'mythos-9')).toBeUndefined()
  })
})
