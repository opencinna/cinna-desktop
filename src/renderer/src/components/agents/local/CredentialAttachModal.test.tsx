import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { createElement } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { OAuthConnectFlow, ServiceCredentialAttachOptions, ServiceCredentialDto } from '../../../../../shared/serviceCredentials'

/**
 * The attach picker: sections per group (this computer, then each account),
 * one Attach button per card. What has to hold is that an attach lands on its
 * own card, the card stays where it was, and a failure stays in the open modal.
 */

const attachOptions = vi.fn()
const oauthFlow = vi.fn(), createOAuth = vi.fn(), reconnectOAuth = vi.fn(), reopenOAuth = vi.fn(), cancelOAuth = vi.fn()
const changed = new Set<() => void>()
const fireChanged = () => act(async () => { changed.forEach(cb => cb()) })
window.api = { serviceCredentials: { attachOptions, oauthFlow, createOAuth, reconnectOAuth, reopenOAuth, cancelOAuth,
  onChanged: (cb: () => void) => { changed.add(cb); return () => changed.delete(cb) } } } as never
const { CredentialAttachModal } = await import('./CredentialAttachModal')

function credential(overrides: Partial<ServiceCredentialDto>): ServiceCredentialDto & { attached: boolean } {
  return { id: 'id', origin: 'local', cloudId: null, name: 'Token', type: 'api_token', serviceUri: null, notes: null, status: 'complete', isPlaceholder: false,
    relation: 'owned', ownerEmail: null, localUseAllowed: true, revision: null, hasValues: true, expiresAt: null, keyStatus: null, agentApi: null, keyBlocked: null, oauthStatus: null, grantedUserEmail: null, attached: false, ...overrides }
}
const options: ServiceCredentialAttachOptions = { groups: [
  { key: 'local', label: 'This computer', detail: '', error: null, items: [credential({ id: 'local-1', name: 'Local API', serviceUri: 'api.local' }), credential({ id: 'local-2', name: 'Mailbox', type: 'email_imap' })] },
  { key: 'acct-work', label: 'Work', detail: 'cinna.example.com', error: 'reauth_required', items: [
    credential({ id: 'row-1', origin: 'cloud', cloudId: 'cloud-1', name: 'Slack bot', relation: 'shared', ownerEmail: 'owner@example.test' })] },
  { key: 'acct-home', label: 'Home', detail: 'home.example.com', error: null, items: [] }
] }

function renderModal(onAttach: (group: string, ref: string) => Promise<void>, onClose = vi.fn(), seed?: OAuthConnectFlow) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  if (seed) client.setQueryData(['service-credential-oauth-flow', 'folder:a'], seed)
  const result = render(createElement(QueryClientProvider, { client }, createElement(CredentialAttachModal, { open: true, agentId: 'folder:a', onClose, onAttach })))
  return { ...result, onClose }
}
const order = () => screen.getAllByTestId(/^credential-card-/).map(el => el.dataset.testid)

const flow = (over: Partial<OAuthConnectFlow>): OAuthConnectFlow => ({ id: 'flow-1', agentId: 'folder:a', group: 'acct-work', type: 'gmail_oauth', credentialId: null,
  reconnect: false, state: 'waiting', error: null, expiresAt: Date.now() + 600_000, ...over })
const ok = <T,>(value: T) => ({ ok: true, value })

beforeEach(() => {
  attachOptions.mockResolvedValue({ ok: true, value: options })
  oauthFlow.mockResolvedValue(ok(null)); reopenOAuth.mockResolvedValue(ok(undefined)); cancelOAuth.mockResolvedValue(ok(undefined))
})
afterEach(() => { for (const fn of [attachOptions, oauthFlow, createOAuth, reconnectOAuth, reopenOAuth, cancelOAuth]) fn.mockReset() })

describe('CredentialAttachModal', () => {
  it('marks a card whose credential needs attention, and leaves healthy cards unmarked', async () => {
    attachOptions.mockResolvedValue({ ok: true, value: { groups: [{ key: 'local', label: 'This computer', detail: '', error: null, items: [
      credential({ id: 'ok', name: 'Healthy' }), credential({ id: 'part', name: 'Partial', isPlaceholder: true })] }] } })
    renderModal(vi.fn())
    expect(within(await screen.findByTestId('credential-card-part')).getByRole('img', { name: 'Some values are missing' })).toBeTruthy()
    expect(within(screen.getByTestId('credential-card-ok')).queryByRole('img')).toBeNull()
  })

  it('shows an issued key as an Agent API key, marking a paused one and leaving an active one unmarked', async () => {
    attachOptions.mockResolvedValue({ ok: true, value: { groups: [{ key: 'acct', label: 'Work', detail: '', error: null, items: [
      credential({ id: 'live', origin: 'cloud', cloudId: 'k1', name: 'CRM live', type: 'agent_api', serviceUri: 'crm', keyStatus: 'active', hasValues: false }),
      credential({ id: 'paused', origin: 'cloud', cloudId: 'k2', name: 'CRM paused', type: 'agent_api', keyStatus: 'external_access_paused', hasValues: false, agentApi: { producerName: 'Billing agent', issuerEmail: 'bob@example.com' } })] }] } })
    renderModal(vi.fn())
    const live = await screen.findByTestId('credential-card-k1')
    expect(within(live).getByText('Agent API key · crm')).toBeTruthy()
    // Healthy: no status glyph, only who issued it (unknown here).
    expect(within(live).getAllByRole('img').map(el => el.getAttribute('aria-label'))).toEqual(['Issued to you'])
    const paused = screen.getByTestId('credential-card-k2')
    expect(within(paused).getAllByRole('img').map(el => el.getAttribute('aria-label'))).toEqual([
      'Agent API key for Billing agent', 'External access to Billing agent is paused — works again when its owner resumes it', 'Issued to you by bob@example.com'])
    fireEvent.change(screen.getByRole('textbox', { name: 'Search credentials' }), { target: { value: 'agent api' } })
    expect(order()).toEqual(['credential-card-k1', 'credential-card-k2'])
  })

  it('marks an active key whose delivery Desktop blocked', async () => {
    attachOptions.mockResolvedValue({ ok: true, value: { groups: [{ key: 'acct', label: 'Work', detail: '', error: null, items: [
      credential({ id: 'blocked', origin: 'cloud', cloudId: 'k9', name: 'CRM blocked', type: 'agent_api', keyStatus: 'active', keyBlocked: 'insecure_base_url', hasValues: false })] }] } })
    renderModal(vi.fn())
    expect(within(await screen.findByTestId('credential-card-k9')).getByRole('img', { name: 'Blocked — this key’s API address isn’t secure (https); ask your Cinna server’s admin to fix it' })).toBeTruthy()
  })

  it('groups credentials by where they live, with account detail, sync errors and empty groups', async () => {
    renderModal(vi.fn())
    const work = await screen.findByRole('region', { name: 'Work' })
    expect(screen.getAllByRole('region').map(el => el.getAttribute('aria-label'))).toEqual(['This computer', 'Work', 'Home'])
    expect(within(work).getByText('cinna.example.com')).toBeTruthy()
    expect(within(work).getByText('Sign in again to sync credentials.')).toBeTruthy()
    expect(within(work).getByText('Shared by owner@example.test')).toBeTruthy()
    expect(within(screen.getByRole('region', { name: 'This computer' })).getByText('API token · api.local')).toBeTruthy()
    // An empty account offers only New.
    expect(within(screen.getByRole('region', { name: 'Home' })).getAllByRole('button').map(b => b.textContent)).toEqual([expect.stringContaining('New Google credential')])
  })

  it('keeps an attached card in place with a disabled Attached state, pending per card', async () => {
    let finish!: () => void
    const onAttach = vi.fn(() => new Promise<void>(resolve => { finish = resolve }))
    renderModal(onAttach)
    await screen.findByRole('button', { name: 'Attach Slack bot' })
    const before = order()
    fireEvent.click(screen.getByRole('button', { name: 'Attach Slack bot' }))
    expect(onAttach).toHaveBeenCalledWith('acct-work', 'cloud-1')
    expect(screen.getByRole('button', { name: 'Attach Slack bot' }).textContent).toContain('Attaching…')
    // Only the clicked card is busy.
    expect((screen.getByRole('button', { name: 'Attach Local API' }) as HTMLButtonElement).disabled).toBe(false)
    await act(async () => { finish() })
    const done = screen.getByRole('button', { name: 'Slack bot attached' }) as HTMLButtonElement
    expect(done.disabled).toBe(true); expect(done.textContent).toContain('Attached')
    expect(order()).toEqual(before)
    expect(screen.getByRole('dialog', { name: 'Attach credential' })).toBeTruthy()
  })

  it('shows a failed attach on its card and keeps the modal open', async () => {
    const onClose = vi.fn()
    renderModal(vi.fn(async () => { throw new Error("Error invoking remote method 'x': Error: Credential is no longer available.") }), onClose)
    fireEvent.click(await screen.findByRole('button', { name: 'Attach Mailbox' }))
    const alert = await within(screen.getByTestId('credential-card-local-2')).findByRole('alert')
    expect(alert.textContent).toBe('Credential is no longer available.')
    expect((screen.getByRole('button', { name: 'Attach Mailbox' }) as HTMLButtonElement).disabled).toBe(false)
    expect(onClose).not.toHaveBeenCalled()
  })

  it('searches across groups and hides sections without matches', async () => {
    renderModal(vi.fn())
    await screen.findByRole('region', { name: 'Work' })
    fireEvent.change(screen.getByRole('textbox', { name: 'Search credentials' }), { target: { value: 'slack' } })
    expect(screen.getAllByRole('region').map(el => el.getAttribute('aria-label'))).toEqual(['Work'])
    expect(order()).toEqual(['credential-card-cloud-1'])
    fireEvent.change(screen.getByRole('textbox', { name: 'Search credentials' }), { target: { value: 'nothing-here' } })
    expect(screen.getByText('No credentials match')).toBeTruthy()
  })

  it('closes on Escape', async () => {
    const { onClose } = renderModal(vi.fn())
    await screen.findByRole('region', { name: 'Work' })
    fireEvent.keyDown(window, { key: 'Escape' })
    expect(onClose).toHaveBeenCalled()
  })

  describe('New Google credential', () => {
    const newIn = (region: string) => within(screen.getByRole('region', { name: region })).queryByRole('button', { name: /New Google credential/ })

    it('ends every account group with New, never the computer’s, and hides it while searching', async () => {
      renderModal(vi.fn())
      await screen.findByRole('region', { name: 'Work' })
      expect(newIn('This computer')).toBeNull()
      expect(newIn('Work')).toBeTruthy()
      expect(newIn('Home')).toBeTruthy()
      fireEvent.change(screen.getByRole('textbox', { name: 'Search credentials' }), { target: { value: 'slack' } })
      expect(screen.queryByRole('button', { name: /New Google credential/ })).toBeNull()
    })

    it('connects the chosen service in its account, read-only when switched, and moves to the waiting view', async () => {
      createOAuth.mockResolvedValue(ok(flow({ type: 'gdrive_oauth_readonly' })))
      renderModal(vi.fn())
      await screen.findByRole('region', { name: 'Work' })
      fireEvent.click(newIn('Work')!)
      expect(screen.queryByRole('textbox', { name: 'Search credentials' })).toBeNull()
      // Label and host as the group headings show them, each truncating, never "Work ·" dangling on a line.
      expect([...screen.getByTestId('oauth-account').children].map(el => el.textContent)).toEqual(['Work', 'cinna.example.com'])
      expect(document.activeElement).toBe(screen.getByRole('radio', { name: 'Gmail' }))
      expect(screen.getByText('Will be named “Gmail”')).toBeTruthy()
      fireEvent.click(screen.getByRole('radio', { name: 'Google Drive' }))
      fireEvent.click(screen.getByRole('switch', { name: 'Read-only' }))
      expect(screen.getByText('Will be named “Google Drive (read-only)”')).toBeTruthy()
      fireEvent.click(screen.getByRole('button', { name: 'Connect' }))
      expect(createOAuth).toHaveBeenCalledWith('folder:a', 'acct-work', 'gdrive_oauth_readonly')
      expect(await screen.findByText('Finish in your browser')).toBeTruthy()
      expect(screen.getByText(/allow Google Drive \(read-only\) for this Cinna account/)).toBeTruthy()
      expect(screen.getByTestId('oauth-account').textContent).toBe('Workcinna.example.com')
      await waitFor(() => expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Reopen browser' })))
    })

    it('keeps a refused Connect inline in the chooser, busy while it runs and usable again after', async () => {
      let answer!: (value: unknown) => void
      createOAuth.mockReturnValue(new Promise(resolve => { answer = resolve }))
      const { onClose } = renderModal(vi.fn())
      await screen.findByRole('region', { name: 'Home' })
      fireEvent.click(newIn('Home')!)
      fireEvent.click(screen.getByRole('button', { name: 'Connect' }))
      expect(createOAuth).toHaveBeenCalledWith('folder:a', 'acct-home', 'gmail_oauth')
      expect((screen.getByRole('button', { name: 'Connect' }) as HTMLButtonElement).disabled).toBe(true)
      await act(async () => { answer({ ok: false, code: 'oauth_not_configured', message: 'Google OAuth is not configured on this server.' }) })
      expect(screen.getByRole('alert').textContent).toBe('Google OAuth is not configured on this server.')
      expect((screen.getByRole('button', { name: 'Connect' }) as HTMLButtonElement).disabled).toBe(false)
      expect(screen.getByRole('radiogroup', { name: 'Google service' })).toBeTruthy()
      expect(onClose).not.toHaveBeenCalled()
    })

    it('shows a waiting flow on open; Reopen and Cancel go to main, Cancel back to the list, and clicks inside close nothing', async () => {
      oauthFlow.mockResolvedValue(ok(flow({})))
      const { onClose } = renderModal(vi.fn())
      expect(await screen.findByText('Finish in your browser')).toBeTruthy()
      expect(screen.queryByRole('textbox', { name: 'Search credentials' })).toBeNull()
      fireEvent.mouseDown(screen.getByRole('button', { name: 'Reopen browser' }))
      fireEvent.click(screen.getByRole('button', { name: 'Reopen browser' }))
      await waitFor(() => expect(reopenOAuth).toHaveBeenCalledWith('folder:a', 'flow-1'))
      oauthFlow.mockResolvedValue(ok(null))
      fireEvent.click(screen.getByRole('button', { name: 'Cancel' }))
      await waitFor(() => expect(cancelOAuth).toHaveBeenCalledWith('folder:a', 'flow-1'))
      expect(await screen.findByRole('textbox', { name: 'Search credentials' })).toBeTruthy()
      expect(onClose).not.toHaveBeenCalled()
    })

    it('closes on Escape while waiting without cancelling the flow', async () => {
      oauthFlow.mockResolvedValue(ok(flow({})))
      const { onClose } = renderModal(vi.fn())
      await screen.findByText('Finish in your browser')
      fireEvent.keyDown(window, { key: 'Escape' })
      expect(onClose).toHaveBeenCalled()
      expect(cancelOAuth).not.toHaveBeenCalled()
    })

    it('dismisses the flow and closes once a watched flow is attached', async () => {
      oauthFlow.mockResolvedValue(ok(flow({ reconnect: true, credentialId: 'cloud-1' })))
      // Seeded as Reconnect does, before the modal opens.
      const { onClose } = renderModal(vi.fn(), vi.fn(), flow({ reconnect: true, credentialId: 'cloud-1' }))
      expect(screen.getByText('Finish in your browser')).toBeTruthy()
      await waitFor(() => expect(oauthFlow).toHaveBeenCalled())
      oauthFlow.mockResolvedValue(ok(flow({ reconnect: true, credentialId: 'cloud-1', state: 'attached' })))
      await fireChanged()
      await waitFor(() => expect(onClose).toHaveBeenCalled())
      expect(cancelOAuth).toHaveBeenCalledWith('folder:a', 'flow-1')
    })

    it('only dismisses an attached flow found on open, and shows the list', async () => {
      oauthFlow.mockResolvedValue(ok(flow({ state: 'attached' })))
      const { onClose } = renderModal(vi.fn())
      await waitFor(() => expect(cancelOAuth).toHaveBeenCalledWith('folder:a', 'flow-1'))
      expect(await screen.findByRole('region', { name: 'Work' })).toBeTruthy()
      expect(onClose).not.toHaveBeenCalled()
    })

    it('reopened after its flow finished while closed, dismisses it and stays open', async () => {
      oauthFlow.mockResolvedValue(ok(flow({})))
      const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
      const onClose = vi.fn()
      const at = (open: boolean) => createElement(QueryClientProvider, { client }, createElement(CredentialAttachModal, { open, agentId: 'folder:a', onClose, onAttach: vi.fn() }))
      const { rerender } = render(at(true))
      await screen.findByText('Finish in your browser')
      rerender(at(false))
      await new Promise(resolve => setTimeout(resolve, 2))
      oauthFlow.mockResolvedValue(ok(flow({ state: 'attached' })))
      rerender(at(true))
      await waitFor(() => expect(cancelOAuth).toHaveBeenCalledWith('folder:a', 'flow-1'))
      expect(await screen.findByRole('region', { name: 'Work' })).toBeTruthy()
      expect(onClose).not.toHaveBeenCalled()
    })

    it('says why a flow failed, retries the same type in the same account, and Back cancels it', async () => {
      oauthFlow.mockResolvedValue(ok(flow({ state: 'failed', type: 'gcalendar_oauth_readonly', error: { code: 'timeout', message: 'Timed out' } })))
      createOAuth.mockResolvedValue(ok(flow({ id: 'flow-2', type: 'gcalendar_oauth_readonly' })))
      renderModal(vi.fn())
      expect(await screen.findByText('Could not connect Google Calendar (read-only)')).toBeTruthy()
      expect(screen.getByRole('alert').textContent).toBe('Google sign-in was not finished in time.')
      await waitFor(() => expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Retry' })))
      fireEvent.click(screen.getByRole('button', { name: 'Retry' }))
      await waitFor(() => expect(createOAuth).toHaveBeenCalledWith('folder:a', 'acct-work', 'gcalendar_oauth_readonly'))
      expect(await screen.findByText('Finish in your browser')).toBeTruthy()
      await waitFor(() => expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Reopen browser' })))
    })

    it('retries a failed reconnect as a reconnect, and Back from a failed New returns to its choice', async () => {
      oauthFlow.mockResolvedValue(ok(flow({ state: 'failed', reconnect: true, credentialId: 'cloud-1', error: { code: 'other', message: 'Core said no.' } })))
      reconnectOAuth.mockResolvedValue(ok(flow({ reconnect: true, credentialId: 'cloud-1', state: 'failed', error: { code: 'oauth_not_configured', message: 'x' } })))
      const view = renderModal(vi.fn())
      expect(await screen.findByText('Could not reconnect Gmail')).toBeTruthy()
      expect(screen.getByRole('alert').textContent).toBe('Core said no.')
      fireEvent.click(screen.getByRole('button', { name: 'Retry' }))
      await waitFor(() => expect(reconnectOAuth).toHaveBeenCalledWith('folder:a', 'acct-work', 'cloud-1'))
      expect(await screen.findByText('Google sign-in is not set up on this Cinna server.')).toBeTruthy()
      view.unmount()

      oauthFlow.mockResolvedValue(ok(flow({ state: 'failed', type: 'gmeet_oauth_readonly', error: { code: 'reauth_required', message: 'x' } })))
      renderModal(vi.fn())
      expect(await screen.findByText('Sign in to this Cinna account again.')).toBeTruthy()
      fireEvent.click(screen.getByRole('button', { name: 'Back' }))
      await waitFor(() => expect(cancelOAuth).toHaveBeenCalledWith('folder:a', 'flow-1'))
      expect((await screen.findByRole('radio', { name: 'Google Meet' }) as HTMLInputElement).checked).toBe(true)
      await waitFor(() => expect(document.activeElement).toBe(screen.getByRole('radio', { name: 'Google Meet' })))
      expect(screen.getByRole('switch', { name: 'Read-only' }).getAttribute('aria-checked')).toBe('true')
    })
  })

  it('shows the Google account a record was granted for, and its pending grant', async () => {
    attachOptions.mockResolvedValue({ ok: true, value: { groups: [{ key: 'acct', label: 'Work', detail: '', error: null, items: [
      credential({ id: 'g', origin: 'cloud', cloudId: 'g1', name: 'Mail', type: 'gmail_oauth', oauthStatus: 'ready', grantedUserEmail: 'alice@gmail.com', hasValues: false }),
      credential({ id: 'p', origin: 'cloud', cloudId: 'g2', name: 'Drive', type: 'gdrive_oauth', oauthStatus: 'pending_authorization', hasValues: false })] }] } })
    renderModal(vi.fn())
    expect(within(await screen.findByTestId('credential-card-g1')).getByText('Gmail · alice@gmail.com')).toBeTruthy()
    expect(within(screen.getByTestId('credential-card-g2')).getByRole('img', { name: 'Waiting for Google sign-in' })).toBeTruthy()
  })

  it('names a record called after its type by its Google account, not the type a second time', async () => {
    attachOptions.mockResolvedValue({ ok: true, value: { groups: [{ key: 'acct', label: 'Work', detail: '', error: null, items: [
      credential({ id: 'g', origin: 'cloud', cloudId: 'g1', name: 'Gmail', type: 'gmail_oauth', oauthStatus: 'ready', grantedUserEmail: 'alice@gmail.com', hasValues: false }),
      credential({ id: 'p', origin: 'cloud', cloudId: 'g2', name: 'Google Drive', type: 'gdrive_oauth', oauthStatus: 'pending_authorization', hasValues: false })] }] } })
    renderModal(vi.fn())
    const granted = await screen.findByTestId('credential-card-g1')
    expect(within(granted).getAllByText(/Gmail/).map(el => el.textContent)).toEqual(['Gmail'])
    expect(within(granted).getByText('alice@gmail.com')).toBeTruthy()
    // Not granted yet: an empty line that keeps the card's height, not the type again.
    const pending = screen.getByTestId('credential-card-g2')
    expect(within(pending).getAllByText(/Google Drive/).map(el => el.textContent)).toEqual(['Google Drive'])
  })
})
