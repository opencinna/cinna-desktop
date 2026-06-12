import { useEffect, useRef, useState } from 'react'
import { Plus, Paperclip, SlidersHorizontal, Boxes, ChevronLeft, Check, Loader2 } from 'lucide-react'
import type { ChatModeData } from '../../constants/chatModeColors'

export interface PlusModeMenu {
  modes: ChatModeData[]
  activeId: string | null
  /** Called with the picked mode, or `null` to deselect the active one. */
  onSelectMode: (mode: ChatModeData | null) => void
  renderIcon: (mode: ChatModeData) => React.ReactNode
  composeSecondary?: (mode: ChatModeData) => string | null | undefined
}

interface ComposerPlusMenuProps {
  /** "Attach files" row — shown when the current target accepts attachments. */
  canAttachFiles: boolean
  uploading?: boolean
  onAttachFiles: () => void
  /** "Add agents / MCP" row — shown when any agent or MCP is available. */
  hasCapabilities: boolean
  onOpenCapabilityPicker: () => void
  /** "Chat mode" sub-menu — omitted when mode selection doesn't apply here. */
  modeMenu?: PlusModeMenu
  /** Tints the [+] button border to the active chat-mode color, if any. */
  activeModeColor?: { border: string } | null
}

type View = 'root' | 'modes'

/**
 * The single left-side `[+]` composer entry point. Opens a small frosted menu
 * with up to three actions — Attach files, Chat mode (sub-menu), and Add
 * agents / MCP (opens a search modal). The mouse-driven counterpart to the
 * `@` / `~` keyboard triggers, driving the exact same state changes.
 */
export function ComposerPlusMenu({
  canAttachFiles,
  uploading = false,
  onAttachFiles,
  hasCapabilities,
  onOpenCapabilityPicker,
  modeMenu,
  activeModeColor
}: ComposerPlusMenuProps): React.JSX.Element | null {
  const [open, setOpen] = useState(false)
  const [view, setView] = useState<View>('root')
  const triggerRef = useRef<HTMLButtonElement>(null)
  const menuRef = useRef<HTMLDivElement>(null)

  // Outside-click / Esc close. Mirrors AttachMenuPopup.
  useEffect(() => {
    if (!open) return
    const onMouseDown = (e: MouseEvent): void => {
      const target = e.target as Node | null
      if (!target) return
      if (menuRef.current?.contains(target)) return
      if (triggerRef.current?.contains(target)) return
      setOpen(false)
    }
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') setOpen(false)
    }
    document.addEventListener('mousedown', onMouseDown)
    document.addEventListener('keydown', onKey)
    return () => {
      document.removeEventListener('mousedown', onMouseDown)
      document.removeEventListener('keydown', onKey)
    }
  }, [open])

  // Always reopen on the root view.
  useEffect(() => {
    if (!open) setView('root')
  }, [open])

  const hasModes = !!modeMenu && modeMenu.modes.length > 0
  // Nothing to offer → no button at all.
  if (!canAttachFiles && !hasCapabilities && !hasModes) return null

  const rowCls =
    'w-full flex items-center gap-2.5 px-3 py-2 text-left text-[13px] ' +
    'text-[var(--color-text)] hover:bg-[var(--color-accent)]/20 ' +
    'disabled:opacity-40 disabled:cursor-not-allowed transition-colors'
  const iconCls = 'shrink-0 text-[var(--color-text-secondary)]'

  return (
    <div className="relative">
      <button
        ref={triggerRef}
        type="button"
        onClick={() => setOpen((v) => !v)}
        title="Add to chat"
        aria-label="Add to chat"
        aria-haspopup="menu"
        aria-expanded={open}
        className="relative p-1.5 rounded-lg text-[var(--color-text-muted)] hover:text-[var(--color-text)]
          hover:bg-[var(--color-bg-hover)] border transition-colors"
        style={{ borderColor: activeModeColor ? activeModeColor.border : 'var(--color-border)' }}
      >
        <Plus size={16} style={activeModeColor ? { color: activeModeColor.border } : undefined} />
        {uploading && (
          // Attaching is one of several actions here, so signal upload progress
          // as a small corner badge rather than swapping the whole glyph.
          <Loader2
            size={10}
            className="animate-spin absolute -top-0.5 -right-0.5 text-[var(--color-accent)]"
          />
        )}
      </button>

      {open && (
        <div
          ref={menuRef}
          role="menu"
          aria-label="Add to chat"
          className="absolute bottom-full left-0 mb-1 min-w-[13rem]
            bg-[var(--color-accent)]/10 [[data-theme=light]_&]:bg-[var(--color-accent)]/5
            backdrop-blur-xl
            border border-[var(--color-accent)]/25 [[data-theme=light]_&]:border-[var(--color-accent)]/12
            rounded-lg shadow-xl z-50 overflow-hidden py-1"
        >
          {view === 'root' ? (
            <>
              {canAttachFiles && (
                <button
                  type="button"
                  role="menuitem"
                  disabled={uploading}
                  onClick={() => {
                    onAttachFiles()
                    setOpen(false)
                  }}
                  className={rowCls}
                >
                  <Paperclip size={16} className={iconCls} />
                  <span>{uploading ? 'Uploading…' : 'Attach files'}</span>
                </button>
              )}

              {hasModes && (
                <button
                  type="button"
                  role="menuitem"
                  onClick={() => setView('modes')}
                  className={rowCls}
                >
                  <SlidersHorizontal size={16} className={iconCls} />
                  <span className="flex-1">Chat mode</span>
                  <ChevronLeft size={14} className="rotate-180 text-[var(--color-text-muted)]" />
                </button>
              )}

              {hasCapabilities && (
                <button
                  type="button"
                  role="menuitem"
                  onClick={() => {
                    onOpenCapabilityPicker()
                    setOpen(false)
                  }}
                  className={rowCls}
                >
                  <Boxes size={16} className={iconCls} />
                  <span>Add agents / MCP</span>
                </button>
              )}
            </>
          ) : (
            modeMenu && (
              <div className="max-h-72 overflow-y-auto">
                <button
                  type="button"
                  onClick={() => setView('root')}
                  className="w-full flex items-center gap-1.5 px-3 py-2 text-left text-[12px]
                    font-semibold uppercase tracking-wider text-[var(--color-text-muted)]
                    hover:text-[var(--color-text)] transition-colors"
                >
                  <ChevronLeft size={14} />
                  <span>Chat mode</span>
                </button>
                {modeMenu.modes.map((mode) => {
                  const isActive = modeMenu.activeId === mode.id
                  const secondary = modeMenu.composeSecondary?.(mode)
                  return (
                    <button
                      key={mode.id}
                      type="button"
                      role="menuitemradio"
                      aria-checked={isActive}
                      onClick={() => {
                        modeMenu.onSelectMode(isActive ? null : mode)
                        setOpen(false)
                      }}
                      className="w-full flex items-start gap-2.5 px-3 py-2 text-left
                        hover:bg-[var(--color-accent)]/20 transition-colors"
                    >
                      <span className="mt-0.5">{modeMenu.renderIcon(mode)}</span>
                      <span className="min-w-0 flex-1">
                        <span className="block text-[13px] text-[var(--color-text)] truncate">
                          {mode.name}
                        </span>
                        {secondary && (
                          <span className="block text-[11px] text-[var(--color-text-muted)] truncate">
                            {secondary}
                          </span>
                        )}
                      </span>
                      {isActive && (
                        <Check size={14} className="mt-0.5 shrink-0 text-[var(--color-accent)]" />
                      )}
                    </button>
                  )
                })}
              </div>
            )
          )}
        </div>
      )}
    </div>
  )
}
