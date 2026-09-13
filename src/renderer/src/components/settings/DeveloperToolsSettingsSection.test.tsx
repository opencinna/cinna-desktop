import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'

const mocks = vi.hoisted(() => {
  window.api = { app: { setTheme: async () => undefined } } as unknown as typeof window.api
  return { installed: vi.fn(), check: vi.fn(), update: vi.fn(), refresh: vi.fn() }
})
vi.mock('../../hooks/useLocalAgents', () => ({ useLocalAgents: () => ({ data: { roots: [] } }) }))
vi.mock('../../hooks/useLocalTools', () => ({
  useLocalTools: () => ({ data: [{ id: 'cinna', label: 'Cinna CLI', kind: 'runtime', version: '9.0.0', available: true, source: 'path', path: '/shell/cinna' }] }),
  useRefreshLocalTools: () => ({ mutate: mocks.refresh, isPending: false })
}))
vi.mock('../../hooks/useEngine', () => ({ useEngineBinary: () => ({ data: { state: 'unresolved' } }) }))
vi.mock('./OpenCodeSettingsFields', () => ({ OpenCodeSettingsFields: () => null }))
import { useAuthStore } from '../../stores/auth.store'
import { useLocalDevStore } from '../../stores/localDev.store'
import { DeveloperToolsSettingsSection } from './DeveloperToolsSettingsSection'

beforeEach(() => {
  vi.resetAllMocks()
  window.api.localDev = { getManagedCli: mocks.installed, checkCliUpdate: mocks.check, updateCli: mocks.update } as unknown as typeof window.api.localDev
  useAuthStore.getState().setCurrentUser({ id: 'alice', username: 'alice', displayName: 'Alice', type: 'cinna_user', hasPassword: false, cinnaServerUrl: 'https://cinna.example' })
  useLocalDevStore.setState({ state: { phase: 'ready', cliVersion: '0.3.0', protocol: 'legacy', workspacePath: '/workspace', cinnaBinPath: '/managed/cinna' }, subscribed: true })
  mocks.installed.mockResolvedValue({ version: '0.3.0', path: '/managed/cinna' })
  mocks.check.mockResolvedValue({ installedVersion: '0.3.0', targetVersion: '0.4.1', updateAvailable: true })
})

function renderTools(): void {
  render(<QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}><DeveloperToolsSettingsSection /></QueryClientProvider>)
}

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
