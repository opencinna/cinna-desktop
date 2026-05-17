import { Fragment } from 'react'

/**
 * Render a structured tool call (name + input params) in a compact,
 * user-friendly way. Generic over input shape — types are inferred at
 * render time and styled accordingly. Two variants:
 *
 *   - `inline`: single line, truncated, used inside collapsed headers
 *   - `block`:  multi-line, full values, used in the expanded view
 */

type AnyValue = unknown

const STRING_PREVIEW_MAX = 60
const STRING_BLOCK_MAX = 240

function isPlainObject(v: AnyValue): v is Record<string, unknown> {
  return !!v && typeof v === 'object' && !Array.isArray(v)
}

function looksLikePath(v: string): boolean {
  return /^(\.?\.?\/|[A-Za-z]:\\|\/)/.test(v) && v.length < 200
}

function truncate(s: string, n: number): { text: string; truncated: boolean } {
  if (s.length <= n) return { text: s, truncated: false }
  return { text: s.slice(0, n).trimEnd() + '…', truncated: true }
}

function ValueInline({ value }: { value: AnyValue }): React.JSX.Element {
  if (value === null || value === undefined) {
    return <span className="text-[var(--color-text-muted)] italic">{value === null ? 'null' : '—'}</span>
  }
  if (typeof value === 'boolean') {
    return (
      <span className={`px-1 rounded text-[10px] font-semibold ${value ? 'bg-[var(--color-success)]/15 text-[var(--color-success)]' : 'bg-[var(--color-text-muted)]/15 text-[var(--color-text-muted)]'}`}>
        {value ? 'true' : 'false'}
      </span>
    )
  }
  if (typeof value === 'number') {
    return <span className="text-[var(--color-accent)]">{value}</span>
  }
  if (typeof value === 'string') {
    const firstLine = value.split('\n')[0]
    const extraLines = value.split('\n').length - 1
    const { text } = truncate(firstLine, STRING_PREVIEW_MAX)
    const isPath = looksLikePath(value)
    return (
      <span className={isPath ? 'text-[var(--color-text)]' : 'text-[var(--color-text-secondary)]'}>
        {isPath ? text : `"${text}"`}
        {extraLines > 0 && <span className="text-[var(--color-text-muted)]"> +{extraLines}L</span>}
      </span>
    )
  }
  if (Array.isArray(value)) {
    return <span className="text-[var(--color-text-muted)]">[{value.length}]</span>
  }
  if (isPlainObject(value)) {
    const n = Object.keys(value).length
    return <span className="text-[var(--color-text-muted)]">{'{'}{n}{'}'}</span>
  }
  return <span className="text-[var(--color-text-muted)]">{String(value)}</span>
}

function ValueBlock({ value }: { value: AnyValue }): React.JSX.Element {
  if (value === null || value === undefined) {
    return <span className="text-[var(--color-text-muted)] italic">{value === null ? 'null' : '—'}</span>
  }
  if (typeof value === 'boolean') {
    return (
      <span className={`px-1.5 py-0.5 rounded text-[10px] font-semibold ${value ? 'bg-[var(--color-success)]/15 text-[var(--color-success)]' : 'bg-[var(--color-text-muted)]/15 text-[var(--color-text-muted)]'}`}>
        {value ? 'true' : 'false'}
      </span>
    )
  }
  if (typeof value === 'number') {
    return <span className="text-[var(--color-accent)] font-mono">{value}</span>
  }
  if (typeof value === 'string') {
    const isMultiline = value.includes('\n')
    if (isMultiline || value.length > STRING_BLOCK_MAX) {
      return (
        <pre className="mt-0.5 max-h-40 overflow-y-auto text-[11px] bg-[var(--color-bg)] px-2 py-1 rounded font-mono whitespace-pre-wrap break-words text-[var(--color-text)]">
          {value}
        </pre>
      )
    }
    const isPath = looksLikePath(value)
    return (
      <span className={`font-mono ${isPath ? 'text-[var(--color-text)]' : 'text-[var(--color-text-secondary)]'}`}>
        {isPath ? value : `"${value}"`}
      </span>
    )
  }
  if (Array.isArray(value)) {
    if (value.length === 0) return <span className="text-[var(--color-text-muted)]">[]</span>
    const allPrimitive = value.every(
      (v) => v === null || ['string', 'number', 'boolean'].includes(typeof v)
    )
    if (allPrimitive) {
      return (
        <span className="font-mono text-[var(--color-text-secondary)]">
          [
          {value.map((v, i) => (
            <Fragment key={i}>
              {i > 0 && <span className="text-[var(--color-text-muted)]">, </span>}
              <ValueInline value={v} />
            </Fragment>
          ))}
          ]
        </span>
      )
    }
    return (
      <pre className="mt-0.5 max-h-40 overflow-y-auto text-[11px] bg-[var(--color-bg)] px-2 py-1 rounded font-mono whitespace-pre-wrap break-words text-[var(--color-text)]">
        {JSON.stringify(value, null, 2)}
      </pre>
    )
  }
  if (isPlainObject(value)) {
    return (
      <div className="ml-2 mt-0.5 border-l border-[var(--color-border)] pl-2 space-y-0.5">
        {Object.entries(value).map(([k, v]) => (
          <div key={k} className="flex gap-1.5 items-baseline">
            <span className="text-[var(--color-text-muted)] font-mono shrink-0">{k}:</span>
            <ValueBlock value={v} />
          </div>
        ))}
      </div>
    )
  }
  return <span className="text-[var(--color-text-muted)] font-mono">{String(value)}</span>
}

interface ToolCallSummaryProps {
  name: string
  input?: Record<string, unknown>
  /** `inline` for collapsed/header use; `block` for expanded body. */
  variant?: 'inline' | 'block'
  /** Hide the tool name when the caller already shows it nearby. */
  hideName?: boolean
  /** Optional className override for the outer element. */
  className?: string
}

export function ToolCallSummary({
  name,
  input,
  variant = 'inline',
  hideName,
  className
}: ToolCallSummaryProps): React.JSX.Element {
  const entries = input ? Object.entries(input) : []

  if (variant === 'inline') {
    return (
      <span className={`inline-flex items-baseline gap-1 min-w-0 ${className ?? ''}`}>
        {!hideName && (
          <span className="font-mono text-[var(--color-accent)] shrink-0">{name}</span>
        )}
        {entries.length > 0 && (
          <span className="inline-flex items-baseline gap-1 min-w-0 overflow-hidden">
            <span className="text-[var(--color-text-muted)] shrink-0">(</span>
            <span className="inline-flex items-baseline gap-1 truncate font-mono text-[11px]">
              {entries.map(([k, v], i) => (
                <Fragment key={k}>
                  {i > 0 && <span className="text-[var(--color-text-muted)]">,</span>}
                  <span className="inline-flex items-baseline gap-1">
                    <span className="text-[var(--color-text-muted)]">{k}:</span>
                    <ValueInline value={v} />
                  </span>
                </Fragment>
              ))}
            </span>
            <span className="text-[var(--color-text-muted)] shrink-0">)</span>
          </span>
        )}
      </span>
    )
  }

  return (
    <div className={`text-[12px] ${className ?? ''}`}>
      {!hideName && (
        <div className="font-mono text-[var(--color-accent)] mb-1">{name}</div>
      )}
      {entries.length === 0 ? (
        <span className="text-[var(--color-text-muted)] italic text-[11px]">no arguments</span>
      ) : (
        <div className="space-y-1">
          {entries.map(([k, v]) => (
            <div key={k} className="flex gap-1.5 items-baseline">
              <span className="text-[var(--color-text-muted)] font-mono shrink-0">{k}:</span>
              <div className="min-w-0 flex-1"><ValueBlock value={v} /></div>
            </div>
          ))}
        </div>
      )}
    </div>
  )
}
