import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'

const mocks = vi.hoisted(() => {
  window.api = { app: { setTheme: async () => undefined } } as unknown as typeof window.api
  return { installed: vi.fn(), check: vi.fn(), update: vi.fn(), refresh: vi.fn(), codexBinary: { state: 'unresolved' } as Record<string, unknown> | undefined }
})
vi.mock('../../hooks/useLocalAgents', () => ({ useLocalAgents: () => ({ data: { roots: [] } }) }))
vi.mock('../../hooks/useLocalTools', () => ({
  useLocalTools: () => ({ data: [{ id: 'cinna', label: 'Cinna CLI', kind: 'runtime', version: '9.0.0', available: true, source: 'path', path: '/shell/cinna' }] }),
  useRefreshLocalTools: () => ({ mutate: mocks.refresh, isPending: false })
}))
vi.mock('../../hooks/useEngine', () => ({ useEngineBinary: () => ({ data: { state: 'unresolved' } }), useCodexBinary: () => ({ data: mocks.codexBinary }) }))
vi.mock('./OpenCodeSettingsFields', () => ({ OpenCodeSettingsFields: () => null }))
vi.mock('./CodexSettingsFields', () => ({ CodexSettingsFields: () => null }))
import { useAuthStore } from '../../stores/auth.store'
import { useLocalDevStore } from '../../stores/localDev.store'
import { DeveloperToolsSettingsSection } from './DeveloperToolsSettingsSection'

beforeEach(() => {
  vi.resetAllMocks()
  mocks.codexBinary = { state: 'unresolved' }
  window.api.localDev = { getManagedCli: mocks.installed, checkCliUpdate: mocks.check, updateCli: mocks.update } as unknown as typeof window.api.localDev
  useAuthStore.getState().setCurrentUser({ id: 'alice', username: 'alice', displayName: 'Alice', type: 'cinna_user', hasPassword: false, cinnaServerUrl: 'https://cinna.example' })
  useLocalDevStore.setState({ state: { phase: 'ready', cliVersion: '0.3.0', protocol: 'legacy', workspacePath: '/workspace', cinnaBinPath: '/managed/cinna' }, subscribed: true })
  mocks.installed.mockResolvedValue({ version: '0.3.0', path: '/managed/cinna' })
  mocks.check.mockResolvedValue({ installedVersion: '0.3.0', targetVersion: '0.4.1', updateAvailable: true })
})

function renderTools(): void {
  render(<QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}><DeveloperToolsSettingsSection /></QueryClientProvider>)
}

describe('the Codex row', () => {
  const codexRow = (): HTMLElement => screen.getByText('Codex', { selector: 'td' }).closest('tr')!

  it('sits under the OpenCode row and names the managed pin, with the binary path on the name', async () => {
    mocks.codexBinary = { state: 'ready', path: '/data/runtimes/codex-0.155.0/codex', source: 'managed', version: 'codex-cli 0.155.0' }
    renderTools()
    await screen.findByRole('button', { name: 'Update' })
    const row = codexRow()
    expect(row.previousElementSibling?.querySelector('td')?.textContent).toBe('OpenCode')
    expect(within(row).getByText('0.155.0 managed').className).toContain('font-mono')
    expect(row.querySelector('td')?.title).toBe('/data/runtimes/codex-0.155.0/codex')
  })

  it('labels a configured path unverified by its own version — never as the managed pin', async () => {
    // Mutation: render the pin here and the table says `0.155.0 managed` directly
    // above a Codex Path field that replaced it.
    mocks.codexBinary = { state: 'ready', path: '/opt/codex', source: 'configured', version: 'codex-cli 0.160.0' }
    renderTools()
    await screen.findByRole('button', { name: 'Update' })
    expect(within(codexRow()).getByText('0.160.0 unverified')).toBeTruthy()
    expect(within(codexRow()).queryByText(/managed/)).toBeNull()
  })

  it('says Unavailable with the reason below the table when it failed, and makes no claim while loading', async () => {
    mocks.codexBinary = { state: 'failed', error: 'Codex could not be downloaded. Check your connection and try again.' }
    const view = render(<QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}><DeveloperToolsSettingsSection /></QueryClientProvider>)
    await screen.findByRole('button', { name: 'Update' })
    expect(within(codexRow()).getByText('Unavailable')).toBeTruthy()
    const reason = screen.getByText('Codex could not be downloaded. Check your connection and try again.')
    expect(reason.className).toContain('text-[var(--color-danger)]')
    // Below the table, so its arrival moves no row (ux_rules rule 1).
    expect(reason.compareDocumentPosition(screen.getByRole('table')) & Node.DOCUMENT_POSITION_PRECEDING).toBeTruthy()
    view.unmount()

    mocks.codexBinary = undefined
    renderTools()
    await screen.findByRole('button', { name: 'Update' })
    expect(codexRow().querySelectorAll('td')[1].textContent).toBe('')
  })
})

describe('Cinna CLI settings update', () => {
  it('updates the managed version shown in the row, with progress and refreshed results', async () => {
    let finish!: () => void
    mocks.update.mockImplementation(() => new Promise<void>((resolve) => { finish = resolve }))
    renderTools()
    const update = await screen.findByRole('button', { name: 'Update' })
    const row = update.closest('tr')!
    expect(within(row).getByText('0.3.0')).toBeTruthy()
    expect(row.querySelector('td')?.title).toBe('/managed/cinna')
    fireEvent.click(update)
    expect(await screen.findByRole('button', { name: 'Updating…' })).toHaveProperty('disabled', true)
    expect(screen.getByRole('button', { name: 'Updating…' }).querySelector('svg')?.classList.contains('animate-spin')).toBe(true)
    mocks.installed.mockResolvedValue({ version: '0.4.1', path: '/managed/cinna' })
    mocks.check.mockResolvedValue({ installedVersion: '0.4.1', targetVersion: '0.4.1', updateAvailable: false })
    await act(async () => finish())
    expect(await screen.findByText('Cinna CLI updated.')).toBeTruthy()
    expect(within(row).getByText('0.4.1')).toBeTruthy()
    expect(screen.queryByRole('button', { name: 'Update' })).toBeNull()
    expect(mocks.update).toHaveBeenCalledOnce()
  })
  it('shows update errors inline and keeps retry available', async () => {
    mocks.update.mockRejectedValue(new Error('Could not download cinna-cli.'))
    renderTools()
    fireEvent.click(await screen.findByRole('button', { name: 'Update' }))
    expect(await screen.findByRole('alert')).toHaveProperty('textContent', 'Could not download cinna-cli.')
    expect(screen.getByRole('button', { name: 'Update' })).toHaveProperty('disabled', false)
  })
  it('checks again with Refresh and offers no update when current', async () => {
    mocks.check.mockResolvedValue({ installedVersion: '0.4.1', targetVersion: '0.4.1', updateAvailable: false })
    renderTools()
    await waitFor(() => expect(screen.getByRole('button', { name: 'Refresh detected tools' })).toHaveProperty('disabled', false))
    expect(screen.queryByRole('button', { name: 'Update' })).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: 'Refresh detected tools' }))
    await waitFor(() => expect(mocks.check).toHaveBeenCalledTimes(2))
    expect(mocks.refresh).toHaveBeenCalledOnce()
  })
})
