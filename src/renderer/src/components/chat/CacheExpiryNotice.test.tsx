import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { createElement, type ReactNode } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { SessionTelemetry, SessionTelemetryChangedPayload, SessionTelemetryGetResult } from '../../../../shared/sessionTelemetry'
import type { CacheExpiryNotice as NoticeData } from '../../../../shared/sessionTelemetryDerived'

/**
 * The prompt-cache notice above an open chat's composer: shown when the chat
 * opens on a cold cache over a large context, never inserted by a clock while
 * the user sits in the chat, hidden while a turn runs, gone on send, and
 * dismissed per chat and `lastRequestAt`.
 */

const MIN = 60_000
const HOUR = 60 * MIN
const T0 = Date.UTC(2026, 9, 26, 12, 0, 0)

const listeners: Array<(payload: SessionTelemetryChangedPayload) => void> = []
const readings = new Map<string, SessionTelemetry>()
const get = vi.fn(async (chatId: string): Promise<SessionTelemetryGetResult> => ({ ok: true, telemetry: readings.get(chatId) ?? null }))

;(window as unknown as { api: unknown }).api = {
  sessionTelemetry: {
    get,
    measureContext: async () => ({ ok: false, code: 'chat_not_found' }),
    onChanged: (handler: (payload: SessionTelemetryChangedPayload) => void) => {
      listeners.push(handler)
      return () => listeners.splice(listeners.indexOf(handler), 1)
    }
  }
}

const { useCacheExpiryNotice } = await import('../../hooks/useCacheExpiryNotice')
const { CacheExpiryNotice, cacheNoticeCopy } = await import('./CacheExpiryNotice')
const { useComposerDraftStore } = await import('../../stores/composerDraft.store')
const { useCacheNoticeStore, CACHE_NOTICE_DISMISSED_KEY } = await import('../../stores/cacheNotice.store')

/** A Claude session on an API key with an observed 1h TTL: warm for an hour, then certainly cold. */
function telemetry(chatId: string, lastRequestAt: number, used = 120_000): SessionTelemetry {
  return {
    chatId,
    engine: 'claude',
    auth: { kind: 'api_key' },
    model: { resolved: 'claude-sonnet-5', source: 'init' },
    context: { used, size: 200_000, sizeAuthoritative: true },
    totals: {
      tokens: { input: 100, output: 1_000, cacheRead: 8_000, cacheWrite: 1_900 },
      costSource: 'runtime',
      turns: 1,
      tokenScope: 'turn',
      byModel: {},
      bySession: {}
    },
    cache: { lastRequestAt, ttlMs: HOUR, ttlSource: 'observed', expiresAt: lastRequestAt + HOUR },
    updatedAt: lastRequestAt
  }
}

function push(chatId: string, reading: SessionTelemetry): void {
  readings.set(chatId, reading)
  act(() => { for (const listener of [...listeners]) listener({ chatId, telemetry: reading }) })
}

const draftKey = (chatId: string): string => `chat:${chatId}`

function Harness({ chatId, streaming = false }: { chatId: string; streaming?: boolean }): React.JSX.Element | null {
  const model = useCacheExpiryNotice(chatId, { draftKey: draftKey(chatId), streaming })
  return model ? createElement(CacheExpiryNotice, { notice: model.notice, onNewChat: () => undefined, onDismiss: model.dismiss }) : null
}

let client: QueryClient
function mount(chatId: string, streaming = false): { rerender: (chatId: string, streaming?: boolean) => void } {
  client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  const wrapper = ({ children }: { children: ReactNode }): React.JSX.Element => createElement(QueryClientProvider, { client }, children)
  const view = render(createElement(Harness, { chatId, streaming }), { wrapper })
  return { rerender: (next, nextStreaming = false) => view.rerender(createElement(Harness, { chatId: next, streaming: nextStreaming })) }
}

const panel = (): HTMLElement | null => screen.queryByRole('region', { name: 'Prompt cache notice' })

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] })
  vi.setSystemTime(T0)
  readings.clear()
  listeners.length = 0
  localStorage.removeItem(CACHE_NOTICE_DISMISSED_KEY)
  useCacheNoticeStore.setState({ dismissed: {} })
})

afterEach(() => {
  vi.useRealTimers()
})

describe('the prompt-cache notice', () => {
  it('appears when a chat opens on an expired cache over a large context', async () => {
    readings.set('c1', telemetry('c1', T0 - 3 * HOUR))
    mount('c1')
    await waitFor(() => expect(panel()).not.toBeNull())
    expect(panel()!.textContent).toContain("Prompt cache expired (idle 3 h).")
    expect(screen.getByRole('button', { name: 'New chat' })).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Dismiss' }).getAttribute('title')).toBe('Dismiss')
    expect(screen.getByRole('button', { name: 'New chat' }).getAttribute('title')).toBe('A new chat set up like this one')
    // The whole copy is on screen, never cut to a tooltip.
    const copy = panel()!.querySelector('p')!
    expect(copy.className).not.toMatch(/line-clamp/)
    expect(copy.hasAttribute('title')).toBe(false)
  })

  it('stays away under 50K tokens of context', async () => {
    readings.set('c1', telemetry('c1', T0 - 3 * HOUR, 49_000))
    mount('c1')
    await waitFor(() => expect(get).toHaveBeenCalled())
    await act(async () => { await Promise.resolve() })
    expect(panel()).toBeNull()
  })

  it('is not inserted when the clock passes the expiry with the chat open, only when the user comes back', async () => {
    readings.set('c1', telemetry('c1', T0 - 50 * MIN))
    readings.set('c2', telemetry('c2', T0 - 3 * HOUR))
    const view = mount('c1')
    await waitFor(() => expect(get).toHaveBeenCalledWith('c1'))
    expect(panel()).toBeNull()

    // An hour passes with the chat on screen; a telemetry push re-renders it.
    vi.setSystemTime(T0 + HOUR)
    push('c1', telemetry('c1', T0 - 50 * MIN))
    view.rerender('c1')
    expect(panel()).toBeNull()

    // Typing, then the window regains focus: still nothing under the cursor.
    act(() => useComposerDraftStore.getState().update(draftKey('c1'), () => ({ text: 'half a thought' })))
    act(() => { window.dispatchEvent(new Event('focus')) })
    expect(panel()).toBeNull()

    // An empty composer when the window comes back: the clock is read again.
    act(() => useComposerDraftStore.getState().update(draftKey('c1'), () => ({ text: '' })))
    act(() => { window.dispatchEvent(new Event('focus')) })
    expect(panel()).not.toBeNull()
  })

  it('reads the clock again when another chat opens', async () => {
    readings.set('c1', telemetry('c1', T0 - 50 * MIN))
    readings.set('c2', telemetry('c2', T0 - 50 * MIN))
    const view = mount('c1')
    await waitFor(() => expect(get).toHaveBeenCalledWith('c1'))
    vi.setSystemTime(T0 + HOUR)
    view.rerender('c2')
    await waitFor(() => expect(panel()).not.toBeNull())
  })

  it('is hidden while a turn streams', async () => {
    readings.set('c1', telemetry('c1', T0 - 3 * HOUR))
    const view = mount('c1')
    await waitFor(() => expect(panel()).not.toBeNull())
    view.rerender('c1', true)
    expect(panel()).toBeNull()
  })

  it('is gone from the moment a send starts, and stays gone once it ends', async () => {
    readings.set('c1', telemetry('c1', T0 - 3 * HOUR))
    mount('c1')
    await waitFor(() => expect(panel()).not.toBeNull())
    act(() => { useComposerDraftStore.getState().beginSend(draftKey('c1')) })
    expect(panel()).toBeNull()
    // The send's turn has not reported yet: the reading is the same.
    act(() => useComposerDraftStore.getState().endSend(draftKey('c1')))
    expect(panel()).toBeNull()
  })

  it('stays dismissed for the reading it was dismissed on, across a restart, and returns for a newer one', async () => {
    readings.set('c1', telemetry('c1', T0 - 3 * HOUR))
    const view = mount('c1')
    await waitFor(() => expect(panel()).not.toBeNull())
    fireEvent.click(screen.getByRole('button', { name: 'Dismiss' }))
    expect(panel()).toBeNull()
    expect(JSON.parse(localStorage.getItem(CACHE_NOTICE_DISMISSED_KEY)!)).toEqual({ c1: T0 - 3 * HOUR })

    // Reopened: still dismissed.
    view.rerender('c2')
    view.rerender('c1')
    expect(panel()).toBeNull()

    // Used again, then idle again: a new reading brings it back.
    push('c1', telemetry('c1', T0 + MIN))
    vi.setSystemTime(T0 + 4 * HOUR)
    view.rerender('c2')
    view.rerender('c1')
    expect(panel()).not.toBeNull()
  })

  it('keeps one dismissal per chat', () => {
    useCacheNoticeStore.getState().dismiss('c1', 1)
    useCacheNoticeStore.getState().dismiss('c1', 2)
    useCacheNoticeStore.getState().dismiss('c2', 3)
    expect(useCacheNoticeStore.getState().dismissed).toEqual({ c1: 2, c2: 3 })
  })
})

describe('its copy', () => {
  const notice = (patch: Partial<NoticeData>): NoticeData => ({
    level: 'expired',
    reason: 'idle',
    idleMs: 3 * HOUR + 5 * MIN,
    contextTokens: 180_400,
    estimate: { basis: 'api', coldUsd: 0.6765, warmUsd: 0.0541 },
    ...patch
  })

  it('names the price on an API key', () => {
    expect(cacheNoticeCopy(notice({}))).toEqual({
      title: 'Prompt cache expired (idle 3 h)',
      body: 'Next message costs ~$0.68 instead of $0.05. A new chat starts without history.'
    })
  })

  it('names no price on a subscription', () => {
    expect(cacheNoticeCopy(notice({ level: 'probably_expired', estimate: { basis: 'subscription' } }))).toEqual({
      title: 'Prompt cache probably expired (idle 3 h)',
      body: 'Next message re-reads ~180K tokens uncached and uses much more of your plan. A new chat starts without history.'
    })
  })

  it('says tokens only when no price is known', () => {
    expect(cacheNoticeCopy(notice({ estimate: { basis: 'none' } })).body).toBe('Next message re-reads ~180K tokens uncached, which costs more. A new chat starts without history.')
  })

  it('names what reset the cache instead of the idle time', () => {
    expect(cacheNoticeCopy(notice({ reason: 'model_change' })).title).toBe('Prompt cache reset: the model changed')
    expect(cacheNoticeCopy(notice({ reason: 'compaction' })).title).toBe('Prompt cache reset: context compacted')
    expect(cacheNoticeCopy(notice({ reason: 'session_params_change' })).title).toBe('Prompt cache reset: settings changed')
  })
})
