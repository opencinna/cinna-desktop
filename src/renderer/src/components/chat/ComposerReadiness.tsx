import { useEffect, useId, useRef, useState, type ReactNode } from 'react'
import { AlertTriangle, ArrowUpRight, Check, Copy, Cpu, Download, ExternalLink, FileWarning, FolderOpen, KeyRound, Loader2, LogIn, Plus, RefreshCw, WifiOff, X } from 'lucide-react'
import type { LucideIcon } from 'lucide-react'
import { FindingText, NoticeButton, StableLabel } from './ComposerNoticePanel'
import type { ComposerNotice } from './ComposerNoticePanel'
import { AntigravityTermsTip } from '../settings/AntigravityTermsTip'
import { useCheckAgentReadiness } from '../../hooks/useAgents'
import { useProviders } from '../../hooks/useProviders'
import { useLocalAgents, useOpenAgentPath } from '../../hooks/useLocalAgents'
import { isSkillFinding } from '../../../../shared/kit/findings'
import { folderReadinessBlocksTurn, missingCredentialsReason, type LocalAgentDto, type LocalAgentSkill, type LocalAgentSkillCredential } from '../../../../shared/localAgents'
import { useFinishSetup } from '../agents/local/FinishSetupDialog'
import { useSlotAuthorize, type SlotAuthorizeState } from '../../hooks/useSlotAuthorize'
import { credentialTypeName } from '../settings/LocalCredentialForm'
import { isGoogleOAuthType, type CredentialSetupDto, type SlotOAuthAction } from '../../../../shared/serviceCredentials'
import { useCredentialSetup } from '../../hooks/useServiceCredentials'
import { useAgentAiCredentialIssue, type AiCredentialIssue } from '../../hooks/useAgentAiCredential'
import { useUIStore } from '../../stores/ui.store'
import { skillsLackingCredentials, useSkillCredentialPromptStore } from '../../stores/skillCredentialPrompt.store'
import { useAgentActiveSessions } from '../../hooks/useAgentSessions'
import { activeSessionSentence, openSessionTitle, runningSessionsOf, useOpenSession } from '../agents/AgentActiveSessionNotice'
import { useCinnaReauth } from '../../hooks/useAuth'
import { useEngineLogin } from '../../hooks/useLocalTools'
import { unwrapIpcError } from '../../utils/ipcError'
import { RUN_REFERENCE_PATTERN } from '../../../../shared/kit/manifest'
import { readinessBlocksTurn } from '../../../../shared/agentDrivers'
import type { AgentReadiness, AgentReadinessState } from '../../../../shared/agentDrivers'
import { DEFAULT_AGENT_ENGINE, effectiveEngine, ENGINE_LOGIN_NAMES, isEngineLoginId, loginFailureLead, loginPendingText, type EngineLoginId } from '../../../../shared/engine'
import { isModelOffered, type RuntimeModelCatalog } from '../../../../shared/runtimeModelCatalog'
import { useDefaultRuntime } from '../../hooks/useEngine'
import { useRuntimeModelCatalog, useRuntimeModelCatalogRefresh } from '../../hooks/useRuntimeModelCatalog'

type AgentData = Awaited<ReturnType<typeof window.api.agents.list>>[number]

export type ReadinessSeverity = 'warning' | 'danger'

/**
 * How loudly a readiness state is shown. Something the user fixes on this
 * machine or in their account — a credential, a login, an install — is a
 * warning; an agent that cannot be reached or whose folder cannot be run (an
 * unparseable manifest, a duplicate id, a newer contract) is an error. A folder
 * that only fails validation is not `invalid` here: its findings are a notice
 * row of their own (`useFolderFindingsNotice`).
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
  /** Offered beside the pending button — a login waiting on a browser can be stopped. */
  cancel?: () => void
  /**
   * After a login that did not finish: the terminal command to run instead,
   * offered as **Copy command** after the main button rather than spliced
   * into the warning's prose.
   */
  copyCommand?: string | null
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
  // A CLI engine that is not logged in is fixed by its own login, run in-app
  // on the binary the turns use — the readiness names which one.
  const loginEngine =
    notice?.state === 'not_logged_in' && target?.capabilities.auth !== 'cinna' ? (notice.login ?? null) : null
  const login = useEngineLogin(loginEngine)

  // An earlier failure belongs to the agent and the answer it was shown
  // against; a new target, or a new answer, starts clean.
  const resetCheck = check.reset
  const resetReauth = reauth.reset
  const resetLogin = login.reset
  useEffect(() => {
    resetCheck()
    resetReauth()
    resetLogin()
  }, [agentId, notice?.state, notice?.reason, resetCheck, resetReauth, resetLogin])

  if (!target || !notice) {
    return { notice: null, refusal: null, blocksSend: false, text: null, title: null, action: null }
  }

  // An expired Cinna session is not fixed by asking again: it is fixed by
  // signing in again, the same flow the chat's error bubble offers.
  const reauthable = notice.state === 'not_logged_in' && target.capabilities.auth === 'cinna'
  const failure = loginEngine
    ? loginFailureLead(login.failure)
    : reauthable
    ? reauth.error
      ? unwrapIpcError(reauth.error, 'Re-authentication failed')
      : reauth.data && !reauth.data.success
        ? (reauth.data.error ?? 'Re-authentication failed')
        : null
    : check.error
      ? unwrapIpcError(check.error, 'the check could not run')
      : null
  const suffix = failure
    ? ` Couldn't ${loginEngine ? 'log in' : reauthable ? 're-authenticate' : 'check again'} — ${failure}`
    : ''

  const action: ReadinessAction = loginEngine
    ? {
        label: 'Log in',
        pendingLabel: loginPendingText(loginEngine, login.phase),
        pending: login.pending,
        // Pressed again while pending it would only join the running login;
        // the button refuses the press anyway (`aria-disabled`).
        run: login.start,
        cancel: login.cancel,
        copyCommand: loginFailureLead(login.failure) ? login.failure?.command ?? null : null
      }
    : reauthable
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
function ReadinessActionButton({ action, tip }: {
  action: ReadinessAction
  /** A (?) kept directly before the button, so the button's changing label never moves it. */
  tip?: React.ReactNode
}): React.JSX.Element {
  const [feedback, setFeedback] = useState(false)
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null)
  useEffect(() => () => { if (timer.current !== null) clearTimeout(timer.current) }, [])
  const pending = action.pending || feedback
  const isCheck = action.label === 'Check again'
  // Log in and Re-authenticate both sign in; Check again refreshes (its glyph spins while it runs).
  const ActionIcon = isCheck ? RefreshCw : LogIn
  const button = <NoticeButton aria-disabled={pending || undefined} aria-busy={pending}
    onClick={() => {
      if (action.pending || timer.current !== null) return
      // Keep an unchanged, immediate answer visibly checking, without delaying recovery.
      setFeedback(true)
      timer.current = setTimeout(() => { timer.current = null; setFeedback(false) }, 600)
      action.run()
    }}>
    {action.cancel
      // A login's pending label ("Waiting for sign-in in your browser…") is far wider than Log in,
      // and Cancel comes with it: sized to both, the idle button would be mostly padding. On its own
      // line under the sentence (`actionBelow`) it widens into free space instead.
      ? <>{pending ? <Loader2 size={12} className="animate-spin" /> : <ActionIcon size={12} aria-hidden="true" />}{pending ? action.pendingLabel : action.label}</>
      : <StableLabel pending={pending}
          label={<><ActionIcon size={12} aria-hidden="true" />{action.label}</>}
          pendingLabel={<>{isCheck ? <RefreshCw size={12} className="animate-spin" /> : <Loader2 size={12} className="animate-spin" />}{action.pendingLabel}</>} />}
  </NoticeButton>
  if (!action.cancel && !tip) return button
  // Always wrapped when a cancel exists, so the button keeps its place in the
  // tree — and its focus — as Copy command and Cancel come and go after it.
  return <div className="flex items-center gap-2">
    {/* Before the button: its label widens while the sign-in runs, and a tip
        after it would slide sideways under the pointer (ux_rules rule 1). */}
    {tip}
    {button}
    {!pending && action.copyCommand && <CopyCommandButton key={action.copyCommand} command={action.copyCommand} />}
    {action.pending && action.cancel && <NoticeButton onClick={action.cancel}><X size={12} aria-hidden="true" />Cancel</NoticeButton>}
  </div>
}

/** Copies the terminal fallback through main's clipboard; `navigator.clipboard` rejects without document focus. */
function CopyCommandButton({ command }: { command: string }): React.JSX.Element {
  const [copied, setCopied] = useState<'yes' | 'failed' | null>(null)
  return <NoticeButton title={command} onClick={() => {
    void window.api.clipboard.writeText(command)
      .then((result) => setCopied(result.success ? 'yes' : 'failed'))
      .catch(() => setCopied('failed'))
  }}>{copied === 'yes' ? <Check size={12} aria-hidden="true" /> : <Copy size={12} aria-hidden="true" />}{copied === 'yes' ? 'Copied' : copied === 'failed' ? 'Copy failed' : 'Copy command'}</NoticeButton>
}

const ICON: Record<Exclude<AgentReadinessState, 'ok'>, LucideIcon> = {
  credentials_needed: KeyRound,
  not_logged_in: KeyRound,
  not_installed: Download,
  unreachable: WifiOff,
  invalid: AlertTriangle,
  contract_too_new: AlertTriangle
}

/** The readiness answer as a row of the composer's notice panel, or null when ready. */
export function readinessNoticeItem(readiness: ComposerReadiness, reasonId: string): ComposerNotice | null {
  const { notice, text, title, action } = readiness
  if (!notice || !text || !action || notice.state === 'ok') return null
  // Before the first sign-in: what the user is about to agree to run, behind a
  // (?) beside Log in — one fixed icon in the action row, so it adds no line.
  const tip = notice.state === 'not_logged_in' && notice.login === 'antigravity'
    ? <AntigravityTermsTip />
    : undefined
  return {
    key: 'readiness',
    tone: readinessSeverity(notice),
    icon: ICON[notice.state],
    text,
    textId: reasonId,
    title: title ?? undefined,
    // The one row whose action stays under its text: a login's button grows into "Waiting for
    // sign-in in your browser…" and Cancel, wider than any reservation worth drawing (ux_rules rule 1).
    actionBelow: action.cancel !== undefined,
    action: <ReadinessActionButton key={reasonId + action.label} action={action} tip={tip} />
  }
}

/** The folder agent behind a composer target, from the list the sidebar already holds; null for any other target. */
export function useComposerFolder(target: AgentData | null): LocalAgentDto | null {
  const { data } = useLocalAgents()
  return (target ? data?.agents.find((a) => a.id === target.id) : undefined) ?? null
}

/**
 * The folder agent with this id, by id alone — a just-created agent is in the
 * folder list (the create mutation writes it there) before the merged agent
 * list has refetched. `pending` while the folder list cannot answer yet: not
 * loaded, or refetching without the agent when the merged list (`listed`)
 * does not know the id either — a folder made behind the mutation's back. An
 * agent the merged list has and the folder list does not is no folder, so a
 * refetch never makes it pending. A surface that would show one thing for a
 * folder and another for no folder waits on `pending` rather than painting
 * the second and then the first.
 */
export function usePickedFolder(agentId: string | null, listed: boolean): { folder: LocalAgentDto | null; pending: boolean } {
  const { data, isError, isFetching } = useLocalAgents()
  const folder = (agentId ? data?.agents.find((a) => a.id === agentId) : undefined) ?? null
  const pending = agentId !== null && folder === null && (data === undefined ? !isError : isFetching && !listed)
  return { folder, pending }
}

/**
 * What the folder's own check found, for a folder agent whose findings do not
 * stop it: the agent still takes the message, and the user still learns the
 * folder is not what its manifest promises. Skill findings are left to the
 * Addons tab, as they are left out of readiness. Null for every other target.
 */
export function useFolderFindingsNotice(folder: LocalAgentDto | null): ComposerNotice | null {
  const openPath = useOpenAgentPath()
  if (!folder || folder.readiness !== 'invalid' || folderReadinessBlocksTurn(folder)) return null
  const errors = folder.validation.errors.filter((finding) => !isSkillFinding(finding))
  if (errors.length === 0) return null
  const [first, ...rest] = errors
  return {
    key: 'folder-findings',
    tone: 'warning',
    icon: FileWarning,
    text: <><span className="text-[var(--color-text-muted)]">{first.path || 'Agent folder'}:</span> <FindingText text={first.message} /></>,
    title: `${first.message} The agent still runs; fix the folder so it behaves as declared.`,
    detailsName: rest.length > 0 ? `Show ${rest.length} more ${rest.length === 1 ? 'finding' : 'findings'}` : undefined,
    details: rest.length > 0
      ? <ul className="space-y-1 text-[11px] leading-snug text-[var(--color-text-secondary)]">
          {rest.map((finding, i) => <li key={`${finding.code}-${i}`}>
            {finding.path && <span className="text-[var(--color-text-muted)]">{finding.path}: </span>}
            <FindingText text={finding.message} />
          </li>)}
        </ul>
      : undefined,
    action: <NoticeButton title={`Show ${first.path || 'the folder'} in Finder`}
      onClick={() => openPath.mutate({ agentId: folder.id, relPath: first.path || undefined })}>
      <FolderOpen size={12} aria-hidden="true" />Reveal
    </NoticeButton>
  }
}

/** The one Google OAuth slot a credential row could authorize directly: `slotKey` as `authorizeSlot` takes it. */
export interface GoogleSlot { slotKey: string; type: string }

/** The folder's missing slot when it is exactly one, and a Google OAuth one; null otherwise. */
export function folderGoogleSlot(folder: LocalAgentDto | null): GoogleSlot | null {
  const missing = folder?.credentials.filter((slot) => !slot.satisfied) ?? []
  return missing.length === 1 && isGoogleOAuthType(missing[0].type) ? { slotKey: missing[0].name, type: missing[0].type } : null
}

/** The prompted skills' missing slot when it is exactly one, and a Google OAuth one (`skill:<slot>`); null otherwise. */
export function skillGoogleSlot(folder: LocalAgentDto | null, prompted: readonly string[] | undefined): GoogleSlot | null {
  if (!folder || !prompted?.length) return null
  const slots = new Map<string, string>()
  for (const { missing } of skillsLackingCredentials(folder, prompted)) for (const slot of missing) slots.set(`${slot.type}\n${slot.slot}`, slot.slot)
  if (slots.size !== 1) return null
  const [[key, slot]] = [...slots]
  const type = key.slice(0, key.indexOf('\n'))
  return isGoogleOAuthType(type) ? { slotKey: `skill:${slot}`, type } : null
}

/**
 * Main's Authorize verdict for a slot key (`setupState`): null until it has answered, without an
 * account to authorize in, or when main does not offer it for that slot.
 */
export function slotOAuthAction(setup: CredentialSetupDto | undefined, slotKey: string): SlotOAuthAction | null {
  if (!setup?.oauthAccount) return null
  if (slotKey.startsWith('skill:')) {
    const name = slotKey.slice('skill:'.length)
    return setup.skillSlots.find((slot) => slot.slot === name && slot.oauth)?.oauth ?? null
  }
  return setup.slots.find((slot) => slot.name === slotKey)?.oauth ?? null
}

/** A credential row's Authorize, as `useComposerNotices` wires it: the slot's sign-in state and its two moves. */
export interface ComposerAuthorize {
  slot: GoogleSlot
  /** Main's verdict on the slot (`setupState`): Reconnect for an owned record whose access expired. */
  action: SlotOAuthAction
  state: SlotAuthorizeState
  onAuthorize: () => void
  onReopen: () => void
}

const BLOCKED = 'Finish the other Google sign-in first.'

/**
 * The row's Authorize (or Reconnect), Reopen or Try again. All four labels share one cell, so the button
 * keeps its width as the sign-in moves on and the sentence before it never re-wraps (ux_rules rule 1).
 * While another sign-in of the agent waits it is dimmed and refuses the click.
 */
function AuthorizeNoticeButton({ authorize }: { authorize: ComposerAuthorize }): React.JSX.Element {
  const { phase, error } = authorize.state
  const shown = phase === 'waiting' ? 'reopen' : error ? 'retry' : authorize.action
  const blocked = phase === 'blocked', busy = phase === 'starting' || blocked
  const cell = (which: string, content: ReactNode) =>
    <span key={which} aria-hidden={shown !== which} className={`col-start-1 row-start-1 flex items-center gap-1 ${shown === which ? '' : 'invisible'}`}>{content}</span>
  const start = phase === 'starting' ? <Loader2 size={12} className="animate-spin" aria-hidden="true" /> : <KeyRound size={12} aria-hidden="true" />
  return <NoticeButton aria-disabled={busy || undefined} aria-busy={phase === 'starting'}
    className={blocked ? '!opacity-50 cursor-not-allowed' : ''}
    title={blocked ? BLOCKED : undefined}
    onClick={() => {
      if (busy) return
      if (shown === 'reopen') authorize.onReopen()
      else authorize.onAuthorize()
    }}>
    <span className="grid">
      {cell('authorize', <>{start}Authorize</>)}
      {cell('reconnect', <>{start}Reconnect</>)}
      {cell('retry', <><RefreshCw size={12} aria-hidden="true" />Try again</>)}
      {cell('reopen', <><ExternalLink size={12} aria-hidden="true" />Reopen</>)}
    </span>
  </NoticeButton>
}

/**
 * What a credential row says while it authorizes its one Google slot: the service by its friendly name
 * ("Gmail (read-only)"), then the wait for the browser, then a failure's reason. Short, so it fits one
 * line beside the button at the narrowest window (ux_rules rule 7).
 */
/** The composer's shorter words for a failure the dialog spells out (the full sentence stays in the row's title). */
const SHORT_ERRORS: Record<string, string> = { timeout: 'Sign-in timed out.', oauth_not_configured: 'Not set up on this server.' }
const SHORT_BLOCKED = 'Finish the other sign-in first.'

function authorizeSentence(skill: string | null, authorize: ComposerAuthorize, short: boolean): string {
  if (authorize.state.phase === 'waiting') return 'Finish in your browser.'
  if (authorize.state.phase === 'blocked') return short ? SHORT_BLOCKED : BLOCKED
  if (authorize.state.error) return (short && authorize.state.errorCode && SHORT_ERRORS[authorize.state.errorCode]) || authorize.state.error
  const service = credentialTypeName(authorize.slot.type)
  return skill === null ? `${service} isn’t connected.` : `${skill} needs ${service}.`
}

/** A credential row that authorizes its one Google slot directly instead of opening Finish setup. */
function authorizeNotice(key: string, skill: string | null, authorize: ComposerAuthorize): Pick<ComposerNotice, 'key' | 'tone' | 'icon' | 'text' | 'title' | 'singleLine' | 'action'> {
  // The slot beside the button is about 200 px at the narrowest window: the line takes the short words, the title the full ones.
  const text = authorizeSentence(skill, authorize, true)
  return { key, tone: 'warning', icon: KeyRound, text, title: authorizeSentence(skill, authorize, false), singleLine: true, action: <AuthorizeNoticeButton authorize={authorize} /> }
}

/**
 * The folder's required credential slots that nothing fills, as a row whose
 * one action is Finish setup. Read from the slots themselves rather than from
 * readiness: a folder that is `invalid` *and* missing a credential says
 * `invalid`, which would hide this row behind the findings one. When the one
 * missing slot is a Google OAuth one (`authorize`), the action is Authorize
 * instead, with no dialog.
 */
export function folderCredentialsNotice(folder: LocalAgentDto | null, onFinishSetup: () => void, authorize: ComposerAuthorize | null = null): ComposerNotice | null {
  const missing = folder?.credentials.filter((slot) => !slot.satisfied) ?? []
  if (!folder || missing.length === 0) return null
  if (authorize && authorize.slot.slotKey === folderGoogleSlot(folder)?.slotKey) return authorizeNotice('folder-credentials', null, authorize)
  const text = folder.readiness === 'credentials_needed' && folder.readinessReason
    ? folder.readinessReason
    : missingCredentialsReason(missing)
  return {
    key: 'folder-credentials',
    tone: 'warning',
    icon: KeyRound,
    text,
    title: text,
    action: <NoticeButton onClick={onFinishSetup}><KeyRound size={12} aria-hidden="true" />Finish setup</NoticeButton>
  }
}

/** One prompted skill's sentence: the slot named when it is one, counted when several. */
function skillCredentialSentence(skill: LocalAgentSkill, missing: readonly LocalAgentSkillCredential[], code: boolean): string {
  // The folder name, as Finish setup names the skill ("Needed by skill invoice-reader").
  const name = skill.name
  if (missing.length > 1) return `${name} needs ${missing.length} credentials this agent doesn’t have.`
  const slot = code ? `\`${missing[0].slot}\`` : missing[0].slot
  return `${name} needs a credential this agent doesn’t have: ${slot}.`
}

/**
 * After Add to agent or Update, the skills main named once its fill of their slots settled
 * (`skill-credential-prompt` store) that still lack a credential, as a row whose action is Finish
 * setup. Read live from the folder's DTO (`skillsLackingCredentials`), so the row goes on its own
 * once they are filled. One truncated line, Finish setup and a × at its end, the shape of the
 * skill-link offer it follows, so swapping one for the other keeps the panel's height (ux_rules
 * rule 1). Only the × puts the prompt away; Finish setup leaves it until the slots fill.
 */
export function skillCredentialsNotice(
  folder: LocalAgentDto | null,
  prompted: readonly string[] | undefined,
  onFinishSetup: () => void,
  onDismiss: () => void,
  authorize: ComposerAuthorize | null = null
): ComposerNotice | null {
  if (!folder || !prompted?.length) return null
  const lacking = skillsLackingCredentials(folder, prompted)
  if (lacking.length === 0) return null
  const [first] = lacking
  if (authorize && authorize.slot.slotKey === skillGoogleSlot(folder, prompted)?.slotKey) {
    return { ...authorizeNotice('skill-credentials', first.skill.name, authorize), onDismiss, dismissLabel: 'Dismiss skill credential prompt' }
  }
  return {
    key: 'skill-credentials',
    tone: 'warning',
    icon: KeyRound,
    text: <FindingText text={skillCredentialSentence(first.skill, first.missing, true)} />,
    title: lacking.map(({ skill, missing }) => skillCredentialSentence(skill, missing, false)).join(' '),
    // The count or slot changes as slots fill; the line never wraps into a second one meanwhile.
    singleLine: true,
    action: <NoticeButton onClick={onFinishSetup}><KeyRound size={12} aria-hidden="true" />Finish setup</NoticeButton>,
    onDismiss,
    dismissLabel: 'Dismiss skill credential prompt'
  }
}

/**
 * The credential rows the panel shows: with the folder's own credentials row on screen, the skill
 * prompt is not a row of its own but a sentence in that row's tooltip, since both open the same
 * Finish setup, which lists the agent's slots and the skills' together.
 */
export function credentialRows(
  folderCredentials: ComposerNotice | null,
  skillPrompt: ComposerNotice | null
): { credentials: ComposerNotice | null; skillCredentials: ComposerNotice | null } {
  if (!folderCredentials) return { credentials: null, skillCredentials: skillPrompt }
  if (!skillPrompt?.title) return { credentials: folderCredentials, skillCredentials: null }
  return {
    credentials: { ...folderCredentials, title: [folderCredentials.title, skillPrompt.title].filter(Boolean).join(' ') },
    skillCredentials: null
  }
}

const AI_CREDENTIAL_TEXT: Record<Exclude<AiCredentialIssue, null>, string> = {
  missing: 'No AI credential is set for this agent.',
  inactive: 'This agent’s AI credential is switched off.'
}

/** The agent page in Settings mode, where Runs with — the runtime and its credential — is the first section. */
export function openAgentRuntimeSettings(agentId: string): void {
  const ui = useUIStore.getState()
  ui.setActiveLocalAgentId(agentId)
  ui.setAgentPageMode('settings')
  ui.setSidebarTab('agents')
  ui.setActiveView('local-agent')
}

/** The agent page in Settings mode on its Credentials tab, where the agent's own access is added. */
export function openAgentCredentials(agentId: string): void {
  const ui = useUIStore.getState()
  ui.setAgentPageTabRequest('credentials')
  ui.setActiveLocalAgentId(agentId)
  ui.setAgentPageMode('settings')
  ui.setSidebarTab('agents')
  ui.setActiveView('local-agent')
}

/** Settings → AI Credentials, where a first credential is added. */
function openAiCredentialsSettings(): void {
  const ui = useUIStore.getState()
  ui.setSettingsMenu('llm')
  ui.setActiveView('settings')
}

/**
 * An OpenCode agent with no AI credential it can spend, as a row; it does not
 * block Send. With none on this machine at all there is nothing to choose on
 * the agent's runtime, so the button goes where one is added instead.
 */
export function aiCredentialNotice(folder: LocalAgentDto | null, issue: AiCredentialIssue, noCredentials = false): ComposerNotice | null {
  if (!folder || !issue) return null
  return {
    key: 'ai-credential',
    tone: 'warning',
    icon: KeyRound,
    text: AI_CREDENTIAL_TEXT[issue],
    action: noCredentials
      ? <NoticeButton onClick={openAiCredentialsSettings}><Plus size={12} aria-hidden="true" />Add credential</NoticeButton>
      : <NoticeButton onClick={() => openAgentRuntimeSettings(folder.id)}><KeyRound size={12} aria-hidden="true" />Choose credential</NoticeButton>
  }
}

/**
 * A CLI agent whose declared model its runtime no longer offers, as a row; it
 * does not block Send — the turn runs on the runtime's default and the chat
 * says so. Only when the runtime's list is known and lacks the model (the
 * driver's own matching, aliases included): an unknown list warns about nothing.
 */
export function staleModelNotice(
  folder: LocalAgentDto | null,
  engine: EngineLoginId | null,
  catalog: RuntimeModelCatalog | undefined
): ComposerNotice | null {
  const model = typeof folder?.runtime?.model === 'string' ? folder.runtime.model.trim() : ''
  if (!folder || !engine || model === '' || isModelOffered(catalog, model) !== false) return null
  const text = `This agent’s model “${model}” is no longer offered by ${ENGINE_LOGIN_NAMES[engine]}.`
  return {
    key: 'stale-model',
    tone: 'warning',
    icon: AlertTriangle,
    text,
    title: text,
    action: <NoticeButton onClick={() => {
      // The panel focuses its Model select once it shows it.
      useUIStore.getState().setPendingRuntimeModelFocusId(folder.id)
      openAgentRuntimeSettings(folder.id)
    }}><Cpu size={12} aria-hidden="true" />Choose model</NoticeButton>
  }
}

/**
 * {@link staleModelNotice} for the composer's folder agent: reads its CLI
 * runtime's recorded list, and asks main for one when the agent names a model
 * and none is known — the same request the Runs with panel makes, shared.
 */
export function useStaleModelNotice(folder: LocalAgentDto | null): ComposerNotice | null {
  const { data: defaultRuntime } = useDefaultRuntime()
  const engine = folder && defaultRuntime ? effectiveEngine(folder.runtime, defaultRuntime.engine ?? DEFAULT_AGENT_ENGINE) : null
  const declaresModel = typeof folder?.runtime?.model === 'string' && folder.runtime.model.trim() !== ''
  const cli = engine && isEngineLoginId(engine) && declaresModel ? engine : null
  const { data: catalog } = useRuntimeModelCatalog(cli)
  useRuntimeModelCatalogRefresh(cli, cli !== null && catalog !== undefined && isModelOffered(catalog, String(folder?.runtime?.model)) === null)
  return staleModelNotice(folder, cli, catalog)
}

export interface ComposerNotices {
  notices: ComposerNotice[]
  /** Finish setup, opened from the credentials row; rendered by the composer (it portals). */
  dialog: ReactNode
}

/**
 * Stop prompting for a skill once it is gone from the folder or no slot of it lacks anything, so a
 * prompt never comes back on its own later (a slot emptied by hand is the Addons row's to say).
 */
export function useDropSettledPrompts(folder: LocalAgentDto | null, prompted: readonly string[] | undefined): void {
  useEffect(() => {
    if (!folder || !prompted?.length) return
    const lacking = new Set(skillsLackingCredentials(folder, prompted).map(({ skill }) => skill.name))
    const done = prompted.filter((name) => !lacking.has(name))
    if (done.length) useSkillCredentialPromptStore.getState().drop(folder.id, done)
  }, [folder, prompted])
}

/**
 * Every row of the composer's notice panel, in one order: the driver's
 * readiness answer, the folder's missing credentials, what a just added or
 * updated skill still lacks, its AI credential, a
 * declared model its CLI runtime no longer offers, its findings. A row the folder states itself replaces the readiness row that
 * says the same thing (`credentials_needed` by the credentials row, a
 * non-blocking `invalid` by the findings row), and takes over its id so Send's
 * `aria-describedby` still names a line on screen.
 *
 * Finish setup is owned here, so by the composer (which outlives the click),
 * and opens only when clicked: the agent page answers team library requests.
 */
export function useComposerNotices(target: AgentData | null, readiness: ComposerReadiness, reasonId: string): ComposerNotices {
  const folder = useComposerFolder(target)
  const findings = useFolderFindingsNotice(folder)
  const finishSetup = useFinishSetup(folder?.id ?? null, folder?.name ?? '', { followRequests: false })
  const aiIssue = useAgentAiCredentialIssue(folder)
  const staleModel = useStaleModelNotice(folder)
  const { data: providers } = useProviders()
  const folderId = folder?.id ?? null
  const prompted = useSkillCredentialPromptStore((s) => (folderId ? s.prompts[folderId] : undefined))
  useDropSettledPrompts(folder, prompted)
  // One missing Google slot is authorized from the row itself, as main judges it (`setupState`): only
  // with an account to authorize in, and Reconnect where the dialog says Reconnect. Until main has
  // answered, and without an account, the row stays Finish setup, whose dialog says to sign in.
  const folderCandidate = folderGoogleSlot(folder)
  const skillCandidate = skillGoogleSlot(folder, prompted)
  const setup = useCredentialSetup(folderId ?? '', folderId !== null && (folderCandidate !== null || skillCandidate !== null))
  // Followed for any agent with a Google slot, not only while one is missing: the flow that just
  // filled it is dismissed by this hook once it attached, after the row has already gone.
  const hasGoogleSlot = !!folder && (folder.credentials.some((slot) => isGoogleOAuthType(slot.type))
    || (folder.skills ?? []).some((skill) => skill.credentials.some((slot) => isGoogleOAuthType(slot.type))))
  const google = useSlotAuthorize(hasGoogleSlot ? folderId : null)
  const authorizeOf = (slot: GoogleSlot | null): ComposerAuthorize | null => {
    const action = slot ? slotOAuthAction(setup.data, slot.slotKey) : null
    return slot && action && {
      slot, action, state: google.stateOf(slot.slotKey), onAuthorize: () => google.authorize(slot.slotKey), onReopen: () => google.reopen(slot.slotKey)
    }
  }
  const folderGoogle = folderCandidate, skillGoogle = skillCandidate
  const skillPrompt = folderId
    ? skillCredentialsNotice(folder, prompted, finishSetup.open, () => useSkillCredentialPromptStore.getState().dismiss(folderId), authorizeOf(skillGoogle))
    : null
  const { credentials, skillCredentials } = credentialRows(folderCredentialsNotice(folder, finishSetup.open, authorizeOf(folderGoogle)), skillPrompt)
  const readinessItem = readinessNoticeItem(readiness, reasonId)
  const state = readiness.notice?.state
  const replacedBy = credentials && state === 'credentials_needed' ? credentials
    // Only when the driver's `invalid` *is* the folder's check: an `invalid`
    // for another cause (folder not found, unsupported engine) is a refusal
    // the findings row does not describe, and keeps its own row.
    : findings && state === 'invalid' && readiness.notice?.reason === folder?.readinessReason ? findings
    : null
  const rows = [
    replacedBy ? null : readinessItem,
    credentials,
    skillCredentials,
    aiCredentialNotice(folder, aiIssue, providers?.length === 0),
    staleModel,
    findings
  ].filter((row): row is ComposerNotice => row !== null)
  return {
    notices: rows.map((row) => (row === replacedBy ? { ...row, textId: reasonId } : row)),
    dialog: finishSetup.dialog
  }
}

/**
 * The new-chat screen's warning, one row per picked agent that is already
 * running a session (a chat, a task): "<Agent> is already running in
 * “<chat>”. Make sure this request won’t conflict with it." with Open, which
 * goes to the newest one. The composer puts these after its readiness rows.
 * A warning only: it never blocks Send. Pass no agents (an existing chat's
 * composer) and nothing is read.
 */
export function useActiveSessionNotices(agents: readonly { id: string; name: string }[]): ComposerNotice[] {
  const { data } = useAgentActiveSessions({ enabled: agents.length > 0 })
  const openSession = useOpenSession()
  const baseId = useId()
  return runningSessionsOf(agents, data).map(({ agent, sessions }, index) => {
    const latest = sessions[0]
    const sentence = activeSessionSentence(agent.name, sessions)
    const textId = `${baseId}-session-${index}`
    return {
      key: `active-session:${agent.id}`,
      tone: 'warning',
      icon: AlertTriangle,
      text: sentence,
      textId,
      title: sentence,
      // Named "Open" as it reads; the sentence it acts on describes it, so
      // several rows' Opens are told apart (ux_rules §10).
      action: <NoticeButton aria-describedby={textId} title={openSessionTitle(latest)} onClick={() => openSession(latest)}><ArrowUpRight size={12} aria-hidden="true" />Open</NoticeButton>
    }
  })
}

interface RefusableExamplePromptsProps {
  /** The refusal a send from these prompts would meet; null leaves them live. */
  refusal: AgentReadiness | null
  /**
   * A reason sends are held for now (the agent's prompts are being drafted),
   * or null. Holds the prompts the same way a refusal does.
   */
  hold?: string | null
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
  hold = null,
  children
}: RefusableExamplePromptsProps): React.JSX.Element {
  const inert = refusal !== null || !!hold
  return (
    <div
      className={`w-full${inert ? ' cursor-not-allowed' : ''}`}
      title={refusal ? readinessTitle(refusal) : hold || undefined}
      aria-disabled={inert ? true : undefined}
    >
      <div inert={inert ? true : undefined} className={`w-full${inert ? ' opacity-50 pointer-events-none' : ''}`}>
        {children}
      </div>
    </div>
  )
}
