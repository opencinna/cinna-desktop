import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { render, screen, waitFor, fireEvent } from '@testing-library/react'
import { createElement, type ReactNode } from 'react'
import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest'

/**
 * The overlay's failure layout.
 *
 * It rendered `error ? <error> : <list>` — the error **replaced** the grid. That
 * made two things impossible at once: a folder agent's status, which is read off
 * local disk and is unaffected by anything the Cinna leg does, could not survive
 * a remote failure; and even for a remote-only user a single transient poll
 * failure blanked a panel full of perfectly good cached snapshots. Both are the
 * same bug and both are fixed by deciding the *layout* on whether there is
 * anything left to look at.
 *
 * The constraint these tests exist to hold is that nothing got quieter. The
 * failure keeps its wording, its colour and its Re-authenticate button; only
 * where it sits changed, and only when there are rows to sit above.
 */

;(window as unknown as { api: Record<string, unknown> }).api = {
  app: { setTheme: async () => undefined }
}

const reauthMutate = vi.hoisted(() => vi.fn())
vi.mock('../../hooks/useAuth', () => ({
  useCinnaReauth: () => ({ mutateAsync: reauthMutate, isPending: false })
}))

const { AgentStatusOverlay } = await import('./AgentStatusOverlay')
const { useUIStore } = await import('../../stores/ui.store')
const { useAuthStore } = await import('../../stores/auth.store')

function wrapper({ children }: { children: ReactNode }): React.JSX.Element {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return createElement(QueryClientProvider, { client }, children)
}

/** A wrapper whose cache is pre-seeded, so a *failing* fetch has data to keep. */
function seededWrapper(items: unknown[]) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  // Backdated past the hook's 15s `staleTime`, so mounting really does refetch —
  // without that the seeded data is fresh, no fetch happens, and the test would
  // assert nothing.
  client.setQueryData(['agent-status'], { items, remoteError: null }, {
    updatedAt: Date.now() - 60_000
  })
  return ({ children }: { children: ReactNode }): React.JSX.Element =>
    createElement(QueryClientProvider, { client }, children)
}

const folderRow = {
  agentId: 'folder:alpha',
  remoteAgentId: 'folder:alpha',
  name: 'Alpha',
  environmentId: 'local',
  severity: 'warning',
  summary: '3 invoices without a PO number',
  reportedAt: '2026-09-02T10:15:00Z',
  reportedAtSource: 'frontmatter',
  fetchedAt: '2026-09-02T10:16:00Z',
  raw: null,
  body: '',
  hasStructuredMetadata: true,
  prevSeverity: null,
  severityChangedAt: null
}

let list: ReturnType<typeof vi.fn>
let get: ReturnType<typeof vi.fn>

function setApi(listResult: unknown, getResult?: unknown): void {
  list = vi.fn().mockResolvedValue(listResult)
  get = vi.fn().mockResolvedValue(getResult ?? { success: true, item: null })
  ;(window as unknown as { api: Record<string, unknown> }).api = {
    app: { setTheme: async () => undefined },
    agentStatus: { list, get }
  }
}

beforeEach(() => {
  useUIStore.setState({ agentStatusOpen: true, agentStatusDetailId: null } as never)
  useAuthStore.setState({
    currentUser: {
      id: 'u1',
      type: 'cinna_user',
      username: 'u',
      displayName: 'U',
      hasPassword: false,
      createdAt: new Date()
    }
  } as never)
  reauthMutate.mockResolvedValue({ success: true })
})

afterEach(() => {
  vi.clearAllMocks()
})

describe('AgentStatusOverlay — a remote failure with local rows to show', () => {
  it('keeps the folder agent on screen and still says the Cinna leg failed', async () => {
    setApi({
      success: true,
      items: [folderRow],
      remoteError: { code: 'remote_unreachable', message: 'Failed to reach Cinna backend' }
    })

    render(createElement(AgentStatusOverlay), { wrapper })

    // Consequence first: the row the failure did not invalidate is on screen.
    expect(await screen.findByText('Alpha')).toBeTruthy()
    expect(screen.getByText('3 invoices without a PO number')).toBeTruthy()
    // And the failure is not quieter than it was — same message, verbatim.
    expect(screen.getByText('Failed to reach Cinna backend')).toBeTruthy()
  })

  it('keeps the full-panel error when there is nothing the failure did not invalidate', async () => {
    setApi({ success: false, code: 'remote_unreachable', error: 'Failed to reach Cinna backend' })

    render(createElement(AgentStatusOverlay), { wrapper })

    expect(await screen.findByText('Failed to reach Cinna backend')).toBeTruthy()
    expect(screen.queryByText('No agents have reported status yet.')).toBeNull()
  })

  it('keeps a populated panel through a transient poll failure', async () => {
    // The pre-existing bug this repairs on the way past, remote agents included:
    // a *total* query failure — a throw, not a partial `remoteError` — used to
    // blank a grid full of good cached snapshots. The cache is seeded and the
    // fetch fails, which is exactly the shape of a 502 on the 45-second poll.
    setApi({ success: false, code: 'unknown', error: 'Status fetch failed: 502 Bad Gateway' })

    render(createElement(AgentStatusOverlay), { wrapper: seededWrapper([folderRow]) })

    // Wait for the failure to actually land first — asserting the row before
    // the fetch resolves proves nothing, because the seeded cache renders it
    // either way and the assertion passes against the layout it is meant to
    // rule out.
    await waitFor(() =>
      expect(screen.getByText('Status fetch failed: 502 Bad Gateway')).toBeTruthy()
    )
    // Consequence: the cached rows survived the failed poll.
    expect(screen.getByText('Alpha')).toBeTruthy()
  })

  it('offers Re-authenticate beside the rows when the session expired', async () => {
    setApi({
      success: true,
      items: [folderRow],
      remoteError: { code: 'reauth_required', message: 'Session expired' }
    })

    render(createElement(AgentStatusOverlay), { wrapper })

    expect(await screen.findByText('Alpha')).toBeTruthy()
    // The affordance survives the layout change — this is the one the strip
    // could most easily have dropped.
    expect(screen.getByRole('button', { name: /Re-authenticate/ })).toBeTruthy()
  })

  it('still takes the whole panel for an expired session with nothing else to show', async () => {
    setApi({ success: false, code: 'reauth_required', error: 'Session expired' })

    render(createElement(AgentStatusOverlay), { wrapper })

    expect(await screen.findByText(/Cinna session expired/)).toBeTruthy()
    expect(screen.getByRole('button', { name: /Re-authenticate/ })).toBeTruthy()
  })
})

describe('AgentStatusOverlay — the per-card Refresh', () => {
  it('says so when a refresh fails instead of just stopping the spinner', async () => {
    // This is where a folder agent's broken `status_refresh_command` lands. The
    // IPC resolves `{success:false}` rather than rejecting (error codes do not
    // survive a thrown invoke), and the only consumer was an `onSuccess` that
    // early-returned on it.
    setApi({ success: true, items: [folderRow], remoteError: null }, {
      success: false,
      code: 'unknown',
      error: '"uv run scripts/update_status.py" exited with code 3.'
    })

    render(createElement(AgentStatusOverlay), { wrapper })
    expect(await screen.findByText('Alpha')).toBeTruthy()

    fireEvent.click(screen.getAllByTitle(/status refresh command/i)[0])

    expect(
      await screen.findByText('"uv run scripts/update_status.py" exited with code 3.')
    ).toBeTruthy()
    // The row it failed to refresh is still there — a failed refresh does not
    // cost the user the status they already had.
    expect(screen.getByText('Alpha')).toBeTruthy()
  })

  /**
   * The differential pair. This test and the grid one above it differ in
   * **exactly one line** — `agentStatusDetailId` — and that is the point: the
   * per-agent error was rendered inside the grid branch of
   * `{detail ? <DetailView/> : <>…</>}`, so the grid test passed while the
   * detail view, wired to the same mutation, said nothing at all.
   *
   * Detail is not the obscure half of that pair. `useTrayActions.openStatusDetail`
   * sets `agentStatusDetailId` and opens the overlay *straight into* it, so the
   * tray — the surface people check instead of opening the app — is the shortest
   * path to the button that could not report a failure. Keep these two together:
   * either one alone stops being evidence of anything.
   */
  it('says so on the detail view too, which the tray opens straight into', async () => {
    setApi({ success: true, items: [folderRow], remoteError: null }, {
      success: false,
      code: 'unknown',
      error: '"uv run scripts/update_status.py" exited with code 3.'
    })
    useUIStore.setState({ agentStatusOpen: true, agentStatusDetailId: 'folder:alpha' } as never)

    render(createElement(AgentStatusOverlay), { wrapper })
    // Back to grid — DetailView's own control, so we know we are on it.
    expect(await screen.findByTitle('Back to grid')).toBeTruthy()

    fireEvent.click(screen.getAllByTitle(/status refresh command/i)[0])

    // Mechanism first here, unusually: without it a missing error message is
    // ambiguous between "not rendered" and "the refresh never ran".
    await waitFor(() =>
      expect(get).toHaveBeenCalledWith({ agentId: 'folder:alpha', forceRefresh: true })
    )
    expect(
      await screen.findByText('"uv run scripts/update_status.py" exited with code 3.')
    ).toBeTruthy()
  })

  it('keeps one card’s spinner on while another card is refreshed', async () => {
    // The shared-mutation bug: `forceRefresh.variables` names only the most
    // recent call, so starting B stopped A's spinner and re-enabled A's button
    // mid-flight — which invites a second click that the turn lock refuses,
    // swallows as `busy`, and reports as success.
    const rows = [folderRow, { ...folderRow, agentId: 'folder:beta', name: 'Beta' }]
    setApi({ success: true, items: rows, remoteError: null })
    let settleA: (v: unknown) => void = () => {}
    get.mockImplementation((args: { agentId: string }) =>
      args.agentId === 'folder:alpha'
        ? new Promise((resolve) => {
            settleA = resolve
          })
        : Promise.resolve({ success: true, item: rows[1] })
    )

    render(createElement(AgentStatusOverlay), { wrapper })
    expect(await screen.findByText('Alpha')).toBeTruthy()

    const buttons = screen.getAllByTitle(/status refresh command/i)
    fireEvent.click(buttons[0])
    await waitFor(() => expect((buttons[0] as HTMLButtonElement).disabled).toBe(true))

    // Refresh the *other* card while the first is still in flight.
    fireEvent.click(buttons[1])
    await waitFor(() => expect(get).toHaveBeenCalledTimes(2))

    // The consequence: A is still shown as refreshing, because it still is.
    expect((buttons[0] as HTMLButtonElement).disabled).toBe(true)

    settleA({ success: true, item: rows[0] })
    await waitFor(() => expect((buttons[0] as HTMLButtonElement).disabled).toBe(false))
  })

  it('will not start a second run on an agent that is already refreshing', async () => {
    // Named for what it actually proves. An earlier version of this test clicked
    // twice and asserted one call — and the `if (refreshingIds.has(agentId))
    // return` guard **survived being deleted**, because `disabled={refreshing}`
    // already swallows the second click, so the test could not distinguish the
    // guard from its absence. What is observable, and what actually stops the
    // second run, is the button going disabled; the guard is a second mechanism
    // behind it (see the note in `AgentStatusOverlay.tsx`).
    setApi({ success: true, items: [folderRow], remoteError: null })
    get.mockImplementation(() => new Promise(() => {}))

    render(createElement(AgentStatusOverlay), { wrapper })
    expect(await screen.findByText('Alpha')).toBeTruthy()

    const button = screen.getAllByTitle(/status refresh command/i)[0] as HTMLButtonElement
    fireEvent.click(button)
    // A second run would be refused by the agent's turn lock, swallowed as
    // `busy`, and returned as `{success: true}` — a click that looks like it
    // worked and did nothing. The button is what prevents it.
    await waitFor(() => expect(button.disabled).toBe(true))
    fireEvent.click(button)
    expect(get).toHaveBeenCalledTimes(1)
  })

  it('says nothing when a refresh succeeds', async () => {
    setApi({ success: true, items: [folderRow], remoteError: null }, {
      success: true,
      item: folderRow
    })

    render(createElement(AgentStatusOverlay), { wrapper })
    expect(await screen.findByText('Alpha')).toBeTruthy()

    fireEvent.click(screen.getAllByTitle(/status refresh command/i)[0])

    await waitFor(() => expect(get).toHaveBeenCalled())
    expect(screen.queryByText(/Could not refresh/)).toBeNull()
  })
})
