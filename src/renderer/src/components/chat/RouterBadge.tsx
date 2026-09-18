import { useId, useState } from 'react'
import { Radio, SquareTerminal, Users, Waypoints, Workflow } from 'lucide-react'
import type { AgentData } from '../../../../preload'
import { AgentConnectionDetails, agentLocation } from './AgentConnectionDetails'
import type { ChatRouter } from '../../../../shared/chatRouting'

type DisplayRouter = ChatRouter | 'script'

export interface RouterBadgeInfo {
  router: DisplayRouter
  connectionAgent?: AgentData | null
  /** The chat's single counterparty, for `direct`. */
  agentName?: string
  /** Who answers the next message, for `human`. */
  answererName?: string
  /** The model that would conduct, for `coordinator`. */
  modelName?: string
  conductorName?: string
  conductorId?: string | null
  coordinateAction?: { conductorName: string; pending?: boolean; onCoordinate(): void }
}

/** Icon, short label and tone per router. The label is what the pill shows. */
const FACE: Record<DisplayRouter, { label: string; icon: typeof Radio; tone: string }> = {
  script: {
    label: 'Script routes',
    icon: Workflow,
    tone: 'text-[var(--color-accent)] border-[var(--color-accent)]/40 bg-[var(--color-accent)]/10'
  },
  direct: {
    label: 'Direct',
    icon: Radio,
    tone: 'text-[var(--color-accent)] border-[var(--color-accent)]/40 bg-[var(--color-accent)]/10'
  },
  human: {
    label: 'You route',
    icon: Users,
    tone: 'text-[var(--color-success)] border-[var(--color-success)]/40 bg-[var(--color-success)]/10'
  },
  coordinator: {
    label: 'Model routes',
    icon: Workflow,
    tone: 'text-[var(--color-warning)] border-[var(--color-warning)]/40 bg-[var(--color-warning)]/10'
  }
}

const ARIA: Record<DisplayRouter, string> = {
  script: 'Routed by defined script steps',
  direct: 'Direct agent connection',
  human: 'You route this chat',
  coordinator: 'Coordinated by your local model'
}

/** Direct chats describe the agent's location; multi-agent chats explain routing. */
export function RouterBadge({
  router,
  connectionAgent,
  agentName,
  answererName,
  modelName,
  conductorName,
  coordinateAction
}: RouterBadgeInfo): React.JSX.Element {
  const [hovered, setHovered] = useState(false)
  const [focused, setFocused] = useState(false)
  const [dismissed, setDismissed] = useState(false)
  const tooltipId = useId()
  const open = (hovered || focused) && !dismissed
  const location = router === 'direct' && connectionAgent ? agentLocation(connectionAgent) : null
  const face = location ? { ...FACE.direct, label: location, icon: location === 'Local' ? SquareTerminal : Waypoints } : router === 'coordinator' && conductorName ? { ...FACE.coordinator, label: `${conductorName} routes` } : FACE[router]
  const Icon = face.icon
  const who = agentName ? `“${agentName}”` : 'the agent'
  const next = answererName ? `“${answererName}”` : 'the agent you last wrote to'
  const model = conductorName ?? modelName ?? 'your local model'

  return (
    <div
      className="relative"
      onMouseEnter={() => { setHovered(true); setDismissed(false) }}
      onMouseLeave={() => setHovered(false)}
      // The tooltip is the only place the three routers are explained, and a
      // hover is not a gesture a keyboard has. Focus opens it too — on the
      // wrapper, so the badge stays one stop rather than two.
      onFocus={() => { setFocused(true); setDismissed(false) }}
      onBlur={(event) => { if (!event.currentTarget.contains(event.relatedTarget)) setFocused(false) }}
      onKeyDown={(event) => { if (event.key === 'Escape') setDismissed(true) }}
    >
      <div
        className={`flex items-center gap-1 px-1.5 py-1 rounded-lg border
          focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--color-accent)] ${face.tone}`}
        role="status"
        tabIndex={0}
        aria-label={location ? `${location} agent connection` : router === 'coordinator' && conductorName ? `Coordinated by ${conductorName}` : ARIA[router]}
        aria-describedby={open ? tooltipId : undefined}
      >
        <Icon size={12} className="shrink-0" />
        <span className="text-[11px] font-semibold tracking-wide whitespace-nowrap max-w-[10rem] truncate" title={face.label}>
          {face.label}
        </span>
      </div>

      {open && (
        <div
          id={tooltipId}
          role={coordinateAction || router === 'coordinator' || router === 'human' ? "dialog" : "tooltip"}
          aria-label="Chat routing"
          className={`absolute bottom-full right-0 z-50 w-72 rounded-lg border
            border-[var(--color-border)] bg-[var(--color-overlay-panel)] backdrop-blur-xl
            shadow-xl px-3 py-2.5 text-[11px] leading-relaxed text-[var(--color-text-secondary)]`}
        >
          {coordinateAction && router !== 'coordinator' && (
            <button type="button" aria-disabled={coordinateAction.pending || undefined}
              onClick={() => { if (!coordinateAction.pending) coordinateAction.onCoordinate() }}
              className="mb-2 w-full rounded-md border border-[var(--color-border)] px-2 py-1.5 text-left font-medium text-[var(--color-accent)] hover:bg-[var(--color-bg-hover)]">
              Coordinate by {coordinateAction.conductorName}
            </button>
          )}
          {router === 'script'  && (
            <>
              <p className="text-[var(--color-text)] font-semibold mb-1">Script routes this job</p>
              <p>Agents follow the saved steps. Independent steps can run together; questions wait in the Inbox.</p>
              <p className="mt-1.5">Only the agents use models. The script itself makes no model calls.</p>
            </>
          )}
          {router === 'direct' && connectionAgent && <AgentConnectionDetails agent={connectionAgent} />}
          {router === 'direct' && !connectionAgent && (
            <>
              <p className="text-[var(--color-text)] font-semibold mb-1">Direct agent connection</p>
              <p>
                Your message goes straight to <strong>{who}</strong>; it runs its own model and
                tools and streams the full response back.
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
          )}
          {router === 'human' && (
            <>
              <p className="text-[var(--color-text)] font-semibold mb-1">You route this chat</p>
              <p>
                Each message goes to one agent. The next one goes to <strong>{next}</strong>.
              </p>
              <p className="mt-1.5">
                <strong>How to use:</strong> pick an agent from the chips or with{' '}
                <strong>@</strong> to address it; whatever the others said since its last turn
                travels with your message, so it can pick the thread up.
              </p>
              <p className="mt-1.5">
                <strong>Cost:</strong> only the agents&apos; own usage. No local model is involved
                at all — this works with no AI provider configured.
              </p>
            </>
          )}
          {router === 'coordinator' && (
            <>
              <p className="text-[var(--color-text)] font-semibold mb-1">
                Coordinated by {model}
              </p>
              <p>
                <strong>{model}</strong> runs the conversation and calls the selected agents and
                MCP tools as needed.
              </p>
              <p className="mt-1.5">Write to the coordinator. It can ask participants and use the connected tools; their work appears in sub-threads.</p>
            </>
          )}
        </div>
      )}
    </div>
  )
}
