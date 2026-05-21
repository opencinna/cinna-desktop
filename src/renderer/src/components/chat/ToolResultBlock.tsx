import { useState } from 'react'
import { Terminal, ChevronRight, AlertTriangle } from 'lucide-react'
import type { ToolStream } from '../../../../shared/messageParts'

interface ToolResultBlockProps {
  content: string
  toolStream?: ToolStream
  isStreaming?: boolean
  defaultExpanded?: boolean
  animate?: boolean
  animateDelay?: number
}

export function ToolResultBlock({
  content,
  toolStream,
  isStreaming,
  defaultExpanded,
  animate,
  animateDelay
}: ToolResultBlockProps): React.JSX.Element {
  const [expanded, setExpanded] = useState(defaultExpanded ?? !!isStreaming)
  const isErr = toolStream === 'stderr'

  return (
    <div
      className={`rounded-lg border transition-colors duration-200 ${
        expanded
          ? isErr
            ? 'border-[var(--color-danger)]/40 bg-[var(--color-danger)]/8'
            : 'border-[var(--color-border)]/60 bg-[var(--color-bg-secondary)]/40'
          : 'border-transparent bg-transparent'
      } ${animate ? 'anim-assistant-bubble' : ''}`}
      style={animate && animateDelay ? { animationDelay: `${animateDelay}ms` } : undefined}
    >
      <button
        onClick={() => setExpanded(!expanded)}
        className={`w-full flex items-center gap-1.5 px-2.5 py-1.5 text-[11px]
          ${isErr ? 'text-[var(--color-danger)]' : 'text-[var(--color-text-muted)]'}
          hover:text-[var(--color-text-secondary)] transition-colors min-w-0 text-left`}
      >
        <ChevronRight
          size={11}
          className={`shrink-0 transition-transform duration-150 ${expanded ? 'rotate-90' : ''}`}
        />
        {isErr ? <AlertTriangle size={11} className="shrink-0" /> : <Terminal size={11} className="shrink-0" />}
        <span className="flex-1 min-w-0 truncate">
          <span className="font-medium">{isErr ? 'stderr' : 'Output'}</span>
        </span>
        {isStreaming && (
          <span className="ml-1 inline-block w-1 h-1 rounded-full bg-[var(--color-accent)] animate-pulse shrink-0" />
        )}
      </button>
      {expanded && content && (
        <pre
          className={`px-3 pb-2.5 pt-0 text-[12px] leading-relaxed font-mono whitespace-pre-wrap break-words max-h-96 overflow-y-auto ${
            isErr ? 'text-[var(--color-danger)]' : 'text-[var(--color-text-secondary)]'
          }`}
        >
          {content}
        </pre>
      )}
    </div>
  )
}
