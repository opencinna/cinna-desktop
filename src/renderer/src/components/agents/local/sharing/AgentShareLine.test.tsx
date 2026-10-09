import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { createElement } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { AgentShareResult, AgentShareStatus } from '../../../../../../shared/agentSharing'

/**
 * A shared agent's status line on its page: whether it exists at all (decided
 * from the statuses list, so it is there at first paint), what it says (one
 * entry of the state or refusal map), which buttons it offers, and the two
 * dialogs it opens — Share changes, and the two-button conflict.
 */

const { AgentShareLine } = await import('./AgentShareLine')
const { SHARE_REFUSAL_TEXT, SHARE_STATE_TEXT, SHARE_UI_TEXT } = await import('../../../../utils/shareText')
const { resetSharingFetchClock, sharingStatusesKey } = await import('../../../../hooks/useSharing')
const { useAuthStore } = await import('../../../../stores/auth.store')

const AGENT = 'folder:alpha'

function status(overrides: Partial<AgentShareStatus> = {}): AgentShareStatus {
  return {
    agentId: AGENT,
    remote: { kind: 'cinna', url: 'https://core.test/git/r1.git', repoId: 'r1', host: 'https://core.test', access: 'write' },
    state: 'up_to_date',
    headSha: 'a',
    remoteHeadSha: 'a',
    ahead: 0,
    behind: 0,
    changedFiles: 0,
    unshared: false,
    fetched: false,
    refusal: null,
    ...overrides
  }
}

function result(overrides: Partial<AgentShareResult> = {}): AgentShareResult {
  return { done: true, refusal: null, detail: null, status: null, agentId: null, ...overrides }
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
    useTeamVersion: vi.fn()
  }
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

/** Mount with the statuses list already loaded, as the sidebar leaves it. */
function mount(listed: AgentShareStatus[], onNote = vi.fn()): { client: QueryClient; onNote: typeof onNote } {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } })
  client.setQueryData(sharingStatusesKey(null), listed)
  sharing.statuses.mockResolvedValue(ok(listed))
  render(createElement(QueryClientProvider, { client }, createElement(AgentShareLine, { agentId: AGENT, onNote })))
  return { client, onNote }
}

function line(): HTMLElement | null {
  return document.querySelector('[data-share-line]')
}

function sentence(): string {
  return (line()?.querySelector('[role="status"], [role="alert"]')?.textContent ?? '').trim()
}

describe('AgentShareLine — the slot', () => {
  it('is there at first paint for a shared agent, before its own status lands', () => {
    mount([status()])
    expect(line()).not.toBeNull()
    expect(sentence()).toBe(SHARE_STATE_TEXT.up_to_date(status()))
  })

  it('is absent for an agent that is not shared', () => {
    mount([status({ agentId: 'folder:other' })])
    expect(line()).toBeNull()
    expect(sharing.status).not.toHaveBeenCalled()
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

describe('AgentShareLine — across a profile switch', () => {
  it('re-reads the agent’s status under the new account instead of keeping the last one’s', async () => {
    sharing.status.mockResolvedValue(ok(status({ state: 'unshared', unshared: true, changedFiles: 1 })))
    mount([status()])
    await waitFor(() => expect(sentence()).toBe(SHARE_STATE_TEXT.unshared(status({ changedFiles: 1 }))))
    expect(sharing.status).toHaveBeenCalledTimes(1)

    sharing.status.mockResolvedValue(ok(status({ state: 'other_account' })))
    act(() =>
      useAuthStore.setState({
        currentUser: { id: 'p2', type: 'cinna_user', username: 'b', displayName: 'B', hasPassword: false } as never
      })
    )
    await waitFor(() => expect(sentence()).toBe(SHARE_STATE_TEXT.other_account(status())))
    expect(sharing.status).toHaveBeenCalledTimes(2)
  })
})

describe('AgentShareLine — what it says', () => {
  it.each<[string, Partial<AgentShareStatus>]>([
    ['up_to_date', {}],
    ['unshared', { state: 'unshared', unshared: true, changedFiles: 3 }],
    ['behind', { state: 'behind', behind: -1 }],
    ['diverged', { state: 'diverged', ahead: 1, behind: 2, unshared: true }],
    ['removed', { state: 'removed' }],
    ['other_account', { state: 'other_account' }]
  ])('%s → its state sentence', (state, overrides) => {
    const s = status(overrides)
    mount([s])
    expect(sentence()).toBe(SHARE_STATE_TEXT[state as AgentShareStatus['state']](s))
  })

  it('counts unshared changes', () => {
    expect(SHARE_STATE_TEXT.unshared(status({ changedFiles: 1 }))).toMatch(/^1 change /)
    expect(SHARE_STATE_TEXT.unshared(status({ changedFiles: 2 }))).toMatch(/^2 changes /)
  })

  it('a failed read shows its refusal instead of the state', () => {
    mount([status({ refusal: 'fetch_failed' })])
    expect(sentence()).toBe(SHARE_REFUSAL_TEXT.fetch_failed)
  })

  it('switches to the agent’s own status once it lands, in the same slot', async () => {
    sharing.status.mockResolvedValue(ok(status({ state: 'behind', behind: 2 })))
    mount([status()])
    await waitFor(() => expect(sentence()).toBe(SHARE_STATE_TEXT.behind(status())))
  })
})

describe('AgentShareLine — which buttons', () => {
  const buttons = (): string[] =>
    Array.from(line()?.querySelectorAll('button') ?? []).map((b) => b.textContent ?? '')

  it.each<[string, Partial<AgentShareStatus>, string[]]>([
    ['up to date', {}, []],
    ['team moved', { state: 'behind', behind: -1 }, [SHARE_UI_TEXT.update]],
    ['unshared', { state: 'unshared', unshared: true, changedFiles: 1 }, [SHARE_UI_TEXT.shareChanges]],
    ['behind with local edits', { state: 'behind', behind: 1, unshared: true, changedFiles: 1 }, [SHARE_UI_TEXT.update, SHARE_UI_TEXT.shareChanges]],
    ['diverged', { state: 'diverged', behind: 1, ahead: 1, unshared: true }, [SHARE_UI_TEXT.shareChanges]],
    ['read-only access', { state: 'unshared', unshared: true, changedFiles: 1, remote: { kind: 'cinna', url: 'u', repoId: 'r', host: 'h', access: 'read' } }, []],
    ['external, unknown access', { state: 'unshared', unshared: true, changedFiles: 1, remote: { kind: 'external', url: 'u', repoId: null, host: null, access: null } }, [SHARE_UI_TEXT.shareChanges]],
    ['removed', { state: 'removed', behind: -1, unshared: true }, []],
    ['other account', { state: 'other_account', behind: -1, unshared: true }, []]
  ])('%s', (_label, overrides, expected) => {
    mount([status(overrides)])
    expect(buttons()).toEqual(expected)
  })
})

describe('AgentShareLine — Update', () => {
  it('a dirty refusal says to share first, on the line', async () => {
    sharing.update.mockResolvedValue(ok(result({ done: false, refusal: 'dirty' })))
    mount([status({ state: 'behind', behind: 1 })])
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: SHARE_UI_TEXT.update }))
    })
    expect(sentence()).toBe(SHARE_REFUSAL_TEXT.dirty)
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

describe('AgentShareLine — Share changes dialog', () => {
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

describe('AgentShareLine — the conflict dialog', () => {
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
