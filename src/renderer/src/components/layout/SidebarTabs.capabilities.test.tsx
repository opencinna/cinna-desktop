import { act, render, screen } from '@testing-library/react'
import { createElement } from 'react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

/**
 * The tab rail with Notes and Dashboards optional (ux rule 15), and in
 * Settings, where it stays — dimmed, nothing selected — as a way out besides
 * Back (ux rule 17).
 */

// Main's app settings, as `useCapabilities` reads them (`'on'` only).
const capabilities = vi.hoisted(() => ({ notesEnabled: true, dashboardsEnabled: true, loaded: true }))
vi.mock('../../hooks/useCapabilities', () => ({ useCapabilities: () => capabilities }))

vi.mock('../../hooks/useChat', () => ({
  useChatList: () => ({ data: [{ id: 'first-chat' }, { id: 'other-chat' }] })
}))

;(window as unknown as { api: Record<string, unknown> }).api = {
  app: { setTheme: async () => undefined }
}

const { SidebarTabs } = await import('./SidebarTabs')
const { useUIStore, disabledCapabilityOnScreen } = await import('../../stores/ui.store')
const { useChatStore } = await import('../../stores/chat.store')

const tabNames = (): string[] =>
  screen.getAllByRole('button').map((button) => button.getAttribute('aria-label') ?? '')

beforeEach(() => {
  Object.assign(capabilities, { notesEnabled: true, dashboardsEnabled: true, loaded: true })
  useUIStore.setState({ activeView: 'chat', sidebarTab: 'chats' } as never)
  useChatStore.setState({ activeChatId: 'other-chat' } as never)
})

describe('the optional tabs', () => {
  it('orders the rail Chats, Jobs, Agents, Notes, Dashboards', () => {
    render(createElement(SidebarTabs))
    expect(tabNames()).toEqual(['Chats', 'Jobs', 'Agents', 'Notes', 'Dashboards'])
  })

  it('shows neither while off (main’s undecided reads as off too)', () => {
    Object.assign(capabilities, { notesEnabled: false, dashboardsEnabled: false })
    render(createElement(SidebarTabs))
    expect(tabNames()).toEqual(['Chats', 'Jobs', 'Agents'])
  })

  it('leaves a section for Chats, and its chat, when it is turned off while open', () => {
    // Mutation: drop the fallback effect and the Notes list stays in the
    // sidebar with no tab to say so.
    useUIStore.setState({ activeView: 'note-detail', sidebarTab: 'notes', activeNoteId: 'n1' } as never)
    const { rerender } = render(createElement(SidebarTabs))
    capabilities.notesEnabled = false
    act(() => rerender(createElement(SidebarTabs)))
    expect(useUIStore.getState()).toMatchObject({ sidebarTab: 'chats', activeView: 'chat' })
    expect(useChatStore.getState().activeChatId).toBe('other-chat')
    expect(tabNames()).toEqual(['Chats', 'Jobs', 'Agents', 'Dashboards'])
  })

  it('leaves the dashboard view on startup when Dashboards is off', () => {
    capabilities.dashboardsEnabled = false
    useUIStore.setState({ activeView: 'dashboard', sidebarTab: 'dashboards' } as never)
    render(createElement(SidebarTabs))
    expect(useUIStore.getState()).toMatchObject({ sidebarTab: 'chats', activeView: 'chat' })
  })

  it('leaves nothing before the settings have loaded, which is not an answer', () => {
    // Mutation: drop the `loaded` guard and a launch leaves the open section
    // before main has said it is on.
    Object.assign(capabilities, { notesEnabled: false, dashboardsEnabled: false, loaded: false })
    useUIStore.setState({ activeView: 'dashboard', sidebarTab: 'dashboards' } as never)
    const { rerender } = render(createElement(SidebarTabs))
    expect(useUIStore.getState()).toMatchObject({ sidebarTab: 'dashboards', activeView: 'dashboard' })
    Object.assign(capabilities, { dashboardsEnabled: true, loaded: true })
    act(() => rerender(createElement(SidebarTabs)))
    expect(useUIStore.getState()).toMatchObject({ sidebarTab: 'dashboards', activeView: 'dashboard' })
  })

  it('turned off from Settings, stays in Settings and only moves the tab under it', () => {
    useUIStore.setState({ activeView: 'settings', sidebarTab: 'dashboards' } as never)
    const { rerender } = render(createElement(SidebarTabs))
    capabilities.dashboardsEnabled = false
    act(() => rerender(createElement(SidebarTabs)))
    expect(useUIStore.getState()).toMatchObject({ sidebarTab: 'chats', activeView: 'settings' })
  })
})

describe('disabledCapabilityOnScreen', () => {
  const off = { notesEnabled: false, dashboardsEnabled: false }
  it('names the off capability whose tab or center is on screen, else null', () => {
    expect(disabledCapabilityOnScreen({ ...off, sidebarTab: 'notes', activeView: 'settings' })).toBe('notes')
    expect(disabledCapabilityOnScreen({ ...off, sidebarTab: 'chats', activeView: 'dashboard' })).toBe('dashboards')
    expect(disabledCapabilityOnScreen({ ...off, sidebarTab: 'chats', activeView: 'chat' })).toBeNull()
    expect(disabledCapabilityOnScreen({ notesEnabled: true, dashboardsEnabled: true, sidebarTab: 'notes', activeView: 'note-detail' })).toBeNull()
  })
})

describe('the rail in Settings', () => {
  it('is dimmed with no tab selected, each tab named for leaving Settings', () => {
    useUIStore.setState({ activeView: 'settings', sidebarTab: 'jobs' } as never)
    const { container } = render(createElement(SidebarTabs))
    // The Settings menu beside it has its own Chats and Agents (ux rule 10).
    expect(tabNames()).toEqual(['Open Chats', 'Open Jobs', 'Open Agents', 'Open Notes', 'Open Dashboards'])
    expect(container.querySelector('.app-sidebar-tabs')?.classList.contains('is-dimmed')).toBe(true)
    expect(screen.getAllByRole('button').some((b) => b.getAttribute('aria-pressed') === 'true')).toBe(false)
  })

  it('leaves Settings by the tab that was selected before, keeping the chat', () => {
    // Mutation: drop 'settings' from LEAVABLE_VIEWS and the press is swallowed.
    useUIStore.setState({ activeView: 'settings', sidebarTab: 'chats' } as never)
    render(createElement(SidebarTabs))
    screen.getByRole('button', { name: 'Open Chats' }).click()
    expect(useUIStore.getState().activeView).toBe('chat')
    expect(useChatStore.getState().activeChatId).toBe('other-chat')
  })

  it('leaves Settings for another section', () => {
    useUIStore.setState({ activeView: 'settings', sidebarTab: 'chats', activeJobId: 'j1' } as never)
    render(createElement(SidebarTabs))
    screen.getByRole('button', { name: 'Open Jobs' }).click()
    expect(useUIStore.getState()).toMatchObject({ activeView: 'job-detail', sidebarTab: 'jobs', activeJobId: null })
  })

  it('is not dimmed outside Settings', () => {
    const { container } = render(createElement(SidebarTabs))
    expect(container.querySelector('.app-sidebar-tabs')?.classList.contains('is-dimmed')).toBe(false)
    expect(screen.getByRole('button', { name: 'Chats' }).getAttribute('aria-pressed')).toBe('true')
  })
})
