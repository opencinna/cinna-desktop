import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { GeminiAdapter } from './gemini'
import type { StreamParams, ToolDefinition } from './types'

/**
 * `GeminiAdapter` wraps `@google/genai`. As in `openai.test.ts`, nothing here
 * mocks the SDK: the real client runs against a fake `fetch` that answers with
 * the bytes `streamGenerateContent?alt=sse` sends, so a renamed part field, a
 * moved error status or an SDK-side schema transform fails here, where `tsc`
 * passes.
 *
 * These tests were first run against the adapter on the legacy
 * `@google/generative-ai`; what they pin about the wire is what that SDK sent.
 */

const KEY = 'gemini-test-key'
const PROVIDER_ID = 'prov-gemini-1'
const MODEL = 'gemini-2.5-flash'
const STREAM_URL = `https://generativelanguage.googleapis.com/v1beta/models/${MODEL}:streamGenerateContent?alt=sse`

/**
 * The Gen AI SDK reads these when the caller leaves them unset: an API key,
 * the Vertex switch (which would send the turn to a Google Cloud project), the
 * base URL and the API version. The credential row alone decides what is sent
 * and where.
 */
const CLIENT_ENV = [
  'GOOGLE_API_KEY',
  'GEMINI_API_KEY',
  'GOOGLE_GENAI_USE_VERTEXAI',
  'GOOGLE_GENAI_USE_ENTERPRISE',
  'GOOGLE_CLOUD_PROJECT',
  'GOOGLE_CLOUD_LOCATION',
  'GOOGLE_GEMINI_BASE_URL',
  'GOOGLE_VERTEX_BASE_URL',
  'GOOGLE_GENAI_API_VERSION'
] as const
let savedEnv: Partial<Record<(typeof CLIENT_ENV)[number], string>> = {}

beforeEach(() => {
  savedEnv = {}
  for (const k of CLIENT_ENV) {
    savedEnv[k] = process.env[k]
    delete process.env[k]
  }
})

afterEach(() => {
  vi.unstubAllGlobals()
  for (const k of CLIENT_ENV) {
    if (savedEnv[k] === undefined) delete process.env[k]
    else process.env[k] = savedEnv[k]
  }
})

// ---------------------------------------------------------------------------
// The wire
// ---------------------------------------------------------------------------

interface Captured {
  url: string
  method: string
  headers: Headers
  body: Record<string, unknown> | null
  signal: AbortSignal | undefined
}

/** Stubs the global `fetch`; `answer` is called once per request, in order. */
function installFetch(answer: (req: Captured, n: number) => Response | Promise<Response>): Captured[] {
  const calls: Captured[] = []
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url
      const req: Captured = {
        url,
        method: init?.method ?? 'GET',
        headers: new Headers(init?.headers as HeadersInit | undefined),
        body: typeof init?.body === 'string' ? JSON.parse(init.body) : null,
        signal: init?.signal ?? undefined
      }
      // What a real fetch does with a signal that is already aborted.
      if (req.signal?.aborted) throw Object.assign(new Error('This operation was aborted'), { name: 'AbortError' })
      calls.push(req)
      return answer(req, calls.length)
    })
  )
  return calls
}

type Part = Record<string, unknown>

/** One `streamGenerateContent` frame carrying these parts on the first candidate. */
function frame(parts: Part[], finishReason?: string): unknown {
  return {
    candidates: [{ content: { role: 'model', parts }, index: 0, ...(finishReason ? { finishReason } : {}) }],
    modelVersion: MODEL
  }
}

function sse(payloads: unknown[]): string {
  return payloads.map((p) => `data: ${JSON.stringify(p)}\r\n\r\n`).join('')
}

function streamResponse(body: string): Response {
  return new Response(body, { status: 200, headers: { 'content-type': 'text/event-stream' } })
}

function jsonResponse(status: number, statusText: string, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, statusText, headers: { 'content-type': 'application/json' } })
}

/** The body Google's API answers a failed call with. */
function googleError(code: number, status: string, message: string, details: unknown[] = []): unknown {
  return { error: { code, message, status, ...(details.length ? { details } : {}) } }
}

async function runStream(
  adapter: GeminiAdapter,
  overrides: Partial<StreamParams> = {}
): Promise<{ result: Awaited<ReturnType<GeminiAdapter['stream']>>; deltas: string[] }> {
  const deltas: string[] = []
  const result = await adapter.stream({
    model: MODEL,
    messages: [{ role: 'user', content: 'hi' }],
    onDelta: (t) => deltas.push(t),
    ...overrides
  })
  return { result, deltas }
}

// ---------------------------------------------------------------------------
// What leaves the app
// ---------------------------------------------------------------------------

describe('GeminiAdapter.stream — the request', () => {
  it('posts to the v1beta SSE stream endpoint with the stored key in the API-key header, never in the URL', async () => {
    const calls = installFetch(() => streamResponse(sse([frame([{ text: 'ok' }])])))
    const adapter = new GeminiAdapter(KEY, PROVIDER_ID)

    await runStream(adapter)

    expect(calls).toHaveLength(1)
    expect(calls[0].method).toBe('POST')
    expect(calls[0].url).toBe(STREAM_URL)
    expect(calls[0].headers.get('x-goog-api-key')).toBe(KEY)
    expect(calls[0].headers.get('authorization')).toBeNull()
  })

  it('a key, Vertex switch, project, base URL or API version in the environment changes nothing about what is sent, or where', async () => {
    process.env.GOOGLE_API_KEY = 'key-from-a-shell'
    process.env.GEMINI_API_KEY = 'another-key-from-a-shell'
    process.env.GOOGLE_GENAI_USE_VERTEXAI = 'true'
    process.env.GOOGLE_CLOUD_PROJECT = 'someones-project'
    process.env.GOOGLE_CLOUD_LOCATION = 'us-central1'
    process.env.GOOGLE_GEMINI_BASE_URL = 'https://proxy.from-a-shell.example'
    process.env.GOOGLE_VERTEX_BASE_URL = 'https://vertex.from-a-shell.example'
    process.env.GOOGLE_GENAI_API_VERSION = 'v1'
    const calls = installFetch(() => streamResponse(sse([frame([{ text: 'ok' }])])))
    const adapter = new GeminiAdapter(KEY, PROVIDER_ID)

    await runStream(adapter)

    expect(calls[0].url).toBe(STREAM_URL)
    expect(calls[0].headers.get('x-goog-api-key')).toBe(KEY)
    expect(calls[0].headers.get('authorization')).toBeNull()
  })

  it('lifts system messages into a system instruction and sends a plain user turn as one text part', async () => {
    const calls = installFetch(() => streamResponse(sse([frame([{ text: 'ok' }])])))
    const adapter = new GeminiAdapter(KEY, PROVIDER_ID)

    await runStream(adapter, {
      messages: [
        { role: 'system', content: 'Be brief.' },
        { role: 'system', content: 'Answer in English.' },
        { role: 'user', content: 'hi' }
      ]
    })

    expect(calls[0].body?.systemInstruction).toEqual({ role: 'system', parts: [{ text: 'Be brief.\n\nAnswer in English.' }] })
    expect(calls[0].body?.contents).toEqual([{ role: 'user', parts: [{ text: 'hi' }] }])
    expect(calls[0].body).not.toHaveProperty('tools')
  })

  it('renders history the way the API takes it: calls on the model turn, results as function turns', async () => {
    const calls = installFetch(() => streamResponse(sse([frame([{ text: 'ok' }])])))
    const adapter = new GeminiAdapter(KEY, PROVIDER_ID)

    await runStream(adapter, {
      messages: [
        { role: 'user', content: 'weather?' },
        { role: 'assistant', content: 'Checking.', toolCalls: [{ id: 'gemini-1', name: 'weather', input: { city: 'Oslo' } }] },
        { role: 'tool_call', content: '{"temp":3}', toolName: 'weather', toolCallId: 'gemini-1' },
        { role: 'assistant', content: '', toolCalls: [{ id: 'gemini-2', name: 'search', input: { q: 'x' } }] },
        // An MCP result: content blocks, flattened to text.
        { role: 'tool_call', content: '[{"type":"text","text":"line 1"},{"type":"image","data":"…"}]', toolName: 'search' },
        { role: 'assistant', content: 'Done.' },
        { role: 'user', content: 'thanks' }
      ]
    })

    expect(calls[0].body?.contents).toEqual([
      { role: 'user', parts: [{ text: 'weather?' }] },
      { role: 'model', parts: [{ text: 'Checking.' }, { functionCall: { name: 'weather', args: { city: 'Oslo' } } }] },
      { role: 'function', parts: [{ functionResponse: { name: 'weather', response: { temp: 3 } } }] },
      { role: 'model', parts: [{ functionCall: { name: 'search', args: { q: 'x' } } }] },
      { role: 'function', parts: [{ functionResponse: { name: 'search', response: { result: 'line 1\n{"type":"image","data":"…"}' } } }] },
      { role: 'model', parts: [{ text: 'Done.' }] },
      { role: 'user', parts: [{ text: 'thanks' }] }
    ])
  })

  it('a tool result as the newest message goes out as a function turn; a non-JSON result is wrapped', async () => {
    const calls = installFetch(() => streamResponse(sse([frame([{ text: 'ok' }])])))
    const adapter = new GeminiAdapter(KEY, PROVIDER_ID)

    await runStream(adapter, {
      messages: [
        { role: 'user', content: 'run it' },
        { role: 'assistant', content: '', toolCalls: [{ id: 'gemini-1', name: 'shell', input: {} }] },
        { role: 'tool_call', content: 'plain output', toolName: 'shell' }
      ]
    })

    expect(calls[0].body?.contents).toEqual([
      { role: 'user', parts: [{ text: 'run it' }] },
      { role: 'model', parts: [{ functionCall: { name: 'shell', args: {} } }] },
      { role: 'function', parts: [{ functionResponse: { name: 'shell', response: { result: 'plain output' } } }] }
    ])
  })

  it('carries images and PDFs as inline data ahead of the text, inlines text parts, and drops what it cannot take', async () => {
    const calls = installFetch(() => streamResponse(sse([frame([{ text: 'ok' }])])))
    const adapter = new GeminiAdapter(KEY, PROVIDER_ID)

    await runStream(adapter, {
      messages: [
        {
          role: 'user',
          content: 'look',
          media: [
            { kind: 'image', mimeType: 'image/png', bytes: Buffer.from('PNG'), filename: 'a.png' },
            { kind: 'document', mimeType: 'application/pdf', bytes: Buffer.from('PDF'), filename: 'b.pdf' },
            { kind: 'image', mimeType: 'image/tiff', bytes: Buffer.from('TIF'), filename: 'c.tif' },
            { kind: 'text', mimeType: 'text/csv', text: 'a,b', filename: 'd.csv' }
          ]
        }
      ]
    })

    expect(calls[0].body?.contents).toEqual([
      {
        role: 'user',
        parts: [
          { inlineData: { mimeType: 'image/png', data: Buffer.from('PNG').toString('base64') } },
          { inlineData: { mimeType: 'application/pdf', data: Buffer.from('PDF').toString('base64') } },
          { text: '<file name="d.csv" type="text/csv">\na,b\n</file>\n\nlook' }
        ]
      }
    ])
  })

  it('keeps media on earlier user turns too', async () => {
    const calls = installFetch(() => streamResponse(sse([frame([{ text: 'ok' }])])))
    const adapter = new GeminiAdapter(KEY, PROVIDER_ID)

    await runStream(adapter, {
      messages: [
        { role: 'user', content: 'what is this', media: [{ kind: 'image', mimeType: 'image/jpeg', bytes: Buffer.from('JPG') }] },
        { role: 'assistant', content: 'A cat.' },
        { role: 'user', content: 'sure?' }
      ]
    })

    expect(calls[0].body?.contents).toEqual([
      { role: 'user', parts: [{ inlineData: { mimeType: 'image/jpeg', data: Buffer.from('JPG').toString('base64') } }, { text: 'what is this' }] },
      { role: 'model', parts: [{ text: 'A cat.' }] },
      { role: 'user', parts: [{ text: 'sure?' }] }
    ])
  })

  it('declares tools as function declarations with the sanitized schema, and omits parameters for a no-argument tool', async () => {
    const calls = installFetch(() => streamResponse(sse([frame([{ text: 'ok' }])])))
    const adapter = new GeminiAdapter(KEY, PROVIDER_ID)
    const tools: ToolDefinition[] = [
      {
        name: 'weather',
        description: 'Weather for a city',
        mcpProviderId: 'mcp-1',
        providerType: 'mcp',
        inputSchema: {
          type: 'object',
          properties: { city: { type: 'string', const: 'Oslo' }, days: { type: ['integer', 'null'] } },
          required: ['city'],
          additionalProperties: false
        }
      },
      { name: 'now', description: 'The time', mcpProviderId: 'mcp-1', providerType: 'mcp', inputSchema: { type: 'object', properties: {} } }
    ]

    await runStream(adapter, { tools })

    const sent = calls[0].body?.tools as { functionDeclarations: Record<string, unknown>[] }[]
    expect(sent).toHaveLength(1)
    const [weather, now] = sent[0].functionDeclarations
    expect(weather.name).toBe('weather')
    expect(weather.description).toBe('Weather for a city')
    // Type names are case-insensitive on this API (the new SDK upper-cases them).
    expect(JSON.parse(JSON.stringify(weather.parameters).toLowerCase())).toEqual({
      type: 'object',
      properties: { city: { type: 'string', enum: ['oslo'] }, days: { type: 'integer', nullable: true } },
      required: ['city']
    })
    expect(now).toEqual({ name: 'now', description: 'The time' })
  })

  it('a schema whose node has both a type and alternatives still sends — the turn is not lost to one tool', async () => {
    // MCP servers emit `{ type: 'object', anyOf: [{ required: [...] }, …] }`
    // and `{ type: 'string', oneOf: [{ const: … }, …] }`. The Gen AI SDK
    // throws on a node carrying both `type` and `anyOf` before anything is
    // sent, which would fail every turn with that tool attached.
    const calls = installFetch(() => streamResponse(sse([frame([{ text: 'ok' }])])))
    const adapter = new GeminiAdapter(KEY, PROVIDER_ID)
    const tools: ToolDefinition[] = [
      {
        name: 'lookup',
        description: 'Look something up',
        mcpProviderId: 'mcp-1',
        providerType: 'mcp',
        inputSchema: {
          type: 'object',
          properties: {
            id: { type: 'string' },
            name: { type: 'string' },
            mode: { type: 'string', oneOf: [{ const: 'fast' }, { const: 'slow' }] },
            only: { type: 'null' }
          },
          anyOf: [{ required: ['id'] }, { required: ['name'] }]
        }
      }
    ]

    const { result } = await runStream(adapter, { tools })

    expect(result.content).toBe('ok')
    expect(calls).toHaveLength(1)
    const declared = (calls[0].body?.tools as { functionDeclarations: { parameters: Record<string, unknown> }[] }[])[0]
      .functionDeclarations[0].parameters
    expect(JSON.parse(JSON.stringify(declared).toLowerCase())).toMatchObject({
      type: 'object',
      properties: { id: { type: 'string' }, name: { type: 'string' } }
    })
  })
})

// ---------------------------------------------------------------------------
// What comes back
// ---------------------------------------------------------------------------

describe('GeminiAdapter.stream — the response', () => {
  it('delivers each text part as an increment and returns the whole text', async () => {
    installFetch(() =>
      streamResponse(sse([frame([{ text: 'Hel' }]), frame([{ text: 'lo' }, { text: ', world' }]), frame([{ text: '.' }], 'STOP')]))
    )
    const adapter = new GeminiAdapter(KEY, PROVIDER_ID)

    const { result, deltas } = await runStream(adapter)

    expect(deltas).toEqual(['Hel', 'lo', ', world', '.'])
    expect(result).toEqual({ content: 'Hello, world.', toolCalls: [] })
  })

  it('turns function-call parts into tool calls with an id of their own, keeping the text that preceded them', async () => {
    installFetch(() =>
      streamResponse(
        sse([
          frame([{ text: 'Let me check.' }]),
          frame([{ functionCall: { name: 'weather', args: { city: 'Oslo' } } }, { functionCall: { name: 'now' } }], 'STOP')
        ])
      )
    )
    const adapter = new GeminiAdapter(KEY, PROVIDER_ID)

    const { result, deltas } = await runStream(adapter)

    expect(deltas).toEqual(['Let me check.'])
    expect(result.content).toBe('Let me check.')
    expect(result.toolCalls).toEqual([
      { id: expect.stringMatching(/^gemini-.{10}$/), name: 'weather', input: { city: 'Oslo' } },
      { id: expect.stringMatching(/^gemini-.{10}$/), name: 'now', input: {} }
    ])
    expect(result.toolCalls[0].id).not.toBe(result.toolCalls[1].id)
  })

  it('a frame with no candidates — usage only, or a blocked prompt — is skipped, not a crash', async () => {
    installFetch(() =>
      streamResponse(
        sse([
          { promptFeedback: { blockReason: 'SAFETY' }, usageMetadata: { promptTokenCount: 3 } },
          frame([{ text: 'ok' }]),
          { usageMetadata: { promptTokenCount: 3, candidatesTokenCount: 1, totalTokenCount: 4 } }
        ])
      )
    )
    const adapter = new GeminiAdapter(KEY, PROVIDER_ID)

    const { result } = await runStream(adapter)

    expect(result).toEqual({ content: 'ok', toolCalls: [] })
  })
})

describe('GeminiAdapter.stream — cancellation', () => {
  it('aborting mid-turn cancels the request on the wire and rejects instead of resolving with the partial text', async () => {
    let controller: ReadableStreamDefaultController<Uint8Array> | undefined
    const calls = installFetch((req) => {
      const body = new ReadableStream<Uint8Array>({
        start(c) {
          controller = c
          req.signal?.addEventListener('abort', () =>
            c.error(Object.assign(new Error('This operation was aborted'), { name: 'AbortError' }))
          )
        }
      })
      return new Response(body, { status: 200, headers: { 'content-type': 'text/event-stream' } })
    })
    const adapter = new GeminiAdapter(KEY, PROVIDER_ID)
    const ac = new AbortController()
    const deltas: string[] = []

    const pending = adapter.stream({ model: MODEL, messages: [{ role: 'user', content: 'hi' }], signal: ac.signal, onDelta: (t) => deltas.push(t) })
    await vi.waitFor(() => expect(calls).toHaveLength(1))
    controller!.enqueue(new TextEncoder().encode(sse([frame([{ text: 'Hel' }])])))
    await vi.waitFor(() => expect(deltas).toEqual(['Hel']))

    ac.abort()

    await expect(pending).rejects.toThrow(/abort/i)
    expect(calls[0].signal?.aborted).toBe(true)
  })

  it('a turn cancelled before it starts sends nothing', async () => {
    const calls = installFetch(() => streamResponse(sse([frame([{ text: 'ok' }])])))
    const adapter = new GeminiAdapter(KEY, PROVIDER_ID)
    const ac = new AbortController()
    ac.abort()

    await expect(
      adapter.stream({ model: MODEL, messages: [{ role: 'user', content: 'hi' }], signal: ac.signal, onDelta: () => {} })
    ).rejects.toThrow(/abort/i)
    expect(calls).toHaveLength(0)
  })
})

// ---------------------------------------------------------------------------
// Errors — as they reach the caller's catch, then through parseError
// ---------------------------------------------------------------------------

describe('GeminiAdapter — failures on the wire, through parseError', () => {
  async function failingTurn(adapter: GeminiAdapter): Promise<Error> {
    try {
      await runStream(adapter)
    } catch (e) {
      return e as Error
    }
    throw new Error('stream() resolved')
  }

  it('a rate limit is not retried and reads as the rate-limit sentence with the wait the API asked for', async () => {
    const calls = installFetch(() =>
      jsonResponse(429, 'Too Many Requests', googleError(429, 'RESOURCE_EXHAUSTED', 'You exceeded your current quota. Please retry in 12.4s.', [
        { '@type': 'type.googleapis.com/google.rpc.RetryInfo', retryDelay: '12s' }
      ]))
    )
    const adapter = new GeminiAdapter(KEY, PROVIDER_ID)

    const err = await failingTurn(adapter)

    expect(calls).toHaveLength(1)
    const parsed = adapter.parseError(err)
    expect(parsed.short).toBe('Rate limit exceeded — retry in 13s')
    expect(parsed.detail).toContain('You exceeded your current quota')
  })

  it('an error frame inside an open stream rejects the turn, read by its code', async () => {
    installFetch(() =>
      streamResponse(
        sse([frame([{ text: 'partial' }]), googleError(429, 'RESOURCE_EXHAUSTED', 'Quota exceeded. Please retry in 2s.')])
      )
    )
    const adapter = new GeminiAdapter(KEY, PROVIDER_ID)

    const parsed = adapter.parseError(await failingTurn(adapter))

    expect(parsed.short).toBe('Rate limit exceeded — retry in 2s')
    expect(parsed.detail).toBe('[429 RESOURCE_EXHAUSTED] Quota exceeded. Please retry in 2s.')
  })

  it.each([
    [401, 'Unauthorized', 'UNAUTHENTICATED', 'Invalid API key'],
    [403, 'Forbidden', 'PERMISSION_DENIED', 'Access denied — check your Google AI plan'],
    [404, 'Not Found', 'NOT_FOUND', 'Model not found'],
    [500, 'Internal Server Error', 'INTERNAL', 'Google AI server error — try again'],
    [503, 'Service Unavailable', 'UNAVAILABLE', 'Google AI server error — try again']
  ])('HTTP %i reads as "%s"', async (code, statusText, status, short) => {
    installFetch(() => jsonResponse(code, statusText, googleError(code, status, `fixture ${status}`)))
    const adapter = new GeminiAdapter(KEY, PROVIDER_ID)

    const parsed = adapter.parseError(await failingTurn(adapter))

    expect(parsed.short).toBe(short)
    expect(parsed.detail).toContain(`fixture ${status}`)
  })

  it('an unmapped status — a bad key is a 400 on this API — keeps the API message where the user can read it', async () => {
    installFetch(() =>
      jsonResponse(400, 'Bad Request', googleError(400, 'INVALID_ARGUMENT', 'API key not valid. Please pass a valid API key.'))
    )
    const adapter = new GeminiAdapter(KEY, PROVIDER_ID)

    const parsed = adapter.parseError(await failingTurn(adapter))

    expect(parsed.short).toContain('API key not valid')
    expect(parsed.short.length).toBeLessThanOrEqual(120)
    expect(parsed.short).not.toContain(KEY)
    expect(parsed.detail).toContain('API key not valid')
  })
})

describe('GeminiAdapter.parseError — the status table', () => {
  const adapter = new GeminiAdapter(KEY, PROVIDER_ID)

  it('reads the legacy bracketed status the list-models path still throws', () => {
    expect(adapter.parseError(new Error('Gemini list-models failed [401 Unauthorized]')).short).toBe('Invalid API key')
    expect(adapter.parseError(new Error('Gemini list-models failed [429 Too Many Requests]')).short).toBe('Rate limit exceeded')
  })

  it('an unmapped message falls back to the message, truncated at 120 characters', () => {
    const long = 'x'.repeat(200)
    expect(adapter.parseError(new Error(long))).toEqual({ short: 'x'.repeat(117) + '...', detail: long })
  })
})

describe('GeminiAdapter.listModels', () => {
  it('keeps models that can generate content, across pages, tagged with this provider', async () => {
    const calls = installFetch((_req, n) =>
      n === 1
        ? jsonResponse(200, 'OK', {
            models: [
              { name: 'models/gemini-2.5-flash', displayName: 'Gemini 2.5 Flash', supportedGenerationMethods: ['generateContent', 'countTokens'] },
              { name: 'models/text-embedding-004', displayName: 'Embedding', supportedGenerationMethods: ['embedContent'] }
            ],
            nextPageToken: 'p2'
          })
        : jsonResponse(200, 'OK', { models: [{ name: 'models/gemini-2.5-pro', supportedGenerationMethods: ['generateContent'] }] })
    )
    const adapter = new GeminiAdapter(KEY, PROVIDER_ID)

    const models = await adapter.listModels()

    expect(calls).toHaveLength(2)
    expect(new URL(calls[1].url).searchParams.get('pageToken')).toBe('p2')
    expect(models).toEqual([
      { id: 'gemini-2.5-flash', name: 'Gemini 2.5 Flash', providerId: PROVIDER_ID, providerType: 'gemini' },
      { id: 'gemini-2.5-pro', name: 'gemini-2.5-pro', providerId: PROVIDER_ID, providerType: 'gemini' }
    ])
  })

  it('a rejected key surfaces as the friendly sentence, not an empty list', async () => {
    installFetch(() => jsonResponse(401, 'Unauthorized', googleError(401, 'UNAUTHENTICATED', 'bad key')))
    const adapter = new GeminiAdapter(KEY, PROVIDER_ID)

    await expect(adapter.listModels()).rejects.toThrow('Invalid API key')
  })
})

describe('GeminiAdapter.modelCapability', () => {
  const adapter = new GeminiAdapter(KEY, PROVIDER_ID)

  it('a multimodal model takes images and PDFs natively and everything else through extraction', () => {
    const cap = adapter.modelCapability('gemini-2.5-flash')
    expect(cap.nativeMimeTypes).toEqual(['image/png', 'image/jpeg', 'image/webp', 'application/pdf'])
    expect(cap.acceptedMimeTypes).toEqual(expect.arrayContaining(['image/png', 'application/pdf', 'text/csv']))
  })

  it('the text-only gemini-pro keeps extracted attachments only', () => {
    const cap = adapter.modelCapability('gemini-pro')
    expect(cap.nativeMimeTypes).toEqual([])
    expect(cap.acceptedMimeTypes).not.toContain('image/png')
  })
})
