import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { GithubStatusDto } from '../../../../shared/github'
import { useAuthStore } from '../../stores/auth.store'
import { UserAccountsSection } from './UserAccountsSection'

/** Settings → User Accounts: two titled sections, Profiles and GitHub, whose cards look alike (ux_rules rule 12). */

const status: GithubStatusDto = {
  account: { login: 'evgeny-l', state: 'connected', coverage: [], coverageFetchedAt: 1 },
  device: null, needs: [], dismissed: []
}
const users = [{ id: 'alice', type: 'local_user', username: 'alice', displayName: 'Alice', hasPassword: false, createdAt: new Date(0) }]
let queryClient: QueryClient

beforeEach(() => {
  queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  useAuthStore.getState().setCurrentUser({ id: 'alice', type: 'local_user', username: 'alice', displayName: 'Alice', hasPassword: false })
  window.api = {
    auth: { listUsers: vi.fn(async () => users) },
    github: { status: vi.fn(async () => ({ ok: true, value: status })), onChanged: () => () => {} }
  } as unknown as typeof window.api
})
afterEach(() => { queryClient.clear(); useAuthStore.getState().setCurrentUser(null) })

describe('User Accounts tab', () => {
  it('is a stack of Profiles and GitHub sections, the intro behind the (?), the cards alike', async () => {
    const { container } = render(<QueryClientProvider client={queryClient}><UserAccountsSection /></QueryClientProvider>)
    const profile = (await screen.findByText('Alice')).closest('.rounded-lg') as HTMLElement
    const github = (await screen.findByText('evgeny-l', { selector: 'span' })).closest('.rounded-lg') as HTMLElement

    expect(screen.getAllByRole('heading').map((h) => h.textContent)).toEqual(['Profiles', 'GitHub'])
    expect((container.firstElementChild as HTMLElement).className).toContain('space-y-6')
    expect(screen.queryByText(/Manage local user accounts/)).toBeNull()
    expect(screen.getByRole('button', { name: 'About profiles' })).toBeTruthy()

    // The same card shell: background, border and radius.
    const shell = (el: HTMLElement): string[] => el.className.split(/\s+/).filter((c) => /^(bg-|border|rounded-)/.test(c)).sort()
    expect(shell(profile)).toEqual(shell(github))
  })
})
