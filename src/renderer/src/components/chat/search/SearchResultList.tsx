import { useCallback, useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react'

export interface RailEntry {
  /** The option's DOM id. */
  id: string
  /** Which chat it belongs to: a gap opens in the rail between chats. */
  group: string
}

interface SearchResultListProps {
  id: string
  label: string
  /** The results in display order, top to bottom. */
  entries: readonly RailEntry[]
  /** Changes whenever the results do: the list then scrolls to its bottom, nearest the bar. */
  resultsKey: string
  activeId: string | undefined
  onActivate: (id: string) => void
  children: ReactNode
}

/** At most this many px per dot, dot and gap together. */
const MAX_PITCH = 9

/**
 * The results listbox and the dot rail beside it. No scrollbar: one dot per
 * result, lit while that result is on screen, a gap between chats; a click on
 * a dot scrolls its result into view.
 */
export function SearchResultList({ id, label, entries, resultsKey, activeId, onActivate, children }: SearchResultListProps): React.JSX.Element {
  const listRef = useRef<HTMLDivElement | null>(null)
  const [seen, setSeen] = useState<ReadonlySet<string>>(new Set())
  const [pitch, setPitch] = useState(MAX_PITCH)

  const paint = useCallback(() => {
    const list = listRef.current
    if (!list) return
    const box = list.getBoundingClientRect()
    const next = new Set<string>()
    for (const entry of entries) {
      const el = list.ownerDocument.getElementById(entry.id)
      if (!el) continue
      const r = el.getBoundingClientRect()
      const visible = Math.min(r.bottom, box.bottom) - Math.max(r.top, box.top)
      if (visible > Math.min(40, r.height * 0.4)) next.add(entry.id)
    }
    setSeen((prev) => (prev.size === next.size && [...next].every((k) => prev.has(k)) ? prev : next))
  }, [entries])

  // New results: the newest is nearest the bar, so the list starts at its bottom.
  useLayoutEffect(() => {
    const list = listRef.current
    if (!list) return
    list.scrollTop = list.scrollHeight
    setPitch(Math.max(4, Math.min(MAX_PITCH, (list.clientHeight - 24) / Math.max(1, entries.length))))
    paint()
  }, [resultsKey, entries.length, paint])

  useEffect(() => {
    const list = listRef.current
    if (!list || typeof ResizeObserver === 'undefined') return
    const ro = new ResizeObserver(() => {
      setPitch(Math.max(4, Math.min(MAX_PITCH, (list.clientHeight - 24) / Math.max(1, entries.length))))
      paint()
    })
    ro.observe(list)
    return () => ro.disconnect()
  }, [resultsKey, entries.length, paint])

  // The arrows moved the active result: keep it in view.
  useEffect(() => {
    if (!activeId) return
    const el = listRef.current?.ownerDocument.getElementById(activeId)
    if (el && typeof el.scrollIntoView === 'function') el.scrollIntoView({ block: 'nearest' })
  }, [activeId])

  const dot = Math.max(3, Math.min(6, pitch * 0.62))
  const gap = Math.max(1, pitch - dot)
  return (
    <div className="chat-search-listwrap">
      <div ref={listRef} id={id} role="listbox" aria-label={label} className="chat-search-list" key={resultsKey} onScroll={paint}>
        {children}
      </div>
      {entries.length > 1 && (
        <div
          className="chat-search-rail"
          aria-hidden="true"
          style={{ ['--rail-dot' as string]: `${dot}px`, ['--rail-gap' as string]: `${gap}px` }}
        >
          {entries.map((entry, k) => (
            <span
              key={entry.id}
              data-rail-dot
              className="chat-search-dot"
              data-seen={seen.has(entry.id) || undefined}
              data-group-end={(k < entries.length - 1 && entries[k + 1].group !== entry.group) || undefined}
              onClick={() => {
                const el = listRef.current?.ownerDocument.getElementById(entry.id)
                if (el && typeof el.scrollIntoView === 'function') el.scrollIntoView({ block: 'center', behavior: 'smooth' })
                onActivate(entry.id)
              }}
            />
          ))}
        </div>
      )}
    </div>
  )
}
