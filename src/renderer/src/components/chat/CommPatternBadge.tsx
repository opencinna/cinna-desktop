import { useState } from 'react'
import { Radio, Workflow } from 'lucide-react'
import type { CommPattern } from '../../utils/commPattern'

interface CommPatternBadgeProps {
  pattern: CommPattern
  /** Agent name for the A2A tooltip ("…goes straight to {agent}…"). */
  agentName?: string
  /** Chat-mode model name for the AI tooltip ("{model} runs the conversation"). */
  modelName?: string
}

/**
 * New-chat composer indicator showing whether the current selection routes as
 * a **direct A2A** connection (one agent, no MCPs) or is **orchestrated** by
 * the local model (anything else). Sits immediately left of the chat-mode Cog.
 * Two visually distinct tones; colors via `var(--color-*)` only.
 */
export function CommPatternBadge({
  pattern,
  agentName,
  modelName
}: CommPatternBadgeProps): React.JSX.Element {
  const [hovered, setHovered] = useState(false)

  const isA2A = pattern === 'A2A'
  const tone = isA2A
    ? 'text-[var(--color-accent)] border-[var(--color-accent)]/40 bg-[var(--color-accent)]/10'
    : 'text-[var(--color-warning)] border-[var(--color-warning)]/40 bg-[var(--color-warning)]/10'
  const Icon = isA2A ? Radio : Workflow
  const who = agentName ? `“${agentName}”` : 'the agent'
  const model = modelName ?? 'your local model'

  return (
    <div
      className="relative"
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
    >
      <div
        className={`flex items-center gap-1 px-1.5 py-1 rounded-lg border ${tone}`}
        role="status"
        aria-label={isA2A ? 'Direct A2A connection' : 'Orchestrated by local model'}
      >
        <Icon size={12} className="shrink-0" />
        <span className="text-[11px] font-semibold tracking-wide">{pattern}</span>
      </div>

      {hovered && (
        <div
          className="absolute bottom-full mb-1.5 right-0 z-50 w-72 rounded-lg border
            border-[var(--color-border)] bg-[var(--color-overlay-panel)] backdrop-blur-xl
            shadow-xl px-3 py-2.5 text-[11px] leading-relaxed text-[var(--color-text-secondary)]"
        >
          {isA2A ? (
            <>
              <p className="text-[var(--color-text)] font-semibold mb-1">Direct agent connection</p>
              <p>
                Your message goes straight to <strong>{who}</strong> over the A2A protocol; it
                runs its own model and tools and streams the full response back.
              </p>
              <p className="mt-1.5">
                <strong>How to use:</strong> just type — your conversation happens directly with
                the agent, no need to mention it separately.
              </p>
              <p className="mt-1.5">
                <strong>Cost:</strong> only the agent&apos;s own usage — no extra local model
                calls.
              </p>
            </>
          ) : (
            <>
              <p className="text-[var(--color-text)] font-semibold mb-1">
                Orchestrated by your local model
              </p>
              <p>
                <strong>{model}</strong> runs the conversation and calls the selected agents and
                MCP tools as needed.
              </p>
              <p className="mt-1.5">
                <strong>How to use:</strong> mention each tool or agent by name to invoke it — the
                model calls the ones you reference.
              </p>
              <p className="mt-1.5">
                <strong>Cost &amp; trade-offs:</strong> you pay local-model tokens every turn{' '}
                <em>plus</em> each agent invocation, tool schemas add to context, latency is
                higher, and an agent&apos;s live thinking/tool stream is summarized into a single
                tool result rather than shown verbatim.
              </p>
            </>
          )}
        </div>
      )}
    </div>
  )
}
