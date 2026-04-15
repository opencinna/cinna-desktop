import { Wrench, Check, X, Loader2, Plug, ChevronRight } from 'lucide-react'
import { useRef, useState } from 'react'

interface ToolCallBlockProps {
  name: string
  input: Record<string, unknown>
  result?: string | unknown
  error?: string
  status: 'pending' | 'done' | 'error'
  provider?: string
}

type ParsedResult = { type: 'text'; value: string } | { type: 'object'; value: Record<string, unknown> }

/** Try to parse a string as JSON object, fall back to plain text. */
function tryParseStructured(str: string): ParsedResult {
  try {
    const inner = JSON.parse(str)
    if (inner && typeof inner === 'object' && !Array.isArray(inner)) {
      return { type: 'object', value: inner as Record<string, unknown> }
    }
  } catch {
    // not JSON
  }
  return { type: 'text', value: str }
}

/**
 * Parse a result value into a structured form for rendering.
 * - MCP content block arrays `[{type:"text", text:"..."}]` -> plain text or object
 * - Plain JSON objects -> structured key-value view
 * - Everything else -> string
 */
function parseResult(raw: string | unknown): ParsedResult {
  if (typeof raw !== 'string') {
    if (raw && typeof raw === 'object' && !Array.isArray(raw)) {
      return { type: 'object', value: raw as Record<string, unknown> }
    }
    return { type: 'text', value: JSON.stringify(raw, null, 2) }
  }

  // Try to parse as JSON
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    return { type: 'text', value: raw }
  }

  // Handle MCP content block arrays: [{type:"text", text:"..."}, ...]
  if (Array.isArray(parsed)) {
    const textParts: string[] = []
    let allText = true
    for (const block of parsed) {
      if (block && typeof block === 'object' && block.type === 'text' && typeof block.text === 'string') {
        textParts.push(block.text)
      } else {
        allText = false
        break
      }
    }
    if (allText && textParts.length > 0) {
      // The extracted text itself might be JSON — try to parse it
      const joined = textParts.join('\n')
      return tryParseStructured(joined)
    }
    return { type: 'text', value: JSON.stringify(parsed, null, 2) }
  }

  // Plain JSON object -> structured view
  if (parsed && typeof parsed === 'object') {
    return { type: 'object', value: parsed as Record<string, unknown> }
  }

  return { type: 'text', value: JSON.stringify(parsed, null, 2) }
}

function JsonView({ data }: { data: Record<string, unknown> }): React.JSX.Element {
  const entries = Object.entries(data)

  if (entries.length === 0) {
    return <span className="text-[var(--color-text-muted)]">{'{}'}</span>
  }

  return (
    <div className="space-y-0.5">
      {entries.map(([key, value]) => {
        const displayValue = typeof value === 'string' ? value : JSON.stringify(value, null, 2)
        const isMultiline = typeof value === 'string' && value.includes('\n')

        return (
          <div key={key} className={isMultiline ? '' : 'flex gap-1.5'}>
            <span className="text-[var(--color-accent)] shrink-0">{key}:</span>
            {isMultiline ? (
              <pre className="mt-0.5 text-[var(--color-text)] whitespace-pre-wrap break-words">{displayValue}</pre>
            ) : (
              <span className="text-[var(--color-text)] break-all">{displayValue}</span>
            )}
          </div>
        )
      })}
    </div>
  )
}

export function ToolCallBlock({
  name,
  input,
  result,
  error,
  status,
  provider
}: ToolCallBlockProps): React.JSX.Element {
  const [expanded, setExpanded] = useState(false)

  const isPending = status === 'pending'

  const statusIcon =
    isPending ? (
      <Loader2 size={12} className="animate-spin text-[var(--color-warning)]" />
    ) : status === 'done' ? (
      <Check size={12} className="text-[var(--color-success)]" />
    ) : (
      <X size={12} className="text-[var(--color-danger)]" />
    )

  const parsedResult = result != null ? parseResult(result) : null
  const contentRef = useRef<HTMLDivElement>(null)

  return (
    <div className={`rounded-lg border overflow-hidden text-xs relative transition-colors ${expanded ? 'border-[var(--color-border)] bg-[var(--color-bg-secondary)]' : 'border-transparent hover:border-[var(--color-border)] hover:bg-[var(--color-bg-secondary)]'}`}>
      {/* Progress bar for pending state */}
      {isPending && (
        <div className="absolute top-0 left-0 right-0 h-[2px] overflow-hidden">
          <div className="h-full w-1/3 bg-[var(--color-accent)] rounded-full animate-[shimmer_1.2s_ease-in-out_infinite]" />
        </div>
      )}

      <button
        onClick={() => setExpanded(!expanded)}
        className="w-full flex items-center gap-1.5 px-2.5 py-1.5 hover:bg-[var(--color-bg-hover)] transition-colors"
      >
        <ChevronRight
          size={12}
          className={`text-[var(--color-text-muted)] transition-transform duration-150 ${expanded ? 'rotate-90' : ''}`}
        />
        {provider ? (
          <>
            <span className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded bg-[var(--color-accent)]/15 text-[11px] font-semibold text-[var(--color-accent)]">
              <Plug size={10} />
              {provider}
            </span>
            <span className="font-mono text-[var(--color-text-muted)]">{name}</span>
          </>
        ) : (
          <>
            <Wrench size={11} className="text-[var(--color-text-muted)]" />
            <span className="font-mono text-[var(--color-accent)]">{name}</span>
          </>
        )}
        {statusIcon}
      </button>

      <div
        className="grid transition-[grid-template-rows] duration-150 ease-out"
        style={{ gridTemplateRows: expanded ? '1fr' : '0fr' }}
      >
        <div className="overflow-hidden">
          <div ref={contentRef} className="border-t border-[var(--color-border)] px-2.5 py-2 space-y-2">
            <div>
              <p className="text-[10px] font-medium text-[var(--color-text-muted)] uppercase tracking-wide mb-1">Input</p>
              <div className="text-[11px] bg-[var(--color-bg)] p-2 rounded font-mono">
                <JsonView data={input} />
              </div>
            </div>
            {parsedResult && !error && (
              <div>
                <p className="text-[10px] font-medium text-[var(--color-text-muted)] uppercase tracking-wide mb-1">Result</p>
                {parsedResult.type === 'object' ? (
                  <div className="text-[11px] bg-[var(--color-bg)] p-2 rounded font-mono max-h-64 overflow-y-auto">
                    <JsonView data={parsedResult.value} />
                  </div>
                ) : (
                  <pre className="text-[11px] bg-[var(--color-bg)] p-2 rounded font-mono whitespace-pre-wrap break-words overflow-x-auto max-h-64 overflow-y-auto">
                    {parsedResult.value}
                  </pre>
                )}
              </div>
            )}
            {error && (
              <div>
                <p className="text-[10px] font-medium text-[var(--color-danger)] uppercase tracking-wide mb-1">Error</p>
                <pre className="text-[11px] bg-[var(--color-bg)] p-2 rounded font-mono whitespace-pre-wrap break-words text-[var(--color-danger)]">
                  {error}
                </pre>
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  )
}
