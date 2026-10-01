import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { createElement, type ReactNode } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type {
  SessionTelemetry,
  SessionTelemetryChangedPayload,
  SessionTelemetryMeasureResult
} from '../../../../shared/sessionTelemetry'

/**
 * The session telemetry block in the mode badge's popover (`RouterBadge` with
 * a `chatId`). Telemetry is read once and then pushed, so the tests drive it
 * the way main does: a `get` answer, then `session-telemetry:changed` payloads
 * into the hook's listener.
 */

const NOW = new Date('2026-09-30T10:00:00Z').getTime()

const push = vi.hoisted(() => ({ listener: null as null | ((p: SessionTelemetryChangedPayload) => void) }))
const spies = vi.hoisted(() => ({ get: vi.fn(), measure: vi.fn() }))

vi.mock('../../hooks/useRelativeNow', () => ({ useRelativeNow: () => new Date(NOW) }))

;(window as unknown as { api: unknown }).api = {
  app: { setTheme: async () => undefined },
  sessionTelemetry: {
    get: (chatId: string) => spies.get(chatId),
    measureContext: (chatId: string) => spies.measure(chatId),
    onChanged: (listener: (p: SessionTelemetryChangedPayload) => void) => {
      push.listener = listener
      return () => {
        if (push.listener === listener) push.listener = null
      }
    }
  }
}

const { RouterBadge } = await import('./RouterBadge')
const { DETAILS_MAX_HEIGHT, popoverMaxHeight } = await import('./SessionTelemetryBlock')
const { useUIStore } = await import('../../stores/ui.store')

function claude(patch: Partial<SessionTelemetry> = {}): SessionTelemetry {
  return {
    chatId: 'chat-1',
    engine: 'claude',
    auth: { kind: 'subscription', label: 'Claude Max', plan: 'max' },
    model: { selected: 'opus', resolved: 'claude-opus-5-5', source: 'init' },
    context: { used: 84_200, size: 200_000, sizeAuthoritative: true, breakdown: { baseline: 20_000, conversation: 64_200 } },
    totals: {
      tokens: { input: 1_200, output: 3_400, cacheRead: 80_000, cacheWrite: 12_000 },
      costUsd: 0.0412345,
      costSource: 'runtime',
      turns: 3,
      tokenScope: 'turn',
      byModel: {},
      bySession: {}
    },
    cache: { lastRequestAt: NOW - 108_000, ttlMs: 300_000, ttlSource: 'observed', expiresAt: NOW + 192_000 },
    updatedAt: NOW,
    ...patch
  }
}

function codex(patch: Partial<SessionTelemetry> = {}): SessionTelemetry {
  const base = claude()
  return {
    ...base,
    engine: 'codex',
    auth: { kind: 'api_key' },
    model: { selected: 'gpt-5.4', source: 'config' },
    context: { used: 84_200, size: 200_000, sizeAuthoritative: true },
    totals: { ...base.totals, costSource: 'estimated' },
    cache: { ttlSource: 'assumed' },
    ...patch
  }
}

async function mount(telemetry: SessionTelemetry | null): Promise<{ client: QueryClient; switchTo: (chatId: string) => void }> {
  spies.get.mockResolvedValue({ ok: true, telemetry })
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  const wrapper = ({ children }: { children: ReactNode }): React.JSX.Element =>
    createElement(QueryClientProvider, { client }, children)
  const view = render(createElement(RouterBadge, { router: 'direct', chatId: 'chat-1' }), { wrapper })
  await waitFor(() => {
    expect(client.getQueryState(['sessionTelemetry', 'chat-1'])?.status).toBe('success')
    expect(push.listener).not.toBeNull()
  })
  return { client, switchTo: (chatId) => view.rerender(createElement(RouterBadge, { router: 'direct', chatId })) }
}

async function send(telemetry: SessionTelemetry): Promise<void> {
  await act(async () => {
    push.listener?.({ chatId: 'chat-1', telemetry })
    await new Promise((resolve) => setTimeout(resolve, 0))
  })
}

const pill = (): HTMLElement => screen.getByRole('status', { name: 'Direct agent connection' })
const dialog = (): HTMLElement | null => screen.queryByRole('dialog', { name: 'Chat routing' })
const toggle = (): HTMLElement | null => (dialog() ? within(dialog()!).queryByRole('button', { name: /^Context / }) : null)
const details = (): HTMLElement | null => (dialog() ? within(dialog()!).queryByLabelText('Session details list') : null)
const section = (name: string): HTMLElement => within(dialog()!).getByRole('region', { name })

function hover(): HTMLElement {
  fireEvent.mouseEnter(pill())
  expect(dialog()).not.toBeNull()
  return dialog()!
}

/** Hovers the pill and expands the details, if they are not already. */
function open(): HTMLElement {
  hover()
  if (toggle()!.getAttribute('aria-expanded') !== 'true') fireEvent.click(toggle()!)
  expect(details()).not.toBeNull()
  return dialog()!
}

function close(): void {
  fireEvent.keyDown(dialog()!, { key: 'Escape' })
  expect(dialog()).toBeNull()
  fireEvent.mouseLeave(pill().parentElement!)
}

/** A row's value, found by its label. */
function row(sectionName: string, label: string): string {
  const labelEl = within(section(sectionName)).getByText(label, { exact: true })
  return labelEl.nextElementSibling?.textContent ?? ''
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] })
  vi.setSystemTime(NOW)
  spies.get.mockReset()
  spies.measure.mockReset().mockResolvedValue({ ok: true })
  push.listener = null
  useUIStore.setState({ verboseMode: false })
})

afterEach(() => {
  vi.useRealTimers()
})

describe('the Context row', () => {
  it('is absent while the chat has no telemetry, and the popover stays a plain routing card', async () => {
    await mount(null)
    fireEvent.mouseEnter(pill())
    expect(dialog()).toBeNull()
    const card = screen.getByRole('tooltip', { name: 'Chat routing' })
    expect(within(card).queryByRole('button')).toBeNull()
    expect(card.className).toContain('w-72')
    expect(card.style.maxHeight).toBe('')
    await send(claude())
    expect(toggle()).not.toBeNull()
    expect(dialog()!.className).toContain('w-80')
  })

  it('is absent without a chat: the badge reads no telemetry', () => {
    render(createElement(RouterBadge, { router: 'direct' }))
    fireEvent.mouseEnter(pill())
    expect(spies.get).not.toHaveBeenCalled()
    expect(screen.getByRole('tooltip')).toBeTruthy()
    expect(screen.queryByRole('button', { name: /^Context/ })).toBeNull()
  })

  it('makes the popover a dialog even for a router whose card is a tooltip', async () => {
    await mount(claude())
    expect(hover().getAttribute('role')).toBe('dialog')
  })

  it('is collapsed by default: used tokens and fill, named in words', async () => {
    await mount(claude())
    hover()
    const row = toggle()!
    expect(row.getAttribute('aria-expanded')).toBe('false')
    expect(row.textContent).toBe('Context84.2K – 42%')
    expect(row.getAttribute('aria-label')).toBe('Context 84.2K, 42% full')
    expect(details()).toBeNull()
    expect(within(dialog()!).queryByRole('region')).toBeNull()

    await send(claude({ context: { used: 100, size: 1_000_000, sizeAuthoritative: true } }))
    expect(toggle()!.textContent).toBe('Context100 – <1%')
    expect(toggle()!.getAttribute('aria-label')).toBe('Context 100, <1% full')
  })

  it('shows the used tokens alone without a window size', async () => {
    await mount(codex({ context: { used: 5_000, size: 0, sizeAuthoritative: false } }))
    hover()
    expect(toggle()!.textContent).toBe('Context5K')
    expect(toggle()!.getAttribute('aria-label')).toBe('Context 5K')
  })

  it('expands and collapses on click, with the details above it and the row last', async () => {
    await mount(claude())
    hover()
    const row = toggle()!
    fireEvent.click(row)
    expect(row.getAttribute('aria-expanded')).toBe('true')
    const list = details()!
    expect(row.getAttribute('aria-controls')).toBe(list.id)
    // Above the row in DOM order, and the row is the popover's last.
    expect(list.compareDocumentPosition(row) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
    expect(row.parentElement!.lastElementChild).toBe(row)
    expect(dialog()!.lastElementChild).toBe(row.parentElement)
    // Below the routing copy.
    const routing = within(dialog()!).getByText('Direct agent connection')
    expect(routing.compareDocumentPosition(list) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
    // The same node stays: nothing under the pointer is replaced.
    expect(toggle()).toBe(row)
    fireEvent.click(row)
    expect(row.getAttribute('aria-expanded')).toBe('false')
    expect(details()).toBeNull()
    expect(dialog()).not.toBeNull()
  })

  it('keeps the popover open while focus is inside it', async () => {
    await mount(claude())
    act(() => pill().focus())
    const row = toggle()!
    act(() => row.focus())
    fireEvent.click(row)
    expect(dialog()).not.toBeNull()
    const measure = within(section('Context')).getByRole('button', { name: 'Measure' })
    act(() => measure.focus())
    fireEvent.click(measure)
    expect(dialog()).not.toBeNull()
  })

  // A focused node that unmounts sends focus to <body> with no blur React
  // sees; the popover then stayed open past mouse-away and click-away.
  it('closes on mouse-away and on a press elsewhere once its focused row unmounts', async () => {
    const { client } = await mount(claude())
    // The popover's role turns from dialog to tooltip without telemetry; the
    // pill's description is there exactly while either is open.
    const isOpen = (): boolean => pill().hasAttribute('aria-describedby')
    const anchor = hover().parentElement!
    act(() => toggle()!.focus())
    // TanStack notifies on a later tick.
    const drop = (): Promise<void> => {
      act(() => client.setQueryData(['sessionTelemetry', 'chat-1'], null))
      return waitFor(() => expect(document.activeElement).toBe(document.body))
    }
    await drop()
    expect(isOpen()).toBe(true)
    fireEvent.mouseLeave(anchor)
    expect(isOpen()).toBe(false)

    act(() => client.setQueryData(['sessionTelemetry', 'chat-1'], claude()))
    fireEvent.mouseEnter(anchor)
    await waitFor(() => expect(toggle()).not.toBeNull())
    act(() => toggle()!.focus())
    fireEvent.mouseLeave(anchor)
    expect(isOpen()).toBe(true)
    await drop()
    expect(isOpen()).toBe(true)
    fireEvent.pointerDown(document.body)
    expect(isOpen()).toBe(false)
  })

  it('stays expanded across a close and reopen, and resets when the chat changes', async () => {
    const { client, switchTo } = await mount(claude())
    open()
    close()
    hover()
    expect(toggle()!.getAttribute('aria-expanded')).toBe('true')
    expect(details()).not.toBeNull()

    client.setQueryData(['sessionTelemetry', 'chat-2'], claude({ chatId: 'chat-2' }))
    spies.get.mockImplementation(async (chatId: string) => ({ ok: true, telemetry: claude({ chatId }) }))
    act(() => switchTo('chat-2'))
    expect(toggle()!.getAttribute('aria-expanded')).toBe('false')
    expect(details()).toBeNull()
    act(() => switchTo('chat-1'))
    expect(toggle()!.getAttribute('aria-expanded')).toBe('false')
  })
})

describe('the expanded details', () => {
  it('for Claude: model, login, context split, measure, cache clock, next message and prices', async () => {
    await mount(claude())
    const popover = open()
    expect(within(popover).getByText('claude-opus-5-5').tagName).toBe('CODE')
    // No native hover titles anywhere in the popover.
    expect(popover.querySelector('[title]')).toBeNull()
    expect(within(popover).getByText('Claude Max')).toBeTruthy()
    expect(within(section('Context')).getByText('84.2K of 200K (42%)')).toBeTruthy()
    expect(within(section('Context')).queryByText(/size not confirmed yet/)).toBeNull()
    expect(row('Context', 'Setup (system prompt, tools, memory, first message)')).toBe('20K')
    expect(row('Context', 'Conversation')).toBe('64.2K')
    expect(within(section('Context')).getByRole('button', { name: 'Measure' })).toBeTruthy()

    expect(row('Spent in this chat', 'Input')).toBe('1.2K')
    expect(row('Spent in this chat', 'Cache read')).toBe('80K')
    expect(row('Spent in this chat', 'Turns')).toBe('3')
    expect(row('Spent in this chat', 'Cache hit')).toBe(`${Math.round((80_000 / 93_200) * 100)}%`)
    expect(row('Spent in this chat', 'Cache write')).toBe('12K')
    expect(row('Spent in this chat', 'Cost')).toBe('$0.0412 API-equivalent')

    expect(row('Cache', 'State')).toBe('Warm cold in 3:12')
    expect(row('Cache', 'TTL')).toBe('5 min observed')

    expect(row('Next message', 'Cache warm')).toBe('$0.0168')
    expect(row('Next message', 'Cache cold')).toBe('$0.421')
    expect(within(section('Next message')).getByText('Warm price until')).toBeTruthy()
    expect(within(section('Next message')).queryByText('Priced at')).toBeNull()
    expect(section('Next message').textContent).not.toMatch(/tool calls/)
    // Said once, on the cost.
    expect(popover.textContent!.match(/API-equivalent/g)).toHaveLength(1)
    // No ` · `-joined prose anywhere: a value, then one muted qualifier.
    expect(popover.textContent).not.toContain(' · ')

    expect(row('Prices', 'Input')).toBe('$4')
    expect(row('Prices', 'Cache write')).toBe('$5 1 h $8')
    expect(within(section('Prices')).getByText('checked 2026-09-29')).toBeTruthy()
  })

  it('for Codex: no measure, no cache section, no cache writes, one upper-bound price', async () => {
    await mount(codex())
    open()
    expect(within(section('Context')).queryByRole('button')).toBeNull()
    expect(within(dialog()!).queryByRole('region', { name: 'Cache' })).toBeNull()
    expect(within(dialog()!).queryByText('Not reported by this agent')).toBeNull()
    expect(within(dialog()!).queryByText('API key')).not.toBeNull()
    expect(row('Next message', 'Uncached')).toBe('$0.211 at most')
    expect(within(section('Next message')).queryByText('Cache warm')).toBeNull()
    expect(within(section('Next message')).queryByText('Priced at')).toBeNull()
    expect(within(section('Spent in this chat')).queryByText('Cache write')).toBeNull()
    expect(within(section('Prices')).queryByText('Cache write')).toBeNull()
    expect(row('Spent in this chat', 'Cost')).toBe('$0.0412 estimated')
  })

  it('qualifies the cost: at least on last-request totals, none reported, unknown price', async () => {
    const base = codex()
    await mount(codex({ totals: { ...base.totals, tokenScope: 'last_request' } }))
    open()
    expect(row('Spent in this chat', 'Cost')).toBe('$0.0412 estimated, at least')
    await send(codex({ model: { selected: 'gpt-9-unknown', source: 'config' }, totals: { ...base.totals, costUsd: undefined } }))
    expect(row('Spent in this chat', 'Cost')).toBe('no cost reported')
    expect(within(section('Next message')).getByText('price unknown for gpt-9-unknown')).toBeTruthy()
    expect(within(dialog()!).queryByRole('region', { name: 'Prices' })).toBeNull()
  })

  it('marks a guessed window size, and lists measured categories largest first', async () => {
    const t = claude()
    await mount(claude({ context: { ...t.context, sizeAuthoritative: false } }))
    open()
    expect(within(section('Context')).getByText(/size not confirmed yet/)).toBeTruthy()
    await send(claude({
      context: {
        ...t.context,
        categories: {
          categories: [
            { name: 'System tools', tokens: 12_000 },
            { name: 'Messages', tokens: 60_000 },
            { name: 'Skills', tokens: 0 },
            { name: 'Deferred MCP tools', tokens: 9_000, isDeferred: true },
            // The pinned CLI lists the window's room beside its content; its `/context` counts neither.
            { name: 'Free space', tokens: 110_000 },
            { name: 'Autocompact buffer', tokens: 45_000 },
            { name: 'compact buffer', tokens: 3_000 }
          ],
          totalTokens: 72_000, maxTokens: 200_000, rawMaxTokens: 200_000, percentage: 36, model: 'claude-opus-5-5',
          memoryFiles: [], mcpTools: [], agents: [], systemTools: [], systemPromptSections: []
        },
        categoriesMeasuredAt: NOW - 3 * 60_000
      }
    }))
    expect(within(section('Context')).getByText('counted by the provider 3 min ago')).toBeTruthy()
    expect(within(section('Context')).queryByText('Free space')).toBeNull()
    expect(within(section('Context')).queryByText('Autocompact buffer')).toBeNull()
    expect(within(section('Context')).queryByText('compact buffer')).toBeNull()
    expect(within(section('Context')).getByText('Free: 110K')).toBeTruthy()
    expect(within(section('Context')).queryByText('Conversation')).toBeNull()
    expect(within(section('Context')).queryByText('Skills')).toBeNull()
    expect(within(section('Context')).queryByText('Deferred MCP tools')).toBeNull()
    const labels = within(section('Context')).getAllByText(/^(Messages|System tools)$/).map((el) => el.textContent)
    expect(labels).toEqual(['Messages', 'System tools'])
    expect(row('Context', 'Messages')).toBe('60K')
  })

  it('counts the cache down every second while shown', async () => {
    // After the mount: `waitFor` polls on the real `setInterval`.
    await mount(claude())
    vi.useRealTimers()
    vi.useFakeTimers({ toFake: ['Date', 'setInterval', 'clearInterval'] })
    vi.setSystemTime(NOW)
    open()
    expect(row('Cache', 'State')).toBe('Warm cold in 3:12')
    act(() => vi.advanceTimersByTime(2_000))
    expect(row('Cache', 'State')).toBe('Warm cold in 3:10')
  })

  it('keeps known prices in fast mode when the table lists no fast rate, and says which is missing', async () => {
    await mount(claude({ model: { selected: 'sonnet', resolved: 'claude-sonnet-5', source: 'init' }, runtime: { fastMode: 'on' } }))
    open()
    expect(row('Prices', 'Input')).toBe('$2')
    expect(within(section('Prices')).getByText('fast-mode rate not listed')).toBeTruthy()
    expect(within(section('Next message')).getByText('price unknown in fast mode')).toBeTruthy()
    expect(within(section('Next message')).queryByText(/claude-sonnet-5/)).toBeNull()
  })

  it('caps the popover at the room above the pill, the list scrolling inside with a stable gutter', async () => {
    expect(popoverMaxHeight(undefined)).toBeUndefined()
    // It grows up from the pill: 8px short of the window's top.
    expect(popoverMaxHeight(300)).toBe('292px')
    expect(popoverMaxHeight(4)).toBeUndefined()
    await mount(claude())
    const top = vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockReturnValue({ top: 500 } as DOMRect)
    try {
      open()
      expect(dialog()!.style.maxHeight).toBe('492px')
      expect(dialog()!.className).toContain('flex-col')
      const list = details()!
      expect(list.style.maxHeight).toBe(DETAILS_MAX_HEIGHT)
      expect(list.className).toContain('[scrollbar-gutter:stable]')
      expect(list.className).toContain('overflow-y-auto')
      expect(list.className).toContain('min-h-0')
    } finally {
      top.mockRestore()
    }
  })

  it('shows the runtime block only in verbose mode', async () => {
    const t = claude({ runtime: { cliVersion: '2.1.9', effort: 'high', fastMode: 'off', betas: ['context-1m'] }, rateLimit: { status: 'allowed' } })
    await mount(t)
    open()
    expect(within(dialog()!).queryByLabelText('Runtime details')).toBeNull()
    close()
    act(() => useUIStore.setState({ verboseMode: true }))
    open()
    const block = within(dialog()!).getByLabelText('Runtime details')
    expect(block.textContent).toContain('cli: 2.1.9')
    expect(block.textContent).toContain('effort: high')
    expect(block.textContent).toContain('betas: context-1m')
    expect(block.textContent).toContain('"status": "allowed"')
  })
})

describe('measuring the context', () => {
  function deferred(): { promise: Promise<SessionTelemetryMeasureResult>; resolve: (r: SessionTelemetryMeasureResult) => void } {
    let resolve!: (r: SessionTelemetryMeasureResult) => void
    const promise = new Promise<SessionTelemetryMeasureResult>((r) => { resolve = r })
    return { promise, resolve }
  }

  it.each([
    ['busy', 'The agent is working — measure when the turn ends.'],
    ['not_ready', "Available after the agent's first reply in this session."],
    ['not_running', "The agent's process isn't running — send a message first."],
    ['failed', "The agent didn't answer the measurement."],
    ['chat_not_found', "The context couldn't be measured."]
  ] as const)('reads Measuring… inline, then explains a %s refusal below the action', async (code, line) => {
    await mount(claude())
    open()
    const pending = deferred()
    spies.measure.mockReturnValueOnce(pending.promise)
    fireEvent.click(within(section('Context')).getByRole('button', { name: 'Measure' }))
    expect(spies.measure).toHaveBeenCalledWith('chat-1')
    const button = within(section('Context')).getByRole('button', { name: 'Measuring…' })
    expect(button.getAttribute('aria-disabled')).toBe('true')
    fireEvent.click(button)
    expect(spies.measure).toHaveBeenCalledTimes(1)

    await act(async () => { pending.resolve({ ok: false, code }) })
    const status = within(section('Context')).getByRole('status')
    expect(status.textContent).toBe(line)
    // Last in the section, below the action.
    expect(section('Context').lastElementChild).toBe(status)
  })

  it('clears the refusal on the next attempt and when the popover closes', async () => {
    await mount(claude())
    open()
    spies.measure.mockResolvedValueOnce({ ok: false, code: 'busy' })
    fireEvent.click(within(section('Context')).getByRole('button', { name: 'Measure' }))
    await waitFor(() => expect(within(section('Context')).queryByRole('status')).not.toBeNull())

    const pending = deferred()
    spies.measure.mockReturnValueOnce(pending.promise)
    fireEvent.click(within(section('Context')).getByRole('button', { name: 'Measure' }))
    expect(within(section('Context')).queryByRole('status')).toBeNull()
    await act(async () => { pending.resolve({ ok: false, code: 'busy' }) })
    expect(within(section('Context')).queryByRole('status')).not.toBeNull()

    close()
    open()
    expect(within(section('Context')).queryByRole('status')).toBeNull()
    expect(within(section('Context')).getByRole('button', { name: 'Measure' })).toBeTruthy()
  })

  it('never carries a refusal into another chat while the popover stays open', async () => {
    const { client, switchTo } = await mount(claude())
    // Chat 2 was visited before: its telemetry is cached, so the popover stays open across the switch.
    const other = claude({ chatId: 'chat-2' })
    client.setQueryData(['sessionTelemetry', 'chat-2'], other)
    spies.get.mockImplementation(async (chatId: string) => ({ ok: true, telemetry: chatId === 'chat-2' ? other : claude() }))
    open()
    spies.measure.mockResolvedValueOnce({ ok: false, code: 'busy' })
    fireEvent.click(within(section('Context')).getByRole('button', { name: 'Measure' }))
    await waitFor(() => expect(within(section('Context')).queryByRole('status')).not.toBeNull())

    act(() => switchTo('chat-2'))
    expect(dialog()).not.toBeNull()
    open()
    expect(within(section('Context')).getByRole('button', { name: 'Measure' })).toBeTruthy()
    expect(within(section('Context')).queryByRole('status')).toBeNull()
  })

  it('takes an unsupported answer as final for the session: its own line, and no Measure', async () => {
    await mount(claude({ context: { ...claude().context, sessionId: 's-1' } }))
    open()
    spies.measure.mockResolvedValueOnce({ ok: false, code: 'unsupported' })
    fireEvent.click(within(section('Context')).getByRole('button', { name: 'Measure' }))
    await waitFor(() => expect(within(section('Context')).queryByRole('button', { name: 'Measure' })).toBeNull())
    const line = within(section('Context')).getByRole('status')
    expect(line.textContent).toBe("This agent can't report a breakdown.")
    expect(line.className).not.toContain('danger')

    close()
    open()
    expect(within(section('Context')).queryByRole('button', { name: 'Measure' })).toBeNull()
    expect(within(section('Context')).getByRole('status').textContent).toBe("This agent can't report a breakdown.")

    // A new agent session may answer differently.
    await send(claude({ context: { ...claude().context, sessionId: 's-2' } }))
    expect(within(section('Context')).getByRole('button', { name: 'Measure' })).toBeTruthy()
    expect(within(section('Context')).queryByRole('status')).toBeNull()
  })
})
