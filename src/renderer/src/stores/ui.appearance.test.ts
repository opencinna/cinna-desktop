import { beforeEach, describe, expect, it, vi } from 'vitest'

const system = vi.hoisted(() => {
  const events = new EventTarget()
  const state = { dark: false, events }
  window.matchMedia = vi.fn(() => ({
    get matches() { return state.dark },
    addEventListener: events.addEventListener.bind(events),
    removeEventListener: events.removeEventListener.bind(events)
  })) as unknown as typeof window.matchMedia
  window.api = { app: { setTheme: vi.fn().mockResolvedValue({ success: true }) } } as unknown as typeof window.api
  return state
})

import { useUIStore } from './ui.store'

beforeEach(() => {
  system.dark = false
  useUIStore.getState().setThemePreference('dark')
  useUIStore.getState().setExtraUIAnimation(true)
})

describe('appearance preferences', () => {
  it('enables extra animation by default and persists the off setting', () => {
    expect(useUIStore.getInitialState().extraUIAnimation).toBe(true)
    useUIStore.getState().setExtraUIAnimation(false)
    expect(useUIStore.getState().extraUIAnimation).toBe(false)
    expect(localStorage.getItem('cinna-extra-ui-animation')).toBe('0')
  })

  it('follows live OS changes only while System is selected', () => {
    useUIStore.getState().setThemePreference('system')
    expect(useUIStore.getState().theme).toBe('light')
    system.dark = true
    system.events.dispatchEvent(new Event('change'))
    expect(useUIStore.getState().theme).toBe('dark')
    expect(document.documentElement.dataset.theme).toBe('dark')
    expect(localStorage.getItem('cinna-theme')).toBe('system')
    expect(window.api.app.setTheme).toHaveBeenLastCalledWith('dark')

    useUIStore.getState().setThemePreference('light')
    system.events.dispatchEvent(new Event('change'))
    expect(useUIStore.getState().theme).toBe('light')
  })

  it('makes the footer shortcut choose the opposite fixed theme from System', () => {
    useUIStore.getState().setThemePreference('system')
    useUIStore.getState().toggleTheme()
    expect(useUIStore.getState().themePreference).toBe('dark')
    expect(localStorage.getItem('cinna-theme')).toBe('dark')
    useUIStore.getState().toggleTheme()
    expect(useUIStore.getState().themePreference).toBe('light')
  })

  it('syncs preferences changed in another app window', () => {
    localStorage.setItem('cinna-theme', 'system')
    window.dispatchEvent(new StorageEvent('storage', { key: 'cinna-theme' }))
    expect(useUIStore.getState().themePreference).toBe('system')
    expect(useUIStore.getState().theme).toBe('light')
    localStorage.setItem('cinna-extra-ui-animation', '0')
    window.dispatchEvent(new StorageEvent('storage', { key: 'cinna-extra-ui-animation' }))
    expect(useUIStore.getState().extraUIAnimation).toBe(false)
  })
})

// Last in the file: the fresh store modules imported below install their own
// window listeners, and nothing after them should share a window with them.
describe('sidebar open state', () => {
  it('starts open when nothing is stored', async () => {
    localStorage.removeItem('cinna-sidebar-open')
    vi.resetModules()
    const { useUIStore: freshStore } = await import('./ui.store')
    expect(freshStore.getState().sidebarOpen).toBe(true)
  })

  it('writes the key on every toggle', () => {
    useUIStore.setState({ sidebarOpen: true })
    useUIStore.getState().toggleSidebar()
    expect(useUIStore.getState().sidebarOpen).toBe(false)
    expect(localStorage.getItem('cinna-sidebar-open')).toBe('0')
    useUIStore.getState().toggleSidebar()
    expect(useUIStore.getState().sidebarOpen).toBe(true)
    expect(localStorage.getItem('cinna-sidebar-open')).toBe('1')
  })

  it('starts closed after it was closed, and still starts on the new-chat screen', async () => {
    localStorage.setItem('cinna-sidebar-open', '0')
    vi.resetModules()
    const { useUIStore: freshStore } = await import('./ui.store')
    const state = freshStore.getState()
    expect(state.sidebarOpen).toBe(false)
    expect(state.activeView).toBe('chat')
    expect(state.sidebarTab).toBe('chats')
    localStorage.removeItem('cinna-sidebar-open')
  })
})
