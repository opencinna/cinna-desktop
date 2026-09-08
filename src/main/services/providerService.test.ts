import { describe, it, expect, beforeEach, vi } from 'vitest'

/**
 * `providerService.upsert`, and the two things a keyless credential changed
 * about it.
 *
 * **The host is normalised on the way in.** `shared/credentials` has always been
 * able to normalise one; for a while nothing called it on a *write*, so the
 * probe and the save disagreed — a pasted `http://127.0.0.1:11434/v1` tested
 * green against the origin and was then stored verbatim, which made the adapter
 * fetch `…/v1/api/tags` and the engine emit `…/v1/v1`. The pure function is
 * covered in `shared/credentials.test.ts`; what is covered here is that the
 * write path actually calls it, which is the half that was missing.
 *
 * **An adapter is registered without a key.** A keyless row that registered no
 * adapter would be a credential the model picker never lists and the engine
 * never sees — usable everywhere except in fact.
 */

const upserted = vi.hoisted(() => ({ calls: [] as Record<string, unknown>[] }))
const registry = vi.hoisted(() => ({
  registered: [] as { id: string; adapter: unknown }[],
  unregistered: [] as string[]
}))
const adapters = vi.hoisted(() => ({ created: [] as Record<string, unknown>[] }))

const stored = vi.hoisted(() => ({ rows: {} as Record<string, Record<string, unknown>> }))

vi.mock('../db/llmProviders', () => ({
  llmProviderRepo: {
    getOwned: (_userId: string, id: string) => stored.rows[id],
    upsert: (_userId: string, input: Record<string, unknown>) => {
      upserted.calls.push(input)
      const prior = input.id ? stored.rows[input.id as string] : undefined
      return {
        id: (input.id as string) ?? 'generated-id',
        created: true,
        row: {
          id: (input.id as string) ?? 'generated-id',
          userId: '__default__',
          type: input.type,
          name: input.name,
          // Mirrors the real repo: an absent key PRESERVES the stored one.
          // That preservation is what makes re-typing a row dangerous.
          apiKeyEncrypted:
            input.apiKeyEncrypted !== undefined
              ? input.apiKeyEncrypted
              : (prior?.apiKeyEncrypted ?? null),
          enabled: input.enabled ?? true,
          defaultModelId: input.defaultModelId ?? null,
          availableModels: null,
          baseUrl: input.baseUrl !== undefined ? input.baseUrl : (prior?.baseUrl ?? null),
          managed: false,
          adminManaged: false,
          unsupported: false,
          createdAt: new Date(0)
        }
      }
    }
  }
}))
vi.mock('../security/keystore', () => ({
  encryptApiKey: (k: string) => Buffer.from(k),
  decryptApiKey: (b: Buffer) => b.toString()
}))
/** What the next `createAdapter` should do when asked to list models. */
const adapterBehaviour = vi.hoisted(() => ({ listModels: null as null | (() => Promise<never>) }))

vi.mock('../llm/factory', async () => {
  const actual = await vi.importActual<typeof import('../llm/factory')>('../llm/factory')
  return {
    isProviderType: actual.isProviderType,
    createAdapter: (type: string, apiKey: string, id: string, opts: Record<string, unknown>) => {
      adapters.created.push({ type, apiKey, id, ...opts })
      return {
        providerType: type,
        listModels: adapterBehaviour.listModels ?? (async () => []),
        // Stands in for a real adapter's own error translation.
        parseError: (err: Error) => ({
          short: `friendly: ${err.message}`,
          detail: `raw: ${err.message}`
        })
      }
    }
  }
})
vi.mock('../llm/registry', () => ({
  registerAdapter: (id: string, adapter: unknown) => registry.registered.push({ id, adapter }),
  unregisterAdapter: (id: string) => registry.unregistered.push(id),
  getAdapter: () => undefined,
  getAllModels: async () => []
}))
vi.mock('../auth/scope', () => ({ getManagedResourceScopes: () => ['__default__'] }))
vi.mock('../logger/logger', () => ({
  createLogger: () => ({ debug: () => {}, info: () => {}, warn: () => {}, error: () => {} })
}))

const { providerService } = await import('./providerService')

beforeEach(() => {
  adapterBehaviour.listModels = null
  stored.rows = {}
  upserted.calls = []
  registry.registered = []
  registry.unregistered = []
  adapters.created = []
})

const OLLAMA = { type: 'ollama', name: 'Ollama', enabled: true }

describe('upsert — a keyless credential', () => {
  it.each([
    ['http://127.0.0.1:11434/v1', 'http://127.0.0.1:11434'],
    ['127.0.0.1:11434', 'http://127.0.0.1:11434'],
    ['localhost:11434', 'http://127.0.0.1:11434'],
    ['http://127.0.0.1:11434/', 'http://127.0.0.1:11434'],
    ['  192.168.1.40:11434  ', 'http://192.168.1.40:11434']
  ])('stores %s as %s', (given, stored) => {
    providerService.upsert('__default__', { ...OLLAMA, baseUrl: given })
    expect(upserted.calls[0].baseUrl).toBe(stored)
  })

  it('resolves an empty host to the default rather than storing nothing', () => {
    providerService.upsert('__default__', { ...OLLAMA, baseUrl: '' })
    expect(upserted.calls[0].baseUrl).toBe('http://127.0.0.1:11434')
  })

  /**
   * Refused, not silently defaulted: the Add form renders the message inline
   * without closing, and storing a different host than the field displays would
   * be a screen that lies about what it saved.
   */
  it('refuses a host it cannot parse, naming it back', () => {
    expect(() => providerService.upsert('__default__', { ...OLLAMA, baseUrl: 'my ollama box' })
    ).toThrow(/my ollama box/)
    expect(upserted.calls).toHaveLength(0)
  })

  /**
   * `undefined` means "leave the stored value alone" — what the enable toggle
   * and the default-model writer both send. Normalising it would rewrite the
   * host to the default on every unrelated edit.
   */
  it('leaves the stored host alone when none is supplied', () => {
    providerService.upsert('__default__', { id: 'p1', ...OLLAMA, enabled: false })
    expect(upserted.calls[0].baseUrl).toBeUndefined()
  })

  it('registers an adapter despite having no API key, and hands it the host', () => {
    providerService.upsert('__default__', { ...OLLAMA, baseUrl: '127.0.0.1:11434' })
    expect(registry.registered).toHaveLength(1)
    expect(registry.unregistered).toHaveLength(0)
    expect(adapters.created[0]).toMatchObject({
      type: 'ollama',
      apiKey: '',
      baseUrl: 'http://127.0.0.1:11434'
    })
  })

  it('unregisters it when disabled, like any other credential', () => {
    providerService.upsert('__default__', { ...OLLAMA, baseUrl: '', enabled: false })
    expect(registry.registered).toHaveLength(0)
    expect(registry.unregistered).toEqual(['generated-id'])
  })
})

describe('upsert — a credential that does have a key', () => {
  /**
   * A keyed credential's endpoint is **never** renderer-supplied. Pointing a row
   * that holds a real key at an arbitrary URL is key exfiltration with extra
   * steps, so the value is dropped rather than written.
   *
   * The one legitimate keyed base URL — an `openai_compatible` gateway — comes
   * from account-config sync, which writes through `llmProviderRepo` directly
   * and never through this method.
   */
  it('drops a gateway URL supplied through this entry point', () => {
    providerService.upsert('__default__', {
      type: 'openai_compatible',
      name: 'Gateway',
      apiKey: 'k',
      baseUrl: 'https://gw.example.com/openai/v1/'
    })
    expect(upserted.calls[0].baseUrl).toBeUndefined()
  })

  it('registers with its key, and with whatever base URL the row already had', () => {
    stored.rows['gw'] = {
      id: 'gw',
      type: 'openai_compatible',
      name: 'Gateway',
      apiKeyEncrypted: null,
      enabled: true,
      baseUrl: 'https://gw.example.com/v1'
    }
    providerService.upsert('__default__', {
      id: 'gw',
      type: 'openai_compatible',
      name: 'Gateway',
      apiKey: 'sk-test'
    })
    expect(adapters.created[0]).toMatchObject({
      type: 'openai_compatible',
      apiKey: 'sk-test',
      baseUrl: 'https://gw.example.com/v1'
    })
  })

  it('registers no adapter for a keyed credential with no key yet', () => {
    providerService.upsert('__default__', { type: 'anthropic', name: 'Anthropic' })
    expect(registry.registered).toHaveLength(0)
    expect(registry.unregistered).toEqual(['generated-id'])
  })
})

/**
 * `provider:upsert` passes the renderer's object through to the repo, which
 * writes `type` unconditionally on update and **preserves** the stored
 * encrypted key when no new one is supplied. Two guards keep that from becoming
 * a way to spend a real key at an address the renderer chose.
 *
 * This is the shape of the attack, written down so a future edit that removes
 * either guard fails here rather than in the field.
 */
describe('upsert — mass-assignment guards', () => {
  const anthropicRow = {
    id: 'row-anthropic',
    type: 'anthropic',
    name: 'Anthropic',
    apiKeyEncrypted: Buffer.from('sk-ant-REAL-SECRET'),
    enabled: true,
    baseUrl: null
  }

  it('refuses to re-type an existing credential', () => {
    stored.rows['row-anthropic'] = anthropicRow
    expect(() =>
      providerService.upsert('__default__', {
        id: 'row-anthropic',
        type: 'openai_compatible',
        name: 'Anthropic',
        baseUrl: 'https://evil.example'
      })
    ).toThrow(/provider type cannot be changed/)
    expect(upserted.calls).toHaveLength(0)
    expect(adapters.created).toHaveLength(0)
  })

  /**
   * The second guard, which holds even if the first is somehow passed: a keyed
   * credential's endpoint is never renderer-supplied, so the stored key cannot
   * be pointed anywhere.
   */
  it('ignores a baseUrl sent for a credential that has a key', () => {
    stored.rows['row-anthropic'] = anthropicRow
    providerService.upsert('__default__', {
      id: 'row-anthropic',
      type: 'anthropic',
      name: 'Anthropic',
      baseUrl: 'https://evil.example'
    })
    // Nothing attacker-supplied is written…
    expect(upserted.calls[0].baseUrl).toBeUndefined()
    // …and the adapter built with the preserved real key points nowhere new.
    expect(adapters.created[0]).toMatchObject({ apiKey: 'sk-ant-REAL-SECRET' })
    expect(adapters.created[0].baseUrl).toBeNull()
  })

  it('still accepts a host for a keyless credential', () => {
    stored.rows['row-ollama'] = {
      id: 'row-ollama',
      type: 'ollama',
      name: 'Ollama',
      apiKeyEncrypted: null,
      enabled: true,
      baseUrl: 'http://127.0.0.1:11434'
    }
    providerService.upsert('__default__', {
      id: 'row-ollama',
      type: 'ollama',
      name: 'Ollama',
      baseUrl: '192.168.1.40:11434'
    })
    expect(upserted.calls[0].baseUrl).toBe('http://192.168.1.40:11434')
  })
})

/**
 * A failing probe must reach the user as the **adapter's** sentence.
 *
 * `test` and `testKey` used to rethrow whatever the SDK threw, so a stopped
 * Ollama surfaced in Settings as the literal string `fetch failed` — while
 * `OllamaAdapter.parseError` held "Ollama isn't answering at … — start it with
 * 'ollama serve'", reachable from no path a user could take. `fetchModels` had
 * always done this correctly; the other two had not, and nothing noticed
 * because the copy that was missing is copy nobody sees until something breaks.
 */
describe('a failing probe is translated, not rethrown raw', () => {
  beforeEach(() => {
    adapterBehaviour.listModels = async () => {
      throw new Error('fetch failed')
    }
  })

  it('test() reports the adapter sentence and keeps the raw text as detail', async () => {
    stored.rows['p1'] = {
      id: 'p1',
      type: 'ollama',
      name: 'Ollama',
      apiKeyEncrypted: null,
      enabled: true,
      baseUrl: 'http://127.0.0.1:11434'
    }
    await expect(providerService.test('__default__', 'p1')).rejects.toMatchObject({
      code: 'list_models_failed',
      message: 'friendly: fetch failed',
      detail: 'raw: fetch failed'
    })
  })

  it('testKey() does the same for a credential that has not been saved yet', async () => {
    await expect(
      providerService.testKey({ type: 'ollama', baseUrl: 'http://127.0.0.1:11434' })
    ).rejects.toMatchObject({
      code: 'list_models_failed',
      message: 'friendly: fetch failed'
    })
  })
})
