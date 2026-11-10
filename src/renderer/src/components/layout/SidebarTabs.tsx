import { MessageSquare, ClipboardList, NotebookPen, Bot, LayoutDashboard } from 'lucide-react'
import { useEffect } from 'react'
import {
  useUIStore,
  CAPABILITY_VIEWS,
  disabledCapabilityOnScreen,
  isSidebarTabEnabled,
  type ActiveView,
  type SidebarTab
} from '../../stores/ui.store'
import { useChatStore } from '../../stores/chat.store'
import { useChatList } from '../../hooks/useChat'
import { useCapabilities } from '../../hooks/useCapabilities'

/**
 * The centers that belong to **no** tab, and are therefore the ones the
 * already-selected tab has to be able to leave.
 *
 * The Inbox was the first: an ask belongs to no tab, which is the point of it.
 * The task page is the second, reached from a job's run rows *and* from an
 * inbox entry — so which tab is selected while it is open depends on where the
 * user came from, and pressing that tab has to realign the center rather than
 * decide nothing changed. The cinna run screen has always had the same shape
 * and the same trap; it is named here rather than left as the one exception
 * nobody wrote down.
 */
const TABLESS_VIEWS: readonly ActiveView[] = ['inbox', 'tasks', 'task', 'cinna-task-run']

/**
 * Settings leaves the same way: its section menu replaces the list, so no tab
 * is selected while it is open, and pressing the tab that was selected before
 * has to leave it rather than decide nothing changed.
 */
const LEAVABLE_VIEWS: readonly ActiveView[] = [...TABLESS_VIEWS, 'settings']

/**
 * The center each tab owns, for the one case that only realigns it: returning
 * from a tabless view to the tab that is already selected. A genuine tab change
 * goes through `handleSwitchTab`'s body, which also clears the old tab's
 * selection.
 */
const VIEW_FOR_TAB: Record<SidebarTab, ActiveView> = {
  chats: 'chat',
  jobs: 'job-detail',
  notes: 'note-detail',
  agents: 'local-agent',
  dashboards: 'dashboard'
}

const TAB_ITEMS: { id: SidebarTab; label: string; Icon: typeof MessageSquare }[] = [
  { id: 'chats', label: 'Chats', Icon: MessageSquare },
  { id: 'jobs', label: 'Jobs', Icon: ClipboardList },
  { id: 'agents', label: 'Agents', Icon: Bot },
  // Optional capabilities (Settings → Features → Capabilities), shown only
  // once on. Last on the rail, so turning one on appends a tab and moves none.
  { id: 'notes', label: 'Notes', Icon: NotebookPen },
  { id: 'dashboards', label: 'Dashboards', Icon: LayoutDashboard }
]

/**
 * Diary-book tabs that stick out on the LEFT of the sidebar card. The
 * sidebar reads as a "page"; the active tab visually merges with the page
 * (same surface, no seam on the right), while inactive tabs sit as smaller
 * recessed blocks. In Settings the rail stays, dimmed and with no tab
 * selected — the section menu is the page then — and a tab leaves Settings.
 */
export function SidebarTabs(): React.JSX.Element {
  const sidebarTab = useUIStore((s) => s.sidebarTab)
  const setSidebarTab = useUIStore((s) => s.setSidebarTab)
  const activeView = useUIStore((s) => s.activeView)
  const setActiveView = useUIStore((s) => s.setActiveView)
  const setActiveJobId = useUIStore((s) => s.setActiveJobId)
  const setActiveCinnaRunId = useUIStore((s) => s.setActiveCinnaRunId)
  const setActiveTaskId = useUIStore((s) => s.setActiveTaskId)
  const setActiveNoteId = useUIStore((s) => s.setActiveNoteId)
  const activeExternalAgentId = useUIStore((s) => s.activeExternalAgentId)
  const setActiveLocalAgentId = useUIStore((s) => s.setActiveLocalAgentId)
  const setActiveChatId = useChatStore((s) => s.setActiveChatId)
  const { notesEnabled, dashboardsEnabled, loaded: capabilitiesLoaded } = useCapabilities()
  const inSettings = activeView === 'settings'

  const { data: chats } = useChatList()

  // Switching sidebar tabs should also realign the main area so the user
  // doesn't end up with (e.g.) Chats in the sidebar and a job still in the
  // center. For Chats we reopen the chat that was open last — Save to Notes,
  // for one, moves the sidebar off the chat being read — and fall back to the
  // first chat (or the new-chat screen) when it is gone.
  // For Jobs we intentionally do NOT auto-select — jobs can live inside a
  // collapsed folder, so the "first job" is ambiguous from the user's POV
  // and would silently expand a folder. Instead we land on the empty
  // "Select a job from the sidebar" view.
  // A view that belongs to no tab (`TABLESS_VIEWS`) is the one the
  // already-selected tab has to be able to leave: pressing Chats while the
  // inbox or a task fills the center must realign the center, not decide
  // nothing changed.
  const openChats = (): void => {
    // The dashboard chat panel holds the store's selection while it is
    // open; the Chats view's own chat is the one it put aside.
    const stash = useUIStore.getState().dashboardChatsStash
    const lastChatId = stash ? stash.chatId : useChatStore.getState().activeChatId
    const chat = chats?.find((c) => c.id === lastChatId) ?? chats?.[0]
    setActiveView('chat')
    setActiveChatId(chat?.id ?? null)
  }

  const handleSwitchTab = (target: SidebarTab): void => {
    const leavingTabless = LEAVABLE_VIEWS.includes(activeView)
    if (target === sidebarTab && !leavingTabless) return
    setSidebarTab(target)
    // **Coming back to the tab you were already on keeps your place.** The
    // resets below exist because a genuine tab change must not leave a job in
    // the center under the Notes list; nothing about pressing Chats to leave
    // the inbox asks for the open chat to be abandoned, and dropping it would
    // send a user who answered one ask back to a different conversation than
    // the one they left.
    if (target === sidebarTab) {
      setActiveView(target === 'agents' && activeExternalAgentId ? 'external-agent' : VIEW_FOR_TAB[target])
      return
    }
    setActiveCinnaRunId(null)
    setActiveTaskId(null)
    if (target === 'chats') {
      openChats()
    } else if (target === 'jobs') {
      setActiveJobId(null)
      setActiveView('job-detail')
    } else if (target === 'notes') {
      setActiveNoteId(null)
      setActiveView('note-detail')
    } else if (target === 'dashboards') {
      // Like Chats, the tab comes back to the dashboard that was open; the
      // list opens the first one itself when there is none (or it is gone):
      // a dashboard is a screen to look at, not a folder to choose from.
      setActiveView('dashboard')
    } else {
      // Agents: like Jobs, land on the empty page rather than auto-selecting.
      // The first agent is ambiguous when the list is grouped by root, and
      // opening one would start reading its folder without being asked to.
      setActiveLocalAgentId(null)
      setActiveView('local-agent')
    }
  }

  // A capability turned off — here, in Settings or in another window — takes
  // its tab with it, and the sidebar falls back to Chats. Its center goes too
  // when it is on screen; a center that belongs to no tab (Settings, the
  // Inbox) stays, and only the tab under it moves to Chats.
  // Not before the settings answer: unloaded reads as off, and is not a choice.
  const offOnScreen = capabilitiesLoaded
    ? disabledCapabilityOnScreen({ notesEnabled, dashboardsEnabled, sidebarTab, activeView })
    : null
  useEffect(() => {
    if (!offOnScreen) return
    if (sidebarTab !== 'chats') setSidebarTab('chats')
    if (activeView === CAPABILITY_VIEWS[offOnScreen]) {
      setActiveCinnaRunId(null)
      setActiveTaskId(null)
      openChats()
    }
  }, [offOnScreen]) // eslint-disable-line react-hooks/exhaustive-deps

  const tabs = TAB_ITEMS.filter(({ id }) => isSidebarTabEnabled({ notesEnabled, dashboardsEnabled }, id))

  return (
    <div className={`app-sidebar-tabs ${inSettings ? 'is-dimmed' : ''}`}>
      {tabs.map(({ id, label, Icon }) => {
        const isActive = !inSettings && sidebarTab === id
        // In Settings the menu beside the rail has its own Chats and Agents
        // items; a tab there says it leaves Settings, so the two never share
        // a name (ux rule 10).
        const name = inSettings ? `Open ${label}` : label
        return (
          <button
            key={id}
            type="button"
            onClick={() => handleSwitchTab(id)}
            title={name}
            aria-label={name}
            aria-pressed={isActive}
            className="sidebar-tab splash-block"
          >
            <Icon size={14} />
          </button>
        )
      })}
    </div>
  )
}
