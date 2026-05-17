import { useEffect, useRef, type RefObject } from 'react'
import type { LucideIcon } from 'lucide-react'

export interface MentionPopupProps<T> {
  /** Already-filtered list — the parent owns the filter predicate. */
  items: T[]
  selectedIndex: number
  onSelect: (item: T) => void
  onClose: () => void
  listboxId: string
  /** Input that owns the popup — clicks inside it are treated as "inside". */
  anchorRef?: RefObject<HTMLElement | null>

  header: string
  ariaLabel: string
  icon: LucideIcon
  /** Tailwind width class for the popup container. */
  width?: string
  getKey: (item: T, index: number) => string
  getPrimary: (item: T) => string
  getSecondary?: (item: T) => string | null | undefined
  getMeta?: (item: T) => string | null | undefined
  secondaryClamp?: 'truncate' | 'line-clamp-2'
}

// Container is tinted with the accent on a frosted backdrop. Light theme uses
// a much weaker tint because the icon-blue accent reads too saturated against
// the bright background.
const CONTAINER_CLS =
  'absolute bottom-full mb-1 left-0 ' +
  'bg-[var(--color-accent)]/10 [[data-theme=light]_&]:bg-[var(--color-accent)]/4 ' +
  'backdrop-blur-xl ' +
  'border border-[var(--color-accent)]/25 [[data-theme=light]_&]:border-[var(--color-accent)]/12 ' +
  'rounded-lg shadow-xl z-50 overflow-hidden'

// Selected-item pill uses a left-to-right accent gradient. Foreground color is
// driven by --color-on-accent (white in dark theme, near-black in light theme)
// so the same opacity ladder works on either surface.
const ACTIVE_BG =
  'bg-gradient-to-r from-[var(--color-accent)]/65 to-[var(--color-accent)]/40 ' +
  '[[data-theme=light]_&]:from-[var(--color-accent)]/40 [[data-theme=light]_&]:to-[var(--color-accent)]/22'
const ACTIVE_TEXT = 'text-[var(--color-on-accent)]'
const ACTIVE_TEXT_70 = 'text-[var(--color-on-accent)]/70'
const ACTIVE_TEXT_80 = 'text-[var(--color-on-accent)]/80'

export function MentionPopup<T>({
  items,
  selectedIndex,
  onSelect,
  onClose,
  listboxId,
  anchorRef,
  header,
  ariaLabel,
  icon: Icon,
  width = 'w-72',
  getKey,
  getPrimary,
  getSecondary,
  getMeta,
  secondaryClamp = 'truncate'
}: MentionPopupProps<T>): React.JSX.Element | null {
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
    <div ref={ref} className={`${width} ${CONTAINER_CLS}`}>
      <div className="px-2.5 pt-2 pb-1">
        <div className="text-[10px] font-semibold text-[var(--color-text-muted)] uppercase tracking-wider mb-1.5">
          {header}
        </div>
      </div>

      <ul
        id={listboxId}
        role="listbox"
        aria-label={ariaLabel}
        className="px-1.5 pb-1.5 space-y-0.5 max-h-72 overflow-y-auto list-none m-0"
      >
        {items.map((item, i) => {
          const isActive = i === selectedIndex
          const optionId = `${listboxId}-opt-${i}`
          const secondary = getSecondary?.(item)
          const meta = getMeta?.(item)

          return (
            <li key={getKey(item, i)} role="presentation">
              <button
                id={optionId}
                role="option"
                aria-selected={isActive}
                type="button"
                ref={(el) => {
                  itemRefs.current[i] = el
                }}
                onClick={() => onSelect(item)}
                className={`w-full text-left px-2.5 py-2 rounded-md transition-all cursor-pointer ${
                  isActive ? `${ACTIVE_BG} ${ACTIVE_TEXT}` : 'hover:bg-[var(--color-bg-hover)]'
                }`}
              >
                <div className="flex items-center gap-1.5">
                  <Icon
                    size={12}
                    className={isActive ? ACTIVE_TEXT : 'text-[var(--color-text-muted)]'}
                  />
                  <span
                    className={`text-xs font-medium ${isActive ? ACTIVE_TEXT : 'text-[var(--color-text)]'}`}
                  >
                    {getPrimary(item)}
                  </span>
                  {meta && (
                    <span
                      className={`text-[10px] ml-auto ${isActive ? ACTIVE_TEXT_70 : 'text-[var(--color-text-muted)]'}`}
                    >
                      {meta}
                    </span>
                  )}
                </div>
                {secondary && (
                  <div
                    className={`mt-0.5 pl-[18px] text-[10px] ${secondaryClamp} ${isActive ? ACTIVE_TEXT_80 : 'text-[var(--color-text-muted)]'}`}
                  >
                    {secondary}
                  </div>
                )}
              </button>
            </li>
          )
        })}
      </ul>
    </div>
  )
}
