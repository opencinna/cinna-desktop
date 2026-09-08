import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'

/**
 * Detection, and the two properties that make it safe to call from a render.
 *
 * **It never rejects.** "Nothing is listening" is the ordinary answer on a
 * machine without Ollama, and a promise that rejects for it would put a React
 * Query error state — a red failure — on a screen where nothing has failed.
 *
 * **It probes only what it was told to.** Given an explicit host it must not
 * quietly fall back to `127.0.0.1` and report success: the user typed a
 * specific server, and "connected" about a different one is worse than "not
 * running" about theirs.
 */

const rows = vi.hoisted(() => ({ current: [] as { type: string; baseUrl: string | null }[] }))

vi.mock('../db/llmProviders', () => ({
  llmProviderRepo: { list: () => rows.current }
}))
vi.mock('../auth/scope', () => ({ getSettingsScopeUserId: () => '__default__' }))
vi.mock('../logger/logger', () => ({
  createLogger: () => ({ debug: () => {}, info: () => {}, warn: () => {}, error: () => {} })
}))

const { ollamaService } = await import('./ollamaService')

/** A fetch that answers only the hosts named, and refuses everything else. */
function serveOnly(
  hosts: Record<string, { version?: string; tags?: unknown; tagsStatus?: number }>
): void {
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string) => {
      const parsed = new URL(url)
      const origin = `${parsed.protocol}//${parsed.host}`
      const served = hosts[origin]
      if (!served) throw Object.assign(new TypeError('fetch failed'), { cause: { code: 'ECONNREFUSED' } })
      if (parsed.pathname === '/api/version') {
        return { ok: true, json: async () => ({ version: served.version ?? '0.6.2' }) }
      }
      if (parsed.pathname === '/api/tags') {
        if (served.tagsStatus) return { ok: false, status: served.tagsStatus }
        return { ok: true, json: async () => ({ models: served.tags ?? [] }) }
      }
      return { ok: false, status: 404 }
    })
  )
}

const TAGS = [
  { name: 'qwen3:8b', details: { family: 'qwen3', parameter_size: '8.2B' } },
  { name: 'llama3.2:3b', details: { family: 'llama', parameter_size: '3.2B' } },
  // Filtered out — an embedding model is not something to chat with. Both
  // spellings, because they are caught by different halves of the filter:
  // `embeddinggemma` by the shared `isChatCapableModelId`, `nomic-embed-text`
  // only by Ollama's own list, since it contains `embed` but not `embedding`.
  { name: 'nomic-embed-text:latest', details: { family: 'nomic-bert' } },
  { name: 'embeddinggemma:300m', details: { family: 'gemma3' } },
  { name: 'all-minilm:l6-v2', details: { family: 'bert' } }
]

let originalHost: string | undefined

beforeEach(() => {
  originalHost = process.env.OLLAMA_HOST
  delete process.env.OLLAMA_HOST
  rows.current = []
})

afterEach(() => {
  if (originalHost === undefined) delete process.env.OLLAMA_HOST
  else process.env.OLLAMA_HOST = originalHost
  vi.unstubAllGlobals()
})

describe('ollamaService.detect', () => {
  it('reports a running server, with its version and chat-capable models', async () => {
    serveOnly({ 'http://127.0.0.1:11434': { version: '0.6.2', tags: TAGS } })

    const found = await ollamaService.detect()

    expect(found.running).toBe(true)
    expect(found.host).toBe('http://127.0.0.1:11434')
    expect(found.version).toBe('0.6.2')
    expect(found.models.map((m) => m.id)).toEqual(['llama3.2:3b', 'qwen3:8b'])
    expect(found.models[1].parameterSize).toBe('8.2B')
  })

  it('resolves rather than rejecting when nothing is listening', async () => {
    serveOnly({})

    const found = await ollamaService.detect()

    expect(found.running).toBe(false)
    expect(found.host).toBe('http://127.0.0.1:11434')
    expect(found.version).toBeNull()
    expect(found.models).toEqual([])
  })

  it('prefers OLLAMA_HOST, in the scheme-less form it is conventionally set to', async () => {
    process.env.OLLAMA_HOST = '127.0.0.1:11500'
    serveOnly({
      'http://127.0.0.1:11500': { tags: [{ name: 'mistral:7b' }] },
      'http://127.0.0.1:11434': { tags: TAGS }
    })

    const found = await ollamaService.detect()

    expect(found.host).toBe('http://127.0.0.1:11500')
    expect(found.models.map((m) => m.id)).toEqual(['mistral:7b'])
  })

  it('falls back to the default when OLLAMA_HOST names something dead', async () => {
    process.env.OLLAMA_HOST = '127.0.0.1:11500'
    serveOnly({ 'http://127.0.0.1:11434': { tags: TAGS } })

    const found = await ollamaService.detect()

    expect(found.running).toBe(true)
    expect(found.host).toBe('http://127.0.0.1:11434')
  })

  /**
   * The sharper version of the case below: `normaliseOllamaHost` answers null
   * for a non-empty value it cannot parse, and the fallback used to read that
   * as "nothing was asked" — so a typed `my ollama box` probed `127.0.0.1` and
   * reported a running server the user had never named.
   */
  it('does not fall back to the default when the given host is unparseable', async () => {
    serveOnly({ 'http://127.0.0.1:11434': { tags: TAGS } })

    const found = await ollamaService.detect('my ollama box')

    expect(found.running).toBe(false)
    expect(found.models).toEqual([])
    // Quoted back as typed, so the failure sentence names what the user entered.
    expect(found.host).toBe('my ollama box')
  })

  it('treats a blank host as no host at all, and probes the candidates', async () => {
    serveOnly({ 'http://127.0.0.1:11434': { tags: TAGS } })

    const found = await ollamaService.detect('   ')

    expect(found.running).toBe(true)
    expect(found.host).toBe('http://127.0.0.1:11434')
  })

  it('probes only the host it was given, with no silent fallback', async () => {
    serveOnly({ 'http://127.0.0.1:11434': { tags: TAGS } })

    const found = await ollamaService.detect('192.168.1.40:11434')

    expect(found.running).toBe(false)
    expect(found.host).toBe('http://192.168.1.40:11434')
  })

  /**
   * A server that answers `/api/version` is running, whatever `/api/tags` does.
   * Reporting it as not running would send the user to start something that is
   * already started.
   */
  it('still reports running when the model listing fails', async () => {
    serveOnly({ 'http://127.0.0.1:11434': { tagsStatus: 500 } })

    const found = await ollamaService.detect()

    expect(found.running).toBe(true)
    expect(found.models).toEqual([])
  })

  it('sees an existing credential through a different spelling of the same host', async () => {
    rows.current = [{ type: 'ollama', baseUrl: 'http://localhost:11434' }]
    serveOnly({ 'http://127.0.0.1:11434': { tags: TAGS } })

    const found = await ollamaService.detect()

    expect(found.alreadyConfigured).toBe(true)
  })

  it('does not mistake another provider type for a configured Ollama', async () => {
    rows.current = [{ type: 'openai_compatible', baseUrl: 'http://127.0.0.1:11434' }]
    serveOnly({ 'http://127.0.0.1:11434': { tags: TAGS } })

    const found = await ollamaService.detect()

    expect(found.alreadyConfigured).toBe(false)
  })

  /** A row saved before hosts were stored at all still counts as the default. */
  it('treats an Ollama row with no host as the default host', async () => {
    rows.current = [{ type: 'ollama', baseUrl: null }]
    serveOnly({ 'http://127.0.0.1:11434': { tags: TAGS } })

    const found = await ollamaService.detect()

    expect(found.alreadyConfigured).toBe(true)
  })
})
