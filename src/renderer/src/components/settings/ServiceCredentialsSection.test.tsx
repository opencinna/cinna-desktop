import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import type { ServiceCredentialDto } from '../../../../shared/serviceCredentials'
import { useAuthStore } from '../../stores/auth.store'
import { ServiceCredentialsSection } from './ServiceCredentialsSection'

const local: ServiceCredentialDto = {
  id: 'local', origin: 'local', cloudId: null, name: 'Local token', type: 'api_token',
  serviceUri: null, notes: null, status: 'complete', isPlaceholder: false, relation: 'owned',
  ownerEmail: null, localUseAllowed: true, revision: null, hasValues: true, expiresAt: null
}
const remote: ServiceCredentialDto = { ...local, id: 'cloud', origin: 'cloud', cloudId: 'cloud', name: 'Cloud token' }
const list = vi.fn(), sync = vi.fn(), save = vi.fn(), remove = vi.fn(), openExternal = vi.fn()
let queryClient: QueryClient

beforeEach(() => {
  vi.clearAllMocks()
  queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  useAuthStore.getState().setCurrentUser({ id: 'cloud-profile', type: 'cinna_user', username: 'fixture', displayName: 'Fixture', hasPassword: false, cinnaServerUrl: 'https://fixture.test' })
  window.api = { serviceCredentials: { list, sync, save, remove, onChanged: () => () => {} }, system: { openExternal } } as unknown as typeof window.api
})
afterEach(() => { queryClient.clear(); useAuthStore.getState().setCurrentUser(null) })

function show(error: string | null, cloud = false, secureStorage = true) {
  list.mockResolvedValue({ ok: true, value: { items: [local, remote], lastSync: 1, error, secureStorage } })
  return render(<QueryClientProvider client={queryClient}><ServiceCredentialsSection cloud={cloud} /></QueryClientProvider>)
}

it.each([
  ['sync_failed', 'Could not sync credentials from this profile. Try again.'],
  ['reauth_required', 'Sign in again to sync credentials.'],
  ['permission_denied', 'This account is not allowed to download credential values. Check access with the owner or administrator.']
])('keeps %s on the cloud page while Default remains local', async (code, message) => {
  const view = show(code)
  await screen.findByText('Local token')
  expect(screen.queryByText('Cloud token')).toBeNull()
  expect(screen.queryByRole('alert')).toBeNull()
  expect(screen.queryByText(/Last synced/)).toBeNull()
  expect(screen.queryByRole('button', { name: 'Sync Now' })).toBeNull()
  expect(sync).not.toHaveBeenCalled()

  view.rerender(<QueryClientProvider client={queryClient}><ServiceCredentialsSection cloud /></QueryClientProvider>)
  expect(screen.getByRole('alert').textContent).toBe(message)
  expect(screen.getByText('Cloud token')).toBeTruthy()
  expect(screen.queryByText('Local token')).toBeNull()
})

it('still reports local file-delivery and keychain failures without asking for a connection', async () => {
  show('cleanup_failed', false, false)
  await screen.findByText('Local token')
  const messages = screen.getAllByRole('alert').map(el => el.textContent).join(' ')
  expect(messages).toContain('Some agent credential files could not be updated.')
  expect(messages).toContain('Unlock your system keychain to save local credential values.')
  expect(messages).not.toMatch(/sync|connected|sign in/i)
})

it('allows local saves during a cloud sync failure and reports a local save error', async () => {
  show('sync_failed')
  save.mockResolvedValue({ ok: false, code: 'credential_error', message: 'Secure storage is unavailable.' })
  await screen.findByText('Local token')
  fireEvent.click(screen.getByRole('button', { name: 'Add Credential' }))
  fireEvent.click(screen.getByRole('button', { name: /^API token/ }))
  fireEvent.change(screen.getByLabelText('Name'), { target: { value: 'New local token' } })
  fireEvent.change(screen.getByLabelText('API token'), { target: { value: 'fixture-local-token' } })
  fireEvent.click(screen.getByRole('button', { name: 'Save' }))
  await waitFor(() => expect(screen.getByRole('alert').textContent).toBe('Secure storage is unavailable.'))
  expect(save).toHaveBeenCalledWith(expect.objectContaining({ name: 'New local token', values: expect.objectContaining({ api_token: 'fixture-local-token' }) }))
  expect(sync).not.toHaveBeenCalled()
})

it('preserves errors reading local records', async () => {
  list.mockResolvedValueOnce({ ok: false, code: 'credential_error', message: 'Local credential database could not be read.' })
  show(null)
  expect((await screen.findByRole('alert')).textContent).toBe('Local credential database could not be read.')
})

it('opens a searchable type picker before showing the corresponding form', async () => {
  show(null)
  await screen.findByText('Local token')
  const add = screen.getByRole('button', { name: 'Add Credential' })
  expect(add.className).toContain('border-dashed')
  fireEvent.click(add)
  expect(screen.queryByLabelText('Name')).toBeNull()
  fireEvent.change(screen.getByRole('textbox', { name: 'Search credential types' }), { target: { value: 'smtp' } })
  expect(screen.queryByRole('button', { name: /^API token/ })).toBeNull()
  fireEvent.click(screen.getByRole('button', { name: /^Email · SMTP/ }))
  expect(screen.getByLabelText('Mail server')).toBeTruthy()
  expect(screen.getByLabelText('Sender email')).toBeTruthy()
  expect(screen.getByLabelText('Service URI')).toBeTruthy()
  expect(screen.queryByLabelText('Type')).toBeNull()
  fireEvent.click(screen.getByRole('button', { name: 'About Service URI' }))
  expect(screen.getByRole('dialog', { name: 'About Service URI' }).textContent).toContain('credential type')
})

it.each(['API token', 'Email · IMAP', 'Email · SMTP', 'Odoo', 'Google service account'])('offers Service URI on the %s form', async name => {
  show(null)
  await screen.findByText('Local token')
  fireEvent.click(screen.getByRole('button', { name: 'Add Credential' }))
  fireEvent.click(screen.getByRole('button', { name: new RegExp('^' + name) }))
  fireEvent.change(screen.getByLabelText('Name'), { target: { value: 'New credential' } })
  fireEvent.change(screen.getByLabelText('Service URI'), { target: { value: 'work-mail' } })
  save.mockResolvedValue({ ok: true, value: local })
  fireEvent.click(screen.getByRole('button', { name: 'Save' }))
  await waitFor(() => expect(save).toHaveBeenCalledWith(expect.objectContaining({ serviceUri: 'work-mail' })))
})

it('keeps remote actions together and pins manual sync to the displayed profile', async () => {
  sync.mockResolvedValue({ ok: true, value: undefined })
  show(null, true)
  await screen.findByText('Cloud token')
  const manage = screen.getByRole('button', { name: 'Manage on Remote' })
  const syncButton = screen.getByRole('button', { name: 'Sync Now' })
  expect(manage.parentElement).toBe(syncButton.parentElement)
  expect(manage.className).toContain('ambient-button')
  expect(syncButton.className).toContain('ambient-button')
  fireEvent.click(syncButton)
  await waitFor(() => expect(sync).toHaveBeenCalledWith('cloud-profile', 'https://fixture.test'))
})

it('keeps a late old-host error out of the new profile and syncs its displayed server', async () => {
  let finishOld!: (value: unknown) => void
  list.mockImplementation((id: string) => id === 'cloud-profile'
    ? new Promise(resolve => { finishOld = resolve })
    : Promise.resolve({ ok: true, value: { items: [{ ...remote, name: 'Localhost token' }], lastSync: 1, error: null, secureStorage: true } }))
  sync.mockResolvedValue({ ok: true, value: undefined })
  render(<QueryClientProvider client={queryClient}><ServiceCredentialsSection cloud /></QueryClientProvider>)
  await waitFor(() => expect(list).toHaveBeenCalledWith('cloud-profile', 'https://fixture.test'))
  act(() => useAuthStore.getState().setCurrentUser({ id: 'localhost-profile', type: 'cinna_user', username: 'admin', displayName: 'admin', hasPassword: false, cinnaServerUrl: 'http://localhost:5173' }))
  await screen.findByText('Localhost token')
  await act(async () => { finishOld({ ok: true, value: { items: [], lastSync: null, error: 'not_supported', secureStorage: true } }) })
  expect(screen.queryByRole('alert')).toBeNull()
  expect(screen.getByRole('link', { name: 'localhost:5173' }).getAttribute('href')).toBe('http://localhost:5173')
  fireEvent.click(screen.getByRole('button', { name: 'Sync Now' }))
  await waitFor(() => expect(sync).toHaveBeenCalledWith('localhost-profile', 'http://localhost:5173'))
  expect(list).toHaveBeenLastCalledWith('localhost-profile', 'http://localhost:5173')
})

it('explains beside the remote title that only locally usable credentials are listed', async () => {
  show(null, true)
  fireEvent.click(await screen.findByRole('button', { name: 'About remote credentials' }))
  expect(screen.getByRole('dialog', { name: 'About remote credentials' }).textContent).toContain('not the full list')
  show(null)
  expect(screen.getAllByRole('button', { name: 'About remote credentials' })).toHaveLength(1)
})

it('shows each row as icon, name, type badge, status, ownership and Service URI', async () => {
  list.mockResolvedValue({ ok: true, value: { items: [{ ...local, serviceUri: 'slack.com' }, { ...remote, relation: 'shared', ownerEmail: 'ann@example.com', localUseAllowed: false }], lastSync: 1, error: null, secureStorage: true } })
  const view = render(<QueryClientProvider client={queryClient}><ServiceCredentialsSection /></QueryClientProvider>)
  const toggle = await screen.findByRole('button', { name: /^Local token/ })
  expect(toggle.getAttribute('aria-expanded')).toBe('false')
  expect(toggle.textContent).toContain('API token')
  expect(screen.getByRole('img', { name: 'Ready' })).toBeTruthy()
  expect(screen.getByRole('img', { name: 'Stored on this computer' })).toBeTruthy()
  expect(screen.getByText('slack.com').tagName).toBe('CODE')
  expect(screen.queryByText(/Service URI:/)).toBeNull()
  view.rerender(<QueryClientProvider client={queryClient}><ServiceCredentialsSection cloud /></QueryClientProvider>)
  expect(screen.getByRole('img', { name: 'The owner must allow use on your computer' })).toBeTruthy()
  expect(screen.getByRole('img', { name: 'Shared by ann@example.com' })).toBeTruthy()
  expect(screen.queryByRole('button', { name: /Delete/ })).toBeNull()
})

it('edits a local record inline, locks the rest while a form is open, and confirms delete inside the row', async () => {
  const other = { ...local, id: 'other', name: 'Other token' }
  list.mockResolvedValue({ ok: true, value: { items: [local, other, remote], lastSync: 1, error: null, secureStorage: true } })
  render(<QueryClientProvider client={queryClient}><ServiceCredentialsSection /></QueryClientProvider>)
  remove.mockResolvedValue({ ok: true, value: undefined })
  const row = () => screen.getByRole('button', { name: /^Local token/ })
  fireEvent.click(await screen.findByRole('button', { name: /^Local token/ }))
  expect(row().getAttribute('aria-expanded')).toBe('true')
  expect((screen.getByLabelText('Name') as HTMLInputElement).value).toBe('Local token')
  // An open form holds unsaved input: nothing else can replace it.
  for (const name of ['Add Credential', 'Delete Local token', 'Delete Other token']) expect((screen.getByRole('button', { name }) as HTMLButtonElement).disabled).toBe(true)
  expect((screen.getByRole('button', { name: /^Other token/ }) as HTMLButtonElement).disabled).toBe(true)
  fireEvent.click(screen.getByRole('button', { name: /^Other token/ }))
  expect(row().getAttribute('aria-expanded')).toBe('true')
  // Its own header closes it, which frees the rest.
  fireEvent.click(row())
  expect(row().getAttribute('aria-expanded')).toBe('false')
  fireEvent.click(screen.getByRole('button', { name: 'Add Credential' }))
  expect(screen.getByRole('textbox', { name: 'Search credential types' })).toBeTruthy()
  expect((screen.getByRole('button', { name: 'Delete Local token' }) as HTMLButtonElement).disabled).toBe(true)
  // The collapsed row's form stays mounted in jsdom, so take the picker's own Cancel.
  fireEvent.click(within(screen.getByRole('heading', { name: 'Choose credential type' }).parentElement!).getByRole('button', { name: 'Cancel' }))
  fireEvent.click(screen.getByRole('button', { name: 'Delete Local token' }))
  const confirm = screen.getByRole('group', { name: 'Delete Local token' })
  expect(confirm.textContent).toContain('You can create it again')
  // The header closes the confirm rather than switching the row to its edit form.
  fireEvent.click(row())
  expect(row().getAttribute('aria-expanded')).toBe('false')
  fireEvent.click(screen.getByRole('button', { name: 'Delete Local token' }))
  expect(remove).not.toHaveBeenCalled()
  fireEvent.click(screen.getByRole('button', { name: 'Delete credential' }))
  await waitFor(() => expect(remove).toHaveBeenCalledWith('local'))
})

it('opens Core’s page for a remote credential and reports a refused open', async () => {
  openExternal.mockResolvedValueOnce({ success: true }).mockResolvedValueOnce({ success: false, error: 'No browser is available.' })
  show(null, true)
  const manage = await screen.findByRole('button', { name: 'Manage Cloud token' })
  fireEvent.click(manage)
  await waitFor(() => expect(openExternal).toHaveBeenCalledWith('https://fixture.test/credential/cloud'))
  expect(screen.queryByRole('alert')).toBeNull()
  fireEvent.click(manage)
  expect((await screen.findByRole('alert')).textContent).toBe('No browser is available.')
})

it('names the profile and links its server in the remote header', async () => {
  useAuthStore.getState().setCurrentUser({ id: 'cloud-profile', type: 'cinna_user', username: 'ann@example.com', displayName: 'ann', cinnaFullName: 'Ann Lee', hasPassword: false, cinnaServerUrl: 'https://fixture.test' })
  openExternal.mockResolvedValue({ success: true })
  show(null, true)
  const link = await screen.findByRole('link', { name: 'fixture.test' })
  expect(link.parentElement!.textContent).toBe('Ann Lee <ann@example.com> fixture.test')
  fireEvent.click(link)
  await waitFor(() => expect(openExternal).toHaveBeenCalledWith('https://fixture.test'))
  expect(screen.queryByText(/Server:/)).toBeNull()
})
