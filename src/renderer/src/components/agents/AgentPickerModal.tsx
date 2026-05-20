import { useEffect, useMemo, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { Bot, Check, Search, X } from 'lucide-react'

export interface AgentPickerItem {
  id: string
  name: string
  description?: string | null
  /** Short tag shown in the card corner (e.g. "A2A", "Cinna"). */
  meta?: string | null
  /** Optional group/section label for visual grouping. */
  group?: string | null
}

interface AgentPickerModalProps {
  open: boolean
  title?: string
  items: AgentPickerItem[]
  selectedId: string | null
  onSelect: (id: string | null) => void
  onClose: () => void
  /** Renders a leading "no agent" card. */
  allowNone?: boolean
  noneLabel?: string
  noneDescription?: string
  searchPlaceholder?: string
  emptyLabel?: string
}

interface NoneEntry {
  kind: 'none'
}
interface AgentEntry {
  kind: 'agent'
  item: AgentPickerItem
}
type Entry = NoneEntry | AgentEntry

function matches(item: AgentPickerItem, query: string): boolean {
  if (!query) return true
  const q = query.toLowerCase()
  if (item.name.toLowerCase().includes(q)) return true
  if (item.description && item.description.toLowerCase().includes(q)) return true
  if (item.meta && item.meta.toLowerCase().includes(q)) return true
  return false
}

export function AgentPickerModal({
  open,
  title = 'Select Agent',
  items,
  selectedId,
  onSelect,
  onClose,
  allowNone = false,
  noneLabel = 'No agent',
  noneDescription,
  searchPlaceholder = 'Search agents…',
  emptyLabel = 'No agents match'
}: AgentPickerModalProps): React.ReactPortal | null {
  const [query, setQuery] = useState('')
  const [activeIndex, setActiveIndex] = useState(0)
  const cardRef = useRef<HTMLDivElement>(null)
  const inputRef = useRef<HTMLInputElement>(null)
  const cardRefs = useRef<(HTMLButtonElement | null)[]>([])

  // Reset state each time the modal is opened.
  useEffect(() => {
    if (!open) return
    setQuery('')
    setActiveIndex(0)
    const t = window.setTimeout(() => inputRef.current?.focus(), 0)
    return () => window.clearTimeout(t)
  }, [open])

  const filtered = useMemo(() => items.filter((i) => matches(i, query)), [items, query])

  const entries: Entry[] = useMemo(() => {
    const list: Entry[] = []
    if (allowNone && (query === '' || matches({ id: '__none__', name: noneLabel, description: noneDescription }, query))) {
      list.push({ kind: 'none' })
    }
    for (const item of filtered) list.push({ kind: 'agent', item })
    return list
  }, [allowNone, filtered, noneDescription, noneLabel, query])

  // Group agent entries by group label, preserving order of first appearance.
  const grouped = useMemo(() => {
    const sections: Array<{ label: string | null; entries: Entry[] }> = []
    const indexByLabel = new Map<string | null, number>()
    for (const e of entries) {
      const label = e.kind === 'none' ? null : (e.item.group ?? null)
      let idx = indexByLabel.get(label)
      if (idx === undefined) {
        idx = sections.length
        indexByLabel.set(label, idx)
        sections.push({ label, entries: [] })
      }
      sections[idx].entries.push(e)
    }
    return sections
  }, [entries])

  // Clamp activeIndex into range whenever the filtered list changes.
  useEffect(() => {
    if (activeIndex >= entries.length) setActiveIndex(Math.max(0, entries.length - 1))
  }, [entries.length, activeIndex])

  useEffect(() => {
    cardRefs.current[activeIndex]?.scrollIntoView({ block: 'nearest' })
  }, [activeIndex])

  // ESC + outside-click close.
  useEffect(() => {
    if (!open) return
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') {
        e.preventDefault()
        onClose()
      }
    }
    const onMouseDown = (e: MouseEvent): void => {
      if (cardRef.current && !cardRef.current.contains(e.target as Node)) onClose()
    }
    window.addEventListener('keydown', onKey)
    window.addEventListener('mousedown', onMouseDown)
    return () => {
      window.removeEventListener('keydown', onKey)
      window.removeEventListener('mousedown', onMouseDown)
    }
  }, [open, onClose])

  if (!open) return null

  const handlePick = (entry: Entry): void => {
    if (entry.kind === 'none') onSelect(null)
    else onSelect(entry.item.id)
    onClose()
  }

  const handleSearchKey = (e: React.KeyboardEvent<HTMLInputElement>): void => {
    if (entries.length === 0) return
    if (e.key === 'ArrowDown') {
      e.preventDefault()
      setActiveIndex((i) => Math.min(entries.length - 1, i + 1))
    } else if (e.key === 'ArrowUp') {
      e.preventDefault()
      setActiveIndex((i) => Math.max(0, i - 1))
    } else if (e.key === 'ArrowRight') {
      e.preventDefault()
      setActiveIndex((i) => Math.min(entries.length - 1, i + 1))
    } else if (e.key === 'ArrowLeft') {
      e.preventDefault()
      setActiveIndex((i) => Math.max(0, i - 1))
    } else if (e.key === 'Enter') {
      e.preventDefault()
      const entry = entries[activeIndex]
      if (entry) handlePick(entry)
    }
  }

  let runningIndex = 0

  return createPortal(
    <div
      role="dialog"
      aria-modal="true"
      aria-label={title}
      className="fixed inset-0 z-50 flex items-center justify-center px-4"
    >
      <div
        ref={cardRef}
        className="w-full max-w-[34rem] h-[32rem] rounded-xl shadow-2xl flex flex-col overflow-hidden
          bg-[var(--color-accent)]/10 [[data-theme=light]_&]:bg-[var(--color-accent)]/4
          backdrop-blur-xl
          border border-[var(--color-accent)]/25 [[data-theme=light]_&]:border-[var(--color-accent)]/12"
      >
        {/* Header */}
        <div className="flex items-center justify-between px-4 pt-3.5 pb-2">
          <div className="text-sm font-semibold text-[var(--color-text)]">{title}</div>
          <button
            type="button"
            onClick={onClose}
            className="p-1 rounded hover:bg-[var(--color-bg-hover)] text-[var(--color-text-muted)] hover:text-[var(--color-text)] transition-colors"
            title="Close"
            aria-label="Close"
          >
            <X size={14} />
          </button>
        </div>

        {/* Search */}
        <div className="px-4 pb-3">
          <div className="relative">
            <Search
              size={13}
              className="absolute left-2.5 top-1/2 -translate-y-1/2 text-[var(--color-text-muted)]"
            />
            <input
              ref={inputRef}
              value={query}
              onChange={(e) => {
                setQuery(e.target.value)
                setActiveIndex(0)
              }}
              onKeyDown={handleSearchKey}
              placeholder={searchPlaceholder}
              className="w-full bg-[var(--color-bg)]/40 [[data-theme=light]_&]:bg-white/40 text-[var(--color-text)] pl-7 pr-2.5 py-1.5 rounded-md text-xs border border-[var(--color-accent)]/20 focus:border-[var(--color-accent)] focus:outline-none placeholder:text-[var(--color-text-muted)]"
            />
          </div>
        </div>

        {/* Card grid */}
        <div className="px-4 pb-4 overflow-y-auto flex-1 min-h-0">
          {entries.length === 0 ? (
            <div className="h-full flex items-center justify-center text-xs text-[var(--color-text-muted)]">
              {emptyLabel}
            </div>
          ) : (
            <div className="space-y-3">
              {grouped.map((section, sIdx) => (
                <div key={section.label ?? `__nolabel__${sIdx}`}>
                  {section.label && (
                    <div className="text-[10px] font-semibold text-[var(--color-text-muted)] uppercase tracking-wider mb-1.5">
                      {section.label}
                    </div>
                  )}
                  <div className="grid grid-cols-2 gap-2">
                    {section.entries.map((entry) => {
                      const index = runningIndex++
                      const isNone = entry.kind === 'none'
                      const isActive = index === activeIndex
                      const isSelected = isNone
                        ? selectedId === null
                        : entry.item.id === selectedId

                      const name = isNone ? noneLabel : entry.item.name
                      const description = isNone ? noneDescription : entry.item.description
                      const meta = isNone ? null : entry.item.meta

                      // All cards sit on an opaque bg-secondary base; the gradient
                      // overlay (with alpha stops) is layered on top via background-image
                      // so the underlying color stays solid.
                      const baseBg = 'bg-[var(--color-bg-secondary)]'
                      const cardClass = isSelected
                        ? `${baseBg} border-[var(--color-accent)]/70 ` +
                          'bg-gradient-to-br from-[var(--color-accent)]/65 to-[var(--color-accent)]/35 ' +
                          '[[data-theme=light]_&]:from-[var(--color-accent)]/40 [[data-theme=light]_&]:to-[var(--color-accent)]/20'
                        : isActive
                          ? `${baseBg} border-[var(--color-accent)]/40 ` +
                            'bg-gradient-to-br from-[var(--color-accent)]/22 to-[var(--color-accent)]/8 ' +
                            '[[data-theme=light]_&]:from-[var(--color-accent)]/14 [[data-theme=light]_&]:to-[var(--color-accent)]/4'
                          : `${baseBg} border-[var(--color-border)] ` +
                            'hover:border-[var(--color-accent)]/30'

                      const primaryTextClass = isSelected
                        ? 'text-[var(--color-on-accent)]'
                        : 'text-[var(--color-text)]'
                      const secondaryTextClass = isSelected
                        ? 'text-[var(--color-on-accent)]/80'
                        : 'text-[var(--color-text-muted)]'
                      const iconWrapClass = isSelected
                        ? 'bg-[var(--color-on-accent)]/15 text-[var(--color-on-accent)]'
                        : isActive
                          ? 'bg-[var(--color-accent)]/15 text-[var(--color-accent)]'
                          : 'bg-[var(--color-bg)] text-[var(--color-text-muted)]'
                      const metaPillClass = isSelected
                        ? 'bg-[var(--color-on-accent)]/15 text-[var(--color-on-accent)] border-[var(--color-on-accent)]/20'
                        : 'bg-[var(--color-bg)] text-[var(--color-text-muted)] border-[var(--color-border)]'

                      return (
                        <button
                          key={isNone ? '__none__' : entry.item.id}
                          ref={(el) => {
                            cardRefs.current[index] = el
                          }}
                          type="button"
                          onMouseEnter={() => setActiveIndex(index)}
                          onClick={() => handlePick(entry)}
                          className={`relative text-left p-3 rounded-lg border transition-colors ${cardClass}`}
                        >
                          {isSelected && (
                            <span className="absolute top-2 right-2 inline-flex items-center justify-center w-4 h-4 rounded-full bg-[var(--color-on-accent)]/20 text-[var(--color-on-accent)]">
                              <Check size={10} />
                            </span>
                          )}
                          <div className="flex items-start gap-2">
                            <div
                              className={`shrink-0 w-7 h-7 rounded-md flex items-center justify-center ${iconWrapClass}`}
                            >
                              <Bot size={14} />
                            </div>
                            <div className="min-w-0 flex-1 pr-4">
                              <div className="flex items-center gap-1.5">
                                <span className={`text-xs font-medium truncate ${primaryTextClass}`}>
                                  {name}
                                </span>
                              </div>
                              {description && (
                                <div className={`mt-0.5 text-[10px] line-clamp-2 ${secondaryTextClass}`}>
                                  {description}
                                </div>
                              )}
                              {meta && (
                                <div className="mt-1.5">
                                  <span
                                    className={`inline-flex items-center px-1.5 py-0.5 rounded text-[9px] font-semibold uppercase tracking-wider border ${metaPillClass}`}
                                  >
                                    {meta}
                                  </span>
                                </div>
                              )}
                            </div>
                          </div>
                        </button>
                      )
                    })}
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>
      </div>
    </div>,
    document.body
  )
}
