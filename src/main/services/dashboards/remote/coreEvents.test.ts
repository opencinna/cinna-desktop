import { describe, expect, it, vi } from 'vitest'

vi.mock('../../../logger/logger', () => ({ createLogger: () => ({ debug: () => {}, info: () => {}, warn: () => {}, error: () => {} }) }))
vi.mock('socket.io-client', () => ({ io: () => { throw new Error('no real socket in tests') } }))
vi.mock('../../../auth/cinna-oauth', () => ({ CinnaReauthRequired: class CinnaReauthRequired extends Error {} }))
vi.mock('../../../auth/cinna-session', () => ({ cinnaSessionGeneration: () => 0 }))
vi.mock('../../../auth/cinna-tokens', () => ({ getCinnaAccessToken: async () => 't' }))
vi.mock('../../cinna-http', () => ({ resolveBaseUrl: () => 'https://cinna.example.com' }))

const { createCoreEvents, CLOSE_DEBOUNCE_MS, SERVER_CLOSE_RETRY_MS, CONNECT_REFUSED_RETRY_MS, CONNECT_REFUSED_RETRY_MAX_MS } = await import('./coreEvents')
type Deps = import('./coreEvents').CoreEventsDeps
type Options = import('./coreEvents').CoreSocketOptions

class FakeSocket {
  connected = false
  active = true
  disconnected = 0
  connects = 0
  listeners = new Map<string, Array<(...args: unknown[]) => void>>()
  constructor(readonly url: string, readonly options: Options) {}
  on(event: string, listener: (...args: unknown[]) => void) {
    this.listeners.set(event, [...(this.listeners.get(event) ?? []), listener])
  }
  connect() {
    this.connects += 1
  }
  disconnect() {
    this.disconnected += 1
    this.connected = false
  }
  emit(event: string, ...args: unknown[]) {
    for (const listener of this.listeners.get(event) ?? []) listener(...args)
  }
  /** What socket.io does on a (re)connect: ask for auth. */
  auth(): Promise<Record<string, unknown> | null> {
    return new Promise((resolve) => {
      this.options.auth((data) => resolve(data))
      setTimeout(() => resolve(null), 20)
    })
  }
}

function setup(overrides: Partial<Deps> = {}) {
  const sockets: FakeSocket[] = []
  const timers: Array<{ fn: () => void; ms: number; cancelled: boolean }> = []
  let generation = 0
  let tokenN = 0
  const deps: Deps = {
    socket: (url, options) => {
      const socket = new FakeSocket(url, options)
      sockets.push(socket)
      return socket
    },
    baseUrl: (userId) => {
      if (userId === 'local-only') throw new Error('not a Cinna profile')
      return 'https://cinna.example.com'
    },
    token: vi.fn(async () => `token-${++tokenN}`),
    generation: () => generation,
    isReauth: (err) => err instanceof Error && err.message === 'reauth',
    setTimeout: (fn, ms) => {
      const timer = { fn, ms, cancelled: false }
      timers.push(timer)
      return timer
    },
    clearTimeout: (handle) => {
      ;(handle as { cancelled: boolean }).cancelled = true
    },
    ...overrides
  }
  const events = createCoreEvents(deps)
  const fire = (ms: number) => {
    for (const timer of timers.filter((t) => !t.cancelled && t.ms === ms)) {
      timer.cancelled = true
      timer.fn()
    }
  }
  return { events, sockets, deps, fire, bump: () => { generation += 1 } }
}

describe('coreEvents', () => {
  it('opens one socket.io connection to <server> on /ws with reconnection, and a fresh token on every (re)connect', async () => {
    const { events, sockets } = setup()
    events.want('p1', true)
    events.want('p1', true)
    expect(sockets).toHaveLength(1)
    expect(sockets[0].url).toBe('https://cinna.example.com')
    expect(sockets[0].options).toMatchObject({ path: '/ws', reconnection: true })
    expect(await sockets[0].auth()).toEqual({ token: 'token-1' })
    expect(await sockets[0].auth()).toEqual({ token: 'token-2' })
    expect(events.isLive('p1')).toBe(false)
    sockets[0].connected = true
    expect(events.isLive('p1')).toBe(true)
    expect(events.isLive('p2')).toBe(false)
  })

  it('routes dashboard_tile_updated and dashboard_tile_highlight by block id, and ignores the rest', () => {
    const { events, sockets } = setup()
    const tileUpdated = vi.fn()
    const tileHighlight = vi.fn()
    events.setHandlers({ tileUpdated, tileHighlight })
    events.want('p1', true)
    sockets[0].emit('event', { type: 'dashboard_tile_updated', model_id: 'x', meta: { block_id: 'b1' } })
    sockets[0].emit('event', { type: 'dashboard_tile_highlight', meta: { block_id: 'b2', ids: ['r1', 7, 'r2'] } })
    sockets[0].emit('event', { type: 'dashboard_tile_highlight', meta: { block_id: 'b3' } })
    sockets[0].emit('event', { type: 'session_updated', meta: { block_id: 'b4' } })
    sockets[0].emit('event', { type: 'dashboard_tile_updated', meta: {} })
    sockets[0].emit('event', 'garbage')
    expect(tileUpdated.mock.calls).toEqual([['p1', 'b1']])
    expect(tileHighlight.mock.calls).toEqual([['p1', 'b2', ['r1', 'r2']], ['p1', 'b3', []]])
  })

  it('tells the handlers when the socket connects, first time and after a reconnect', () => {
    const { events, sockets } = setup()
    const connected = vi.fn()
    events.setHandlers({ tileUpdated: vi.fn(), tileHighlight: vi.fn(), connected })
    events.want('p1', true)
    sockets[0].emit('connect')
    sockets[0].emit('disconnect', 'transport close')
    sockets[0].emit('connect')
    expect(connected.mock.calls).toEqual([['p1'], ['p1']])
  })

  it('closes after a short debounce when no longer wanted, and not when wanted again in time', () => {
    const { events, sockets, fire } = setup()
    events.want('p1', true)
    events.want('p1', false)
    events.want('p1', true)
    fire(CLOSE_DEBOUNCE_MS)
    expect(sockets[0].disconnected).toBe(0)
    events.want('p1', false)
    fire(CLOSE_DEBOUNCE_MS)
    expect(sockets[0].disconnected).toBe(1)
    expect(events.isLive('p1')).toBe(false)
    events.want('p1', true)
    expect(sockets).toHaveLength(2)
  })

  it('closes on closeAll and on another profile, and opens nothing for a profile without Cinna', () => {
    const { events, sockets } = setup()
    events.want('p1', true)
    events.closeAll()
    expect(sockets[0].disconnected).toBe(1)
    events.want('p1', true)
    events.want('p2', true)
    expect(sockets[1].disconnected).toBe(1)
    expect(sockets[2].url).toBe('https://cinna.example.com')
    events.want('local-only', true)
    expect(sockets).toHaveLength(3)
    expect(sockets[2].disconnected).toBe(1)
  })

  it('replaces the connection when the Cinna session changed', async () => {
    const { events, sockets, bump } = setup()
    events.want('p1', true)
    bump()
    // At the next reconnect: no token for the old session; a new connection for the new one.
    expect(await sockets[0].auth()).toBeNull()
    expect(sockets[0].disconnected).toBe(1)
    expect(sockets).toHaveLength(2)
    bump()
    events.want('p1', true)
    expect(sockets[1].disconnected).toBe(1)
    expect(sockets).toHaveLength(3)
  })

  it('stops on a session that needs a new sign-in until the session changes', async () => {
    const token = vi.fn(async () => { throw new Error('reauth') })
    const { events, sockets, bump } = setup({ token })
    events.want('p1', true)
    expect(await sockets[0].auth()).toBeNull()
    expect(sockets[0].disconnected).toBe(1)
    events.want('p1', true)
    expect(sockets).toHaveLength(1)
    bump()
    events.want('p1', true)
    expect(sockets).toHaveLength(2)
  })

  it('reconnects itself after core closed the connection', () => {
    const { events, sockets, fire } = setup()
    events.want('p1', true)
    sockets[0].emit('disconnect', 'io server disconnect')
    fire(SERVER_CLOSE_RETRY_MS)
    expect(sockets[0].connects).toBe(1)
    sockets[0].emit('disconnect', 'transport close')
    fire(SERVER_CLOSE_RETRY_MS)
    expect(sockets[0].connects).toBe(1)
  })

  it('tries again with a growing backoff when core refuses the connect, which socket.io gives up on', async () => {
    const { events, sockets, fire, deps } = setup()
    events.want('p1', true)
    const socket = sockets[0]
    // A transport failure: socket.io still retries on its own, nothing scheduled here.
    socket.emit('connect_error', new Error('xhr poll error'))
    fire(CONNECT_REFUSED_RETRY_MS)
    expect(socket.connects).toBe(0)
    // Core's connect returned False (CONNECT_ERROR): socket.io destroyed the socket.
    socket.active = false
    socket.emit('connect_error', new Error('connection refused'))
    socket.emit('connect_error', new Error('connection refused')) // one retry pending at a time
    fire(CONNECT_REFUSED_RETRY_MS)
    expect(socket.connects).toBe(1)
    // A fresh token on the retry's auth.
    const before = (deps.token as ReturnType<typeof vi.fn>).mock.calls.length
    await socket.auth()
    expect((deps.token as ReturnType<typeof vi.fn>).mock.calls.length).toBe(before + 1)
    socket.emit('connect_error', new Error('connection refused'))
    fire(CONNECT_REFUSED_RETRY_MS)
    expect(socket.connects).toBe(1)
    fire(CONNECT_REFUSED_RETRY_MS * 2)
    expect(socket.connects).toBe(2)
    // Capped.
    for (let i = 0; i < 12; i++) socket.emit('connect_error', new Error('connection refused')), fire(Math.min(CONNECT_REFUSED_RETRY_MS * 2 ** (i + 2), CONNECT_REFUSED_RETRY_MAX_MS))
    expect(socket.connects).toBe(14)
    // A connect resets the backoff.
    socket.emit('connect')
    socket.emit('connect_error', new Error('connection refused'))
    fire(CONNECT_REFUSED_RETRY_MS)
    expect(socket.connects).toBe(15)
  })

  it('does not retry a refused connect once closed', () => {
    const { events, sockets, fire } = setup()
    events.want('p1', true)
    sockets[0].active = false
    sockets[0].emit('connect_error', new Error('connection refused'))
    events.closeAll()
    fire(CONNECT_REFUSED_RETRY_MS)
    expect(sockets[0].connects).toBe(0)
  })
})
