import { describe, expect, it } from 'vitest'
import { getRuntimeModelCatalog, recordRuntimeModelCatalog } from './runtimeModelCatalog'

describe('runtime model catalog', () => {
  it('learns model config choices, including groups, and ignores unrelated updates', () => {
    recordRuntimeModelCatalog('profile-config', 'claude', { configOptions: [
      { id: 'effort', options: [{ value: 'high', name: 'High' }] },
      { id: 'model', category: 'model', options: [
        { value: 'sonnet', name: 'Sonnet 5', description: 'Efficient' },
        { group: 'More', options: [{ value: 'new-plan-model', name: 'New model' }] }
      ] }
    ] })
    recordRuntimeModelCatalog('profile-config', 'claude', { configOptions: [{ id: 'mode', options: [] }] })
    expect(getRuntimeModelCatalog('profile-config', 'claude')).toMatchObject({ source: 'session', models: [
      { id: 'sonnet', name: 'Sonnet 5', description: 'Efficient' },
      { id: 'new-plan-model', name: 'New model' }
    ] })
    expect(getRuntimeModelCatalog('other-profile', 'claude').source).toBe('unavailable')
    expect(getRuntimeModelCatalog('profile-config', 'codex').source).toBe('unavailable')
  })

  it('learns the legacy models response and replaces models when the runtime changes it', () => {
    recordRuntimeModelCatalog('profile-legacy', 'codex', { models: { availableModels: [{ modelId: 'plan-v1', name: 'Plan v1' }] } })
    expect(getRuntimeModelCatalog('profile-legacy', 'codex').models).toEqual([{ id: 'plan-v1', name: 'Plan v1' }])
    recordRuntimeModelCatalog('profile-legacy', 'codex', { configOptions: [{ category: 'model', options: [{ value: 'plan-v2', name: 'Plan v2' }] }] })
    expect(getRuntimeModelCatalog('profile-legacy', 'codex').models).toEqual([{ id: 'plan-v2', name: 'Plan v2' }])
  })
})
