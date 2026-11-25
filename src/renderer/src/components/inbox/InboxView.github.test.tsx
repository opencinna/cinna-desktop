import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { createElement, type ReactNode } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { InboxSnapshot, GithubNeedInboxItem } from '../../../../shared/inbox'
import type { GithubNeedDto, GithubStatusDto } from '../../../../shared/github'

/**
 * A GitHub need a run with no chat hit (a kit command, a scheduled run): a card in the Inbox
 * naming the agent, with the composer row's own action — Sign in to GitHub and its device-flow
 * states, Reconnect GitHub, Allow access — and Dismiss, which dismisses the need in main.
 */

const listMock = vi.fn<() => Promise<InboxSnapshot>>()
let status: GithubStatusDto
/** Every `github:changed` listener (the card's status and the Inbox list both listen). */
const listeners = new Set<() => void>()
const changed = (): void => { for (const fn of listeners) fn() }
const github = {
  status: vi.fn(async () => ({ ok: true, value: status })),
  signIn: vi.fn(),
  cancelSignIn: vi.fn(async () => ({ ok: true, value: null })),
  dismiss: vi.fn(async (_key: string) => ({ ok: true, value: null }) as { ok: boolean; value?: null; error?: string }),
  openInstall: vi.fn(async (_key: string) => ({ ok: true, value: null }) as { ok: boolean; value?: null; error?: string }),
  checkAgain: vi.fn(async () => ({ ok: true, value: status })),
  onChanged: (fn: () => void) => { listeners.add(fn); return () => { listeners.delete(fn) } }
}

;(window as unknown as { api: Record<string, unknown> }).api = {
  app: { setTheme: async () => undefined },
  inbox: { list: () => listMock(), answer: vi.fn() },
  github,
  clipboard: { writeText: vi.fn(async () => ({ success: true })) },
  tasks: { list: async () => [] },
  agents: {
    list: async () => [{ id: 'folder:repo', name: 'Repo Agent' }],
    syncRemote: async () => ({ success: true }),
    onRemoteSyncComplete: () => () => {},
    onReadinessChanged: () => () => {}
  }
}

const { InboxView } = await import('./InboxView')
const { useUIStore } = await import('../../stores/ui.store')
const { useAuthStore } = await import('../../stores/auth.store')
const { GITHUB_INBOX_TEXT } = await import('./InboxGithubCard')

const ACCOUNT: GithubNeedDto = { key: 'account', kind: 'sign_in', agentIds: ['folder:repo'], chatlessAgentIds: ['folder:repo'] }
const INSTALL: GithubNeedDto = {
  key: 'install:acme', kind: 'install', owner: 'acme', repos: ['acme/shop', 'acme/site'],
  installUrl: 'https://github.com/organizations/acme/settings/installations/7', agentIds: ['folder:repo'], chatlessAgentIds: ['folder:repo']
}
const item = (need: GithubNeedDto, agents = [{ id: 'folder:repo', name: 'Repo Agent' }]): GithubNeedInboxItem => ({ kind: 'github_need', need, agents })
const snapshot = (github: GithubNeedInboxItem[]): InboxSnapshot => ({ entries: [], unreadable: [], dispatch: [], updates: [], disconnected: [], github })
const signedOut = (needs: GithubNeedDto[]): GithubStatusDto => ({ account: null, device: null, needs, dismissed: [] })
const connected = (needs: GithubNeedDto[]): GithubStatusDto => ({ account: { login: 'octo', state: 'connected', coverage: [], coverageFetchedAt: 1 }, device: null, needs, dismissed: [] })

let client: QueryClient
function wrapper({ children }: { children: ReactNode }): React.JSX.Element {
  return createElement(QueryClientProvider, { client }, children)
}

async function open(items: GithubNeedInboxItem[], name: string): Promise<HTMLElement> {
  listMock.mockResolvedValue(snapshot(items))
  render(createElement(InboxView), { wrapper })
  return screen.findByRole('article', { name })
}

beforeEach(() => {
  client = new QueryClient({ defaultOptions: { queries: { retryDelay: 0 } } })
  vi.clearAllMocks()
  listMock.mockReset()
  useAuthStore.getState().setCurrentUser({ id: 'alice', type: 'cinna_user', username: 'alice', displayName: 'Alice', hasPassword: false, cinnaServerUrl: 'https://core.test' })
  useUIStore.setState({ activeView: 'inbox', activeLocalAgentId: null } as never)
})
afterEach(() => { client.clear(); useAuthStore.getState().setCurrentUser(null) })

describe('the GitHub card — a need a run with no chat hit', () => {
  it('says which agent is not connected, with the GitHub badge, Sign in to GitHub and Dismiss; the name opens its page', async () => {
    status = signedOut([ACCOUNT])
    const c = await open([item(ACCOUNT)], 'GitHub isn’t connected for Repo Agent')
    expect(within(c).getByText('A scheduled run or command stopped at gh or git, with no chat to ask you in.')).toBeTruthy()
    expect(within(c).getByText('GitHub')).toBeTruthy()
    expect(within(c).getAllByRole('button').map((b) => b.textContent)).toEqual(['Repo Agent', 'Sign in to GitHub', 'Dismiss'])
    fireEvent.click(within(c).getByRole('button', { name: 'Repo Agent' }))
    expect(useUIStore.getState().activeLocalAgentId).toBe('folder:repo')
  })

  it('reconnect and install are worded per kind; an install names its repositories', async () => {
    const reconnect = { ...ACCOUNT, kind: 'reconnect' as const }
    status = { ...connected([reconnect, INSTALL]), account: { login: 'octo', state: 'expired', coverage: [], coverageFetchedAt: null } }
    listMock.mockResolvedValue(snapshot([item(reconnect), item(INSTALL, [{ id: 'folder:repo', name: 'Repo Agent' }, { id: 'folder:site', name: 'Site Agent' }, { id: 'folder:x', name: 'X' }])]))
    render(createElement(InboxView), { wrapper })
    const expired = await screen.findByRole('article', { name: 'The GitHub sign-in expired for Repo Agent' })
    expect(within(expired).getByRole('button', { name: 'Reconnect GitHub' })).toBeTruthy()
    const install = screen.getByRole('article', { name: 'Cinna’s GitHub app can’t reach your repos for Repo Agent and 2 other agents' })
    expect(within(install).getByText('A scheduled run or command couldn’t reach acme/shop, acme/site on GitHub.')).toBeTruthy()
    expect(within(install).getByRole('button', { name: 'Allow access' })).toBeTruthy()
    // The first agent stays a link to its page.
    expect(within(install).getByRole('button', { name: 'Repo Agent' })).toBeTruthy()
  })

  it('Sign in to GitHub runs the device flow on the card: the code, the wait and Cancel; then GitHub is connected', async () => {
    status = signedOut([ACCOUNT])
    const c = await open([item(ACCOUNT)], 'GitHub isn’t connected for Repo Agent')
    const device = { userCode: 'WDJB-MJHT', verificationUri: 'https://github.com/login/device', expiresAt: Date.now() + 900_000, state: 'pending' as const }
    github.signIn.mockImplementation(async () => { status = { ...signedOut([ACCOUNT]), device }; return { ok: true, value: device } })
    await act(async () => { fireEvent.click(within(c).getByRole('button', { name: 'Sign in to GitHub' })) })
    await waitFor(() => expect(c.textContent).toContain('Enter code WDJB-MJHT on GitHub. Only enter a code Cinna shows you.'))
    expect(within(c).getByText(GITHUB_INBOX_TEXT.waiting)).toBeTruthy()
    expect(within(c).getByRole('button', { name: 'Cancel' })).toBeTruthy()
    // Approved in the browser: main clears the need, and the next read drops the item. The card stays, connected.
    status = connected([])
    listMock.mockResolvedValue(snapshot([]))
    await act(async () => { changed() })
    await waitFor(() => expect(within(c).getByRole('status').textContent).toBe('GitHub is connected. The agent’s next run can use it.'))
    expect(screen.getByRole('article', { name: 'GitHub isn’t connected for Repo Agent' })).toBe(c)
  })

  it('Allow access opens the stored install page through main, and keeps a refusal on the card', async () => {
    status = connected([INSTALL])
    const c = await open([item(INSTALL)], 'Cinna’s GitHub app can’t reach your repos for Repo Agent')
    github.openInstall.mockResolvedValueOnce({ ok: false, error: 'Couldn’t open GitHub.' })
    await act(async () => { fireEvent.click(within(c).getByRole('button', { name: 'Allow access' })) })
    expect(github.openInstall).toHaveBeenCalledWith('install:acme')
    await waitFor(() => expect(within(c).getByRole('alert').textContent).toBe('Couldn’t open GitHub.'))
    expect(within(c).getByRole('button', { name: 'Dismiss' })).toBeTruthy()
  })

  it('Dismiss dismisses the need in main and settles the card in place', async () => {
    status = signedOut([ACCOUNT])
    const c = await open([item(ACCOUNT)], 'GitHub isn’t connected for Repo Agent')
    status = { ...signedOut([]), dismissed: ['account'] }
    listMock.mockResolvedValue(snapshot([]))
    await act(async () => { fireEvent.click(within(c).getByRole('button', { name: 'Dismiss' })) })
    expect(github.dismiss).toHaveBeenCalledWith('account')
    expect(within(c).getByRole('status').textContent).toBe('Dismissed. It shows again if a run needs GitHub again.')
  })

  it('a refused Dismiss keeps the card and its buttons, and says so under them', async () => {
    status = signedOut([ACCOUNT])
    const c = await open([item(ACCOUNT)], 'GitHub isn’t connected for Repo Agent')
    github.dismiss.mockResolvedValueOnce({ ok: false, error: 'nope' })
    await act(async () => { fireEvent.click(within(c).getByRole('button', { name: 'Dismiss' })) })
    await waitFor(() => expect(within(c).getByRole('alert').textContent).toBe('The card could not be dismissed.'))
    expect(within(c).queryByRole('status')).toBeNull()
    expect(within(c).getByRole('button', { name: 'Sign in to GitHub' })).toBeTruthy()
  })

  it('install: once its repositories are covered, the card says Cinna can reach them', async () => {
    status = connected([INSTALL])
    const c = await open([item(INSTALL)], 'Cinna’s GitHub app can’t reach your repos for Repo Agent')
    await act(async () => { fireEvent.click(within(c).getByRole('button', { name: 'Allow access' })) })
    status = connected([])
    await act(async () => { changed() })
    await waitFor(() => expect(within(c).getByRole('status').textContent).toBe('Cinna can reach acme/shop, acme/site now.'))
  })

  it('a status read from before the need was recorded never reads as connected', async () => {
    // Main's status cache trails the Inbox: connected, with no need yet, while the snapshot has the item.
    status = connected([])
    const c = await open([item(INSTALL)], 'Cinna’s GitHub app can’t reach your repos for Repo Agent')
    await waitFor(() => expect(github.status).toHaveBeenCalled())
    await act(async () => {})
    await act(async () => { fireEvent.click(within(c).getByRole('button', { name: 'Allow access' })) })
    expect(within(c).queryByRole('status')).toBeNull()
    // The status catches up (the need is there), and only its later clearing reads as reachable.
    status = connected([INSTALL])
    await act(async () => { changed() })
    await waitFor(() => expect(client.getQueryData(['github', 'status', 'alice'])).toEqual(status))
    expect(within(c).queryByRole('status')).toBeNull()
    status = connected([])
    await act(async () => { changed() })
    await waitFor(() => expect(within(c).getByRole('status').textContent).toBe('Cinna can reach acme/shop, acme/site now.'))
  })

  it('several agents: their next runs', async () => {
    status = signedOut([ACCOUNT])
    const c = await open([item(ACCOUNT, [{ id: 'folder:repo', name: 'Repo Agent' }, { id: 'folder:site', name: 'Site Agent' }])], 'GitHub isn’t connected for Repo Agent and Site Agent')
    github.signIn.mockResolvedValue({ ok: true, value: { userCode: 'X', verificationUri: 'https://github.com/login/device', expiresAt: Date.now() + 1000, state: 'pending' } })
    await act(async () => { fireEvent.click(within(c).getByRole('button', { name: 'Sign in to GitHub' })) })
    status = connected([])
    await act(async () => { changed() })
    await waitFor(() => expect(within(c).getByRole('status').textContent).toBe('GitHub is connected. Their next runs can use it.'))
  })

  it('leaves with the next read when it cleared elsewhere and the user did not act on it', async () => {
    status = signedOut([ACCOUNT])
    await open([item(ACCOUNT)], 'GitHub isn’t connected for Repo Agent')
    status = connected([])
    listMock.mockResolvedValue(snapshot([]))
    await act(async () => { changed() })
    await waitFor(() => expect(screen.queryByRole('article', { name: 'GitHub isn’t connected for Repo Agent' })).toBeNull())
  })
})
