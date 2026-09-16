import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { cleanup, render, screen, waitFor } from '@testing-library/react'
import { createElement, type ReactNode } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { InboxEntry, InboxSnapshot, InboxUnreadableSource } from '../../../../shared/inbox'

/**
 * The top bar's Inbox button.
 *
 * The count on it is the one number in this app that changes **while the user
 * is doing something else** — an agent parks on a permission ask in a job run
 * nobody is watching, and the badge goes from nothing to 1 under a pointer
 * already on its way to the chat below. So the thing actually under test is
 * that the slot holding it never changes size: at 0, at 9, at 99 and past it.
 */

// `ui.store.ts` calls `window.api.app.setTheme(...)` at module scope.
;(window as unknown as { api: Record<string, unknown> }).api = {
  app: { setTheme: async () => undefined }
}

const { InboxButton } = await import('./InboxButton')
const { useUIStore } = await import('../../stores/ui.store')

function entry(n: number): InboxEntry {
  return {
    requestId: `per_${n}`,
    source: 'local',
    taskId: `t${n}`,
    taskTitle: 'Nightly check',
    chatId: `c${n}`,
    agentId: 'a1',
    request: { kind: 'permission', action: 'bash', resources: ['ls'] },
    resume: 'reply',
    createdAt: new Date('2026-09-11T10:00:00Z')
  }
}

function wrapper({ children }: { children: ReactNode }): React.JSX.Element {
  // `retryDelay`, not `retry`: `useInboxList` sets `retry: 1` itself and a
  // hook's own option beats the client default.
  const client = new QueryClient({ defaultOptions: { queries: { retryDelay: 0 } } })
  return createElement(QueryClientProvider, { client }, children)
}

function mountWith(count: number, unreadable: InboxUnreadableSource[] = []): void {
  mountListing(async () => ({
    entries: Array.from({ length: count }, (_v, i) => entry(i)),
    unreadable
  }))
}

function mountListing(list: () => Promise<InboxSnapshot>): void {
  ;(window as unknown as { api: Record<string, unknown> }).api = {
    app: { setTheme: async () => undefined },
    inbox: { list }
  }
  render(createElement(InboxButton), { wrapper })
}

/** The slot is the last child of the button — the one holding the number. */
function slotOf(button: HTMLElement): HTMLElement {
  const slot = button.lastElementChild as HTMLElement | null
  if (!slot) throw new Error('the count slot is not rendered')
  return slot
}

beforeEach(() => {
  useUIStore.setState({ activeView: 'chat' } as never)
})

afterEach(() => {
  vi.restoreAllMocks()
})

describe('InboxButton', () => {
  it('keeps the count in a slot of one width at 0, 9 and 99', async () => {
    // Mutation: drop `w-5` from the slot's class and this fails on the first
    // count — the overlay no longer has a fixed footprint for its count.
    const widths: string[] = []
    for (const count of [0, 9, 99]) {
      mountWith(count)
      const slot = slotOf(await screen.findByRole('button', { name: /^Inbox/ }))
      await waitFor(() => {
        expect(slot.textContent).toBe(count === 0 ? '' : String(count))
      })
      widths.push(slot.className.split(/\s+/).filter((c) => c.startsWith('w-')).join(' '))
      cleanup()
    }
    expect(widths).toEqual(['w-5', 'w-5', 'w-5'])
  })

  it('says "99+" rather than growing the slot past two digits', async () => {
    mountWith(120)
    const button = await screen.findByRole('button', { name: /^Inbox/ })
    await waitFor(() => expect(slotOf(button).textContent).toBe('99+'))
  })

  it('announces the count it shows, and only names itself when there is none', async () => {
    // `ux_rules.md` §10 — the badge is `aria-hidden`, so a reader that heard
    // only "Inbox" would be told nothing is waiting when three things are.
    mountWith(3)
    await waitFor(() =>
      expect(screen.getByRole('button', { name: 'Inbox — 3 waiting' })).toBeTruthy()
    )
  })

  it('says a read failed rather than showing a confident zero', async () => {
    // Mutation: drop the `unreadable` branch and this fails — `data` is
    // undefined on an error too, so the badge would report "nothing waiting"
    // for a profile whose agent is parked, in the one place anyone would look.
    mountListing(async () => {
      throw new Error('database is locked')
    })
    const button = await screen.findByRole('button', { name: 'Inbox — could not be read' })
    await waitFor(() => expect(slotOf(button).textContent).toBe('!'))
    // Still the same slot: a failure must not resize the badge either.
    expect(slotOf(button).className).toContain('w-5')
  })

  it('opens the inbox view', async () => {
    mountWith(1)
    const button = await screen.findByRole('button', { name: /^Inbox/ })
    button.click()
    expect(useUIStore.getState().activeView).toBe('inbox')
  })

  it('reports a failed warm refresh even when the last successful count was zero', async () => {
    const client = new QueryClient({ defaultOptions: { queries: { retryDelay: 0 } } })
    const list = vi.fn<() => Promise<InboxSnapshot>>().mockResolvedValue({ entries: [], unreadable: [] })
    ;(window as unknown as { api: Record<string, unknown> }).api = {
      app: { setTheme: async () => undefined }, inbox: { list }
    }
    render(createElement(QueryClientProvider, { client }, createElement(InboxButton)))
    await waitFor(() => expect(client.getQueryState(['inbox'])?.status).toBe('success'))
    list.mockRejectedValue(new Error('service offline'))
    await client.invalidateQueries({ queryKey: ['inbox'] })
    const button = await screen.findByRole('button', { name: 'Inbox — could not be read' })
    expect(slotOf(button).textContent).toBe('!')
    expect(client.getQueryData(['inbox'])).toEqual({ entries: [], unreadable: [] })
  })

  it('keeps the count and warns beside it when a service could not be read', async () => {
    // Mutation: fall back to the plain `Inbox — 3 waiting` when something is
    // unreadable and this fails — the number is announced as the whole truth
    // in the one place anybody checks, while a bound service's asks are not in
    // it. The count itself stays: those three *are* waiting.
    mountWith(3, [{ adapter: 'cinna', reason: 'offline' }])
    const button = await screen.findByRole('button', {
      name: 'Inbox — 3 waiting, one service could not be read'
    })
    await waitFor(() => expect(slotOf(button).textContent).toBe('3'))
    // Warning, not accent: the badge is still a count, and still not a promise.
    expect(slotOf(button).className).toContain('bg-[var(--color-warning)]')
    expect(slotOf(button).className).toContain('w-5')
  })

  it('says only what failed when nothing local is waiting either', async () => {
    mountWith(0, [{ adapter: 'cinna', reason: 'offline' }])
    await waitFor(() =>
      expect(
        screen.getByRole('button', { name: 'Inbox — one service could not be read' })
      ).toBeTruthy()
    )
  })

  it('is still visibly marked when the hole is all there is to report', async () => {
    // Mutation: gate the fill on `partial && count > 0` and drop the `!` at
    // zero, and this fails — the badge goes back to being pixel-identical to a
    // healthy empty inbox at the exact moment the user's only bound service has
    // gone dark. The accessible name alone is not "visible" (`ux_rules.md` §6);
    // this is the state `remote-inbox.spec.ts` opens by, and it used to reach
    // the user as a warning because main rejected the whole read.
    mountWith(0, [{ adapter: 'cinna', reason: 'offline' }])
    const button = await screen.findByRole('button', {
      name: 'Inbox — one service could not be read'
    })
    await waitFor(() => expect(slotOf(button).textContent).toBe('!'))
    expect(slotOf(button).className).toContain('bg-[var(--color-warning)]')
    expect(slotOf(button).className).toContain('w-5')
  })
})
