import { useEffect, useId, useLayoutEffect, useRef, useState } from 'react'
import { Radio, SquareTerminal, Users, Waypoints, Workflow } from 'lucide-react'
import type { AgentData } from '../../../../preload'
import { AgentConnectionDetails, agentLocation } from './AgentConnectionDetails'
import {
  SessionTelemetryBlock,
  popoverMaxHeight,
  useSessionTelemetryBlock,
  type SessionTelemetryBlockModel
} from './SessionTelemetryBlock'
import type { ChatRouter } from '../../../../shared/chatRouting'
import {
  AI_SPENDING_LEVEL_LABEL,
  contextHealth,
  type AiSpendingLevel,
  type ContextHealth
} from '../../../../shared/aiSpendingLevel'
import { useAppSettings } from '../../hooks/useAppSettings'
import { useToastStore } from '../../stores/toast.store'
import { useUIStore } from '../../stores/ui.store'
import { formatTokens } from '../../utils/telemetryFormat'

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
  /**
   * The chat whose session the popover also describes (context fill, spend,
   * cache, prices), once it has telemetry. Absent outside a chat.
   */
  chatId?: string
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

/**
 * Direct chats describe the agent's location; multi-agent chats explain
 * routing. In a chat, the popover also carries the session's telemetry.
 */
export function RouterBadge({ chatId, ...info }: RouterBadgeInfo): React.JSX.Element {
  // Only a chat reads telemetry: the job pages' badge has no session to show.
  return chatId ? <ChatRouterBadge chatId={chatId} {...info} /> : <RouterBadgeView {...info} telemetry={null} />
}

function ChatRouterBadge({ chatId, ...info }: RouterBadgeInfo & { chatId: string }): React.JSX.Element {
  const telemetry = useSessionTelemetryBlock(chatId)
  const level = useAppSettings().data?.aiSpendingLevel ?? 'mid'
  const health = telemetry ? contextHealth(level, telemetry.telemetry.context) : null
  // A reading the badge did not hear live — the cached one on coming back to a
  // chat, and the refetch that replaces it — is not a crossing: its rise
  // happened while nobody was listening. Only pushes after the fetch settles count.
  useBudgetCrossingToast(chatId, level, telemetry && !telemetry.fetching ? health : null)
  return <RouterBadgeView {...info} telemetry={telemetry} budgetLine={health ? { key: chatId, fill: health.fill } : null} />
}

/**
 * Tells the user, once, when the context in the chat on screen crosses their
 * spending level's budget — a reading below it followed by one at or above it,
 * both in this chat at this level. Anything else only records the reading: the
 * first one for a chat (opening it, or switching back to one already over),
 * a changed level, and a reading with no budget (size unconfirmed), which
 * also forgets the last one, since "below" was a guess from then on. A reading
 * back under the budget (compaction, a new session) re-arms it.
 */
function useBudgetCrossingToast(chatId: string, level: AiSpendingLevel, health: ContextHealth | null): void {
  const last = useRef<{ chatId: string; level: AiSpendingLevel; over: boolean | null } | null>(null)
  const over = health ? health.over : null
  const budget = health?.budget
  useEffect(() => {
    const previous = last.current
    last.current = { chatId, level, over }
    if (!previous || previous.chatId !== chatId || previous.level !== level) return
    if (previous.over === false && over === true && budget !== undefined) {
      useToastStore.getState().show(
        `Context in this chat reached your ${AI_SPENDING_LEVEL_LABEL[level]} budget (${formatTokens(budget)}). Consider starting a new chat or compacting the conversation to avoid excessive token spending.`,
        { link: { label: 'Settings → Features', settingsMenu: 'features' } }
      )
    }
  }, [chatId, level, over, budget])
}

/**
 * The line's colour along its fill: green to half, amber by 80%, red at the
 * budget — mixed continuously, from theme colours only.
 */
export function budgetLineColor(fill: number): string {
  if (fill <= 0.5) return 'var(--color-success)'
  if (fill <= 0.8) {
    const towardWarning = Math.round(((fill - 0.5) / 0.3) * 100)
    return `color-mix(in oklab, var(--color-success), var(--color-warning) ${towardWarning}%)`
  }
  const towardDanger = Math.round((Math.min(1, fill) - 0.8) / 0.2 * 100)
  return `color-mix(in oklab, var(--color-warning), var(--color-danger) ${towardDanger}%)`
}

function RouterBadgeView({
  router,
  connectionAgent,
  agentName,
  answererName,
  modelName,
  conductorName,
  telemetry,
  budgetLine = null
}: Omit<RouterBadgeInfo, 'chatId'> & {
  telemetry: SessionTelemetryBlockModel | null
  /** The context health line; `key` is the chat, so a chat switch shows its value without replaying the width. */
  budgetLine?: { key: string; fill: number } | null
}): React.JSX.Element {
  const animate = useUIStore((s) => s.extraUIAnimation)
  const [hovered, setHovered] = useState(false)
  const [focused, setFocused] = useState(false)
  const [dismissed, setDismissed] = useState(false)
  const tooltipId = useId()
  const open = (hovered || focused) && !dismissed
  const hasTelemetry = telemetry !== null
  // The pill's top edge, measured while the popover with telemetry is open:
  // the popover grows up from it and must stop short of the window's top.
  const anchorRef = useRef<HTMLDivElement>(null)
  const [anchorTop, setAnchorTop] = useState<number | undefined>(undefined)
  useLayoutEffect(() => {
    if (open && hasTelemetry) setAnchorTop(anchorRef.current?.getBoundingClientRect().top)
  }, [open, hasTelemetry])
  useEffect(() => {
    if (!open || !hasTelemetry) return
    const measure = (): void => setAnchorTop(anchorRef.current?.getBoundingClientRect().top)
    window.addEventListener('resize', measure)
    return () => window.removeEventListener('resize', measure)
  }, [open, hasTelemetry])
  const location = router === 'direct' && connectionAgent ? agentLocation(connectionAgent) : null
  const face = location ? { ...FACE.direct, label: location, icon: location === 'Local' ? SquareTerminal : Waypoints } : router === 'coordinator' && conductorName ? { ...FACE.coordinator, label: `${conductorName} routes` } : FACE[router]
  const Icon = face.icon
  const who = agentName ? `“${agentName}”` : 'the agent'
  const next = answererName ? `“${answererName}”` : 'the agent you last wrote to'
  const model = conductorName ?? modelName ?? 'your local model'

  return (
    <div
      ref={anchorRef}
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
        className={`relative overflow-hidden flex items-center gap-1 px-1.5 py-1 rounded-lg border
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
        {budgetLine && (
          <span
            key={budgetLine.key}
            aria-hidden="true"
            data-testid="context-budget-line"
            className={`pointer-events-none absolute bottom-0 left-0 h-[2px] ${animate ? 'transition-[width,background-color] duration-500 ease-out motion-reduce:transition-none' : ''}`}
            style={{ width: `${budgetLine.fill * 100}%`, backgroundColor: budgetLineColor(budgetLine.fill) }}
          />
        )}
      </div>

      {open && (
        <div
          id={tooltipId}
          // A dialog whenever it holds a control: the telemetry row is the only one.
          role={hasTelemetry ? 'dialog' : 'tooltip'}
          aria-label="Chat routing"
          style={hasTelemetry ? { maxHeight: popoverMaxHeight(anchorTop) } : undefined}
          className={`absolute bottom-full right-0 z-50 ${hasTelemetry ? 'w-80 flex flex-col' : 'w-72'} rounded-lg border
            border-[var(--color-border)] bg-[var(--color-overlay-panel)] backdrop-blur-xl
            shadow-xl px-3 py-2.5 text-[11px] leading-relaxed text-[var(--color-text-secondary)]`}
        >
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
          {/* Last, under the routing: its row stays put as the details open above
              it. The routing above keeps its height (a flex item's `min-height:
              auto`); under the cap only the details shrink, and scroll. */}
          {telemetry && <SessionTelemetryBlock model={telemetry} />}
        </div>
      )}
    </div>
  )
}
