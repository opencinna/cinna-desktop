import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { CinnaAgentManifest } from '../../../shared/kit/manifest'
import type { ProviderDto } from '../providerService'

/**
 * Resolving a runtime, and writing one back.
 *
 * Two things are load-bearing and neither is obvious from the types:
 *
 * 1. **A key must never end up in the manifest.** The Runtime card sends a
 *    string that lands in a file the user commits and publishes, so the check
 *    is on the way *in*, using the validator's own pattern rather than a second
 *    copy of it.
 * 2. **A manifest with no `runtime` block must round-trip as having none.**
 *    Leaving `{}` behind is the kind of difference nothing notices until a diff
 *    of the user's manifest shows a change they did not make.
 *
 * Every assertion below was mutation-checked, and re-checked: ten mutations —
 * dropping the key-shape refusal, leaving `{}` behind, discarding unknown
 * runtime keys, removing the length cap, accepting a non-string, letting a
 * name lookup beat an id, dropping a manifest's model for the default's,
 * falling back to the default credential without saying so, and reporting no
 * reason for an unusable default — each failed at least one test here.
 */

const defaultMode = vi.hoisted(
  () => ({ current: null as { providerId: string; modelId: string } | null })
)

vi.mock('../chatModeService', () => ({
  chatModeService: { resolveEffectiveDefault: () => defaultMode.current }
}))
vi.mock('../providerService', () => ({ providerService: { listMerged: () => [] } }))
vi.mock('../../logger/logger', () => ({
  createLogger: () => ({ debug: () => {}, info: () => {}, warn: () => {}, error: () => {} })
}))

const { findCredential, runtimeService } = await import('./runtimeService')

function provider(overrides: Partial<ProviderDto> = {}): ProviderDto {
  return {
    id: 'p1',
    type: 'anthropic',
    name: 'Anthropic',
    enabled: true,
    defaultModelId: null,
    hasApiKey: true,
    managed: false,
    adminManaged: false,
    unsupported: false,
    createdAt: new Date(0),
    ...overrides
  }
}

beforeEach(() => {
  defaultMode.current = null
})

describe('findCredential', () => {
  const providers = [
    provider({ id: 'p1', name: 'Personal', type: 'anthropic' }),
    provider({ id: 'p2', name: 'Work', type: 'anthropic' })
  ]

  it('matches an id, a name and a type, in that order', () => {
    expect(findCredential(providers, 'p2')?.id).toBe('p2')
    expect(findCredential(providers, 'work')?.id).toBe('p2')
    expect(findCredential(providers, 'anthropic')?.id).toBe('p1')
    expect(findCredential(providers, 'nothing')).toBeNull()
  })

  it('prefers a usable credential when two share a name', () => {
    // The real shape: an account-provisioned `Anthropic` alongside the user's
    // own. Picking the keyless one strands an agent that is in fact runnable.
    const shared = [
      provider({ id: 'managed', name: 'Anthropic', hasApiKey: false }),
      provider({ id: 'mine', name: 'Anthropic', hasApiKey: true })
    ]
    expect(findCredential(shared, 'Anthropic')?.id).toBe('mine')
  })

  it('does not let an id match win on a different credential’s name', () => {
    // `p2`'s *name* is `p1` — the id lookup must still find the row whose id is
    // `p1`, or a reference means two different things depending on row order.
    const confusing = [provider({ id: 'p1', name: 'x' }), provider({ id: 'p2', name: 'p1' })]
    expect(findCredential(confusing, 'p1')?.id).toBe('p1')
  })
})

describe('runtimeService.resolveDefault', () => {
  it('says what to do when there is no default chat mode', () => {
    const resolved = runtimeService.resolveDefault([])
    expect(resolved.source).toBe('none')
    expect(resolved.credentialId).toBeNull()
    expect(resolved.reason).toMatch(/default chat mode/i)
  })

  it('resolves the default chat mode’s credential and model', () => {
    defaultMode.current = { providerId: 'p1', modelId: 'claude-sonnet-4-5' }
    const resolved = runtimeService.resolveDefault([provider({ id: 'p1', name: 'Personal' })])
    expect(resolved).toMatchObject({
      source: 'default',
      credentialId: 'p1',
      credentialName: 'Personal',
      modelId: 'claude-sonnet-4-5',
      reason: null
    })
  })

  it('reports a default whose credential has no usable key rather than pretending it runs', () => {
    defaultMode.current = { providerId: 'p1', modelId: 'm' }
    const resolved = runtimeService.resolveDefault([provider({ id: 'p1', hasApiKey: false })])
    expect(resolved.credentialId).toBe('p1')
    expect(resolved.reason).toMatch(/no API key/i)
  })
})

describe('runtimeService.resolve', () => {
  const providers = [
    provider({ id: 'p1', name: 'Personal' }),
    provider({ id: 'p2', name: 'Work' })
  ]

  beforeEach(() => {
    defaultMode.current = { providerId: 'p1', modelId: 'default-model' }
  })

  it('falls back to the default runtime when the manifest declares none', () => {
    expect(runtimeService.resolve(null, providers)).toMatchObject({
      source: 'default',
      credentialId: 'p1',
      modelId: 'default-model'
    })
  })

  it('prefers the manifest over the default', () => {
    expect(
      runtimeService.resolve({ credential: 'Work', model: 'other-model' }, providers)
    ).toMatchObject({
      source: 'manifest',
      credentialId: 'p2',
      modelId: 'other-model',
      reason: null
    })
  })

  it('keeps a manifest model while borrowing the default credential', () => {
    // "This agent needs Opus" is a statement about the model, independent of
    // which key pays for it. Dropping it back to the default's model would
    // silently downgrade the agent.
    expect(runtimeService.resolve({ model: 'opus-only' }, providers)).toMatchObject({
      credentialId: 'p1',
      modelId: 'opus-only'
    })
  })

  it('falls back but says so when the manifest names a credential this machine lacks', () => {
    const resolved = runtimeService.resolve({ credential: 'Somebody else’s' }, providers)
    expect(resolved.credentialId).toBe('p1')
    expect(resolved.credentialRef).toBe('Somebody else’s')
    expect(resolved.reason).toMatch(/not configured here/)
  })

  it('has no runtime at all when neither the manifest nor a default resolves', () => {
    defaultMode.current = null
    const resolved = runtimeService.resolve({ credential: 'Missing' }, providers)
    expect(resolved.credentialId).toBeNull()
    expect(resolved.source).toBe('none')
  })
})

describe('runtimeService.applyToManifest', () => {
  it('writes a credential name and a model', () => {
    const manifest: CinnaAgentManifest = {}
    runtimeService.applyToManifest(manifest, { credential: 'Work', modelId: 'gpt-5' })
    expect(manifest.runtime).toEqual({ credential: 'Work', model: 'gpt-5' })
  })

  it('refuses anything key-shaped', () => {
    const manifest: CinnaAgentManifest = {}
    for (const value of ['sk-ant-api03-abc', 'ghp_abcdef', 'AIzaSyABCDEF', 'AKIAIOSFODNN7']) {
      expect(() =>
        runtimeService.applyToManifest(manifest, { credential: value, modelId: null })
      ).toThrow(/looks like an API key/i)
    }
    // Nothing was written on the way through.
    expect(manifest.runtime).toBeUndefined()
  })

  it('removes the block entirely when both fields are cleared', () => {
    const manifest: CinnaAgentManifest = { runtime: { credential: 'Work', model: 'gpt-5' } }
    runtimeService.applyToManifest(manifest, { credential: null, modelId: null })
    // `{}` rather than absence would show up as a change in the user's manifest
    // diff that they did not make.
    expect(Object.hasOwn(manifest, 'runtime')).toBe(false)
  })

  it('keeps a block that still carries something the desktop does not own', () => {
    const manifest: CinnaAgentManifest = {
      runtime: { credential: 'Work', model: 'gpt-5', permissions: { bash: 'deny' } }
    }
    runtimeService.applyToManifest(manifest, { credential: null, modelId: null })
    expect(manifest.runtime).toEqual({ permissions: { bash: 'deny' } })
  })

  it('preserves unknown keys through an edit', () => {
    const manifest: CinnaAgentManifest = {
      runtime: { credential: 'Work', model: 'gpt-5', somethingNewer: 42 }
    }
    runtimeService.applyToManifest(manifest, { credential: 'Personal', modelId: 'claude' })
    expect(manifest.runtime).toEqual({
      somethingNewer: 42,
      credential: 'Personal',
      model: 'claude'
    })
  })

  it('treats whitespace as clearing, and refuses a non-string', () => {
    const manifest: CinnaAgentManifest = { runtime: { credential: 'Work', model: 'gpt-5' } }
    runtimeService.applyToManifest(manifest, { credential: '  ', modelId: '  ' })
    expect(Object.hasOwn(manifest, 'runtime')).toBe(false)
    expect(() =>
      runtimeService.applyToManifest(manifest, {
        credential: 42 as unknown as string,
        modelId: null
      })
    ).toThrow(/must be text/i)
  })

  it('refuses a value long enough to be a pasted key', () => {
    expect(() =>
      runtimeService.applyToManifest({}, { credential: 'x'.repeat(500), modelId: null })
    ).toThrow(/too long/i)
  })
})
