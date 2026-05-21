import {
  ArrowLeft,
  Brain,
  Plug,
  Trash2,
  MessageSquare,
  Bot,
  Users,
  Wrench,
  Sparkles
} from 'lucide-react'
import { useEffect } from 'react'
import { useUIStore, PROFILE_SCOPE_TABS } from '../../stores/ui.store'
import type { SettingsMenu } from '../../stores/ui.store'
import { useAuthStore } from '../../stores/auth.store'
import { ChatList } from '../chat/ChatList'
import { JobsList } from '../jobs/JobsList'
import { NotesList } from '../notes/NotesList'
import { SidebarTabs } from './SidebarTabs'
import { UserMenu } from '../auth/UserMenu'
import { AgentStatusButton } from '../agents/AgentStatusButton'
import { UpdateStatusButton } from '../updater/UpdateStatusButton'
import { InterfaceMenu } from './InterfaceMenu'
import { DEFAULT_USER_ID } from '../../../../shared/userIds'

const defaultMenuItems: { id: SettingsMenu; label: string; icon: typeof Brain }[] = [
  { id: 'chats', label: 'Chats', icon: MessageSquare },
  { id: 'agents', label: 'Agents', icon: Bot },
  { id: 'llm', label: 'LLM Providers', icon: Brain },
  { id: 'mcp', label: 'MCP Providers', icon: Plug },
  { id: 'accounts', label: 'User Accounts', icon: Users },
  { id: 'features', label: 'Features', icon: Sparkles },
  { id: 'development', label: 'Development', icon: Wrench }
]

const profileMenuItems: { id: SettingsMenu; label: string; icon: typeof Brain }[] = [
  { id: 'profile-agents', label: 'Agents', icon: Bot }
]

export function Sidebar(): React.JSX.Element {
  const sidebarOpen = useUIStore((s) => s.sidebarOpen)
  const activeView = useUIStore((s) => s.activeView)
  const setActiveView = useUIStore((s) => s.setActiveView)
  const settingsTab = useUIStore((s) => s.settingsTab)
  const setSettingsMenu = useUIStore((s) => s.setSettingsMenu)
  const sidebarTab = useUIStore((s) => s.sidebarTab)
  const currentUser = useAuthStore((s) => s.currentUser)
  const isCinnaUser = currentUser?.type === 'cinna_user'
  const profileLabel =
    currentUser && currentUser.id !== DEFAULT_USER_ID
      ? currentUser.displayName || currentUser.username
      : null
  // Profile scope currently only carries remote agents — Cinna users only.
  const showProfileGroup = isCinnaUser && !!profileLabel

  // When the active profile loses the Profile group, snap the selected tab
  // back to the default-scope view so the sidebar doesn't show empty content
  // for a menu item that no longer exists.
  useEffect(() => {
    if (!showProfileGroup && PROFILE_SCOPE_TABS.includes(settingsTab)) {
      setSettingsMenu('chats')
    }
  }, [showProfileGroup, settingsTab, setSettingsMenu])

  const isSettings = activeView === 'settings'

  const renderMenuButton = (item: { id: SettingsMenu; label: string; icon: typeof Brain }) => {
    const Icon = item.icon
    const active = settingsTab === item.id
    return (
      <button
        key={item.id}
        onClick={() => setSettingsMenu(item.id)}
        className={`w-full flex items-center gap-2 px-2.5 py-2 rounded-md text-xs font-medium transition-colors ${
          active
            ? 'app-nav-active text-[var(--color-text)]'
            : 'text-[var(--color-text-muted)] hover:bg-[var(--color-bg-hover)] hover:text-[var(--color-text-secondary)]'
        }`}
      >
        <Icon size={14} />
        {item.label}
      </button>
    )
  }

  return (
    <div className={`app-sidebar-wrap h-full ${sidebarOpen ? '' : 'is-collapsed'}`}>
      {!isSettings && <SidebarTabs />}
      <div className="app-sidebar overflow-hidden flex flex-col">
        {isSettings ? (
          <>
            <div className="px-2 pt-2 pb-1">
              <button
                onClick={() => setActiveView('chat')}
                className="flex items-center gap-1.5 px-2.5 py-1.5 rounded-md text-xs font-medium
                  text-[var(--color-text-muted)] hover:bg-[var(--color-bg-hover)] hover:text-[var(--color-text-secondary)] transition-colors"
              >
                <ArrowLeft size={14} />
                Back
              </button>
            </div>

            <div className="flex-1 px-2 overflow-y-auto">
              <div className="px-2 pt-1 pb-2">
                <h2 className="text-sm font-semibold text-[var(--color-text)]">Default</h2>
              </div>
              <div className="space-y-0.5">
                {defaultMenuItems.map(renderMenuButton)}
              </div>

              {showProfileGroup && (
                <>
                  <div className="mx-0.5 mt-3 mb-2 border-t border-[var(--color-border)]" />
                  <div className="px-2 pb-2">
                    <h2 className="text-sm font-semibold text-[var(--color-text)] truncate">
                      Profile{' '}
                      <span className="font-normal text-[var(--color-text-muted)]">
                        {profileLabel}
                      </span>
                    </h2>
                  </div>
                  <div className="space-y-0.5">
                    {profileMenuItems.map(renderMenuButton)}
                  </div>
                </>
              )}

              <div className="mx-0.5 my-2 border-t border-[var(--color-border)]" />
              <button
                onClick={() => setSettingsMenu('trash')}
                className={`w-full flex items-center gap-2 px-2.5 py-2 rounded-md text-xs font-medium transition-colors ${
                  settingsTab === 'trash'
                    ? 'app-nav-active text-[var(--color-text)]'
                    : 'text-[var(--color-text-muted)] hover:bg-[var(--color-bg-hover)] hover:text-[var(--color-text-secondary)]'
                }`}
              >
                <Trash2 size={14} />
                Trash
              </button>
            </div>
          </>
        ) : (
          <div className="flex-1 overflow-y-auto">
            {sidebarTab === 'chats' ? (
              <ChatList />
            ) : sidebarTab === 'jobs' ? (
              <JobsList />
            ) : (
              <NotesList />
            )}
          </div>
        )}

        {/* Footer: profile (left) — agent status + interface (right) */}
        <div className="px-2 py-2 flex items-center gap-1">
          <UserMenu compact />
          <div className="flex-1" />
          {isCinnaUser && <AgentStatusButton />}
          <UpdateStatusButton />
          <InterfaceMenu />
        </div>
      </div>
    </div>
  )
}
