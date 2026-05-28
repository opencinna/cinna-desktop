import { useEffect, useState } from 'react'
import { Bot, ChevronRight, Loader2, X } from 'lucide-react'
import type { MessagePart } from '../../../../shared/messageParts'
import { presetForAgentId } from '../../utils/agentColors'
import { AgentContribution } from './AgentContribution'

interface AgentToolSubThreadProps {
  agentName: string
  /** Agent id — drives the per-agent hash color. Falls back to name when absent. */
  agentId?: string | null
  parts: MessagePart[]
  /** Orchestrator-authored task message — surfaced as the sub-thread's first line. */
  askMessage?: string
  status: 'pending' | 'done' | 'error'
  /** Live: the agent sub-turn is still streaming under the orchestrator. */
  isStreaming?: boolean
  errorText?: string
  verbose?: boolean
}

/**
 * Expandable wrapper that renders an agent-backed tool call (orchestrated
 * mode) as a nested sub-thread: a collapsed header (`{agent} · {n} steps ·
 * {status}`) over an inset, hash-colored {@link AgentContribution}. Auto-
 * expands while the agent is streaming and collapses on completion (respecting
 * verbose mode), so the user watches the active agent work and can drill into
 * a finished one on demand.
 */
export function AgentToolSubThread({
  agentName,
  agentId,
  parts,
  askMessage,
  status,
  isStreaming,
  errorText,
  verbose
}: AgentToolSubThreadProps): React.JSX.Element {
  const [expanded, setExpanded] = useState<boolean>(!!isStreaming || !!verbose)

  // Live → persisted transition: collapse once the agent sub-turn finishes
  // (unless verbose mode keeps everything open). Auto-open again if it goes
  // live (e.g. a re-invocation reusing the block).
  const [wasStreaming, setWasStreaming] = useState<boolean>(!!isStreaming)
  useEffect(() => {
    if (isStreaming && !wasStreaming) {
      setExpanded(true)
      setWasStreaming(true)
    } else if (!isStreaming && wasStreaming) {
      setExpanded(verbose ? true : false)
      setWasStreaming(false)
    }
  }, [isStreaming, wasStreaming, verbose])

  // Color by stable agent id when known so a given agent shows the same color
  // whether the model called it (here) or the user addressed it directly
  // (switchboard); fall back to the display name for legacy rows.
  const color = presetForAgentId(agentId ?? agentName)
  const steps = parts.length
  const statusLabel =
    status === 'pending' ? 'running' : status === 'error' ? 'error' : 'done'

  return (
    <div className="text-xs">
      {/* Badge line — sits above the content block, not inside a border box. */}
      <button
        onClick={() => setExpanded((v) => !v)}
        className="flex items-center gap-1.5 px-1.5 py-1 rounded-md hover:bg-gradient-to-r hover:from-[var(--color-bg-hover)] hover:to-transparent transition-colors min-w-0 text-left"
      >
        <ChevronRight
          size={12}
          className={`text-[var(--color-text-muted)] shrink-0 transition-transform duration-150 ${expanded ? 'rotate-90' : ''}`}
        />
        <span
          className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded text-[11px] font-semibold shrink-0"
          style={{ color: color.border, backgroundColor: color.bg }}
        >
          <Bot size={10} className="shrink-0" />
          {agentName}
        </span>
        {/* Step count + status are verbose-only detail. */}
        {verbose && (
          <>
            <span className="text-[var(--color-text-muted)] shrink-0">·</span>
            <span className="text-[var(--color-text-muted)] whitespace-nowrap">
              {steps} {steps === 1 ? 'step' : 'steps'}
            </span>
            <span className="text-[var(--color-text-muted)] shrink-0">·</span>
            {status === 'pending' ? (
              <span className="inline-flex items-center gap-1 text-[var(--color-warning)] whitespace-nowrap">
                <Loader2 size={11} className="animate-spin" />
                {statusLabel}
              </span>
            ) : status === 'error' ? (
              <span className="inline-flex items-center gap-1 text-[var(--color-danger)] whitespace-nowrap">
                <X size={11} />
                {statusLabel}
              </span>
            ) : (
              <span className="text-[var(--color-success)] whitespace-nowrap">{statusLabel}</span>
            )}
          </>
        )}
      </button>

      <div
        className="grid transition-[grid-template-rows] duration-150 ease-out"
        style={{ gridTemplateRows: expanded ? '1fr' : '0fr' }}
      >
        <div className="overflow-hidden">
          <div
            className="mt-1 rounded-lg border border-[var(--color-border)] bg-[var(--color-bg-secondary)] px-2.5 py-2 pl-3"
            style={{ borderLeft: `2px solid ${color.border}` }}
          >
            {parts.length === 0 && status === 'pending' ? (
              <div className="text-[11px] text-[var(--color-text-muted)] italic">
                {askMessage ? `Working on: ${askMessage}` : 'Working…'}
              </div>
            ) : (
              <AgentContribution
                parts={parts}
                agentId={agentId ?? agentName}
                askMessage={askMessage}
                isStreaming={isStreaming}
              />
            )}
            {errorText && (
              <pre className="mt-2 text-[11px] bg-[var(--color-bg)] p-2 rounded font-mono whitespace-pre-wrap break-words text-[var(--color-danger)]">
                {errorText}
              </pre>
            )}
          </div>
        </div>
      </div>
    </div>
  )
}
