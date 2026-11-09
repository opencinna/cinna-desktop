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

/** Below this pitch the extra gap between chats is dropped, so the dots alone fit. */
const MIN_GROUPED_PITCH = 4

export interface RailLayout {
  /** Dot size, px. */
  dot: number
  /** Space after each dot, px. */
  gap: number
  /** Extra space after a chat's last dot, px. */
  groupGap: number
}

/**
 * Dot sizes for `count` dots with `breaks` chat breaks in `height` px. Each
 * break takes one more pitch, so the rail is never taller than `height`:
 * (count + breaks) × pitch ≤ height. When that leaves too fine a pitch, the
 * breaks go and the dots shrink until they fit.
 */
export function railLayout(height: number, count: number, breaks: number): RailLayout {
  const room = Math.max(0, height)
  const n = Math.max(1, count)
  let pitch = Math.min(MAX_PITCH, room / (n + breaks))
  let groupGap = pitch
  if (pitch < MIN_GROUPED_PITCH) {
    pitch = Math.min(MAX_PITCH, room / n)
    groupGap = 0
  }
  const dot = Math.max(1, Math.min(6, pitch * 0.62, pitch))
  return { dot, gap: Math.max(0, pitch - dot), groupGap }
}

/**
 * The results listbox and the dot rail beside it. No scrollbar: one dot per
 * result, lit while that result is on screen, a gap between chats; a click on
 * a dot scrolls its result into view.
 */
export function SearchResultList({ id, label, entries, resultsKey, activeId, onActivate, children }: SearchResultListProps): React.JSX.Element {
  const listRef = useRef<HTMLDivElement | null>(null)
  const [seen, setSeen] = useState<ReadonlySet<string>>(new Set())
  const breaks = entries.reduce((n, entry, k) => n + (k > 0 && entries[k - 1].group !== entry.group ? 1 : 0), 0)
  const [rail, setRail] = useState<RailLayout>(() => railLayout(Infinity, entries.length, breaks))
  // The list's own height, less a margin: the rail never reaches the bar or the top bar.
  const layoutRail = useCallback(() => {
    const list = listRef.current
    if (!list) return
    const next = railLayout(list.clientHeight - 16, entries.length, breaks)
    setRail((prev) => (prev.dot === next.dot && prev.gap === next.gap && prev.groupGap === next.groupGap ? prev : next))
  }, [entries.length, breaks])

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
    layoutRail()
    paint()
  }, [resultsKey, layoutRail, paint])

  useEffect(() => {
    const list = listRef.current
    if (!list || typeof ResizeObserver === 'undefined') return
    const ro = new ResizeObserver(() => {
      layoutRail()
      paint()
    })
    ro.observe(list)
    return () => ro.disconnect()
  }, [resultsKey, layoutRail, paint])

  // The arrows moved the active result: keep it in view.
  useEffect(() => {
    if (!activeId) return
    const el = listRef.current?.ownerDocument.getElementById(activeId)
    if (el && typeof el.scrollIntoView === 'function') el.scrollIntoView({ block: 'nearest' })
  }, [activeId])

  return (
    <div className="chat-search-listwrap" data-rail={entries.length > 1 || undefined}>
      <div ref={listRef} id={id} role="listbox" aria-label={label} className="chat-search-list" key={resultsKey} onScroll={paint}>
        {children}
      </div>
      {entries.length > 1 && (
        <div
          className="chat-search-rail"
          aria-hidden="true"
          style={{
            ['--rail-dot' as string]: `${rail.dot}px`,
            ['--rail-gap' as string]: `${rail.gap}px`,
            ['--rail-group-gap' as string]: `${rail.groupGap}px`
          }}
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
