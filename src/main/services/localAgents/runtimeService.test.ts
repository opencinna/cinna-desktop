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
  () => ({ current: null as { providerId: string; modelId: string | null } | null })
)

vi.mock('../chatModeService', () => ({
  chatModeService: { resolveEffectiveDefault: () => defaultMode.current }
}))
vi.mock('../providerService', () => ({ providerService: { listMerged: () => [] } }))
const pinnedCredential = vi.hoisted(() => ({ current: '' }))
vi.mock('../appSettingsService', () => ({
  appSettingsService: {
    getAll: () => ({ localAgentsDefaultCredentialId: pinnedCredential.current })
  }
}))
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
    baseUrl: null,
    managed: false,
    adminManaged: false,
    unsupported: false,
    createdAt: new Date(0),
    ...overrides
  }
}

beforeEach(() => {
  defaultMode.current = null
  pinnedCredential.current = ''
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

  it('falls through to the credential’s own default when the mode names no model', () => {
    // A default mode on "First available". `resolve` returns this object
    // verbatim for an agent with no runtime block, so a null here is an agent
    // the engine drops for naming no model.
    defaultMode.current = { providerId: 'p1', modelId: null }
    const resolved = runtimeService.resolveDefault([
      provider({ id: 'p1', name: 'Personal', defaultModelId: 'claude-opus-4-1' })
    ])
    expect(resolved.modelId).toBe('claude-opus-4-1')
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

  describe('this machine’s pinned credential', () => {
    it('wins over the default chat mode, with its own default model', () => {
      // Settings → Local Agents → Default AI credential. Which key the engine
      // spends is a property of the machine, not of a chat preference that
      // syncs with the profile.
      defaultMode.current = { providerId: 'p1', modelId: 'claude-sonnet-4-5' }
      pinnedCredential.current = 'p2'
      const resolved = runtimeService.resolveDefault([
        provider({ id: 'p1', name: 'Personal' }),
        provider({ id: 'p2', name: 'Team', type: 'openai', defaultModelId: 'gpt-5' })
      ])
      expect(resolved).toMatchObject({
        source: 'default',
        credentialId: 'p2',
        credentialName: 'Team',
        // Not `claude-sonnet-4-5`: the mode's model belongs to the mode's
        // credential, and lending it to a different key would name a model that
        // key may not have.
        modelId: 'gpt-5',
        reason: null
      })
    })

    it('falls through to the chat mode when the pin names a credential this machine lost', () => {
      // A stale setting must not strand every agent on the machine — the
      // runtime they had before the pin was set is a better answer than none.
      defaultMode.current = { providerId: 'p1', modelId: 'claude-sonnet-4-5' }
      pinnedCredential.current = 'deleted'
      const resolved = runtimeService.resolveDefault([provider({ id: 'p1', name: 'Personal' })])
      expect(resolved.credentialId).toBe('p1')
      expect(resolved.reason).toBeNull()
    })

    it('reports a pinned credential with no usable key rather than silently switching keys', () => {
      // It does **not** fall back here, and the settings copy says so. Silently
      // re-pointing at another key is the billing surprise this module refuses.
      defaultMode.current = { providerId: 'p1', modelId: 'm' }
      pinnedCredential.current = 'p2'
      const resolved = runtimeService.resolveDefault([
        provider({ id: 'p1', name: 'Personal' }),
        provider({ id: 'p2', name: 'Team', hasApiKey: false })
      ])
      expect(resolved.credentialId).toBe('p2')
      expect(resolved.reason).toMatch(/no API key/i)
    })

    it('is ignored when empty, which is the default', () => {
      defaultMode.current = { providerId: 'p1', modelId: 'm' }
      const resolved = runtimeService.resolveDefault([provider({ id: 'p1', name: 'Personal' })])
      expect(resolved.credentialId).toBe('p1')
    })
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

  it('gives an agent with no runtime block the same model the panel shows it', () => {
    defaultMode.current = { providerId: 'p1', modelId: null }
    const own = [provider({ id: 'p1', name: 'Personal', defaultModelId: 'claude-opus-4-1' })]
    expect(runtimeService.resolve(null, own).modelId).toBe('claude-opus-4-1')
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

  it('does not lend the default’s model to a credential that is not the default’s', () => {
    // The engine builds `<credential>/<model>` verbatim, so an OpenAI
    // credential carrying the default mode's `claude-…` is a config that saves
    // and then fails on the agent's first turn.
    const mixed = [
      provider({ id: 'p1', name: 'Personal' }),
      provider({ id: 'p3', name: 'OpenAI', type: 'openai' })
    ]
    const resolved = runtimeService.resolve({ credential: 'OpenAI' }, mixed)
    expect(resolved.credentialId).toBe('p3')
    expect(resolved.modelId).toBeNull()
    expect(resolved.reason).toMatch(/No models listed for this credential/)
  })

  it('keeps the default’s model on a second credential of the same type', () => {
    // A personal Anthropic key beside the account-provisioned one. The model id
    // is the provider's, not the row's, so this pairing runs — dropping it would
    // silently take a working agent off the air.
    const two = [provider({ id: 'p1', name: 'Personal' }), provider({ id: 'p2', name: 'Mine' })]
    expect(runtimeService.resolve({ credential: 'Mine' }, two)).toMatchObject({
      credentialId: 'p2',
      modelId: 'default-model',
      reason: null
    })
  })

  it('falls through to the credential’s own default when the mode names no model', () => {
    // The chat mode's "First available": `modelId` is null, and the credential's
    // own default is what the user set in Settings → AI Credentials.
    defaultMode.current = { providerId: 'p1', modelId: null }
    const own = [provider({ id: 'p1', name: 'Personal', defaultModelId: 'claude-opus-4-1' })]
    expect(runtimeService.resolve({ credential: 'Personal' }, own)).toMatchObject({
      credentialId: 'p1',
      modelId: 'claude-opus-4-1'
    })
  })

  it('uses the chosen credential’s own default model when it has one', () => {
    const mixed = [
      provider({ id: 'p1', name: 'Personal' }),
      provider({ id: 'p3', name: 'OpenAI', type: 'openai', defaultModelId: 'gpt-5' })
    ]
    expect(runtimeService.resolve({ credential: 'OpenAI' }, mixed)).toMatchObject({
      credentialId: 'p3',
      modelId: 'gpt-5',
      reason: null
    })
  })

  it('does not lend a model between two openai_compatible gateways', () => {
    // Same type, two different catalogues that merely share a wire format.
    defaultMode.current = { providerId: 'g1', modelId: 'llama-3.1-70b' }
    const gateways = [
      provider({ id: 'g1', name: 'Gateway A', type: 'openai_compatible' }),
      provider({ id: 'g2', name: 'Gateway B', type: 'openai_compatible' })
    ]
    expect(runtimeService.resolve({ credential: 'Gateway B' }, gateways).modelId).toBeNull()
  })

  it('still borrows the default’s model when the manifest names the default’s credential', () => {
    expect(runtimeService.resolve({ credential: 'Personal' }, providers)).toMatchObject({
      credentialId: 'p1',
      modelId: 'default-model'
    })
  })

  it('falls back but says so when the manifest names a credential this machine lacks', () => {
    const resolved = runtimeService.resolve({ credential: 'Somebody else’s' }, providers)
    expect(resolved.credentialId).toBe('p1')
    expect(resolved.credentialRef).toBe('Somebody else’s')
    expect(resolved.reason).toMatch(/not configured on this machine/)
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
    runtimeService.applyToManifest(manifest, { credential: 'Work', modelId: 'gpt-5', complexity: null })
    expect(manifest.runtime).toEqual({ credential: 'Work', model: 'gpt-5' })
  })

  it('refuses anything key-shaped', () => {
    const manifest: CinnaAgentManifest = {}
    for (const value of ['sk-ant-api03-abc', 'ghp_abcdef', 'AIzaSyABCDEF', 'AKIAIOSFODNN7']) {
      expect(() =>
        runtimeService.applyToManifest(manifest, { credential: value, modelId: null, complexity: null })
      ).toThrow(/looks like an API key/i)
    }
    // Nothing was written on the way through.
    expect(manifest.runtime).toBeUndefined()
  })

  it('removes the block entirely when both fields are cleared', () => {
    const manifest: CinnaAgentManifest = { runtime: { credential: 'Work', model: 'gpt-5' } }
    runtimeService.applyToManifest(manifest, { credential: null, modelId: null, complexity: null })
    // `{}` rather than absence would show up as a change in the user's manifest
    // diff that they did not make.
    expect(Object.hasOwn(manifest, 'runtime')).toBe(false)
  })

  it('keeps a block that still carries something the desktop does not own', () => {
    const manifest: CinnaAgentManifest = {
      runtime: { credential: 'Work', model: 'gpt-5', permissions: { bash: 'deny' } }
    }
    runtimeService.applyToManifest(manifest, { credential: null, modelId: null, complexity: null })
    expect(manifest.runtime).toEqual({ permissions: { bash: 'deny' } })
  })

  it('preserves unknown keys through an edit', () => {
    const manifest: CinnaAgentManifest = {
      runtime: { credential: 'Work', model: 'gpt-5', somethingNewer: 42 }
    }
    runtimeService.applyToManifest(manifest, { credential: 'Personal', modelId: 'claude', complexity: null })
    expect(manifest.runtime).toEqual({
      somethingNewer: 42,
      credential: 'Personal',
      model: 'claude'
    })
  })

  it('treats whitespace as clearing, and refuses a non-string', () => {
    const manifest: CinnaAgentManifest = { runtime: { credential: 'Work', model: 'gpt-5' } }
    runtimeService.applyToManifest(manifest, { credential: '  ', modelId: '  ', complexity: null })
    expect(Object.hasOwn(manifest, 'runtime')).toBe(false)
    expect(() =>
      runtimeService.applyToManifest(manifest, {
        credential: 42 as unknown as string,
        modelId: null,
        complexity: null
      })
    ).toThrow(/must be text/i)
  })

  it('refuses a value long enough to be a pasted key', () => {
    expect(() =>
      runtimeService.applyToManifest({}, { credential: 'x'.repeat(500), modelId: null, complexity: null })
    ).toThrow(/too long/i)
  })
})

/**
 * Work Complexity, on the resolution side.
 *
 * These are the assertions that stop the engine and the "Runs with" panel
 * drifting apart: both call `resolveRuntimeModel`, so what is tested here is
 * that `resolve` feeds it the right catalogue (the *chosen* credential's, not
 * the aggregate registry) and reports what came back honestly enough for the
 * panel and the skip list to explain themselves.
 */
describe('resolve — work complexity', () => {
  const anthropic = provider({ id: 'p1', name: 'Anthropic', type: 'anthropic' })
  const openai = provider({ id: 'p2', name: 'OpenAI', type: 'openai' })
  const providers = [anthropic, openai]
  const catalogue = [
    { id: 'claude-haiku-4-5', providerId: 'p1' },
    { id: 'claude-sonnet-4-5', providerId: 'p1' },
    { id: 'claude-opus-4-1-20250805', providerId: 'p1' },
    { id: 'gpt-5-mini', providerId: 'p2' },
    { id: 'gpt-5', providerId: 'p2' }
  ]

  it('resolves a tier against the chosen credential, not the whole registry', () => {
    const result = runtimeService.resolve(
      { credential: 'OpenAI', complexity: 'simple' },
      providers,
      catalogue
    )
    expect(result.modelId).toBe('gpt-5-mini')
    expect(result.modelSource).toBe('tier')
    expect(result.reason).toBeNull()
  })

  it('does not lend one credential’s catalogue to another of the same type', () => {
    // Two OpenAI keys — a personal one and an account-provisioned one — is a
    // shape this app supports, and they do not list the same models. Filtering
    // by provider *type* instead of by row would resolve a tier to a model the
    // chosen key cannot call, which fails on the agent's first turn.
    const second = provider({ id: 'p3', name: 'Work OpenAI', type: 'openai' })
    const split = [
      { id: 'gpt-5-mini', providerId: 'p2' },
      { id: 'gpt-4o-mini', providerId: 'p3' }
    ]
    const result = runtimeService.resolve(
      { credential: 'Work OpenAI', complexity: 'simple' },
      [...providers, second],
      split
    )
    expect(result.modelId).toBe('gpt-4o-mini')
  })

  it('does not call a model current because a sibling credential lists it', () => {
    const second = provider({ id: 'p3', name: 'Work OpenAI', type: 'openai' })
    const split = [
      { id: 'gpt-5.4-mini', providerId: 'p2' },
      { id: 'gpt-5.5-mini', providerId: 'p3' }
    ]
    const result = runtimeService.resolve(
      { credential: 'Work OpenAI', model: 'gpt-5.4-mini' },
      [...providers, second],
      split
    )
    expect(result.modelId).toBe('gpt-5.5-mini')
    expect(result.modelSource).toBe('substituted')
  })

  it('says so, and runs nothing, when the credential lists no model in the tier', () => {
    const result = runtimeService.resolve(
      { credential: 'OpenAI', complexity: 'complex' },
      providers,
      catalogue
    )
    expect(result.modelId).toBeNull()
    // Action first: this line truncates at the 800px minimum window, so the
    // half that survives has to be the half the user can act on.
    expect(result.reason).toMatch(/^Pick another complexity or another credential/)
    expect(result.reason).toMatch(/OpenAI lists no model for Complex work/)
  })

  it('does not claim a catalogue lists nothing when none was read', () => {
    const result = runtimeService.resolve({ credential: 'OpenAI', complexity: 'simple' }, providers)
    expect(result.reason).toMatch(/model list has not loaded/i)
  })

  it('borrows nothing from the default runtime when a tier comes up empty', () => {
    defaultMode.current = { providerId: 'p1', modelId: 'claude-opus-4-1-20250805' }
    const result = runtimeService.resolve(
      { credential: 'OpenAI', complexity: 'complex' },
      providers,
      catalogue
    )
    // The user asked for Complex on OpenAI. Quietly running Anthropic's Opus
    // would be a different tier *and* a different bill.
    expect(result.modelId).toBeNull()
  })

  it('resolves a tier against the fallback credential when the named one is missing', () => {
    // A cloned folder naming a colleague's credential. The panel falls back to
    // the default runtime's credential and resolves the tier against *its*
    // catalogue, so this must too — labelling the select `Simple (Haiku)` while
    // the engine built the default mode's Sonnet is the panel-predicts-a-
    // different-runtime defect, and a bill for work declared simple.
    defaultMode.current = { providerId: 'p1', modelId: 'claude-sonnet-4-5' }
    const result = runtimeService.resolve(
      { credential: 'Anthropic Work', complexity: 'simple' },
      providers,
      catalogue
    )
    expect(result.modelId).toBe('claude-haiku-4-5')
    expect(result.modelSource).toBe('tier')
    expect(result.reason).toMatch(/not configured on this machine/)
  })

  it('substitutes against the fallback credential’s catalogue too', () => {
    defaultMode.current = { providerId: 'p2', modelId: null }
    const retired = [
      { id: 'gpt-5.5-mini', providerId: 'p2' },
      { id: 'gpt-5', providerId: 'p2' }
    ]
    const result = runtimeService.resolve(
      { credential: 'Nope', model: 'gpt-5.4-mini' },
      providers,
      retired
    )
    expect(result.modelId).toBe('gpt-5.5-mini')
    expect(result.modelSource).toBe('substituted')
  })

  it('substitutes the nearest sibling for a model the catalogue dropped, and says which', () => {
    const retired = [
      { id: 'gpt-5.5-mini', providerId: 'p2' },
      { id: 'gpt-5', providerId: 'p2' }
    ]
    const result = runtimeService.resolve(
      { credential: 'OpenAI', model: 'gpt-5.4-mini' },
      providers,
      retired
    )
    expect(result.modelId).toBe('gpt-5.5-mini')
    expect(result.modelSource).toBe('substituted')
    expect(result.replacedModelId).toBe('gpt-5.4-mini')
  })

  it('leaves a declared model alone when the credential lists nothing to check it against', () => {
    // A gateway that does not implement `/models`. "Nothing lists it" must not
    // read as "it is stale".
    const result = runtimeService.resolve(
      { credential: 'OpenAI', model: 'some-gateway-model' },
      providers,
      []
    )
    expect(result.modelId).toBe('some-gateway-model')
    expect(result.modelSource).toBe('declared')
  })

  it('floors an otherwise model-less agent at Medium on the credential it was given', () => {
    // The dead end this replaces: a default chat mode on "First available",
    // a credential with no default model, and an agent that could not run.
    defaultMode.current = { providerId: 'p1', modelId: null }
    const result = runtimeService.resolve(null, providers, catalogue)
    expect(result.modelId).toBe('claude-sonnet-4-5')
    expect(result.modelSource).toBe('floor')
    expect(result.reason).toBeNull()
  })

  it('never floors onto a credential the user did not choose', () => {
    defaultMode.current = null
    const result = runtimeService.resolve(null, providers, catalogue)
    expect(result.credentialId).toBeNull()
    expect(result.modelId).toBeNull()
    expect(result.reason).toMatch(/default chat mode/i)
  })

  it('still prefers the default runtime’s own model over the floor', () => {
    defaultMode.current = { providerId: 'p1', modelId: 'claude-opus-4-1-20250805' }
    const result = runtimeService.resolve(null, providers, catalogue)
    expect(result.modelId).toBe('claude-opus-4-1-20250805')
    expect(result.modelSource).toBe('inherited')
  })

  it('reports the default runtime’s own complaint for an agent that declares nothing', () => {
    defaultMode.current = { providerId: 'p3', modelId: null }
    const result = runtimeService.resolve(null, providers, catalogue)
    expect(result.reason).toMatch(/no longer has/i)
  })
})

describe('applyToManifest — work complexity', () => {
  it('writes a tier and clears the model it replaces', () => {
    const manifest: CinnaAgentManifest = { runtime: { credential: 'Work', model: 'gpt-5' } }
    runtimeService.applyToManifest(manifest, {
      credential: 'Work',
      modelId: null,
      complexity: 'medium'
    })
    expect(manifest.runtime).toEqual({ credential: 'Work', complexity: 'medium' })
  })

  it('writes a model and clears the tier it replaces', () => {
    const manifest: CinnaAgentManifest = { runtime: { credential: 'Work', complexity: 'medium' } }
    runtimeService.applyToManifest(manifest, {
      credential: 'Work',
      modelId: 'gpt-5',
      complexity: null
    })
    expect(manifest.runtime).toEqual({ credential: 'Work', model: 'gpt-5' })
  })

  it('refuses both at once rather than inventing a precedence', () => {
    expect(() =>
      runtimeService.applyToManifest(
        {},
        { credential: null, modelId: 'gpt-5', complexity: 'simple' }
      )
    ).toThrow(/not both/i)
  })

  it('refuses a tier the contract does not define', () => {
    expect(() =>
      runtimeService.applyToManifest({}, {
        credential: null,
        modelId: null,
        complexity: 'extreme' as never
      })
    ).toThrow(/simple, medium or complex/i)
  })

  it('removes the runtime block when the tier is cleared too', () => {
    const manifest: CinnaAgentManifest = { runtime: { complexity: 'complex' } }
    runtimeService.applyToManifest(manifest, {
      credential: null,
      modelId: null,
      complexity: null
    })
    expect(Object.hasOwn(manifest, 'runtime')).toBe(false)
  })

  it('preserves unknown runtime keys across a tier write', () => {
    const manifest: CinnaAgentManifest = {
      runtime: { model: 'gpt-5', permissions: { bash: 'ask' }, future: 1 }
    }
    runtimeService.applyToManifest(manifest, {
      credential: null,
      modelId: null,
      complexity: 'simple'
    })
    expect(manifest.runtime).toEqual({ permissions: { bash: 'ask' }, future: 1, complexity: 'simple' })
  })
})
