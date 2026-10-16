import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { act, cleanup, render, waitFor } from '@testing-library/react'
import { createElement } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { AgentShareStatus } from '../../../shared/agentSharing'
import type { LocalAgentChangedPayload } from '../../../shared/localAgents'

/**
 * A folder edit is what makes a shared agent have something to share, and main
 * publishes `sharing:changed` only when a sharing action or a library read
 * settles. So the watcher's `local-agent:changed` has to re-read the open
 * status — without a fetch — or the badge keeps "Up to date" after an edit.
 */

const { resetSharingFetchClock, sharingStatusesKey, useDismissTeamChanges, useShareStatus, useShareStatuses, useSharingWatch } =
  await import('./useSharing')

const ALPHA = 'folder:alpha'
const BETA = 'folder:beta'
const ok = <T,>(value: T) => ({ success: true as const, value })

function status(agentId: string, overrides: Partial<AgentShareStatus> = {}): AgentShareStatus {
  return {
    agentId,
    remote: { kind: 'external', url: 'git@x:y.git', repoId: null, host: null, access: null },
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

let sharing: Record<string, ReturnType<typeof vi.fn>>
let pushFolderChange: (payload: LocalAgentChangedPayload) => void

beforeEach(() => {
  resetSharingFetchClock()
  sharing = {
    statuses: vi.fn().mockResolvedValue(ok([status(ALPHA)])),
    status: vi.fn(async (id: string) => ok(status(id))),
    onChanged: vi.fn(() => () => {})
  }
  ;(window as unknown as { api: unknown }).api = {
    sharing,
    localAgents: {
      onChanged: vi.fn((handler: (payload: LocalAgentChangedPayload) => void) => {
        pushFolderChange = handler
        return () => {}
      })
    }
  }
})

afterEach(() => {
  cleanup()
  vi.clearAllMocks()
})

function mount(): { client: QueryClient; seen: { alpha?: AgentShareStatus | null } } {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  const seen: { alpha?: AgentShareStatus | null } = {}
  function Page(): null {
    useSharingWatch()
    useShareStatuses()
    seen.alpha = useShareStatus(ALPHA, 'external').data
    return null
  }
  render(createElement(QueryClientProvider, { client }, createElement(Page)))
  return { client, seen }
}

describe('useSharingWatch — a folder change', () => {
  it('re-reads the edited agent’s status, without a fetch, and the badge sees the change', async () => {
    const { seen } = mount()
    await waitFor(() => expect(seen.alpha?.state).toBe('up_to_date'))
    // The mount read fetched (an external agent, first read in a minute).
    expect(sharing.status).toHaveBeenLastCalledWith(ALPHA, true)
    // Over a minute later, so the clock alone would let a fetch through.
    vi.spyOn(Date, 'now').mockReturnValue(Date.now() + 120_000)
    sharing.status.mockResolvedValue(ok(status(ALPHA, { state: 'unshared', changedFiles: 1, unshared: true })))
    const listReads = sharing.statuses.mock.calls.length
    await act(async () => pushFolderChange({ rootId: "r", agentId: ALPHA, reason: "watch" }))
    await waitFor(() => expect(seen.alpha?.state).toBe('unshared'))
    expect(sharing.status).toHaveBeenLastCalledWith(ALPHA, false)
    // A named agent's edit leaves the sidebar's list alone.
    expect(sharing.statuses.mock.calls.length).toBe(listReads)
    vi.restoreAllMocks()
  })

  it('leaves another agent’s status alone', async () => {
    mount()
    await waitFor(() => expect(sharing.status).toHaveBeenCalledTimes(1))
    await act(async () => pushFolderChange({ rootId: "r", agentId: BETA, reason: "watch" }))
    expect(sharing.status).toHaveBeenCalledTimes(1)
  })

  it('a root push re-reads every open status and the shared-agent list, still without a fetch', async () => {
    const { client } = mount()
    await waitFor(() => expect(sharing.status).toHaveBeenCalledTimes(1))
    await waitFor(() => expect(client.getQueryData(sharingStatusesKey(null))).toBeDefined())
    vi.spyOn(Date, 'now').mockReturnValue(Date.now() + 120_000)
    const listReads = sharing.statuses.mock.calls.length
    await act(async () => pushFolderChange({ rootId: "r", agentId: null, reason: "watch" }))
    await waitFor(() => expect(sharing.status).toHaveBeenCalledTimes(2))
    expect(sharing.status).toHaveBeenLastCalledWith(ALPHA, false)
    await waitFor(() => expect(sharing.statuses.mock.calls.length).toBe(listReads + 1))
    vi.restoreAllMocks()
  })

  it('a quiet read does not swallow the next real fetch', async () => {
    const { client } = mount()
    await waitFor(() => expect(sharing.status).toHaveBeenCalledTimes(1))
    const now = Date.now()
    vi.spyOn(Date, 'now').mockReturnValue(now + 120_000)
    await act(async () => pushFolderChange({ rootId: "r", agentId: ALPHA, reason: "watch" }))
    await waitFor(() => expect(sharing.status).toHaveBeenCalledTimes(2))
    await act(async () => {
      await client.invalidateQueries({ queryKey: ['sharing', 'status'] })
    })
    expect(sharing.status).toHaveBeenLastCalledWith(ALPHA, true)
    vi.restoreAllMocks()
  })
})

describe('an action’s result and the shared-agent list', () => {
  /**
   * Not now, then the agent opened again within a second: the page decides the
   * Bring together banner from the statuses list, so the entry has to carry
   * `teamChangesDeclined` the moment the dismiss resolves — before the list's
   * refetch lands, which here never does.
   */
  it('patches the list entry with the returned status at once, ahead of the refetch', async () => {
    const client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } })
    const diverged = status(ALPHA, { state: 'diverged', ahead: 1, behind: 1, changedFiles: 1, unshared: true })
    client.setQueryData(sharingStatusesKey(null), [diverged, status(BETA)])
    sharing.statuses.mockImplementation(() => new Promise(() => {}))
    sharing.dismissTeamChanges = vi.fn().mockResolvedValue(
      ok({ done: true, refusal: null, detail: null, status: { ...diverged, teamChangesDeclined: true }, agentId: ALPHA, autoAttached: [], setupNeeded: false })
    )
    let dismiss!: ReturnType<typeof useDismissTeamChanges>
    function Page(): null {
      dismiss = useDismissTeamChanges()
      return null
    }
    render(createElement(QueryClientProvider, { client }, createElement(Page)))
    await act(async () => {
      await dismiss.mutateAsync(ALPHA)
    })
    const list = client.getQueryData<AgentShareStatus[]>(sharingStatusesKey(null))
    expect(list?.find((entry) => entry.agentId === ALPHA)?.teamChangesDeclined).toBe(true)
    // The other entry is untouched, and the list is still marked for a re-read behind it.
    expect(list?.find((entry) => entry.agentId === BETA)).toEqual(status(BETA))
    expect(client.getQueryState(sharingStatusesKey(null))?.isInvalidated).toBe(true)
  })
})
