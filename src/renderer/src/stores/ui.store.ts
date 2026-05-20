import { create } from 'zustand'

export type ActiveView =
  | 'chat'
  | 'settings'
  | 'job-detail'
  | 'job-edit'
  | 'cinna-task-run'
  | 'note-detail'
export type SidebarTab = 'chats' | 'jobs' | 'notes'
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
  sidebarTab: SidebarTab
  activeJobId: string | null
  /** Cinna task run currently being viewed (when activeView === 'cinna-task-run'). */
  activeCinnaRunId: string | null
  activeNoteId: string | null
  sidebarOpen: boolean
  theme: Theme
  logsOpen: boolean
  agentStatusOpen: boolean
  pendingAgentId: string | null
  verboseMode: boolean
  setActiveView: (view: ActiveView) => void
  setSettingsMenu: (tab: SettingsMenu) => void
  setSidebarTab: (tab: SidebarTab) => void
  setActiveJobId: (id: string | null) => void
  setActiveCinnaRunId: (id: string | null) => void
  setActiveNoteId: (id: string | null) => void
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
  sidebarTab: 'chats',
  activeJobId: null,
  activeCinnaRunId: null,
  activeNoteId: null,
  sidebarOpen: true,
  theme: (localStorage.getItem('cinna-theme') as Theme) || 'dark',
  logsOpen: false,
  agentStatusOpen: false,
  pendingAgentId: null,
  verboseMode: localStorage.getItem(VERBOSE_KEY) === '1',
  setActiveView: (view) => set({ activeView: view }),
  setSettingsMenu: (tab) => set({ settingsTab: tab }),
  setSidebarTab: (tab) => set({ sidebarTab: tab }),
  setActiveJobId: (id) => set({ activeJobId: id }),
  setActiveCinnaRunId: (id) => set({ activeCinnaRunId: id }),
  setActiveNoteId: (id) => set({ activeNoteId: id }),
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
