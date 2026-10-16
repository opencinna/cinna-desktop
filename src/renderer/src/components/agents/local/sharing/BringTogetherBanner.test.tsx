import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { createElement } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { AgentShareStatus } from '../../../../../../shared/agentSharing'

/**
 * The chat banner that offers to bring the team's changes together: there at
 * first paint when the page decided so from the listed status, gone on Not
 * now (which is remembered in main) and gone the moment the status stops
 * being "both sides moved" — never added later while the user works.
 */

const { BringTogetherBanner } = await import('./BringTogetherBanner')
const { SHARE_UI_TEXT } = await import('../../../../utils/shareText')
const { resetSharingFetchClock, sharingStatusesKey } = await import('../../../../hooks/useSharing')

const AGENT = 'folder:alpha'

function status(overrides: Partial<AgentShareStatus> = {}): AgentShareStatus {
  return {
    agentId: AGENT,
    remote: { kind: 'cinna', url: 'https://core.test/git/r1.git', repoId: 'r1', host: 'https://core.test', access: 'edit' },
    bundleId: null,
    state: 'diverged',
    headSha: 'a',
    remoteHeadSha: 'b',
    ahead: 1,
    behind: 1,
    changedFiles: 1,
    unshared: true,
    fetched: false,
    refusal: null,
    adoption: null,
    teamChangesDeclined: false,
    ...overrides
  }
}

const ok = <T,>(value: T) => ({ success: true as const, value })

let sharing: Record<string, ReturnType<typeof vi.fn>>

beforeEach(() => {
  resetSharingFetchClock()
  sharing = {
    statuses: vi.fn().mockResolvedValue(ok([])),
    // Never resolves unless a test says so: the banner must not wait for it.
    status: vi.fn(() => new Promise(() => {}))
  }
  ;(window as unknown as { api: unknown }).api = { sharing }
})

afterEach(() => {
  cleanup()
  vi.clearAllMocks()
})

interface Actions {
  bringTogether: ReturnType<typeof vi.fn>
  bringTogetherPending: boolean
  notNow: ReturnType<typeof vi.fn>
}

function mount(listed: AgentShareStatus[], initialOffered: boolean, pending = false): { client: QueryClient; actions: Actions } {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  client.setQueryData(sharingStatusesKey(null), listed)
  sharing.statuses.mockResolvedValue(ok(listed))
  const actions: Actions = { bringTogether: vi.fn(), bringTogetherPending: pending, notNow: vi.fn() }
  render(
    createElement(
      QueryClientProvider,
      { client },
      createElement(BringTogetherBanner, { agentId: AGENT, initialOffered, actions })
    )
  )
  return { client, actions }
}

const banner = (): HTMLElement | null => screen.queryByTestId('bring-together-banner')

describe('BringTogetherBanner', () => {
  it('is there at first paint when offered and both sides moved, with the sentence and its two buttons', () => {
    const { actions } = mount([status()], true)
    expect(banner()).not.toBeNull()
    expect(banner()!.textContent).toContain(SHARE_UI_TEXT.bringTogetherBanner)
    // Two buttons inside: a named region, not a live status.
    expect(screen.getByRole('region', { name: SHARE_UI_TEXT.bringTogetherBannerLabel })).toBe(banner())
    expect(screen.queryByRole('status')).toBeNull()
    // The composer's band, so its edges meet the message box's.
    expect(banner()!.parentElement!.className.split(/\s+/)).toEqual(expect.arrayContaining(['max-w-3xl', 'mx-auto', 'px-4', 'w-full']))
    fireEvent.click(screen.getByRole('button', { name: SHARE_UI_TEXT.bringTogether }))
    expect(actions.bringTogether).toHaveBeenCalledTimes(1)
    expect(actions.notNow).not.toHaveBeenCalled()
  })

  it('leaves on Not now, once, and tells main', () => {
    const { actions } = mount([status()], true)
    fireEvent.click(screen.getByRole('button', { name: SHARE_UI_TEXT.notNow }))
    expect(banner()).toBeNull()
    expect(actions.notNow).toHaveBeenCalledTimes(1)
  })

  it('is absent when the page did not offer it, even while both sides moved', () => {
    mount([status()], false)
    expect(banner()).toBeNull()
  })

  it('leaves the moment the status stops being both-sides-moved', async () => {
    const { client } = mount([status()], true)
    expect(banner()).not.toBeNull()
    act(() => {
      client.setQueryData(sharingStatusesKey(null), [status({ state: 'adopting', adoption: { chatId: null, startedAt: '2026-10-16T09:00:00Z' } })])
    })
    await waitFor(() => expect(banner()).toBeNull())
  })

  it('says it is bringing together inside the button while the session begins, and holds both buttons', () => {
    mount([status()], true, true)
    const bring = screen.getByRole('button', { name: SHARE_UI_TEXT.bringingTogether }) as HTMLButtonElement
    expect(bring.disabled).toBe(true)
    expect((screen.getByRole('button', { name: SHARE_UI_TEXT.notNow }) as HTMLButtonElement).disabled).toBe(true)
  })
})
