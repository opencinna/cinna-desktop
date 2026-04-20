import { useEffect, useRef, type RefObject } from 'react'
import { Terminal } from 'lucide-react'
import type { CliCommand } from '../../hooks/useCliCommands'

interface CliCommandPopupProps {
  /** Already-filtered list — ChatInput owns the filter predicate. */
  items: CliCommand[]
  selectedIndex: number
  onSelect: (command: CliCommand) => void
  onClose: () => void
  listboxId: string
  /** Input that owns the popup — clicks inside it are treated as "inside". */
  anchorRef?: RefObject<HTMLElement | null>
}

export function CliCommandPopup({
  items,
  selectedIndex,
  onSelect,
  onClose,
  listboxId,
  anchorRef
}: CliCommandPopupProps): React.JSX.Element | null {
  const ref = useRef<HTMLDivElement>(null)
  const itemRefs = useRef<(HTMLButtonElement | null)[]>([])

  useEffect(() => {
    const handler = (e: MouseEvent): void => {
      const target = e.target as Node
      if (ref.current?.contains(target)) return
      if (anchorRef?.current?.contains(target)) return
      onClose()
    }
    document.addEventListener('mousedown', handler)
    return () => document.removeEventListener('mousedown', handler)
  }, [onClose, anchorRef])

  useEffect(() => {
    itemRefs.current[selectedIndex]?.scrollIntoView({ block: 'nearest' })
  }, [selectedIndex])

  if (items.length === 0) return null

  return (
    <div
      ref={ref}
      className="absolute bottom-full mb-1 left-0 w-80 bg-[var(--color-bg-secondary)]
        border border-[var(--color-border)] rounded-lg shadow-xl z-50 overflow-hidden"
    >
      <div className="px-2.5 pt-2 pb-1">
        <div className="text-[10px] font-semibold text-[var(--color-text-muted)] uppercase tracking-wider mb-1.5">
          Agent Commands
        </div>
      </div>

      <ul
        id={listboxId}
        role="listbox"
        aria-label="Agent commands"
        className="px-1.5 pb-1.5 space-y-0.5 max-h-72 overflow-y-auto list-none m-0"
      >
        {items.map((cmd, i) => {
          const isActive = i === selectedIndex
          const optionId = `${listboxId}-opt-${i}`
          return (
            <li key={`${cmd.slug}-${i}`} role="presentation">
              <button
                id={optionId}
                role="option"
                aria-selected={isActive}
                type="button"
                ref={(el) => {
                  itemRefs.current[i] = el
                }}
                onClick={() => onSelect(cmd)}
                className={`w-full text-left px-2.5 py-2 rounded-md transition-all cursor-pointer ${
                  isActive
                    ? 'bg-[var(--color-accent)]/10 border-l-2 border-[var(--color-accent)]'
                    : 'hover:bg-[var(--color-bg-hover)] border-l-2 border-transparent'
                }`}
              >
                <div className="flex items-center gap-1.5">
                  <Terminal
                    size={12}
                    className={
                      isActive ? 'text-[var(--color-accent)]' : 'text-[var(--color-text-muted)]'
                    }
                  />
                  <span
                    className={`text-xs font-medium ${isActive ? 'text-[var(--color-accent)]' : 'text-[var(--color-text)]'}`}
                  >
                    {cmd.command}
                  </span>
                </div>
                <div className="mt-0.5 pl-[18px] text-[10px] text-[var(--color-text-muted)] line-clamp-2">
                  {cmd.description}
                </div>
              </button>
            </li>
          )
        })}
      </ul>
    </div>
  )
}
