import { createPortal } from 'react-dom'
import { Sun, Moon, Terminal, Eye, EyeOff, SlidersHorizontal, Minimize2 } from 'lucide-react'
import { useUIStore } from '../../stores/ui.store'
import { useChatStore } from '../../stores/chat.store'
import { usePopover } from '../ui/usePopover'
import { requestMinimalView } from '../../hooks/useMinimalView'
import { useChatHandoffPending } from '../tasks/PendingHandoffControl'
import { minimalRefused } from '../../utils/minimalView'

/**
 * Sidebar footer button that opens a small popover containing UI toggles
 * (Console / Verbose / Theme / Minimal view). Portaled so it escapes the
 * sidebar's `overflow: hidden` clip.
 */
export function InterfaceMenu(): React.JSX.Element {
  const theme = useUIStore((s) => s.theme)
  const toggleTheme = useUIStore((s) => s.toggleTheme)
  const logsOpen = useUIStore((s) => s.logsOpen)
  const setLogsOpen = useUIStore((s) => s.setLogsOpen)
  const verboseMode = useUIStore((s) => s.verboseMode)
  const toggleVerboseMode = useUIStore((s) => s.toggleVerboseMode)
  // Minimal view applies to an open chat in the chat view only; elsewhere the
  // toggle is not offered. Disabled while the chat needs the user (an open
  // ask, a send error, a pending handoff), which minimal view would hide.
  const minimalView = useUIStore((s) => s.minimalView)
  const inChatView = useUIStore((s) => s.activeView === 'chat')
  const chatOpen = useChatStore((s) => s.activeChatId !== null)
  const minimalApplies = inChatView && chatOpen
  const chatId = useChatStore((s) => s.activeChatId)
  const handoffPending = useChatHandoffPending(minimalApplies ? chatId : null)
  const minimalBlocked = useChatStore((s) => minimalRefused({ ...s, handoffPending }))

  const { open, setOpen, triggerRef, popoverRef, style } = usePopover<HTMLButtonElement>('above-right')

  return (
    <>
      <button
        ref={triggerRef}
        onClick={() => setOpen(!open)}
        className={`p-1.5 rounded-md transition-colors ${
          open
            ? 'bg-[var(--color-bg-tertiary)] text-[var(--color-text)]'
            : 'text-[var(--color-text-muted)] hover:bg-[var(--color-bg-hover)] hover:text-[var(--color-text-secondary)]'
        }`}
        title="Interface"
      >
        <SlidersHorizontal size={14} />
      </button>

      {open && style && createPortal(
        <div
          ref={popoverRef}
          style={style}
          className="app-popover-surface flex items-center gap-1 px-1.5 py-1.5 rounded-lg
            border border-[var(--color-border)] shadow-lg z-50"
        >
          <button
            onClick={() => setLogsOpen(!logsOpen)}
            className={`p-1.5 rounded-md transition-colors ${
              logsOpen
                ? 'text-[var(--color-text)] bg-[var(--color-bg-tertiary)]'
                : 'text-[var(--color-text-muted)] hover:bg-[var(--color-bg-hover)] hover:text-[var(--color-text-secondary)]'
            }`}
            title="App logs (⌘`)"
          >
            <Terminal size={14} />
          </button>
          <button
            onClick={toggleVerboseMode}
            className={`p-1.5 rounded-md transition-colors ${
              verboseMode
                ? 'text-[var(--color-text)] bg-[var(--color-bg-tertiary)]'
                : 'text-[var(--color-text-muted)] hover:bg-[var(--color-bg-hover)] hover:text-[var(--color-text-secondary)]'
            }`}
            title={verboseMode ? 'Switch to compact mode' : 'Switch to verbose mode'}
          >
            {verboseMode ? <Eye size={14} /> : <EyeOff size={14} />}
          </button>
          <button
            onClick={toggleTheme}
            className="p-1.5 rounded-md text-[var(--color-text-muted)] hover:bg-[var(--color-bg-hover)] hover:text-[var(--color-text-secondary)] transition-colors"
            title={theme === 'dark' ? 'Switch to light' : 'Switch to dark'}
          >
            {theme === 'dark' ? <Sun size={14} /> : <Moon size={14} />}
          </button>
          {minimalApplies && (
            <button
              onClick={() => {
                if (requestMinimalView(handoffPending)) setOpen(false)
              }}
              disabled={minimalBlocked}
              aria-pressed={minimalView}
              aria-label="Minimal view"
              title="Minimal view"
              className={`p-1.5 rounded-md transition-colors disabled:opacity-40 disabled:cursor-not-allowed ${
                minimalView
                  ? 'text-[var(--color-text)] bg-[var(--color-bg-tertiary)]'
                  : 'text-[var(--color-text-muted)] hover:bg-[var(--color-bg-hover)] hover:text-[var(--color-text-secondary)]'
              }`}
            >
              <Minimize2 size={14} />
            </button>
          )}
        </div>,
        document.body
      )}
    </>
  )
}
