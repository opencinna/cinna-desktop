import {
  ArrowLeft,
  Brain,
  Plug,
  Trash2,
  MessageSquare,
  Bot,
  Users,
  Wrench
} from 'lucide-react'
import { useUIStore } from '../../stores/ui.store'
import type { SettingsMenu } from '../../stores/ui.store'
import { useAuthStore } from '../../stores/auth.store'
import { ChatList } from '../chat/ChatList'
import { UserMenu } from '../auth/UserMenu'
import { AgentStatusButton } from '../agents/AgentStatusButton'
import { UpdateStatusButton } from '../updater/UpdateStatusButton'
import { InterfaceMenu } from './InterfaceMenu'

const settingsMenuItems: { id: SettingsMenu; label: string; icon: typeof Brain }[] = [
  { id: 'chats', label: 'Chats', icon: MessageSquare },
  { id: 'agents', label: 'Agents', icon: Bot },
  { id: 'llm', label: 'LLM Providers', icon: Brain },
  { id: 'mcp', label: 'MCP Providers', icon: Plug },
  { id: 'accounts', label: 'User Accounts', icon: Users },
  { id: 'development', label: 'Development', icon: Wrench }
]

export function Sidebar(): React.JSX.Element {
  const sidebarOpen = useUIStore((s) => s.sidebarOpen)
  const activeView = useUIStore((s) => s.activeView)
  const setActiveView = useUIStore((s) => s.setActiveView)
  const settingsTab = useUIStore((s) => s.settingsTab)
  const setSettingsMenu = useUIStore((s) => s.setSettingsMenu)
  const currentUser = useAuthStore((s) => s.currentUser)
  const isCinnaUser = currentUser?.type === 'cinna_user'

  const isSettings = activeView === 'settings'

  return (
    <div className={`app-sidebar-wrap h-full ${sidebarOpen ? '' : 'is-collapsed'}`}>
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
            <div className="px-4 pt-1 pb-3">
              <h2 className="text-sm font-semibold text-[var(--color-text)]">Settings</h2>
            </div>

            <div className="flex-1 px-2 space-y-0.5 overflow-y-auto">
              {settingsMenuItems.map((item) => {
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
              })}

              <div className="mx-2.5 border-t border-[var(--color-border)]" />
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
          <div className="flex-1 overflow-y-auto pt-2">
            <ChatList />
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
