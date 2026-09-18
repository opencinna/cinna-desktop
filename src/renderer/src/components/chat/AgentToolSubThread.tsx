import { useContext, useEffect, useState } from 'react'
import { Bot, ChevronRight, Loader2, X } from 'lucide-react'
import type { MessagePart } from '../../../../shared/messageParts'
import { presetForAgentId } from '../../utils/agentColors'
import { AgentContribution, AskLine } from './AgentContribution'
import { isPermissionRequestTool } from '../../../../shared/localAgentRequests'
import { isAskUserQuestionTool } from '../../utils/askUserQuestion'
import { unwrapIpcError } from '../../utils/ipcError'
import { TranscriptVisibleContext, useTranscriptDisclosure } from './transcriptExpansion'

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
  renderRequest?: (part: MessagePart, decision?: string) => React.JSX.Element | null
  /**
   * An ask inside is waiting on the user: the thread is open, and stays open
   * even if the user collapsed it, until the ask is settled — otherwise the
   * only way to answer it would be hidden.
   */
  holdOpen?: boolean
  /** Passed to {@link AgentContribution}: a nested group drawn in place of a part. */
  renderNested?: (index: number) => React.JSX.Element | null
  onStop?: () => Promise<unknown>
}

/**
 * What the header counts as a step: calls and what the agent said or thought —
 * not a call's output, and not a permission or question ask (by their reserved
 * names) or its decision, which are the user's part of the thread.
 */
function countSteps(parts: MessagePart[]): number {
  return parts.filter(
    (part) =>
      (part.kind === 'tool' && !isPermissionRequestTool(part.toolName) && !isAskUserQuestionTool(part.toolName)) ||
      part.kind === 'text' ||
      part.kind === 'thinking'
  ).length
}

/**
 * Expandable wrapper that renders an agent-backed tool call (orchestrated
 * mode) as a nested sub-thread: a collapsed header (`{agent} · {n} steps ·
 * {status}`) over an inset, hash-colored {@link AgentContribution}. Auto-
 * expands while the agent is streaming and collapses on completion (respecting
 * verbose mode), so the user watches the active agent work and can drill into
 * a finished one on demand. A failed one never collapses and says "error" in
 * the header in compact mode too; a pending ask inside holds it open.
 */
export function AgentToolSubThread({
  agentName,
  agentId,
  parts,
  askMessage,
  status,
  isStreaming,
  errorText,
  verbose,
  renderRequest,
  holdOpen,
  renderNested,
  onStop
}: AgentToolSubThreadProps): React.JSX.Element {
  // A failed thread opens and stays open, in every mode: its error is inside,
  // and a failure folded away reads as a success (UX rule 6).
  const [userExpanded, setExpanded, setAutoExpanded] = useTranscriptDisclosure(
    !!isStreaming || !!verbose || status === 'error'
  )
  const expanded = userExpanded || !!holdOpen
  // The body stays mounted while closed, so blocks inside must know it is hidden.
  const visible = useContext(TranscriptVisibleContext)

  // Live → persisted transition: collapse once the agent sub-turn finishes
  // (unless verbose mode keeps everything open). Auto-open again if it goes
  // live (e.g. a re-invocation reusing the block). These go through the auto
  // setter, which moves the default with the state, so the transcript's
  // "Collapse expanded" never counts an opening the user did not make.
  const [wasStreaming, setWasStreaming] = useState<boolean>(!!isStreaming)
  const [stopping, setStopping] = useState(false)
  const [stopError, setStopError] = useState<string | null>(null)
  useEffect(() => {
    if (isStreaming && !wasStreaming) {
      setAutoExpanded(true)
      setWasStreaming(true)
    } else if (!isStreaming && wasStreaming) {
      setAutoExpanded(!!verbose || status === 'error')
      setWasStreaming(false)
    }
  }, [isStreaming, wasStreaming, verbose, status, setAutoExpanded])

  // Color by stable agent id when known so a given agent shows the same color
  // whether the model called it (here) or the user addressed it directly
  // (switchboard); fall back to the display name for legacy rows.
  const color = presetForAgentId(agentId ?? agentName)
  const steps = countSteps(parts)
  const statusLabel =
    status === 'pending' ? 'running' : status === 'error' ? 'error' : 'done'

  return (
    <div className="text-xs">
      {/* Badge line — sits above the content block, not inside a border box.
          One row with Stop and its error, so neither adds or removes a line
          of transcript when the specialist starts, fails to stop, or ends. */}
      <div className="flex items-center min-w-0">
      <button
        type="button"
        aria-expanded={expanded}
        // Held open by an ask: a click here would be stored and snap the thread
        // shut the moment the ask is answered (UX rule 1), so it does nothing.
        aria-disabled={holdOpen || undefined}
        title={holdOpen ? 'Answer the request first' : undefined}
        onClick={() => {
          if (!holdOpen) setExpanded((v) => !v)
        }}
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
        {/* Compact mode shows no status, except a failure: it must not read as done. */}
        {!verbose && status === 'error' && (
          <span className="inline-flex items-center gap-0.5 text-[11px] text-[var(--color-danger)] whitespace-nowrap shrink-0">
            <X size={11} />
            {statusLabel}
          </span>
        )}
      </button>
      {isStreaming && onStop && (
        <button type="button" disabled={stopping} aria-label={`Stop ${agentName}`}
          className="ml-1.5 shrink-0 px-2 py-0.5 rounded border border-[var(--color-border)] text-[11px] text-[var(--color-text-secondary)] hover:bg-[var(--color-bg-hover)] disabled:opacity-50"
          onClick={() => {
            setStopping(true)
            setStopError(null)
            void onStop().catch((error: unknown) => {
              setStopping(false)
              setStopError(unwrapIpcError(error, 'Could not stop this agent.'))
            })
          }}>
          {stopping ? 'Stopping…' : 'Stop'}
        </button>
      )}
      {stopError && <span role="alert" title={stopError} className="ml-1.5 min-w-0 truncate text-[11px] text-[var(--color-danger)]">{stopError}</span>}
      </div>

      <div
        className="grid transition-[grid-template-rows] duration-150 ease-out"
        style={{ gridTemplateRows: expanded ? '1fr' : '0fr' }}
      >
        <div className="overflow-hidden">
          <TranscriptVisibleContext.Provider value={visible && expanded}>
          <div
            className="mt-1 rounded-lg border border-[var(--color-border)] bg-[var(--color-bg-secondary)] px-2.5 py-2 pl-3"
            style={{ borderLeft: `2px solid ${color.border}` }}
          >
            {parts.length === 0 && status === 'pending' ? (
              // The prompt on the same ↳ line `AgentContribution` draws it on,
              // so it stays put when the first part arrives and takes the
              // "Working…" line's place below it.
              <div className="space-y-2">
                {askMessage && <AskLine text={askMessage} />}
                <div className="text-[11px] text-[var(--color-text-muted)] italic">Working…</div>
              </div>
            ) : (
              <AgentContribution
                parts={parts}
                agentId={agentId ?? agentName}
                askMessage={askMessage}
                isStreaming={isStreaming}
                verbose={verbose}
                renderRequest={renderRequest}
                renderNested={renderNested}
              />
            )}
            {errorText && (
              <pre className="mt-2 text-[11px] bg-[var(--color-bg)] p-2 rounded font-mono whitespace-pre-wrap break-words text-[var(--color-danger)]">
                {errorText}
              </pre>
            )}
          </div>
          </TranscriptVisibleContext.Provider>
        </div>
      </div>
    </div>
  )
}
