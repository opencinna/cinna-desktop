import { createPortal } from 'react-dom'
import { Sun, Moon, Terminal, Eye, EyeOff, SlidersHorizontal } from 'lucide-react'
import { useUIStore } from '../../stores/ui.store'
import { usePopover } from '../ui/usePopover'

/**
 * Sidebar footer button that opens a small popover containing UI toggles
 * (Console / Verbose / Theme). Portaled so it escapes the sidebar's
 * `overflow: hidden` clip.
 */
export function InterfaceMenu(): React.JSX.Element {
  const theme = useUIStore((s) => s.theme)
  const toggleTheme = useUIStore((s) => s.toggleTheme)
  const logsOpen = useUIStore((s) => s.logsOpen)
  const setLogsOpen = useUIStore((s) => s.setLogsOpen)
  const verboseMode = useUIStore((s) => s.verboseMode)
  const toggleVerboseMode = useUIStore((s) => s.toggleVerboseMode)

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
          className="flex items-center gap-1 px-1.5 py-1.5 rounded-lg
            border border-[var(--color-border)] bg-[var(--color-bg-secondary)] shadow-lg z-50"
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
        </div>,
        document.body
      )}
    </>
  )
}
