import { useEffect, useRef, type RefObject } from 'react'
import type { LucideIcon } from 'lucide-react'

export interface AttachMenuItem {
  id: string
  label: string
  icon: LucideIcon
  onSelect: () => void
  /** Optional disabled state — renders the row dimmed and ignores click. */
  disabled?: boolean
}

interface AttachMenuPopupProps {
  items: AttachMenuItem[]
  onClose: () => void
  /** Trigger button; clicks inside it are not counted as "outside". */
  anchorRef: RefObject<HTMLElement | null>
}

/**
 * Small right-anchored action menu floating above the [+] attach button.
 * Currently exposes one item ("Add files"); the array shape is here so new
 * options (clipboard, drag-zone, browse workspace, ...) can be added later
 * without restructuring the trigger.
 */
export function AttachMenuPopup({
  items,
  onClose,
  anchorRef
}: AttachMenuPopupProps): React.JSX.Element {
  const ref = useRef<HTMLDivElement>(null)

  useEffect(() => {
    const onMouseDown = (e: MouseEvent): void => {
      const target = e.target as Node | null
      if (!target) return
      if (ref.current?.contains(target)) return
      if (anchorRef.current?.contains(target)) return
      onClose()
    }
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') onClose()
    }
    document.addEventListener('mousedown', onMouseDown)
    document.addEventListener('keydown', onKey)
    return () => {
      document.removeEventListener('mousedown', onMouseDown)
      document.removeEventListener('keydown', onKey)
    }
  }, [onClose, anchorRef])

  return (
    <div
      ref={ref}
      role="menu"
      aria-label="Attach"
      className="absolute bottom-full right-0 mb-1 min-w-[10rem]
        bg-[var(--color-accent)]/10 [[data-theme=light]_&]:bg-[var(--color-accent)]/5
        backdrop-blur-xl
        border border-[var(--color-accent)]/25 [[data-theme=light]_&]:border-[var(--color-accent)]/12
        rounded-lg shadow-xl z-50 overflow-hidden py-1"
    >
      {items.map((item) => {
        const Icon = item.icon
        return (
          <button
            key={item.id}
            type="button"
            role="menuitem"
            disabled={item.disabled}
            onClick={() => {
              if (item.disabled) return
              item.onSelect()
              onClose()
            }}
            className="w-full flex items-center gap-2 px-2.5 py-1.5 text-left text-[12px]
              text-[var(--color-text)]
              hover:bg-[var(--color-accent)]/20
              disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
          >
            <Icon size={14} className="shrink-0 text-[var(--color-text-secondary)]" />
            <span>{item.label}</span>
          </button>
        )
      })}
    </div>
  )
}
