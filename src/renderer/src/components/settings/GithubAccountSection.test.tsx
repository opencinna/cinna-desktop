import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { GithubStatusDto } from '../../../../shared/github'
import { useAuthStore } from '../../stores/auth.store'
import { GithubAccountSection } from './GithubAccountSection'

/** Settings → User Accounts → GitHub: signed out, connected with its coverage, expired. */

let status: GithubStatusDto
const api = {
  status: vi.fn(async () => ({ ok: true, value: status })),
  signIn: vi.fn(),
  cancelSignIn: vi.fn(async () => ({ ok: true, value: null })),
  signOut: vi.fn(async () => ({ ok: true, value: null })),
  openUrl: vi.fn(async () => ({ ok: true, value: null })),
  onChanged: () => () => {}
}
const writeText = vi.fn(async () => ({ success: true }))
let queryClient: QueryClient

const account = (over: Partial<NonNullable<GithubStatusDto['account']>> = {}): NonNullable<GithubStatusDto['account']> => ({
  login: 'evgeny-l', state: 'connected', coverageFetchedAt: 1,
  coverage: [
    { installationId: 1, owner: 'acme', ownerType: 'Organization', ownerId: 10, selection: 'all', repos: [] },
    { installationId: 2, owner: 'evgeny-l', ownerType: 'User', ownerId: 11, selection: 'selected', repos: ['evgeny-l/shop', 'evgeny-l/site'] }
  ],
  ...over
})

function show() {
  return render(<QueryClientProvider client={queryClient}><GithubAccountSection /></QueryClientProvider>)
}

beforeEach(() => {
  vi.clearAllMocks()
  queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  useAuthStore.getState().setCurrentUser({ id: 'alice', type: 'cinna_user', username: 'alice', displayName: 'Alice', hasPassword: false, cinnaServerUrl: 'https://core.test' })
  window.api = { github: api, clipboard: { writeText } } as unknown as typeof window.api
})
afterEach(() => { queryClient.clear(); useAuthStore.getState().setCurrentUser(null) })

describe('GitHub section', () => {
  it('signed out: says what it is for and signs in with the device flow', async () => {
    status = { account: null, device: null, needs: [] }
    api.signIn.mockImplementation(async () => {
      status = { account: null, device: { userCode: 'ABCD-1234', verificationUri: 'https://github.com/login/device', expiresAt: 1, state: 'pending' }, needs: [] }
      return { ok: true, value: status.device }
    })
    show()
    expect(screen.getByRole('heading', { name: 'GitHub' })).toBeTruthy()
    expect(await screen.findByText('Lets this profile’s agents use gh and git on your GitHub repositories.')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'Sign in to GitHub' }))
    await waitFor(() => expect(writeText).toHaveBeenCalledWith('ABCD-1234'))
    expect(await screen.findByText('ABCD-1234')).toBeTruthy()
    expect(screen.getByText('Waiting for you to approve in the browser…')).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Copy code' })).toBeTruthy()
    expect(screen.queryByRole('button', { name: 'Sign in to GitHub' })).toBeNull()
  })

  it('connected: the login, the covered owners and repositories, Manage repository access', async () => {
    status = { account: account(), device: null, needs: [] }
    show()
    expect(await screen.findByText('evgeny-l', { selector: 'span' })).toBeTruthy()
    const list = screen.getByRole('list', { name: 'Repositories Cinna can reach' })
    expect(within(list).getAllByRole('listitem').map((li) => li.textContent)).toEqual(['acme: all repositories', 'evgeny-l: shop, site'])
    fireEvent.click(screen.getByRole('button', { name: 'Manage repository access' }))
    expect(api.openUrl).toHaveBeenCalledWith('manage')
    expect(screen.getByText(/a full revoke is at/)).toBeTruthy()
  })

  it('connected with no installation: No repositories yet', async () => {
    status = { account: account({ coverage: [] }), device: null, needs: [] }
    show()
    expect(await screen.findByText('No repositories yet')).toBeTruthy()
  })

  it('confirms Sign out, saying where the full revoke is, and closes only once it is done', async () => {
    status = { account: account(), device: null, needs: [] }
    show()
    fireEvent.click(await screen.findByRole('button', { name: 'Sign out' }))
    const dialog = screen.getByRole('dialog', { name: 'Sign out of GitHub' })
    expect(dialog.textContent).toContain('stop using evgeny-l')
    expect(dialog.textContent).toContain('fully revoked only on GitHub')
    fireEvent.click(within(dialog).getByRole('button', { name: 'github.com/settings/applications' }))
    expect(api.openUrl).toHaveBeenCalledWith('applications')
    expect(api.signOut).not.toHaveBeenCalled()
    status = { account: null, device: null, needs: [] }
    await act(async () => { fireEvent.click(within(dialog).getByRole('button', { name: 'Sign out' })) })
    expect(api.signOut).toHaveBeenCalledTimes(1)
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
    expect(await screen.findByRole('button', { name: 'Sign in to GitHub' })).toBeTruthy()
  })

  it('keeps a refused sign-out in the dialog', async () => {
    status = { account: account(), device: null, needs: [] }
    api.signOut.mockResolvedValueOnce({ ok: false, error: 'Session not activated' } as never)
    show()
    fireEvent.click(await screen.findByRole('button', { name: 'Sign out' }))
    const dialog = screen.getByRole('dialog', { name: 'Sign out of GitHub' })
    await act(async () => { fireEvent.click(within(dialog).getByRole('button', { name: 'Sign out' })) })
    expect(await within(dialog).findByRole('alert')).toBeTruthy()
    expect(within(dialog).getByRole('alert').textContent).toBe('Session not activated')
  })

  it('expired: says so and offers Reconnect GitHub', async () => {
    status = { account: account({ state: 'expired' }), device: null, needs: [] }
    show()
    expect(await screen.findByText(/Sign-in expired for/)).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'Reconnect GitHub' }))
    await waitFor(() => expect(api.signIn).toHaveBeenCalled())
  })
})
