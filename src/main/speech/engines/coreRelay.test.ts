import { once } from 'node:events'
import type { IncomingMessage } from 'node:http'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { WebSocketServer, type WebSocket } from 'ws'
import type { SpeechStreamEvent } from '../../../shared/speech'

const logged = vi.hoisted(() => [] as { message: string; data: unknown }[])
vi.mock('../../logger/logger', () => ({
  createLogger: () => {
    const log = (message: string, data?: unknown): void => { logged.push({ message, data }) }
    return { debug: log, info: log, warn: log, error: log }
  }
}))

const { createCoreRelayEngine, pickRelayLocale, RELAY_MAX_FRAME_BYTES, RELAY_CONNECTION_LOST } = await import('./coreRelay')

const TOKEN = 'access-token-secret'

/** One client connection as the server saw it. */
interface Client {
  socket: WebSocket
  request: IncomingMessage
  /** Text frames, parsed. */
  json: Record<string, unknown>[]
  /** Binary frames' sizes. */
  binary: number[]
  /** Every frame in order: `json:<type>` or `audio:<bytes>`. */
  order: string[]
  closed: Promise<void>
}

/** A real local relay: records what the client sends and lets the test answer. */
async function relayServer(options: { refuse?: number } = {}): Promise<{
  url: string
  clients: Client[]
  next(): Promise<Client>
  close(): Promise<void>
}> {
  const server = new WebSocketServer({
    host: '127.0.0.1',
    port: 0,
    verifyClient: options.refuse ? (_info, done) => done(false, options.refuse) : undefined
  })
  const clients: Client[] = []
  const waiting: ((client: Client) => void)[] = []
  server.on('connection', (socket, request) => {
    const client: Client = { socket, request, json: [], binary: [], order: [], closed: once(socket, 'close').then(() => {}) }
    socket.on('message', (data, isBinary) => {
      const bytes = Array.isArray(data) ? Buffer.concat(data) : Buffer.isBuffer(data) ? data : Buffer.from(data)
      if (isBinary) {
        client.binary.push(bytes.length)
        client.order.push(`audio:${bytes.length}`)
      } else {
        const frame = JSON.parse(bytes.toString('utf8')) as Record<string, unknown>
        client.json.push(frame)
        client.order.push(`json:${String(frame.type)}`)
      }
    })
    clients.push(client)
    waiting.shift()?.(client)
  })
  await once(server, 'listening')
  const address = server.address() as { port: number }
  return {
    url: `ws://127.0.0.1:${address.port}/api/v1/speech/stream`,
    clients,
    next: () => clients.length > waiting.length ? Promise.resolve(clients[waiting.length]) : new Promise((resolve) => waiting.push(resolve)),
    close: async () => {
      for (const client of clients) client.socket.terminate()
      await new Promise<void>((resolve) => server.close(() => resolve()))
    }
  }
}

let server: Awaited<ReturnType<typeof relayServer>> | null = null
afterEach(async () => {
  logged.length = 0
  await server?.close()
  server = null
})

function engine(url: string, overrides: Partial<Parameters<typeof createCoreRelayEngine>[0]> = {}) {
  const onDisabled = vi.fn()
  const relay = createCoreRelayEngine({
    resolveTarget: async () => ({ ok: true, url, token: TOKEN, serverName: 'Acme Cinna' }),
    onDisabled,
    ...overrides
  })
  return { relay, onDisabled }
}

function open(relay: ReturnType<typeof engine>['relay'], options: Parameters<typeof relay.openStream>[0] = {}) {
  const events: SpeechStreamEvent[] = []
  const session = relay.openStream(options, (event) => events.push(event))
  return { events, session }
}

const send = (client: Client, frame: Record<string, unknown>): void => client.socket.send(JSON.stringify(frame))

function terminals(events: SpeechStreamEvent[]): SpeechStreamEvent[] {
  return events.filter((e) => e.type === 'stop' || (e.type === 'error' && !e.recoverable))
}

describe('coreRelay engine', () => {
  it('opens with the Bearer header, sends the start frame first, then audio queued before the socket opened', async () => {
    server = await relayServer()
    const { relay } = engine(server.url)
    const { events, session } = open(relay, { locale: 'de-DE', replaySeconds: 2.5 })
    // Pushed at once, before the target resolved and the socket opened.
    session.push(Buffer.alloc(3200, 1))
    session.push(Buffer.alloc(3200, 2))
    const client = await server.next()
    expect(client.request.headers.authorization).toBe(`Bearer ${TOKEN}`)
    expect(client.request.url).toBe('/api/v1/speech/stream')
    await vi.waitFor(() => expect(client.order).toEqual(['json:start', 'audio:3200', 'audio:3200']))
    expect(client.json[0]).toEqual({ type: 'start', version: 1, locale: 'de-DE', sample_rate: 16000, replay_seconds: 2.5 })
    expect(events[0]).toEqual({ type: 'start', backend: 'core-relay' })
  })

  it('defaults the locale to en-US and replay to 0, and never puts the token in the URL or the log', async () => {
    server = await relayServer()
    const { relay } = engine(server.url)
    const { session } = open(relay)
    const client = await server.next()
    await vi.waitFor(() => expect(client.json).toHaveLength(1))
    expect(client.json[0]).toMatchObject({ locale: 'en-US', replay_seconds: 0 })
    expect(client.request.url).not.toContain(TOKEN)
    session.cancel()
    expect(JSON.stringify(logged)).not.toContain(TOKEN)
    expect(JSON.stringify(logged)).not.toContain('/api/v1/speech/stream')
  })

  it('maps partial, final and stop (full_text) and ends with exactly one terminal event', async () => {
    server = await relayServer()
    const { relay } = engine(server.url)
    const { events, session } = open(relay)
    const client = await server.next()
    send(client, { type: 'start', backend: 'core-relay', session_id: 'x', remaining_seconds: 120 })
    send(client, { type: 'partial', text: 'hello' })
    send(client, { type: 'partial', text: 'hello wor' })
    send(client, { type: 'final', text: 'Hello world.' })
    await vi.waitFor(() => expect(events.some((e) => e.type === 'final')).toBe(true))
    session.stop()
    await vi.waitFor(() => expect(client.json.map((f) => f.type)).toEqual(['start', 'stop']))
    send(client, { type: 'stop', full_text: 'Hello world.' })
    send(client, { type: 'final', text: 'late' })
    await client.closed
    await new Promise((resolve) => setTimeout(resolve, 20))
    expect(events).toEqual([
      { type: 'start', backend: 'core-relay' },
      { type: 'partial', text: 'hello' },
      { type: 'partial', text: 'hello wor' },
      { type: 'final', text: 'Hello world.' },
      { type: 'stop', fullText: 'Hello world.' }
    ])
    const line = logged.find((l) => l.message === 'speech stream finished')?.data as Record<string, unknown>
    expect(line).toMatchObject({ engine: 'core', backend: 'core-relay', host: expect.stringContaining('127.0.0.1'), partials: 2, finals: 1, outcome: 'stop', remainingSeconds: 120 })
    expect(JSON.stringify(logged)).not.toContain('Hello world')
  })

  it('sends stop only after the start frame and queued audio when stopped before the socket opened', async () => {
    server = await relayServer()
    const { relay } = engine(server.url)
    const { session } = open(relay)
    session.push(Buffer.alloc(100))
    session.stop()
    const client = await server.next()
    await vi.waitFor(() => expect(client.order).toEqual(['json:start', 'audio:100', 'json:stop']))
  })

  it('splits a chunk over 64 KB into frames of at most 64 KB', async () => {
    server = await relayServer()
    const { relay } = engine(server.url)
    const { session } = open(relay)
    const client = await server.next()
    await vi.waitFor(() => expect(client.json).toHaveLength(1))
    session.push(Buffer.alloc(RELAY_MAX_FRAME_BYTES * 2 + 10))
    await vi.waitFor(() => expect(client.binary).toEqual([RELAY_MAX_FRAME_BYTES, RELAY_MAX_FRAME_BYTES, 10]))
  })

  it.each([
    ['busy', 'busy'],
    ['disabled', 'unavailable'],
    ['unavailable', 'unavailable'],
    ['quota_exceeded', 'unavailable'],
    ['unauthorized', 'failed'],
    ['failed', 'failed'],
    ['bad_request', 'failed'],
    ['something_new', 'failed']
  ])('maps the server error %s to %s with the server sentence', async (serverCode, code) => {
    server = await relayServer()
    const { relay, onDisabled } = engine(server.url)
    const { events } = open(relay)
    const client = await server.next()
    send(client, { type: 'error', code: serverCode, message: `Server says ${serverCode}.`, recoverable: false })
    await vi.waitFor(() => expect(terminals(events)).toHaveLength(1))
    expect(terminals(events)[0]).toEqual({ type: 'error', code, message: `Server says ${serverCode}.`, recoverable: false })
    expect(onDisabled).toHaveBeenCalledTimes(serverCode === 'disabled' ? 1 : 0)
    await client.closed
    await new Promise((resolve) => setTimeout(resolve, 20))
    expect(terminals(events)).toHaveLength(1)
  })

  it.each([401, 403])('a refused upgrade (HTTP %s) fails with a sentence to sign in again', async (status) => {
    server = await relayServer({ refuse: status })
    const { relay } = engine(server.url)
    const { events } = open(relay)
    await vi.waitFor(() => expect(terminals(events)).toHaveLength(1))
    expect(terminals(events)[0]).toMatchObject({ type: 'error', code: 'failed', message: expect.stringMatching(/Acme Cinna.*Sign in again/) })
  })

  it('a close with 1008 fails with a sentence to sign in again', async () => {
    server = await relayServer()
    const { relay } = engine(server.url)
    const { events } = open(relay)
    const client = await server.next()
    client.socket.close(1008, 'policy')
    await vi.waitFor(() => expect(terminals(events)).toHaveLength(1))
    expect(terminals(events)[0]).toMatchObject({ code: 'failed', message: expect.stringContaining('Sign in again') })
  })

  it('a socket dropped without a terminal event fails as a lost connection', async () => {
    server = await relayServer()
    const { relay } = engine(server.url)
    const { events } = open(relay)
    const client = await server.next()
    send(client, { type: 'final', text: 'kept' })
    await vi.waitFor(() => expect(events.some((e) => e.type === 'final')).toBe(true))
    client.socket.terminate()
    await vi.waitFor(() => expect(terminals(events)).toHaveLength(1))
    expect(terminals(events)[0]).toEqual({ type: 'error', code: 'failed', message: RELAY_CONNECTION_LOST, recoverable: false })
  })

  it('a socket that does not open in time fails', async () => {
    // A TCP listener that never answers the upgrade.
    const net = await import('node:net')
    const held: import('node:net').Socket[] = []
    const silent = net.createServer((socket) => { held.push(socket) })
    await new Promise<void>((resolve) => silent.listen(0, '127.0.0.1', () => resolve()))
    const port = (silent.address() as { port: number }).port
    try {
      const { relay } = engine(`ws://127.0.0.1:${port}/api/v1/speech/stream`, { connectTimeoutMs: 100 })
      const { events } = open(relay)
      await vi.waitFor(() => expect(terminals(events)).toHaveLength(1))
      expect(terminals(events)[0]).toMatchObject({ type: 'error', code: 'failed', message: expect.stringContaining("Couldn't reach Acme Cinna") })
    } finally {
      for (const socket of held) socket.destroy()
      await new Promise<void>((resolve) => silent.close(() => resolve()))
    }
  })

  it('a token that never arrives fails within the connect budget', async () => {
    const { relay } = engine('ws://127.0.0.1:1/api/v1/speech/stream', {
      connectTimeoutMs: 100,
      // A token refresh whose request hangs.
      resolveTarget: () => new Promise(() => {})
    })
    const { events } = open(relay)
    await vi.waitFor(() => expect(terminals(events)).toHaveLength(1))
    expect(terminals(events)[0]).toMatchObject({ type: 'error', code: 'failed' })
  })

  it('cancel sends cancel and nothing more reaches the sink', async () => {
    server = await relayServer()
    const { relay } = engine(server.url)
    const { events, session } = open(relay)
    const client = await server.next()
    await vi.waitFor(() => expect(client.json).toHaveLength(1))
    session.push(Buffer.alloc(10))
    session.cancel()
    await client.closed
    expect(client.order).toEqual(['json:start', 'audio:10', 'json:cancel'])
    expect(events).toEqual([{ type: 'start', backend: 'core-relay' }])
  })

  it('without a target answers the reason and opens nothing', async () => {
    const { relay } = engine('ws://unused', { resolveTarget: async () => ({ ok: false, code: 'unavailable', message: 'Not offered.' }) })
    const { events } = open(relay)
    await vi.waitFor(() => expect(events).toEqual([{ type: 'error', code: 'unavailable', message: 'Not offered.', recoverable: false }]))
  })

  it('ends with what it has when the server does not answer stop in time', async () => {
    server = await relayServer()
    const { relay } = engine(server.url, { stopTimeoutMs: 50 })
    const { events, session } = open(relay)
    const client = await server.next()
    send(client, { type: 'final', text: 'one' })
    await vi.waitFor(() => expect(events.some((e) => e.type === 'final')).toBe(true))
    session.stop()
    await vi.waitFor(() => expect(terminals(events)).toEqual([{ type: 'stop', fullText: 'one' }]))
  })

  it('fails, rather than ending empty, when the server answers nothing at all after stop', async () => {
    server = await relayServer()
    const { relay } = engine(server.url, { stopTimeoutMs: 50 })
    const { events, session } = open(relay)
    const client = await server.next()
    await vi.waitFor(() => expect(client.json).toHaveLength(1))
    session.stop()
    await vi.waitFor(() => expect(terminals(events)).toHaveLength(1))
    expect(terminals(events)[0]).toEqual({ type: 'error', code: 'failed', message: 'Acme Cinna did not finish transcribing. Try again.', recoverable: false })
  })

  it('starts the stop budget when the stop frame is sent, not while the target and the socket are still coming', async () => {
    server = await relayServer()
    const url = server.url
    // The token refresh alone outlasts the stop budget.
    const { relay } = engine(url, {
      stopTimeoutMs: 400,
      resolveTarget: () => new Promise((resolve) => setTimeout(() => resolve({ ok: true, url, token: TOKEN, serverName: 'Acme Cinna' }), 600))
    })
    const { events, session } = open(relay)
    session.push(Buffer.alloc(3200))
    session.stop()
    const client = await server.next()
    await vi.waitFor(() => expect(client.order).toEqual(['json:start', 'audio:3200', 'json:stop']), { interval: 5 })
    send(client, { type: 'final', text: 'late but there' })
    send(client, { type: 'stop', full_text: 'late but there' })
    await vi.waitFor(() => expect(terminals(events)).toEqual([{ type: 'stop', fullText: 'late but there' }]))
  })

  it('gives a replayed continuation more time to finish, per replayed second', async () => {
    server = await relayServer()
    const { relay } = engine(server.url, { stopTimeoutMs: 50, stopTimeoutPerReplaySecondMs: 200 })
    const { events, session } = open(relay, { replaySeconds: 3 })
    const client = await server.next()
    await vi.waitFor(() => expect(client.json).toHaveLength(1))
    session.stop()
    // Past the base budget, well inside base + 3 × 200 ms.
    await new Promise((resolve) => setTimeout(resolve, 200))
    send(client, { type: 'stop', full_text: 'replayed words' })
    await vi.waitFor(() => expect(terminals(events)).toEqual([{ type: 'stop', fullText: 'replayed words' }]))
  })

  it('sends the locale normalised to BCP-47', async () => {
    server = await relayServer()
    const { relay } = engine(server.url)
    open(relay, { locale: 'de_DE.UTF-8' })
    const client = await server.next()
    await vi.waitFor(() => expect(client.json).toHaveLength(1))
    expect(client.json[0]).toMatchObject({ locale: 'de-DE' })
  })

  it('picks the first candidate that is a locale, else en-US', () => {
    expect(pickRelayLocale(['fr_CA', 'de-DE'])).toBe('fr-CA')
    expect(pickRelayLocale([undefined, 'not a locale!', 'pt_BR'])).toBe('pt-BR')
    expect(pickRelayLocale(['x'.repeat(40), '', null])).toBe('en-US')
    expect(pickRelayLocale([])).toBe('en-US')
  })

  it('refuses the batch path as unavailable', async () => {
    const { relay } = engine('ws://unused')
    expect(await relay.transcribe({ wav: Buffer.alloc(0) })).toMatchObject({ success: false, code: 'unavailable' })
  })
})
