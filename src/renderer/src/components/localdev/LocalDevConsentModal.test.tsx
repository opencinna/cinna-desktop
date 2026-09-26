/**
 * Local development is asked about only when the user goes looking: the
 * sidebar button opens the question, and nothing else does. A modal that
 * popped up by itself is the regression these guard against.
 */
import { act, fireEvent, render, screen } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { useLocalDevStore } from '../../stores/localDev.store'
import { useUIStore } from '../../stores/ui.store'
import type { LocalDevState } from '../../../../shared/localDevState'
import { LocalDevConsentModal } from './LocalDevConsentModal'
import { LocalDevStatusButton } from './LocalDevStatusButton'

const HOST = 'cinna.example.com'
let consent = vi.fn()

function renderShell() {
  return render(<><LocalDevStatusButton /><LocalDevConsentModal /></>)
}

beforeEach(() => {
  consent = vi.fn(() => new Promise<LocalDevState>(() => undefined))
  window.api = {
    localDev: { consent },
    logger: { log: vi.fn().mockResolvedValue(undefined) },
    localAgents: { homeState: vi.fn().mockResolvedValue({ path: '/home/agents' }) }
  } as unknown as typeof window.api
  useLocalDevStore.setState({ state: { phase: 'consent', host: HOST }, subscribed: true, consentOpen: false, pageMode: 'settings' })
  useUIStore.setState({ activeView: 'chat' })
})

describe('local development consent', () => {
  it('is not shown until the sidebar button is clicked', () => {
    renderShell()
    expect(screen.queryByRole('dialog')).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: 'Set up local development' }))
    expect(screen.getByRole('dialog', { name: 'Set up local development' })).toBeTruthy()
  })

  it('offers the button after a decline too', () => {
    useLocalDevStore.setState({ state: { phase: 'declined', host: HOST } })
    renderShell()
    fireEvent.click(screen.getByRole('button', { name: 'Set up local development' }))
    expect(screen.getByRole('dialog')).toBeTruthy()
  })

  it.each(['idle', 'unsupported'] as const)('has no button while %s', (phase) => {
    useLocalDevStore.setState({ state: phase === 'idle' ? { phase } : { phase, reason: 'server' } })
    renderShell()
    expect(screen.queryByRole('button')).toBeNull()
  })

  it('Not now closes without recording an answer', () => {
    renderShell()
    fireEvent.click(screen.getByRole('button', { name: 'Set up local development' }))
    fireEvent.click(screen.getByRole('button', { name: 'Not now' }))
    expect(screen.queryByRole('dialog')).toBeNull()
    expect(consent).not.toHaveBeenCalled()
    expect(screen.getByRole('button', { name: 'Set up local development' })).toBeTruthy()
  })

  it('Escape closes without recording an answer', () => {
    renderShell()
    fireEvent.click(screen.getByRole('button', { name: 'Set up local development' }))
    fireEvent.keyDown(window, { key: 'Escape' })
    expect(screen.queryByRole('dialog')).toBeNull()
    expect(consent).not.toHaveBeenCalled()
  })

  it('Set up records consent and hands over to the page once setup starts', () => {
    renderShell()
    fireEvent.click(screen.getByRole('button', { name: 'Set up local development' }))
    fireEvent.click(screen.getByRole('button', { name: 'Set up' }))
    expect(consent).toHaveBeenCalledWith(HOST, true)
    // Still waiting on main: the modal stays, locked, rather than closing onto nothing.
    expect(screen.getByRole('dialog')).toBeTruthy()
    expect((screen.getByRole('button', { name: 'Not now' }) as HTMLButtonElement).disabled).toBe(true)

    act(() => useLocalDevStore.getState().set({ phase: 'installing', step: 'Downloading uv' }))
    expect(screen.queryByRole('dialog')).toBeNull()
    expect(useUIStore.getState().activeView).toBe('local-development')
    expect(useLocalDevStore.getState().pageMode).toBe('chat')
  })

  it('keeps the modal open with the refusal when main rejects the answer', async () => {
    consent.mockRejectedValueOnce(new Error('Error invoking remote method: Error: Sign in again first.'))
    renderShell()
    fireEvent.click(screen.getByRole('button', { name: 'Set up local development' }))
    fireEvent.click(screen.getByRole('button', { name: 'Set up' }))
    expect(screen.getByRole('button', { name: 'Starting…' })).toBeTruthy()
    expect((await screen.findByRole('alert')).textContent).toContain('Sign in again first.')
    expect(screen.getByRole('dialog')).toBeTruthy()
    expect((screen.getByRole('button', { name: 'Set up' }) as HTMLButtonElement).disabled).toBe(false)
  })

  it('does not close on a press that began inside the dialog', () => {
    renderShell()
    fireEvent.click(screen.getByRole('button', { name: 'Set up local development' }))
    const backdrop = screen.getByRole('dialog')
    fireEvent.mouseDown(screen.getByText('Set up local development?'))
    fireEvent.click(backdrop)
    expect(screen.getByRole('dialog')).toBeTruthy()
    fireEvent.mouseDown(backdrop)
    fireEvent.click(backdrop)
    expect(screen.queryByRole('dialog')).toBeNull()
  })

  it('a profile switch during Set up leaves the next question usable', async () => {
    let reply: (refusal: string) => void = () => undefined
    consent.mockReturnValueOnce(new Promise((_, reject) => { reply = (m) => reject(new Error(m)) }))
    renderShell()
    fireEvent.click(screen.getByRole('button', { name: 'Set up local development' }))
    fireEvent.click(screen.getByRole('button', { name: 'Set up' }))
    act(() => useLocalDevStore.getState().set({ phase: 'idle' }))
    act(() => useLocalDevStore.getState().set({ phase: 'consent', host: 'other.example.com' }))
    // The first profile's refusal lands late, after the switch.
    await act(async () => reply('Old profile deactivated'))
    fireEvent.click(screen.getByRole('button', { name: 'Set up local development' }))
    expect((screen.getByRole('button', { name: 'Not now' }) as HTMLButtonElement).disabled).toBe(false)
    expect(screen.queryByRole('alert')).toBeNull()
    fireEvent.keyDown(window, { key: 'Escape' })
    expect(screen.queryByRole('dialog')).toBeNull()
  })

  it('closes, without navigating, when the profile changes under it', () => {
    renderShell()
    fireEvent.click(screen.getByRole('button', { name: 'Set up local development' }))
    act(() => useLocalDevStore.getState().set({ phase: 'idle' }))
    act(() => useLocalDevStore.getState().set({ phase: 'consent', host: 'other.example.com' }))
    expect(screen.queryByRole('dialog')).toBeNull()
    expect(useUIStore.getState().activeView).toBe('chat')
  })
})
