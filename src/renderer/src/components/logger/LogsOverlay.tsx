import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { X, Trash2, ChevronDown, ChevronRight, Pause, Play, Copy, Check } from 'lucide-react'
import { useUIStore } from '../../stores/ui.store'
import { useLoggerStore, type LogEntry, type LogLevel } from '../../stores/logger.store'

const LEVEL_COLORS: Record<LogLevel, string> = {
  debug: 'text-[var(--color-text-muted)]',
  info: 'text-[var(--color-text-secondary)]',
  warn: 'text-[var(--color-warning)]',
  error: 'text-[var(--color-danger)]'
}

const LEVEL_LABELS: Record<LogLevel, string> = {
  debug: 'DBG',
  info: 'INF',
  warn: 'WRN',
  error: 'ERR'
}

function formatTime(ts: number): string {
  const d = new Date(ts)
  const hh = String(d.getHours()).padStart(2, '0')
  const mm = String(d.getMinutes()).padStart(2, '0')
  const ss = String(d.getSeconds()).padStart(2, '0')
  const ms = String(d.getMilliseconds()).padStart(3, '0')
  return `${hh}:${mm}:${ss}.${ms}`
}

function stringifyData(data: unknown): string {
  if (data === undefined || data === null) return ''
  try {
    return typeof data === 'string' ? data : JSON.stringify(data, null, 2)
  } catch {
    return String(data)
  }
}

function formatEntryForCopy(entry: LogEntry): string {
  const head = `[${formatTime(entry.timestamp)}] ${LEVEL_LABELS[entry.level]} [${entry.source}:${entry.scope}] ${entry.message}`
  const data = stringifyData(entry.data)
  if (!data) return head
  const indented = data
    .split('\n')
    .map((l) => '  ' + l)
    .join('\n')
  return `${head}\n${indented}`
}

interface LogRowProps {
  entry: LogEntry
  index: number
  selected: boolean
  expanded: boolean
  onMouseDown: (e: React.MouseEvent, entry: LogEntry, index: number) => void
  onMouseEnter: (entry: LogEntry, index: number) => void
  onChevronClick: (e: React.MouseEvent, entry: LogEntry) => void
}

function LogRow({
  entry,
  index,
  selected,
  expanded,
  onMouseDown,
  onMouseEnter,
  onChevronClick
}: LogRowProps): React.JSX.Element {
  const hasData = entry.data !== undefined && entry.data !== null
  const dataStr = useMemo(() => (hasData ? stringifyData(entry.data) : ''), [entry.data, hasData])

  return (
    <div
      data-log-index={index}
      onMouseDown={(e) => onMouseDown(e, entry, index)}
      onMouseEnter={() => onMouseEnter(entry, index)}
      className={`select-none border-b border-[var(--color-border)]/40 font-mono text-[11px] leading-snug cursor-default ${
        selected
          ? 'bg-[var(--color-accent)]/20 hover:bg-[var(--color-accent)]/25'
          : 'hover:bg-[var(--color-bg-hover)]'
      }`}
    >
      <div className="flex items-start gap-2 px-3 py-1">
        <button
          type="button"
          onMouseDown={(e) => {
            if (hasData) e.stopPropagation()
          }}
          onClick={(e) => onChevronClick(e, entry)}
          disabled={!hasData}
          tabIndex={-1}
          className={`shrink-0 w-3 pt-0.5 text-[var(--color-text-muted)] ${
            hasData ? 'hover:text-[var(--color-text)] cursor-pointer' : 'cursor-default'
          }`}
          aria-label={expanded ? 'Collapse data' : 'Expand data'}
        >
          {hasData ? (expanded ? <ChevronDown size={10} /> : <ChevronRight size={10} />) : null}
        </button>
        <span className="shrink-0 text-[var(--color-text-muted)]">{formatTime(entry.timestamp)}</span>
        <span className={`shrink-0 font-semibold ${LEVEL_COLORS[entry.level]}`}>
          {LEVEL_LABELS[entry.level]}
        </span>
        <span className="shrink-0 text-[var(--color-accent)]">[{entry.source}]</span>
        <span className="shrink-0 text-[var(--color-text-secondary)]">[{entry.scope}]</span>
        <span className="flex-1 text-[var(--color-text)] break-words whitespace-pre-wrap">
          {entry.message}
        </span>
      </div>
      {hasData && expanded && (
        <pre className="px-10 pb-2 text-[10px] text-[var(--color-text-secondary)] whitespace-pre-wrap break-all">
          {dataStr}
        </pre>
      )}
    </div>
  )
}

interface DragState {
  anchorIndex: number
  baseSelection: Set<number>
  moved: boolean
}

export function LogsOverlay(): React.JSX.Element | null {
  const { logsOpen, setLogsOpen } = useUIStore()
  const entries = useLoggerStore((s) => s.entries)
  const subscribe = useLoggerStore((s) => s.subscribe)
  const clear = useLoggerStore((s) => s.clear)

  const [filter, setFilter] = useState('')
  const [levels, setLevels] = useState<Record<LogLevel, boolean>>({
    debug: true,
    info: true,
    warn: true,
    error: true
  })
  const [autoScroll, setAutoScroll] = useState(true)
  const [selected, setSelected] = useState<Set<number>>(new Set())
  const [expandedIds, setExpandedIds] = useState<Set<number>>(new Set())
  const [anchorIndex, setAnchorIndex] = useState<number | null>(null)
  const [copyState, setCopyState] = useState<'idle' | 'ok' | 'err'>('idle')
  const [copyDropped, setCopyDropped] = useState(0)
  const [copyWritten, setCopyWritten] = useState(0)
  const dragRef = useRef<DragState | null>(null)
  const filteredRef = useRef<LogEntry[]>([])
  const bottomRef = useRef<HTMLDivElement | null>(null)

  useEffect(() => {
    if (logsOpen) void subscribe()
  }, [logsOpen, subscribe])

  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape' && logsOpen) {
        e.preventDefault()
        if (selected.size > 0) {
          setSelected(new Set())
          setAnchorIndex(null)
        } else {
          setLogsOpen(false)
        }
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [logsOpen, setLogsOpen, selected.size])

  useEffect(() => {
    const unsub = window.api.logger.onToggleOverlay(() => {
      const { logsOpen: open, setLogsOpen: set } = useUIStore.getState()
      set(!open)
    })
    return unsub
  }, [])

  useEffect(() => {
    const onUp = (): void => {
      dragRef.current = null
    }
    window.addEventListener('mouseup', onUp)
    return () => window.removeEventListener('mouseup', onUp)
  }, [])

  const filtered = useMemo(() => {
    const q = filter.trim().toLowerCase()
    return entries.filter((e) => {
      if (!levels[e.level]) return false
      if (!q) return true
      if (e.scope.toLowerCase().includes(q)) return true
      if (e.message.toLowerCase().includes(q)) return true
      if (e.source.toLowerCase().includes(q)) return true
      return false
    })
  }, [entries, filter, levels])

  useEffect(() => {
    filteredRef.current = filtered
  }, [filtered])

  useEffect(() => {
    if (autoScroll && logsOpen) {
      bottomRef.current?.scrollIntoView({ block: 'end' })
    }
  }, [filtered, autoScroll, logsOpen])

  const handleRowMouseDown = useCallback(
    (e: React.MouseEvent, entry: LogEntry, index: number) => {
      if (e.button !== 0) return
      const additive = e.metaKey || e.ctrlKey
      const shift = e.shiftKey

      setSelected((prev) => {
        let next: Set<number>
        if (shift && anchorIndex != null) {
          const [lo, hi] = anchorIndex < index ? [anchorIndex, index] : [index, anchorIndex]
          next = additive ? new Set(prev) : new Set()
          for (let i = lo; i <= hi; i++) {
            const en = filteredRef.current[i]
            if (en) next.add(en.id)
          }
        } else if (additive) {
          next = new Set(prev)
          if (next.has(entry.id)) next.delete(entry.id)
          else next.add(entry.id)
        } else {
          next = new Set([entry.id])
        }
        return next
      })

      if (!shift) setAnchorIndex(index)
      dragRef.current = {
        anchorIndex: shift && anchorIndex != null ? anchorIndex : index,
        baseSelection: additive ? new Set(selected) : new Set(),
        moved: false
      }
    },
    [anchorIndex, selected]
  )

  const handleRowMouseEnter = useCallback((_entry: LogEntry, index: number) => {
    const drag = dragRef.current
    if (!drag) return
    drag.moved = true
    const a = drag.anchorIndex
    const [lo, hi] = a < index ? [a, index] : [index, a]
    setSelected(() => {
      const next = new Set(drag.baseSelection)
      for (let i = lo; i <= hi; i++) {
        const en = filteredRef.current[i]
        if (en) next.add(en.id)
      }
      return next
    })
  }, [])

  const handleChevronClick = useCallback((e: React.MouseEvent, entry: LogEntry) => {
    e.stopPropagation()
    setExpandedIds((prev) => {
      const next = new Set(prev)
      if (next.has(entry.id)) next.delete(entry.id)
      else next.add(entry.id)
      return next
    })
  }, [])

  const selectedCount = selected.size

  const clearSelection = useCallback(() => {
    setSelected(new Set())
    setAnchorIndex(null)
  }, [])

  const copySelection = useCallback(async () => {
    if (selectedCount === 0) return
    const byId = new Map(entries.map((e) => [e.id, e] as const))
    const ordered = Array.from(selected)
      .map((id) => byId.get(id))
      .filter((e): e is LogEntry => Boolean(e))
      .sort((a, b) => a.id - b.id)
    const text = ordered.map(formatEntryForCopy).join('\n')
    setCopyWritten(ordered.length)
    setCopyDropped(selectedCount - ordered.length)
    try {
      await navigator.clipboard.writeText(text)
      setCopyState('ok')
    } catch {
      setCopyState('err')
    }
    window.setTimeout(() => setCopyState('idle'), 1500)
  }, [entries, selected, selectedCount])

  if (!logsOpen) return null

  return (
    <div
      className="fixed inset-0 z-50 flex items-stretch justify-stretch bg-black/40 backdrop-blur-sm"
      style={{ padding: '5vmin' }}
      onClick={() => setLogsOpen(false)}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        className="relative flex-1 flex flex-col rounded-xl overflow-hidden border border-[var(--color-border)] bg-[var(--color-bg)] shadow-2xl"
      >
        <button
          onClick={() => setLogsOpen(false)}
          className="absolute top-2 right-2 z-10 p-1.5 rounded-md text-[var(--color-text-muted)] hover:bg-[var(--color-bg-hover)] hover:text-[var(--color-text)] transition-colors"
          title="Close"
        >
          <X size={14} />
        </button>
        <div className="flex items-center gap-3 px-4 py-2 pr-12 border-b border-[var(--color-border)] bg-[var(--color-bg-secondary)]">
          <h2 className="text-sm font-semibold text-[var(--color-text)]">App Logs</h2>

          <input
            type="text"
            value={filter}
            onChange={(e) => setFilter(e.target.value)}
            placeholder="Filter by scope, message, source..."
            className="flex-1 max-w-md px-2.5 py-1 rounded-md text-xs bg-[var(--color-bg)] border border-[var(--color-border)] text-[var(--color-text)] placeholder:text-[var(--color-text-muted)] focus:outline-none focus:border-[var(--color-accent)]"
          />

          <div className="flex items-center gap-1">
            {(['debug', 'info', 'warn', 'error'] as LogLevel[]).map((lvl) => (
              <button
                key={lvl}
                onClick={() => setLevels((s) => ({ ...s, [lvl]: !s[lvl] }))}
                className={`px-2 py-1 rounded-md text-[10px] font-mono font-semibold transition-colors ${
                  levels[lvl]
                    ? `${LEVEL_COLORS[lvl]} bg-[var(--color-bg-tertiary)]`
                    : 'text-[var(--color-text-muted)] opacity-50 hover:opacity-80'
                }`}
                title={`Toggle ${lvl}`}
              >
                {LEVEL_LABELS[lvl]}
              </button>
            ))}
          </div>

          <span className="text-[10px] text-[var(--color-text-muted)]">
            {filtered.length}/{entries.length}
          </span>

          {selectedCount > 0 && (
            <div className="flex items-center gap-1 pl-2 ml-1 border-l border-[var(--color-border)]">
              <span className="text-[10px] font-mono text-[var(--color-text-secondary)]">
                {selectedCount} selected
              </span>
              <button
                onClick={() => void copySelection()}
                className={`flex items-center gap-1 px-2 py-1 rounded-md text-[10px] font-semibold transition-colors ${
                  copyState === 'ok'
                    ? 'text-[var(--color-success,var(--color-accent))] bg-[var(--color-bg-tertiary)]'
                    : copyState === 'err'
                      ? 'text-[var(--color-danger)] bg-[var(--color-bg-tertiary)]'
                      : 'text-[var(--color-text)] bg-[var(--color-accent)]/15 hover:bg-[var(--color-accent)]/25'
                }`}
                title="Copy selected entries to clipboard"
              >
                {copyState === 'ok' ? <Check size={12} /> : <Copy size={12} />}
                {copyState === 'ok'
                  ? copyDropped > 0
                    ? `Copied ${copyWritten}/${copyWritten + copyDropped}`
                    : 'Copied'
                  : copyState === 'err'
                    ? 'Failed'
                    : `Copy ${selectedCount}`}
              </button>
              <button
                onClick={clearSelection}
                className="p-1 rounded-md text-[var(--color-text-muted)] hover:bg-[var(--color-bg-hover)] hover:text-[var(--color-text)] transition-colors"
                title="Clear selection (Esc)"
              >
                <X size={12} />
              </button>
            </div>
          )}

          <button
            onClick={() => setAutoScroll(!autoScroll)}
            className={`p-1.5 rounded-md transition-colors ${
              autoScroll
                ? 'text-[var(--color-accent)] bg-[var(--color-bg-tertiary)]'
                : 'text-[var(--color-text-muted)] hover:bg-[var(--color-bg-hover)]'
            }`}
            title={autoScroll ? 'Pause auto-scroll' : 'Resume auto-scroll'}
          >
            {autoScroll ? <Pause size={14} /> : <Play size={14} />}
          </button>

          <button
            onClick={() => {
              void clear()
              clearSelection()
            }}
            className="p-1.5 rounded-md text-[var(--color-text-muted)] hover:bg-[var(--color-bg-hover)] hover:text-[var(--color-danger)] transition-colors"
            title="Clear logs"
          >
            <Trash2 size={14} />
          </button>
        </div>

        <div className="flex-1 overflow-y-auto bg-[var(--color-bg)]">
          {filtered.length === 0 ? (
            <div className="h-full flex items-center justify-center text-xs text-[var(--color-text-muted)]">
              No log entries {entries.length > 0 ? 'match filter' : 'yet'}
            </div>
          ) : (
            <>
              {filtered.map((e, i) => (
                <LogRow
                  key={e.id}
                  entry={e}
                  index={i}
                  selected={selected.has(e.id)}
                  expanded={expandedIds.has(e.id)}
                  onMouseDown={handleRowMouseDown}
                  onMouseEnter={handleRowMouseEnter}
                  onChevronClick={handleChevronClick}
                />
              ))}
              <div ref={bottomRef} />
            </>
          )}
        </div>
      </div>
    </div>
  )
}
