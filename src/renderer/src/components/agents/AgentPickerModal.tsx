import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { AlertTriangle, Bot, Check, Download, Loader2, Plug, Search, Sparkles, X } from 'lucide-react'
import { CATALOG_TEXT } from '../../utils/catalogItems'
import { CatalogKindBadge } from './CatalogKindBadge'
import { CHIP, KindIcon, PRIMARY } from './CatalogItemViews'
import { useCatalogType } from './catalogSurface'

export interface AgentPickerItem {
  id: string
  name: string
  description?: string | null
  /** Short tag shown in the card corner (e.g. "A2A", "Cinna"). */
  meta?: string | null
  /** Optional group/section label for visual grouping. */
  group?: string | null
  /** Card glyph. `'connector'` renders a Plug (MCP); default is a Bot (agent). */
  iconKind?: 'agent' | 'connector'
}

/**
 * A catalog agent not on this computer yet, rendered in the dedicated
 * "Catalog" section at the bottom of the picker. Unlike {@link AgentPickerItem}
 * these carry a Get action rather than a selection toggle — getting one makes
 * it a normal selectable capability (see `useCatalogPicker`).
 */
export interface CatalogPickerItem {
  /** The catalog item's uuid. */
  id: string
  /** Runs in Cinna or on this computer: its badge, as the catalog dialog shows it. */
  kind: 'cloud_agent' | 'desktop_agent'
  name: string
  description?: string | null
  /** Who stands behind it (maintainers or publisher), shown under the name. */
  meta?: string | null
  /** The latest version's label, in a chip beside the badge. */
  version?: string | null
  /** "Needs …": the credentials it asks for. */
  needs?: string | null
}

interface AgentPickerModalProps {
  open: boolean
  title?: string
  items: AgentPickerItem[]
  onClose: () => void
  searchPlaceholder?: string
  emptyLabel?: string
  /**
   * Multi-select mode: clicking an item toggles it via `onToggle` and the modal
   * stays open; selected items keep their checkmark. When false (default) the
   * modal is single-pick — `onSelect` fires and the modal closes.
   */
  multiSelect?: boolean
  // --- single-select props ---
  selectedId?: string | null
  onSelect?: (id: string | null) => void
  /** Renders a leading "no agent" card (single-select only). */
  allowNone?: boolean
  noneLabel?: string
  noneDescription?: string
  // --- multi-select props ---
  selectedIds?: Set<string>
  onToggle?: (id: string) => void
  /**
   * Active-first ordering (multi-select only): selected items float to the top
   * when the modal opens, then hold their position while the user toggles
   * (so a card never jumps under the cursor). The snapshot re-sorts on the next
   * open or when the item set itself changes. Mirrors the cinna-mobile picker.
   * Renders a single flat grid (group labels are ignored).
   */
  activeFirst?: boolean
  // --- catalog section (optional, multi-select only) ---
  /**
   * Catalog agents not on this computer yet, shown in a dedicated section at
   * the bottom of the list. Each renders with a Get button instead of a
   * selection toggle; the owner gets it and selects the agent it lands as.
   */
  catalogItems?: CatalogPickerItem[]
  /** Catalog item whose Get is in flight (drives the spinner). */
  installingCatalogId?: string | null
  /** A Get is running: every Get button waits. */
  catalogBusy?: boolean
  onInstallCatalog?: (id: string) => void
  /** Section label for the catalog group. */
  catalogLabel?: string
  /** Last install error, shown inline above the catalog cards. */
  catalogError?: string | null
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
  onClose,
  searchPlaceholder = 'Search agents…',
  emptyLabel = 'No agents match',
  multiSelect = false,
  selectedId = null,
  onSelect,
  allowNone = false,
  noneLabel = 'No agent',
  noneDescription,
  selectedIds,
  onToggle,
  activeFirst = false,
  catalogItems,
  installingCatalogId = null,
  catalogBusy = false,
  onInstallCatalog,
  catalogLabel = 'Catalog',
  catalogError = null
}: AgentPickerModalProps): React.ReactPortal | null {
  const [query, setQuery] = useState('')
  const [activeIndex, setActiveIndex] = useState(0)
  const cardRef = useRef<HTMLDivElement>(null)
  const inputRef = useRef<HTMLInputElement>(null)
  const cardRefs = useRef<(HTMLButtonElement | null)[]>([])
  // The catalog cards take the catalog dialog's scale, as its tiles do.
  const type = useCatalogType()

  // Active-first snapshot. Read selection through a ref so toggling doesn't
  // re-sort the list (the snapshot only refreshes on open or when the item
  // set's identity changes). Array.sort is stable, so within each bucket the
  // original order is preserved.
  const selectedIdsRef = useRef(selectedIds)
  selectedIdsRef.current = selectedIds
  const [order, setOrder] = useState<string[]>([])
  const capSig = useMemo(() => items.map((i) => i.id).join('|'), [items])

  // Reset state each time the modal is opened.
  useEffect(() => {
    if (!open) return
    setQuery('')
    setActiveIndex(0)
    const t = window.setTimeout(() => inputRef.current?.focus(), 0)
    return () => window.clearTimeout(t)
  }, [open])

  // (Re)compute the active-first snapshot at open time and whenever the item
  // set changes while open. Layout effect so the reorder lands before paint —
  // otherwise a reopen briefly shows the previous snapshot's order.
  useLayoutEffect(() => {
    if (!activeFirst || !open) return
    const sel = selectedIdsRef.current
    setOrder(
      [...items]
        .sort((a, b) => Number(!!sel?.has(b.id)) - Number(!!sel?.has(a.id)))
        .map((i) => i.id)
    )
  }, [open, capSig, activeFirst]) // eslint-disable-line react-hooks/exhaustive-deps

  // Items in snapshot order (active-first mode); plain `items` otherwise. Any
  // item missing from the snapshot (added while open) is appended.
  const orderedItems = useMemo(() => {
    if (!activeFirst || order.length === 0) return items
    const byId = new Map(items.map((i) => [i.id, i]))
    const ranked = order
      .map((id) => byId.get(id))
      .filter((i): i is AgentPickerItem => !!i)
    const inSnapshot = new Set(order)
    return [...ranked, ...items.filter((i) => !inSnapshot.has(i.id))]
  }, [activeFirst, order, items])

  const filtered = useMemo(
    () => orderedItems.filter((i) => matches(i, query)),
    [orderedItems, query]
  )

  // Catalog bundles run through the same search filter (name / description /
  // publisher) but render in their own section, outside the keyboard-nav
  // `entries` list — they're mouse-driven Install actions, not selectable rows.
  const filteredCatalog = useMemo(() => {
    const list = catalogItems ?? []
    if (!query) return list
    const q = query.toLowerCase()
    return list.filter(
      (c) =>
        c.name.toLowerCase().includes(q) ||
        !!c.description?.toLowerCase().includes(q) ||
        !!c.meta?.toLowerCase().includes(q)
    )
  }, [catalogItems, query])

  const entries: Entry[] = useMemo(() => {
    const list: Entry[] = []
    if (
      allowNone &&
      !multiSelect &&
      (query === '' || matches({ id: '__none__', name: noneLabel, description: noneDescription }, query))
    ) {
      list.push({ kind: 'none' })
    }
    for (const item of filtered) list.push({ kind: 'agent', item })
    return list
  }, [allowNone, multiSelect, filtered, noneDescription, noneLabel, query])

  // Group agent entries by group label, preserving order of first appearance.
  // Active-first mode renders a single flat grid (the snapshot order already
  // carries the active-first ranking, so section breaks would fight it).
  const grouped = useMemo(() => {
    if (activeFirst) return [{ label: null as string | null, entries }]
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
  }, [entries, activeFirst])

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
    if (entry.kind === 'none') {
      onSelect?.(null)
      onClose()
      return
    }
    if (multiSelect) {
      // Toggle and keep the modal open so the user can pick several.
      onToggle?.(entry.item.id)
      return
    }
    onSelect?.(entry.item.id)
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
          {entries.length === 0 && filteredCatalog.length === 0 ? (
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
                        : multiSelect
                          ? !!selectedIds?.has(entry.item.id)
                          : entry.item.id === selectedId
                      const ItemIcon =
                        !isNone && entry.item.iconKind === 'connector' ? Plug : Bot

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
                          className={`relative flex flex-col text-left p-3 rounded-lg border transition-colors ${cardClass}`}
                        >
                          {isSelected && (
                            <span className="absolute top-2 right-2 inline-flex items-center justify-center w-4 h-4 rounded-full bg-[var(--color-on-accent)]/20 text-[var(--color-on-accent)]">
                              <Check size={10} />
                            </span>
                          )}
                          {/* Icon + title share one top header row so they
                              line up; description/meta flow below it. */}
                          <div className="flex items-center gap-2">
                            <div
                              className={`shrink-0 w-7 h-7 rounded-md flex items-center justify-center ${iconWrapClass}`}
                            >
                              <ItemIcon size={14} />
                            </div>
                            <span
                              className={`min-w-0 flex-1 truncate text-xs font-medium pr-4 ${primaryTextClass}`}
                            >
                              {name}
                            </span>
                          </div>
                          {description && (
                            <div className={`mt-1.5 text-[10px] line-clamp-2 ${secondaryTextClass}`}>
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
                        </button>
                      )
                    })}
                  </div>
                </div>
              ))}

              {/* Catalog section — catalog agents not on this computer yet,
                  with a Get action. Sits at the very bottom, after the user's
                  own agents/MCP. */}
              {filteredCatalog.length > 0 && (
                <div>
                  <div className="flex items-center gap-1.5 mb-1.5 text-[10px] font-semibold text-[var(--color-text-muted)] uppercase tracking-wider">
                    <Sparkles size={11} />
                    {catalogLabel}
                  </div>
                  {catalogError && (
                    <div className="flex items-start gap-1.5 mb-2 px-2.5 py-1.5 rounded-md border border-[var(--color-danger)]/40 bg-[var(--color-danger)]/10 text-[11px] text-[var(--color-text-secondary)]">
                      <AlertTriangle
                        size={12}
                        className="mt-0.5 shrink-0 text-[var(--color-danger)]"
                      />
                      <span className="min-w-0">{catalogError}</span>
                    </div>
                  )}
                  <div className="grid grid-cols-2 gap-2">
                    {filteredCatalog.map((item) => {
                      const isInstalling = installingCatalogId === item.id
                      // The catalog tile's lines, in its order and at its scale (ux_rules rule 13).
                      return (
                        <div
                          key={item.id}
                          role="group"
                          aria-label={item.name}
                          className="relative flex flex-col rounded-lg border border-[var(--color-border)] bg-[var(--color-bg)]/40"
                        >
                          {isInstalling && (
                            <div className="absolute inset-0 z-10 flex items-center justify-center rounded-lg bg-[var(--color-bg-secondary)]/70 backdrop-blur-sm">
                              <Loader2
                                size={20}
                                className="animate-spin text-[var(--color-accent)]"
                              />
                            </div>
                          )}
                          <div className="flex flex-1 flex-col gap-1 p-3">
                            <span className="flex w-full min-w-0 items-center gap-2">
                              <KindIcon kind={item.kind} size="tile" />
                              <span title={item.name} className={`min-w-0 flex-1 truncate ${type.name} font-medium text-[var(--color-text)]`}>
                                {item.name}
                              </span>
                            </span>
                            <span className="flex w-full min-w-0 flex-wrap items-center gap-1.5">
                              <CatalogKindBadge kind={item.kind} />
                              {item.version && <span className={`${CHIP} ${type.meta}`}>{item.version}</span>}
                            </span>
                            {item.meta && (
                              <span className={`block w-full truncate ${type.meta} text-[var(--color-text-muted)]`} title={CATALOG_TEXT.by(item.meta)}>
                                {CATALOG_TEXT.by(item.meta)}
                              </span>
                            )}
                            {item.description && (
                              <span className={`line-clamp-3 ${type.body} leading-relaxed text-[var(--color-text-secondary)]`}>
                                {item.description}
                              </span>
                            )}
                            {item.needs && (
                              <span className={`block w-full truncate ${type.meta} text-[var(--color-text-muted)]`} title={item.needs}>
                                {item.needs}
                              </span>
                            )}
                          </div>
                          <div className="flex items-center justify-end gap-1.5 border-t border-[var(--color-border)] px-3 py-2">
                            <button
                              type="button"
                              disabled={catalogBusy}
                              aria-busy={isInstalling}
                              title={catalogBusy && !isInstalling ? CATALOG_TEXT.anotherGetting : undefined}
                              onClick={() => onInstallCatalog?.(item.id)}
                              className={PRIMARY}
                            >
                              {isInstalling ? (
                                <>
                                  <Loader2 size={11} className="animate-spin" />
                                  {CATALOG_TEXT.getting}
                                </>
                              ) : (
                                <>
                                  <Download size={11} />
                                  {CATALOG_TEXT.get}
                                </>
                              )}
                            </button>
                          </div>
                        </div>
                      )
                    })}
                  </div>
                </div>
              )}
            </div>
          )}
        </div>
      </div>
    </div>,
    document.body
  )
}
