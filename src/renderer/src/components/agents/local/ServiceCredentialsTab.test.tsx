import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { createElement } from 'react'
import { describe, expect, it, vi } from 'vitest'
import type { ServiceCredentialAttachmentDto } from '../../../../../shared/serviceCredentials'
import type { LocalAgentDto } from '../../../../../shared/localAgents'

/**
 * Attach and detach both write a whole group list. They share one
 * chain and each re-reads the list, so an attach still in flight when the user
 * detaches something else must survive the detach, and vice versa.
 */

let stored: Record<string, string[]> = {}
let release: (() => void) | null = null
const attachments = vi.fn(async () => ({ ok: true, value: Object.entries(stored).flatMap(([group, refs]) => refs.map((ref): ServiceCredentialAttachmentDto => ({
  ref, origin: group === 'local' ? 'local' : 'cloud', group, groupLabel: group === 'local' ? 'This computer' : group === 'acct' ? 'Ann' : 'Signed-out account',
  state: group === 'local' ? 'ready' : group === 'acct' ? 'not_cached' : 'account_unavailable', serverUrl: group === 'acct' ? 'https://core.example.com' : null,
  account: group === 'acct' ? { name: 'Ann Lee', email: 'ann@example.com' } : null,
  credential: group === 'local' || group === 'acct' ? { id: ref, origin: group === 'local' ? 'local' : 'cloud', cloudId: group === 'acct' ? `core-${ref}` : null, name: `Cred ${ref}`, type: 'api_token', serviceUri: null, notes: null, status: 'complete', isPlaceholder: false, relation: group === 'acct' ? 'shared' : 'owned', ownerEmail: group === 'acct' ? 'ann@example.com' : null, localUseAllowed: true, revision: null, hasValues: true, expiresAt: null } : null
}))) }))
const setAttachments = vi.fn(async (_id: string, group: string, refs: string[]) => {
  if (release === null && refs.includes('y')) await new Promise<void>(resolve => { release = resolve })
  stored = { ...stored, [group]: refs }
  return { ok: true, value: [] }
})
const openExternal = vi.fn(async () => ({ success: true }))
window.api = { serviceCredentials: { attachments, setAttachments, onChanged: () => () => {} }, system: { openExternal } } as never
vi.mock('./ReadOnlyCards', () => ({ useOpenCredentialsFile: () => null, CredentialsCard: () => null }))
vi.mock('./CredentialAttachModal', () => ({
  CredentialAttachModal: ({ onAttach }: { onAttach: (group: string, ref: string) => Promise<void> }) =>
    createElement('button', { onClick: () => void onAttach('local', 'y') }, 'fake attach y')
}))
const { ServiceCredentialsTab } = await import('./ServiceCredentialsTab')

function renderTab() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  const agent = { id: 'folder:a', kind: 'bare', credentials: [] } as unknown as LocalAgentDto
  return render(createElement(QueryClientProvider, { client }, createElement(ServiceCredentialsTab, { agent })))
}

describe('ServiceCredentialsTab', () => {
  it('keeps an in-flight attach when another credential is detached before it lands', async () => {
    stored = { local: ['x'] }; release = null
    renderTab()
    await screen.findByText(/Cred x/)
    fireEvent.click(screen.getByText('fake attach y'))
    await waitFor(() => expect(release).not.toBeNull())
    fireEvent.click(screen.getByRole('button', { name: 'Detach Cred x' }))
    await act(async () => { release!() })
    await waitFor(() => expect(stored.local).toEqual(['y']))
    await screen.findByText(/Cred y/)
    expect(screen.queryByText(/Cred x/)).toBeNull()
  })

  it('offers Detach for an attachment whose account is signed out', async () => {
    stored = { local: [], 'a1b2c3d4e5f60718': ['gone'] }; release = null
    renderTab()
    await screen.findByText(/Account not signed in/)
    expect(screen.queryByRole('button', { name: /^Manage/ })).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: /^Detach / }))
    await waitFor(() => expect(setAttachments).toHaveBeenLastCalledWith('folder:a', 'a1b2c3d4e5f60718', []))
  })
  it('shows each attachment as the shared row, with icon actions and Manage for a cloud record', async () => {
    stored = { local: ['x', 'z'], acct: ['c'] }; release = null
    renderTab()
    await screen.findByText('Cred c')
    const local = screen.getByRole('region', { name: 'This computer' })
    expect(within(local).getAllByRole('img', { name: 'Ready' })).toHaveLength(2)
    expect(within(local).getAllByRole('img', { name: 'Stored on this computer' })).toHaveLength(2)
    expect(within(local).queryByRole('button', { name: /^Move / })).toBeNull()
    expect(within(local).queryByRole('button', { name: /^Manage/ })).toBeNull()
    const cloud = screen.getByRole('region', { name: 'Ann' })
    expect(within(cloud).getByRole('img', { name: 'Values not downloaded yet' })).toBeTruthy()
    expect(within(cloud).getByRole('img', { name: 'Shared by ann@example.com' })).toBeTruthy()
    expect(within(cloud).getByRole('heading').textContent).toBe('Ann Lee <ann@example.com> core.example.com')
    fireEvent.click(within(cloud).getByRole('link', { name: 'core.example.com' }))
    await waitFor(() => expect(openExternal).toHaveBeenCalledWith('https://core.example.com'))
    fireEvent.click(within(cloud).getByRole('button', { name: 'Manage Cred c' }))
    await waitFor(() => expect(openExternal).toHaveBeenCalledWith('https://core.example.com/credential/core-c'))
  })
  it('heads the list "Attached Credentials" with the explanation behind its (?) and Attach beside it', async () => {
    stored = { local: [] }; release = null
    renderTab()
    const section = (await screen.findByRole('heading', { name: 'Attached Credentials' })).closest('section')!
    expect(within(section).getByRole('button', { name: 'About attached credentials' })).toBeTruthy()
    expect(within(section).getByRole('button', { name: /Attach/ })).toBeTruthy()
    expect(await within(section).findByText('No credentials attached.')).toBeTruthy()
    expect(screen.queryByText(/Detach updates generated files/)).toBeNull()
  })
})
