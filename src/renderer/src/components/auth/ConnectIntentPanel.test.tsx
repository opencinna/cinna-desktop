import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { describe, expect, it, vi, beforeEach } from 'vitest'
import type { ConnectIntent } from '../../../../shared/connectIntent'

/**
 * The panel is the security boundary of the `cinna://connect` deep link, and it
 * now also carries the local-development answer. Both halves are asserted here
 * for the same reason: they are decisions taken on the user's behalf if the
 * wiring quietly breaks — a connect that never records the answer sends them
 * back to a consent step that first run is supposed to have removed, and a
 * "Not now" that stops being reachable removes the only way to refuse.
 */
const registerMutate = vi.fn(async () => ({ success: true }))
const loginMutate = vi.fn(async () => ({ success: true }))

/** Profiles on this machine. Empty is a genuine first run. */
let users: { id: string; type: string; cinnaServerUrl?: string }[] = []

vi.mock('../../hooks/useAuth', () => ({
  useRegister: () => ({ mutateAsync: registerMutate, isPending: false }),
  useLogin: () => ({ mutateAsync: loginMutate, isPending: false }),
  useUsers: () => ({ data: users }),
  useCinnaOAuthAbort: () => ({ mutate: vi.fn() })
}))

const consent = vi.fn(async () => undefined)
/** What this machine has already answered, per host. Empty by default. */
let storedConsent: Record<string, boolean> = {}

;(window as unknown as { api: Record<string, unknown> }).api = {
  localDev: {
    getState: async () => ({ phase: 'idle' }),
    onState: () => () => undefined,
    getConsent: async () => storedConsent
  },
  // The panel names the agents folder in its (?) copy. It reads the path, and
  // deliberately does not create it — asking used to go through the roots list,
  // which scaffolds the folder and raises the macOS Documents prompt mid
  // sign-in.
  localAgents: {
    homeState: async () => ({
      path: '/Users/test/Documents/CinnaAgents',
      access: 'ready',
      guarded: true
    })
  }
}

const { ConnectIntentPanel } = await import('./ConnectIntentPanel')
const { useLocalDevStore } = await import('../../stores/localDev.store')

const INTENT: ConnectIntent = {
  serverUrl: 'https://cinna.example.com',
  receivedAt: 1
} as ConnectIntent

beforeEach(() => {
  users = []
  storedConsent = {}
  registerMutate.mockClear()
  loginMutate.mockClear()
  consent.mockClear()
  useLocalDevStore.setState({ consent } as never)
})

describe('ConnectIntentPanel', () => {
  it('shows the server URL, and offers local development ticked', () => {
    render(<ConnectIntentPanel intent={INTENT} onDone={vi.fn()} />)
    expect(screen.getByText('Connect to cinna.example.com?')).toBeTruthy()
    expect(screen.getByText('https://cinna.example.com')).toBeTruthy()
    expect(screen.getByRole('checkbox', { name: /local development/i })).toHaveProperty(
      'checked',
      true
    )
    // Declining stays reachable, quietly.
    expect(screen.getByRole('button', { name: 'Not now' })).toBeTruthy()
  })

  it('records the ticked answer for the host, so nothing asks again after sign-in', async () => {
    const onDone = vi.fn()
    render(<ConnectIntentPanel intent={INTENT} onDone={onDone} />)
    fireEvent.click(screen.getByRole('button', { name: 'Connect' }))

    await waitFor(() => expect(onDone).toHaveBeenCalledWith('connected'))
    expect(registerMutate).toHaveBeenCalled()
    // The host, not the origin: it is what the reconciler keys consent on.
    expect(consent).toHaveBeenCalledWith('cinna.example.com', true)
  })

  it('records an unticked box as a decline rather than as no answer', async () => {
    render(<ConnectIntentPanel intent={INTENT} onDone={vi.fn()} />)
    fireEvent.click(screen.getByRole('checkbox', { name: /local development/i }))
    fireEvent.click(screen.getByRole('button', { name: 'Connect' }))
    await waitFor(() => expect(consent).toHaveBeenCalledWith('cinna.example.com', false))
  })

  it('does not record anything when the link is refused', async () => {
    const onDone = vi.fn()
    render(<ConnectIntentPanel intent={INTENT} onDone={onDone} />)
    fireEvent.click(screen.getByRole('button', { name: 'Not now' }))
    expect(registerMutate).not.toHaveBeenCalled()
    expect(consent).not.toHaveBeenCalled()
    expect(onDone).toHaveBeenCalledWith('declined')
  })

  it('does not re-tick a box this machine has already unticked for the host', async () => {
    // "Switch to it" can name a profile whose owner declined local development
    // on purpose. Re-ticking it would spend a few hundred megabytes undoing a
    // deliberate decision.
    // A machine that has profiles: on a genuine first run there is nothing to
    // read and the channel would refuse the question anyway.
    users = [{ id: 'u1', type: 'cinna_user', cinnaServerUrl: 'https://other.example.com' }]
    storedConsent = { 'cinna.example.com': false }
    render(<ConnectIntentPanel intent={INTENT} onDone={vi.fn()} />)
    await waitFor(() =>
      expect(screen.getByRole('checkbox', { name: /local development/i })).toHaveProperty(
        'checked',
        false
      )
    )
  })

  it('explains what will be installed, behind the (?)', async () => {
    render(<ConnectIntentPanel intent={INTENT} onDone={vi.fn()} />)
    expect(screen.queryByText(/inside Cinna’s own data folder/)).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: /what local development installs/i }))
    await waitFor(() => expect(screen.getByText(/inside Cinna’s own data folder/)).toBeTruthy())
  })
})
