import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { createElement, type ReactNode } from 'react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { SessionTelemetry, SessionTelemetryChangedPayload } from '../../../../shared/sessionTelemetry'
import type { AiSpendingLevel } from '../../../../shared/aiSpendingLevel'

/**
 * The context health line along the bottom of the chat's badge, and the toast
 * when a chat crosses the spending level's budget. Telemetry is read once and
 * then pushed, as in `SessionTelemetryBlock.test.tsx`.
 */

const push = vi.hoisted(() => ({ listener: null as null | ((p: SessionTelemetryChangedPayload) => void) }))
const spies = vi.hoisted(() => ({ get: vi.fn(), settings: vi.fn() }))

;(window as unknown as { api: unknown }).api = {
  app: { setTheme: async () => undefined },
  settings: { getAll: () => spies.settings() },
  sessionTelemetry: {
    get: (chatId: string) => spies.get(chatId),
    measureContext: async () => ({ ok: true }),
    onChanged: (listener: (p: SessionTelemetryChangedPayload) => void) => {
      push.listener = listener
      return () => {
        if (push.listener === listener) push.listener = null
      }
    }
  }
}

const { RouterBadge, budgetLineColor } = await import('./RouterBadge')
const { useToastStore } = await import('../../stores/toast.store')
const { useUIStore } = await import('../../stores/ui.store')

function telemetry(chatId: string, used: number, context: Partial<SessionTelemetry['context']> = {}): SessionTelemetry {
  return {
    chatId,
    engine: 'claude',
    auth: { kind: 'api_key' },
    model: { selected: 'opus', source: 'init' },
    context: { used, size: 200_000, sizeAuthoritative: true, ...context },
    totals: {
      tokens: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      costUsd: 0,
      costSource: 'runtime',
      turns: 1,
      tokenScope: 'turn',
      byModel: {},
      bySession: {}
    },
    cache: { ttlSource: 'assumed' },
    updatedAt: 0
  }
}

let client: QueryClient

async function mount(
  initial: SessionTelemetry | null,
  opts: { level?: AiSpendingLevel; chatId?: string } = {}
): Promise<{ switchTo: (chatId: string) => Promise<void> }> {
  spies.settings.mockResolvedValue({ aiSpendingLevel: opts.level ?? 'eco' })
  spies.get.mockImplementation(async (chatId: string) => ({ ok: true, telemetry: initial && { ...initial, chatId } }))
  client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  const wrapper = ({ children }: { children: ReactNode }): React.JSX.Element =>
    createElement(QueryClientProvider, { client }, children)
  const chatId = opts.chatId ?? 'chat-1'
  const view = render(createElement(RouterBadge, { router: 'direct', chatId }), { wrapper })
  await waitFor(() => {
    expect(client.getQueryState(['sessionTelemetry', chatId])?.status).toBe('success')
    expect(client.getQueryState(['app-settings'])?.status).toBe('success')
    expect(push.listener).not.toBeNull()
  })
  return {
    switchTo: async (next) => {
      view.rerender(createElement(RouterBadge, { router: 'direct', chatId: next }))
      await waitFor(() => expect(client.getQueryState(['sessionTelemetry', next])?.status).toBe('success'))
    }
  }
}

async function send(t: SessionTelemetry): Promise<void> {
  await act(async () => {
    push.listener?.({ chatId: t.chatId, telemetry: t })
    await new Promise((resolve) => setTimeout(resolve, 0))
  })
}

const line = (): HTMLElement | null => screen.queryByTestId('context-budget-line')
const toast = (): string | undefined => useToastStore.getState().toast?.message

beforeEach(() => {
  spies.get.mockReset()
  spies.settings.mockReset()
  push.listener = null
  useToastStore.setState({ toast: null })
  useUIStore.setState({ extraUIAnimation: false })
})

describe('context health line', () => {
  it('fills to used / budget for an authoritative reading, inside the pill', async () => {
    // Eco on a 200K window: a 120K budget, 60K used.
    await mount(telemetry('chat-1', 60_000))
    const el = line()!
    expect(el).not.toBeNull()
    expect(el.style.width).toBe('50%')
    expect(el.getAttribute('aria-hidden')).toBe('true')
    expect(screen.getByRole('status', { name: 'Direct agent connection' }).contains(el)).toBe(true)
    await send(telemetry('chat-1', 180_000))
    expect(line()!.style.width).toBe('100%')
  })

  it('is absent while the window size is a guess', async () => {
    await mount(telemetry('chat-1', 60_000, { sizeAuthoritative: false }))
    expect(line()).toBeNull()
  })

  it('is absent on a job page badge, which has no chat', () => {
    client = new QueryClient()
    render(createElement(QueryClientProvider, { client }, createElement(RouterBadge, { router: 'script' })))
    expect(line()).toBeNull()
  })

  it('animates its width only with extra UI animation on', async () => {
    useUIStore.setState({ extraUIAnimation: true })
    await mount(telemetry('chat-1', 60_000))
    expect(line()!.className).toContain('transition-[width,background-color]')
    expect(line()!.className).toContain('motion-reduce:transition-none')
    act(() => useUIStore.setState({ extraUIAnimation: false }))
    expect(line()!.className).not.toContain('transition')
  })

  it('shows another chat’s reading on a fresh element, so the width does not replay', async () => {
    const view = await mount(telemetry('chat-1', 60_000))
    const first = line()
    await view.switchTo('chat-2')
    expect(line()).not.toBe(first)
  })

  it('shows the budget in the popover', async () => {
    await mount(telemetry('chat-1', 60_000))
    fireEvent.mouseEnter(screen.getByRole('status', { name: 'Direct agent connection' }))
    const dialog = screen.getByRole('dialog', { name: 'Chat routing' })
    fireEvent.click(within(dialog).getByRole('button', { name: /^Context / }))
    const toggle = within(dialog).getByRole('button', { name: /^Context / })
    expect(toggle.textContent).toBe('Context60K | 50% Eco budget | 30% total')
    const label = within(within(dialog).getByRole('region', { name: 'Context' })).getByText('Eco budget', { exact: true })
    expect(label.nextElementSibling?.textContent).toBe('120K 50% used')
  })

  it('says over 100% past the budget, while the line stops full', async () => {
    await mount(telemetry('chat-1', 180_000))
    fireEvent.mouseEnter(screen.getByRole('status', { name: 'Direct agent connection' }))
    const dialog = screen.getByRole('dialog', { name: 'Chat routing' })
    expect(within(dialog).getByRole('button', { name: /^Context / }).textContent).toBe('Context180K | 150% Eco budget | 90% total')
    expect(line()!.style.width).toBe('100%')
  })

  it('shows no budget at Greedy: its budget is the window', async () => {
    await mount(telemetry('chat-1', 60_000), { level: 'greedy' })
    fireEvent.mouseEnter(screen.getByRole('status', { name: 'Direct agent connection' }))
    const dialog = screen.getByRole('dialog', { name: 'Chat routing' })
    const toggle = within(dialog).getByRole('button', { name: /^Context / })
    expect(toggle.textContent).toBe('Context60K | 30% total')
    expect(toggle.getAttribute('aria-label')).toBe('Context 60K, 30% total')
    fireEvent.click(toggle)
    expect(within(dialog).getByText('60K of 200K (30%)')).toBeTruthy()
    expect(within(dialog).queryByText(/budget/)).toBeNull()
  })

  it('colours from theme variables, green to amber to red', () => {
    expect(budgetLineColor(0.2)).toBe('var(--color-success)')
    expect(budgetLineColor(0.65)).toBe('color-mix(in oklab, var(--color-success), var(--color-warning) 50%)')
    expect(budgetLineColor(0.8)).toBe('color-mix(in oklab, var(--color-success), var(--color-warning) 100%)')
    expect(budgetLineColor(1)).toBe('color-mix(in oklab, var(--color-warning), var(--color-danger) 100%)')
  })
})

describe('budget crossing toast', () => {
  it('tells the user once when a live reading crosses the budget, linking to the setting', async () => {
    await mount(telemetry('chat-1', 100_000))
    expect(toast()).toBeUndefined()
    await send(telemetry('chat-1', 125_000))
    expect(toast()).toBe(
      'Context in this chat reached your Eco budget (120K). Consider starting a new chat or compacting the conversation to avoid excessive token spending.'
    )
    expect(useToastStore.getState().toast?.link).toEqual({ label: 'Settings → Features', settingsMenu: 'features' })
    useToastStore.setState({ toast: null })
    await send(telemetry('chat-1', 140_000))
    expect(toast()).toBeUndefined()
  })

  it('says nothing when a chat opens already over the budget', async () => {
    await mount(telemetry('chat-1', 150_000))
    await send(telemetry('chat-1', 155_000))
    expect(toast()).toBeUndefined()
  })

  it('says nothing on switching to a chat already over the budget', async () => {
    spies.settings.mockResolvedValue({ aiSpendingLevel: 'eco' })
    const view = await mount(telemetry('chat-1', 100_000))
    spies.get.mockImplementation(async (chatId: string) => ({ ok: true, telemetry: telemetry(chatId, 150_000) }))
    await view.switchTo('chat-2')
    expect(line()!.style.width).toBe('100%')
    expect(toast()).toBeUndefined()
  })

  it('re-arms once usage drops back under the budget', async () => {
    await mount(telemetry('chat-1', 100_000))
    await send(telemetry('chat-1', 130_000))
    expect(toast()).toMatch(/reached your Eco budget/)
    useToastStore.setState({ toast: null })
    // Compacted.
    await send(telemetry('chat-1', 40_000))
    expect(toast()).toBeUndefined()
    await send(telemetry('chat-1', 121_000))
    expect(toast()).toMatch(/reached your Eco budget/)
  })

  it('says nothing when the level changes under a chat already past the new budget', async () => {
    await mount(telemetry('chat-1', 150_000), { level: 'mid' })
    await act(async () => {
      client.setQueryData(['app-settings'], { aiSpendingLevel: 'eco' })
    })
    await send(telemetry('chat-1', 151_000))
    expect(toast()).toBeUndefined()
  })

  it('says nothing on coming back to a chat that crossed the budget while away', async () => {
    const view = await mount(telemetry('chat-1', 100_000))
    await view.switchTo('chat-2')
    // chat-1's turn went on while chat-2 was open; its cached reading is the old one.
    spies.get.mockImplementation(async (chatId: string) => ({ ok: true, telemetry: telemetry(chatId, chatId === 'chat-1' ? 130_000 : 100_000) }))
    await view.switchTo('chat-1')
    await waitFor(() => expect(line()!.style.width).toBe('100%'))
    expect(toast()).toBeUndefined()
    // Live again from here: a drop and a new crossing still tell.
    await send(telemetry('chat-1', 50_000))
    await send(telemetry('chat-1', 125_000))
    expect(toast()).toMatch(/reached your Eco budget/)
  })

  it('says nothing when the size is confirmed with usage already over', async () => {
    await mount(telemetry('chat-1', 100_000, { sizeAuthoritative: false }))
    await send(telemetry('chat-1', 130_000))
    expect(toast()).toBeUndefined()
  })
})

it('keeps the Profile → Agents link for callers that pass no options', async () => {
  const { PROFILE_AGENTS_LINK } = await import('../../stores/toast.store')
  useToastStore.getState().show('Off Agent is disabled')
  expect(useToastStore.getState().toast?.link).toBe(PROFILE_AGENTS_LINK)
})
