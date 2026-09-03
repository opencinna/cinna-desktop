import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { EngineConfigInput } from './configGenerator'

/**
 * Turning this desktop's state into the engine's config input.
 *
 * This module had **no test at all** when Phase 5 was interrupted, and it is
 * the one its own header calls "the one place a decrypted API key is read".
 * Everything around it was covered: `configGenerator` proves a key never
 * reaches the config file, `engineManager` proves the child's environment is
 * narrow. Neither says anything about *which* credentials get collected, or
 * what happens to the rest when one of them will not decrypt.
 *
 * Two properties carry this file, and neither is visible in the types:
 *
 * 1. **One bad credential must not take the engine down with it.** A keychain
 *    entry that will not decrypt — a restored machine, a changed login
 *    keychain, an OS upgrade — is a per-credential problem. Failing the whole
 *    collection would mean one stale row makes every local agent unrunnable.
 * 2. **An agent whose runtime does not resolve is still collected.** It is
 *    `configGenerator` that decides to skip it, and it records *why* when it
 *    does. Dropping the agent here instead loses the reason, and the Runtime
 *    card can then only say the agent is absent rather than what to fix.
 *
 * Every assertion below was mutation-checked against the code it covers.
 */

interface ProviderRow {
  id: string
  apiKeyEncrypted: Buffer | null
  baseUrl: string | null
}

const state = vi.hoisted(() => ({
  dtos: [] as Record<string, unknown>[],
  rows: [] as Record<string, unknown>[],
  scopes: [] as string[],
  scopesAsked: 0,
  models: [] as { id: string; name: string; providerId: string }[],
  modelsThrows: false,
  modelFetches: 0,
  agents: [] as Record<string, unknown>[],
  runtimes: {} as Record<string, { credentialId: string | null; modelId: string | null }>,
  decryptFails: new Set<string>(),
  logged: [] as { message: string; meta: unknown }[]
}))

vi.mock('../logger/logger', () => ({
  createLogger: () => ({
    debug: () => {},
    info: () => {},
    warn: (message: string, meta: unknown) => state.logged.push({ message, meta }),
    error: (message: string, meta: unknown) => state.logged.push({ message, meta })
  })
}))
vi.mock('../security/keystore', () => ({
  // The ciphertext in these tests is just the plaintext with a marker, so a
  // test can assert on the *decrypted* value without a real keychain.
  decryptApiKey: (buffer: Buffer): string => {
    const value = buffer.toString('utf8')
    if (state.decryptFails.has(value)) throw new Error('the keychain refused this item')
    return value
  }
}))
vi.mock('../db/llmProviders', () => ({
  llmProviderRepo: {
    listByUserIds: (userIds: string[]) =>
      state.rows.filter((row) => userIds.includes(row.userId as string))
  }
}))
vi.mock('../auth/scope', () => ({
  getManagedResourceScopes: () => {
    state.scopesAsked += 1
    return state.scopes
  }
}))
vi.mock('../llm/registry', () => ({
  getAllModels: async () => {
    state.modelFetches += 1
    if (state.modelsThrows) throw new Error('the gateway is unreachable')
    return state.models
  }
}))
vi.mock('../services/providerService', () => ({
  providerService: { listMerged: () => state.dtos }
}))
vi.mock('../services/localAgents/localAgentService', () => ({
  localAgentService: { list: () => ({ agents: state.agents, roots: [] }) }
}))
vi.mock('../services/localAgents/runtimeService', () => ({
  runtimeService: {
    resolve: (runtime: { credential?: string } | null | undefined) => ({
      source: 'manifest',
      credentialRef: null,
      credentialName: null,
      credentialType: null,
      reason: null,
      ...(state.runtimes[runtime?.credential ?? '_default'] ?? {
        credentialId: null,
        modelId: null
      })
    })
  }
}))
vi.mock('../services/localAgents/promptAssembly', () => ({
  assembleAgentPrompt: (agentDir: string) => `PROMPT FOR ${agentDir}`,
  resolveDesktopPromptContext: () => ({ locale: 'en-GB', timeZone: 'Europe/Berlin' })
}))

const { collectEngineAgents, collectEngineConfigInput, collectEngineProviders, refreshModelCache } =
  await import('./engineConfigSource')
// The **real** generator, deliberately not mocked: the question this file has
// to answer is what happens to a decrypted key on its way to disk, and a mocked
// generator answers it by assumption.
const { buildEngineConfig, writeEngineConfig } = await import('./configGenerator')

function dto(overrides: Record<string, unknown> = {}): Record<string, unknown> {
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

function row(overrides: Partial<ProviderRow> & { userId?: string } = {}): Record<string, unknown> {
  return {
    id: 'p1',
    userId: 'default',
    apiKeyEncrypted: Buffer.from('sk-ant-THE-SECRET', 'utf8'),
    baseUrl: null,
    ...overrides
  }
}

function agent(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: 'folder:aaa',
    slug: 'invoices',
    description: 'Reads invoices.',
    path: '/agents/invoices',
    readiness: 'ok',
    manifest: { name: 'Invoices' },
    runtime: null,
    ...overrides
  }
}

beforeEach(() => {
  state.dtos = []
  state.rows = []
  state.scopes = ['default']
  state.scopesAsked = 0
  state.models = []
  state.modelsThrows = false
  state.modelFetches = 0
  state.agents = []
  state.runtimes = { _default: { credentialId: 'p1', modelId: 'claude-sonnet-4-5' } }
  state.decryptFails = new Set()
  state.logged = []
})

describe('collectEngineProviders', () => {
  it('decrypts the key of a usable credential and passes it through', () => {
    state.dtos = [dto()]
    state.rows = [row()]
    const [provider] = collectEngineProviders()
    expect(provider).toMatchObject({
      id: 'p1',
      type: 'anthropic',
      name: 'Anthropic',
      apiKey: 'sk-ant-THE-SECRET',
      baseUrl: null
    })
  })

  it('carries a gateway’s base URL through from the row, not the DTO', () => {
    // `baseUrl` is not on `ProviderDto` at all — it lives only on the row — so
    // this is the one path by which an OpenAI-compatible credential can reach
    // the generator in a usable state. Reading it from the DTO would be
    // `undefined` and the generator would skip the credential as having no
    // base URL, which reads to the user as "my gateway stopped working".
    state.dtos = [dto({ id: 'gw', type: 'openai_compatible', name: 'Gateway' })]
    state.rows = [row({ id: 'gw', baseUrl: 'https://gw.example.com/v1' })]
    expect(collectEngineProviders()[0].baseUrl).toBe('https://gw.example.com/v1')
  })

  it('excludes a credential with no key, and one this app cannot call', () => {
    state.dtos = [
      dto({ id: 'no-key', hasApiKey: false }),
      // A managed Anthropic OAuth token: a real credential, but not an API key.
      dto({ id: 'oauth', unsupported: true }),
      dto({ id: 'fine' })
    ]
    state.rows = [row({ id: 'no-key' }), row({ id: 'oauth' }), row({ id: 'fine' })]
    expect(collectEngineProviders().map((provider) => provider.id)).toEqual(['fine'])
  })

  it('excludes a credential whose row holds no ciphertext, and one that decrypts to nothing', () => {
    state.dtos = [dto({ id: 'no-cipher' }), dto({ id: 'empty' }), dto({ id: 'fine' })]
    state.rows = [
      row({ id: 'no-cipher', apiKeyEncrypted: null }),
      row({ id: 'empty', apiKeyEncrypted: Buffer.from('', 'utf8') }),
      row({ id: 'fine' })
    ]
    expect(collectEngineProviders().map((provider) => provider.id)).toEqual(['fine'])
  })

  it('excludes a credential with no row in any scope this user can reach', () => {
    // `listMerged` unions the Default scope with the active profile's managed
    // rows; `listByUserIds` is scoped. A DTO with no reachable row must not
    // become a provider entry with an undefined key.
    state.dtos = [dto({ id: 'other-profile' }), dto({ id: 'fine' })]
    state.rows = [row({ id: 'other-profile', userId: 'someone-else' }), row({ id: 'fine' })]
    expect(collectEngineProviders().map((provider) => provider.id)).toEqual(['fine'])
    expect(state.scopesAsked).toBeGreaterThan(0)
    // Excluded by the `row?` guard, **not** by a TypeError caught downstream.
    // Both exclude the credential, so only the log tells them apart — and the
    // difference matters: the accidental version writes a keychain warning on
    // every start for a row that is simply out of scope, which is exactly the
    // noise that trains a user to ignore the log.
    expect(state.logged).toEqual([])
  })

  it('collects a server-managed credential alongside the user’s own', () => {
    // Excluding managed credentials would leave an account-provisioned machine
    // unable to run a local agent at all — the user has no other key to offer.
    state.scopes = ['default', 'profile-1']
    state.dtos = [dto({ id: 'mine' }), dto({ id: 'managed', managed: true, adminManaged: true })]
    state.rows = [
      row({ id: 'mine' }),
      row({ id: 'managed', userId: 'profile-1', apiKeyEncrypted: Buffer.from('sk-managed') })
    ]
    expect(collectEngineProviders().map((provider) => provider.id).sort()).toEqual([
      'managed',
      'mine'
    ])
    expect(collectEngineProviders().find((p) => p.id === 'managed')?.apiKey).toBe('sk-managed')
  })

  it('skips only the credential the keystore refused, and keeps the rest', () => {
    // The property that matters. A keychain that has lost one item — a
    // restored machine, a changed login keychain — must not make every local
    // agent unrunnable.
    state.decryptFails = new Set(['sk-broken'])
    state.dtos = [dto({ id: 'broken' }), dto({ id: 'fine' })]
    state.rows = [
      row({ id: 'broken', apiKeyEncrypted: Buffer.from('sk-broken') }),
      row({ id: 'fine' })
    ]
    expect(collectEngineProviders().map((provider) => provider.id)).toEqual(['fine'])
  })

  it('never puts a key in the log line it writes about a refused credential', () => {
    state.decryptFails = new Set(['sk-broken'])
    state.dtos = [dto({ id: 'broken' })]
    state.rows = [row({ id: 'broken', apiKeyEncrypted: Buffer.from('sk-broken') })]
    collectEngineProviders()
    expect(state.logged).toHaveLength(1)
    expect(JSON.stringify(state.logged)).not.toContain('sk-broken')
    expect(JSON.stringify(state.logged)).toContain('broken')
  })

  it('attaches the registry’s models to the credential they belong to', async () => {
    state.models = [
      { id: 'gpt-4o', name: 'GPT-4o', providerId: 'gw' },
      { id: 'claude-sonnet-4-5', name: 'Sonnet', providerId: 'p1' }
    ]
    await refreshModelCache()
    state.dtos = [dto(), dto({ id: 'gw', type: 'openai_compatible', name: 'Gateway' })]
    state.rows = [row(), row({ id: 'gw', baseUrl: 'https://gw.example.com/v1' })]
    const collected = collectEngineProviders()
    // Not merely "has models" — the wrong credential's models would produce a
    // config that offers a model the key cannot address.
    expect(collected.find((provider) => provider.id === 'gw')?.models).toEqual([
      { id: 'gpt-4o', name: 'GPT-4o' }
    ])
    expect(collected.find((provider) => provider.id === 'p1')?.models).toEqual([
      { id: 'claude-sonnet-4-5', name: 'Sonnet' }
    ])
  })
})

describe('refreshModelCache', () => {
  it('keeps the last good model list when a refresh fails, rather than throwing or emptying it', async () => {
    // `getAllModels` can reach the network for a gateway that implements
    // `/models`. A start that fails because a gateway is briefly down would be
    // a start that never happens, for a list that is optional — and *emptying*
    // the cache on failure is the other wrong answer: it would silently strip
    // every model from a custom provider entry, leaving a credential that can
    // address nothing until the next successful refresh.
    state.models = [{ id: 'gpt-4o', name: 'GPT-4o', providerId: 'gw' }]
    await refreshModelCache()

    state.modelsThrows = true
    await expect(refreshModelCache()).resolves.toBeUndefined()

    state.dtos = [dto({ id: 'gw', type: 'openai_compatible', name: 'Gateway' })]
    state.rows = [row({ id: 'gw', baseUrl: 'https://gw.example.com/v1' })]
    expect(collectEngineProviders()[0].models).toEqual([{ id: 'gpt-4o', name: 'GPT-4o' }])
  })
})

describe('collectEngineAgents', () => {
  it('carries the assembled prompt, the slug and the resolved runtime', () => {
    state.agents = [agent()]
    const [collected] = collectEngineAgents('user-1')
    expect(collected).toMatchObject({
      agentId: 'folder:aaa',
      slug: 'invoices',
      description: 'Reads invoices.',
      prompt: 'PROMPT FOR /agents/invoices',
      providerId: 'p1',
      modelId: 'claude-sonnet-4-5'
    })
  })

  it('does not hand a model a folder that failed validation', () => {
    // An invalid folder's prompt files may be half-written and its manifest may
    // say anything; a folder built against a newer kit may mean something this
    // app does not understand yet.
    state.agents = [
      agent({ id: 'folder:bad', readiness: 'invalid' }),
      agent({ id: 'folder:new', readiness: 'contract_too_new' }),
      agent({ id: 'folder:warn', readiness: 'credentials_needed' }),
      agent({ id: 'folder:ok' })
    ]
    expect(collectEngineAgents('user-1').map((entry) => entry.agentId)).toEqual([
      // `credentials_needed` is a warning about the *agent's* own `.env`, not
      // about the folder's validity, so it still runs and says so at the turn.
      'folder:warn',
      'folder:ok'
    ])
  })

  it('still collects an agent whose runtime resolves to nothing', () => {
    // So that `configGenerator` skips it *with a reason* the Runtime card can
    // show. Dropping it here makes the agent merely absent from the engine,
    // which is the version of this the user cannot act on.
    state.runtimes = { _default: { credentialId: null, modelId: null } }
    state.agents = [agent()]
    const [collected] = collectEngineAgents('user-1')
    expect(collected.agentId).toBe('folder:aaa')
    expect(collected.providerId).toBe('')
    expect(collected.modelId).toBe('')
  })

  it('passes a manifest permission override through, and nothing else', () => {
    state.agents = [
      agent({ id: 'folder:a', runtime: { permissions: { bash: { '*': 'allow' } } } }),
      agent({ id: 'folder:b', runtime: { permissions: 'not an object' } }),
      agent({ id: 'folder:c', runtime: {} })
    ]
    const collected = collectEngineAgents('user-1')
    expect(collected[0].permissions).toEqual({ bash: { '*': 'allow' } })
    // A string here would be spread over the permission profile by
    // `mergePermissions` and produce a config OpenCode rejects.
    expect(collected[1].permissions).toBeNull()
    expect(collected[2].permissions).toBeNull()
  })
})

describe('collectEngineConfigInput', () => {
  it('refreshes the model list before collecting, so a custom entry has models', async () => {
    // The cache is module state that outlives a test, so seeding it with a
    // *different* list first is what makes this assertion able to fail:
    // collecting before refreshing would otherwise read a cache that happened
    // to hold the right answer already, and the test would prove nothing.
    state.models = [{ id: 'previous-run', name: 'Previous', providerId: 'gw' }]
    await refreshModelCache()

    state.models = [{ id: 'gpt-4o', name: 'GPT-4o', providerId: 'gw' }]
    state.dtos = [dto({ id: 'gw', type: 'openai_compatible', name: 'Gateway' })]
    state.rows = [row({ id: 'gw', baseUrl: 'https://gw.example.com/v1' })]
    state.agents = [agent()]

    const input: EngineConfigInput = await collectEngineConfigInput('user-1')
    // Refreshed *by this call*: `collectEngineProviders` reads a cache, so a
    // build that collected before refreshing would give a gateway credential an
    // empty model map on the first start after launch — and a custom provider
    // entry with no models can address nothing.
    expect(input.providers[0].models).toEqual([{ id: 'gpt-4o', name: 'GPT-4o' }])
    expect(input.agents).toHaveLength(1)
  })
})

describe('collectEngineConfigInput — the model refresh', () => {
  it('skips the refresh when the caller asks it to', async () => {
    // Every adapter's `listModels()` is a network request, so this flag is what
    // keeps a per-turn reconcile off the network. The count is the assertion:
    // "the models are still right" would hold either way, because the cache is
    // warm — which is exactly how a flag that is quietly ignored survives.
    state.models = [{ id: 'gpt-4o', name: 'GPT-4o', providerId: 'gw' }]
    await refreshModelCache()
    const before = state.modelFetches

    await collectEngineConfigInput('user-1', { refreshModels: false })
    expect(state.modelFetches).toBe(before)

    await collectEngineConfigInput('user-1')
    expect(state.modelFetches).toBe(before + 1)
  })
})

describe('a decrypted key, from the keystore to disk', () => {
  let dir: string

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'cinna-engine-e2e-'))
  })

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true })
  })

  /**
   * The seam no other test covers.
   *
   * `configGenerator.test.ts` proves a key never reaches the config — but for
   * *its own* hand-written input. `engineManager.test.ts` proves the child gets
   * the key in its environment — but it mocks this module out entirely, so the
   * key it checks is a literal in the test file. Nothing anywhere runs a key
   * that came out of `decryptApiKey` through the real collector, the real
   * generator and onto a real file. That is the path that actually ships.
   */
  it('reaches the process environment and never the config file on disk', async () => {
    const SECRET = 'sk-ant-api03-THE-ONE-THAT-MUST-NOT-LAND'
    const GATEWAY_SECRET = 'gw-THE-OTHER-ONE-THAT-MUST-NOT-LAND'
    // Both entry shapes, because they are not the same code path: a canonical
    // key emits `{options}` alone, while a custom one also writes `npm`,
    // `name` and a model map — three more fields a key could ride out on, and
    // the sweep below is only meaningful if a custom entry is in the file.
    state.dtos = [dto(), dto({ id: 'gw', type: 'openai_compatible', name: 'Gateway' })]
    state.rows = [
      row({ apiKeyEncrypted: Buffer.from(SECRET, 'utf8') }),
      row({
        id: 'gw',
        baseUrl: 'https://gw.example.com/v1',
        apiKeyEncrypted: Buffer.from(GATEWAY_SECRET, 'utf8')
      })
    ]
    state.agents = [agent()]

    const built = buildEngineConfig(await collectEngineConfigInput('user-1'))
    const written = writeEngineConfig(dir, built)

    // In the environment handed to spawn, by name — this is the whole point of
    // the `{env:…}` indirection, and a generator that inlined the key instead
    // would still satisfy "the engine can authenticate".
    expect(Object.values(built.env)).toContain(SECRET)
    expect(Object.values(built.env)).toContain(GATEWAY_SECRET)
    // The custom entry really is in this config, or the sweep below proves
    // nothing about the fields only it has.
    expect(JSON.stringify(built.config)).toContain('@ai-sdk/openai-compatible')

    // Not in the config file, and not in any generated prompt beside it. The
    // sweep is over **every byte this generation wrote**, not over the one
    // field a key is expected in: a key that leaks does so through a field
    // nobody thought to check.
    for (const name of readdirSync(dir)) {
      if (name === 'prompts') continue
      const text = readFileSync(join(dir, name), 'utf8')
      expect(text, name).not.toContain(SECRET)
      expect(text, name).not.toContain(GATEWAY_SECRET)
    }
    for (const name of readdirSync(join(dir, 'prompts'))) {
      const text = readFileSync(join(dir, 'prompts', name), 'utf8')
      expect(text, name).not.toContain(SECRET)
      expect(text, name).not.toContain(GATEWAY_SECRET)
    }
    expect(readFileSync(written.configPath, 'utf8')).toContain('{env:')
  })

  it('leaves no temp file behind, so the config directory is only ever complete files', () => {
    // `writeIfDifferent` writes to `<path>.<pid>.<ms>.tmp` and renames, which is
    // what stops a reader — the engine, reloading — from ever seeing a
    // half-written config. The rename is not directly observable, but a
    // leftover temp file is proof it did not happen.
    const built = buildEngineConfig({
      providers: [
        { id: 'p1', type: 'anthropic', name: 'A', apiKey: 'k', baseUrl: null, models: [] }
      ],
      agents: [
        {
          agentId: 'folder:aaa',
          slug: 'demo',
          description: 'd',
          prompt: 'p',
          providerId: 'p1',
          modelId: 'm',
          permissions: null
        }
      ]
    })
    writeEngineConfig(dir, built)
    writeEngineConfig(dir, built)
    const stray = [...readdirSync(dir), ...readdirSync(join(dir, 'prompts'))].filter((name) =>
      name.endsWith('.tmp')
    )
    expect(stray).toEqual([])
  })
})
