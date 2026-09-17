import { useEffect, useRef, useState } from 'react'
import { Loader2, RefreshCw } from 'lucide-react'
import { ComposerWarning } from './ComposerWarning'
import { SettingsButton } from '../settings/SettingsLayout'
import { useCheckAgentReadiness } from '../../hooks/useAgents'
import { useCinnaReauth } from '../../hooks/useAuth'
import { unwrapIpcError } from '../../utils/ipcError'
import { RUN_REFERENCE_PATTERN } from '../../../../shared/kit/manifest'
import { readinessBlocksTurn } from '../../../../shared/agentDrivers'
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

/** The readiness a warning is shown for, or null when the agent is `ok` or unchecked. */
export function readinessNotice(agent: AgentData | null | undefined): AgentReadiness | null {
  const readiness = agent?.readiness ?? null
  return readiness && readiness.state !== 'ok' ? readiness : null
}

/**
 * The readiness a send to `agent` is refused on, or null when it is not.
 *
 * Only an answer the agent's driver actually gave refuses: `null` — never
 * checked, or a check that could not tell — lets the message through, so a
 * probe that has not happened can never stop a working agent. Missing
 * credentials warn without refusing (see `readinessBlocksTurn`).
 */
export function readinessRefusal(agent: AgentData | null | undefined): AgentReadiness | null {
  const readiness = readinessNotice(agent)
  return agent && readinessBlocksTurn(readiness, agent.capabilities) ? readiness : null
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
  /** The answer the warning is shown for; null when the agent is ready. */
  notice: AgentReadiness | null
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
 * Everything the composer needs for an agent that is not ready: whether to
 * block, what to say, and what to offer. A notice that does not refuse
 * (missing credentials) is said and offered the same way, with Send left on.
 *
 * The line depends only on the agent's readiness and on the outcome of the
 * action — never on what is typed — so nothing appears or moves while the user
 * types. What is typed decides only `blocksSend`.
 */
export function useComposerReadiness(target: AgentData | null, typed: string): ComposerReadiness {
  const check = useCheckAgentReadiness()
  const reauth = useCinnaReauth()
  const notice = readinessNotice(target)
  const refusal = readinessRefusal(target)
  const agentId = target?.id ?? null

  // An earlier failure belongs to the agent and the answer it was shown
  // against; a new target, or a new answer, starts clean.
  const resetCheck = check.reset
  const resetReauth = reauth.reset
  useEffect(() => {
    resetCheck()
    resetReauth()
  }, [agentId, notice?.state, notice?.reason, resetCheck, resetReauth])

  if (!target || !notice) {
    return { notice: null, refusal: null, blocksSend: false, text: null, title: null, action: null }
  }

  // An expired Cinna session is not fixed by asking again: it is fixed by
  // signing in again, the same flow the chat's error bubble offers.
  const reauthable = notice.state === 'not_logged_in' && target.capabilities.auth === 'cinna'
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
    notice,
    refusal,
    blocksSend: refusal !== null && !isCatalogCommand(target, typed),
    text: `${readinessText(notice)}${suffix}`,
    title: `${readinessTitle(notice)}${suffix}`,
    action
  }
}

/** Match settings actions while retaining focus until a warning clears. */
function ReadinessActionButton({ action }: { action: ReadinessAction }): React.JSX.Element {
  const [feedback, setFeedback] = useState(false)
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null)
  useEffect(() => () => { if (timer.current !== null) clearTimeout(timer.current) }, [])
  const pending = action.pending || feedback
  const isCheck = action.label === 'Check again'
  return <SettingsButton aria-disabled={pending || undefined} aria-busy={pending}
    onClick={() => {
      if (action.pending || timer.current !== null) return
      // Keep an unchanged, immediate answer visibly checking, without delaying recovery.
      setFeedback(true)
      timer.current = setTimeout(() => { timer.current = null; setFeedback(false) }, 600)
      action.run()
    }}>
    {isCheck ? <RefreshCw size={13} className={pending ? 'animate-spin' : undefined} />
      : pending && <Loader2 size={13} className="animate-spin" />}
    {pending ? action.pendingLabel : action.label}
  </SettingsButton>
}

/** A complete, actionable warning above the input, hidden when ready. */
export function ComposerReadinessWarning({ readiness, reasonId }: {
  readiness: ComposerReadiness
  reasonId: string
}): React.JSX.Element | null {
  const { notice, text, title, action } = readiness
  if (!notice || !text || !action) return null
  return <ComposerWarning className="mb-3" tone={readinessSeverity(notice)} action={
    <ReadinessActionButton key={reasonId + action.label} action={action} />
  }>
    <p id={reasonId} title={title ?? undefined}>{text}</p>
  </ComposerWarning>
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
