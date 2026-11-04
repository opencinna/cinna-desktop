import { afterEach, describe, expect, it, vi } from 'vitest'
import { MAX_ASK_TEXT, createBridgeSession, linkTarget, readCollectedContext, readModelContext } from './componentBridge'

/** The host's checks on a dashboard frame's messages (spike §3's cases). */

function setup() {
  const frame = { name: 'tile frame' }
  const posted: Array<Record<string, unknown>> = []
  const onInitialized = vi.fn()
  let n = 0
  const session = createBridgeSession({
    frameWindow: () => frame,
    post: (message) => posted.push(message as Record<string, unknown>),
    hostContext: () => ({ theme: 'dark', styles: { variables: { '--cinna-bg': '#000' } } }),
    meta: () => ({ component: 'chart', title: 'Chart', params: { month: 'current' }, size: 'm' }),
    onInitialized,
    newNonce: () => `nonce-${++n}`
  })
  const from = (data: unknown, source: unknown = frame, origin = 'null') => session.receive({ source, origin, data })
  const initialize = (id = 1) => from({ jsonrpc: '2.0', id, method: 'ui/initialize', params: {} })
  const lastNonce = () => ((posted.filter((m) => m.result).at(-1)!.result as { _meta: { cinna: { nonce: string } } })._meta.cinna.nonce)
  return { frame, posted, onInitialized, session, from, initialize, lastNonce }
}

describe('the component bridge', () => {
  it('answers ui/initialize with the host context, the tile and a nonce, and sends data only after initialized', () => {
    const { posted, onInitialized, session, from, initialize, lastNonce } = setup()
    expect(initialize(7)).toBe('accepted')
    expect(posted[0]).toEqual({
      jsonrpc: '2.0',
      id: 7,
      result: expect.objectContaining({
        protocolVersion: '2026-01-26',
        hostContext: { theme: 'dark', styles: { variables: { '--cinna-bg': '#000' } } },
        _meta: { cinna: { nonce: 'nonce-1', component: 'chart', title: 'Chart', params: { month: 'current' }, size: 'm' } }
      })
    })
    expect(session.sendData({ items: [] }, { stale: true, fetchedAt: 1 })).toBe(false)
    expect(from({ jsonrpc: '2.0', method: 'ui/notifications/initialized', params: { _meta: { cinna: { nonce: lastNonce() } } } })).toBe('accepted')
    expect(onInitialized).toHaveBeenCalledOnce()
    expect(session.sendData({ items: [] }, { stale: true, fetchedAt: 1 })).toBe(true)
    expect(posted.at(-1)).toEqual({
      jsonrpc: '2.0',
      method: 'ui/notifications/tool-result',
      params: { structuredContent: { items: [] }, content: [], _meta: { cinna: { stale: true, fetched_at: 1 } } }
    })
    expect(session.sendHostContext()).toBe(true)
    expect(posted.at(-1)).toMatchObject({ method: 'ui/notifications/host-context-changed', params: { theme: 'dark' } })
  })

  it('ignores a message from any window but the tile’s frame, the host window included', () => {
    const { from, posted } = setup()
    expect(from({ jsonrpc: '2.0', id: 1, method: 'ui/initialize' }, { name: 'another tile' })).toBe('ignored')
    expect(from({ jsonrpc: '2.0', id: 1, method: 'ui/initialize' }, globalThis)).toBe('ignored')
    expect(posted).toEqual([])
  })

  it('rejects a message whose origin is not opaque', () => {
    const { from, frame, posted } = setup()
    expect(from({ jsonrpc: '2.0', id: 1, method: 'ui/initialize' }, frame, 'cinna-preview://dash-x')).toBe('rejected')
    expect(from({ jsonrpc: '2.0', id: 1, method: 'ui/initialize' }, frame, 'http://localhost:5173')).toBe('rejected')
    expect(posted).toEqual([])
  })

  it('rejects messages with no nonce, another tile’s nonce, or before initialize', () => {
    const { from, initialize, onInitialized } = setup()
    expect(from({ jsonrpc: '2.0', method: 'ui/notifications/initialized' })).toBe('rejected')
    initialize()
    expect(from({ jsonrpc: '2.0', method: 'ui/notifications/initialized' })).toBe('rejected')
    expect(from({ jsonrpc: '2.0', method: 'ui/notifications/initialized', params: { _meta: { cinna: { nonce: 'nonce-of-another-tile' } } } })).toBe('rejected')
    expect(onInitialized).not.toHaveBeenCalled()
  })

  it('rotates the nonce on every ui/initialize: the previous document’s nonce is dead, and data waits for the new handshake', () => {
    const { from, initialize, lastNonce, session, onInitialized } = setup()
    initialize(1)
    const first = lastNonce()
    from({ jsonrpc: '2.0', method: 'ui/notifications/initialized', params: { _meta: { cinna: { nonce: first } } } })
    expect(session.isInitialized()).toBe(true)
    // The page reloaded: its new document initializes again, before any load event.
    initialize(1)
    const second = lastNonce()
    expect(second).not.toBe(first)
    expect(session.isInitialized()).toBe(false)
    expect(session.sendData({}, { stale: false, fetchedAt: 2 })).toBe(false)
    expect(from({ jsonrpc: '2.0', method: 'ui/notifications/initialized', params: { _meta: { cinna: { nonce: first } } } })).toBe('rejected')
    expect(from({ jsonrpc: '2.0', method: 'ui/notifications/initialized', params: { _meta: { cinna: { nonce: second } } } })).toBe('accepted')
    expect(onInitialized).toHaveBeenCalledTimes(2)
  })

  it('answers any other request with a JSON-RPC error and drops other notifications', () => {
    const { from, initialize, lastNonce, posted } = setup()
    initialize()
    const nonce = lastNonce()
    expect(from({ jsonrpc: '2.0', id: 5, method: 'tools/call', params: { name: 'x', _meta: { cinna: { nonce } } } })).toBe('accepted')
    expect(posted.at(-1)).toEqual({ jsonrpc: '2.0', id: 5, error: { code: -32601, message: 'tools/call is not available here.' } })
    const count = posted.length
    expect(from({ jsonrpc: '2.0', method: 'ui/update-model-context', params: { _meta: { cinna: { nonce: nonce } } } })).toBe('ignored')
    expect(posted).toHaveLength(count)
    expect(from({ jsonrpc: '1.0', id: 6, method: 'x', params: { _meta: { cinna: { nonce: nonce } } } })).toBe('rejected')
    // setContext is answered and dropped; setParams is a notification, dropped.
    expect(from({ jsonrpc: '2.0', id: 7, method: 'ui/update-model-context', params: { content: [], _meta: { cinna: { nonce } } } })).toBe('accepted')
    expect(posted.at(-1)).toEqual({ jsonrpc: '2.0', id: 7, result: {} })
    const before = posted.length
    expect(from({ jsonrpc: '2.0', method: 'cinna/params-changed', params: { params: { month: '2026-01' }, _meta: { cinna: { nonce } } } })).toBe('ignored')
    expect(posted).toHaveLength(before)
    expect(from('not an object')).toBe('rejected')
  })
})

/**
 * The kit's real `dashboards-bridge.js`, from the bundle, against this
 * host session: the two halves of the wire agree, and the D1 no-ops neither
 * throw nor leave an unhandled rejection.
 */
describe('the kit bridge against this host', () => {
  async function wire(
    onContext?: (context: { summary: string; selection: string[] }) => void,
    extra: Partial<Parameters<typeof createBridgeSession>[0]> = {}
  ) {
    const { readFileSync } = await import('node:fs')
    const { DASHBOARDS_BRIDGE_REPO_PATH } = await import('../../../../main/kit/dashboardsProtocol')
    const DASHBOARDS_BRIDGE_SCRIPT = readFileSync(DASHBOARDS_BRIDGE_REPO_PATH, 'utf8')
    const frameListeners: Array<(event: { source: unknown; data: unknown }) => void> = []
    const frame: Record<string, unknown> = {
      parent: {
        postMessage: (data: unknown) => {
          // Cloned, as postMessage does.
          queueMicrotask(() => session.receive({ source: frame, origin: 'null', data: JSON.parse(JSON.stringify(data)) }))
        }
      },
      addEventListener: (_type: string, listener: (event: { source: unknown; data: unknown }) => void) => frameListeners.push(listener)
    }
    const session = createBridgeSession({
      frameWindow: () => frame,
      post: (message) => queueMicrotask(() => frameListeners.forEach((l) => l({ source: (frame.parent as object), data: JSON.parse(JSON.stringify(message)) }))),
      hostContext: () => ({ theme: 'dark', styles: { variables: { '--cinna-bg': '#111' } } }),
      meta: () => ({ component: 'chart', title: 'Chart', params: { month: '2026-11' }, size: 'l' }),
      onInitialized: () => session.sendData({ weeks: [1] }, { stale: true, fetchedAt: 5 }),
      onContext,
      ...extra
    })
    const documentStub = { documentElement: { style: { setProperty: () => {}, colorScheme: '' }, setAttribute: () => {} } }
    new Function('window', 'document', DASHBOARDS_BRIDGE_SCRIPT)(frame, documentStub)
    return { cinna: frame.cinna as Record<string, (...args: unknown[]) => unknown> & { ready: Promise<unknown> }, session }
  }
  const flush = () => new Promise((resolve) => setTimeout(resolve, 0))

  it('completes the handshake, delivers data with its meta, and rejects call with {message}', async () => {
    const unhandled = vi.fn()
    process.on('unhandledRejection', unhandled)
    try {
      const { cinna, session } = await wire()
      expect(await cinna.ready).toEqual({ component: 'chart', title: 'Chart', params: { month: '2026-11' }, theme: 'dark', size: 'l' })
      const seen: unknown[] = []
      cinna.onData((data: unknown, meta: unknown) => seen.push([data, meta]))
      await flush()
      expect(seen).toEqual([[{ weeks: [1] }, { stale: true, fetched_at: 5 }]])
      expect(session.isInitialized()).toBe(true)
      session.sendData({ weeks: [2] }, { stale: false, fetchedAt: 9 })
      await flush()
      expect(seen.at(-1)).toEqual([{ weeks: [2] }, { stale: false, fetched_at: 9 }])
      await expect(cinna.call('week_detail', { week: 'W1' })).rejects.toEqual({ message: 'tools/call is not available here.' })
      expect(() => cinna.setParams({ month: '2026-10' })).not.toThrow()
      expect(() => cinna.setContext({ summary: 's', selection: [], visible: [] })).not.toThrow()
      expect(() => cinna.ask('why?')).not.toThrow()
      expect(() => cinna.openLink('https://example.com')).not.toThrow()
      await flush(); await flush()
      expect(unhandled).not.toHaveBeenCalled()
    } finally {
      process.off('unhandledRejection', unhandled)
    }
  })

  it('hands the page’s setContext to the host as {summary, selection}', async () => {
    const onContext = vi.fn()
    const { cinna } = await wire(onContext)
    await cinna.ready
    await cinna.setContext({ summary: 'Two deals stalled', selection: ['d-17', 21], visible: ['d-1'] })
    expect(onContext).toHaveBeenCalledWith({ summary: 'Two deals stalled', selection: ['d-17', '21'] })
  })
})

describe('setContext on the host', () => {
  it('keeps only a nonced request, as {summary, selection}', () => {
    const onContext = vi.fn()
    const frame = { name: 'tile frame' }
    const posted: Array<Record<string, unknown>> = []
    const session = createBridgeSession({
      frameWindow: () => frame,
      post: (message) => posted.push(message as Record<string, unknown>),
      hostContext: () => ({ theme: 'dark', styles: { variables: {} } }),
      meta: () => ({ component: 'c', title: 'C', params: {}, size: 'm' }),
      onInitialized: () => {},
      onContext,
      newNonce: () => 'n1'
    })
    const from = (data: unknown) => session.receive({ source: frame, origin: 'null', data })
    from({ jsonrpc: '2.0', id: 1, method: 'ui/initialize', params: {} })
    expect(from({ jsonrpc: '2.0', id: 2, method: 'ui/update-model-context', params: { structuredContent: { summary: 'x' }, _meta: { cinna: { nonce: 'wrong' } } } })).toBe('rejected')
    expect(onContext).not.toHaveBeenCalled()
    expect(from({ jsonrpc: '2.0', id: 3, method: 'ui/update-model-context', params: { structuredContent: { summary: 'x', selection: ['a'] }, _meta: { cinna: { nonce: 'n1' } } } })).toBe('accepted')
    expect(onContext).toHaveBeenCalledWith({ summary: 'x', selection: ['a'] })
    expect(posted.at(-1)).toEqual({ jsonrpc: '2.0', id: 3, result: {} })
  })

  it('reads the text content when there is no structured summary, and drops what is not an id', () => {
    expect(readModelContext({ content: [{ type: 'text', text: 'a' }, { type: 'image' }, { type: 'text', text: 'b' }] })).toEqual({ summary: 'a\nb', selection: [] })
    expect(readModelContext({ structuredContent: { summary: 's', selection: ['x', '', 3, null, { id: 1 }, Number.NaN] } })).toEqual({ summary: 's', selection: ['x', '3'] })
    expect(readModelContext(null)).toEqual({ summary: '', selection: [] })
    expect(readModelContext({ structuredContent: { selection: Array.from({ length: 500 }, (_, i) => `r${i}`) } }).selection).toHaveLength(200)
  })
})

describe('the D4 bridge methods (kit bridge against this host)', () => {
  async function wired(extra: Partial<Parameters<typeof createBridgeSession>[0]>) {
    const { readFileSync } = await import('node:fs')
    const { DASHBOARDS_BRIDGE_REPO_PATH } = await import('../../../../main/kit/dashboardsProtocol')
    const script = readFileSync(DASHBOARDS_BRIDGE_REPO_PATH, 'utf8')
    const listeners: Array<(event: { source: unknown; data: unknown }) => void> = []
    const frame: Record<string, unknown> = {
      parent: { postMessage: (data: unknown) => queueMicrotask(() => session.receive({ source: frame, origin: 'null', data: JSON.parse(JSON.stringify(data)) })) },
      addEventListener: (_type: string, listener: (event: { source: unknown; data: unknown }) => void) => listeners.push(listener)
    }
    const session = createBridgeSession({
      frameWindow: () => frame,
      post: (message) => queueMicrotask(() => listeners.forEach((l) => l({ source: frame.parent, data: JSON.parse(JSON.stringify(message)) }))),
      hostContext: () => ({ theme: 'light', styles: { variables: {} } }),
      meta: () => ({ component: 'chart', title: 'Chart', params: {}, size: 'm' }),
      onInitialized: () => {},
      ...extra
    })
    const documentStub = { documentElement: { style: { setProperty: () => {}, colorScheme: '' }, setAttribute: () => {} } }
    new Function('window', 'document', script)(frame, documentStub)
    const cinna = frame.cinna as Record<string, (...args: unknown[]) => Promise<unknown>> & { ready: Promise<unknown> }
    await cinna.ready
    return { cinna, session }
  }
  const flush = () => new Promise((resolve) => setTimeout(resolve, 0))

  it('cinna.call runs the endpoint through call and resolves with its value', async () => {
    const call = vi.fn(async () => ({ ok: true as const, value: { rows: [1, 2] } }))
    const { cinna } = await wired({ call })
    await expect(cinna.call('week_detail', { week: 'W1' })).resolves.toEqual({ rows: [1, 2] })
    expect(call).toHaveBeenCalledWith('week_detail', { week: 'W1' })
  })

  it('cinna.call rejects with the endpoint’s message when it fails or is refused', async () => {
    const call = vi.fn(async () => ({ ok: false as const, code: 'limit_reached' as const, message: 'Too many calls from this tile.' }))
    const { cinna } = await wired({ call })
    await expect(cinna.call('week_detail')).rejects.toEqual({ message: 'Too many calls from this tile.' })
    expect(call).toHaveBeenCalledWith('week_detail', {})
  })

  it('cinna.call rejects with a message when the IPC itself throws', async () => {
    const { cinna } = await wired({ call: vi.fn(async () => { throw new Error('ipc gone') }) })
    await expect(cinna.call('week_detail')).rejects.toEqual({ message: 'week_detail could not be run.' })
  })

  it('cinna.setParams hands the params to onParams, without the bridge’s _meta', async () => {
    const onParams = vi.fn()
    const { cinna } = await wired({ onParams })
    cinna.setParams({ month: '2026-10' })
    await flush(); await flush()
    expect(onParams).toHaveBeenCalledWith({ month: '2026-10' })
  })

  it('cinna.ask hands the text to onAsk (it never sends), capped; no panel rejects', async () => {
    const onAsk = vi.fn(() => true)
    const { cinna } = await wired({ onAsk })
    await expect(cinna.ask('Why did W3 drop?')).resolves.toEqual({})
    expect(onAsk).toHaveBeenCalledWith('Why did W3 drop?')
    await cinna.ask('x'.repeat(MAX_ASK_TEXT + 50))
    expect((onAsk.mock.calls.at(-1) as unknown as [string])[0]).toHaveLength(MAX_ASK_TEXT)
    const noPanel = await wired({ onAsk: () => false })
    await expect(noPanel.cinna.ask('hi')).rejects.toEqual({ message: 'There is no chat to ask here.' })
  })

  it('cinna.openLink waits for the owner: opened resolves, declined rejects, and only http(s) is asked about', async () => {
    let decide: (opened: boolean) => void = () => {}
    const openLink = vi.fn(() => new Promise<boolean>((resolve) => { decide = resolve }))
    const { cinna } = await wired({ openLink })
    let settled = false
    const first = cinna.openLink('https://example.com/deals?id=7').then(() => { settled = true })
    await flush(); await flush()
    expect(openLink).toHaveBeenCalledWith('https://example.com/deals?id=7')
    expect(settled).toBe(false)
    // A second link while the first is on screen is refused, not stacked.
    await expect(cinna.openLink('https://example.com/other')).rejects.toEqual({ message: 'Another link is waiting for the owner.' })
    decide(true)
    await first
    expect(settled).toBe(true)

    const declined = cinna.openLink('https://example.com/b')
    await flush(); await flush()
    decide(false)
    await expect(declined).rejects.toEqual({ message: 'The link was not opened.' })

    openLink.mockClear()
    for (const url of ['javascript:alert(1)', 'file:///etc/passwd', 'cinna://agent/x', 'not a url']) {
      await expect(cinna.openLink(url)).rejects.toEqual({ message: 'Only web (http, https) and mailto links open from a dashboard.' })
    }
    expect(openLink).not.toHaveBeenCalled()
  })

  it('after the owner declines a link, the page’s next ones are refused without asking until it re-initialises', async () => {
    const posted: Array<Record<string, unknown>> = []
    const frame = {}
    let n = 0
    let decide: (opened: boolean) => void = () => {}
    const openLink = vi.fn(() => new Promise<boolean>((resolve, reject) => {
      decide = (opened) => (opened === null ? reject(new Error('gone')) : resolve(opened))
    }))
    const session = createBridgeSession({
      frameWindow: () => frame,
      post: (message) => posted.push(message as Record<string, unknown>),
      hostContext: () => ({ theme: 'light', styles: { variables: {} } }),
      meta: () => ({ component: 'c', title: 'C', params: {}, size: 'm' }),
      onInitialized: () => {},
      openLink,
      newNonce: () => `n-${++n}`
    })
    const init = (id: number) => session.receive({ source: frame, origin: 'null', data: { jsonrpc: '2.0', id, method: 'ui/initialize' } })
    const ask = (id: number) => session.receive({
      source: frame, origin: 'null',
      data: { jsonrpc: '2.0', id, method: 'ui/open-link', params: { url: 'https://example.com/', _meta: { cinna: { nonce: `n-${n}` } } } }
    })
    const answer = (id: number) => posted.find((m) => m.id === id)
    init(1)
    // A failure to ask (not the owner's no) leaves links open.
    ask(2)
    decide(null as never)
    await flush()
    expect(answer(2)).toMatchObject({ error: { message: 'The link was not opened.' } })
    ask(3)
    expect(openLink).toHaveBeenCalledTimes(2)
    decide(false)
    await flush()
    expect(answer(3)).toMatchObject({ error: { message: 'The link was not opened.' } })
    ask(4)
    ask(5)
    expect(openLink).toHaveBeenCalledTimes(2)
    expect(answer(4)).toMatchObject({ error: { message: 'The owner declined a link from this page.' } })
    expect(answer(5)).toMatchObject({ error: { message: 'The owner declined a link from this page.' } })
    // A new document asks again.
    init(6)
    ask(7)
    expect(openLink).toHaveBeenCalledTimes(3)
    decide(true)
    await flush()
    expect(answer(7)).toEqual({ jsonrpc: '2.0', id: 7, result: {} })
  })

  it('drops an answer that arrives after the page re-initialised', async () => {
    let resolveCall: (value: { ok: true; value: unknown }) => void = () => {}
    const posted: Array<Record<string, unknown>> = []
    const frame = {}
    let n = 0
    const session = createBridgeSession({
      frameWindow: () => frame,
      post: (message) => posted.push(message as Record<string, unknown>),
      hostContext: () => ({ theme: 'light', styles: { variables: {} } }),
      meta: () => ({ component: 'c', title: 'C', params: {}, size: 'm' }),
      onInitialized: () => {},
      call: () => new Promise((resolve) => { resolveCall = resolve }),
      newNonce: () => `n-${++n}`
    })
    session.receive({ source: frame, origin: 'null', data: { jsonrpc: '2.0', id: 1, method: 'ui/initialize' } })
    session.receive({ source: frame, origin: 'null', data: { jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'e', _meta: { cinna: { nonce: 'n-1' } } } } })
    session.receive({ source: frame, origin: 'null', data: { jsonrpc: '2.0', id: 1, method: 'ui/initialize' } })
    const count = posted.length
    resolveCall({ ok: true, value: 1 })
    await flush()
    expect(posted).toHaveLength(count)
  })
})

describe('linkTarget', () => {
  it('accepts http, https and mailto only', () => {
    expect(linkTarget('https://a.example/x')?.host).toBe('a.example')
    expect(linkTarget('http://a.example')?.protocol).toBe('http:')
    expect(linkTarget('mailto:a@b.c')?.protocol).toBe('mailto:')
    expect(linkTarget('javascript:alert(1)')).toBeNull()
    expect(linkTarget('file:///etc/passwd')).toBeNull()
    expect(linkTarget('data:text/html,hi')).toBeNull()
    expect(linkTarget(42)).toBeNull()
  })
})

describe('D5 on the host: highlight and collect-context', () => {
  function d5(extra: Partial<Parameters<typeof createBridgeSession>[0]> = {}) {
    const frame = { name: 'tile frame' }
    const posted: Array<Record<string, unknown>> = []
    let n = 0
    const session = createBridgeSession({
      frameWindow: () => frame,
      post: (message) => posted.push(message as Record<string, unknown>),
      hostContext: () => ({ theme: 'dark', styles: { variables: {} } }),
      meta: () => ({ component: 'chart', title: 'Chart', params: {}, size: 'm' }),
      onInitialized: () => {},
      newNonce: () => `nonce-${++n}`,
      ...extra
    })
    const from = (data: unknown) => session.receive({ source: frame, origin: 'null', data })
    const init = (id = 1) => {
      from({ jsonrpc: '2.0', id, method: 'ui/initialize', params: {} })
      const nonce = `nonce-${n}`
      from({ jsonrpc: '2.0', method: 'ui/notifications/initialized', params: { _meta: { cinna: { nonce } } } })
      return nonce
    }
    const ready = (nonce: string) => from({ jsonrpc: '2.0', method: 'cinna/highlight-ready', params: { _meta: { cinna: { nonce } } } })
    return { session, posted, from, init, ready }
  }
  afterEach(() => vi.useRealTimers())

  it('hands cinna/highlight-ready to onHighlightReady once per document, and only after initialized', () => {
    const onHighlightReady = vi.fn()
    const { from, init, ready, session } = d5({ onHighlightReady })
    from({ jsonrpc: '2.0', id: 1, method: 'ui/initialize', params: {} })
    expect(ready('nonce-1')).toBe('ignored')
    from({ jsonrpc: '2.0', method: 'ui/notifications/initialized', params: { _meta: { cinna: { nonce: 'nonce-1' } } } })
    expect(ready('nonce-other')).toBe('rejected')
    expect(ready('nonce-1')).toBe('accepted')
    expect(ready('nonce-1')).toBe('accepted')
    expect(onHighlightReady).toHaveBeenCalledOnce()
    expect(session.isHighlightReady()).toBe(true)
    // A reloaded document starts over and says it again.
    const second = init(2)
    expect(session.isHighlightReady()).toBe(false)
    ready(second)
    expect(onHighlightReady).toHaveBeenCalledTimes(2)
  })

  it('reports a ready document replaced by a new load to onHighlightLost, and only then', () => {
    const onHighlightLost = vi.fn()
    const { init, ready } = d5({ onHighlightReady: () => {}, onHighlightLost })
    init(1)
    init(2)
    expect(onHighlightLost).not.toHaveBeenCalled()
    ready(`nonce-2`)
    init(3)
    expect(onHighlightLost).toHaveBeenCalledOnce()
  })

  it('a host with no highlight (a preview) ignores highlight-ready and sends none', () => {
    const { init, ready, session, posted } = d5()
    const nonce = init()
    expect(ready(nonce)).toBe('ignored')
    expect(session.sendHighlight(['a'])).toBe(false)
    expect(posted.some((m) => m.method === 'cinna/highlight')).toBe(false)
  })

  it('sends cinna/highlight {ids} with the nonce only to a ready document', () => {
    const { init, ready, session, posted } = d5({ onHighlightReady: () => {} })
    const nonce = init()
    expect(session.sendHighlight(['a'])).toBe(false)
    ready(nonce)
    expect(session.sendHighlight(['o-1', 'o-2'])).toBe(true)
    expect(posted.at(-1)).toEqual({ jsonrpc: '2.0', method: 'cinna/highlight', params: { ids: ['o-1', 'o-2'], _meta: { cinna: { nonce } } } })
    expect(session.sendHighlight([])).toBe(true)
    expect(posted.at(-1)).toMatchObject({ method: 'cinna/highlight', params: { ids: [] } })
  })

  it('collect-context: a nonced request, resolved with the cleaned answer', async () => {
    const { init, session, posted, from } = d5()
    expect(await session.collectContext()).toBeNull()
    const nonce = init()
    const pending = session.collectContext()
    const request = posted.at(-1)!
    expect(request).toMatchObject({ jsonrpc: '2.0', method: 'cinna/collect-context', params: { _meta: { cinna: { nonce } } } })
    // Another document's answer, or none of ours, settles nothing.
    expect(from({ jsonrpc: '2.0', id: request.id, result: { source: 'collected', _meta: { cinna: { nonce: 'nonce-9' } } } })).toBe('rejected')
    expect(from({ jsonrpc: '2.0', id: 'unknown', result: { _meta: { cinna: { nonce } } } })).toBe('ignored')
    expect(from({
      jsonrpc: '2.0', id: request.id,
      result: { source: 'collected', summary: 'Pipeline', selection: ['o-1', 3], visible: [], microdata: [{ id: 'o-1', type: 'Order', properties: { status: 'open' } }, 'junk'], selected_text: 'Acme', _meta: { cinna: { nonce } } }
    })).toBe('accepted')
    expect(await pending).toEqual({
      source: 'collected', summary: 'Pipeline', selection: ['o-1'], visible: [],
      microdata: [{ id: 'o-1', type: 'Order', properties: { status: 'open' } }], selected_text: 'Acme'
    })
  })

  it('collect-context: no answer within 500 ms, an error, or a re-initialise is nothing', async () => {
    vi.useFakeTimers()
    const { init, session, posted, from } = d5()
    const nonce = init()
    const silent = session.collectContext()
    await vi.advanceTimersByTimeAsync(499)
    let settled = false
    void silent.then(() => { settled = true })
    await Promise.resolve()
    expect(settled).toBe(false)
    await vi.advanceTimersByTimeAsync(1)
    expect(await silent).toBeNull()
    const failed = session.collectContext()
    from({ jsonrpc: '2.0', id: posted.at(-1)!.id, error: { code: -32601, message: 'no', data: { _meta: { cinna: { nonce } } } } })
    expect(await failed).toBeNull()
    const orphaned = session.collectContext()
    init(2)
    expect(await orphaned).toBeNull()
  })

  it('readCollectedContext caps what a page that is not the kit’s sends', () => {
    expect(readCollectedContext('x')).toBeNull()
    const big = readCollectedContext({ source: 'weird', selected_text: 'x'.repeat(5000), selection: Array.from({ length: 900 }, (_, i) => `i${i}`), microdata: Array.from({ length: 300 }, () => ({ properties: Object.fromEntries(Array.from({ length: 40 }, (_, i) => [`p${i}`, 'v'.repeat(500)])) })) })!
    expect(big.source).toBe('collected')
    expect(big.selected_text).toHaveLength(2000)
    expect(big.selection).toHaveLength(500)
    expect(big.microdata).toHaveLength(100)
    expect(Object.keys(big.microdata[0].properties)).toHaveLength(20)
    expect(big.microdata[0].properties.p0).toHaveLength(200)
  })
})

describe('D5 against the kit’s bridge', () => {
  async function kit(extra: Partial<Parameters<typeof createBridgeSession>[0]>) {
    const { readFileSync } = await import('node:fs')
    const { DASHBOARDS_BRIDGE_REPO_PATH } = await import('../../../../main/kit/dashboardsProtocol')
    const script = readFileSync(DASHBOARDS_BRIDGE_REPO_PATH, 'utf8')
    const listeners: Array<(event: { source: unknown; data: unknown }) => void> = []
    const frame: Record<string, unknown> = {
      parent: { postMessage: (data: unknown) => queueMicrotask(() => session.receive({ source: frame, origin: 'null', data: JSON.parse(JSON.stringify(data)) })) },
      addEventListener: (_type: string, listener: (event: { source: unknown; data: unknown }) => void) => listeners.push(listener),
      getSelection: () => ({ toString: () => '  Acme   renewal ', isCollapsed: true })
    }
    const session = createBridgeSession({
      frameWindow: () => frame,
      post: (message) => queueMicrotask(() => listeners.forEach((l) => l({ source: frame.parent, data: JSON.parse(JSON.stringify(message)) }))),
      hostContext: () => ({ theme: 'light', styles: { variables: {} } }),
      meta: () => ({ component: 'chart', title: 'Chart', params: {}, size: 'm' }),
      onInitialized: () => {},
      ...extra
    })
    const documentStub = { title: 'Pipeline', querySelectorAll: () => [], documentElement: { style: { setProperty: () => {}, colorScheme: '' }, setAttribute: () => {} } }
    new Function('window', 'document', script)(frame, documentStub)
    const cinna = frame.cinna as Record<string, (...args: unknown[]) => unknown> & { ready: Promise<unknown> }
    await cinna.ready
    return { cinna, session }
  }
  const flush = () => new Promise((resolve) => setTimeout(resolve, 0))

  it('onHighlight sends highlight-ready, and the page’s listener gets the ids the host sends', async () => {
    const onHighlightReady = vi.fn()
    const { cinna, session } = await kit({ onHighlightReady })
    const seen: unknown[] = []
    cinna.onHighlight((ids: unknown) => seen.push(ids))
    await flush()
    expect(onHighlightReady).toHaveBeenCalledOnce()
    expect(session.sendHighlight(['o-1'])).toBe(true)
    await flush()
    expect(seen).toEqual([['o-1']])
  })

  it('collect-context is answered by the bridge itself: collected, then set_context after setContext', async () => {
    const { cinna, session } = await kit({ onContext: () => {} })
    expect(await session.collectContext()).toEqual({ source: 'collected', summary: 'Pipeline', selection: [], visible: [], microdata: [], selected_text: 'Acme renewal' })
    await cinna.setContext({ summary: 'Two deals stalled', selection: ['d-17'], visible: [] })
    expect(await session.collectContext()).toMatchObject({ source: 'set_context', summary: 'Two deals stalled', selection: ['d-17'], selected_text: 'Acme renewal' })
  })
})
