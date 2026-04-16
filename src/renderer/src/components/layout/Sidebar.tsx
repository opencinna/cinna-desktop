import { Settings, Sun, Moon, Plus, ArrowLeft, Brain, Plug, Trash2, MessageSquare } from 'lucide-react'
import { useUIStore } from '../../stores/ui.store'
import type { SettingsMenu } from '../../stores/ui.store'
import { useChatStore } from '../../stores/chat.store'
import { ChatList } from '../chat/ChatList'

const settingsMenuItems: { id: SettingsMenu; label: string; icon: typeof Brain }[] = [
  { id: 'chats', label: 'Chats', icon: MessageSquare },
  { id: 'llm', label: 'LLM Providers', icon: Brain },
  { id: 'mcp', label: 'MCP Providers', icon: Plug }
]

export function Sidebar(): React.JSX.Element {
  const { sidebarOpen, setActiveView, activeView, settingsTab, setSettingsMenu, theme, toggleTheme } = useUIStore()
  const setActiveChatId = useChatStore((s) => s.setActiveChatId)

  const handleNewChat = (): void => {
    setActiveChatId(null)
    setActiveView('chat')
  }

  const isSettings = activeView === 'settings'

  return (
    <div
      className="h-full shrink-0 overflow-hidden transition-[width] duration-250 ease-in-out border-r border-[var(--color-border)] bg-[var(--color-bg-secondary)]"
      style={{ width: sidebarOpen ? 240 : 0, borderRightWidth: sidebarOpen ? 1 : 0 }}
    >
      <div className="w-[240px] h-full flex flex-col">
        {isSettings ? (
          <>
            {/* Settings header with back button */}
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

            {/* Settings menu */}
            <div className="flex-1 px-2 space-y-0.5">
              {settingsMenuItems.map((item) => {
                const Icon = item.icon
                const active = settingsTab === item.id
                return (
                  <button
                    key={item.id}
                    onClick={() => setSettingsMenu(item.id)}
                    className={`w-full flex items-center gap-2 px-2.5 py-2 rounded-md text-xs font-medium transition-colors ${
                      active
                        ? 'bg-[var(--color-bg-tertiary)] text-[var(--color-text)]'
                        : 'text-[var(--color-text-muted)] hover:bg-[var(--color-bg-hover)] hover:text-[var(--color-text-secondary)]'
                    }`}
                  >
                    <Icon size={14} />
                    {item.label}
                  </button>
                )
              })}

              {/* Trash with delimiter */}
              <div className="mx-2.5 border-t border-[var(--color-border)]" />
              <button
                onClick={() => setSettingsMenu('trash')}
                className={`w-full flex items-center gap-2 px-2.5 py-2 rounded-md text-xs font-medium transition-colors ${
                  settingsTab === 'trash'
                    ? 'bg-[var(--color-bg-tertiary)] text-[var(--color-text)]'
                    : 'text-[var(--color-text-muted)] hover:bg-[var(--color-bg-hover)] hover:text-[var(--color-text-secondary)]'
                }`}
              >
                <Trash2 size={14} />
                Trash
              </button>
            </div>
          </>
        ) : (
          <>
            {/* New Chat button */}
            <div className="px-2 pt-2 pb-1 mx-4 border-b border-[var(--color-border)]">
              <button
                onClick={handleNewChat}
                className="w-full flex items-center gap-1.5 px-2.5 py-1.5 rounded-md text-xs font-medium
                  text-[var(--color-text-secondary)] hover:bg-[var(--color-bg-hover)] transition-colors"
              >
                <Plus size={14} />
                New Chat
              </button>
            </div>

            <div className="flex-1 overflow-y-auto">
              <ChatList />
            </div>
          </>
        )}

        {/* Bottom bar: settings + theme */}
        <div className="border-t border-[var(--color-border)] px-2 py-2 flex items-center gap-1">
          <button
            onClick={() => setActiveView(isSettings ? 'chat' : 'settings')}
            className={`p-1.5 rounded-md transition-colors ${
              isSettings
                ? 'text-[var(--color-text)] bg-[var(--color-bg-tertiary)]'
                : 'text-[var(--color-text-muted)] hover:bg-[var(--color-bg-hover)] hover:text-[var(--color-text-secondary)]'
            }`}
            title="Settings"
          >
            <Settings size={14} />
          </button>
          <div className="flex-1" />
          <button
            onClick={toggleTheme}
            className="p-1.5 rounded-md text-[var(--color-text-muted)] hover:bg-[var(--color-bg-hover)] hover:text-[var(--color-text-secondary)] transition-colors"
            title={theme === 'dark' ? 'Switch to light' : 'Switch to dark'}
          >
            {theme === 'dark' ? <Sun size={14} /> : <Moon size={14} />}
          </button>
        </div>
      </div>
    </div>
  )
}
