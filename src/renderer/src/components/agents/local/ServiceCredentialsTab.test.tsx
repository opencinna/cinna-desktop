import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { createElement } from 'react'
import { describe, expect, it, vi } from 'vitest'
import type { ServiceCredentialAttachmentDto } from '../../../../../shared/serviceCredentials'
import type { LocalAgentDto } from '../../../../../shared/localAgents'

/**
 * Attach, detach and reorder all write a whole group list. They share one
 * chain and each re-reads the list, so an attach still in flight when the user
 * detaches something else must survive the detach, and vice versa.
 */

let stored: Record<string, string[]> = {}
let release: (() => void) | null = null
const attachments = vi.fn(async () => ({ ok: true, value: Object.entries(stored).flatMap(([group, refs]) => refs.map((ref): ServiceCredentialAttachmentDto => ({
  ref, origin: group === 'local' ? 'local' : 'cloud', group, groupLabel: group === 'local' ? 'This computer' : 'Signed-out account', state: group === 'local' ? 'ready' : 'account_unavailable',
  credential: group === 'local' ? { id: ref, origin: 'local', cloudId: null, name: `Cred ${ref}`, type: 'api_token', serviceUri: null, notes: null, status: 'complete', isPlaceholder: false, relation: 'owned', ownerEmail: null, localUseAllowed: true, revision: null, hasValues: true, expiresAt: null } : null
}))) }))
const setAttachments = vi.fn(async (_id: string, group: string, refs: string[]) => {
  if (release === null && refs.includes('y')) await new Promise<void>(resolve => { release = resolve })
  stored = { ...stored, [group]: refs }
  return { ok: true, value: [] }
})
window.api = { serviceCredentials: { attachments, setAttachments, onChanged: () => () => {} } } as never
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
    fireEvent.click(screen.getByRole('button', { name: 'Detach' }))
    await act(async () => { release!() })
    await waitFor(() => expect(stored.local).toEqual(['y']))
    await screen.findByText(/Cred y/)
    expect(screen.queryByText(/Cred x/)).toBeNull()
  })

  it('offers Detach, not Move up, for an attachment whose account is signed out', async () => {
    stored = { local: [], 'a1b2c3d4e5f60718': ['gone'] }; release = null
    renderTab()
    await screen.findByText(/Account not signed in/)
    expect(screen.queryByRole('button', { name: 'Move up' })).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: 'Detach' }))
    await waitFor(() => expect(setAttachments).toHaveBeenLastCalledWith('folder:a', 'a1b2c3d4e5f60718', []))
  })
})
