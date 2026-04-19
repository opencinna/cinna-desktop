import { create } from 'zustand'

export type ActiveView = 'chat' | 'settings'
export type SettingsMenu =
  | 'chats'
  | 'llm'
  | 'mcp'
  | 'agents'
  | 'accounts'
  | 'development'
  | 'trash'
export type Theme = 'dark' | 'light'

const LOGGER_KEY = 'cinna-logger-enabled'
const VERBOSE_KEY = 'cinna-verbose-mode'

interface UIStore {
  activeView: ActiveView
  settingsTab: SettingsMenu
  sidebarOpen: boolean
  theme: Theme
  loggerEnabled: boolean
  logsOpen: boolean
  agentStatusOpen: boolean
  pendingAgentId: string | null
  verboseMode: boolean
  setActiveView: (view: ActiveView) => void
  setSettingsMenu: (tab: SettingsMenu) => void
  toggleSidebar: () => void
  toggleTheme: () => void
  setLoggerEnabled: (enabled: boolean) => void
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
  loggerEnabled: localStorage.getItem(LOGGER_KEY) === '1',
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
      return { theme: next }
    }),
  setLoggerEnabled: (enabled) => {
    localStorage.setItem(LOGGER_KEY, enabled ? '1' : '0')
    set((state) => ({ loggerEnabled: enabled, logsOpen: enabled ? state.logsOpen : false }))
  },
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
const savedTheme = localStorage.getItem('cinna-theme') || 'dark'
document.documentElement.setAttribute('data-theme', savedTheme)
