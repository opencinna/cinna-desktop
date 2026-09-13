import { render, screen, fireEvent, waitFor } from '@testing-library/react'
import { describe, expect, it, vi, beforeEach } from 'vitest'
import type { LocalDevState } from '../../../../shared/localDevState'

;(window as unknown as { api: Record<string, unknown> }).api = {
  app: { setTheme: async () => undefined },
  localDev: {
    getState: async () => ({ phase: 'idle' }) as LocalDevState,
    onState: () => () => undefined
  }
}
const { ProfileLocalDevSettingsSection } = await import('./ProfileLocalDevSettingsSection')
const { useLocalDevStore } = await import('../../stores/localDev.store')
const { useAuthStore } = await import('../../stores/auth.store')
const resetConsent = vi.fn(async () => undefined)
const openWorkspace = vi.fn(async () => undefined)

function withState(state: LocalDevState): void {
  useLocalDevStore.setState({ state, subscribed: true })
}

beforeEach(() => {
  vi.clearAllMocks()
  useLocalDevStore.setState({ resetConsent, openWorkspace })
  useAuthStore.setState({ currentUser: {
    id: 'account-a', type: 'cinna_user', username: 'alice', displayName: 'Alice',
    hasPassword: false, cinnaServerUrl: 'https://cinna.example.com'
  } })
})

describe('ProfileLocalDevSettingsSection', () => {
  it('explains the role gate and offers nothing to press', () => {
    withState({ phase: 'unsupported', reason: 'role' })
    render(<ProfileLocalDevSettingsSection />)

    expect(screen.getByText(/agent-developer or admin role/i)).toBeTruthy()
    expect(screen.getByText(/Ask an admin/i)).toBeTruthy()
    expect(screen.queryByRole('button', { name: /set up/i })).toBeNull()
    expect(screen.queryByRole('button', { name: /repair/i })).toBeNull()
  })

  it('says a toolchain failure may need an app update, and still offers Repair', () => {
    withState({
      phase: 'attention',
      reason: 'toolchain',
      detail: 'Mutagen 0.18.1 could not be verified.'
    })
    render(<ProfileLocalDevSettingsSection />)

    expect(screen.getByText('Mutagen 0.18.1 could not be verified.')).toBeTruthy()
    expect(screen.getByText(/updating Cinna Desktop will/i)).toBeTruthy()
    expect(screen.getByRole('button', { name: /repair/i })).toBeTruthy()
  })

  it('says what an older pinned cinna-cli cannot do, without calling it broken', () => {
    // The server picks the cinna-cli version, so a desktop can be handed one
    // that predates the machine-readable protocol. Everything works; one thing
    // (silent token refresh) does not, and meeting that as a surprise later is
    // worse than a sentence here.
    withState({
      phase: 'ready',
      workspacePath: '/Users/x/Agents/Cloud/cinna.example.com',
      cliVersion: '0.3.0',
      cinnaBinPath: '/Users/x/Library/Application Support/cinna/bin/cinna',
      protocol: 'legacy' as const
    })
    render(<ProfileLocalDevSettingsSection />)

    expect(screen.getByText(/older than the machine-readable protocol/i)).toBeTruthy()
    expect(screen.getByText(/expired account token cannot be refreshed on its own/i)).toBeTruthy()
    // Still ready: no warning icon, no attention copy.
    expect(screen.queryByText(/needs attention/i)).toBeNull()
  })

  it('reports progress while installing', () => {
    withState({ phase: 'installing', step: 'Downloading cinna-cli', percent: 40 })
    render(<ProfileLocalDevSettingsSection />)

    expect(screen.getByText('Downloading cinna-cli')).toBeTruthy()
    expect(screen.getByRole('progressbar').getAttribute('aria-valuenow')).toBe('40')
  })
  it('keeps workspace and consent in the profile and resets consent for its server', async () => {
    withState({ phase: 'ready', workspacePath: '/Agents/Cloud/cinna.example.com',
      cliVersion: '0.4.2', cinnaBinPath: '/managed/cinna', protocol: 'json' })
    render(<ProfileLocalDevSettingsSection />)

    expect(screen.getByText('/Agents/Cloud/cinna.example.com')).toBeTruthy()
    expect(screen.queryByText('Desktop App Cinna-CLI managed binary')).toBeNull()
    expect(screen.queryByRole('button', { name: /add to path/i })).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: 'Open folder' }))
    await waitFor(() => expect(openWorkspace).toHaveBeenCalledOnce())
    await waitFor(() => expect((screen.getByRole('button', { name: 'Reset consent' }) as HTMLButtonElement).disabled).toBe(false))
    fireEvent.click(screen.getByRole('button', { name: 'Reset consent' }))
    await waitFor(() => expect(resetConsent).toHaveBeenCalledWith('cinna.example.com'))
  })
})
