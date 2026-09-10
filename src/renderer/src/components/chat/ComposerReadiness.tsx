import { useEffect } from 'react'
import { Loader2 } from 'lucide-react'
import { useCheckAgentReadiness } from '../../hooks/useAgents'
import { useCinnaReauth } from '../../hooks/useAuth'
import { unwrapIpcError } from '../../utils/ipcError'
import { RUN_REFERENCE_PATTERN } from '../../../../shared/kit/manifest'
import type { AgentReadiness, AgentReadinessState } from '../../../../shared/agentDrivers'

type AgentData = Awaited<ReturnType<typeof window.api.agents.list>>[number]

export type ReadinessSeverity = 'warning' | 'danger'

/**
 * How loudly a readiness state is shown. Something the user fixes on this
 * machine or in their account — a credential, a login, an install — is a
 * warning; an agent that cannot be reached or whose folder does not validate is
 * an error.
 */
const SEVERITY: Record<Exclude<AgentReadinessState, 'ok'>, ReadinessSeverity> = {
  credentials_needed: 'warning',
  not_logged_in: 'warning',
  not_installed: 'warning',
  unreachable: 'danger',
  invalid: 'danger',
  contract_too_new: 'danger'
}

const TONE: Record<ReadinessSeverity, string> = {
  warning: 'text-[var(--color-warning)]',
  danger: 'text-[var(--color-danger)]'
}

/** Shown when a driver reported a state without a sentence of its own. */
const NOT_READY = 'This agent is not ready to take a message.'

export function readinessSeverity(readiness: AgentReadiness): ReadinessSeverity {
  return readiness.state === 'ok' ? 'warning' : SEVERITY[readiness.state]
}

/** The text colour class for a readiness answer that is not `ok`. */
export function readinessTone(readiness: AgentReadiness): string {
  return TONE[readinessSeverity(readiness)]
}

/**
 * The readiness a send to `agent` is refused on, or null when it is not.
 *
 * Only an answer the agent's driver actually gave refuses: `null` — never
 * checked, or a check that could not tell — lets the message through, so a
 * probe that has not happened can never stop a working agent.
 */
export function readinessRefusal(agent: AgentData | null | undefined): AgentReadiness | null {
  const readiness = agent?.readiness ?? null
  return readiness && readiness.state !== 'ok' ? readiness : null
}

/** The short sentence shown on screen. */
export function readinessText(readiness: AgentReadiness): string {
  return readiness.reason ?? NOT_READY
}

/** The full account, for a tooltip: the raw error when the driver kept one. */
export function readinessTitle(readiness: AgentReadiness): string {
  return readiness.detail || readinessText(readiness)
}

/**
 * A bare `/run:<name>` to an agent whose commands come from its folder catalog.
 *
 * It runs a script in the agent's folder on this machine, not a turn on the
 * agent's engine, so the agent's readiness does not decide whether it can go.
 * The grammar is `RUN_REFERENCE_PATTERN`, the one main's `matchRunCommand`
 * applies — a looser one here would enable Send for text main then hands to
 * the engine.
 */
export function isCatalogCommand(agent: AgentData | null | undefined, typed: string): boolean {
  return agent?.capabilities.commands === 'catalog' && RUN_REFERENCE_PATTERN.test(typed.trim())
}

/** The one thing the user can do about a refusal. */
export interface ReadinessAction {
  label: string
  pendingLabel: string
  pending: boolean
  run: () => void
}

export interface ComposerReadiness {
  /** The answer the send is refused on; null when nothing is refused. */
  refusal: AgentReadiness | null
  /** Whether Send and Enter are blocked — false for a catalog `/run:` even while refused. */
  blocksSend: boolean
  /** The line on screen, and what Send's `aria-describedby` reads. */
  text: string | null
  /** The tooltip on the line and on Send. */
  title: string | null
  action: ReadinessAction | null
}

/**
 * Everything the composer needs to refuse a send to an agent that is not
 * ready: whether to block, what to say, and what to offer.
 *
 * The line depends only on the agent's readiness and on the outcome of the
 * action — never on what is typed — so nothing appears or moves while the user
 * types. What is typed decides only `blocksSend`.
 */
export function useComposerReadiness(target: AgentData | null, typed: string): ComposerReadiness {
  const check = useCheckAgentReadiness()
  const reauth = useCinnaReauth()
  const refusal = readinessRefusal(target)
  const agentId = target?.id ?? null

  // An earlier failure belongs to the agent and the answer it was shown
  // against; a new target, or a new answer, starts clean.
  const resetCheck = check.reset
  const resetReauth = reauth.reset
  useEffect(() => {
    resetCheck()
    resetReauth()
  }, [agentId, refusal?.state, refusal?.reason, resetCheck, resetReauth])

  if (!target || !refusal) {
    return { refusal: null, blocksSend: false, text: null, title: null, action: null }
  }

  // An expired Cinna session is not fixed by asking again: it is fixed by
  // signing in again, the same flow the chat's error bubble offers.
  const reauthable = refusal.state === 'not_logged_in' && target.capabilities.auth === 'cinna'
  const failure = reauthable
    ? reauth.error
      ? unwrapIpcError(reauth.error, 'Re-authentication failed')
      : reauth.data && !reauth.data.success
        ? (reauth.data.error ?? 'Re-authentication failed')
        : null
    : check.error
      ? unwrapIpcError(check.error, 'the check could not run')
      : null
  const suffix = failure
    ? ` Couldn't ${reauthable ? 're-authenticate' : 'check again'} — ${failure}`
    : ''

  const action: ReadinessAction = reauthable
    ? {
        label: 'Re-authenticate',
        pendingLabel: 'Signing in…',
        pending: reauth.isPending,
        run: () => reauth.mutate()
      }
    : {
        label: 'Check again',
        pendingLabel: 'Checking…',
        pending: check.isPending,
        run: () => check.mutate(target.id)
      }

  return {
    refusal,
    blocksSend: !isCatalogCommand(target, typed),
    text: `${readinessText(refusal)}${suffix}`,
    title: `${readinessTitle(refusal)}${suffix}`,
    action
  }
}

interface ComposerReadinessLineProps {
  readiness: ComposerReadiness
  /** Id Send points `aria-describedby` at. */
  reasonId: string
}

/**
 * Why the composer will not send to this agent, and the one action that might
 * change it.
 *
 * **A line of its own under the controls row, at a fixed height, rendered
 * whenever the composer sends straight to one agent — refused or not.** So a
 * refusal arriving (a check that lands while the user types) or clearing
 * (*Check again*) moves nothing, and the reason never competes with the chips
 * for the row's width. Inline in the row, the action and its separator cost
 * ~100px: that wrapped two chips at the narrowest window and four at every
 * width, moved the textarea when the refusal cleared, and squeezed the reason
 * itself to nothing, leaving "· Check again" with no sentence before it.
 */
export function ComposerReadinessLine({
  readiness,
  reasonId
}: ComposerReadinessLineProps): React.JSX.Element {
  const { refusal, text, title, action } = readiness

  return (
    <div data-readiness-line="" className="flex h-4 mt-1 px-1 min-w-0 items-center justify-end gap-1.5">
      {refusal && text && action && (
        <>
          <span
            id={reasonId}
            role="status"
            aria-live="polite"
            title={title ?? undefined}
            className={`min-w-0 truncate text-right text-[11px] leading-4 ${readinessTone(refusal)}`}
          >
            {text}
          </span>
          {/* Keeps an amber sentence and an accent action from reading as one run. */}
          <span aria-hidden="true" className="shrink-0 text-[11px] leading-4 text-[var(--color-text-muted)]">
            ·
          </span>
          <button
            type="button"
            // `aria-disabled`, not `disabled`: a button that disables itself while
            // it has focus drops focus to the page body mid-check.
            aria-disabled={action.pending || undefined}
            onClick={() => {
              if (!action.pending) action.run()
            }}
            // Wide enough for either of its labels, so the pending swap moves nothing.
            className={`shrink-0 inline-flex items-center justify-center gap-1 text-[11px] leading-4 font-medium
              text-[var(--color-accent)] hover:text-[var(--color-accent-hover)] transition-colors
              aria-disabled:cursor-default ${action.label.length > 11 ? 'min-w-[6.5rem]' : 'min-w-[5rem]'}`}
          >
            {action.pending ? (
              <>
                <Loader2 size={10} className="animate-spin" />
                {action.pendingLabel}
              </>
            ) : (
              action.label
            )}
          </button>
        </>
      )}
    </div>
  )
}

interface RefusableExamplePromptsProps {
  /** The refusal a send from these prompts would meet; null leaves them live. */
  refusal: AgentReadiness | null
  children: React.ReactNode
}

/**
 * The new-chat example prompts, dimmed and inert while the agent they would
 * be sent to is refused — they send past the composer, so a live-looking tag
 * that does nothing would be a silent failure.
 *
 * The two wrappers are always rendered, so a refusal arriving or clearing
 * swaps classes rather than the tree: the tags keep their footprint and do not
 * replay their entry animation.
 */
export function RefusableExamplePrompts({
  refusal,
  children
}: RefusableExamplePromptsProps): React.JSX.Element {
  return (
    <div
      className={`w-full${refusal ? ' cursor-not-allowed' : ''}`}
      title={refusal ? readinessTitle(refusal) : undefined}
      aria-disabled={refusal ? true : undefined}
    >
      <div inert={refusal ? true : undefined} className={`w-full${refusal ? ' opacity-50 pointer-events-none' : ''}`}>
        {children}
      </div>
    </div>
  )
}
