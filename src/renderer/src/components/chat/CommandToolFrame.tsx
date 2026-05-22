import { useState } from 'react'
import { Terminal, ChevronRight } from 'lucide-react'

interface CommandToolFrameProps {
  /**
   * Verbatim slash invocation from `cinna.command_invocation` — drives the
   * "Command: <invocation>" header.
   */
  commandInvocation: string
  /**
   * Inner blocks (typically a `ToolNarrationBlock` + `ToolResultBlock` pair
   * already paired by `cinna.tool_id`). Rendered as the expandable body.
   */
  children: React.ReactNode
  isStreaming?: boolean
  /**
   * Outer frame default-collapsed: the bash plumbing is incidental — the
   * user already knows what command they invoked. Caller can override per
   * surface (e.g. verbose mode).
   */
  defaultExpanded?: boolean
  animate?: boolean
  animateDelay?: number
}

/**
 * Outer wrapper for a `/run:*` tool/tool_result pair carrying
 * `cinna.command_invocation`. Logical grouping only — no border or fill of
 * its own so the inner `ToolNarrationBlock` / `ToolResultBlock` cards aren't
 * double-framed inside a page-wide outer box. Mirrors the `ToolNarrationBlock`
 * disclosure pattern: chevron + header sit transparent, children appear
 * below when expanded.
 */
export function CommandToolFrame({
  commandInvocation,
  children,
  isStreaming,
  defaultExpanded,
  animate,
  animateDelay
}: CommandToolFrameProps): React.JSX.Element {
  const [expanded, setExpanded] = useState(defaultExpanded ?? !!isStreaming)

  return (
    <div
      className={animate ? 'anim-assistant-bubble' : undefined}
      style={animate && animateDelay ? { animationDelay: `${animateDelay}ms` } : undefined}
    >
      <button
        onClick={() => setExpanded(!expanded)}
        className="w-full flex items-center gap-1.5 px-2.5 py-1.5 text-[11px]
          text-[var(--color-text-muted)] hover:text-[var(--color-text-secondary)]
          transition-colors min-w-0 text-left"
      >
        <ChevronRight
          size={11}
          className={`shrink-0 transition-transform duration-150 ${expanded ? 'rotate-90' : ''}`}
        />
        <Terminal size={11} className="shrink-0" />
        <span className="flex-1 min-w-0 truncate">
          <span className="font-medium">Command: </span>
          <span className="font-mono">{commandInvocation}</span>
        </span>
        {isStreaming && (
          <span className="ml-1 inline-block w-1 h-1 rounded-full bg-[var(--color-accent)] animate-pulse shrink-0" />
        )}
      </button>
      {expanded && <div className="space-y-2">{children}</div>}
    </div>
  )
}
