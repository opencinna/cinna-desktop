import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ComponentInfo, ComponentParamSpec, TileResultDto, TileScheduleState, TileView } from '../../../../shared/dashboards'

vi.mock('../../stores/logger.store', () => ({
  createLogger: () => ({ debug: () => {}, info: () => {}, warn: () => {}, error: () => {} })
}))

import { Tile, type TileChat } from './Tile'
import { FILTER_TEXT_DEBOUNCE_MS } from './TileFilters'
import { useUIStore } from '../../stores/ui.store'

/** D4 on a tile: the native filter row, schedule-fed tiles, and a page's bridge requests. */

const RULE = { maxAge: '15m', whileOpenEvery: null, afterTurn: false, onAppStart: false, command: null, schedule: null }

function component(over: Partial<ComponentInfo> = {}): ComponentInfo {
  return {
    agentId: 'folder:sales', manifestId: 'sales', agentName: 'Sales Agent', name: 'deals', skill: null, title: 'Deals',
    description: '', view: 'list', size: 'wide', source: { endpoint: 'e' }, maxAge: '15m', refreshCommand: null,
    refresh: RULE, params: {}, prompts: [], valid: true, findings: [], missingCredentials: [],
    ...over
  }
}

function tileView(over: Partial<ComponentInfo> = {}, params: Record<string, unknown> = {}, schedule: TileScheduleState | null = null): TileView {
  return {
    tile: { id: 't1', dashboardId: 'd1', agentManifestId: 'sales', component: 'deals', skill: null, title: 'Deals', size: 'wide', position: 0, params, refreshOverride: null },
    displayTitle: 'Deals',
    state: 'ok',
    component: component(over),
    schedule
  }
}

let result: TileResultDto
const setParams = vi.fn()
const call = vi.fn()
const openExternal = vi.fn()

function show(view: TileView, chat?: TileChat) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return render(
    <QueryClientProvider client={client}>
      <Tile view={view} dashboardName="Sales" span={{ cols: 12, rows: 2 }} editMode={false} dragging={false} onHandlePointerDown={() => {}} onVisibilityChange={() => {}} chat={chat} />
    </QueryClientProvider>
  )
}

beforeEach(() => {
  result = { tileId: 't1', data: { items: [{ title: 'Call Bob' }] }, fetchedAt: Date.now(), error: null, refreshing: false, stale: false, tooLarge: false, notice: null }
  setParams.mockReset().mockResolvedValue({ ok: true, tile: {} })
  call.mockReset().mockResolvedValue({ ok: true, value: { rows: [1] } })
  openExternal.mockReset().mockResolvedValue({ success: true })
  window.api = {
    dashboards: {
      tileResult: async () => ({ ok: true, result }),
      onTileChanged: () => () => {},
      highlight: async () => [],
      onTileHighlight: () => () => {},
      clearHighlight: async () => true,
      highlightReady: async () => true,
      ensureFresh: async () => ({ ok: true }),
      setParams,
      call,
      openFrame: async () => ({ ok: true, token: 'tok', url: 'cinna-preview://dash-h/t1/index.html' }),
      releaseFrame: async () => {}
    },
    system: { openExternal }
  } as never
})

afterEach(() => {
  vi.useRealTimers()
})

const PARAMS: Record<string, ComponentParamSpec> = {
  stage: { type: 'enum', label: 'Stage', values: ['open', 'won', 'lost'], default: 'open' },
  month: { type: 'month', label: 'Month', default: '2026-09' },
  day: { type: 'date', label: 'Day' },
  span: { type: 'date_range', label: 'Span' },
  owner: { type: 'text', label: 'Owner' },
  min: { type: 'number', label: 'Min amount' },
  mine: { type: 'boolean', label: 'Only mine', default: false }
}

describe('a list item’s link', () => {
  it('opens mailto: like http(s), as the schema allows; anything else stays text', async () => {
    result = { ...result, data: { items: [{ title: 'Mail Ann', url: 'mailto:ann@example.com' }, { title: 'Run it', url: 'javascript:alert(1)' }] } }
    show(tileView())
    fireEvent.click(await screen.findByRole('button', { name: 'Mail Ann' }))
    expect(openExternal).toHaveBeenCalledWith('mailto:ann@example.com')
    expect(screen.queryByRole('button', { name: 'Run it' })).toBeNull()
    expect(screen.getByText('Run it')).toBeTruthy()
  })
})

describe('the native filter row', () => {
  it('draws one control per param, valued from the tile, else the defaults, in a row of fixed height that is always there', async () => {
    show(tileView({ params: PARAMS }, { stage: 'won', owner: 'Ann' }))
    await screen.findByText('Call Bob')
    const row = screen.getByTestId('tile-filters')
    // Not a hover control: fixed height, no opacity toggle; the content starts below it.
    expect(row.className).toContain('h-8')
    expect(row.className).not.toMatch(/opacity|group-hover/)
    expect(screen.getByTestId('tile-content').className).toContain('top-[68px]')
    expect((within(row).getByLabelText('Stage') as HTMLSelectElement).value).toBe('won')
    expect((within(row).getByLabelText('Month') as HTMLInputElement).type).toBe('month')
    expect((within(row).getByLabelText('Month') as HTMLInputElement).value).toBe('2026-09')
    expect((within(row).getByLabelText('Day') as HTMLInputElement).type).toBe('date')
    expect(within(row).getByLabelText('From')).toBeTruthy()
    expect(within(row).getByLabelText('To')).toBeTruthy()
    expect((within(row).getByLabelText('Owner') as HTMLInputElement).value).toBe('Ann')
    expect((within(row).getByLabelText('Min amount') as HTMLInputElement).type).toBe('number')
    expect((within(row).getByLabelText('Only mine') as HTMLInputElement).checked).toBe(false)
  })

  it('a pick sends the tile’s params with that value replaced, the picks before it kept', async () => {
    show(tileView({ params: PARAMS }, { owner: 'Ann' }))
    await screen.findByText('Call Bob')
    fireEvent.change(screen.getByLabelText('Stage'), { target: { value: 'lost' } })
    expect(setParams).toHaveBeenLastCalledWith({ tileId: 't1', params: { owner: 'Ann', stage: 'lost' } })
    fireEvent.change(screen.getByLabelText('Month'), { target: { value: '2026-10' } })
    expect(setParams).toHaveBeenLastCalledWith({ tileId: 't1', params: { owner: 'Ann', stage: 'lost', month: '2026-10' } })
    fireEvent.change(screen.getByLabelText('Day'), { target: { value: '2026-10-02' } })
    expect(setParams).toHaveBeenLastCalledWith({ tileId: 't1', params: { owner: 'Ann', stage: 'lost', month: '2026-10', day: '2026-10-02' } })
    fireEvent.change(screen.getByLabelText('From'), { target: { value: '2026-10-01' } })
    expect(setParams).toHaveBeenLastCalledWith({
      tileId: 't1', params: { owner: 'Ann', stage: 'lost', month: '2026-10', day: '2026-10-02', span: { from: '2026-10-01', to: '' } }
    })
    fireEvent.click(screen.getByLabelText('Only mine'))
    expect(setParams).toHaveBeenLastCalledWith({
      tileId: 't1', params: { owner: 'Ann', stage: 'lost', month: '2026-10', day: '2026-10-02', span: { from: '2026-10-01', to: '' }, mine: true }
    })
  })

  it('filter B after filter A carries A, once A is stored and while the tile’s params still lag', async () => {
    // Main answers with the tile it stored; the tile's own params only change when the tiles query refetches.
    setParams.mockImplementation(async (input: { params: Record<string, unknown> }) => ({ ok: true, tile: { params: input.params } }))
    show(tileView({ params: PARAMS }, { owner: 'Ann' }))
    await screen.findByText('Call Bob')
    fireEvent.change(screen.getByLabelText('Stage'), { target: { value: 'won' } })
    await waitFor(() => expect(setParams).toHaveBeenCalledTimes(1))
    await act(async () => {})
    fireEvent.change(screen.getByLabelText('Month'), { target: { value: '2026-10' } })
    expect(setParams).toHaveBeenLastCalledWith({ tileId: 't1', params: { owner: 'Ann', stage: 'won', month: '2026-10' } })
    // The controls show what was stored, not the stale tile.
    expect((screen.getByLabelText('Stage') as HTMLSelectElement).value).toBe('won')
  })

  it('clearing a date, a month or both ends of a range removes the value instead of sending ""', async () => {
    show(tileView({ params: PARAMS }, { month: '2026-10', day: '2026-10-02', span: { from: '2026-10-01', to: '' } }))
    await screen.findByText('Call Bob')
    fireEvent.change(screen.getByLabelText('Month'), { target: { value: '' } })
    expect(setParams).toHaveBeenLastCalledWith({ tileId: 't1', params: { day: '2026-10-02', span: { from: '2026-10-01', to: '' } } })
    fireEvent.change(screen.getByLabelText('Day'), { target: { value: '' } })
    expect(setParams).toHaveBeenLastCalledWith({ tileId: 't1', params: { span: { from: '2026-10-01', to: '' } } })
    fireEvent.change(screen.getByLabelText('From'), { target: { value: '' } })
    expect(setParams).toHaveBeenLastCalledWith({ tileId: 't1', params: {} })
  })

  it('text and numbers wait until the typing stops (or Enter), then send once', async () => {
    show(tileView({ params: PARAMS }))
    await screen.findByText('Call Bob')
    vi.useFakeTimers()
    const owner = screen.getByLabelText('Owner')
    fireEvent.focus(owner)
    fireEvent.change(owner, { target: { value: 'B' } })
    fireEvent.change(owner, { target: { value: 'Bo' } })
    fireEvent.change(owner, { target: { value: 'Bob' } })
    expect(setParams).not.toHaveBeenCalled()
    act(() => { vi.advanceTimersByTime(FILTER_TEXT_DEBOUNCE_MS) })
    expect(setParams).toHaveBeenCalledOnce()
    expect(setParams).toHaveBeenLastCalledWith({ tileId: 't1', params: { owner: 'Bob' } })
    const min = screen.getByLabelText('Min amount')
    fireEvent.change(min, { target: { value: '250' } })
    fireEvent.keyDown(min, { key: 'Enter' })
    expect(setParams).toHaveBeenLastCalledWith({ tileId: 't1', params: { owner: 'Bob', min: 250 } })
  })

  it('a refused value says so under the filter row, and the controls go back to the values main stored', async () => {
    show(tileView({ params: PARAMS }, { stage: 'won' }))
    await screen.findByText('Call Bob')
    setParams.mockImplementationOnce(async (input: { params: Record<string, unknown> }) => ({ ok: true, tile: { params: input.params } }))
    fireEvent.change(screen.getByLabelText('Stage'), { target: { value: 'open' } })
    await act(async () => {})
    setParams.mockResolvedValueOnce({ ok: false, code: 'invalid_input', message: 'month must be YYYY-MM.' })
    fireEvent.change(screen.getByLabelText('Month'), { target: { value: '2026-11' } })
    const notice = await screen.findByTestId('tile-filter-notice')
    expect(notice.getAttribute('role')).toBe('alert')
    expect(notice.textContent).toBe('Value refused: month must be YYYY-MM.')
    // Not the far-away corner mark.
    expect(screen.queryByLabelText(/Last refresh failed/)).toBeNull()
    // Back to what main stored (stage open, the default month), not to the tile's stale stage won.
    await waitFor(() => expect((screen.getByLabelText('Month') as HTMLInputElement).value).toBe('2026-09'))
    expect((screen.getByLabelText('Stage') as HTMLSelectElement).value).toBe('open')
    // The next change merges over the stored values, without the refused one.
    fireEvent.click(screen.getByLabelText('Only mine'))
    expect(setParams).toHaveBeenLastCalledWith({ tileId: 't1', params: { stage: 'open', mine: true } })
    await waitFor(() => expect(screen.queryByTestId('tile-filter-notice')).toBeNull())
  })

  it('a change main turned down for its rate says so in the same place, and Dismiss clears it', async () => {
    setParams.mockResolvedValue({ ok: false, code: 'rate_limited', message: 'Too many changes; try again in a moment.' })
    show(tileView({ params: PARAMS }, { stage: 'won' }))
    await screen.findByText('Call Bob')
    fireEvent.change(screen.getByLabelText('Stage'), { target: { value: 'lost' } })
    expect((await screen.findByTestId('tile-filter-notice')).textContent).toBe('Not applied: Too many changes; try again in a moment.')
    await waitFor(() => expect((screen.getByLabelText('Stage') as HTMLSelectElement).value).toBe('won'))
    fireEvent.click(screen.getByRole('button', { name: 'Dismiss' }))
    expect(screen.queryByTestId('tile-filter-notice')).toBeNull()
  })

  it('filters that do not fit the tile’s width are behind Filters ⋯, decided by width and never by value', async () => {
    // Every label + control 100px wide, the button 60px, the row 400px (+16 padding), 12px gaps: three fit beside the button.
    const rect = vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function (this: HTMLElement) {
      const width = this.dataset.testid === 'tile-filters' ? 416 : this.parentElement?.getAttribute('aria-hidden') === 'true' ? (this.tagName === 'SPAN' && this.textContent === 'Filters' ? 60 : 100) : 0
      return { width, height: 0, top: 0, left: 0, right: width, bottom: 0, x: 0, y: 0, toJSON: () => ({}) } as DOMRect
    })
    try {
      show(tileView({ params: PARAMS }, { owner: 'Ann' }))
      await screen.findByText('Call Bob')
      const row = screen.getByTestId('tile-filters')
      expect(within(row).getByLabelText('Stage')).toBeTruthy()
      expect(within(row).getByLabelText('Month')).toBeTruthy()
      expect(within(row).getByLabelText('Day')).toBeTruthy()
      expect(within(row).queryByLabelText('From')).toBeNull()
      expect(within(row).queryByLabelText('Owner')).toBeNull()
      const more = within(row).getByRole('button', { name: 'Filters' })
      expect(more.getAttribute('title')).toBe('4 more filters')
      fireEvent.click(more)
      const popover = await screen.findByRole('dialog', { name: 'More filters' })
      expect((within(popover).getByLabelText('Owner') as HTMLInputElement).value).toBe('Ann')
      fireEvent.click(within(popover).getByLabelText('Only mine'))
      expect(setParams).toHaveBeenLastCalledWith({ tileId: 't1', params: { owner: 'Ann', mine: true } })
      // A pick moved nothing between the row and the popover.
      fireEvent.change(within(row).getByLabelText('Stage'), { target: { value: 'lost' } })
      expect(within(row).queryByLabelText('Owner')).toBeNull()
      expect(within(screen.getByRole('dialog', { name: 'More filters' })).getByLabelText('Owner')).toBeTruthy()
      fireEvent.keyDown(screen.getByRole('dialog', { name: 'More filters' }), { key: 'Escape' })
      expect(screen.queryByRole('dialog', { name: 'More filters' })).toBeNull()
    } finally {
      rect.mockRestore()
    }
  })

  it('a web view and a component without params get no filter row', async () => {
    const { unmount } = show(tileView({ params: {} }))
    await screen.findByText('Call Bob')
    expect(screen.queryByTestId('tile-filters')).toBeNull()
    expect(screen.getByTestId('tile-content').className).toContain('top-[34px]')
    unmount()
    show(tileView({ view: 'html', params: PARAMS }))
    await screen.findByTestId('dashboard-frame')
    expect(screen.queryByTestId('tile-filters')).toBeNull()
  })
})

describe('a schedule-fed tile', () => {
  const NEXT = new Date(2026, 10, 3, 14, 0).getTime()

  it('names the schedule and its next run on the hover line and in Refresh’s tooltip', async () => {
    show(tileView({}, {}, { name: 'Nightly ranking', exists: true, onThisDevice: true, nextRunAt: NEXT }))
    await screen.findByText('Call Bob')
    const line = screen.getByTestId('tile-schedule-line')
    expect(line.textContent).toContain('Fed by Nightly ranking · next run ')
    expect(screen.getByRole('button', { name: 'Refresh Deals' }).getAttribute('title')).toMatch(/^Re-read what Nightly ranking wrote \(next run .+\)$/)
    expect(screen.queryByTestId('tile-schedule-notice')).toBeNull()
  })

  it('off on this device: says so above the cached data, and Turn on… opens the agent’s Schedules tab', async () => {
    show(tileView({}, {}, { name: 'Nightly ranking', exists: true, onThisDevice: false, nextRunAt: null }))
    await screen.findByText('Call Bob')
    const notice = screen.getByTestId('tile-schedule-notice')
    expect(notice.textContent).toBe('Fed by Nightly ranking, which is off on this device. Turn on…')
    expect(screen.queryByTestId('tile-schedule-line')).toBeNull()
    fireEvent.click(within(notice).getByRole('button', { name: 'Turn on…' }))
    const ui = useUIStore.getState()
    expect(ui.activeLocalAgentId).toBe('folder:sales')
    expect(ui.agentPageTabRequest).toBe('schedules')
    expect(ui.activeView).toBe('local-agent')
  })

  it('off on this device with no data: the sentence instead of the empty state', async () => {
    result = { ...result, data: null, fetchedAt: null }
    show(tileView({}, {}, { name: 'Nightly ranking', exists: true, onThisDevice: false, nextRunAt: null }))
    expect(await screen.findByTestId('tile-schedule-notice')).toBeTruthy()
    expect(screen.queryByLabelText('Loading')).toBeNull()
  })

  it('a schedule the agent no longer has is said, with nothing to turn on', async () => {
    show(tileView({}, {}, { name: 'Nightly ranking', exists: false, onThisDevice: false, nextRunAt: null }))
    const notice = await screen.findByTestId('tile-schedule-notice')
    expect(notice.textContent).toBe('Fed by Nightly ranking, which this agent no longer has.')
    expect(within(notice).queryByRole('button')).toBeNull()
  })
})

/**
 * A page in the tile's frame, talking to the real WebView: messages arrive
 * as window `message` events from the frame's window, answers are what the
 * host posts to it.
 */
async function framePage() {
  const iframe = (await screen.findByTestId('dashboard-frame')) as HTMLIFrameElement
  const win = iframe.contentWindow!
  const posted: Array<Record<string, unknown>> = []
  vi.spyOn(win, 'postMessage').mockImplementation(((message: unknown) => { posted.push(message as Record<string, unknown>) }) as never)
  const send = (data: Record<string, unknown>) =>
    act(() => { window.dispatchEvent(new MessageEvent('message', { data, origin: 'null', source: win })) })
  send({ jsonrpc: '2.0', id: 1, method: 'ui/initialize', params: {} })
  const nonce = (posted[0].result as { _meta: { cinna: { nonce: string } } })._meta.cinna.nonce
  const meta = { _meta: { cinna: { nonce } } }
  send({ jsonrpc: '2.0', method: 'ui/notifications/initialized', params: meta })
  const request = (id: number, method: string, params: Record<string, unknown>) => send({ jsonrpc: '2.0', id, method, params: { ...params, ...meta } })
  const notify = (method: string, params: Record<string, unknown>) => send({ jsonrpc: '2.0', method, params: { ...params, ...meta } })
  const answer = (id: number) => posted.find((m) => m.id === id && m.method === undefined)
  return { request, notify, answer }
}

function chatStub(): TileChat {
  return {
    focused: false, selected: [], onFocus: vi.fn(), onPick: vi.fn(), onClearSelection: vi.fn(), onContext: vi.fn(), onCollected: vi.fn(),
    onAsk: vi.fn(), onPrompt: vi.fn(), onFill: vi.fn()
  }
}

describe('a page’s bridge requests on a tile', () => {
  it('tools/call runs the endpoint for this tile and answers a tool result', async () => {
    show(tileView({ view: 'html' }))
    const page = await framePage()
    page.request(5, 'tools/call', { name: 'week_detail', arguments: { week: 'W1' } })
    expect(call).toHaveBeenCalledWith({ target: { tileId: 't1' }, endpoint: 'week_detail', params: { week: 'W1' } })
    await waitFor(() => expect(page.answer(5)).toEqual({
      jsonrpc: '2.0', id: 5, result: { structuredContent: { rows: [1] }, content: [{ type: 'text', text: '{"rows":[1]}' }] }
    }))
    call.mockResolvedValue({ ok: false, code: 'limit_reached', message: 'Too many calls.' })
    page.request(6, 'tools/call', { name: 'week_detail' })
    await waitFor(() => expect(page.answer(6)).toEqual({ jsonrpc: '2.0', id: 6, result: { isError: true, content: [{ type: 'text', text: 'Too many calls.' }] } }))
  })

  it('cinna/params-changed stores the params on the tile, the latest of a burst', async () => {
    show(tileView({ view: 'html' }))
    const page = await framePage()
    vi.useFakeTimers()
    page.notify('cinna/params-changed', { params: { month: '2026-01' } })
    page.notify('cinna/params-changed', { params: { month: '2026-02' } })
    page.notify('cinna/params-changed', { params: { month: '2026-03' } })
    expect(setParams).toHaveBeenCalledTimes(1)
    expect(setParams).toHaveBeenLastCalledWith({ tileId: 't1', params: { month: '2026-01' } })
    act(() => { vi.advanceTimersByTime(1000) })
    expect(setParams).toHaveBeenCalledTimes(2)
    expect(setParams).toHaveBeenLastCalledWith({ tileId: 't1', params: { month: '2026-03' } })
  })

  it('cinna/params-changed in one window merges the partials: month, then owner, keeps both', async () => {
    show(tileView({ view: 'html' }, { stage: 'won' }))
    const page = await framePage()
    vi.useFakeTimers()
    page.notify('cinna/params-changed', { params: { stage: 'lost' } })
    page.notify('cinna/params-changed', { params: { month: '2026-02' } })
    page.notify('cinna/params-changed', { params: { owner: 'Ann' } })
    page.notify('cinna/params-changed', { params: { month: '2026-03' } })
    expect(setParams).toHaveBeenLastCalledWith({ tileId: 't1', params: { stage: 'lost' } })
    act(() => { vi.advanceTimersByTime(1000) })
    expect(setParams).toHaveBeenCalledTimes(2)
    expect(setParams).toHaveBeenLastCalledWith({ tileId: 't1', params: { stage: 'lost', month: '2026-03', owner: 'Ann' } })
  })

  it('ui/message hands the text to the panel’s composer (never sent); a tile with no panel refuses it', async () => {
    const chat = chatStub()
    const { unmount } = show(tileView({ view: 'html' }), chat)
    let page = await framePage()
    page.request(7, 'ui/message', { role: 'user', content: [{ type: 'text', text: 'Why did W3 drop?' }] })
    expect(chat.onFill).toHaveBeenCalledWith('Why did W3 drop?')
    expect(chat.onPrompt).not.toHaveBeenCalled()
    expect(page.answer(7)).toEqual({ jsonrpc: '2.0', id: 7, result: {} })
    unmount()
    show(tileView({ view: 'html' }))
    page = await framePage()
    page.request(8, 'ui/message', { role: 'user', content: [{ type: 'text', text: 'hi' }] })
    expect(page.answer(8)).toMatchObject({ error: { message: 'There is no chat to ask here.' } })
  })

  it('ui/open-link asks first with the full URL; Open opens it and answers, Cancel answers not opened', async () => {
    show(tileView({ view: 'html' }))
    const page = await framePage()
    page.request(9, 'ui/open-link', { url: 'https://crm.example.com/deals/17?ref=w3' })
    const dialog = await screen.findByRole('dialog', { name: 'Open crm.example.com in your browser?' })
    expect(within(dialog).getByTestId('open-link-url').textContent).toBe('https://crm.example.com/deals/17?ref=w3')
    expect(openExternal).not.toHaveBeenCalled()
    expect(page.answer(9)).toBeUndefined()
    fireEvent.click(within(dialog).getByRole('button', { name: 'Open' }))
    await waitFor(() => expect(page.answer(9)).toEqual({ jsonrpc: '2.0', id: 9, result: {} }))
    expect(openExternal).toHaveBeenCalledWith('https://crm.example.com/deals/17?ref=w3')
    expect(screen.queryByRole('dialog')).toBeNull()

    page.request(10, 'ui/open-link', { url: 'https://crm.example.com/x' })
    fireEvent.click(within(await screen.findByRole('dialog')).getByRole('button', { name: 'Cancel' }))
    await waitFor(() => expect(page.answer(10)).toMatchObject({ error: { message: 'The link was not opened.' } }))
    expect(openExternal).toHaveBeenCalledTimes(1)
  })

  it('a mailto: link asks to write to the address', async () => {
    show(tileView({ view: 'html' }))
    const page = await framePage()
    page.request(13, 'ui/open-link', { url: 'mailto:ann@example.com?subject=W3' })
    const dialog = await screen.findByRole('dialog', { name: 'Write to ann@example.com?' })
    expect(within(dialog).getByTestId('open-link-url').textContent).toBe('mailto:ann@example.com?subject=W3')
  })

  it('after Cancel, the page’s next links are refused without a dialog', async () => {
    show(tileView({ view: 'html' }))
    const page = await framePage()
    page.request(14, 'ui/open-link', { url: 'https://crm.example.com/' })
    fireEvent.click(within(await screen.findByRole('dialog')).getByRole('button', { name: 'Cancel' }))
    await waitFor(() => expect(page.answer(14)).toMatchObject({ error: { message: 'The link was not opened.' } }))
    page.request(15, 'ui/open-link', { url: 'https://crm.example.com/again' })
    expect(page.answer(15)).toMatchObject({ error: { message: 'The owner declined a link from this page.' } })
    expect(screen.queryByRole('dialog')).toBeNull()
  })

  it('ui/open-link refuses anything but http(s) and mailto without asking', async () => {
    show(tileView({ view: 'html' }))
    const page = await framePage()
    page.request(11, 'ui/open-link', { url: 'file:///etc/passwd' })
    expect(page.answer(11)).toMatchObject({ error: { message: 'Only web (http, https) and mailto links open from a dashboard.' } })
    expect(screen.queryByRole('dialog')).toBeNull()
  })

  it('a link the browser could not open says so in the confirm, which stays open', async () => {
    openExternal.mockResolvedValue({ success: false, error: 'open_failed' })
    show(tileView({ view: 'html' }))
    const page = await framePage()
    page.request(12, 'ui/open-link', { url: 'https://crm.example.com/' })
    const dialog = await screen.findByRole('dialog')
    fireEvent.click(within(dialog).getByRole('button', { name: 'Open' }))
    expect((await within(dialog).findByRole('alert')).textContent).toBe('The browser could not open it.')
    expect(screen.getByRole('dialog')).toBeTruthy()
    expect(page.answer(12)).toBeUndefined()
  })
})
