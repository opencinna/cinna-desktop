import { render, screen, waitFor, fireEvent } from '@testing-library/react'
import { describe, expect, it, vi, beforeEach } from 'vitest'
import type { LocalDevState } from '../../../../shared/localDevState'

/**
 * Settings → Local Development, phase by phase.
 *
 * The phases this pins are the ones where being wrong is expensive: a role gate
 * that must not offer a button which cannot work, a toolchain failure that must
 * say updating the app is the fix, and the PATH opt-in whose refusal reason is
 * written for the user and must therefore reach them rather than a log line.
 */

const addToPath = vi.fn()

;(window as unknown as { api: Record<string, unknown> }).api = {
  app: { setTheme: async () => undefined },
  localDev: {
    getState: async () => ({ phase: 'idle' }) as LocalDevState,
    onState: () => () => undefined,
    addToPath
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
})

describe('LocalDevSettingsSection', () => {
  it('explains the role gate and offers nothing to press', () => {
    withState({ phase: 'unsupported', reason: 'role' })
    render(<LocalDevSettingsSection />)

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
    render(<LocalDevSettingsSection />)

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
    render(<LocalDevSettingsSection />)

    expect(screen.getByText(/older than the machine-readable protocol/i)).toBeTruthy()
    expect(screen.getByText(/expired account token cannot be refreshed on its own/i)).toBeTruthy()
    // Still ready: no warning icon, no attention copy.
    expect(screen.queryByText(/needs attention/i)).toBeNull()
  })

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

    expect(screen.getByText('/Users/x/Agents/Cloud/cinna.example.com')).toBeTruthy()
    expect(screen.getByText('0.4.2')).toBeTruthy()

    fireEvent.click(screen.getByRole('button', { name: /add to path/i }))
    await waitFor(() => expect(screen.getByText('~/.local/bin is not writable.')).toBeTruthy())
  })

  it('reports progress while installing', () => {
    withState({ phase: 'installing', step: 'Downloading cinna-cli', percent: 40 })
    render(<LocalDevSettingsSection />)

    expect(screen.getByText('Downloading cinna-cli')).toBeTruthy()
    expect(screen.getByRole('progressbar').getAttribute('aria-valuenow')).toBe('40')
  })
})
