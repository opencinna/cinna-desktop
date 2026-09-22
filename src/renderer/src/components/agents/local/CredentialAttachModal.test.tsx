import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { act, fireEvent, render, screen, within } from '@testing-library/react'
import { createElement } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ServiceCredentialAttachOptions, ServiceCredentialDto } from '../../../../../shared/serviceCredentials'

/**
 * The attach picker: sections per group (this computer, then each account),
 * one Attach button per card. What has to hold is that an attach lands on its
 * own card, the card stays where it was, and a failure stays in the open modal.
 */

const attachOptions = vi.fn()
window.api = { serviceCredentials: { attachOptions, onChanged: () => () => {} } } as never
const { CredentialAttachModal } = await import('./CredentialAttachModal')

function credential(overrides: Partial<ServiceCredentialDto>): ServiceCredentialDto & { attached: boolean } {
  return { id: 'id', origin: 'local', cloudId: null, name: 'Token', type: 'api_token', serviceUri: null, notes: null, status: 'complete', isPlaceholder: false,
    relation: 'owned', ownerEmail: null, localUseAllowed: true, revision: null, hasValues: true, expiresAt: null, attached: false, ...overrides }
}
const options: ServiceCredentialAttachOptions = { groups: [
  { key: 'local', label: 'This computer', detail: '', error: null, items: [credential({ id: 'local-1', name: 'Local API', serviceUri: 'api.local' }), credential({ id: 'local-2', name: 'Mailbox', type: 'email_imap' })] },
  { key: 'acct-work', label: 'Work', detail: 'cinna.example.com', error: 'reauth_required', items: [
    credential({ id: 'row-1', origin: 'cloud', cloudId: 'cloud-1', name: 'Slack bot', relation: 'shared', ownerEmail: 'owner@example.test' })] },
  { key: 'acct-home', label: 'Home', detail: 'home.example.com', error: null, items: [] }
] }

function renderModal(onAttach: (group: string, ref: string) => Promise<void>, onClose = vi.fn()) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  const result = render(createElement(QueryClientProvider, { client }, createElement(CredentialAttachModal, { open: true, agentId: 'folder:a', onClose, onAttach })))
  return { ...result, onClose }
}
const order = () => screen.getAllByTestId(/^credential-card-/).map(el => el.dataset.testid)

beforeEach(() => { attachOptions.mockResolvedValue({ ok: true, value: options }) })
afterEach(() => { attachOptions.mockReset() })

describe('CredentialAttachModal', () => {
  it('groups credentials by where they live, with account detail, sync errors and empty groups', async () => {
    renderModal(vi.fn())
    const work = await screen.findByRole('region', { name: 'Work' })
    expect(screen.getAllByRole('region').map(el => el.getAttribute('aria-label'))).toEqual(['This computer', 'Work', 'Home'])
    expect(within(work).getByText('cinna.example.com')).toBeTruthy()
    expect(within(work).getByText('Sign in again to sync credentials.')).toBeTruthy()
    expect(within(work).getByText('Shared by owner@example.test')).toBeTruthy()
    expect(within(screen.getByRole('region', { name: 'This computer' })).getByText('API token · api.local')).toBeTruthy()
    expect(within(screen.getByRole('region', { name: 'Home' })).getByText('No credentials in this account.')).toBeTruthy()
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
})
