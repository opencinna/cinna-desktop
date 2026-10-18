import { useEffect, useId, useRef, useState, type ReactNode } from 'react'
import { AlertTriangle, Download, FileWarning, FolderOpen, KeyRound, Loader2, RefreshCw, WifiOff } from 'lucide-react'
import type { LucideIcon } from 'lucide-react'
import { FindingText, NoticeButton } from './ComposerNoticePanel'
import type { ComposerNotice } from './ComposerNoticePanel'
import { AntigravityTermsTip } from '../settings/AntigravityTermsTip'
import { useCheckAgentReadiness } from '../../hooks/useAgents'
import { useProviders } from '../../hooks/useProviders'
import { useLocalAgents, useOpenAgentPath } from '../../hooks/useLocalAgents'
import { isSkillFinding } from '../../../../shared/kit/findings'
import { folderReadinessBlocksTurn, missingCredentialsReason, type LocalAgentDto } from '../../../../shared/localAgents'
import { useFinishSetup } from '../agents/local/FinishSetupDialog'
import { useAgentAiCredentialIssue, type AiCredentialIssue } from '../../hooks/useAgentAiCredential'
import { useUIStore } from '../../stores/ui.store'
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
  const button = <NoticeButton aria-disabled={pending || undefined} aria-busy={pending}
    onClick={() => {
      if (action.pending || timer.current !== null) return
      // Keep an unchanged, immediate answer visibly checking, without delaying recovery.
      setFeedback(true)
      timer.current = setTimeout(() => { timer.current = null; setFeedback(false) }, 600)
      action.run()
    }}>
    {isCheck ? <RefreshCw size={12} className={pending ? 'animate-spin' : undefined} />
      : pending && <Loader2 size={12} className="animate-spin" />}
    {pending ? action.pendingLabel : action.label}
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
    {action.pending && action.cancel && <NoticeButton onClick={action.cancel}>Cancel</NoticeButton>}
  </div>
}

/** Copies the terminal fallback through main's clipboard; `navigator.clipboard` rejects without document focus. */
function CopyCommandButton({ command }: { command: string }): React.JSX.Element {
  const [copied, setCopied] = useState<'yes' | 'failed' | null>(null)
  return <NoticeButton title={command} onClick={() => {
    void window.api.clipboard.writeText(command)
      .then((result) => setCopied(result.success ? 'yes' : 'failed'))
      .catch(() => setCopied('failed'))
  }}>{copied === 'yes' ? 'Copied' : copied === 'failed' ? 'Copy failed' : 'Copy command'}</NoticeButton>
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
    // A login's button grows into "Waiting for sign-in…" and Cancel.
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
    detailsLabel: rest.length > 0 ? `${rest.length} more` : undefined,
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

/**
 * The folder's required credential slots that nothing fills, as a row whose
 * one action is Finish setup. Read from the slots themselves rather than from
 * readiness: a folder that is `invalid` *and* missing a credential says
 * `invalid`, which would hide this row behind the findings one.
 */
export function folderCredentialsNotice(folder: LocalAgentDto | null, onFinishSetup: () => void): ComposerNotice | null {
  const missing = folder?.credentials.filter((slot) => !slot.satisfied) ?? []
  if (!folder || missing.length === 0) return null
  const text = folder.readiness === 'credentials_needed' && folder.readinessReason
    ? folder.readinessReason
    : missingCredentialsReason(missing)
  return {
    key: 'folder-credentials',
    tone: 'warning',
    icon: KeyRound,
    text,
    title: text,
    action: <NoticeButton onClick={onFinishSetup}>Finish setup</NoticeButton>
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
      ? <NoticeButton onClick={openAiCredentialsSettings}>Add credential</NoticeButton>
      : <NoticeButton onClick={() => openAgentRuntimeSettings(folder.id)}>Choose credential</NoticeButton>
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
    }}>Choose model</NoticeButton>
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
 * Every row of the composer's notice panel, in one order: the driver's
 * readiness answer, the folder's missing credentials, its AI credential, a
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
  const credentials = folderCredentialsNotice(folder, finishSetup.open)
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
      action: <NoticeButton aria-describedby={textId} title={openSessionTitle(latest)} onClick={() => openSession(latest)}>Open</NoticeButton>
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
