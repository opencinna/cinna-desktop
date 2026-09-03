import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { renderHook, waitFor, act } from '@testing-library/react'
import { createElement, type ReactNode } from 'react'
import { describe, expect, it, vi, afterEach, beforeEach } from 'vitest'
import {
  useAgentStatus,
  useForceRefreshAgentStatus,
  useForceRefreshAllAgentStatuses,
  useRereadAgentStatus
} from './useAgentStatus'
import { useAuthStore } from '../stores/auth.store'

/**
 * The renderer-side gate that decided, for the whole of Phases 1–7a, whether a
 * folder agent's status could reach the screen at all.
 *
 * `useAgentStatus` was `enabled: currentUser?.type === 'cinna_user'`, with
 * `refetchInterval` off entirely when disabled. Every surface in this feature —
 * the status overlay, the sidebar-footer button, the menu-bar tray icon
 * (`useTrayIcon`) and the tray popup (`TrayPanel`) — reads this one hook, so no
 * amount of correctness in `agentStatusService`'s folder branch could be seen by
 * a user with no Cinna account: the IPC call was never issued.
 *
 * The account-type gate is the assertion here, not the query plumbing.
 */

function wrapper({ children }: { children: ReactNode }): React.JSX.Element {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } }
  })
  return createElement(QueryClientProvider, { client }, children)
}

interface StatusApi {
  list: ReturnType<typeof vi.fn>
  get: ReturnType<typeof vi.fn>
}

function stubApi(over: Partial<StatusApi> = {}): StatusApi {
  const api: StatusApi = {
    list: vi.fn().mockResolvedValue({ success: true, items: [], remoteError: null }),
    get: vi.fn().mockResolvedValue({ success: true, item: null }),
    ...over
  }
  ;(window as unknown as { api: { agentStatus: StatusApi } }).api = { agentStatus: api }
  return api
}

function signInAs(type: 'local_user' | 'cinna_user'): void {
  useAuthStore.setState({
    currentUser: {
      id: 'u1',
      type,
      username: 'u',
      displayName: 'U',
      hasPassword: false,
      createdAt: new Date()
    }
  } as never)
}

beforeEach(() => {
  useAuthStore.setState({ currentUser: null } as never)
})

afterEach(() => {
  vi.restoreAllMocks()
})

describe('useAgentStatus — the account gate', () => {
  const folderSnapshot = {
    agentId: 'folder:alpha',
    remoteAgentId: 'folder:alpha',
    name: 'Alpha',
    environmentId: 'local',
    severity: 'warning',
    summary: '3 invoices without a PO number',
    reportedAt: null,
    reportedAtSource: null,
    fetchedAt: null,
    raw: null,
    body: '',
    hasStructuredMetadata: true,
    prevSeverity: null,
    severityChangedAt: null
  }

  it('reaches a purely local account, which is the whole premise of folder agents', async () => {
    signInAs('local_user')
    const api = stubApi({
      list: vi.fn().mockResolvedValue({ success: true, items: [folderSnapshot], remoteError: null })
    })

    const { result } = renderHook(() => useAgentStatus(), { wrapper })

    // Consequence first: the folder agent's status is on screen.
    await waitFor(() => expect(result.current.data).toHaveLength(1))
    expect(result.current.data[0]?.summary).toBe('3 invoices without a PO number')
    // Mechanism: the IPC call was issued at all, which the old gate prevented.
    expect(api.list).toHaveBeenCalled()
  })

  it('reaches an account that is not signed in yet', async () => {
    // `currentUser` is null on first paint, before the profile resolves. The old
    // gate made that a permanently-disabled query rather than a pending one.
    stubApi({
      list: vi.fn().mockResolvedValue({ success: true, items: [folderSnapshot], remoteError: null })
    })
    const { result } = renderHook(() => useAgentStatus(), { wrapper })
    await waitFor(() => expect(result.current.data).toHaveLength(1))
  })

  it('still serves a cinna account', async () => {
    signInAs('cinna_user')
    const api = stubApi()
    renderHook(() => useAgentStatus(), { wrapper })
    await waitFor(() => expect(api.list).toHaveBeenCalled())
  })

  it('surfaces a typed failure code rather than a bare Error', async () => {
    signInAs('local_user')
    stubApi({
      list: vi
        .fn()
        .mockResolvedValue({ success: false, code: 'reauth_required', error: 'Session expired' })
    })
    const { result } = renderHook(() => useAgentStatus(), { wrapper })
    // The overlay and the tray both branch on this code to show the
    // re-authenticate panel instead of a generic error string.
    await waitFor(() => expect(result.current.error?.code).toBe('reauth_required'))
  })
})

describe('a rejection is never rendered as health', () => {
  it('surfaces an invoke that rejects with a plain Error', async () => {
    // `userActivation.requireActivated()` throws a plain `Error`, `ipcHandle`
    // re-throws, and the code is discarded at two IPC boundaries — so the
    // renderer sees an `Error` that is neither an `AgentStatusRequestError` nor
    // a partial failure. That combination used to produce `error: null` with
    // `data: []`, which the overlay and the tray both print as "No agents have
    // reported status yet." An inactive session shown as a clean panel.
    signInAs('local_user')
    stubApi({
      list: vi.fn().mockRejectedValue(
        new Error(
          "Error invoking remote method 'agent-status:list': Error: Session not activated"
        )
      )
    })

    const { result } = renderHook(() => useAgentStatus(), { wrapper })

    // The consequence: something is reported at all.
    await waitFor(() => expect(result.current.error).not.toBeNull())
    expect(result.current.error?.message).toContain('Session not activated')
    expect(result.current.data).toEqual([])
  })

  it('surfaces a rejection that is not an Error at all', async () => {
    signInAs('local_user')
    stubApi({ list: vi.fn().mockRejectedValue('something threw a string') })
    const { result } = renderHook(() => useAgentStatus(), { wrapper })
    await waitFor(() => expect(result.current.error).not.toBeNull())
    expect(result.current.error?.message).toContain('something threw a string')
  })

  it('still reports nothing when nothing went wrong', async () => {
    // The other half: the catch-all must not manufacture an error from a clean
    // empty result, or every account with no agents sees a failure.
    signInAs('local_user')
    stubApi()
    const { result } = renderHook(() => useAgentStatus(), { wrapper })
    await waitFor(() => expect(result.current.isLoading).toBe(false))
    expect(result.current.error).toBeNull()
    expect(result.current.data).toEqual([])
  })
})

describe('a partial failure is raised, not swallowed', () => {
  const folderRow = {
    agentId: 'folder:alpha',
    remoteAgentId: 'folder:alpha',
    name: 'Alpha',
    environmentId: 'local',
    severity: 'ok',
    summary: 'fine',
    reportedAt: null,
    reportedAtSource: null,
    fetchedAt: null,
    raw: null,
    body: '',
    hasStructuredMetadata: true,
    prevSeverity: null,
    severityChangedAt: null
  }

  it('hands back the folder rows AND the remote failure at the same time', async () => {
    stubApi({
      list: vi.fn().mockResolvedValue({
        success: true,
        items: [folderRow],
        remoteError: { code: 'remote_unreachable', message: 'Failed to reach Cinna backend' }
      })
    })
    const { result } = renderHook(() => useAgentStatus(), { wrapper })

    // Both at once is the whole point: rows to show, and a failure to report.
    await waitFor(() => expect(result.current.data).toHaveLength(1))
    expect(result.current.error?.message).toBe('Failed to reach Cinna backend')
    // The code has to survive, or the re-authenticate panel never fires.
    expect(result.current.error?.code).toBe('remote_unreachable')
  })

  it('reports no error when the remote leg was fine', async () => {
    stubApi({
      list: vi
        .fn()
        .mockResolvedValue({ success: true, items: [folderRow], remoteError: null })
    })
    const { result } = renderHook(() => useAgentStatus(), { wrapper })
    await waitFor(() => expect(result.current.data).toHaveLength(1))
    expect(result.current.error).toBeNull()
  })
})

describe('Refresh all asks the two agent kinds different questions', () => {
  it('force-refreshes a remote agent and only re-reads a folder agent', async () => {
    const api = stubApi()
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
    client.setQueryData(['agent-status'], {
      items: [{ agentId: 'folder:alpha' }, { agentId: 'a-remote' }],
      remoteError: null
    })
    const seeded = ({ children }: { children: ReactNode }): React.JSX.Element =>
      createElement(QueryClientProvider, { client }, children)

    const { result } = renderHook(() => useForceRefreshAllAgentStatuses(), { wrapper: seeded })
    await act(async () => {
      await result.current.mutateAsync()
    })

    // A menu-bar click must not start every folder agent's status script at
    // once: for a folder agent `forceRefresh` spawns a subprocess under that
    // agent's turn lock, which then refuses its chat and its editor saves.
    expect(api.get).toHaveBeenCalledWith({ agentId: 'folder:alpha', forceRefresh: false })
    // For a remote agent it is the only way past the server-side cache.
    expect(api.get).toHaveBeenCalledWith({ agentId: 'a-remote', forceRefresh: true })
  })
})

describe('the two per-agent fetches are not the same request', () => {
  it('useForceRefreshAgentStatus asks for a force refresh', async () => {
    const api = stubApi()
    const { result } = renderHook(() => useForceRefreshAgentStatus(), { wrapper })
    await act(async () => {
      await result.current.mutateAsync('folder:alpha')
    })
    expect(api.get).toHaveBeenCalledWith({ agentId: 'folder:alpha', forceRefresh: true })
  })

  it('useRereadAgentStatus does not', async () => {
    // For a folder agent `forceRefresh: true` spawns `status_refresh_command`
    // under the agent's turn lock. This one is a disk read.
    const api = stubApi()
    const { result } = renderHook(() => useRereadAgentStatus(), { wrapper })
    await act(async () => {
      await result.current.mutateAsync('folder:alpha')
    })
    expect(api.get).toHaveBeenCalledWith({ agentId: 'folder:alpha', forceRefresh: false })
  })
})
