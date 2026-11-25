import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { GithubNeedDto, GithubStatusDto } from '../../../../shared/github'
import { useAuthStore } from '../../stores/auth.store'
import { useGithubNoticeStore } from '../../stores/githubNotice.store'
import { resetGithubFocusCheck } from '../../hooks/useGithub'
import { ComposerNoticePanel } from './ComposerNoticePanel'
import { GITHUB_CONTINUE_MESSAGE, useGithubNotices } from './composerGithubNotices'

/**
 * The composer's GitHub rows: one per need of the chat's agent, the device flow's states told in
 * the row, Allow access and × through main, and Continue once a need this chat showed has cleared.
 */

let status: GithubStatusDto
let changed: (() => void) | null = null
const api = {
  status: vi.fn(async () => ({ ok: true, value: status })),
  signIn: vi.fn(),
  cancelSignIn: vi.fn(async () => ({ ok: true, value: null })),
  dismiss: vi.fn(async () => ({ ok: true, value: null })),
  openInstall: vi.fn(async () => ({ ok: true, value: null })),
  checkAgain: vi.fn(async () => ({ ok: true, value: status })),
  onChanged: (fn: () => void) => { changed = fn; return () => { changed = null } }
}
const writeText = vi.fn(async (_text: string) => ({ success: true }))
let queryClient: QueryClient

const need = (over: Partial<GithubNeedDto> = {}): GithubNeedDto => ({ key: 'account', kind: 'sign_in', agentIds: ['agent-1'], ...over })
const signedOut = (needs: GithubNeedDto[], device: GithubStatusDto['device'] = null): GithubStatusDto => ({ account: null, device, needs })
const connected = (needs: GithubNeedDto[] = []): GithubStatusDto => ({ account: { login: 'evgeny-l', state: 'connected', coverage: [], coverageFetchedAt: 1 }, device: null, needs })

function Harness({ chatId, agentId, send }: { chatId: string | null; agentId: string | null; send: (text: string) => Promise<boolean> }): React.JSX.Element {
  const notices = useGithubNotices(chatId, agentId, send)
  return <ComposerNoticePanel notices={notices} />
}

function show(props: Partial<React.ComponentProps<typeof Harness>> = {}) {
  const send = props.send ?? vi.fn(async () => true)
  const view = render(<QueryClientProvider client={queryClient}><Harness chatId="chat-1" agentId="agent-1" {...props} send={send} /></QueryClientProvider>)
  return { ...view, send }
}

/** Main changed something: the next status, then the push. */
async function push(next: GithubStatusDto): Promise<void> {
  status = next
  const reads = api.status.mock.calls.length
  await act(async () => { changed?.() })
  // Read again, and drawn: a row that must not appear has had its chance to.
  await waitFor(() => expect(api.status.mock.calls.length).toBeGreaterThan(reads))
  await waitFor(() => expect(queryClient.getQueryData(['github', 'status', 'alice'])).toEqual(next))
  await act(async () => {})
}

beforeEach(() => {
  vi.clearAllMocks()
  resetGithubFocusCheck()
  queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  useAuthStore.getState().setCurrentUser({ id: 'alice', type: 'cinna_user', username: 'alice', displayName: 'Alice', hasPassword: false, cinnaServerUrl: 'https://core.test' })
  useGithubNoticeStore.setState({ seen: {}, resolved: {} })
  window.api = { github: api, clipboard: { writeText } } as unknown as typeof window.api
})
afterEach(() => { queryClient.clear(); useAuthStore.getState().setCurrentUser(null) })

describe('a row per need', () => {
  it('asks to sign in', async () => {
    status = signedOut([need()])
    show()
    expect(await screen.findByText('GitHub isn’t connected.')).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Sign in to GitHub' })).toBeTruthy()
  })
  it('asks to reconnect an expired sign-in', async () => {
    status = { ...connected([need({ kind: 'reconnect' })]), account: { login: 'evgeny-l', state: 'expired', coverage: [], coverageFetchedAt: null } }
    show()
    expect(await screen.findByText('The GitHub sign-in expired.')).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Reconnect GitHub' })).toBeTruthy()
  })
  it('asks to allow access to the repositories, and opens the stored install page through main', async () => {
    status = connected([need({ key: 'install:acme', kind: 'install', owner: 'acme', repos: ['acme/shop', 'acme/site'], installUrl: 'https://github.com/apps/opencinna/installations/new' })])
    show()
    const line = await screen.findByText('Cinna’s GitHub app can’t reach acme/shop, acme/site yet.')
    expect(line.getAttribute('title')).toContain('acme/shop, acme/site')
    fireEvent.click(screen.getByRole('button', { name: 'Allow access' }))
    expect(api.openInstall).toHaveBeenCalledWith('install:acme')
  })
  it('keeps a refused Allow access in the row', async () => {
    status = connected([need({ key: 'install:acme', kind: 'install', owner: 'acme', repos: ['acme/shop'] })])
    api.openInstall.mockResolvedValueOnce({ ok: false, error: 'Couldn’t open your browser.' } as never)
    show()
    fireEvent.click(await screen.findByRole('button', { name: 'Allow access' }))
    expect(await screen.findByText('Couldn’t open your browser.')).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Allow access' })).toBeTruthy()
  })
  it('shows nothing for the admin kind P1 never produces', async () => {
    status = connected([need({ key: 'install:acme', kind: 'admin', owner: 'acme' })])
    show()
    await waitFor(() => expect(api.status).toHaveBeenCalled())
    expect(screen.queryByRole('status')).toBeNull()
  })
})

describe('which chats show it', () => {
  it('only a chat whose agent is in the need’s agents', async () => {
    status = signedOut([need({ agentIds: ['agent-2'] })])
    show()
    await waitFor(() => expect(api.status).toHaveBeenCalled())
    await act(async () => {})
    expect(screen.queryByText('GitHub isn’t connected.')).toBeNull()
  })
  it('not the new-chat screen', async () => {
    status = signedOut([need()])
    show({ chatId: null })
    await act(async () => {})
    expect(screen.queryByText('GitHub isn’t connected.')).toBeNull()
  })
})

describe('the device flow in the row', () => {
  it('copies the code on Sign in, then shows it with the wait and Cancel', async () => {
    status = signedOut([need()])
    api.signIn.mockImplementation(async () => {
      status = signedOut([need()], { userCode: 'ABCD-1234', verificationUri: 'https://github.com/login/device', expiresAt: 1, state: 'pending' })
      return { ok: true, value: status.device }
    })
    show()
    fireEvent.click(await screen.findByRole('button', { name: 'Sign in to GitHub' }))
    await waitFor(() => expect(writeText).toHaveBeenCalledWith('ABCD-1234'))
    expect(await screen.findByText('ABCD-1234')).toBeTruthy()
    expect(screen.getByTitle('Enter code ABCD-1234 on GitHub. Only enter a code Cinna shows you.')).toBeTruthy()
    expect(screen.getByText(/Only enter a code Cinna shows you\./)).toBeTruthy()
    expect(screen.getByText('Waiting for you to approve in the browser…')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'Copy code' }))
    await waitFor(() => expect(writeText).toHaveBeenCalledTimes(2))
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }))
    await waitFor(() => expect(api.cancelSignIn).toHaveBeenCalled())
  })
  it('offers a new code once the code expired', async () => {
    status = signedOut([need()], { userCode: 'ABCD-1234', verificationUri: 'https://github.com/login/device', expiresAt: 1, state: 'expired' })
    api.signIn.mockResolvedValue({ ok: true, value: { userCode: 'WXYZ-0000', verificationUri: 'https://github.com/login/device', expiresAt: 2, state: 'pending' } })
    show()
    expect(await screen.findByText('Code expired.')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'Get a new code' }))
    await waitFor(() => expect(api.signIn).toHaveBeenCalled())
  })
  it('says a declined sign-in and main’s error in the row, each with Sign in to GitHub', async () => {
    status = signedOut([need()], { userCode: 'A', verificationUri: 'https://github.com/login/device', expiresAt: 1, state: 'denied' })
    show()
    expect(await screen.findByText('Sign-in was declined.')).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Sign in to GitHub' })).toBeTruthy()
    await push(signedOut([need()], { userCode: 'A', verificationUri: 'https://github.com/login/device', expiresAt: 1, state: 'error', error: 'GitHub refused the sign-in (x). Try again.' }))
    expect(await screen.findByText('GitHub refused the sign-in (x). Try again.')).toBeTruthy()
  })
  it('keeps a start main refused in the row', async () => {
    status = signedOut([need()])
    api.signIn.mockResolvedValue({ ok: false, error: 'This profile is locked. Unlock it to sign in to GitHub.' })
    show()
    fireEvent.click(await screen.findByRole('button', { name: 'Sign in to GitHub' }))
    expect(await screen.findByText('This profile is locked. Unlock it to sign in to GitHub.')).toBeTruthy()
    expect(writeText).not.toHaveBeenCalled()
  })
})

describe('dismiss and resolve', () => {
  it('dismisses through main, and a dismissed need is not read as connected', async () => {
    status = connected([need({ key: 'install:acme', kind: 'install', owner: 'acme', repos: ['acme/shop'] })])
    show()
    fireEvent.click(await screen.findByRole('button', { name: 'Dismiss GitHub access request' }))
    expect(api.dismiss).toHaveBeenCalledWith('install:acme')
    await push(connected([]))
    expect(screen.queryByText('GitHub is connected.')).toBeNull()
  })
  it('turns a cleared need into Continue, which sends exactly the fixed message once', async () => {
    status = signedOut([need()])
    const { send } = show()
    await screen.findByText('GitHub isn’t connected.')
    await push(connected([]))
    expect(await screen.findByText('GitHub is connected.')).toBeTruthy()
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Continue' })) })
    expect(send).toHaveBeenCalledTimes(1)
    expect(send).toHaveBeenCalledWith('GitHub is connected, go on')
    expect(GITHUB_CONTINUE_MESSAGE).toBe('GitHub is connected, go on')
    await waitFor(() => expect(screen.queryByText('GitHub is connected.')).toBeNull())
  })
  it('× puts Continue away without sending', async () => {
    status = signedOut([need()])
    const { send } = show()
    await screen.findByText('GitHub isn’t connected.')
    await push(connected([]))
    fireEvent.click(await screen.findByRole('button', { name: 'Dismiss without sending' }))
    expect(send).not.toHaveBeenCalled()
    expect(screen.queryByText('GitHub is connected.')).toBeNull()
  })
  it('remembers a need this chat showed when it clears while the chat is away', async () => {
    status = signedOut([need()])
    const first = show()
    await screen.findByText('GitHub isn’t connected.')
    first.unmount()
    status = connected([])
    queryClient.clear()
    show()
    expect(await screen.findByText('GitHub is connected.')).toBeTruthy()
  })
  it('does not read a sign-out as connected', async () => {
    status = signedOut([need()])
    show()
    await screen.findByText('GitHub isn’t connected.')
    await push(signedOut([]))
    await act(async () => {})
    expect(screen.queryByText('GitHub is connected.')).toBeNull()
  })
})

describe('coverage on focus', () => {
  it('reads the installations again when the window regains focus, at most once per 10 s', async () => {
    status = connected([need({ key: 'install:acme', kind: 'install', owner: 'acme', repos: ['acme/shop'] })])
    show()
    await screen.findByRole('button', { name: 'Allow access' })
    act(() => { window.dispatchEvent(new Event('focus')) })
    act(() => { window.dispatchEvent(new Event('focus')) })
    expect(api.checkAgain).toHaveBeenCalledTimes(1)
  })
  it('does not without an install row', async () => {
    status = signedOut([need()])
    show()
    await screen.findByText('GitHub isn’t connected.')
    act(() => { window.dispatchEvent(new Event('focus')) })
    expect(api.checkAgain).not.toHaveBeenCalled()
  })
})
