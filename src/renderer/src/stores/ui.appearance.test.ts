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

import { selectSidebarVisible, useUIStore } from './ui.store'
import { readThemePreference } from '../utils/theme'

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

  it('defaults to System when nothing valid is saved', () => {
    localStorage.removeItem('cinna-theme')
    expect(readThemePreference()).toBe('system')
    localStorage.setItem('cinna-theme', 'bogus')
    expect(readThemePreference()).toBe('system')
    localStorage.setItem('cinna-theme', 'dark')
    expect(readThemePreference()).toBe('dark')
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

describe('sidebar docking', () => {
  beforeEach(() => {
    localStorage.removeItem('cinna-sidebar-docking')
    useUIStore.setState({ sidebarDocking: 'fixed', sidebarPeek: false, sidebarOpen: true })
  })

  it('defaults to fixed and follows the open state there', () => {
    expect(useUIStore.getInitialState().sidebarDocking).toBe('fixed')
    expect(selectSidebarVisible(useUIStore.getState())).toBe(true)
    useUIStore.getState().toggleSidebar()
    expect(selectSidebarVisible(useUIStore.getState())).toBe(false)
  })

  it('hides into hover mode without touching the fixed open state, and is shown only by a peek', () => {
    useUIStore.getState().setSidebarDocking('hover')
    let state = useUIStore.getState()
    expect(localStorage.getItem('cinna-sidebar-docking')).toBe('hover')
    expect(state.sidebarOpen).toBe(true)
    expect(state.sidebarPeek).toBe(false)
    expect(selectSidebarVisible(state)).toBe(false)
    state.setSidebarPeek(true)
    expect(selectSidebarVisible(useUIStore.getState())).toBe(true)
    // Switching back is docking it: open, persisted, peek gone.
    useUIStore.setState({ sidebarOpen: false })
    localStorage.setItem('cinna-sidebar-open', '0')
    useUIStore.getState().setSidebarDocking('fixed')
    state = useUIStore.getState()
    expect(state.sidebarDocking).toBe('fixed')
    expect(state.sidebarOpen).toBe(true)
    expect(state.sidebarPeek).toBe(false)
    expect(localStorage.getItem('cinna-sidebar-open')).toBe('1')
    expect(localStorage.getItem('cinna-sidebar-docking')).toBe('fixed')
  })

  it('reveals by opening in fixed mode and by peeking in hover mode', () => {
    useUIStore.setState({ sidebarOpen: false })
    useUIStore.getState().revealSidebar()
    expect(useUIStore.getState().sidebarOpen).toBe(true)
    expect(localStorage.getItem('cinna-sidebar-open')).toBe('1')

    useUIStore.getState().setSidebarDocking('hover')
    useUIStore.setState({ sidebarOpen: false })
    useUIStore.getState().revealSidebar()
    expect(useUIStore.getState().sidebarPeek).toBe(true)
    expect(useUIStore.getState().sidebarOpen).toBe(false)
  })

  it('syncs a docking change made in another app window', () => {
    useUIStore.setState({ sidebarPeek: true })
    localStorage.setItem('cinna-sidebar-docking', 'hover')
    window.dispatchEvent(new StorageEvent('storage', { key: 'cinna-sidebar-docking' }))
    expect(useUIStore.getState().sidebarDocking).toBe('hover')
    expect(useUIStore.getState().sidebarPeek).toBe(false)
  })

  it('docks open when another window switches to fixed, and writes the open key first', () => {
    useUIStore.setState({ sidebarDocking: 'hover', sidebarOpen: false })
    localStorage.setItem('cinna-sidebar-open', '0')
    const order: string[] = []
    const setItem = vi.spyOn(Storage.prototype, 'setItem').mockImplementation(function (this: Storage, key: string) {
      order.push(key)
    })
    useUIStore.getState().setSidebarDocking('fixed')
    setItem.mockRestore()
    expect(order).toEqual(['cinna-sidebar-open', 'cinna-sidebar-docking'])

    // The other window, where the open key still reads closed.
    useUIStore.setState({ sidebarDocking: 'hover', sidebarOpen: false })
    localStorage.setItem('cinna-sidebar-docking', 'fixed')
    window.dispatchEvent(new StorageEvent('storage', { key: 'cinna-sidebar-docking' }))
    expect(useUIStore.getState().sidebarDocking).toBe('fixed')
    expect(useUIStore.getState().sidebarOpen).toBe(true)
  })

  it('starts in the stored mode, never peeking', async () => {
    localStorage.setItem('cinna-sidebar-docking', 'hover')
    vi.resetModules()
    const { useUIStore: freshStore } = await import('./ui.store')
    expect(freshStore.getState().sidebarDocking).toBe('hover')
    expect(freshStore.getState().sidebarPeek).toBe(false)
    localStorage.removeItem('cinna-sidebar-docking')
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
