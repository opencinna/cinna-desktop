import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { createElement } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { AgentShareResult, AgentShareStatus } from '../../../../../../shared/agentSharing'

/**
 * A shared agent's badge in the chat header's summary row: whether it exists
 * at all (decided from the statuses list, so it is there at first paint), what
 * it says (a short form, with the full sentence as its tooltip), its tone,
 * that a click opens the Sharing tab, which buttons sit after it, where their
 * refusals go (the page's one-line slot), and the two dialogs they open —
 * Share changes, and the two-button conflict.
 */

/** The chat the session opens: stubbed, since the flow behind it is the composer's and tested there. */
const startNewChat = vi.hoisted(() => vi.fn())
vi.mock('../../../../hooks/useNewChatFlow', () => ({ useNewChatFlow: () => ({ startNewChat }) }))

const { AgentShareBadge } = await import('./AgentShareBadge')
const { useShareActions } = await import('./useShareActions')
const { SHARE_BADGE_TEXT, SHARE_REFUSAL_TEXT, SHARE_STATE_TEXT, SHARE_UI_TEXT } = await import('../../../../utils/shareText')
const { resetSharingFetchClock, sharingStatusesKey } = await import('../../../../hooks/useSharing')
const { useAuthStore } = await import('../../../../stores/auth.store')
const { useChatStore } = await import('../../../../stores/chat.store')
const { useUIStore } = await import('../../../../stores/ui.store')

const AGENT = 'folder:alpha'

function status(overrides: Partial<AgentShareStatus> = {}): AgentShareStatus {
  return {
    agentId: AGENT,
    remote: { kind: 'cinna', url: 'https://core.test/git/r1.git', repoId: 'r1', host: 'https://core.test', access: 'edit' },
    bundleId: null,
    state: 'up_to_date',
    headSha: 'a',
    remoteHeadSha: 'a',
    ahead: 0,
    behind: 0,
    changedFiles: 0,
    unshared: false,
    fetched: false,
    refusal: null,
    adoption: null,
    teamChangesDeclined: false,
    ...overrides
  }
}

const ADOPTION = { chatId: 'chat-9', startedAt: '2026-10-16T09:00:00Z' }

function result(overrides: Partial<AgentShareResult> = {}): AgentShareResult {
  return { done: true, refusal: null, detail: null, status: null, agentId: null, autoAttached: [], setupNeeded: false, ...overrides }
}

const ok = <T,>(value: T) => ({ success: true as const, value })

let sharing: Record<string, ReturnType<typeof vi.fn>>
let getAgent: ReturnType<typeof vi.fn>

beforeEach(() => {
  resetSharingFetchClock()
  sharing = {
    statuses: vi.fn().mockResolvedValue(ok([])),
    // Never resolves unless a test says so: the line must not wait for it.
    status: vi.fn(() => new Promise(() => {})),
    draftMessage: vi.fn().mockResolvedValue(ok('Tightened the workflow prompt.')),
    shareChanges: vi.fn(),
    update: vi.fn(),
    useTeamVersion: vi.fn(),
    beginAdoption: vi.fn(),
    setAdoptionChat: vi.fn().mockResolvedValue(ok(result())),
    finishAdoption: vi.fn(),
    discardAdoption: vi.fn(),
    dismissTeamChanges: vi.fn()
  }
  startNewChat.mockReset()
  act(() => {
    useChatStore.setState({ activeChatId: null })
    useUIStore.setState({ activeView: 'local-agent', sidebarTab: 'agents' } as never)
  })
  getAgent = vi.fn().mockResolvedValue({ ok: true, value: { id: 'folder:copy', name: 'Alpha (mine)' } })
  ;(window as unknown as { api: unknown }).api = {
    sharing,
    localAgents: { get: getAgent }
  }
})

afterEach(() => {
  act(() => useAuthStore.setState({ currentUser: null }))
  cleanup()
  vi.clearAllMocks()
})

interface Mounted {
  client: QueryClient
  onNote: ReturnType<typeof vi.fn>
  onError: ReturnType<typeof vi.fn>
  onOpenSharing: ReturnType<typeof vi.fn>
}

/** Mount with the statuses list already loaded, as the sidebar leaves it, inside a row like the runtime summary. */
function mount(listed: AgentShareStatus[], onNote = vi.fn()): Mounted {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } })
  client.setQueryData(sharingStatusesKey(null), listed)
  sharing.statuses.mockResolvedValue(ok(listed))
  const onError = vi.fn()
  const onOpenSharing = vi.fn()
  // As the page has it: one actions instance owning the mutations and the
  // dialogs, handed to the badge.
  function Page(): React.JSX.Element {
    const actions = useShareActions(AGENT, { onError, onNote })
    return createElement(
      'div',
      null,
      createElement('div', { 'data-row': '' }, createElement(AgentShareBadge, { agentId: AGENT, actions, onOpenSharing })),
      actions.dialogs
    )
  }
  render(createElement(QueryClientProvider, { client }, createElement(Page)))
  return { client, onNote, onError, onOpenSharing }
}

function badge(): HTMLElement | null {
  return document.querySelector('[data-share-badge]')
}

function sentence(): string {
  return (badge()?.textContent ?? '').trim()
}

describe('AgentShareBadge — the slot', () => {
  it('is there at first paint for a shared agent, before its own status lands', () => {
    mount([status()])
    expect(badge()).not.toBeNull()
    expect(sentence()).toBe(SHARE_BADGE_TEXT.up_to_date(status()))
  })

  it('is absent for an agent that is not shared', () => {
    mount([status({ agentId: 'folder:other' })])
    expect(badge()).toBeNull()
    expect(document.querySelector('[data-row]')?.childElementCount).toBe(0)
    expect(sharing.status).not.toHaveBeenCalled()
  })

  it('opens the Sharing tab when clicked', () => {
    const { onOpenSharing } = mount([status()])
    fireEvent.click(badge()!)
    expect(onOpenSharing).toHaveBeenCalledTimes(1)
  })

  it('reads a cinna agent without reaching the network, and an external one with a fetch', () => {
    mount([status()])
    expect(sharing.status).toHaveBeenCalledWith(AGENT, false)
  })

  it('fetches for an external agent at most once a minute', async () => {
    const external = status({ remote: { kind: 'external', url: 'git@x:y.git', repoId: null, host: null, access: null } })
    sharing.status.mockResolvedValue(ok(external))
    const { client } = mount([external])
    expect(sharing.status).toHaveBeenLastCalledWith(AGENT, true)
    await act(async () => {})
    // A fetch moves the counts and main pushes `sharing:changed`; the refetch
    // that follows must not fetch again, or the two would loop.
    await act(async () => {
      await client.invalidateQueries({ queryKey: ['sharing'] })
    })
    expect(sharing.status).toHaveBeenCalledTimes(2)
    expect(sharing.status).toHaveBeenLastCalledWith(AGENT, false)
  })
})

describe('AgentShareBadge — across a profile switch', () => {
  it('re-reads the agent’s status under the new account instead of keeping the last one’s', async () => {
    sharing.status.mockResolvedValue(ok(status({ state: 'unshared', unshared: true, changedFiles: 1 })))
    mount([status()])
    await waitFor(() => expect(sentence()).toBe(SHARE_BADGE_TEXT.unshared(status({ changedFiles: 1 }))))
    expect(sharing.status).toHaveBeenCalledTimes(1)

    sharing.status.mockResolvedValue(ok(status({ state: 'other_account' })))
    act(() =>
      useAuthStore.setState({
        currentUser: { id: 'p2', type: 'cinna_user', username: 'b', displayName: 'B', hasPassword: false } as never
      })
    )
    await waitFor(() => expect(sentence()).toBe(SHARE_BADGE_TEXT.other_account(status())))
    expect(sharing.status).toHaveBeenCalledTimes(2)
  })
})

describe('AgentShareBadge — what it says', () => {
  it.each<[string, Partial<AgentShareStatus>, boolean]>([
    ['up_to_date', {}, false],
    ['unshared', { state: 'unshared', unshared: true, changedFiles: 3 }, false],
    ['behind', { state: 'behind', behind: -1 }, false],
    ['diverged', { state: 'diverged', ahead: 1, behind: 2, unshared: true }, true],
    ['adopting', { state: 'adopting', ahead: 1, behind: 2, unshared: true, adoption: ADOPTION }, false],
    ['removed', { state: 'removed' }, true],
    ['other_account', { state: 'other_account' }, false]
  ])('%s → its short form, the full sentence as its tooltip; warning-toned: %s', (state, overrides, warn) => {
    const s = status(overrides)
    mount([s])
    expect(sentence()).toBe(SHARE_BADGE_TEXT[state as AgentShareStatus['state']](s))
    expect(badge()!.title).toContain(SHARE_STATE_TEXT[state as AgentShareStatus['state']](s))
    expect(badge()!.className.includes('--color-warning')).toBe(warn)
  })

  it('counts unshared changes', () => {
    expect(SHARE_BADGE_TEXT.unshared(status({ changedFiles: 1 }))).toBe('1 change not shared')
    expect(SHARE_BADGE_TEXT.unshared(status({ changedFiles: 3 }))).toBe('3 changes not shared')
  })

  it('a failed read says so, warning-toned, with its refusal as the tooltip', () => {
    mount([status({ refusal: 'fetch_failed' })])
    expect(sentence()).toBe(SHARE_UI_TEXT.badgeReadFailed)
    expect(badge()!.title).toContain(SHARE_REFUSAL_TEXT.fetch_failed)
    expect(badge()!.className).toContain('--color-warning')
  })

  it('switches to the agent’s own status once it lands, in the same badge', async () => {
    sharing.status.mockResolvedValue(ok(status({ state: 'behind', behind: 2 })))
    mount([status()])
    await waitFor(() => expect(sentence()).toBe(SHARE_BADGE_TEXT.behind(status())))
  })
})

describe('AgentShareBadge — which buttons', () => {
  const buttons = (): string[] =>
    Array.from(document.querySelectorAll('[data-row] button:not([data-share-badge])')).map((b) => b.textContent ?? '')

  it.each<[string, Partial<AgentShareStatus>, string[]]>([
    ['up to date', {}, []],
    ['team moved', { state: 'behind', behind: -1 }, [SHARE_UI_TEXT.update]],
    ['unshared', { state: 'unshared', unshared: true, changedFiles: 1 }, [SHARE_UI_TEXT.shareChanges]],
    ['behind with local edits', { state: 'behind', behind: 1, unshared: true, changedFiles: 1 }, [SHARE_UI_TEXT.update, SHARE_UI_TEXT.shareChanges]],
    ['diverged', { state: 'diverged', behind: 1, ahead: 1, unshared: true }, [SHARE_UI_TEXT.shareChanges]],
    ['bringing together', { state: 'adopting', behind: 1, ahead: 1, unshared: true, adoption: ADOPTION }, [SHARE_UI_TEXT.finish, SHARE_UI_TEXT.discard]],
    ['read-only access', { state: 'unshared', unshared: true, changedFiles: 1, remote: { kind: 'cinna', url: 'u', repoId: 'r', host: 'h', access: 'use' } }, []],
    ['external, unknown access', { state: 'unshared', unshared: true, changedFiles: 1, remote: { kind: 'external', url: 'u', repoId: null, host: null, access: null } }, [SHARE_UI_TEXT.shareChanges]],
    ['removed', { state: 'removed', behind: -1, unshared: true }, []],
    ['other account', { state: 'other_account', behind: -1, unshared: true }, []]
  ])('%s', (_label, overrides, expected) => {
    mount([status(overrides)])
    expect(buttons()).toEqual(expected)
  })

  it('sits beside the badge in one unit that never wraps, at the badge’s height', () => {
    mount([status({ state: 'behind', behind: 1, unshared: true, changedFiles: 1 })])
    const unit = document.querySelector('[data-share-unit]') as HTMLElement
    expect(unit.parentElement).toBe(document.querySelector('[data-row]'))
    expect(unit.className).toContain('flex-nowrap')
    const update = screen.getByRole('button', { name: SHARE_UI_TEXT.update })
    expect(update.parentElement).toBe(unit)
    expect(badge()!.parentElement).toBe(unit)
    expect(update.className).toContain('py-0.5')
    expect(update.className).toContain('text-[10px]')
  })
})

describe('AgentShareBadge — Update', () => {
  it('a dirty refusal says to share first, in the page’s one-line slot', async () => {
    sharing.update.mockResolvedValue(ok(result({ done: false, refusal: 'dirty' })))
    const { onError } = mount([status({ state: 'behind', behind: 1 })])
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: SHARE_UI_TEXT.update }))
    })
    expect(onError).toHaveBeenCalledWith(null)
    expect(onError).toHaveBeenLastCalledWith(SHARE_REFUSAL_TEXT.dirty)
    // The badge keeps saying the state; no line of its own appears.
    expect(sentence()).toBe(SHARE_BADGE_TEXT.behind(status()))
  })

  it('a conflict opens the two-button dialog', async () => {
    sharing.update.mockResolvedValue(ok(result({ done: false, refusal: 'diverged_conflict' })))
    mount([status({ state: 'behind', behind: 1 })])
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: SHARE_UI_TEXT.update }))
    })
    expect(screen.getByRole('dialog', { name: SHARE_UI_TEXT.conflictTitle })).toBeTruthy()
  })
})

describe('AgentShareBadge — actions owned by the page', () => {
  it('a collision that lands after the badge is gone still opens the two-button dialog', async () => {
    let answer: (value: unknown) => void = () => {}
    sharing.update.mockReturnValue(new Promise((r) => { answer = r }))
    const client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } })
    const listed = [status({ state: 'behind', behind: 1 })]
    client.setQueryData(sharingStatusesKey(null), listed)
    sharing.statuses.mockResolvedValue(ok(listed))
    // Clicking the badge switches the page to settings, which unmounts it.
    function Page({ chat }: { chat: boolean }): React.JSX.Element {
      const actions = useShareActions(AGENT, { onError: vi.fn() })
      return createElement(
        'div',
        null,
        chat ? createElement(AgentShareBadge, { agentId: AGENT, actions, onOpenSharing: vi.fn() }) : null,
        actions.dialogs
      )
    }
    const view = render(createElement(QueryClientProvider, { client }, createElement(Page, { chat: true })))
    fireEvent.click(screen.getByRole('button', { name: SHARE_UI_TEXT.update }))
    view.rerender(createElement(QueryClientProvider, { client }, createElement(Page, { chat: false })))
    expect(badge()).toBeNull()
    await act(async () => answer(ok(result({ done: false, refusal: 'diverged_conflict' }))))
    expect(screen.getByRole('dialog', { name: SHARE_UI_TEXT.conflictTitle })).toBeTruthy()
  })
})

describe('AgentShareBadge — Share changes dialog', () => {
  const unshared = (): AgentShareStatus => status({ state: 'unshared', unshared: true, changedFiles: 2 })
  const field = (): HTMLTextAreaElement => screen.getByLabelText(SHARE_UI_TEXT.shareChangesLabel) as HTMLTextAreaElement

  it('shows the field at once and fills it with the draft when untouched', async () => {
    let resolveDraft: (value: unknown) => void = () => {}
    sharing.draftMessage.mockReturnValue(new Promise((r) => { resolveDraft = r }))
    mount([unshared()])
    fireEvent.click(screen.getByRole('button', { name: SHARE_UI_TEXT.shareChanges }))
    expect(field().placeholder).toBe(SHARE_UI_TEXT.shareChangesPlaceholder)
    await act(async () => resolveDraft(ok('Tightened the workflow prompt.')))
    expect(field().value).toBe('Tightened the workflow prompt.')
  })

  it('never overwrites what the user typed', async () => {
    let resolveDraft: (value: unknown) => void = () => {}
    sharing.draftMessage.mockReturnValue(new Promise((r) => { resolveDraft = r }))
    mount([unshared()])
    fireEvent.click(screen.getByRole('button', { name: SHARE_UI_TEXT.shareChanges }))
    fireEvent.change(field(), { target: { value: 'My own words' } })
    await act(async () => resolveDraft(ok('An AI summary')))
    expect(field().value).toBe('My own words')
  })

  it('keeps a refusal inside the dialog, and closes on success only', async () => {
    sharing.shareChanges.mockResolvedValueOnce(
      ok(result({ done: false, refusal: 'push_rejected', detail: 'credentials/.env is not allowed.' }))
    )
    mount([unshared()])
    fireEvent.click(screen.getByRole('button', { name: SHARE_UI_TEXT.shareChanges }))
    await act(async () => {})
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: SHARE_UI_TEXT.share }))
    })
    const dialog = screen.getByRole('dialog', { name: SHARE_UI_TEXT.shareChangesTitle })
    expect(sharing.shareChanges).toHaveBeenCalledWith(AGENT, 'Tightened the workflow prompt.')
    expect(dialog.querySelector('[role="alert"]')?.textContent).toContain(SHARE_REFUSAL_TEXT.push_rejected)
    expect(dialog.querySelector('[role="alert"]')?.textContent).toContain('credentials/.env is not allowed.')

    sharing.shareChanges.mockResolvedValueOnce(ok(result({ status: status() })))
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: SHARE_UI_TEXT.share }))
    })
    expect(screen.queryByRole('dialog', { name: SHARE_UI_TEXT.shareChangesTitle })).toBeNull()
  })

  it('a conflict closes it and opens the two-button dialog', async () => {
    sharing.shareChanges.mockResolvedValue(ok(result({ done: false, refusal: 'diverged_conflict' })))
    mount([unshared()])
    fireEvent.click(screen.getByRole('button', { name: SHARE_UI_TEXT.shareChanges }))
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: SHARE_UI_TEXT.share }))
    })
    expect(screen.queryByRole('dialog', { name: SHARE_UI_TEXT.shareChangesTitle })).toBeNull()
    expect(screen.getByRole('dialog', { name: SHARE_UI_TEXT.conflictTitle })).toBeTruthy()
  })
})

describe('AgentShareBadge — the conflict dialog', () => {
  async function openConflict(): Promise<ReturnType<typeof mount>> {
    sharing.update.mockResolvedValue(ok(result({ done: false, refusal: 'diverged_conflict' })))
    const mounted = mount([status({ state: 'behind', behind: 1 })])
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: SHARE_UI_TEXT.update }))
    })
    return mounted
  }

  it('Keep working on mine closes it and changes nothing', async () => {
    await openConflict()
    fireEvent.click(screen.getByRole('button', { name: SHARE_UI_TEXT.keepMine }))
    expect(screen.queryByRole('dialog')).toBeNull()
    expect(sharing.useTeamVersion).not.toHaveBeenCalled()
  })

  it('Use the team’s version keeps errors inside, and on success names the copy quietly', async () => {
    const { onNote } = await openConflict()
    sharing.useTeamVersion.mockResolvedValueOnce(ok(result({ done: false, refusal: 'turn_in_progress' })))
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: SHARE_UI_TEXT.useTeamVersion }))
    })
    const dialog = screen.getByRole('dialog', { name: SHARE_UI_TEXT.conflictTitle })
    expect(dialog.querySelector('[role="alert"]')?.textContent).toBe(SHARE_REFUSAL_TEXT.turn_in_progress)

    sharing.useTeamVersion.mockResolvedValueOnce(ok(result({ agentId: 'folder:copy', status: status() })))
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: SHARE_UI_TEXT.useTeamVersion }))
    })
    expect(sharing.useTeamVersion).toHaveBeenLastCalledWith(AGENT)
    expect(screen.queryByRole('dialog')).toBeNull()
    await waitFor(() => expect(onNote).toHaveBeenCalledWith(SHARE_UI_TEXT.keptCopy('Alpha (mine)')))
  })
})

describe('AgentShareBadge — Bring together', () => {
  const diverged = (): AgentShareStatus => status({ state: 'diverged', behind: 1, ahead: 1, unshared: true })
  const dialog = (): HTMLElement => screen.getByRole('dialog', { name: SHARE_UI_TEXT.shareChangesTitle })

  it('Share changes opens on the Bring together step while both sides moved: no field, no draft', () => {
    mount([diverged()])
    fireEvent.click(screen.getByRole('button', { name: SHARE_UI_TEXT.shareChanges }))
    expect(dialog().textContent).toContain(SHARE_UI_TEXT.bringTogetherBanner)
    expect(screen.queryByLabelText(SHARE_UI_TEXT.shareChangesLabel)).toBeNull()
    expect(screen.getByRole('button', { name: SHARE_UI_TEXT.bringTogether })).toBeTruthy()
    expect(screen.queryByRole('button', { name: SHARE_UI_TEXT.share })).toBeNull()
    expect(sharing.draftMessage).not.toHaveBeenCalled()
  })

  it('begins the session, opens its chat with the brief as the first message, and records the chat', async () => {
    const adopting = status({ state: 'adopting', behind: 1, ahead: 1, unshared: true, adoption: { ...ADOPTION, chatId: null } })
    sharing.beginAdoption.mockResolvedValue(ok({ ...result({ status: adopting }), brief: 'The team changed the tax rule.' }))
    startNewChat.mockImplementation(async () => {
      useChatStore.setState({ activeChatId: 'chat-9' })
      return true
    })
    const { onError } = mount([diverged()])
    fireEvent.click(screen.getByRole('button', { name: SHARE_UI_TEXT.shareChanges }))
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: SHARE_UI_TEXT.bringTogether }))
    })
    expect(sharing.beginAdoption).toHaveBeenCalledWith(AGENT)
    expect(screen.queryByRole('dialog')).toBeNull()
    await waitFor(() => expect(startNewChat).toHaveBeenCalledTimes(1))
    expect(startNewChat).toHaveBeenCalledWith(
      expect.objectContaining({ message: 'The team changed the tax rule.', agentIds: [AGENT], title: SHARE_UI_TEXT.adoptionChatTitle })
    )
    await waitFor(() => expect(sharing.setAdoptionChat).toHaveBeenCalledWith(AGENT, 'chat-9'))
    await waitFor(() => expect(useUIStore.getState().activeView).toBe('chat'))
    expect(useUIStore.getState().sidebarTab).toBe('chats')
    expect(onError).not.toHaveBeenCalledWith(expect.any(String))
    // The badge now says the session is on, with its two buttons.
    expect(sentence()).toBe(SHARE_BADGE_TEXT.adopting(adopting))
    expect(screen.getByRole('button', { name: SHARE_UI_TEXT.finish })).toBeTruthy()
  })

  it('a chat that could not start says so in the page’s slot — the folder was still brought together', async () => {
    sharing.beginAdoption.mockResolvedValue(ok({ ...result(), brief: 'Brief' }))
    startNewChat.mockResolvedValue(false)
    const { onError } = mount([diverged()])
    fireEvent.click(screen.getByRole('button', { name: SHARE_UI_TEXT.shareChanges }))
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: SHARE_UI_TEXT.bringTogether }))
    })
    await waitFor(() => expect(onError).toHaveBeenLastCalledWith(SHARE_UI_TEXT.sessionNotStarted))
    expect(sharing.setAdoptionChat).not.toHaveBeenCalled()
    expect(useUIStore.getState().activeView).toBe('local-agent')
  })

  it('a collision opens the two-button dialog; another refusal stays on the step', async () => {
    sharing.beginAdoption.mockResolvedValueOnce(ok({ ...result({ done: false, refusal: 'turn_in_progress' }), brief: null }))
    mount([diverged()])
    fireEvent.click(screen.getByRole('button', { name: SHARE_UI_TEXT.shareChanges }))
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: SHARE_UI_TEXT.bringTogether }))
    })
    expect(dialog().querySelector('[role="alert"]')?.textContent).toBe(SHARE_REFUSAL_TEXT.turn_in_progress)
    expect(startNewChat).not.toHaveBeenCalled()

    sharing.beginAdoption.mockResolvedValueOnce(ok({ ...result({ done: false, refusal: 'diverged_conflict' }), brief: null }))
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: SHARE_UI_TEXT.bringTogether }))
    })
    expect(screen.queryByRole('dialog', { name: SHARE_UI_TEXT.shareChangesTitle })).toBeNull()
    expect(screen.getByRole('dialog', { name: SHARE_UI_TEXT.conflictTitle })).toBeTruthy()
  })

  it('the team moving onto the same files during a send turns the dialog into the Bring together step, with no error line', async () => {
    sharing.shareChanges.mockResolvedValue(ok(result({ done: false, refusal: 'team_changed_again' })))
    mount([status({ state: 'unshared', unshared: true, changedFiles: 1 })])
    fireEvent.click(screen.getByRole('button', { name: SHARE_UI_TEXT.shareChanges }))
    await act(async () => {})
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: SHARE_UI_TEXT.share }))
    })
    expect(dialog().textContent).toContain(SHARE_UI_TEXT.bringTogetherBanner)
    expect(screen.getByRole('button', { name: SHARE_UI_TEXT.bringTogether })).toBeTruthy()
    expect(dialog().querySelector('[role="alert"]')).toBeNull()
  })
})

describe('AgentShareBadge — Finish and Discard', () => {
  const adopting = (): AgentShareStatus => status({ state: 'adopting', behind: 1, ahead: 1, unshared: true, adoption: ADOPTION })
  const field = (): HTMLTextAreaElement => screen.getByLabelText(SHARE_UI_TEXT.shareChangesLabel) as HTMLTextAreaElement

  it('Finish opens Share changes with the session’s own summary in the field, and asks for no draft', async () => {
    const after = status({ state: 'unshared', unshared: true, ahead: 2 })
    sharing.finishAdoption.mockResolvedValue(ok({ ...result({ status: after }), summary: 'Kept one tax rule.' }))
    mount([adopting()])
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: SHARE_UI_TEXT.finish }))
    })
    expect(sharing.finishAdoption).toHaveBeenCalledWith(AGENT)
    expect(screen.getByRole('dialog', { name: SHARE_UI_TEXT.shareChangesTitle })).toBeTruthy()
    expect(field().value).toBe('Kept one tax rule.')
    expect(sharing.draftMessage).not.toHaveBeenCalled()
    expect(sentence()).toBe(SHARE_BADGE_TEXT.unshared(after))
  })

  it('Finish’s refusal goes to the page’s slot and the badge keeps its buttons', async () => {
    sharing.finishAdoption.mockResolvedValue(ok({ ...result({ done: false, refusal: 'team_changed_again' }), summary: null }))
    const { onError } = mount([adopting()])
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: SHARE_UI_TEXT.finish }))
    })
    expect(onError).toHaveBeenLastCalledWith(SHARE_REFUSAL_TEXT.team_changed_again)
    expect(screen.queryByRole('dialog')).toBeNull()
    expect(screen.getByRole('button', { name: SHARE_UI_TEXT.finish })).toBeTruthy()
    expect(screen.getByRole('button', { name: SHARE_UI_TEXT.discard })).toBeTruthy()
  })

  it('Discard confirms first, keeps a refusal inside, and closes on success only', async () => {
    mount([adopting()])
    fireEvent.click(screen.getByRole('button', { name: SHARE_UI_TEXT.discard }))
    const dialog = screen.getByRole('dialog', { name: SHARE_UI_TEXT.discardTitle })
    expect(dialog.textContent).toContain(SHARE_UI_TEXT.discardBody('this agent'))
    expect(sharing.discardAdoption).not.toHaveBeenCalled()

    sharing.discardAdoption.mockResolvedValueOnce(ok(result({ done: false, refusal: 'turn_in_progress' })))
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: SHARE_UI_TEXT.discardConfirm }))
    })
    expect(sharing.discardAdoption).toHaveBeenCalledWith(AGENT)
    expect(dialog.querySelector('[role="alert"]')?.textContent).toBe(SHARE_REFUSAL_TEXT.turn_in_progress)

    sharing.discardAdoption.mockResolvedValueOnce(ok(result({ status: status({ state: 'diverged', behind: 1, ahead: 1, unshared: true }) })))
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: SHARE_UI_TEXT.discardConfirm }))
    })
    expect(screen.queryByRole('dialog')).toBeNull()
    expect(sentence()).toBe(SHARE_BADGE_TEXT.diverged(status()))
  })
})
