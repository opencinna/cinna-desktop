import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { OpenAIAdapter } from './openai'
import type { ChatMessage, StreamParams, ToolDefinition } from './types'

/**
 * `OpenAIAdapter` is a thin wrapper over the `openai` package, and — as with
 * `anthropic.test.ts`, which this file follows — it is the SDK, not the
 * wrapper, these tests are aimed at. Nothing here mocks the SDK: the real
 * client runs against a fake `fetch` that answers with the bytes Chat
 * Completions sends, so a renamed delta field, a moved error status, or a
 * changed constructor default fails here where `tsc` passes.
 *
 * This adapter also backs two other provider types. `openai_compatible`
 * constructs it with a gateway's base URL (see `factory.ts`), and the Ollama
 * adapter delegates every turn to one built against the local host — so a
 * default that reaches past the credential row reaches all three.
 *
 * The client captures `fetch` when it is constructed, so the stub goes in
 * before `new OpenAIAdapter(...)`, never after.
 */

const KEY = 'sk-test-key'
const PROVIDER_ID = 'prov-openai-1'
const GATEWAY = 'https://gateway.internal/v1'

/**
 * The 6.x client reads these from the environment when the caller leaves them
 * unset: the base URL decides where the stored key is sent, and the two ids
 * ride on every request as `OpenAI-Organization` / `OpenAI-Project`. The
 * adapter used to set only `apiKey`, so a developer's own shell could decide
 * where a chat went and who it was billed to. (`OPENAI_API_KEY` is in the list
 * because a stale one in the environment must not be able to stand in for a
 * missing argument.)
 */
const CLIENT_ENV = ['OPENAI_API_KEY', 'OPENAI_BASE_URL', 'OPENAI_ORG_ID', 'OPENAI_PROJECT_ID'] as const
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
      calls.push(req)
      return answer(req, calls.length)
    })
  )
  return calls
}

type Delta = {
  content?: string
  tool_calls?: {
    index: number
    id?: string
    function?: { name?: string; arguments?: string }
  }[]
}

/** Chat Completions SSE: bare `data:` lines, closed by the `[DONE]` sentinel. */
function sse(payloads: unknown[]): string {
  return payloads.map((p) => `data: ${JSON.stringify(p)}\n\n`).join('') + 'data: [DONE]\n\n'
}

function chunk(delta: Delta, finish: string | null = null): unknown {
  return {
    id: 'chatcmpl-1',
    object: 'chat.completion.chunk',
    created: 1,
    model: 'gpt-4o',
    choices: [{ index: 0, delta, finish_reason: finish }]
  }
}

/** The usage-only frame `stream_options` adds: a chunk with no choices at all. */
function usageChunk(): unknown {
  return {
    id: 'chatcmpl-1',
    object: 'chat.completion.chunk',
    created: 1,
    model: 'gpt-4o',
    choices: [],
    usage: { prompt_tokens: 12, completion_tokens: 20, total_tokens: 32 }
  }
}

function text(...pieces: string[]): unknown[] {
  return [chunk({ content: '' }), ...pieces.map((c) => chunk({ content: c })), chunk({}, 'stop')]
}

function streamResponse(body: string): Response {
  return new Response(body, {
    status: 200,
    headers: { 'content-type': 'text/event-stream', 'x-request-id': 'req_test' }
  })
}

function jsonResponse(status: number, body: unknown, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json', 'x-request-id': 'req_test', ...headers }
  })
}

function apiError(message: string, extra: Record<string, unknown> = {}): unknown {
  return { error: { message, type: 'invalid_request_error', param: null, code: null, ...extra } }
}

async function runStream(
  adapter: OpenAIAdapter,
  overrides: Partial<StreamParams> = {}
): Promise<{ result: Awaited<ReturnType<OpenAIAdapter['stream']>>; deltas: string[] }> {
  const deltas: string[] = []
  const result = await adapter.stream({
    model: 'gpt-4o',
    messages: [{ role: 'user', content: 'hi' }],
    onDelta: (t) => deltas.push(t),
    ...overrides
  })
  return { result, deltas }
}

// ---------------------------------------------------------------------------
// What leaves the app
// ---------------------------------------------------------------------------

describe('OpenAIAdapter.stream — the request', () => {
  it('sends the stored key as a bearer token to the chat-completions endpoint, with no organisation or project', async () => {
    const calls = installFetch(() => streamResponse(sse(text('ok'))))
    const adapter = new OpenAIAdapter(KEY, PROVIDER_ID)

    await runStream(adapter)

    expect(calls).toHaveLength(1)
    expect(calls[0].method).toBe('POST')
    expect(calls[0].url).toBe('https://api.openai.com/v1/chat/completions')
    expect(calls[0].headers.get('authorization')).toBe(`Bearer ${KEY}`)
    expect(calls[0].headers.get('openai-organization')).toBeNull()
    expect(calls[0].headers.get('openai-project')).toBeNull()
    expect(calls[0].body).toMatchObject({ model: 'gpt-4o', stream: true })
  })

  it('a base URL, organisation or project in the process environment changes nothing about what is sent, or where', async () => {
    // Left to its defaults the client would send the stored key to whatever
    // host the shell named, and attribute the request to whatever
    // organisation and project it named.
    process.env.OPENAI_BASE_URL = 'https://proxy.example/v1'
    process.env.OPENAI_ORG_ID = 'org-from-a-shell'
    process.env.OPENAI_PROJECT_ID = 'proj-from-a-shell'
    const calls = installFetch(() => streamResponse(sse(text('ok'))))
    const adapter = new OpenAIAdapter(KEY, PROVIDER_ID)

    await runStream(adapter)

    expect(calls[0].url).toBe('https://api.openai.com/v1/chat/completions')
    expect(calls[0].headers.get('authorization')).toBe(`Bearer ${KEY}`)
    expect(calls[0].headers.get('openai-organization')).toBeNull()
    expect(calls[0].headers.get('openai-project')).toBeNull()
  })

  it('a gateway goes where its credential row says, and the environment cannot move it either', async () => {
    // The pin is a *default*, not a constant — `openai_compatible` and Ollama
    // are this same adapter with a base URL, and theirs must survive it.
    process.env.OPENAI_BASE_URL = 'https://proxy.example/v1'
    const calls = installFetch(() => streamResponse(sse(text('ok'))))
    const adapter = new OpenAIAdapter(KEY, PROVIDER_ID, { baseURL: GATEWAY })

    await runStream(adapter)

    expect(calls[0].url).toBe(`${GATEWAY}/chat/completions`)
  })

  it('keeps system messages in place, where this API takes them', async () => {
    const calls = installFetch(() => streamResponse(sse(text('ok'))))
    const adapter = new OpenAIAdapter(KEY, PROVIDER_ID)

    await runStream(adapter, {
      messages: [
        { role: 'system', content: 'You are terse.' },
        { role: 'user', content: 'hi' },
        { role: 'system', content: 'Answer in French.' }
      ]
    })

    expect(calls[0].body?.messages).toEqual([
      { role: 'system', content: 'You are terse.' },
      { role: 'user', content: 'hi' },
      { role: 'system', content: 'Answer in French.' }
    ])
  })

  it('renders history the way the API takes it: tool calls on the assistant turn, results as tool turns', async () => {
    const calls = installFetch(() => streamResponse(sse(text('ok'))))
    const adapter = new OpenAIAdapter(KEY, PROVIDER_ID)

    const messages: ChatMessage[] = [
      { role: 'user', content: 'weather?' },
      {
        role: 'assistant',
        content: 'checking',
        toolCalls: [{ id: 'call_1', name: 'get_weather', input: { city: 'Berlin' } }]
      },
      { role: 'tool_call', content: '17C', toolCallId: 'call_1', toolName: 'get_weather' },
      { role: 'assistant', content: '17 degrees' }
    ]
    await runStream(adapter, { messages })

    expect(calls[0].body?.messages).toEqual([
      { role: 'user', content: 'weather?' },
      {
        role: 'assistant',
        content: 'checking',
        tool_calls: [
          { id: 'call_1', type: 'function', function: { name: 'get_weather', arguments: '{"city":"Berlin"}' } }
        ]
      },
      { role: 'tool', tool_call_id: 'call_1', content: '17C' },
      { role: 'assistant', content: '17 degrees' }
    ])
  })

  it('an assistant turn with tool calls and no text sends a null content, which is what the API requires', async () => {
    const calls = installFetch(() => streamResponse(sse(text('ok'))))
    const adapter = new OpenAIAdapter(KEY, PROVIDER_ID)

    await runStream(adapter, {
      messages: [
        { role: 'user', content: 'weather?' },
        { role: 'assistant', content: '', toolCalls: [{ id: 'call_1', name: 'get_weather', input: {} }] },
        { role: 'tool_call', content: '17C', toolCallId: 'call_1' }
      ]
    })

    const sent = calls[0].body?.messages as { role: string; content: unknown }[]
    expect(sent[1].content).toBeNull()
  })

  it('carries images as data URLs, inlines text parts, and drops what Chat Completions cannot take', async () => {
    const calls = installFetch(() => streamResponse(sse(text('ok'))))
    const adapter = new OpenAIAdapter(KEY, PROVIDER_ID)

    await runStream(adapter, {
      messages: [
        {
          role: 'user',
          content: 'look',
          media: [
            { kind: 'image', mimeType: 'image/png', bytes: Buffer.from('PNG'), filename: 'a.png' },
            // No native block on this API — the extractor turns these into
            // text parts upstream, so anything still binary here is dropped.
            { kind: 'document', mimeType: 'application/pdf', bytes: Buffer.from('PDF'), filename: 'b.pdf' },
            { kind: 'image', mimeType: 'image/tiff', bytes: Buffer.from('TIF'), filename: 'c.tif' },
            { kind: 'text', mimeType: 'text/csv', text: 'a,b', filename: 'd.csv' }
          ]
        }
      ]
    })

    expect(calls[0].body?.messages).toEqual([
      {
        role: 'user',
        content: [
          { type: 'text', text: '<file name="d.csv" type="text/csv">\na,b\n</file>\n\nlook' },
          { type: 'image_url', image_url: { url: `data:image/png;base64,${Buffer.from('PNG').toString('base64')}` } }
        ]
      }
    ])
  })

  it('a user turn with only text attachments stays a plain string', async () => {
    const calls = installFetch(() => streamResponse(sse(text('ok'))))
    const adapter = new OpenAIAdapter(KEY, PROVIDER_ID)

    await runStream(adapter, {
      messages: [
        {
          role: 'user',
          content: 'read this',
          media: [{ kind: 'text', mimeType: 'text/plain', text: 'body', filename: 'n.txt' }]
        }
      ]
    })

    expect(calls[0].body?.messages).toEqual([
      { role: 'user', content: '<file name="n.txt" type="text/plain">\nbody\n</file>\n\nread this' }
    ])
  })

  it('declares tools as functions with the schema under `parameters`, and sends no `tools` key without them', async () => {
    const calls = installFetch(() => streamResponse(sse(text('ok'))))
    const adapter = new OpenAIAdapter(KEY, PROVIDER_ID)
    const tools: ToolDefinition[] = [
      {
        name: 'get_weather',
        description: 'Look up the weather',
        inputSchema: { type: 'object', properties: { city: { type: 'string' } }, required: ['city'] },
        mcpProviderId: 'mcp-1',
        providerType: 'mcp'
      }
    ]

    await runStream(adapter, { tools })
    expect(calls[0].body?.tools).toEqual([
      {
        type: 'function',
        function: {
          name: 'get_weather',
          description: 'Look up the weather',
          parameters: { type: 'object', properties: { city: { type: 'string' } }, required: ['city'] }
        }
      }
    ])

    await runStream(adapter)
    expect(calls[1].body).not.toHaveProperty('tools')
  })
})

// ---------------------------------------------------------------------------
// What comes back
// ---------------------------------------------------------------------------

describe('OpenAIAdapter.stream — the response', () => {
  it('delivers each delta as an increment and returns the whole text', async () => {
    installFetch(() => streamResponse(sse(text('Hel', 'lo ', 'world'))))
    const adapter = new OpenAIAdapter(KEY, PROVIDER_ID)

    const { result, deltas } = await runStream(adapter)

    expect(deltas).toEqual(['Hel', 'lo ', 'world'])
    expect(result.content).toBe('Hello world')
    expect(result.toolCalls).toEqual([])
  })

  it('assembles a tool call from argument fragments, with the text that preceded it', async () => {
    installFetch(() =>
      streamResponse(
        sse([
          chunk({ content: 'Let me check. ' }),
          chunk({ tool_calls: [{ index: 0, id: 'call_1', function: { name: 'get_weather', arguments: '' } }] }),
          chunk({ tool_calls: [{ index: 0, function: { arguments: '{"ci' } }] }),
          chunk({ tool_calls: [{ index: 0, function: { arguments: 'ty":"Ber' } }] }),
          chunk({ tool_calls: [{ index: 0, function: { arguments: 'lin"}' } }] }),
          chunk({}, 'tool_calls')
        ])
      )
    )
    const adapter = new OpenAIAdapter(KEY, PROVIDER_ID)

    const { result, deltas } = await runStream(adapter)

    expect(deltas).toEqual(['Let me check. '])
    expect(result.content).toBe('Let me check. ')
    expect(result.toolCalls).toEqual([{ id: 'call_1', name: 'get_weather', input: { city: 'Berlin' } }])
  })

  it('keeps two tool calls in one turn, interleaved by index, with a no-argument input as `{}`', async () => {
    installFetch(() =>
      streamResponse(
        sse([
          chunk({ tool_calls: [{ index: 0, id: 'call_a', function: { name: 'now', arguments: '' } }] }),
          chunk({ tool_calls: [{ index: 1, id: 'call_b', function: { name: 'get_weather', arguments: '' } }] }),
          // The API interleaves fragments across indices, not one call at a time.
          chunk({ tool_calls: [{ index: 1, function: { arguments: '{"city"' } }] }),
          chunk({ tool_calls: [{ index: 1, function: { arguments: ':"Berlin"}' } }] }),
          chunk({}, 'tool_calls')
        ])
      )
    )
    const adapter = new OpenAIAdapter(KEY, PROVIDER_ID)

    const { result } = await runStream(adapter)

    expect(result.toolCalls).toEqual([
      { id: 'call_a', name: 'now', input: {} },
      { id: 'call_b', name: 'get_weather', input: { city: 'Berlin' } }
    ])
  })

  it('arguments that never parse leave an empty input rather than failing the turn', async () => {
    installFetch(() =>
      streamResponse(
        sse([
          chunk({ tool_calls: [{ index: 0, id: 'call_1', function: { name: 'now', arguments: '{"city":' } }] }),
          chunk({}, 'tool_calls')
        ])
      )
    )
    const adapter = new OpenAIAdapter(KEY, PROVIDER_ID)

    const { result } = await runStream(adapter)

    expect(result.toolCalls).toEqual([{ id: 'call_1', name: 'now', input: {} }])
  })

  it('a chunk carrying no choices — the usage frame — is ignored, not a crash', async () => {
    installFetch(() => streamResponse(sse([...text('ok'), usageChunk()])))
    const adapter = new OpenAIAdapter(KEY, PROVIDER_ID)

    const { result } = await runStream(adapter)

    expect(result.content).toBe('ok')
  })
})

// ---------------------------------------------------------------------------
// Cancellation
// ---------------------------------------------------------------------------

describe('OpenAIAdapter.stream — cancellation', () => {
  function heldOpenStream(): { calls: Captured[]; push: () => ReadableStreamDefaultController<Uint8Array> } {
    let controller: ReadableStreamDefaultController<Uint8Array> | undefined
    const calls = installFetch((req) => {
      const body = new ReadableStream<Uint8Array>({
        start(c) {
          controller = c
          // What a real fetch does when its signal is aborted: the body errors
          // with an AbortError, which is how the SDK learns the request is gone.
          req.signal?.addEventListener('abort', () =>
            c.error(Object.assign(new Error('This operation was aborted'), { name: 'AbortError' }))
          )
        }
      })
      return new Response(body, { status: 200, headers: { 'content-type': 'text/event-stream' } })
    })
    return {
      calls,
      push: () => {
        if (!controller) throw new Error('no request in flight')
        return controller
      }
    }
  }

  it('aborting mid-turn cancels the request on the wire and rejects instead of resolving with the partial text', async () => {
    // The SDK swallows the abort: its SSE iterator catches the AbortError and
    // returns, so the adapter's loop ends normally. Left alone, `stream()`
    // resolves with what had arrived and the caller records a turn the user
    // cancelled as one that finished.
    const { calls, push } = heldOpenStream()
    const adapter = new OpenAIAdapter(KEY, PROVIDER_ID)
    const ac = new AbortController()
    const deltas: string[] = []

    const pending = adapter.stream({
      model: 'gpt-4o',
      messages: [{ role: 'user', content: 'hi' }],
      signal: ac.signal,
      onDelta: (t) => deltas.push(t)
    })
    await vi.waitFor(() => expect(calls).toHaveLength(1))
    push().enqueue(new TextEncoder().encode(`data: ${JSON.stringify(chunk({ content: 'Hel' }))}\n\n`))
    await vi.waitFor(() => expect(deltas).toEqual(['Hel']))

    ac.abort()

    await expect(pending).rejects.toThrow(/abort/i)
    expect(calls[0].signal?.aborted).toBe(true)
  })

  it('a turn cancelled before it starts sends nothing', async () => {
    const calls = installFetch(() => streamResponse(sse(text('ok'))))
    const adapter = new OpenAIAdapter(KEY, PROVIDER_ID)
    const ac = new AbortController()
    ac.abort()

    await expect(
      adapter.stream({ model: 'gpt-4o', messages: [{ role: 'user', content: 'hi' }], signal: ac.signal, onDelta: () => {} })
    ).rejects.toThrow(/abort/i)
    expect(calls).toHaveLength(0)
  })
})

// ---------------------------------------------------------------------------
// Errors — as they reach chatStreamingService's catch, then through parseError
// ---------------------------------------------------------------------------

describe('OpenAIAdapter — failures on the wire, through parseError', () => {
  async function failingTurn(adapter: OpenAIAdapter): Promise<Error> {
    try {
      await runStream(adapter)
    } catch (e) {
      return e as Error
    }
    throw new Error('stream() resolved')
  }

  it('a rate limit is retried by the client, then reaches the user as the rate-limit sentence', async () => {
    const calls = installFetch(() =>
      jsonResponse(429, apiError('Rate limit reached for gpt-4o', { type: 'requests', code: 'rate_limit_exceeded' }), {
        'retry-after-ms': '1'
      })
    )
    const adapter = new OpenAIAdapter(KEY, PROVIDER_ID)

    const error = await failingTurn(adapter)

    expect(calls).toHaveLength(3) // the client's default: two retries
    expect(adapter.parseError(error)).toEqual({
      short: 'Rate limit exceeded — try again shortly',
      detail: '429 Rate limit reached for gpt-4o'
    })
  })

  it('an exhausted quota is a 429 too, and must not read as a rate limit', async () => {
    // Waiting clears a rate limit and never clears this one, so the status
    // table alone would send the user to retry forever.
    installFetch(() =>
      jsonResponse(
        429,
        apiError('You exceeded your current quota, please check your plan and billing details.', {
          type: 'insufficient_quota',
          code: 'insufficient_quota'
        }),
        { 'retry-after-ms': '1' }
      )
    )
    const adapter = new OpenAIAdapter(KEY, PROVIDER_ID)

    const error = await failingTurn(adapter)

    expect((error as Error & { status?: number }).status).toBe(429)
    expect(adapter.parseError(error).short).toBe('OpenAI quota exceeded — check billing')
  })

  it('an exhausted quota inside an open stream — no HTTP status at all — reads the same way', async () => {
    // The SDK builds a mid-stream `error` payload into an APIError with an
    // undefined status, so nothing in the status table can catch it.
    installFetch(() =>
      streamResponse(
        `data: ${JSON.stringify(chunk({ content: 'Hel' }))}\n\n` +
          `data: ${JSON.stringify(apiError('You exceeded your current quota.', { code: 'insufficient_quota' }))}\n\n`
      )
    )
    const adapter = new OpenAIAdapter(KEY, PROVIDER_ID)

    const error = await failingTurn(adapter)

    expect((error as Error & { status?: number }).status).toBeUndefined()
    expect(adapter.parseError(error)).toEqual({
      short: 'OpenAI quota exceeded — check billing',
      detail: 'You exceeded your current quota.'
    })
  })

  it('a bad key is not retried and reads as an invalid key', async () => {
    const calls = installFetch(() =>
      jsonResponse(401, apiError('Incorrect API key provided', { code: 'invalid_api_key' }))
    )
    const adapter = new OpenAIAdapter(KEY, PROVIDER_ID)

    const error = await failingTurn(adapter)

    expect(calls).toHaveLength(1)
    expect(adapter.parseError(error).short).toBe('Invalid OpenAI API key')
  })

  it('an unknown model reads as a missing model', async () => {
    installFetch(() => jsonResponse(404, apiError('The model `gpt-9` does not exist', { code: 'model_not_found' })))
    const adapter = new OpenAIAdapter(KEY, PROVIDER_ID)

    expect(adapter.parseError(await failingTurn(adapter))).toEqual({
      short: 'Model not found',
      detail: '404 The model `gpt-9` does not exist'
    })
  })
})

describe('OpenAIAdapter.parseError — the status table', () => {
  const adapter = new OpenAIAdapter(KEY, PROVIDER_ID)
  const withStatus = (status: number, message = `${status} boom`): Error => Object.assign(new Error(message), { status })

  it.each([
    [403, 'Access denied — check your OpenAI plan'],
    [404, 'Model not found'],
    [500, 'OpenAI server error — try again'],
    [502, 'OpenAI server error — try again'],
    [503, 'OpenAI server error — try again']
  ])('%i → %s', (status, short) => {
    expect(adapter.parseError(withStatus(status))).toEqual({ short, detail: `${status} boom` })
  })

  it('an unmapped status falls back to the message, truncated at 120 characters', () => {
    const long = 'x'.repeat(200)
    expect(adapter.parseError(withStatus(418, long))).toEqual({ short: 'x'.repeat(117) + '...', detail: long })
    expect(adapter.parseError(new Error('short one'))).toEqual({ short: 'short one', detail: 'short one' })
  })
})

// ---------------------------------------------------------------------------
// listModels
// ---------------------------------------------------------------------------

describe('OpenAIAdapter.listModels', () => {
  function modelsResponse(ids: { id: string; created: number }[]): Response {
    return jsonResponse(200, {
      object: 'list',
      data: ids.map((m) => ({ id: m.id, object: 'model', created: m.created, owned_by: 'openai' }))
    })
  }

  it('keeps the chat families, newest first, tagged with this provider', async () => {
    const calls = installFetch(() =>
      modelsResponse([
        { id: 'gpt-4o-mini', created: 100 },
        { id: 'o3', created: 300 },
        { id: 'gpt-4o', created: 200 }
      ])
    )
    const adapter = new OpenAIAdapter(KEY, PROVIDER_ID)

    const models = await adapter.listModels()

    expect(calls).toHaveLength(1)
    expect(calls[0].method).toBe('GET')
    expect(calls[0].url).toBe('https://api.openai.com/v1/models')
    expect(calls[0].headers.get('authorization')).toBe(`Bearer ${KEY}`)
    expect(models).toEqual([
      { id: 'o3', name: 'o3', providerId: PROVIDER_ID, providerType: 'openai' },
      { id: 'gpt-4o', name: 'GPT-4o', providerId: PROVIDER_ID, providerType: 'openai' },
      { id: 'gpt-4o-mini', name: 'GPT-4o Mini', providerId: PROVIDER_ID, providerType: 'openai' }
    ])
  })

  it('drops everything that cannot hold a text chat', async () => {
    installFetch(() =>
      modelsResponse(
        [
          'text-embedding-3-large',
          'whisper-1',
          'tts-1',
          'dall-e-3',
          'gpt-image-1',
          'omni-moderation-latest',
          'gpt-4o-audio-preview',
          'gpt-4o-realtime-preview',
          'gpt-4o-transcribe',
          'gpt-4o-search-preview',
          'computer-use-preview',
          'gpt-3.5-turbo-instruct',
          'ft:gpt-4o:acme::abc',
          'davinci-002',
          'babbage-002',
          'gpt-4o'
        ].map((id) => ({ id, created: 1 }))
      )
    )
    const adapter = new OpenAIAdapter(KEY, PROVIDER_ID)

    expect((await adapter.listModels()).map((m) => m.id)).toEqual(['gpt-4o'])
  })

  it('a gateway that does not implement the listing advertises its seeded models instead of failing the picker', async () => {
    installFetch(() => jsonResponse(404, apiError('Unknown endpoint')))
    const adapter = new OpenAIAdapter(KEY, PROVIDER_ID, {
      baseURL: GATEWAY,
      fallbackModels: ['acme-large']
    })

    expect(await adapter.listModels()).toEqual([
      { id: 'acme-large', name: 'Acme-Large', providerId: PROVIDER_ID, providerType: 'openai' }
    ])
  })

  it('a listing that answers with nothing this app can chat to falls back too', async () => {
    installFetch(() => modelsResponse([{ id: 'text-embedding-3-large', created: 1 }]))
    const adapter = new OpenAIAdapter(KEY, PROVIDER_ID, { baseURL: GATEWAY, fallbackModels: ['acme-large'] })

    expect((await adapter.listModels()).map((m) => m.id)).toEqual(['acme-large'])
  })

  it('a rejected key on a first-party provider surfaces as the error providerService translates, not an empty list', async () => {
    installFetch(() => jsonResponse(401, apiError('Incorrect API key provided', { code: 'invalid_api_key' })))
    const adapter = new OpenAIAdapter(KEY, PROVIDER_ID)

    await expect(adapter.listModels()).rejects.toMatchObject({ status: 401 })
  })
})

// ---------------------------------------------------------------------------
// modelCapability — pure
// ---------------------------------------------------------------------------

describe('OpenAIAdapter.modelCapability', () => {
  const adapter = new OpenAIAdapter(KEY, PROVIDER_ID)

  it('a vision model takes images natively and everything else through extraction', () => {
    for (const id of ['gpt-4o', 'o3-mini', 'ChatGPT-4o-latest']) {
      const cap = adapter.modelCapability(id)
      expect(cap.nativeMimeTypes).toEqual(['image/png', 'image/jpeg', 'image/gif', 'image/webp'])
      expect(cap.acceptedMimeTypes).toEqual(expect.arrayContaining([...cap.nativeMimeTypes, 'text/csv']))
      expect(cap.maxFileSizeBytes).toBe(20 * 1024 * 1024)
      expect(cap.maxFilesPerMessage).toBe(10)
    }
  })

  it('a model without vision keeps text-extracted attachments only — and PDFs are never native here', () => {
    const cap = adapter.modelCapability('gpt-3.5-turbo')
    expect(cap.nativeMimeTypes).toEqual([])
    expect(cap.acceptedMimeTypes).not.toContain('image/png')
    expect(cap.acceptedMimeTypes).toContain('text/csv')
    expect(adapter.modelCapability('gpt-4o').nativeMimeTypes).not.toContain('application/pdf')
  })
})
