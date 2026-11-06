import { describe, expect, it, vi } from 'vitest'

// The production deps reach the database and the keystore; every test here
// injects its own, so only the module graph needs to load.
vi.mock('../appSettingsService', () => ({ appSettingsService: { getAll: vi.fn() } }))
vi.mock('../providerService', () => ({ providerService: { listMerged: vi.fn() } }))
vi.mock('../../db/llmProviders', () => ({ llmProviderRepo: { getOwned: vi.fn() } }))
vi.mock('../../auth/scope', () => ({ getManagedResourceScopes: () => [] }))
vi.mock('../../security/keystore', () => ({ decryptApiKey: vi.fn() }))
vi.mock('./runtimeService', () => ({ runtimeService: { resolveDefault: vi.fn() } }))

const {
  createClaudeAuthService,
  CLAUDE_API_CREDENTIAL_GONE,
  CLAUDE_API_KEY_UNREADABLE,
  CLAUDE_API_NO_CREDENTIAL,
  SUBSCRIPTION_FINGERPRINT
} = await import('./claudeAuthService')
type Deps = Parameters<typeof createClaudeAuthService>[0]

const provider = (id: string, over: Record<string, unknown> = {}) => ({
  id, type: 'anthropic', name: id, enabled: true, hasApiKey: true, managed: false, adminManaged: false,
  unsupported: false, defaultModelId: null, baseUrl: null, createdAt: new Date(0), ...over
})

function service(over: {
  mode?: string
  chosen?: string
  providers?: ReturnType<typeof provider>[]
  preferred?: string | null
  secrets?: Record<string, { apiKey: string; baseUrl: string | null } | null | Error>
} = {}) {
  const state = {
    mode: over.mode ?? 'api_key',
    chosen: over.chosen ?? '',
    providers: over.providers ?? [provider('one')],
    secrets: over.secrets ?? { one: { apiKey: 'sk-ant-one', baseUrl: null } }
  }
  const deps: NonNullable<Deps> = {
    settings: () => ({ claudeAuthMode: state.mode, claudeApiCredentialId: state.chosen }),
    providers: () => state.providers as never,
    preferredCredentialId: () => over.preferred ?? null,
    secret: async (id) => {
      const value = state.secrets[id]
      if (value instanceof Error) throw value
      return value ?? null
    }
  }
  return { svc: createClaudeAuthService(deps), state }
}

describe('claudeAuthService.resolve', () => {
  it('subscription: no credential, a fixed fingerprint', async () => {
    const { svc } = service({ mode: 'subscription' })
    expect(await svc.resolve()).toEqual({ mode: 'subscription', fingerprint: SUBSCRIPTION_FINGERPRINT })
    expect(svc.mode()).toBe('subscription')
  })

  it('an unknown stored mode reads as the subscription', async () => {
    expect((await service({ mode: 'bedrock' }).svc.resolve()).mode).toBe('subscription')
  })

  it('API mode: the picked credential’s decrypted key and endpoint', async () => {
    const { svc } = service({ secrets: { one: { apiKey: 'sk-ant-one', baseUrl: 'https://gw.example' } } })
    const auth = (await svc.resolve())
    expect(auth).toMatchObject({ mode: 'api_key', credential: { apiKey: 'sk-ant-one', baseUrl: 'https://gw.example' } })
    // A digest, never the key itself.
    expect(auth.fingerprint).toMatch(/^api_key:[0-9a-f]{16}$/)
    expect(auth.fingerprint).not.toContain('sk-ant-one')
  })

  it('automatic prefers the Default AI credential when it is Anthropic', async () => {
    const { svc } = service({
      providers: [provider('one'), provider('two')], preferred: 'two',
      secrets: { one: { apiKey: 'k1', baseUrl: null }, two: { apiKey: 'k2', baseUrl: null } }
    })
    expect(await svc.resolve()).toMatchObject({ credential: { apiKey: 'k2' } })
  })

  it('no qualifying credential refuses — never the subscription', async () => {
    const { svc } = service({ providers: [provider('one', { enabled: false }), provider('oat', { unsupported: true })] })
    const auth = (await svc.resolve())
    expect(auth).toMatchObject({ mode: 'api_key', error: CLAUDE_API_NO_CREDENTIAL })
    expect(auth.fingerprint).not.toBe(SUBSCRIPTION_FINGERPRINT)
  })

  it('a named credential that is gone refuses, even when another key exists', async () => {
    const { svc } = service({ chosen: 'deleted', providers: [provider('one')] })
    expect(await svc.resolve()).toMatchObject({ mode: 'api_key', error: CLAUDE_API_CREDENTIAL_GONE })
  })

  it('a key the keystore will not decrypt refuses', async () => {
    expect((await service({ secrets: { one: new Error('keychain locked') } }).svc.resolve()))
      .toMatchObject({ mode: 'api_key', error: CLAUDE_API_KEY_UNREADABLE })
    expect((await service({ secrets: { one: null } }).svc.resolve()))
      .toMatchObject({ error: CLAUDE_API_KEY_UNREADABLE })
  })

  it('the fingerprint moves with the mode, the credential and a rotated key — and only then', async () => {
    const { svc, state } = service({
      providers: [provider('one'), provider('two')],
      secrets: { one: { apiKey: 'k1', baseUrl: null }, two: { apiKey: 'k2', baseUrl: null } }
    })
    const first = (await svc.fingerprint())
    expect(await svc.fingerprint()).toBe(first)
    state.chosen = 'two'
    const second = (await svc.fingerprint())
    expect(second).not.toBe(first)
    state.secrets = { ...state.secrets, two: { apiKey: 'k2-rotated', baseUrl: null } }
    expect(await svc.fingerprint()).not.toBe(second)
    state.mode = 'subscription'
    expect(await svc.fingerprint()).toBe(SUBSCRIPTION_FINGERPRINT)
  })
})
