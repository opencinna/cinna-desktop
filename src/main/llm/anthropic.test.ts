import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { AnthropicAdapter } from './anthropic'
import type { ChatMessage, StreamParams, ToolDefinition } from './types'

/**
 * `AnthropicAdapter` is a thin wrapper over `@anthropic-ai/sdk`, and it is the
 * SDK — not the wrapper — these tests are aimed at. The package was moved
 * 0.89 → 0.93 by a peer requirement of the Claude Agent SDK (see
 * docs/llm/adapters/adapters_tech.md), and a typecheck cannot see a renamed
 * streaming event, a tool input no longer parsed out of partial JSON, or an
 * error whose status moved. So nothing here mocks the SDK: the real client
 * runs against a fake `fetch` that answers with the bytes the Messages API
 * sends — SSE frames on the wire — and every assertion is on what the adapter
 * handed the app, or on what left it in the request.
 *
 * The client captures `fetch` when it is constructed, so the stub goes in
 * before `new AnthropicAdapter(...)`, never after.
 */

const KEY = 'sk-ant-test-key'
const PROVIDER_ID = 'prov-anthropic-1'

/**
 * The 0.93 client reads these from the environment when the caller leaves
 * them unset. The adapter sets only `apiKey`, so a developer's own shell
 * could otherwise decide where a test's request goes and what it carries.
 */
const CLIENT_ENV = [
  'ANTHROPIC_API_KEY',
  'ANTHROPIC_AUTH_TOKEN',
  'ANTHROPIC_BASE_URL',
  'ANTHROPIC_PROFILE',
  'ANTHROPIC_CUSTOM_HEADERS'
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
      calls.push(req)
      return answer(req, calls.length)
    })
  )
  return calls
}

type Frame = Record<string, unknown> & { type: string }

/** Messages-API SSE: one `event:` + `data:` pair per frame, blank-line separated. */
function sse(frames: Frame[]): string {
  return frames.map((f) => `event: ${f.type}\ndata: ${JSON.stringify(f)}\n\n`).join('')
}

function streamResponse(text: string): Response {
  return new Response(text, {
    status: 200,
    headers: { 'content-type': 'text/event-stream', 'request-id': 'req_test' }
  })
}

function jsonResponse(status: number, body: unknown, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json', 'request-id': 'req_test', ...headers }
  })
}

function apiError(type: string, message: string): unknown {
  return { type: 'error', error: { type, message } }
}

const MESSAGE_START: Frame = {
  type: 'message_start',
  message: {
    id: 'msg_01',
    type: 'message',
    role: 'assistant',
    model: 'claude-opus-5',
    content: [],
    stop_reason: null,
    stop_sequence: null,
    usage: { input_tokens: 12, output_tokens: 1 }
  }
}

function messageEnd(stopReason: 'end_turn' | 'tool_use'): Frame[] {
  return [
    { type: 'message_delta', delta: { stop_reason: stopReason, stop_sequence: null }, usage: { output_tokens: 20 } },
    { type: 'message_stop' }
  ]
}

function textBlock(index: number, pieces: string[]): Frame[] {
  return [
    { type: 'content_block_start', index, content_block: { type: 'text', text: '' } },
    ...pieces.map((text) => ({ type: 'content_block_delta', index, delta: { type: 'text_delta', text } })),
    { type: 'content_block_stop', index }
  ]
}

/** A tool call as the API streams it: an empty `input`, then the JSON in pieces. */
function toolBlock(index: number, id: string, name: string, jsonPieces: string[]): Frame[] {
  return [
    { type: 'content_block_start', index, content_block: { type: 'tool_use', id, name, input: {} } },
    ...jsonPieces.map((partial_json) => ({
      type: 'content_block_delta',
      index,
      delta: { type: 'input_json_delta', partial_json }
    })),
    { type: 'content_block_stop', index }
  ]
}

function thinkingBlock(index: number, pieces: string[]): Frame[] {
  return [
    { type: 'content_block_start', index, content_block: { type: 'thinking', thinking: '', signature: '' } },
    ...pieces.map((thinking) => ({ type: 'content_block_delta', index, delta: { type: 'thinking_delta', thinking } })),
    { type: 'content_block_delta', index, delta: { type: 'signature_delta', signature: 'sig_abc' } },
    { type: 'content_block_stop', index }
  ]
}

function turn(blocks: Frame[][], stopReason: 'end_turn' | 'tool_use' = 'end_turn'): string {
  return sse([MESSAGE_START, ...blocks.flat(), ...messageEnd(stopReason)])
}

async function runStream(
  adapter: AnthropicAdapter,
  overrides: Partial<StreamParams> = {}
): Promise<{ result: Awaited<ReturnType<AnthropicAdapter['stream']>>; deltas: string[] }> {
  const deltas: string[] = []
  const result = await adapter.stream({
    model: 'claude-opus-5',
    messages: [{ role: 'user', content: 'hi' }],
    onDelta: (t) => deltas.push(t),
    ...overrides
  })
  return { result, deltas }
}

// ---------------------------------------------------------------------------
// What leaves the app
// ---------------------------------------------------------------------------

describe('AnthropicAdapter.stream — the request', () => {
  it('sends the stored key as x-api-key to the Messages endpoint, and no bearer token', async () => {
    const calls = installFetch(() => streamResponse(turn([textBlock(0, ['ok'])])))
    const adapter = new AnthropicAdapter(KEY, PROVIDER_ID)

    await runStream(adapter)

    expect(calls).toHaveLength(1)
    expect(calls[0].method).toBe('POST')
    expect(calls[0].url).toBe('https://api.anthropic.com/v1/messages')
    expect(calls[0].headers.get('x-api-key')).toBe(KEY)
    // 0.93 added profile- and token-based auth; an explicit key must still be
    // the one and only credential on the wire.
    expect(calls[0].headers.get('authorization')).toBeNull()
    expect(calls[0].body).toMatchObject({ model: 'claude-opus-5', max_tokens: 8192, stream: true })
  })

  it('a credential, base URL or custom header in the process environment changes nothing about what is sent, or where', async () => {
    // Left to its defaults the client would send the stored key *and* a
    // Bearer from the shell, send the key to whatever host the shell named,
    // or let a shell's custom headers replace the key outright.
    process.env.ANTHROPIC_AUTH_TOKEN = 'token-from-a-shell'
    process.env.ANTHROPIC_BASE_URL = 'https://proxy.example'
    process.env.ANTHROPIC_CUSTOM_HEADERS = 'x-api-key: sk-from-a-shell\nauthorization: Bearer header-token'
    const calls = installFetch(() => streamResponse(turn([textBlock(0, ['ok'])])))
    const adapter = new AnthropicAdapter(KEY, PROVIDER_ID)

    await runStream(adapter)

    expect(calls[0].url).toBe('https://api.anthropic.com/v1/messages')
    expect(calls[0].headers.get('x-api-key')).toBe(KEY)
    expect(calls[0].headers.get('authorization')).toBeNull()
  })

  it('lifts every system message into the top-level `system` field, and omits it when there is none', async () => {
    const calls = installFetch(() => streamResponse(turn([textBlock(0, ['ok'])])))
    const adapter = new AnthropicAdapter(KEY, PROVIDER_ID)

    await runStream(adapter, {
      messages: [
        { role: 'system', content: 'You are terse.' },
        { role: 'user', content: 'hi' },
        { role: 'system', content: 'Answer in French.' }
      ]
    })
    expect(calls[0].body?.system).toBe('You are terse.\n\nAnswer in French.')
    expect(calls[0].body?.messages).toEqual([{ role: 'user', content: 'hi' }])

    await runStream(adapter)
    expect(calls[1].body).not.toHaveProperty('system')
  })

  it('renders history the way the API takes it: tool calls as blocks, tool results as user turns', async () => {
    const calls = installFetch(() => streamResponse(turn([textBlock(0, ['ok'])])))
    const adapter = new AnthropicAdapter(KEY, PROVIDER_ID)
    const messages: ChatMessage[] = [
      { role: 'user', content: 'weather?' },
      {
        role: 'assistant',
        content: 'Checking.',
        toolCalls: [{ id: 'toolu_1', name: 'get_weather', input: { city: 'Berlin' } }]
      },
      { role: 'tool_call', content: '{"temp":21}', toolCallId: 'toolu_1', toolName: 'get_weather' },
      { role: 'assistant', content: '21°C.' },
      { role: 'tool_call', content: 'boom', toolCallId: 'toolu_2', toolError: true }
    ]

    await runStream(adapter, { messages })

    expect(calls[0].body?.messages).toEqual([
      { role: 'user', content: 'weather?' },
      {
        role: 'assistant',
        content: [
          { type: 'text', text: 'Checking.' },
          { type: 'tool_use', id: 'toolu_1', name: 'get_weather', input: { city: 'Berlin' } }
        ]
      },
      { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'toolu_1', content: '{"temp":21}' }] },
      { role: 'assistant', content: '21°C.' },
      { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'toolu_2', content: 'boom', is_error: true }] }
    ])
  })

  it('carries images and PDFs as native blocks, inlines text parts, and drops what the API cannot take', async () => {
    const calls = installFetch(() => streamResponse(turn([textBlock(0, ['ok'])])))
    const adapter = new AnthropicAdapter(KEY, PROVIDER_ID)
    const png = Buffer.from('png-bytes')
    const pdf = Buffer.from('pdf-bytes')

    await runStream(adapter, {
      messages: [
        {
          role: 'user',
          content: 'look',
          media: [
            { kind: 'image', mimeType: 'image/png', bytes: png, filename: 'a.png' },
            { kind: 'image', mimeType: 'image/bmp', bytes: Buffer.from('bmp'), filename: 'b.bmp' },
            { kind: 'document', mimeType: 'application/pdf', bytes: pdf, filename: 'c.pdf' },
            { kind: 'document', mimeType: 'application/msword', bytes: Buffer.from('doc'), filename: 'd.doc' },
            { kind: 'text', mimeType: 'text/csv', text: 'a,b', filename: 'e.csv' }
          ]
        }
      ]
    })

    expect(calls[0].body?.messages).toEqual([
      {
        role: 'user',
        content: [
          { type: 'image', source: { type: 'base64', media_type: 'image/png', data: png.toString('base64') } },
          { type: 'document', source: { type: 'base64', media_type: 'application/pdf', data: pdf.toString('base64') } },
          { type: 'text', text: '<file name="e.csv" type="text/csv">\na,b\n</file>\n\nlook' }
        ]
      }
    ])
  })

  it('a user turn with only text attachments stays a plain string', async () => {
    const calls = installFetch(() => streamResponse(turn([textBlock(0, ['ok'])])))
    const adapter = new AnthropicAdapter(KEY, PROVIDER_ID)

    await runStream(adapter, {
      messages: [{ role: 'user', content: 'sum it', media: [{ kind: 'text', mimeType: 'text/plain', text: 'x' }] }]
    })

    expect(calls[0].body?.messages).toEqual([
      { role: 'user', content: '<file name="attached" type="text/plain">\nx\n</file>\n\nsum it' }
    ])
  })

  it('declares tools with the schema under `input_schema`, and sends no `tools` key without them', async () => {
    const calls = installFetch(() => streamResponse(turn([textBlock(0, ['ok'])])))
    const adapter = new AnthropicAdapter(KEY, PROVIDER_ID)
    const tools: ToolDefinition[] = [
      {
        name: 'get_weather',
        description: 'Weather by city',
        inputSchema: { type: 'object', properties: { city: { type: 'string' } }, required: ['city'] },
        mcpProviderId: 'mcp-1',
        providerType: 'mcp'
      }
    ]

    await runStream(adapter, { tools })
    expect(calls[0].body?.tools).toEqual([
      {
        name: 'get_weather',
        description: 'Weather by city',
        input_schema: { type: 'object', properties: { city: { type: 'string' } }, required: ['city'] }
      }
    ])

    await runStream(adapter)
    expect(calls[1].body).not.toHaveProperty('tools')
  })
})

// ---------------------------------------------------------------------------
// What comes back
// ---------------------------------------------------------------------------

describe('AnthropicAdapter.stream — the response', () => {
  it('delivers each text delta as an increment and returns the whole text', async () => {
    installFetch(() => streamResponse(turn([textBlock(0, ['Hel', 'lo, ', 'world'])])))
    const adapter = new AnthropicAdapter(KEY, PROVIDER_ID)

    const { result, deltas } = await runStream(adapter)

    // The SDK's `text` event carries `(delta, snapshot)`; the adapter must be
    // reading the first. Cumulative text here would render as stuttering.
    expect(deltas).toEqual(['Hel', 'lo, ', 'world'])
    expect(result).toEqual({ content: 'Hello, world', toolCalls: [] })
  })

  it('assembles a tool call from partial JSON deltas, with the text that preceded it', async () => {
    installFetch(() =>
      streamResponse(
        turn(
          [
            textBlock(0, ['Let me check.']),
            toolBlock(1, 'toolu_01', 'get_weather', ['{"ci', 'ty": "Ber', 'lin", "units": "c"}'])
          ],
          'tool_use'
        )
      )
    )
    const adapter = new AnthropicAdapter(KEY, PROVIDER_ID)

    const { result, deltas } = await runStream(adapter)

    expect(deltas).toEqual(['Let me check.'])
    expect(result).toEqual({
      content: 'Let me check.',
      toolCalls: [{ id: 'toolu_01', name: 'get_weather', input: { city: 'Berlin', units: 'c' } }]
    })
  })

  it('keeps two tool calls in one turn, in order, with a no-argument input as `{}`', async () => {
    installFetch(() =>
      streamResponse(
        turn([toolBlock(0, 'toolu_a', 'list_files', ['{}']), toolBlock(1, 'toolu_b', 'read_file', ['{"path":"a"}'])], 'tool_use')
      )
    )
    const adapter = new AnthropicAdapter(KEY, PROVIDER_ID)

    const { result } = await runStream(adapter)

    expect(result.content).toBe('')
    expect(result.toolCalls).toEqual([
      { id: 'toolu_a', name: 'list_files', input: {} },
      { id: 'toolu_b', name: 'read_file', input: { path: 'a' } }
    ])
  })

  it('concatenates several text blocks and never surfaces a thinking block', async () => {
    // Opus 5 thinks by default; the adapter sends no `thinking` option, so a
    // thinking block arrives ahead of the text with nothing asked for.
    installFetch(() =>
      streamResponse(turn([thinkingBlock(0, ['private ', 'reasoning']), textBlock(1, ['First.']), textBlock(2, [' Second.'])]))
    )
    const adapter = new AnthropicAdapter(KEY, PROVIDER_ID)

    const { result, deltas } = await runStream(adapter)

    expect(deltas).toEqual(['First.', ' Second.'])
    expect(result).toEqual({ content: 'First. Second.', toolCalls: [] })
  })

  it('ignores keep-alive pings', async () => {
    installFetch(() =>
      streamResponse(
        sse([MESSAGE_START, { type: 'ping' }, ...textBlock(0, ['a']), { type: 'ping' }, ...messageEnd('end_turn')])
      )
    )
    const adapter = new AnthropicAdapter(KEY, PROVIDER_ID)

    const { result } = await runStream(adapter)

    expect(result.content).toBe('a')
  })

  it('a stream that ends before message_stop is a failure, not an empty success', async () => {
    installFetch(() => streamResponse(sse([MESSAGE_START, ...textBlock(0, ['partial'])])))
    const adapter = new AnthropicAdapter(KEY, PROVIDER_ID)
    const deltas: string[] = []

    await expect(
      adapter.stream({ model: 'claude-opus-5', messages: [{ role: 'user', content: 'hi' }], onDelta: (t) => deltas.push(t) })
    ).rejects.toThrow(/without producing a Message/)
    // What arrived was delivered on the way — the caller decides what to keep.
    expect(deltas).toEqual(['partial'])
  })
})

// ---------------------------------------------------------------------------
// Cancellation
// ---------------------------------------------------------------------------

describe('AnthropicAdapter.stream — cancellation', () => {
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

  it('aborting mid-turn cancels the request on the wire and rejects instead of running to completion', async () => {
    const { calls, push } = heldOpenStream()
    const adapter = new AnthropicAdapter(KEY, PROVIDER_ID)
    const ac = new AbortController()
    const deltas: string[] = []

    const pending = adapter.stream({
      model: 'claude-opus-5',
      messages: [{ role: 'user', content: 'hi' }],
      signal: ac.signal,
      onDelta: (t) => deltas.push(t)
    })
    await vi.waitFor(() => expect(calls).toHaveLength(1))
    push().enqueue(new TextEncoder().encode(sse([MESSAGE_START, ...textBlock(0, ['Hel']).slice(0, 2)])))
    await vi.waitFor(() => expect(deltas).toEqual(['Hel']))

    ac.abort()

    await expect(pending).rejects.toThrow(/abort/i)
    // The signal the adapter was given must reach the request — a turn the
    // user cancelled that keeps streaming is a turn the user still pays for.
    expect(calls[0].signal?.aborted).toBe(true)
  })

  it('a turn cancelled before it starts sends nothing', async () => {
    const calls = installFetch(() => streamResponse(turn([textBlock(0, ['ok'])])))
    const adapter = new AnthropicAdapter(KEY, PROVIDER_ID)
    const ac = new AbortController()
    ac.abort()

    await expect(
      adapter.stream({ model: 'claude-opus-5', messages: [{ role: 'user', content: 'hi' }], signal: ac.signal, onDelta: () => {} })
    ).rejects.toThrow(/abort/i)
    expect(calls).toHaveLength(0)
  })
})

// ---------------------------------------------------------------------------
// Errors — as they reach chatStreamingService's catch, then through parseError
// ---------------------------------------------------------------------------

describe('AnthropicAdapter — failures on the wire, through parseError', () => {
  async function failingTurn(adapter: AnthropicAdapter): Promise<Error> {
    try {
      await runStream(adapter)
    } catch (e) {
      return e as Error
    }
    throw new Error('stream() resolved')
  }

  it('a rate limit is retried by the client, then reaches the user as the rate-limit sentence', async () => {
    const calls = installFetch(() =>
      jsonResponse(429, apiError('rate_limit_error', 'This request would exceed your rate limit'), {
        'retry-after-ms': '1'
      })
    )
    const adapter = new AnthropicAdapter(KEY, PROVIDER_ID)

    const error = await failingTurn(adapter)

    expect(calls).toHaveLength(3) // the client's default: two retries
    expect(adapter.parseError(error)).toEqual({
      short: 'Rate limit exceeded — try again shortly',
      detail: '429 This request would exceed your rate limit'
    })
  })

  it('a bad key is not retried and reads as an invalid key', async () => {
    const calls = installFetch(() => jsonResponse(401, apiError('authentication_error', 'invalid x-api-key')))
    const adapter = new AnthropicAdapter(KEY, PROVIDER_ID)

    const error = await failingTurn(adapter)

    expect(calls).toHaveLength(1)
    expect(adapter.parseError(error).short).toBe('Invalid Anthropic API key')
  })

  it('a 529 before the stream opens reads as overloaded', async () => {
    installFetch(() => jsonResponse(529, apiError('overloaded_error', 'Overloaded'), { 'retry-after-ms': '1' }))
    const adapter = new AnthropicAdapter(KEY, PROVIDER_ID)

    const error = await failingTurn(adapter)

    expect(adapter.parseError(error).short).toBe('Anthropic API overloaded — try again')
  })

  it('an overload inside an open stream — no HTTP status, only the API type — reads as overloaded too', async () => {
    // The documented mid-stream failure: an `error` event carrying what would
    // have been a 529 outside a stream. There is no status to switch on.
    installFetch(() =>
      streamResponse(
        sse([MESSAGE_START, ...textBlock(0, ['Hel']).slice(0, 2), apiError('overloaded_error', 'Overloaded') as Frame])
      )
    )
    const adapter = new AnthropicAdapter(KEY, PROVIDER_ID)

    const error = await failingTurn(adapter)

    expect((error as Error & { status?: number }).status).toBeUndefined()
    expect(adapter.parseError(error)).toEqual({ short: 'Anthropic API overloaded — try again', detail: 'Overloaded' })
  })

  it('a billing refusal is a 400 the status table does not name, caught by its wording', async () => {
    installFetch(() =>
      jsonResponse(400, apiError('invalid_request_error', 'Your credit balance is too low to access the Anthropic API.'))
    )
    const adapter = new AnthropicAdapter(KEY, PROVIDER_ID)

    const error = await failingTurn(adapter)

    expect(adapter.parseError(error).short).toBe('Billing issue — check your Anthropic account')
  })
})

describe('AnthropicAdapter.parseError — the status table', () => {
  const adapter = new AnthropicAdapter(KEY, PROVIDER_ID)
  const withStatus = (status: number, message = `${status} boom`): Error => Object.assign(new Error(message), { status })

  it.each([
    [403, 'Access denied — check your Anthropic plan'],
    [404, 'Model not found'],
    [500, 'Anthropic server error — try again'],
    [502, 'Anthropic server error — try again'],
    [503, 'Anthropic server error — try again']
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

describe('AnthropicAdapter.listModels', () => {
  it('walks every page of the beta models list and tags each row with this provider', async () => {
    const calls = installFetch((_req, n) =>
      n === 1
        ? jsonResponse(200, {
            data: [
              { type: 'model', id: 'claude-opus-5', display_name: 'Claude Opus 5', created_at: '2026-04-01T00:00:00Z' },
              { type: 'model', id: 'claude-haiku-4-5', display_name: 'Claude Haiku 4.5', created_at: '2025-10-01T00:00:00Z' }
            ],
            has_more: true,
            first_id: 'claude-opus-5',
            last_id: 'claude-haiku-4-5'
          })
        : jsonResponse(200, {
            data: [{ type: 'model', id: 'claude-sonnet-5', display_name: 'Claude Sonnet 5', created_at: '2026-03-01T00:00:00Z' }],
            has_more: false,
            first_id: 'claude-sonnet-5',
            last_id: 'claude-sonnet-5'
          })
    )
    const adapter = new AnthropicAdapter(KEY, PROVIDER_ID)

    const models = await adapter.listModels()

    expect(calls).toHaveLength(2)
    expect(calls[0].method).toBe('GET')
    expect(calls[0].url).toBe('https://api.anthropic.com/v1/models?beta=true')
    expect(calls[0].headers.get('x-api-key')).toBe(KEY)
    expect(new URL(calls[1].url).searchParams.get('after_id')).toBe('claude-haiku-4-5')
    expect(models).toEqual([
      { id: 'claude-opus-5', name: 'Claude Opus 5', providerId: PROVIDER_ID, providerType: 'anthropic' },
      { id: 'claude-haiku-4-5', name: 'Claude Haiku 4.5', providerId: PROVIDER_ID, providerType: 'anthropic' },
      { id: 'claude-sonnet-5', name: 'Claude Sonnet 5', providerId: PROVIDER_ID, providerType: 'anthropic' }
    ])
  })

  it('a rejected key surfaces as the error providerService translates, not an empty list', async () => {
    installFetch(() => jsonResponse(401, apiError('authentication_error', 'invalid x-api-key')))
    const adapter = new AnthropicAdapter(KEY, PROVIDER_ID)

    await expect(adapter.listModels()).rejects.toMatchObject({ status: 401 })
  })
})

// ---------------------------------------------------------------------------
// modelCapability — pure
// ---------------------------------------------------------------------------

describe('AnthropicAdapter.modelCapability', () => {
  const adapter = new AnthropicAdapter(KEY, PROVIDER_ID)

  it('a current model takes images and PDFs natively and everything else through extraction', () => {
    const cap = adapter.modelCapability('claude-opus-5')
    expect(cap.nativeMimeTypes).toEqual(['image/png', 'image/jpeg', 'image/gif', 'image/webp', 'application/pdf'])
    expect(cap.acceptedMimeTypes).toEqual(expect.arrayContaining([...cap.nativeMimeTypes, 'text/csv']))
    expect(cap.maxFileSizeBytes).toBe(32 * 1024 * 1024)
    expect(cap.maxFilesPerMessage).toBe(20)
  })

  it('a legacy model keeps text-extracted attachments only', () => {
    for (const id of ['claude-2.1', 'Claude-Instant-1.2']) {
      const cap = adapter.modelCapability(id)
      expect(cap.nativeMimeTypes).toEqual([])
      expect(cap.acceptedMimeTypes).not.toContain('image/png')
      expect(cap.acceptedMimeTypes).toContain('text/csv')
    }
  })
})
