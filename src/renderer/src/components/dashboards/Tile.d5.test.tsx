import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { ComponentInfo, DashboardsTileHighlightPayload, TileResultDto, TileView } from '../../../../shared/dashboards'

vi.mock('../../stores/logger.store', () => ({
  createLogger: () => ({ debug: () => {}, info: () => {}, warn: () => {}, error: () => {} })
}))

import { Tile, type TileChat } from './Tile'

/** D5 on a tile: an agent's highlight in native and web views, and a page's collect-context. */

function tileView(over: Partial<ComponentInfo> = {}): TileView {
  return {
    tile: { id: 't1', dashboardId: 'd1', agentManifestId: 'sales', component: 'deals', skill: null, title: 'Deals', size: 'wide', position: 0, params: {}, refreshOverride: null },
    displayTitle: 'Deals',
    state: 'ok',
    component: {
      agentId: 'folder:sales', manifestId: 'sales', agentName: 'Sales Agent', name: 'deals', skill: null, title: 'Deals',
      description: '', view: 'list', size: 'wide', source: { endpoint: 'e' }, maxAge: '15m', refreshCommand: null,
      refresh: { maxAge: '15m', whileOpenEvery: null, afterTurn: false, onAppStart: false, command: null, schedule: null },
      params: {}, prompts: [], valid: true, findings: [], missingCredentials: [],
      ...over
    },
    schedule: null
  }
}

const LIST = { items: [{ id: 'a', title: 'Call Ana' }, { id: 'b', title: 'Call Bob' }, { id: 'c', title: 'Call Cy' }] }

let result: TileResultDto
let held: Promise<string[]>
let push: (payload: DashboardsTileHighlightPayload) => void
const clearHighlight = vi.fn()
const highlightReady = vi.fn()

function show(view: TileView, chat?: TileChat) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  const ui = (next?: TileChat) => (
    <QueryClientProvider client={client}>
      <Tile view={view} dashboardName="Sales" span={{ cols: 12, rows: 2 }} editMode={false} dragging={false} onHandlePointerDown={() => {}} onVisibilityChange={() => {}} chat={next} />
    </QueryClientProvider>
  )
  const rendered = render(ui(chat))
  return { ...rendered, rerenderChat: (next: TileChat) => rendered.rerender(ui(next)) }
}

function chatStub(over: Partial<TileChat> = {}): TileChat {
  return {
    focused: false, selected: [], onFocus: vi.fn(), onPick: vi.fn(), onClearSelection: vi.fn(), onContext: vi.fn(), onCollected: vi.fn(),
    onAsk: vi.fn(), onPrompt: vi.fn(), onFill: vi.fn(), ...over
  }
}

const row = (text: string) => screen.getByText(text).closest('li, tr') as HTMLElement
const lit = () => [...document.querySelectorAll('[data-highlighted="true"]')].map((node) => node.textContent)

beforeEach(() => {
  result = { tileId: 't1', data: LIST, fetchedAt: Date.now(), error: null, refreshing: false, stale: false, tooLarge: false, notice: null }
  held = Promise.resolve([])
  push = () => {}
  clearHighlight.mockReset().mockResolvedValue(true)
  highlightReady.mockReset().mockResolvedValue(true)
  window.api = {
    dashboards: {
      tileResult: async () => ({ ok: true, result }),
      onTileChanged: () => () => {},
      ensureFresh: async () => ({ ok: true }),
      highlight: () => held,
      clearHighlight,
      highlightReady,
      onTileHighlight: (handler: (payload: DashboardsTileHighlightPayload) => void) => {
        push = handler
        return () => { push = () => {} }
      },
      openFrame: async () => ({ ok: true, token: 'tok', url: 'cinna-preview://dash-h/t1/index.html' }),
      releaseFrame: async () => {}
    }
  } as never
})

describe('the agent’s highlight on a native tile', () => {
  it('draws the highlight it holds on mount, apart from the owner’s selection', async () => {
    held = Promise.resolve(['b', 'c'])
    show(tileView(), chatStub({ selected: ['c'] }))
    await screen.findByText('Call Bob')
    await waitFor(() => expect(lit()).toEqual(['Call Bob']))
    expect(row('Call Bob').className).toContain('dashboard-highlight')
    // Picked wins: the accent, never both.
    expect(row('Call Cy').getAttribute('aria-selected')).toBe('true')
    expect(row('Call Cy').className).not.toContain('dashboard-highlight')
    expect(row('Call Ana').className).not.toContain('dashboard-highlight')
  })

  it('follows the pushes for this tile, `[]` clears, and a push beats a late fetch', async () => {
    let resolveHeld: (ids: string[]) => void = () => {}
    held = new Promise((resolve) => { resolveHeld = resolve })
    show(tileView())
    await screen.findByText('Call Bob')
    act(() => push({ tileId: 't1', ids: ['a'] }))
    expect(lit()).toEqual(['Call Ana'])
    await act(async () => resolveHeld(['c']))
    expect(lit()).toEqual(['Call Ana'])
    act(() => push({ tileId: 'other', ids: ['b'] }))
    expect(lit()).toEqual(['Call Ana'])
    act(() => push({ tileId: 't1', ids: [] }))
    expect(lit()).toEqual([])
  })

  it('the owner picking an item ends it here and in main', async () => {
    held = Promise.resolve(['b'])
    const chat = chatStub()
    show(tileView(), chat)
    await waitFor(() => expect(lit()).toEqual(['Call Bob']))
    fireEvent.click(row('Call Ana'))
    expect(chat.onPick).toHaveBeenCalledWith('a', false)
    expect(clearHighlight).toHaveBeenCalledWith('t1')
    expect(lit()).toEqual([])
  })

  it('Escape on the tile ends it too, with no selection to clear', async () => {
    held = Promise.resolve(['b'])
    const chat = chatStub()
    const { container } = show(tileView(), chat)
    await waitFor(() => expect(lit()).toEqual(['Call Bob']))
    fireEvent.keyDown(container.querySelector('[data-tile-id="t1"]')!, { key: 'Escape' })
    expect(clearHighlight).toHaveBeenCalledOnce()
    expect(chat.onClearSelection).not.toHaveBeenCalled()
    expect(lit()).toEqual([])
  })

  it('draws table rows by their id field', async () => {
    result = { ...result, data: { columns: [{ key: 'name' }], rows: [{ id: 'r1', name: 'Acme' }, { id: 'r2', name: 'Globex' }] } }
    held = Promise.resolve(['r2'])
    show(tileView({ view: 'table' }))
    await waitFor(() => expect(lit()).toEqual(['Globex']))
    expect(row('Globex').tagName).toBe('TR')
  })

  it('a highlighted row says who highlighted it; a selected or plain one says nothing', async () => {
    held = Promise.resolve(['b', 'c'])
    show(tileView(), chatStub({ selected: ['c'] }))
    await waitFor(() => expect(lit()).toEqual(['Call Bob']))
    expect(row('Call Bob').getAttribute('title')).toBe('Highlighted by Sales Agent')
    expect(row('Call Bob').getAttribute('aria-description')).toBe('Highlighted by Sales Agent')
    expect(row('Call Cy').hasAttribute('title')).toBe(false)
    expect(row('Call Ana').hasAttribute('aria-description')).toBe(false)
  })

  it('a highlighted table row says it too, unless the owner selected it', async () => {
    result = { ...result, data: { columns: [{ key: 'name' }], rows: [{ id: 'r1', name: 'Acme' }, { id: 'r2', name: 'Globex' }] } }
    held = Promise.resolve(['r1', 'r2'])
    show(tileView({ view: 'table' }), chatStub({ selected: ['r1'] }))
    await waitFor(() => expect(row('Globex').getAttribute('title')).toBe('Highlighted by Sales Agent'))
    expect(row('Globex').getAttribute('aria-description')).toBe('Highlighted by Sales Agent')
    expect(row('Acme').hasAttribute('title')).toBe(false)
  })

  it('markdown and metrics views ignore it', async () => {
    held = Promise.resolve(['0', 'a'])
    result = { ...result, data: { items: [{ id: 'a', label: 'Revenue', value: 3 }] } }
    show(tileView({ view: 'metrics' }))
    await screen.findByText('Revenue')
    await act(async () => {})
    expect(lit()).toEqual([])
  })

  it('scrolls the tile’s own body to the first highlighted row, and nothing outside the tile', async () => {
    const items = Array.from({ length: 30 }, (_, i) => ({ id: `i${i}`, title: `Item ${i}` }))
    result = { ...result, data: { items } }
    const { container } = show(tileView())
    await screen.findByText('Item 29')
    const content = screen.getByTestId('tile-content')
    Object.defineProperty(content, 'scrollHeight', { value: 900, configurable: true })
    Object.defineProperty(content, 'clientHeight', { value: 200, configurable: true })
    vi.spyOn(content, 'getBoundingClientRect').mockReturnValue({ top: 100, bottom: 300 } as DOMRect)
    vi.spyOn(row('Item 20'), 'getBoundingClientRect').mockReturnValue({ top: 700, bottom: 728 } as DOMRect)
    const outer = container.querySelector('[data-tile-id="t1"]') as HTMLElement
    act(() => push({ tileId: 't1', ids: ['i20', 'i25'] }))
    expect(content.scrollTop).toBe(428)
    expect(outer.scrollTop).toBe(0)
    expect(document.documentElement.scrollTop).toBe(0)
  })

  it('"N highlighted" in the bar steps the tile body through the rows, wrapping, and goes when the highlight clears', async () => {
    const items = Array.from({ length: 30 }, (_, i) => ({ id: `i${i}`, title: `Item ${i}` }))
    result = { ...result, data: { items } }
    show(tileView())
    await screen.findByText('Item 29')
    expect(screen.queryByTestId('tile-highlight-count')).toBeNull()
    const content = screen.getByTestId('tile-content')
    Object.defineProperty(content, 'scrollHeight', { value: 900, configurable: true })
    Object.defineProperty(content, 'clientHeight', { value: 200, configurable: true })
    vi.spyOn(content, 'getBoundingClientRect').mockReturnValue({ top: 100, bottom: 300 } as DOMRect)
    // Each row where it sits, given how far the body has scrolled.
    const at = (title: string, top: number) =>
      vi.spyOn(row(title), 'getBoundingClientRect').mockImplementation(() => ({ top: top - content.scrollTop, bottom: top + 28 - content.scrollTop }) as DOMRect)
    at('Item 3', 150)
    at('Item 20', 700)
    at('Item 25', 850)
    act(() => push({ tileId: 't1', ids: ['i3', 'i20', 'i25'] }))
    const count = screen.getByTestId('tile-highlight-count')
    expect(count.textContent).toBe('3 highlighted')
    expect(count.tagName).toBe('BUTTON')
    // The bar's strip: the same box as before it appeared.
    expect(count.closest('[data-testid="tile-bar"]')).not.toBeNull()
    expect(content.scrollTop).toBe(0)
    fireEvent.click(count)
    expect(content.scrollTop).toBe(428)
    fireEvent.click(count)
    expect(content.scrollTop).toBe(578)
    // Wraps around to the first.
    fireEvent.click(count)
    expect(content.scrollTop).toBe(50)
    act(() => push({ tileId: 't1', ids: [] }))
    expect(screen.queryByTestId('tile-highlight-count')).toBeNull()
  })
})

/** A page in the tile's frame, talking to the real WebView. */
async function framePage() {
  const iframe = (await screen.findByTestId('dashboard-frame')) as HTMLIFrameElement
  const win = iframe.contentWindow!
  const posted: Array<Record<string, unknown>> = []
  vi.spyOn(win, 'postMessage').mockImplementation(((message: unknown) => { posted.push(message as Record<string, unknown>) }) as never)
  const send = (data: Record<string, unknown>) =>
    act(() => { window.dispatchEvent(new MessageEvent('message', { data, origin: 'null', source: win })) })
  let nonce = ''
  const init = (id: number) => {
    send({ jsonrpc: '2.0', id, method: 'ui/initialize', params: {} })
    nonce = (posted.filter((m) => m.id === id).at(-1)!.result as { _meta: { cinna: { nonce: string } } })._meta.cinna.nonce
    send({ jsonrpc: '2.0', method: 'ui/notifications/initialized', params: { _meta: { cinna: { nonce } } } })
  }
  init(1)
  const notify = (method: string, params: Record<string, unknown> = {}) => send({ jsonrpc: '2.0', method, params: { ...params, _meta: { cinna: { nonce } } } })
  const request = (id: number, method: string, params: Record<string, unknown>) => send({ jsonrpc: '2.0', id, method, params: { ...params, _meta: { cinna: { nonce } } } })
  const answer = (id: unknown, value: Record<string, unknown>) => send({ jsonrpc: '2.0', id, result: { ...value, _meta: { cinna: { nonce } } } })
  const highlights = () => posted.filter((m) => m.method === 'cinna/highlight').map((m) => (m.params as { ids: string[] }).ids)
  const collects = () => posted.filter((m) => m.method === 'cinna/collect-context')
  return { iframe, posted, init, notify, request, answer, highlights, collects }
}

describe('the agent’s highlight on a web tile', () => {
  it('on highlight-ready: tells main, and replays what is held; pushes follow; a reloaded page gets it again once ready', async () => {
    held = Promise.resolve(['o-1'])
    show(tileView({ view: 'html' }))
    const page = await framePage()
    await act(async () => {})
    expect(page.highlights()).toEqual([])
    page.notify('cinna/highlight-ready')
    expect(highlightReady).toHaveBeenCalledWith('t1')
    expect(page.highlights()).toEqual([['o-1']])
    act(() => push({ tileId: 't1', ids: ['o-2'] }))
    expect(page.highlights().at(-1)).toEqual(['o-2'])
    // A reload: nothing goes before the new document says it draws highlights.
    page.init(2)
    // …and main forgets the old document could draw them.
    expect(highlightReady).toHaveBeenLastCalledWith('t1', false)
    act(() => push({ tileId: 't1', ids: ['o-3'] }))
    expect(page.highlights().at(-1)).toEqual(['o-2'])
    page.notify('cinna/highlight-ready')
    expect(highlightReady).toHaveBeenCalledTimes(3)
    expect(highlightReady).toHaveBeenLastCalledWith('t1')
    expect(page.highlights().at(-1)).toEqual(['o-3'])
  })

  it('the owner’s new selection reported by the page ends it; a context with no selection does not', async () => {
    held = Promise.resolve(['o-1'])
    const chat = chatStub()
    show(tileView({ view: 'html' }), chat)
    const page = await framePage()
    page.notify('cinna/highlight-ready')
    page.request(5, 'ui/update-model-context', { structuredContent: { summary: 'Pipeline', selection: [] } })
    expect(clearHighlight).not.toHaveBeenCalled()
    page.request(6, 'ui/update-model-context', { structuredContent: { summary: 'Pipeline', selection: ['o-4'] } })
    expect(clearHighlight).toHaveBeenCalledWith('t1')
    expect(chat.onContext).toHaveBeenLastCalledWith({ summary: 'Pipeline', selection: ['o-4'] })
    expect(page.highlights().at(-1)).toEqual([])
  })
})

describe('collect-context on a focused web tile', () => {
  it('asks on each collect request (the composer gained focus), and hands the answer on', async () => {
    const chat = chatStub({ focused: true })
    const { rerenderChat } = show(tileView({ view: 'html' }), chat)
    const page = await framePage()
    expect(page.collects()).toHaveLength(0)
    rerenderChat({ ...chat, collectRequest: 1 })
    expect(page.collects()).toHaveLength(1)
    // One at a time: a second request waits for the first answer.
    rerenderChat({ ...chat, collectRequest: 2 })
    expect(page.collects()).toHaveLength(1)
    page.answer(page.collects()[0].id, { source: 'collected', summary: 'Pipeline', selection: [], visible: [], microdata: [], selected_text: 'Acme' })
    await waitFor(() => expect(chat.onCollected).toHaveBeenCalledWith({ source: 'collected', summary: 'Pipeline', selection: [], visible: [], microdata: [], selected_text: 'Acme' }))
    expect(page.collects()).toHaveLength(2)
  })

  it('focus leaving the frame asks nothing by itself: the parent never hears it', async () => {
    show(tileView({ view: 'html' }), chatStub({ focused: true }))
    const page = await framePage()
    fireEvent.blur(page.iframe)
    expect(page.collects()).toHaveLength(0)
  })

  it('asks once data has reached the page and it has had time to draw it', async () => {
    const chat = chatStub({ focused: true })
    show(tileView({ view: 'html' }), chat)
    const page = await framePage()
    // The cached result went on initialized; the answer comes after the page has drawn it.
    expect(page.collects()).toHaveLength(0)
    await waitFor(() => expect(page.collects()).toHaveLength(1), { timeout: 1000 })
  })

  it('an unfocused tile is never asked', async () => {
    const chat = chatStub({ focused: false })
    const { rerenderChat } = show(tileView({ view: 'html' }), chat)
    const page = await framePage()
    rerenderChat({ ...chat, collectRequest: 1 })
    await new Promise((resolve) => setTimeout(resolve, 400))
    expect(page.collects()).toHaveLength(0)
  })
})
