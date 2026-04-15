import { create } from 'zustand'

export type ActiveView = 'chat' | 'settings'
export type SettingsTab = 'llm' | 'mcp' | 'trash'
export type Theme = 'dark' | 'light'

interface UIStore {
  activeView: ActiveView
  settingsTab: SettingsTab
  sidebarOpen: boolean
  theme: Theme
  setActiveView: (view: ActiveView) => void
  setSettingsTab: (tab: SettingsTab) => void
  toggleSidebar: () => void
  toggleTheme: () => void
}

export const useUIStore = create<UIStore>((set) => ({
  activeView: 'chat',
  settingsTab: 'llm',
  sidebarOpen: true,
  theme: (localStorage.getItem('cinna-theme') as Theme) || 'dark',
  setActiveView: (view) => set({ activeView: view }),
  setSettingsTab: (tab) => set({ settingsTab: tab }),
  toggleSidebar: () => set((state) => ({ sidebarOpen: !state.sidebarOpen })),
  toggleTheme: () =>
    set((state) => {
      const next = state.theme === 'dark' ? 'light' : 'dark'
      localStorage.setItem('cinna-theme', next)
      document.documentElement.setAttribute('data-theme', next)
      return { theme: next }
    })
}))

// Apply theme on load
const savedTheme = localStorage.getItem('cinna-theme') || 'dark'
document.documentElement.setAttribute('data-theme', savedTheme)
