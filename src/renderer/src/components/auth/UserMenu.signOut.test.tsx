import { act, fireEvent, render, screen, within } from '@testing-library/react'
import { useState } from 'react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { AuthUser } from '../../stores/auth.store'

/**
 * The profile menu's Sign Out dialog. For a Cinna account a switch, "Delete data from this
 * device", picks between today's delete (on, the default every time it opens) and a sign-out that
 * keeps the profile and its data (off: no password, `auth.logout({ userId })`). A local profile has
 * no switch: Remove Account is always a delete. The dropdown marks a token-less Cinna profile.
 */

const hooks = vi.hoisted(() => ({
  deleteUser: vi.fn(),
  logout: vi.fn(),
  users: [] as unknown[],
  sync: { initialized: true, disconnected: false } as unknown
}))

vi.mock('../../hooks/useAuth', () => ({
  useUsers: () => ({ data: hooks.users }),
  useDeleteUser: () => ({ mutateAsync: hooks.deleteUser, isPending: false }),
  useLogout: () => ({ mutateAsync: hooks.logout, isPending: false })
}))
vi.mock('../../hooks/useSync', () => ({
  useSyncState: () => ({ data: hooks.sync, isLoading: false })
}))
vi.mock('./RegisterForm', () => ({ RegisterForm: () => null }))
vi.mock('./useSwitchProfile', () => ({
  useSwitchProfile: () => ({ switchTo: vi.fn(), pending: false, error: null, prompt: null, cancelPrompt: () => {} })
}))
vi.mock('../ui/usePopover', () => ({
  usePopover: () => {
    const [open, setOpen] = useState(false)
    return { open, setOpen, triggerRef: { current: null }, popoverRef: { current: null }, style: {} }
  }
}))

const { UserMenu } = await import('./UserMenu')
const { useAuthStore } = await import('../../stores/auth.store')

const cinna = (over: Partial<AuthUser> = {}): AuthUser => ({
  id: 'alice', type: 'cinna_user', username: 'alice@corp.test', displayName: 'alice',
  cinnaFullName: 'Alice Smith', hasPassword: false, hasCinnaTokens: true, ...over
})

function openSignOut(user: AuthUser): void {
  useAuthStore.setState({ currentUser: user })
  hooks.users = [user]
  render(<UserMenu />)
  fireEvent.click(screen.getByTitle(user.cinnaFullName ?? user.displayName))
  fireEvent.click(screen.getByRole('button', { name: 'Sign Out' }))
}

const confirmButton = (): HTMLElement => screen.getAllByRole('button', { name: /^Sign Out$|^Remove Account$/ }).at(-1)!

beforeEach(() => {
  hooks.deleteUser.mockReset().mockResolvedValue({ success: true })
  hooks.logout.mockReset().mockResolvedValue({ success: true })
  hooks.sync = { initialized: true, disconnected: false }
})

describe('Sign Out of a Cinna account', () => {
  it('opens with "Delete data from this device" on, and deletes as before', async () => {
    openSignOut(cinna({ hasPassword: true }))
    const toggle = screen.getByRole('switch', { name: 'Delete data from this device' })
    expect(toggle.getAttribute('aria-checked')).toBe('true')
    const password = screen.getByPlaceholderText('Password')
    expect(screen.getByText('This device will be removed from your account.')).toBeTruthy()
    expect(screen.queryByText(/Its chats, agents and settings stay on this device/)).toBeNull()

    fireEvent.change(password, { target: { value: 'secret' } })
    await act(async () => { fireEvent.click(confirmButton()) })
    expect(hooks.deleteUser).toHaveBeenCalledExactlyOnceWith({ userId: 'alice', password: 'secret', signOut: true, removeDevice: true })
    expect(hooks.logout).not.toHaveBeenCalled()
  })

  it('off: hides the password and the device warning, and signs out with the profile kept', async () => {
    openSignOut(cinna({ hasPassword: true }))
    fireEvent.click(screen.getByRole('switch', { name: 'Delete data from this device' }))
    expect(screen.getByRole('switch', { name: 'Delete data from this device' }).getAttribute('aria-checked')).toBe('false')
    expect(screen.queryByPlaceholderText('Password')).toBeNull()
    expect(screen.queryByText('This device will be removed from your account.')).toBeNull()
    expect(screen.getByText(/Its chats, agents and settings stay on this device/)).toBeTruthy()
    expect(screen.getByText('Its local password still locks it on this device.')).toBeTruthy()

    await act(async () => { fireEvent.click(confirmButton()) })
    expect(hooks.logout).toHaveBeenCalledExactlyOnceWith({ userId: 'alice' })
    expect(hooks.deleteUser).not.toHaveBeenCalled()
  })

  it('off without a local password: warns that anyone on this computer can open it', () => {
    openSignOut(cinna())
    fireEvent.click(screen.getByRole('switch', { name: 'Delete data from this device' }))
    expect(screen.getByText(/Anyone who uses this computer can open this profile/)).toBeTruthy()
    expect(screen.queryByText('Its local password still locks it on this device.')).toBeNull()
  })

  it('says a refused keep-data sign-out inline and stays open', async () => {
    hooks.logout.mockResolvedValue({ success: false, error: 'Only the current profile can be signed out' })
    openSignOut(cinna())
    fireEvent.click(screen.getByRole('switch', { name: 'Delete data from this device' }))
    await act(async () => { fireEvent.click(confirmButton()) })
    expect(screen.getByText('Only the current profile can be signed out')).toBeTruthy()
    expect(screen.getByRole('switch', { name: 'Delete data from this device' })).toBeTruthy()
  })

  it('turns the switch back on each time the dialog opens', () => {
    openSignOut(cinna())
    fireEvent.click(screen.getByRole('switch', { name: 'Delete data from this device' }))
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }))
    fireEvent.click(screen.getByTitle('Alice Smith'))
    fireEvent.click(screen.getByRole('button', { name: 'Sign Out' }))
    expect(screen.getByRole('switch', { name: 'Delete data from this device' }).getAttribute('aria-checked')).toBe('true')
  })
})

describe('Sign Out of a local profile', () => {
  it('has no switch and removes the account as before', async () => {
    openSignOut({ id: 'bob', type: 'local_user', username: 'bob', displayName: 'Bob', hasPassword: false })
    expect(screen.queryByRole('switch')).toBeNull()
    await act(async () => { fireEvent.click(confirmButton()) })
    expect(hooks.deleteUser).toHaveBeenCalledExactlyOnceWith({ userId: 'bob', password: undefined, signOut: true, removeDevice: undefined })
    expect(hooks.logout).not.toHaveBeenCalled()
  })
})

describe('the profile list', () => {
  it('tags a Cinna profile without tokens as signed out', () => {
    useAuthStore.setState({ currentUser: cinna() })
    hooks.users = [cinna(), cinna({ id: 'carol', displayName: 'carol', cinnaFullName: 'Carol', hasCinnaTokens: false })]
    render(<UserMenu />)
    fireEvent.click(screen.getByTitle('Alice Smith'))
    const row = (name: string): HTMLElement => screen.getAllByText(name).map((el) => el.closest('button')!).at(-1)!
    expect(within(row('Carol')).getByText('Signed out')).toBeTruthy()
    expect(within(row('Alice Smith')).queryByText('Signed out')).toBeNull()
    expect(screen.getAllByText('Signed out')).toHaveLength(1)
  })
})
