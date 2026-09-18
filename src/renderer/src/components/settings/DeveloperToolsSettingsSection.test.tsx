import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'

const mocks = vi.hoisted(() => {
  window.api = { app: { setTheme: async () => undefined } } as unknown as typeof window.api
  return { installed: vi.fn(), check: vi.fn(), update: vi.fn(), refresh: vi.fn(), codexBinary: { state: 'unresolved' } as Record<string, unknown> | undefined, claudeBinary: { state: 'unresolved' } as Record<string, unknown> | undefined }
})
vi.mock('../../hooks/useLocalAgents', () => ({ useLocalAgents: () => ({ data: { roots: [] } }) }))
vi.mock('../../hooks/useLocalTools', () => ({
  useLocalTools: () => ({ data: [{ id: 'cinna', label: 'Cinna CLI', kind: 'runtime', version: '9.0.0', available: true, source: 'path', path: '/shell/cinna' }] }),
  useRefreshLocalTools: () => ({ mutate: mocks.refresh, isPending: false })
}))
vi.mock('../../hooks/useEngine', () => ({ useEngineBinary: () => ({ data: { state: 'unresolved' } }), useCodexBinary: () => ({ data: mocks.codexBinary }), useClaudeBinary: () => ({ data: mocks.claudeBinary }) }))
vi.mock('./OpenCodeSettingsFields', () => ({ OpenCodeSettingsFields: () => null }))
vi.mock('./CodexSettingsFields', () => ({ CodexSettingsFields: () => null }))
import { useAuthStore } from '../../stores/auth.store'
import { useLocalDevStore } from '../../stores/localDev.store'
import { DeveloperToolsSettingsSection } from './DeveloperToolsSettingsSection'

beforeEach(() => {
  vi.resetAllMocks()
  mocks.codexBinary = { state: 'unresolved' }
  mocks.claudeBinary = { state: 'unresolved' }
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

  it('says Unavailable with the reason in the cell’s title when it failed, and makes no claim while loading', async () => {
    mocks.codexBinary = { state: 'failed', error: 'Codex could not be downloaded. Check your connection and try again.' }
    const view = render(<QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}><DeveloperToolsSettingsSection /></QueryClientProvider>)
    await screen.findByRole('button', { name: 'Update' })
    expect(within(codexRow()).getByText('Unavailable')).toBeTruthy()
    // The reason is the cell's title here and a line under the Codex Path
    // field (mocked out in this file; see CodexSettingsFields.test.tsx) — never
    // a paragraph of the section's own above the fields (ux_rules rule 1).
    expect(within(codexRow()).getByTitle('Codex could not be downloaded. Check your connection and try again.')).toBeTruthy()
    expect(screen.queryByText('Codex could not be downloaded. Check your connection and try again.')).toBeNull()
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

describe('the Claude Code row', () => {
  const claudeRow = (): HTMLElement => screen.getByText('Claude Code', { selector: 'td' }).closest('tr')!

  it('sits under the Codex row and names the Claude Code Cinna runs — not whatever is on PATH', async () => {
    mocks.claudeBinary = { state: 'ready', path: '/data/runtimes/claude-2.1.276/claude', source: 'managed', version: '2.1.276 (Claude Code)' }
    renderTools()
    await screen.findByRole('button', { name: 'Update' })
    const row = claudeRow()
    expect(row.previousElementSibling?.querySelector('td')?.textContent).toBe('Codex')
    expect(within(row).getByText('2.1.276 managed').className).toContain('font-mono')
    expect(row.querySelector('td')?.title).toBe('/data/runtimes/claude-2.1.276/claude')
    // One row for Claude Code: the detected-tools list leaves runtimes out, so
    // the PATH copy cannot appear beside it as a second, contradicting version.
    expect(screen.getAllByText('Claude Code', { selector: 'td' })).toHaveLength(1)
  })

  it('says whose copy it is: the user’s exact-version install, or an unverified path', async () => {
    mocks.claudeBinary = { state: 'ready', path: '/Users/x/.local/bin/claude', source: 'path-pinned', version: '2.1.276 (Claude Code)' }
    const view = render(<QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}><DeveloperToolsSettingsSection /></QueryClientProvider>)
    await screen.findByRole('button', { name: 'Update' })
    expect(within(claudeRow()).getByText('2.1.276 (your install)')).toBeTruthy()
    view.unmount()

    mocks.claudeBinary = { state: 'ready', path: '/opt/claude', source: 'configured', version: '2.1.300 (Claude Code)' }
    renderTools()
    await screen.findByRole('button', { name: 'Update' })
    expect(within(claudeRow()).getByText('2.1.300 unverified')).toBeTruthy()
    expect(within(claudeRow()).queryByText(/managed/)).toBeNull()
  })

  it('says Unavailable, with the reason under the Claude Path field, when it failed', async () => {
    mocks.claudeBinary = { state: 'failed', error: 'Claude Code could not be downloaded. Check your connection and try again.' }
    renderTools()
    await screen.findByRole('button', { name: 'Update' })
    expect(within(claudeRow()).getByText('Unavailable')).toBeTruthy()
    const reason = screen.getByText('Claude Code could not be downloaded. Check your connection and try again.')
    expect(reason.className).toContain('text-[var(--color-danger)]')
    // Once, and under the Claude Path field — not above it, where its arrival
    // moved the field being edited (ux_rules rule 1).
    const input = screen.getByLabelText('Claude Path', { exact: true })
    expect(input.compareDocumentPosition(reason) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
  })
})
