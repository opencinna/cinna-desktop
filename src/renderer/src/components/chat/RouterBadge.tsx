import { useState } from 'react'
import { Radio, Users, Workflow } from 'lucide-react'
import type { ChatRouter } from '../../../../shared/chatRouting'

export interface RouterBadgeInfo {
  router: ChatRouter
  /** The chat's single counterparty, for `direct`. */
  agentName?: string
  /** Who answers the next message, for `human`. */
  answererName?: string
  /** The model that would conduct, for `coordinator`. */
  modelName?: string
}

interface RouterBadgeProps extends RouterBadgeInfo {
  /**
   * Where the explainer tooltip opens. Default `'top'` (above the badge,
   * right-aligned) suits the composer, which sits at the bottom of the screen.
   * Use `'bottom-right'` (below the badge, extending right) where the default
   * would be clipped by surrounding chrome — e.g. the job detail footer, where
   * an above-left tooltip slides under the floating sidebar.
   */
  tooltipPlacement?: 'top' | 'bottom-right'
}

/** Icon, short label and tone per router. The label is what the pill shows. */
const FACE: Record<ChatRouter, { label: string; icon: typeof Radio; tone: string }> = {
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

const ARIA: Record<ChatRouter, string> = {
  direct: 'Direct agent connection',
  human: 'You route this chat',
  coordinator: 'Coordinated by your local model'
}

/**
 * Who answers the next message in this chat.
 *
 * Replaced `CommPatternBadge`, whose two values (`A2A` / `AI`) could not say
 * the difference between "several agents, and you route them" and "several
 * agents, and the model conducts" — it called both `AI`, and required a model
 * for both.
 *
 * **The pill's box does not change size when the router does.** The three
 * labels are different lengths and Send sits immediately right of it, so the
 * label reserves the width of the longest; a chat switching from `Direct` to
 * `You route` when a second agent arrives moves nothing beside it. Colors via
 * `var(--color-*)` only.
 *
 * `Model routes` rather than `Model`, because the composer's own model picker
 * sits in the same row under the word **Model** and means something else
 * entirely — which model the chat runs on, not who is answering. All three
 * labels are verb phrases about routing for the same reason.
 */
export function RouterBadge({
  router,
  agentName,
  answererName,
  modelName,
  tooltipPlacement = 'top'
}: RouterBadgeProps): React.JSX.Element {
  const [hovered, setHovered] = useState(false)

  const face = FACE[router]
  const Icon = face.icon
  const tooltipPos =
    tooltipPlacement === 'bottom-right' ? 'top-full mt-1.5 left-0' : 'bottom-full mb-1.5 right-0'
  const who = agentName ? `“${agentName}”` : 'the agent'
  const next = answererName ? `“${answererName}”` : 'the agent you last wrote to'
  const model = modelName ?? 'your local model'

  return (
    <div
      className="relative"
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
      // The tooltip is the only place the three routers are explained, and a
      // hover is not a gesture a keyboard has. Focus opens it too — on the
      // wrapper, so the badge stays one stop rather than two.
      onFocus={() => setHovered(true)}
      onBlur={() => setHovered(false)}
    >
      <div
        className={`flex items-center gap-1 px-1.5 py-1 rounded-lg border
          focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--color-accent)] ${face.tone}`}
        role="status"
        tabIndex={0}
        aria-label={ARIA[router]}
      >
        <Icon size={12} className="shrink-0" />
        {/* Wide enough for the longest of the three labels, so a router change
            moves neither this pill's edge nor Send beside it. */}
        <span className="text-[11px] font-semibold tracking-wide min-w-[5.5rem] text-center">
          {face.label}
        </span>
      </div>

      {hovered && (
        <div
          className={`absolute ${tooltipPos} z-50 w-72 rounded-lg border
            border-[var(--color-border)] bg-[var(--color-overlay-panel)] backdrop-blur-xl
            shadow-xl px-3 py-2.5 text-[11px] leading-relaxed text-[var(--color-text-secondary)]`}
        >
          {router === 'direct' && (
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
                Coordinated by your local model
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
