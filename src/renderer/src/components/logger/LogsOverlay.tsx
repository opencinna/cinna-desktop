import { useEffect, useMemo, useRef, useState } from 'react'
import { X, Trash2, ChevronDown, ChevronRight, Pause, Play } from 'lucide-react'
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

function LogRow({ entry }: { entry: LogEntry }): React.JSX.Element {
  const [expanded, setExpanded] = useState(false)
  const hasData = entry.data !== undefined && entry.data !== null
  const dataStr = useMemo(() => {
    if (!hasData) return ''
    try {
      return typeof entry.data === 'string' ? entry.data : JSON.stringify(entry.data, null, 2)
    } catch {
      return String(entry.data)
    }
  }, [entry.data, hasData])

  return (
    <div className="border-b border-[var(--color-border)]/40 font-mono text-[11px] leading-snug">
      <button
        type="button"
        onClick={() => hasData && setExpanded(!expanded)}
        className={`w-full text-left flex items-start gap-2 px-3 py-1 ${
          hasData ? 'hover:bg-[var(--color-bg-hover)] cursor-pointer' : 'cursor-default'
        }`}
      >
        <span className="shrink-0 w-3 pt-0.5 text-[var(--color-text-muted)]">
          {hasData ? (expanded ? <ChevronDown size={10} /> : <ChevronRight size={10} />) : null}
        </span>
        <span className="shrink-0 text-[var(--color-text-muted)]">{formatTime(entry.timestamp)}</span>
        <span className={`shrink-0 font-semibold ${LEVEL_COLORS[entry.level]}`}>
          {LEVEL_LABELS[entry.level]}
        </span>
        <span className="shrink-0 text-[var(--color-accent)]">
          [{entry.source}]
        </span>
        <span className="shrink-0 text-[var(--color-text-secondary)]">[{entry.scope}]</span>
        <span className="flex-1 text-[var(--color-text)] break-words whitespace-pre-wrap">
          {entry.message}
        </span>
      </button>
      {hasData && expanded && (
        <pre className="px-10 pb-2 text-[10px] text-[var(--color-text-secondary)] whitespace-pre-wrap break-all">
          {dataStr}
        </pre>
      )}
    </div>
  )
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
  const bottomRef = useRef<HTMLDivElement | null>(null)

  useEffect(() => {
    if (logsOpen) void subscribe()
  }, [logsOpen, subscribe])

  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape' && logsOpen) {
        e.preventDefault()
        setLogsOpen(false)
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [logsOpen, setLogsOpen])

  useEffect(() => {
    const unsub = window.api.logger.onToggleOverlay(() => {
      const { loggerEnabled: enabled, logsOpen: open, setLogsOpen: set } = useUIStore.getState()
      if (!enabled) return
      set(!open)
    })
    return unsub
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
    if (autoScroll && logsOpen) {
      bottomRef.current?.scrollIntoView({ block: 'end' })
    }
  }, [filtered, autoScroll, logsOpen])

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
          onClick={() => void clear()}
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
            {filtered.map((e) => (
              <LogRow key={e.id} entry={e} />
            ))}
            <div ref={bottomRef} />
          </>
        )}
      </div>
      </div>
    </div>
  )
}
