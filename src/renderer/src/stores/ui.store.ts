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

interface UIStore {
  activeView: ActiveView
  settingsTab: SettingsMenu
  sidebarOpen: boolean
  theme: Theme
  loggerEnabled: boolean
  logsOpen: boolean
  setActiveView: (view: ActiveView) => void
  setSettingsMenu: (tab: SettingsMenu) => void
  toggleSidebar: () => void
  toggleTheme: () => void
  setLoggerEnabled: (enabled: boolean) => void
  setLogsOpen: (open: boolean) => void
}

export const useUIStore = create<UIStore>((set) => ({
  activeView: 'chat',
  settingsTab: 'chats',
  sidebarOpen: true,
  theme: (localStorage.getItem('cinna-theme') as Theme) || 'dark',
  loggerEnabled: localStorage.getItem(LOGGER_KEY) === '1',
  logsOpen: false,
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
  setLogsOpen: (open) => set({ logsOpen: open })
}))

// Apply theme on load
const savedTheme = localStorage.getItem('cinna-theme') || 'dark'
document.documentElement.setAttribute('data-theme', savedTheme)
