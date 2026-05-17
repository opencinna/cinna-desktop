import { create } from 'zustand'

export type ActiveView = 'chat' | 'settings'
export type SettingsMenu =
  | 'chats'
  | 'llm'
  | 'mcp'
  | 'agents'
  | 'accounts'
  | 'development'
  | 'profile-agents'
  | 'trash'

/**
 * Tabs that live in the "Profile" sidebar group — only valid when the active
 * profile renders that group (currently: Cinna users). Switching to a profile
 * without them should snap the sidebar back to a default-scope tab.
 */
export const PROFILE_SCOPE_TABS: readonly SettingsMenu[] = ['profile-agents']
export type Theme = 'dark' | 'light'

const VERBOSE_KEY = 'cinna-verbose-mode'

interface UIStore {
  activeView: ActiveView
  settingsTab: SettingsMenu
  sidebarOpen: boolean
  theme: Theme
  logsOpen: boolean
  agentStatusOpen: boolean
  pendingAgentId: string | null
  verboseMode: boolean
  setActiveView: (view: ActiveView) => void
  setSettingsMenu: (tab: SettingsMenu) => void
  toggleSidebar: () => void
  toggleTheme: () => void
  setLogsOpen: (open: boolean) => void
  setAgentStatusOpen: (open: boolean) => void
  setPendingAgentId: (id: string | null) => void
  toggleVerboseMode: () => void
}

export const useUIStore = create<UIStore>((set) => ({
  activeView: 'chat',
  settingsTab: 'chats',
  sidebarOpen: true,
  theme: (localStorage.getItem('cinna-theme') as Theme) || 'dark',
  logsOpen: false,
  agentStatusOpen: false,
  pendingAgentId: null,
  verboseMode: localStorage.getItem(VERBOSE_KEY) === '1',
  setActiveView: (view) => set({ activeView: view }),
  setSettingsMenu: (tab) => set({ settingsTab: tab }),
  toggleSidebar: () => set((state) => ({ sidebarOpen: !state.sidebarOpen })),
  toggleTheme: () =>
    set((state) => {
      const next = state.theme === 'dark' ? 'light' : 'dark'
      localStorage.setItem('cinna-theme', next)
      document.documentElement.setAttribute('data-theme', next)
      window.api.app.setTheme(next).catch(() => {})
      return { theme: next }
    }),
  setLogsOpen: (open) => set({ logsOpen: open }),
  setAgentStatusOpen: (open) => set({ agentStatusOpen: open }),
  setPendingAgentId: (id) => set({ pendingAgentId: id }),
  toggleVerboseMode: () =>
    set((state) => {
      const next = !state.verboseMode
      localStorage.setItem(VERBOSE_KEY, next ? '1' : '0')
      return { verboseMode: next }
    })
}))

// Apply theme on load
const savedTheme = (localStorage.getItem('cinna-theme') as Theme) || 'dark'
document.documentElement.setAttribute('data-theme', savedTheme)
window.api.app.setTheme(savedTheme).catch(() => {})
