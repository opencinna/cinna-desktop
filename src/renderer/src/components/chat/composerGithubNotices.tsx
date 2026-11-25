import { useEffect, useState, type ReactNode } from 'react'
import { ArrowRight, Check, Copy, ExternalLink, Loader2, LogIn, RefreshCw, X } from 'lucide-react'
import { NOTICE_DISMISS_BUTTON, NoticeButton, StableLabel, type ComposerNotice } from './ComposerNoticePanel'
import { copyGithubCode, useGithubCheckOnFocus, useGithubSignIn, useGithubStatus, type GithubSignIn } from '../../hooks/useGithub'
import { useGithubNoticeStore } from '../../stores/githubNotice.store'
import { unwrapIpcError } from '../../utils/ipcError'
import type { GithubNeedDto } from '../../../../shared/github'

/**
 * The composer's GitHub rows: an agent's `gh` or `git` found nothing to authenticate with (main
 * recorded a need, deduplicated per profile), so the chat of that agent offers the one thing that
 * fixes it. Each row is the panel's one-line template (ux_rules rule 19), warning tone, with a ×;
 * only the device flow's wait keeps its action under the line, as the engine login does.
 */

/** What Continue sends to the chat, exactly. */
export const GITHUB_CONTINUE_MESSAGE = 'GitHub is connected, go on'

const ACCOUNT_SENTENCE: Record<'sign_in' | 'reconnect', string> = {
  sign_in: 'GitHub isn’t connected.',
  reconnect: 'The GitHub sign-in expired.'
}
const ACCOUNT_TITLE: Record<'sign_in' | 'reconnect', string> = {
  sign_in: 'GitHub isn’t connected. This agent’s gh and git commands need a GitHub sign-in.',
  reconnect: 'The GitHub sign-in expired. Sign in again so this agent’s gh and git commands can reach GitHub.'
}
const ACCOUNT_LABEL: Record<'sign_in' | 'reconnect', string> = {
  sign_in: 'Sign in to GitHub',
  reconnect: 'Reconnect GitHub'
}

/** The code's copy button, an icon beside the code (ux_rules rule 20). Says when the copy failed. */
export function CopyCodeButton({ code, className = NOTICE_DISMISS_BUTTON, size = 13 }: { code: string; className?: string; size?: number }): React.JSX.Element {
  const [copied, setCopied] = useState<boolean | null>(null)
  useEffect(() => setCopied(null), [code])
  const title = copied === true ? 'Copied' : copied === false ? 'Copy failed' : 'Copy code'
  return (
    <button type="button" aria-label="Copy code" title={title}
      className={`${className} inline-flex align-middle`}
      onClick={() => { void copyGithubCode(code).then(setCopied) }}>
      {copied === true ? <Check size={size} aria-hidden="true" /> : copied === false ? <X size={size} aria-hidden="true" /> : <Copy size={size} aria-hidden="true" />}
    </button>
  )
}

/** "Enter code ABCD-1234 on GitHub. Only enter a code Cinna shows you." with the code's copy button. */
export function GithubCodeSentence({ code, copyButton }: { code: string; copyButton: ReactNode }): React.JSX.Element {
  return <>Enter code <strong className="font-mono font-semibold tracking-wide">{code}</strong>{copyButton} on GitHub. Only enter a code Cinna shows you.</>
}

/** The account need's sentence and its one action, for a phase of the device flow. */
function accountRow(kind: 'sign_in' | 'reconnect', signIn: GithubSignIn): Pick<ComposerNotice, 'text' | 'title' | 'action' | 'actionBelow' | 'singleLine'> {
  const { phase } = signIn
  const startButton = (label: string, Icon: typeof LogIn) => (
    <NoticeButton aria-disabled={phase.kind === 'starting' || undefined} aria-busy={phase.kind === 'starting'} title={label}
      onClick={() => { if (phase.kind !== 'starting') signIn.start() }}>
      <StableLabel pending={phase.kind === 'starting'} label={<><Icon size={12} aria-hidden="true" />{label}</>}
        pendingLabel={<><Loader2 size={12} className="animate-spin" aria-hidden="true" />Starting…</>} />
    </NoticeButton>
  )
  if (phase.kind === 'pending') {
    const sentence = `Enter code ${phase.userCode} on GitHub. Only enter a code Cinna shows you.`
    return {
      text: <GithubCodeSentence code={phase.userCode} copyButton={<CopyCodeButton code={phase.userCode} />} />,
      title: sentence,
      // The one state whose action stays under the line, as the engine login's does (ux_rules
      // rule 19's exception): the wait plus Cancel is far wider than Sign in to GitHub.
      actionBelow: true,
      action: (
        <div className="flex items-center gap-2">
          <NoticeButton aria-disabled aria-busy>
            <Loader2 size={12} className="animate-spin" aria-hidden="true" />Waiting for you to approve in the browser…
          </NoticeButton>
          <NoticeButton onClick={signIn.cancel}><X size={12} aria-hidden="true" />Cancel</NoticeButton>
        </div>
      )
    }
  }
  const label = ACCOUNT_LABEL[kind]
  if (phase.kind === 'expired') {
    return { text: 'Code expired.', title: 'The GitHub sign-in code expired before it was approved.', singleLine: true, action: startButton('Get a new code', RefreshCw) }
  }
  if (phase.kind === 'denied') {
    return { text: 'Sign-in was declined.', title: 'The GitHub sign-in was declined in the browser.', singleLine: true, action: startButton(label, LogIn) }
  }
  if (phase.kind === 'error') {
    return { text: phase.error, title: phase.error, singleLine: true, action: startButton(label, LogIn) }
  }
  return { text: ACCOUNT_SENTENCE[kind], title: ACCOUNT_TITLE[kind], singleLine: true, action: startButton(label, LogIn) }
}

/** The repositories an install need names, as the sentence says them: `owner/repo, owner/other`, or the owner. */
export function githubNeedRepos(need: Pick<GithubNeedDto, 'repos' | 'owner'>): string {
  return need.repos?.length ? need.repos.join(', ') : need.owner ?? 'this repository'
}

export interface GithubNoticeHandlers {
  signIn: GithubSignIn
  dismiss: (key: string) => void
  allowAccess: (key: string) => void
  /** Why the last Allow access of that need did not open, or null. */
  allowError: (key: string) => string | null
}

/** One GitHub need as a composer row; null for a kind P1 never shows (`admin`). */
export function githubNeedNotice(need: GithubNeedDto, handlers: GithubNoticeHandlers): ComposerNotice | null {
  const base = {
    key: `github:${need.key}`, tone: 'warning' as const, icon: LogIn,
    onDismiss: () => handlers.dismiss(need.key)
  }
  if (need.kind === 'sign_in' || need.kind === 'reconnect') {
    return { ...base, ...accountRow(need.kind, handlers.signIn), dismissLabel: 'Dismiss GitHub sign-in' }
  }
  if (need.kind !== 'install') return null
  const repos = githubNeedRepos(need)
  const sentence = `Cinna’s GitHub app can’t reach ${repos} yet.`
  const failure = handlers.allowError(need.key)
  return {
    ...base, icon: ExternalLink,
    text: failure ?? sentence,
    title: failure ?? `${sentence} Allow access opens GitHub, where you choose the repositories Cinna may use.`,
    singleLine: true,
    dismissLabel: 'Dismiss GitHub access request',
    action: <NoticeButton title={`Allow access to ${repos}`} onClick={() => handlers.allowAccess(need.key)}>
      <ExternalLink size={12} aria-hidden="true" />Allow access
    </NoticeButton>
  }
}

/** A need shown in this chat cleared: say so, and offer to tell the agent. */
export function githubResolvedNotice(onContinue: () => void, onDismiss: () => void, failed: boolean): ComposerNotice {
  const text = failed ? 'GitHub is connected. The message couldn’t be sent yet.' : 'GitHub is connected.'
  return {
    key: 'github:resolved', tone: 'warning', icon: Check, text,
    title: `${text} Continue sends “${GITHUB_CONTINUE_MESSAGE}” to this chat.`,
    singleLine: true,
    onDismiss, dismissLabel: 'Dismiss without sending',
    action: <NoticeButton title={`Send “${GITHUB_CONTINUE_MESSAGE}”`} onClick={onContinue}>
      <ArrowRight size={12} aria-hidden="true" />Continue
    </NoticeButton>
  }
}

/**
 * The GitHub rows of one chat whose answering agent is `agentId`: one per need whose `agentIds`
 * holds it, or, once a need this chat showed has cleared with the profile connected, "GitHub is
 * connected" + Continue, which `send`s {@link GITHUB_CONTINUE_MESSAGE} through the composer. None
 * on the new-chat screen (`chatId` null): there is no conversation to continue.
 */
export function useGithubNotices(chatId: string | null, agentId: string | null, send: (text: string) => Promise<boolean> | boolean): ComposerNotice[] {
  const { data: status } = useGithubStatus()
  const signIn = useGithubSignIn(status)
  const [allowFailure, setAllowFailure] = useState<{ key: string; error: string } | null>(null)
  const [sendFailed, setSendFailed] = useState(false)
  const scope = chatId && agentId ? `${chatId}\n${agentId}` : null
  const needs = scope && status ? status.needs.filter((n) => n.kind !== 'admin' && n.agentIds.includes(agentId as string)) : []
  const keySignature = needs.map((n) => n.key).join('\n')
  const connected = status?.account?.state === 'connected'
  const resolved = useGithubNoticeStore((s) => (scope ? !!s.resolved[scope] : false))
  useEffect(() => {
    if (!scope || !status) return
    const store = useGithubNoticeStore.getState()
    const keys = keySignature ? keySignature.split('\n') : []
    const gone = store.see(scope, keys)
    if (keys.length > 0) store.clearResolved(scope)
    else if (gone.length > 0 && connected) store.resolve(scope)
  }, [scope, status, keySignature, connected])
  useEffect(() => setSendFailed(false), [scope, resolved])
  useGithubCheckOnFocus(needs.some((n) => n.kind === 'install'))

  if (!scope) return []
  const handlers: GithubNoticeHandlers = {
    signIn,
    dismiss: (key) => {
      // Put away by hand: its going is not GitHub getting connected.
      useGithubNoticeStore.getState().forget(scope, key)
      void window.api.github.dismiss(key).catch(() => undefined)
    },
    allowAccess: (key) => {
      setAllowFailure(null)
      void window.api.github.openInstall(key)
        .then((result) => { if (!result.ok) setAllowFailure({ key, error: result.error }) })
        .catch((error) => setAllowFailure({ key, error: unwrapIpcError(error, 'Couldn’t open GitHub.') }))
    },
    allowError: (key) => (allowFailure?.key === key ? allowFailure.error : null)
  }
  const rows = needs.flatMap((need) => githubNeedNotice(need, handlers) ?? [])
  if (rows.length > 0 || !resolved) return rows
  const clear = (): void => useGithubNoticeStore.getState().clearResolved(scope)
  return [githubResolvedNotice(() => {
    void Promise.resolve(send(GITHUB_CONTINUE_MESSAGE)).then((sent) => {
      if (sent) clear()
      else setSendFailed(true)
    }, () => setSendFailed(true))
  }, clear, sendFailed)]
}
