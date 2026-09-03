import { describe, it, expect, beforeEach, vi } from 'vitest'

/**
 * `agentStatusService`'s **folder branch** — the ordering and the failure
 * semantics, not the parsing.
 *
 * What STATUS.md turns into is `statusRefresh.test.ts`'s claim, against real
 * files and a real subprocess; this file mocks that module so the questions it
 * asks stay the ones only this layer can answer: does the folder leg run
 * *before* the two remote gates and the network fetch, does a remote failure
 * keep the folder rows, and does a refresh that genuinely failed reach the
 * caller instead of being swallowed. The seam between the two files — the exact
 * arguments `readFolderAgentSnapshot` is called with — is asserted here.
 */

const fetchMock = vi.hoisted(() => vi.fn())
vi.mock('electron', () => ({ net: { fetch: fetchMock } }))
vi.mock('../logger/logger', () => ({
  createLogger: () => ({ debug: () => {}, info: () => {}, warn: () => {}, error: () => {} })
}))

const users = vi.hoisted(() => ({ current: new Map<string, unknown>() }))
vi.mock('../db/users', () => ({
  userRepo: { get: (id: string) => users.current.get(id) ?? null }
}))

const agents = vi.hoisted(() => ({
  folder: [] as Array<{ id: string; name: string }>,
  owned: new Map<string, unknown>(),
  remote: [] as Array<{ id: string; name: string; remoteTargetId: string }>
}))
vi.mock('../db/agents', () => ({
  agentRepo: {
    listFolder: () => agents.folder,
    getOwned: (_userId: string, agentId: string) => agents.owned.get(agentId) ?? null,
    listRemote: () => agents.remote
  }
}))

const tokens = vi.hoisted(() => ({ impl: async () => 'tok' as string }))
vi.mock('../auth/cinna-tokens', () => ({ getCinnaAccessToken: () => tokens.impl() }))

const locateMock = vi.hoisted(() => vi.fn())
vi.mock('./localAgents/localAgentService', () => ({ localAgentService: { locate: locateMock } }))

const readSnapshotMock = vi.hoisted(() => vi.fn())
const runStatusRefreshMock = vi.hoisted(() => vi.fn())
vi.mock('./localAgents/statusRefresh', () => ({
  readFolderAgentSnapshot: readSnapshotMock,
  runStatusRefresh: runStatusRefreshMock
}))

const manifestMock = vi.hoisted(() => vi.fn())
vi.mock('../kit/manifestIo', () => ({
  manifestPath: (dir: string) => `${dir}/cinna-agent.json`,
  readManifest: manifestMock
}))

const { agentStatusService } = await import('./agentStatusService')
const { CinnaReauthRequired } = await import('../auth/cinna-oauth')
const { AgentStatusError } = await import('../errors')

const USER = 'u1'

function snapshot(agentId: string, over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    agentId,
    remoteAgentId: agentId,
    name: agentId,
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
    severityChangedAt: null,
    ...over
  }
}

/** A local-only account: `getCinnaContext` answers `null` for this one. */
function asLocalUser(): void {
  users.current.set(USER, { id: USER, type: 'local_user', cinnaServerUrl: null })
}

function asCinnaUser(): void {
  users.current.set(USER, {
    id: USER,
    type: 'cinna_user',
    cinnaServerUrl: 'https://cinna.example.com/'
  })
}

function withFolderAgent(id = 'folder:alpha', name = 'Alpha'): void {
  agents.folder = [{ id, name }]
  agents.owned.set(id, { id, name, source: 'folder', remoteTargetId: null })
  locateMock.mockImplementation((_u: string, agentId: string) => {
    if (agentId !== id) throw new Error('not found')
    return { root: { path: '/w' }, agentDir: `/w/Local/${name}` }
  })
}

beforeEach(() => {
  vi.clearAllMocks()
  users.current = new Map()
  agents.folder = []
  agents.owned = new Map()
  agents.remote = []
  tokens.impl = async () => 'tok'
  readSnapshotMock.mockImplementation((agentId: string) => snapshot(agentId))
  runStatusRefreshMock.mockResolvedValue({ ran: true, skipped: false, error: null })
  manifestMock.mockReturnValue({ status_refresh_command: '/run:status' })
})

describe('list — the folder leg is above both remote gates', () => {
  it('answers for a local-only account, which has no Cinna context at all', async () => {
    // The premise of the whole feature: a folder agent is chattable in seconds
    // with no server. `getCinnaContext` returns null for this user and the old
    // `if (!ctx) return []` made this surface permanently empty for them.
    asLocalUser()
    withFolderAgent()

    const result = await agentStatusService.list(USER)

    expect(result.items.map((i) => i.agentId)).toEqual(['folder:alpha'])
    expect(result.remoteError).toBeNull()
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('hands readFolderAgentSnapshot the row id, the row name, the root path and the agent dir', async () => {
    asLocalUser()
    withFolderAgent()
    await agentStatusService.list(USER)
    expect(readSnapshotMock).toHaveBeenCalledWith(
      'folder:alpha',
      'Alpha',
      '/w',
      '/w/Local/Alpha',
      expect.any(Date)
    )
  })

  it('stamps every row in one batch with the same fetch time', async () => {
    asLocalUser()
    agents.folder = [
      { id: 'folder:a', name: 'A' },
      { id: 'folder:b', name: 'B' }
    ]
    locateMock.mockReturnValue({ root: { path: '/w' }, agentDir: '/w/x' })
    await agentStatusService.list(USER)
    const [first, second] = readSnapshotMock.mock.calls.map((c) => c[4])
    expect(first).toBe(second)
  })

  it('omits a folder agent with no STATUS.md rather than listing a blank card', async () => {
    asLocalUser()
    withFolderAgent()
    readSnapshotMock.mockReturnValue(null)
    const result = await agentStatusService.list(USER)
    expect(result.items).toEqual([])
  })

  it('keeps the other agents when one folder cannot be located', async () => {
    asLocalUser()
    agents.folder = [
      { id: 'folder:broken', name: 'Broken' },
      { id: 'folder:good', name: 'Good' }
    ]
    locateMock.mockImplementation((_u: string, agentId: string) => {
      if (agentId === 'folder:broken') throw new Error('folder moved')
      return { root: { path: '/w' }, agentDir: '/w/good' }
    })
    const result = await agentStatusService.list(USER)
    expect(result.items.map((i) => i.agentId)).toEqual(['folder:good'])
  })

  it('never runs status_refresh_command on the polled path', async () => {
    // `list` is polled every 45s and fanned out by "Refresh all". Running a
    // command here would take the per-agent turn lock on a timer, so an editor
    // save and the user's next message would refuse for work nobody asked for.
    asLocalUser()
    withFolderAgent()
    await agentStatusService.list(USER)
    expect(runStatusRefreshMock).not.toHaveBeenCalled()
  })
})

describe('list — a remote failure must not take the folder rows down with it', () => {
  beforeEach(() => {
    asCinnaUser()
    withFolderAgent()
  })

  it('keeps the folder rows and reports the remote failure when the fetch throws', async () => {
    fetchMock.mockRejectedValue(new Error('ECONNREFUSED'))
    const result = await agentStatusService.list(USER)
    // Consequence first: the user's local agents are still on screen.
    expect(result.items.map((i) => i.agentId)).toEqual(['folder:alpha'])
    // And the remote leg's failure is reported, not swallowed — a cinna user's
    // remote agents going silently stale behind a healthy-looking panel is
    // worse than the blanking this replaces.
    expect(result.remoteError?.code).toBe('remote_unreachable')
  })

  it('keeps the folder rows on a non-OK response', async () => {
    fetchMock.mockResolvedValue({ ok: false, status: 500, statusText: 'Server Error' })
    const result = await agentStatusService.list(USER)
    expect(result.items.map((i) => i.agentId)).toEqual(['folder:alpha'])
    expect(result.remoteError?.code).toBe('remote_unreachable')
  })

  it('keeps the folder rows when the session has expired', async () => {
    // `CinnaReauthRequired` is thrown by `getCinnaAccessToken`, i.e. *before*
    // the fetch — so it would take the folder rows with it just as surely.
    tokens.impl = async () => {
      throw new CinnaReauthRequired('Session expired')
    }
    const result = await agentStatusService.list(USER)
    expect(result.items.map((i) => i.agentId)).toEqual(['folder:alpha'])
    // The code has to survive: the overlay and tray branch on it to show the
    // re-authenticate panel rather than a generic error.
    expect(result.remoteError?.code).toBe('reauth_required')
  })

  it('keeps the folder rows when a 200 carries a body that is not JSON', async () => {
    fetchMock.mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => {
        throw new SyntaxError('Unexpected token < in JSON')
      }
    })
    const result = await agentStatusService.list(USER)
    expect(result.items.map((i) => i.agentId)).toEqual(['folder:alpha'])
    expect(result.remoteError).not.toBeNull()
  })

  it('still throws when there are no folder rows to save', async () => {
    // Nothing to show and something failed: the error is the whole answer, and
    // degrading to an empty list would report "no agents" for a network fault.
    agents.folder = []
    fetchMock.mockRejectedValue(new Error('ECONNREFUSED'))
    await expect(agentStatusService.list(USER)).rejects.toBeInstanceOf(AgentStatusError)
  })

  it('merges both kinds when the remote leg succeeds', async () => {
    agents.remote = [{ id: 'a-remote', name: 'Remote', remoteTargetId: 'r1' }]
    fetchMock.mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({
        items: [{ agent_id: 'r1', severity: 'error', raw: 'x', summary: 'boom' }]
      })
    })
    const result = await agentStatusService.list(USER)
    expect(result.items.map((i) => i.agentId).sort()).toEqual(['a-remote', 'folder:alpha'])
    expect(result.remoteError).toBeNull()
  })
})

describe('get — the folder branch is above both gates', () => {
  it('answers for a local-only account', async () => {
    asLocalUser()
    withFolderAgent()
    const item = await agentStatusService.get(USER, 'folder:alpha', false)
    expect(item?.agentId).toBe('folder:alpha')
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('answers for a folder agent even on a cinna account, which has no remoteTargetId', async () => {
    // The seam-11 filter: `if (!agent.remoteTargetId) return null`. A folder
    // agent never has one, so a branch placed after it would be dead code.
    asCinnaUser()
    withFolderAgent()
    const item = await agentStatusService.get(USER, 'folder:alpha', false)
    expect(item?.agentId).toBe('folder:alpha')
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('does not run the refresh command unless asked', async () => {
    asLocalUser()
    withFolderAgent()
    await agentStatusService.get(USER, 'folder:alpha', false)
    expect(runStatusRefreshMock).not.toHaveBeenCalled()
  })

  it('runs the manifest’s status_refresh_command on a force refresh', async () => {
    asLocalUser()
    withFolderAgent()
    const item = await agentStatusService.get(USER, 'folder:alpha', true)
    expect(runStatusRefreshMock).toHaveBeenCalledWith(USER, 'folder:alpha', '/run:status')
    expect(item?.agentId).toBe('folder:alpha')
  })

  it('reads STATUS.md after running the command, not before', async () => {
    asLocalUser()
    withFolderAgent()
    const order: string[] = []
    runStatusRefreshMock.mockImplementation(async () => {
      order.push('refresh')
      return { ran: true, skipped: false, error: null }
    })
    readSnapshotMock.mockImplementation((agentId: string) => {
      order.push('read')
      return snapshot(agentId)
    })
    await agentStatusService.get(USER, 'folder:alpha', true)
    // Reading first would show the user the status the refresh just replaced.
    expect(order).toEqual(['refresh', 'read'])
  })

  it('surfaces a refresh that genuinely failed instead of flashing green', async () => {
    asLocalUser()
    withFolderAgent()
    runStatusRefreshMock.mockResolvedValue({ ran: false, skipped: false, error: 'exited with code 3' })
    await expect(agentStatusService.get(USER, 'folder:alpha', true)).rejects.toThrow(
      'exited with code 3'
    )
  })

  it('returns the on-disk snapshot when the agent was too busy to refresh', async () => {
    // The local equivalent of the remote 429 swallow: nothing ran, nothing
    // failed, and the user still gets a status.
    asLocalUser()
    withFolderAgent()
    runStatusRefreshMock.mockResolvedValue({ ran: false, skipped: true, error: null })
    const item = await agentStatusService.get(USER, 'folder:alpha', true)
    expect(item?.agentId).toBe('folder:alpha')
  })

  it('still returns a status when the manifest itself cannot be read', async () => {
    asLocalUser()
    withFolderAgent()
    manifestMock.mockImplementation(() => {
      throw new Error('manifest_unreadable')
    })
    const item = await agentStatusService.get(USER, 'folder:alpha', true)
    // An unreadable manifest is the agent page's finding to report; withholding
    // a STATUS.md that is sitting right there helps nobody.
    expect(item?.agentId).toBe('folder:alpha')
    expect(runStatusRefreshMock).toHaveBeenCalledWith(USER, 'folder:alpha', null)
  })

  it('returns null for a folder agent whose folder has gone', async () => {
    asLocalUser()
    withFolderAgent()
    locateMock.mockImplementation(() => {
      throw new Error('folder moved')
    })
    expect(await agentStatusService.get(USER, 'folder:alpha', false)).toBeNull()
  })

  it('leaves a remote agent on the remote path', async () => {
    asCinnaUser()
    agents.owned.set('a-remote', {
      id: 'a-remote',
      name: 'Remote',
      source: 'remote',
      remoteTargetId: 'r1'
    })
    fetchMock.mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ agent_id: 'r1', severity: 'ok', summary: 'fine' })
    })
    const item = await agentStatusService.get(USER, 'a-remote', false)
    expect(item?.remoteAgentId).toBe('r1')
    expect(readSnapshotMock).not.toHaveBeenCalled()
  })
})
