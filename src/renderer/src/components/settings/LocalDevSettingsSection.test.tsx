import { render as renderUI, screen, waitFor, fireEvent } from '@testing-library/react'
import { describe, expect, it, vi, beforeEach } from 'vitest'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import type { LocalDevState } from '../../../../shared/localDevState'

/** Device-wide tools remain available independently of account workspace readiness. */

vi.mock('../../hooks/useLocalAgents', () => ({
  useLocalAgents: () => ({ data: { roots: [] } })
}))
vi.mock('../../hooks/useLocalTools', () => ({
  useLocalTools: () => ({ data: [] }),
  useRefreshLocalTools: () => ({ mutate: vi.fn(), isPending: false })
}))

vi.mock('../../hooks/useAppSettings', () => ({
  useAppSettings: () => ({ data: { localAgentsEnginePath: '' } }),
  useSetAppSetting: () => ({ mutate: vi.fn() })
}))
vi.mock('../../hooks/useEngine', () => ({
  useEngineBinary: () => ({ data: { state: 'unresolved' } })
}))

const addToPath = vi.fn()
const getManagedCli = vi.fn()

;(window as unknown as { api: Record<string, unknown> }).api = {
  app: { setTheme: async () => undefined },
  localDev: {
    getState: async () => ({ phase: 'idle' }) as LocalDevState,
    onState: () => () => undefined,
    addToPath,
    getManagedCli
  }
}

const { LocalDevSettingsSection } = await import('./LocalDevSettingsSection')
const { useLocalDevStore } = await import('../../stores/localDev.store')

/** `subscribed: true` keeps the mount effect from overwriting the phase. */
function withState(state: LocalDevState): void {
  useLocalDevStore.setState({ state, subscribed: true })
}

beforeEach(() => {
  addToPath.mockReset()
  getManagedCli.mockResolvedValue({
    path: '/Users/x/Library/Application Support/cinna/bin/cinna',
    version: '0.4.2'
  })
})

function render(element: React.ReactElement): ReturnType<typeof renderUI> {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return renderUI(<QueryClientProvider client={client}>{element}</QueryClientProvider>)
}

describe('LocalDevSettingsSection', () => {
  it('shows where things are when ready, and surfaces a PATH refusal inline', async () => {
    addToPath.mockResolvedValue({ ok: false, reason: '~/.local/bin is not writable.' })
    withState({
      phase: 'ready',
      workspacePath: '/Users/x/Agents/Cloud/cinna.example.com',
      cliVersion: '0.4.2',
      cinnaBinPath: '/Users/x/Library/Application Support/cinna/bin/cinna',
      protocol: 'json' as const
    })
    render(<LocalDevSettingsSection />)

    expect(await screen.findByText('0.4.2')).toBeTruthy()
    expect(screen.queryByText('Account workspace')).toBeNull()
    expect(screen.queryByRole('heading', { name: 'Consent' })).toBeNull()

    fireEvent.click(screen.getByRole('button', { name: /add to path/i }))
    await waitFor(() => expect(screen.getByText('~/.local/bin is not writable.')).toBeTruthy())
  })


  it('keeps installed desktop tools available when the active profile is unsupported', async () => {
    withState({ phase: 'unsupported', reason: 'server' })
    render(<LocalDevSettingsSection />)

    expect(await screen.findByText('0.4.2')).toBeTruthy()
    expect(screen.getByRole('button', { name: /add to path/i })).toBeTruthy()
    expect(screen.queryByText(/This Cinna server/)).toBeNull()
  })

  it('directs setup to the profile when no desktop CLI is installed', async () => {
    getManagedCli.mockResolvedValue(null)
    withState({ phase: 'idle' })
    render(<LocalDevSettingsSection />)

    expect(await screen.findByText(/Set it up under Profile/)).toBeTruthy()
    expect(screen.queryByRole('button', { name: /add to path/i })).toBeNull()
  })

  it('surfaces a rejected PATH IPC call inline', async () => {
    addToPath.mockRejectedValue(new Error('Session not activated'))
    withState({ phase: 'idle' })
    render(<LocalDevSettingsSection />)
    fireEvent.click(await screen.findByRole('button', { name: /add to path/i }))
    expect(await screen.findByText('Session not activated')).toBeTruthy()
  })

})
