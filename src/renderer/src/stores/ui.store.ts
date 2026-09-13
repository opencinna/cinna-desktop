/// <reference types="vite/client" />
import { create } from 'zustand'
import { readThemePreference, resolveTheme, type Theme, type ThemePreference } from '../utils/theme'
export type { Theme, ThemePreference } from '../utils/theme'

export type ActiveView =
  | 'chat'
  | 'settings'
  /** The one list of asks waiting on a human — reachable from every tab. */
  | 'inbox'
  /**
   * One task: what the work is, where it stands, and the way back into it.
   * Reached from a job's run rows and from an inbox entry, so — like the inbox
   * — it belongs to no sidebar tab.
   */
  | 'task'
  | 'job-detail'
  | 'job-edit'
  | 'cinna-task-run'
  | 'note-detail'
  | 'local-agent'
  | 'local-development'
  | 'external-agent'
export type SidebarTab = 'chats' | 'jobs' | 'notes' | 'agents'
export type SettingsMenu =
  | 'chats'
  | 'llm'
  | 'mcp'
  | 'local-agents'
  | 'local-dev'
  | 'accounts'
  | 'features'
  | 'development'
  | 'profile-local-dev'
  | 'profile-agents'
  | 'profile-chats'
  | 'profile-llm'
  | 'profile-catalog'
  | 'profile-sync'
  | 'trash'

/**
 * Tabs that live in the "Profile" sidebar group — only valid when the active
 * profile renders that group (currently: Cinna users). Switching to a profile
 * without them should snap the sidebar back to a default-scope tab.
 */
export const PROFILE_SCOPE_TABS: readonly SettingsMenu[] = [
  'profile-local-dev',
  'profile-agents',
  'profile-chats',
  'profile-llm',
  'profile-catalog',
  'profile-sync'
]
const VERBOSE_KEY = 'cinna-verbose-mode'
const ANIMATION_KEY = 'cinna-extra-ui-animation'

function applyTheme(theme: Theme): void {
  document.documentElement.setAttribute('data-theme', theme)
  void window.api?.app?.setTheme(theme)?.catch(() => {})
}

interface UIStore {
  activeView: ActiveView
  agentPageMode: 'chat' | 'settings'
  settingsTab: SettingsMenu
  sidebarTab: SidebarTab
  activeJobId: string | null
  /** Cinna task run currently being viewed (when activeView === 'cinna-task-run'). */
  activeCinnaRunId: string | null
  /** The task whose page is open (when activeView === 'task'). */
  activeTaskId: string | null
  activeNoteId: string | null
  /** A2A or remote ACP agent selected in the Agents sidebar. */
  activeExternalAgentId: string | null
  /** Folder agent whose page is open (when activeView === 'local-agent'). */
  activeLocalAgentId: string | null
  /**
   * A folder agent that was just scaffolded and still wants its one-shot AI
   * draft. One-shot intent, handed from the new-agent form to the agent page
   * — the same shape as `pendingAgentId` — so the page owns the request and
   * can show its progress, rather than a modal firing it as it unmounts.
   */
  pendingDraftAgentId: string | null
  sidebarOpen: boolean
  theme: Theme
  themePreference: ThemePreference
  extraUIAnimation: boolean
  logsOpen: boolean
  agentStatusOpen: boolean
  /** Agent whose status detail the overlay should show (null = grid view). */
  agentStatusDetailId: string | null
  pendingAgentId: string | null
  verboseMode: boolean
  setAgentPageMode: (mode: 'chat' | 'settings') => void
  setActiveView: (view: ActiveView) => void
  setSettingsMenu: (tab: SettingsMenu) => void
  setSidebarTab: (tab: SidebarTab) => void
  setActiveJobId: (id: string | null) => void
  setActiveCinnaRunId: (id: string | null) => void
  setActiveTaskId: (id: string | null) => void
  setActiveNoteId: (id: string | null) => void
  setActiveExternalAgentId: (id: string | null) => void
  setActiveLocalAgentId: (id: string | null) => void
  setPendingDraftAgentId: (id: string | null) => void
  toggleSidebar: () => void
  toggleTheme: () => void
  setThemePreference: (preference: ThemePreference) => void
  setExtraUIAnimation: (enabled: boolean) => void
  setLogsOpen: (open: boolean) => void
  setAgentStatusOpen: (open: boolean) => void
  setAgentStatusDetailId: (id: string | null) => void
  setPendingAgentId: (id: string | null) => void
  toggleVerboseMode: () => void
}

export const useUIStore = create<UIStore>((set, get) => ({
  activeView: 'chat',
  agentPageMode: 'chat',
  settingsTab: 'chats',
  sidebarTab: 'chats',
  activeJobId: null,
  activeCinnaRunId: null,
  activeTaskId: null,
  activeNoteId: null,
  activeExternalAgentId: null,
  activeLocalAgentId: null,
  pendingDraftAgentId: null,
  sidebarOpen: true,
  theme: resolveTheme(readThemePreference()),
  themePreference: readThemePreference(),
  extraUIAnimation: localStorage.getItem(ANIMATION_KEY) !== '0',
  logsOpen: false,
  agentStatusOpen: false,
  agentStatusDetailId: null,
  pendingAgentId: null,
  verboseMode: localStorage.getItem(VERBOSE_KEY) === '1',
  setAgentPageMode: (mode) => set({ agentPageMode: mode }),
  setActiveView: (view) => set({ activeView: view }),
  setSettingsMenu: (tab) => set({ settingsTab: tab }),
  setSidebarTab: (tab) => set({ sidebarTab: tab }),
  setActiveJobId: (id) => set({ activeJobId: id }),
  setActiveCinnaRunId: (id) => set({ activeCinnaRunId: id }),
  setActiveTaskId: (id) => set({ activeTaskId: id }),
  setActiveNoteId: (id) => set({ activeNoteId: id }),
  setActiveExternalAgentId: (id) => set({ activeExternalAgentId: id, activeLocalAgentId: null }),
  setActiveLocalAgentId: (id) => set({ activeLocalAgentId: id, activeExternalAgentId: null }),
  setPendingDraftAgentId: (id) => set({ pendingDraftAgentId: id }),
  toggleSidebar: () => set((state) => ({ sidebarOpen: !state.sidebarOpen })),
  // The footer always chooses a fixed theme, including when following System.
  toggleTheme: () => get().setThemePreference(get().theme === 'dark' ? 'light' : 'dark'),
  setThemePreference: (themePreference) => {
    localStorage.setItem('cinna-theme', themePreference)
    const theme = resolveTheme(themePreference)
    applyTheme(theme)
    set({ themePreference, theme })
  },
  setExtraUIAnimation: (extraUIAnimation) => {
    localStorage.setItem(ANIMATION_KEY, extraUIAnimation ? '1' : '0')
    set({ extraUIAnimation })
  },
  setLogsOpen: (open) => set({ logsOpen: open }),
  setAgentStatusOpen: (open) => set({ agentStatusOpen: open }),
  setAgentStatusDetailId: (id) => set({ agentStatusDetailId: id }),
  setPendingAgentId: (id) => set({ pendingAgentId: id }),
  toggleVerboseMode: () =>
    set((state) => {
      const next = !state.verboseMode
      localStorage.setItem(VERBOSE_KEY, next ? '1' : '0')
      return { verboseMode: next }
    })
}))

applyTheme(useUIStore.getState().theme)
const systemTheme = window.matchMedia?.('(prefers-color-scheme: dark)')
const followSystemTheme = (): void => {
  if (useUIStore.getState().themePreference !== 'system') return
  const theme = resolveTheme('system')
  applyTheme(theme)
  useUIStore.setState({ theme })
}
systemTheme?.addEventListener('change', followSystemTheme)
const syncAppearance = (event: StorageEvent): void => {
  if (event.key === 'cinna-theme' || event.key === null) {
    const themePreference = readThemePreference()
    const theme = resolveTheme(themePreference)
    applyTheme(theme)
    useUIStore.setState({ themePreference, theme })
  }
  if (event.key === ANIMATION_KEY || event.key === null) {
    useUIStore.setState({ extraUIAnimation: localStorage.getItem(ANIMATION_KEY) !== '0' })
  }
}
window.addEventListener('storage', syncAppearance)
if (import.meta.hot) {
  import.meta.hot.dispose(() => {
    systemTheme?.removeEventListener('change', followSystemTheme)
    window.removeEventListener('storage', syncAppearance)
  })
}
