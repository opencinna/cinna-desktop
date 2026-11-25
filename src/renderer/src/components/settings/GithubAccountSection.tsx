import { useRef, useState, type ReactNode } from 'react'
import { createPortal } from 'react-dom'
import { AlertTriangle, ExternalLink, Loader2, LogIn, LogOut, RefreshCw, X } from 'lucide-react'
import { SettingsButton, SettingsCard, SettingsSection, useDialogChrome } from './SettingsLayout'
import { CopyCodeButton, GithubCodeSentence } from '../chat/composerGithubNotices'
import { openGithubUrl, useGithubSignIn, useGithubSignOut, useGithubStatus, type GithubSignIn } from '../../hooks/useGithub'
import { unwrapIpcError } from '../../utils/ipcError'
import { CANCEL, DANGER, DIALOG_TEXT } from '../agents/local/sharing/ShareDialogs'
import type { GithubCoverage, GithubStatusDto } from '../../../../shared/github'

/** What the section says the sign-in is for, while there is none. */
export const GITHUB_PURPOSE = 'Lets this profile’s agents work on your GitHub repos.'

/** One installation as a line: "acme: all repositories", "evgeny-l: shop, site". */
export function coverageLine(install: GithubCoverage): string {
  if (install.selection === 'all') return `${install.owner}: all repositories`
  const prefix = `${install.owner.toLowerCase()}/`
  const names = install.repos.map((repo) => (repo.toLowerCase().startsWith(prefix) ? repo.slice(prefix.length) : repo))
  return `${install.owner}: ${names.length ? names.join(', ') : 'no repositories'}`
}

const COPY_CLASS = 'shrink-0 rounded-md p-1 text-[var(--color-text-secondary)] transition-colors hover:bg-[var(--color-bg-hover)] hover:text-[var(--color-text)]'

/**
 * The device flow in a card: the line (what it is for, the code, a refusal) and its one action,
 * then, only while GitHub waits for the browser, the wait and Cancel under it. The same phases as
 * the composer row, from the same profile-wide flow.
 */
function SignInCard({ signIn, idle, label }: { signIn: GithubSignIn; idle: ReactNode; label: string }): React.JSX.Element {
  const { phase } = signIn
  const starting = phase.kind === 'starting'
  const button = (text: string, Icon: typeof LogIn) => (
    <SettingsButton aria-disabled={starting || undefined} aria-busy={starting} onClick={signIn.start}>
      {starting ? <Loader2 size={13} className="animate-spin" aria-hidden="true" /> : <Icon size={13} aria-hidden="true" />}{text}
    </SettingsButton>
  )
  const line = phase.kind === 'pending'
    ? <GithubCodeSentence code={phase.userCode} copyButton={<CopyCodeButton code={phase.userCode} className={COPY_CLASS} size={13} />} />
    : phase.kind === 'expired' ? 'Code expired.'
    : phase.kind === 'denied' ? 'GitHub sign-in was declined.'
    : phase.kind === 'error' ? phase.error
    : idle
  const action = phase.kind === 'pending' ? null
    : phase.kind === 'expired' ? button('Get a new code', RefreshCw)
    : button(label, LogIn)
  return (
    <SettingsCard>
      <div className="flex items-center gap-3">
        <p className="min-w-0 flex-1 text-[13px] leading-relaxed text-[var(--color-text-secondary)]">{line}</p>
        {action}
      </div>
      {phase.kind === 'pending' && (
        <div className="mt-2 flex items-center gap-2 text-[13px] text-[var(--color-text-muted)]">
          <Loader2 size={13} className="animate-spin" aria-hidden="true" />
          <span className="min-w-0 flex-1">Waiting for you to approve in the browser…</span>
          <SettingsButton onClick={signIn.cancel}><X size={13} aria-hidden="true" />Cancel</SettingsButton>
        </div>
      )}
    </SettingsCard>
  )
}

/** A text action that opens a github.com page, in the accent colour so it reads as one (ux_rules rule 11). */
function GithubLink({ onClick, children }: { onClick: () => void; children: ReactNode }): React.JSX.Element {
  return <button type="button" onClick={onClick} className="text-[var(--color-accent)] hover:underline">{children}</button>
}

function SignOutDialog({ login, signOut, onCancel, onOpenApplications }: {
  login: string
  signOut: ReturnType<typeof useGithubSignOut>
  onCancel: () => void
  onOpenApplications: () => void
}): React.JSX.Element {
  const modalRef = useRef<HTMLDivElement>(null)
  const cancelRef = useRef<HTMLButtonElement>(null)
  useDialogChrome({ modalRef, initialFocusRef: cancelRef, pending: signOut.isPending, onDismiss: onCancel })
  const error = signOut.error ? unwrapIpcError(signOut.error, 'Couldn’t sign out of GitHub.') : null
  // The standard modal shell: the scrim a sibling of the glass panel, never its parent.
  return createPortal(
    <div className="fixed inset-0 z-50 flex items-start justify-center px-4 pt-[12vh]">
      <div aria-hidden className="app-modal-scrim absolute inset-0" />
      <div ref={modalRef} role="dialog" aria-modal="true" aria-labelledby="github-sign-out-title"
        className="app-modal-panel relative w-full max-w-md space-y-4 rounded-xl border p-5">
        <div id="github-sign-out-title" className="flex items-center gap-2 text-base font-semibold text-[var(--color-text)]">
          <AlertTriangle size={16} className="text-[var(--color-warning)]" aria-hidden="true" />
          Sign out of GitHub
        </div>
        <p className={DIALOG_TEXT}>
          Your repositories and anything already pushed stay as they are. This profile’s agents stop
          using <strong className="text-[var(--color-text)]">{login}</strong> on this computer, and
          their gh and git commands ask you to sign in again.
        </p>
        <p className={DIALOG_TEXT}>
          Cinna’s access is fully revoked only on GitHub, at{' '}
          <GithubLink onClick={onOpenApplications}>github.com/settings/applications</GithubLink>.
        </p>
        <div className="flex justify-end gap-2">
          <button ref={cancelRef} type="button" onClick={onCancel} disabled={signOut.isPending} className={CANCEL}>
            Cancel
          </button>
          <button type="button" onClick={() => signOut.mutate()} disabled={signOut.isPending} className={`${DANGER} min-w-[6.5rem]`}>
            {signOut.isPending ? 'Signing out…' : 'Sign out'}
          </button>
        </div>
        {error && <p role="alert" className="text-[13px] leading-relaxed text-[var(--color-danger)]">{error}</p>}
      </div>
    </div>,
    document.body
  )
}

function ConnectedCard({ account, onSignOut, onOpen }: {
  account: NonNullable<GithubStatusDto['account']>
  onSignOut: () => void
  onOpen: (target: 'manage' | 'applications') => void
}): React.JSX.Element {
  // Each line holds the control that changes it: the login with Sign out, the coverage with
  // Manage repository access. Lines truncate (whole text in the tooltip) rather than wrap at 800 px.
  return (
    <SettingsCard>
      <div className="flex items-center gap-3">
        <span title={account.login} className="min-w-0 flex-1 truncate text-[14px] font-medium text-[var(--color-text)]">{account.login}</span>
        <SettingsButton onClick={onSignOut}><LogOut size={13} aria-hidden="true" />Sign out</SettingsButton>
      </div>
      <div className="mt-3 flex items-start gap-3">
        <ul aria-label="Repositories Cinna can reach" className="min-w-0 flex-1 space-y-1 pt-1 text-[13px] text-[var(--color-text-secondary)]">
          {account.coverage.length === 0
            ? <li>No repositories yet</li>
            : account.coverage.map((install) => {
              const line = coverageLine(install)
              return <li key={install.installationId} title={line} className="truncate">{line}</li>
            })}
        </ul>
        <SettingsButton onClick={() => onOpen('manage')}><ExternalLink size={13} aria-hidden="true" />Manage repository access</SettingsButton>
      </div>
      <p className="mt-3 truncate text-[13px] text-[var(--color-text-muted)]">
        A full revoke is at <GithubLink onClick={() => onOpen('applications')}>github.com/settings/applications</GithubLink>.
      </p>
    </SettingsCard>
  )
}

/**
 * Settings → User Accounts → GitHub: the OpenCinna sign-in of the current profile. Signed out,
 * the purpose and Sign in to GitHub (the device flow, as on the composer row); connected, the
 * login with Sign out, then the repositories the app's installations cover with Manage
 * repository access, and where a full revoke is;
 * expired, Reconnect GitHub.
 */
export function GithubAccountSection(): React.JSX.Element {
  const { data: status, error: statusError } = useGithubStatus()
  const signIn = useGithubSignIn(status)
  const [confirming, setConfirming] = useState(false)
  const signOut = useGithubSignOut(() => setConfirming(false))
  const [openError, setOpenError] = useState<string | null>(null)
  const open = (target: 'manage' | 'applications'): void => {
    setOpenError(null)
    void openGithubUrl(target).then(setOpenError)
  }
  const account = status?.account ?? null
  let body: ReactNode
  if (!status) {
    body = statusError
      ? <SettingsCard><p className="text-[13px] text-[var(--color-danger)]">{unwrapIpcError(statusError, 'Couldn’t read the GitHub sign-in.')}</p></SettingsCard>
      : null
  } else if (account?.state === 'connected') {
    body = <ConnectedCard account={account} onSignOut={() => { signOut.reset(); setConfirming(true) }} onOpen={open} />
  } else if (account?.state === 'expired') {
    body = <SignInCard signIn={signIn} label="Reconnect GitHub"
      idle={<>Sign-in expired for <span className="font-mono text-[12px]">{account.login}</span>.</>} />
  } else {
    body = <SignInCard signIn={signIn} label="Sign in to GitHub" idle={GITHUB_PURPOSE} />
  }
  return (
    <SettingsSection title="GitHub">
      {body}
      {openError && <p role="alert" className="text-[13px] text-[var(--color-danger)]">{openError}</p>}
      {confirming && account && (
        <SignOutDialog login={account.login} signOut={signOut} onOpenApplications={() => open('applications')}
          onCancel={() => setConfirming(false)} />
      )}
    </SettingsSection>
  )
}
