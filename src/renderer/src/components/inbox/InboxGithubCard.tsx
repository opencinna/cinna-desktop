import { Fragment, useEffect, useState } from 'react'
import { ExternalLink, Loader2, LogIn, RefreshCw, X } from 'lucide-react'
import type { GithubNeedInboxItem } from '../../../../shared/inbox'
import { useGithubCheckOnFocus, useGithubSignIn, useGithubStatus } from '../../hooks/useGithub'
import { useOpenAgentPage } from '../../hooks/useOpenAgentPage'
import { unwrapIpcError } from '../../utils/ipcError'
import { useCatalogType } from '../agents/catalogSurface'
import { CopyCodeButton, GithubCodeSentence, githubNeedRepos, useGithubAllowAccess } from '../chat/composerGithubNotices'

/** Words of the GitHub card: an agent's run with no chat to ask in stopped at gh or git. */
export const GITHUB_INBOX_TEXT = {
  /** "Repo Agent", "Repo Agent and Site Agent", "Repo Agent and 2 other agents". */
  agents: (names: string[]): string =>
    names.length <= 1 ? names[0] ?? 'an agent'
      : names.length === 2 ? `${names[0]} and ${names[1]}`
      : `${names[0]} and ${names.length - 1} other agents`,
  /** The title before the agents: "GitHub isn’t connected for". */
  lead: (kind: GithubNeedInboxItem['need']['kind']): string =>
    kind === 'reconnect' ? 'The GitHub sign-in expired for'
      : kind === 'install' ? 'Cinna’s GitHub app can’t reach your repos for'
      : 'GitHub isn’t connected for',
  subject: (item: GithubNeedInboxItem): string =>
    `${GITHUB_INBOX_TEXT.lead(item.need.kind)} ${GITHUB_INBOX_TEXT.agents(item.agents.map((a) => a.name))}`,
  account: 'A scheduled run or command stopped at gh or git, with no chat to ask you in.',
  install: (repos: string): string => `A scheduled run or command couldn’t reach ${repos} on GitHub.`,
  badge: 'GitHub',
  signIn: 'Sign in to GitHub',
  reconnect: 'Reconnect GitHub',
  allowAccess: 'Allow access',
  newCode: 'Get a new code',
  starting: 'Starting…',
  waiting: 'Waiting for you to approve in the browser…',
  cancel: 'Cancel',
  expired: 'Code expired.',
  denied: 'GitHub sign-in was declined.',
  dismiss: 'Dismiss',
  connected: (several: boolean): string =>
    several ? 'GitHub is connected. Their next runs can use it.' : 'GitHub is connected. The agent’s next run can use it.',
  reachable: (repos: string): string => `Cinna can reach ${repos} now.`,
  dismissed: 'Dismissed. It shows again if a run needs GitHub again.',
  dismissFailed: 'The card could not be dismissed.'
} as const

const PRIMARY =
  'inline-flex items-center gap-1.5 rounded-md bg-[var(--color-accent)] px-2.5 py-1 text-[11px] font-medium text-white ' +
  'transition-colors hover:bg-[var(--color-accent-hover)] aria-disabled:opacity-60'
const SECONDARY =
  'inline-flex items-center gap-1.5 rounded-md border border-[var(--color-border)] px-2.5 py-1 text-[11px] font-medium ' +
  'text-[var(--color-text)] transition-colors hover:bg-[var(--color-bg-hover)] aria-disabled:opacity-60'
const COPY =
  'inline-flex shrink-0 rounded p-0.5 align-middle text-[var(--color-text-muted)] transition-colors hover:bg-[var(--color-bg-hover)] hover:text-[var(--color-text)]'
const LINK = 'font-medium text-[var(--color-accent)] transition-colors hover:text-[var(--color-accent-hover)]'

/**
 * "GitHub isn’t connected for *agent*" (and the expired and install kinds): an agent's kit command
 * or scheduled run with no chat found nothing to authenticate its gh or git with, so there is no
 * composer to show the row in. The card offers the composer row's own action — Sign in to GitHub
 * (the profile's one device flow, its code on the card's one body line), Reconnect GitHub, Allow
 * access — and Dismiss, which dismisses the need itself, wherever else it shows.
 *
 * In the update cards' shell, with a kind badge. The body line stays one line whatever it says, so
 * starting a sign-in never changes the card's height (ux_rules rule 1); a refusal goes on its own
 * line under the buttons (rule 6). A card the user acted on stays (`InboxView` retains it) and
 * says what it settled as: connected (only once this card has seen its need, so a stale status
 * never reads as resolved), reachable, or dismissed.
 */
export function GithubNeedCard({
  item,
  onActed
}: {
  item: GithubNeedInboxItem
  onActed: (item: GithubNeedInboxItem) => void
}): React.JSX.Element {
  const type = useCatalogType()
  const openAgentPage = useOpenAgentPage()
  const { data: status } = useGithubStatus()
  const signIn = useGithubSignIn(status)
  const allow = useGithubAllowAccess()
  const [dismissed, setDismissed] = useState(false)
  const [dismissing, setDismissing] = useState(false)
  const [dismissError, setDismissError] = useState<string | null>(null)
  const { need } = item
  const install = need.kind === 'install'
  const repos = githubNeedRepos(need)
  useGithubCheckOnFocus(install)
  const subject = GITHUB_INBOX_TEXT.subject(item)
  // Resolved only after this card saw its need in main's status: a status read from before the
  // need was recorded (the cache can trail the Inbox's read) must not read as "connected".
  const present = !!status?.needs.some((n) => n.key === need.key)
  const [seen, setSeen] = useState(false)
  useEffect(() => { if (present) setSeen(true) }, [present])
  const resolved = seen && !present && !!status && status.account?.state === 'connected' && !status.dismissed.includes(need.key)
  const { phase } = signIn
  const starting = phase.kind === 'starting'

  const act = (fn: () => void): void => { onActed(item); fn() }
  const dismiss = (): void => act(() => {
    if (dismissing) return
    setDismissError(null)
    setDismissing(true)
    void window.api.github.dismiss(need.key)
      .then((result) => { if (result.ok) setDismissed(true); else setDismissError(GITHUB_INBOX_TEXT.dismissFailed) })
      .catch((error) => setDismissError(unwrapIpcError(error, GITHUB_INBOX_TEXT.dismissFailed)))
      .finally(() => setDismissing(false))
  })

  const label = need.kind === 'reconnect' ? GITHUB_INBOX_TEXT.reconnect : GITHUB_INBOX_TEXT.signIn
  const startButton = (text: string, Icon: typeof LogIn): React.JSX.Element => (
    <button type="button" className={PRIMARY} aria-disabled={starting || undefined} aria-busy={starting}
      onClick={() => { if (!starting) act(signIn.start) }}>
      {starting ? <Loader2 size={11} className="animate-spin" aria-hidden="true" /> : <Icon size={11} aria-hidden="true" />}
      {starting ? GITHUB_INBOX_TEXT.starting : text}
    </button>
  )
  const pending = !install && phase.kind === 'pending'
  const bodyText = install ? GITHUB_INBOX_TEXT.install(repos)
    : pending ? `Enter code ${phase.userCode} on GitHub. Only enter a code Cinna shows you.`
    : GITHUB_INBOX_TEXT.account
  // Under the buttons: what went wrong (an alert), or how the last code ended.
  const failure = dismissError ?? (install ? allow.allowError(need.key) : phase.kind === 'error' ? phase.error : null)
  const note = install ? null : phase.kind === 'expired' ? GITHUB_INBOX_TEXT.expired : phase.kind === 'denied' ? GITHUB_INBOX_TEXT.denied : null
  const settled = dismissed ? GITHUB_INBOX_TEXT.dismissed
    : resolved ? (install ? GITHUB_INBOX_TEXT.reachable(repos) : GITHUB_INBOX_TEXT.connected(item.agents.length > 1))
    : null

  return (
    <article
      aria-label={subject}
      className="rounded-lg border border-[var(--color-border)] bg-[var(--color-bg-secondary)]/40 px-3 py-2.5"
    >
      <div className="flex min-w-0 items-start gap-2">
        <div className="min-w-0 flex-1">
          <div className="truncate text-[13px] font-medium text-[var(--color-text)]" title={subject}>
            {GITHUB_INBOX_TEXT.lead(need.kind)}{' '}
            {item.agents.length === 0 ? 'an agent' : item.agents.slice(0, item.agents.length === 2 ? 2 : 1).map((agent, i) => (
              <Fragment key={agent.id}>
                {i > 0 && ' and '}
                <button type="button" onClick={() => openAgentPage({ id: agent.id })} title={`Open ${agent.name}`} className={LINK}>
                  {agent.name}
                </button>
              </Fragment>
            ))}
            {item.agents.length > 2 && ` and ${item.agents.length - 1} other agents`}
          </div>
          <p className="mt-0.5 truncate text-[11px] text-[var(--color-text-secondary)]" title={bodyText}>
            {pending
              ? <GithubCodeSentence code={phase.userCode} copyButton={<CopyCodeButton code={phase.userCode} className={COPY} size={11} />} />
              : bodyText}
          </p>
        </div>
        <span className={`inline-flex shrink-0 items-center rounded bg-[var(--color-bg-tertiary)] px-1.5 py-px ${type.meta} font-medium text-[var(--color-text-secondary)]`}>
          {GITHUB_INBOX_TEXT.badge}
        </span>
      </div>
      {settled ? (
        <p role="status" className="mt-2 text-[11px] text-[var(--color-text-secondary)]">{settled}</p>
      ) : (
        <div className="mt-2 flex items-center gap-2">
          {install ? (
            <button type="button" className={PRIMARY} title={`Allow access to ${repos}`}
              onClick={() => act(() => allow.allowAccess(need.key))}>
              <ExternalLink size={11} aria-hidden="true" />{GITHUB_INBOX_TEXT.allowAccess}
            </button>
          ) : pending ? (
            <>
              <span className="inline-flex items-center gap-1.5 text-[11px] text-[var(--color-text-muted)]">
                <Loader2 size={11} className="animate-spin" aria-hidden="true" />{GITHUB_INBOX_TEXT.waiting}
              </span>
              <button type="button" className={SECONDARY} onClick={signIn.cancel}>
                <X size={11} aria-hidden="true" />{GITHUB_INBOX_TEXT.cancel}
              </button>
            </>
          ) : phase.kind === 'expired' ? startButton(GITHUB_INBOX_TEXT.newCode, RefreshCw) : startButton(label, LogIn)}
          {!pending && (
            <button type="button" className={SECONDARY} aria-disabled={dismissing || undefined} aria-busy={dismissing} onClick={dismiss}>
              {GITHUB_INBOX_TEXT.dismiss}
            </button>
          )}
        </div>
      )}
      {!settled && note && <p className="mt-1.5 text-[11px] text-[var(--color-text-secondary)]">{note}</p>}
      {!settled && failure && <p role="alert" className="mt-1.5 text-[11px] text-[var(--color-danger)]">{failure}</p>}
    </article>
  )
}
