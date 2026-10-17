import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { createElement } from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { ServiceCredentialAttachmentDto } from '../../../../../shared/serviceCredentials'
import type { LocalAgentDto } from '../../../../../shared/localAgents'

/**
 * Attach and detach both write a whole group list. They share one
 * chain and each re-reads the list, so an attach still in flight when the user
 * detaches something else must survive the detach, and vice versa.
 */

let stored: Record<string, string[]> = {}
let release: (() => void) | null = null
let extra: ServiceCredentialAttachmentDto[] = []
const attachments = vi.fn(async () => ({ ok: true, value: [...extra, ...Object.entries(stored).flatMap(([group, refs]) => refs.map((ref): ServiceCredentialAttachmentDto => ({
  ref, origin: group === 'local' ? 'local' : 'cloud', group, groupLabel: group === 'local' ? 'This computer' : group === 'acct' ? 'Ann' : 'Signed-out account',
  state: group === 'local' ? 'ready' : group === 'acct' ? 'not_cached' : 'account_unavailable', serverUrl: group === 'acct' ? 'https://core.example.com' : null,
  account: group === 'acct' ? { name: 'Ann Lee', email: 'ann@example.com' } : null,
  credential: group === 'local' || group === 'acct' ? { id: ref, origin: group === 'local' ? 'local' : 'cloud', cloudId: group === 'acct' ? `core-${ref}` : null, name: `Cred ${ref}`, type: 'api_token', serviceUri: null, notes: null, status: 'complete', isPlaceholder: false, relation: group === 'acct' ? 'shared' : 'owned', ownerEmail: group === 'acct' ? 'ann@example.com' : null, localUseAllowed: true, revision: null, hasValues: true, expiresAt: null, keyStatus: null, agentApi: null, keyBlocked: null, oauthStatus: null, grantedUserEmail: null } : null
})))] }))
const setAttachments = vi.fn(async (_id: string, group: string, refs: string[]) => {
  if (release === null && refs.includes('y')) await new Promise<void>(resolve => { release = resolve })
  stored = { ...stored, [group]: refs }
  return { ok: true, value: [] }
})
const openExternal = vi.fn(async () => ({ success: true }))
const reconnectOAuth = vi.fn()
const oauthFlow = vi.fn(async () => ({ ok: true, value: null as unknown }))
const cancelOAuth = vi.fn(async () => ({ ok: true, value: undefined }))
const attachOptions = vi.fn(async () => ({ ok: true, value: { groups: [{ key: 'acct-w', label: 'Work', detail: 'cinna.example.com', error: null, items: [] }] } }))
const changed = new Set<() => void>()
window.api = { serviceCredentials: { attachments, setAttachments, reconnectOAuth, oauthFlow, cancelOAuth, attachOptions,
  onChanged: (cb: () => void) => { changed.add(cb); return () => changed.delete(cb) } }, system: { openExternal } } as never
vi.mock('./ReadOnlyCards', () => ({ useOpenCredentialsFile: () => null, CredentialsCard: () => null }))
vi.mock('./CredentialAttachModal', () => ({
  CredentialAttachModal: ({ open, onAttach }: { open: boolean; onAttach: (group: string, ref: string) => Promise<void> }) =>
    createElement('button', { onClick: () => void onAttach('local', 'y'), 'data-open': String(open) }, 'fake attach y')
}))
const { ServiceCredentialsTab } = await import('./ServiceCredentialsTab')

function renderTab(client = new QueryClient({ defaultOptions: { queries: { retry: false } } })) {
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
  it('shows a revoked Agent API key on one line with its facts as glyphs, Manage and Detach, and nothing more', async () => {
    stored = {}; release = null
    extra = [{ ref: 'key-1', origin: 'cloud', group: 'acct-key', groupLabel: 'Ann', state: 'key_unavailable', serverUrl: 'https://core.example.com', account: { name: 'Ann Lee', email: 'ann@example.com' },
      credential: { id: 'row-key', origin: 'cloud', cloudId: 'key-1', name: 'CRM key', type: 'agent_api', serviceUri: 'crm', notes: null, status: 'complete', isPlaceholder: false, relation: 'owned', ownerEmail: null, localUseAllowed: true, revision: 'r', hasValues: false, expiresAt: null,
        keyStatus: 'revoked_by_issuer', agentApi: { producerName: 'CRM agent', issuerEmail: 'bob@example.com' }, keyBlocked: null, oauthStatus: null, grantedUserEmail: null } }]
    try {
      renderTab()
      const row = (await screen.findByText('CRM key')).closest('li')!
      expect(within(row).getByText('Agent API key')).toBeTruthy()
      expect(within(row).getAllByRole('img').map(el => el.getAttribute('aria-label'))).toEqual([
        'Agent API key for CRM agent', 'Revoked by bob@example.com — ask them for a new key', 'Issued to you by bob@example.com'])
      expect(within(row).getByText('Agent API key').getAttribute('title')).toBe('Agent API key for CRM agent')
      expect(within(row).queryByText(/CRM agent|bob@/)).toBeNull()
      expect(within(row).getAllByRole('button').map(b => b.getAttribute('aria-label'))).toEqual(['Manage CRM key', 'Detach CRM key'])
      fireEvent.click(within(row).getByRole('button', { name: 'Manage CRM key' }))
      await waitFor(() => expect(openExternal).toHaveBeenCalledWith('https://core.example.com/credential/key-1'))
    } finally { extra = [] }
  })
  it('says an attached active key is blocked, not unavailable on the remote, when Desktop refused its delivery', async () => {
    stored = {}; release = null
    extra = [{ ref: 'key-2', origin: 'cloud', group: 'acct-key', groupLabel: 'Ann', state: 'key_unavailable', serverUrl: 'https://core.example.com', account: { name: 'Ann Lee', email: 'ann@example.com' },
      credential: { id: 'row-key2', origin: 'cloud', cloudId: 'key-2', name: 'Blocked key', type: 'agent_api', serviceUri: 'crm', notes: null, status: 'complete', isPlaceholder: false, relation: 'owned', ownerEmail: null, localUseAllowed: true, revision: 'r', hasValues: false, expiresAt: null,
        keyStatus: 'active', agentApi: null, keyBlocked: 'insecure_base_url', oauthStatus: null, grantedUserEmail: null } }]
    try {
      renderTab()
      const row = (await screen.findByText('Blocked key')).closest('li')!
      expect(within(row).getByRole('img', { name: 'Blocked — this key’s API address isn’t secure (https); ask your Cinna server’s admin to fix it' })).toBeTruthy()
    } finally { extra = [] }
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
  describe('Reconnect', () => {
    const google = (ref: string, state: ServiceCredentialAttachmentDto['state'], over: Partial<NonNullable<ServiceCredentialAttachmentDto['credential']>> = {}): ServiceCredentialAttachmentDto => ({ ref, origin: 'cloud', group: 'acct-g', groupLabel: 'Ann', state, serverUrl: 'https://core.example.com', account: { name: 'Ann Lee', email: 'ann@example.com' },
      credential: { id: `row-${ref}`, origin: 'cloud', cloudId: ref, name: `Mail ${ref}`, type: 'gmail_oauth', serviceUri: null, notes: null, status: 'complete', isPlaceholder: false, relation: 'owned', ownerEmail: null, localUseAllowed: true, revision: 'r', hasValues: false, expiresAt: null,
        keyStatus: null, agentApi: null, keyBlocked: null, oauthStatus: state === 'ready' ? 'ready' : 'reauth_required', grantedUserEmail: null, ...over } })

    it('is offered only on a Google row waiting for or refused its grant, and opens the modal on the new flow', async () => {
      stored = {}; release = null
      extra = [google('g-pending', 'pending_authorization'), google('g-reauth', 'reauth_required'), google('g-ok', 'ready')]
      const flow = { id: 'f1', agentId: 'folder:a', group: 'acct-g', type: 'gmail_oauth', credentialId: 'g-reauth', reconnect: true, state: 'waiting', error: null, expiresAt: 1 }
      reconnectOAuth.mockResolvedValue({ ok: true, value: flow })
      const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
      try {
        renderTab(client)
        const row = (name: string) => screen.getByText(name).closest('li')!
        await screen.findByText('Mail g-ok')
        expect(within(row('Mail g-pending')).getByRole('img', { name: 'Waiting for Google sign-in' })).toBeTruthy()
        expect(within(row('Mail g-pending')).getByRole('button', { name: 'Reconnect Mail g-pending' })).toBeTruthy()
        expect(within(row('Mail g-ok')).queryByRole('button', { name: /^Reconnect/ })).toBeNull()
        expect(screen.getByText('fake attach y').dataset.open).toBe('false')
        fireEvent.click(within(row('Mail g-reauth')).getByRole('button', { name: 'Reconnect Mail g-reauth' }))
        await waitFor(() => expect(reconnectOAuth).toHaveBeenCalledWith('folder:a', 'acct-g', 'g-reauth'))
        await waitFor(() => expect(screen.getByText('fake attach y').dataset.open).toBe('true'))
        expect(client.getQueryData(['service-credential-oauth-flow', 'folder:a'])).toEqual(flow)
      } finally { extra = [] }
    })

    it('is not offered on a shared record, whose health says whom to ask', async () => {
      stored = {}; release = null
      extra = [google('g-shared', 'reauth_required', { relation: 'shared', ownerEmail: 'bob@example.com' }), google('g-shared-p', 'pending_authorization', { relation: 'shared', ownerEmail: 'bob@example.com' }), google('g-mine', 'reauth_required')]
      try {
        renderTab()
        const row = (name: string) => screen.getByText(name).closest('li')!
        await screen.findByText('Mail g-mine')
        expect(within(row('Mail g-shared')).queryByRole('button', { name: /^Reconnect/ })).toBeNull()
        expect(within(row('Mail g-shared')).getByRole('img', { name: 'Google access expired — ask bob@example.com to reconnect' })).toBeTruthy()
        expect(within(row('Mail g-shared-p')).queryByRole('button', { name: /^Reconnect/ })).toBeNull()
        expect(within(row('Mail g-shared-p')).getByRole('img', { name: 'Waiting for bob@example.com to finish Google sign-in' })).toBeTruthy()
        expect(within(row('Mail g-mine')).getByRole('button', { name: 'Reconnect Mail g-mine' })).toBeTruthy()
        expect(within(row('Mail g-mine')).getByRole('img', { name: 'Google access expired' })).toBeTruthy()
      } finally { extra = [] }
    })

    it('names a record called after its type by its Google account, without a badge repeating the name', async () => {
      stored = {}; release = null
      extra = [google('g-1', 'ready', { name: 'Gmail', grantedUserEmail: 'alice@gmail.com' })]
      try {
        renderTab()
        const row = (await screen.findByText('alice@gmail.com')).closest('li')!
        expect(within(row).getAllByText('Gmail')).toHaveLength(1)
      } finally { extra = [] }
    })

    it('shows a refused Reconnect in the tab’s error line and opens nothing', async () => {
      stored = {}; release = null
      extra = [google('g-reauth', 'reauth_required')]
      reconnectOAuth.mockResolvedValue({ ok: false, code: 'oauth_not_configured', message: 'Google OAuth is not configured on this server.' })
      try {
        renderTab()
        fireEvent.click(await screen.findByRole('button', { name: 'Reconnect Mail g-reauth' }))
        expect((await screen.findByRole('alert')).textContent).toBe('Google OAuth is not configured on this server.')
        expect(screen.getByText('fake attach y').dataset.open).toBe('false')
      } finally { extra = [] }
    })
  })

  describe('Google connect in progress', () => {
    const flow = (over: Record<string, unknown> = {}) => ({ id: 'f1', agentId: 'folder:a', group: 'acct-w', type: 'gcalendar_oauth_readonly', credentialId: null, reconnect: false, state: 'waiting', error: null, expiresAt: 1, ...over })
    const record = (ref: string, state: ServiceCredentialAttachmentDto['state'], name = `Cal ${ref}`): ServiceCredentialAttachmentDto => ({ ref, origin: 'cloud', group: 'acct-w', groupLabel: 'Work', state, serverUrl: 'https://core.example.com', account: { name: 'Wendy', email: 'w@example.com' },
      credential: { id: `row-${ref}`, origin: 'cloud', cloudId: ref, name, type: 'gcalendar_oauth_readonly', serviceUri: null, notes: null, status: 'complete', isPlaceholder: false, relation: 'owned', ownerEmail: null, localUseAllowed: true, revision: 'r', hasValues: false, expiresAt: null,
        keyStatus: null, agentApi: null, keyBlocked: null, oauthStatus: state === 'ready' ? 'ready' : 'reauth_required', grantedUserEmail: null } })
    const fire = () => act(async () => { changed.forEach(cb => cb()) })
    afterEach(() => { extra = []; oauthFlow.mockResolvedValue({ ok: true, value: null }) })

    it('shows a waiting New as a row in its account, instead of "No credentials attached.", with Open and Cancel', async () => {
      stored = { local: [] }; release = null
      oauthFlow.mockResolvedValue({ ok: true, value: flow() })
      renderTab()
      const name = await screen.findByText('Google Calendar (read-only)')
      const region = await screen.findByRole('region', { name: 'Work' })
      expect(within(region).getByRole('heading').textContent).toBe('Work cinna.example.com')
      const row = name.closest('li')!
      expect(within(row).getByRole('img', { name: 'Waiting for Google sign-in' })).toBeTruthy()
      expect(screen.queryByText('No credentials attached.')).toBeNull()
      expect(screen.getByText('fake attach y').dataset.open).toBe('false')
      fireEvent.click(within(row).getByRole('button', { name: 'Open Google Calendar (read-only) sign-in' }))
      expect(screen.getByText('fake attach y').dataset.open).toBe('true')
      fireEvent.click(within(row).getByRole('button', { name: 'Cancel Google Calendar (read-only) sign-in' }))
      await waitFor(() => expect(cancelOAuth).toHaveBeenCalledWith('folder:a', 'f1'))
      await waitFor(() => expect(screen.queryByText('Google Calendar (read-only)')).toBeNull())
      expect(screen.getByText('No credentials attached.')).toBeTruthy()
    })

    it('shows a failed New with the modal’s reason, after the account’s other rows', async () => {
      stored = {}; release = null
      extra = [record('c1', 'ready')]; attachOptions.mockClear()
      oauthFlow.mockResolvedValue({ ok: true, value: flow({ state: 'failed', error: { code: 'timeout', message: 'x' } }) })
      renderTab()
      const open = await screen.findByRole('button', { name: 'Open Google Calendar (read-only) sign-in' })
      const region = screen.getByRole('region', { name: 'Work' })
      expect(within(region).getAllByRole('listitem').map(li => li.textContent?.startsWith('Cal c1') ? 'record' : 'flow')).toEqual(['record', 'flow'])
      expect(within(open.closest('li')!).getByRole('img', { name: 'Google sign-in was not finished in time.' })).toBeTruthy()
      expect(attachOptions).not.toHaveBeenCalled()
    })

    it('shows a Reconnect on its record’s row, not as a new row', async () => {
      stored = {}; release = null
      extra = [record('c1', 'reauth_required')]
      oauthFlow.mockResolvedValue({ ok: true, value: flow({ reconnect: true, credentialId: 'c1' }) })
      renderTab()
      await waitFor(() => expect(screen.getByRole('img', { name: 'Waiting for Google sign-in' })).toBeTruthy())
      const region = screen.getByRole('region', { name: 'Work' })
      expect(within(region).getAllByRole('listitem')).toHaveLength(1)
      const row = within(region).getByRole('listitem')
      expect(within(row).queryByRole('button', { name: /^Reconnect/ })).toBeNull()
      expect(within(row).getByRole('button', { name: 'Open Cal c1 sign-in' })).toBeTruthy()
      expect(within(row).getByRole('button', { name: 'Cancel Cal c1 sign-in' })).toBeTruthy()
    })

    it('turns into the attached record when the flow finishes', async () => {
      stored = {}; release = null
      oauthFlow.mockResolvedValue({ ok: true, value: flow() })
      renderTab()
      await screen.findByText('Google Calendar (read-only)')
      extra = [record('c9', 'ready', 'Google Calendar (read-only)')]
      oauthFlow.mockResolvedValue({ ok: true, value: flow({ state: 'attached', credentialId: 'c9' }) })
      await fire()
      await waitFor(() => expect(screen.getByRole('img', { name: 'Ready' })).toBeTruthy())
      expect(within(screen.getByRole('region', { name: 'Work' })).getAllByRole('listitem')).toHaveLength(1)
      expect(screen.queryByRole('button', { name: /sign-in$/ })).toBeNull()
    })
  })
})
