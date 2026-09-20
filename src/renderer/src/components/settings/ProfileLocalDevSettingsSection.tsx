import { useState } from 'react'
import { AlertTriangle, FolderOpen, FolderSync, Loader2, RefreshCw } from 'lucide-react'
import { useLocalDev } from '../../hooks/useLocalDev'
import { useLocalDevStore } from '../../stores/localDev.store'
import { useAuthStore } from '../../stores/auth.store'
import type { LocalDevAttentionReason } from '../../../../shared/localDevState'
import { SettingsButton, SettingsInfoTip } from './SettingsLayout'
import { unwrapIpcError } from '../../utils/ipcError'

/**
 * Settings → Profile → Local Development.
 *
 * Shows every phase of the local-development state. The sidebar
 * button speaks up for two of them and onboarding asks the consent question;
 * workspace setup and access failures belong to the active profile, while
 * consent is remembered for its server.
 *
 * It renders state, never derives it: main owns the reconciler, so every button
 * is a call that comes back as the next state rather than a local optimistic
 * flip. The one thing read from elsewhere is the active profile's host, and
 * only because `ready` does not carry one.
 */
export function ProfileLocalDevSettingsSection(): React.JSX.Element {
  const state = useLocalDev()
  const consent = useLocalDevStore((s) => s.consent)
  const resetConsent = useLocalDevStore((s) => s.resetConsent)
  const repair = useLocalDevStore((s) => s.repair)
  const reconnectWorkspace = useLocalDevStore((s) => s.reconnectWorkspace)
  const openWorkspace = useLocalDevStore((s) => s.openWorkspace)
  const cinnaServerUrl = useAuthStore((s) => s.currentUser?.cinnaServerUrl)

  const [busy, setBusy] = useState(false)
  /**
   * Rendered only when it exists, below the buttons and last in the card (§1).
   *
   * The service answers ordinary failures with a state, so this is for the ones
   * that cannot: a channel refused before it reached the service, a profile
   * deactivated mid-click. Without it `run()` swallowed them — the spinner
   * stopped, the card did not change, and the user pressed the button again.
   */
  const [error, setError] = useState<string | null>(null)

  /**
   * `consent` and `declined` name their host; `ready` does not, so it falls
   * back to the profile's. When neither has one there is no host to reset and
   * the control is simply left out — better than resetting a guess.
   */
  const host =
    state.phase === 'consent' || state.phase === 'declined'
      ? state.host
      : state.phase === 'ready'
        ? hostOf(cinnaServerUrl)
        : null

  const run = async (fn: () => Promise<unknown>): Promise<void> => {
    setBusy(true)
    setError(null)
    try {
      await fn()
    } catch (err) {
      setError(unwrapIpcError(err, 'Could not complete this step. Try again.'))
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="space-y-6">
      <section>
        {/* The tab's standing explanation lives behind the (?) on its first
            title (ux_rules rule 12). It used to be a card of its own, which left
            a card with no control and no status once the paragraph moved. */}
        <SectionTitle
          info={
            <SettingsInfoTip label="About local development">
              <p>
                Cinna installs uv, cinna-cli and Mutagen into its own data folder, and asks
                cinna-cli to prepare an account workspace under your Agents Home. That is what lets
                agent work happen on this machine without setting a terminal up yourself. Nothing is
                installed system-wide and nothing is changed outside those two folders.
              </p>
            </SettingsInfoTip>
          }
        >
          Status
        </SectionTitle>
        <Card>
          <div className="space-y-3">
            {state.phase === 'idle' && (
              <Line>
                Nothing has been checked yet. Local development applies to Cinna accounts — sign in
                to one and Cinna checks what that server offers.
              </Line>
            )}

            {state.phase === 'unsupported' && state.reason === 'server' && (
              <Line>This Cinna server does not offer local development.</Line>
            )}

            {state.phase === 'unsupported' && state.reason === 'role' && (
              <Line>
                This Cinna server restricts local development setup to accounts with the
                agent-developer or admin role, and this account has neither. Ask an admin of your
                server to grant you one. There is nothing to retry from here until they do.
              </Line>
            )}

            {state.phase === 'consent' && (
              <>
                <Line>
                  Local development is available for{' '}
                  <span className="font-mono text-[var(--color-text)]">{state.host}</span>. Nothing
                  has been downloaded or written yet.
                </Line>
                <Actions>
                  <PrimaryButton onClick={() => run(repair)} busy={busy}>
                    Set up
                  </PrimaryButton>
                  <SettingsButton
                    onClick={() => run(() => consent(state.host, false))}
                    disabled={busy}
                  >
                    Not now
                  </SettingsButton>
                </Actions>
              </>
            )}

            {state.phase === 'declined' && (
              <>
                <Line>
                  You chose not to set this up for{' '}
                  <span className="font-mono text-[var(--color-text)]">{state.host}</span>. You can
                  set it up whenever you like.
                </Line>
                <Actions>
                  <PrimaryButton onClick={() => run(repair)} busy={busy}>
                    Set up
                  </PrimaryButton>
                </Actions>
              </>
            )}

            {state.phase === 'installing' && (
              <>
                <div className="flex items-center gap-2 text-[13px] text-[var(--color-text-secondary)]">
                  <Loader2
                    size={14}
                    className="animate-spin shrink-0 text-[var(--color-text-muted)]"
                  />
                  <span className="min-w-0 break-words">{state.step}</span>
                </div>
                {typeof state.percent === 'number' && (
                  <div
                    role="progressbar"
                    aria-label="Local development setup progress"
                    aria-valuemin={0}
                    aria-valuemax={100}
                    aria-valuenow={clampPercent(state.percent)}
                    className="h-1 w-full overflow-hidden rounded-full bg-[var(--color-bg-tertiary)]"
                  >
                    <div
                      className="h-full rounded-full bg-[var(--color-accent)] transition-[width]"
                      style={{ width: `${clampPercent(state.percent)}%` }}
                    />
                  </div>
                )}
              </>
            )}

            {state.phase === 'ready' && (
              <>
                <Line>Ready. Agent work can run on this machine.</Line>
                <Field label="Account workspace" value={state.workspacePath} />
                {state.protocol === 'legacy' && (
                  // Not a warning banner: everything works. It is the one
                  // consequence a user would otherwise meet as a surprise —
                  // an expired token that needs Repair instead of fixing
                  // itself — said once, where the version is shown.
                  <Line>
                    Your server pins a cinna-cli older than the machine-readable protocol, so
                    progress is reported as a single step and an expired account token cannot be
                    refreshed on its own — Repair sets the workspace up again when that happens.
                  </Line>
                )}
                <Actions>
                  <PrimaryButton onClick={() => run(openWorkspace)} busy={busy}>
                    <FolderOpen size={13} /> Open folder
                  </PrimaryButton>
                  <SettingsButton onClick={() => run(repair)} disabled={busy}>
                    <RefreshCw size={13} /> Repair
                  </SettingsButton>
                </Actions>
              </>
            )}

            {state.phase === 'attention' && (
              <>
                <div className="flex items-start gap-2">
                  <AlertTriangle
                    size={14}
                    className="mt-0.5 shrink-0 text-[var(--color-severity-warning)]"
                  />
                  <div className="min-w-0 space-y-1.5">
                    <div className="text-[13px] text-[var(--color-text)] break-words">
                      {state.detail}
                    </div>
                    <Line>{attentionHint(state.reason)}</Line>
                  </div>
                </div>
                <Actions>
                  {/* Reconnect leads for the one reason Repair cannot fix, and
                      Repair stays beside it rather than disappearing — it is
                      still the right button for everything else on this row. */}
                  {state.reason === 'account_mismatch' && (
                    <PrimaryButton onClick={() => run(reconnectWorkspace)} busy={busy}>
                      <FolderSync size={13} /> Reconnect workspace
                    </PrimaryButton>
                  )}
                  {state.reason === 'account_mismatch' ? (
                    <SettingsButton onClick={() => run(repair)} disabled={busy}>
                      <RefreshCw size={13} /> Repair
                    </SettingsButton>
                  ) : (
                    <PrimaryButton onClick={() => run(repair)} busy={busy}>
                      <RefreshCw size={13} /> Repair
                    </PrimaryButton>
                  )}
                </Actions>
              </>
            )}
            {error && (
              <p role="alert" className="text-[13px] text-[var(--color-danger)] leading-relaxed">
                {error}
              </p>
            )}
          </div>
        </Card>
      </section>

      {host && (
        <section>
          <SectionTitle>Consent</SectionTitle>
          <Card>
            <div className="space-y-2">
              <p className="text-[13px] text-[var(--color-text-muted)] leading-relaxed">
                Cinna remembers this consent answer for the server{' '}
                <span className="font-mono text-[var(--color-text-secondary)]">{host}</span>.
                It applies to accounts on this server. Resetting it asks for consent again the
                next time an account on this server is checked.
              </p>
              <Actions>
                <SettingsButton onClick={() => run(() => resetConsent(host))} disabled={busy}>
                  Reset consent
                </SettingsButton>
              </Actions>
            </div>
          </Card>
        </section>
      )}
    </div>
  )
}

/**
 * What Repair will and will not do, per reason.
 *
 * Two of them earn real copy, and for the same reason: Repair cannot fix
 * either, and a user left pressing it would never find that out. `toolchain`'s
 * commonest cause is a desktop older than the versions the server pinned;
 * `account_mismatch` is a folder that belongs to someone else's account, which
 * is what Reconnect is for. Each stays one or two lines, like the rest: a hint
 * that runs five lines for one reason and two for every other is the card
 * changing shape according to how it broke (§12).
 */
function attentionHint(reason: LocalDevAttentionReason): string {
  switch (reason) {
    case 'toolchain':
      return 'A tool could not be installed or verified. This can also mean this copy of Cinna Desktop is older than the versions your server pinned — Repair will not fix that, but updating Cinna Desktop will.'
    case 'network':
      return 'The server could not be reached. Nothing is wrong with the setup; Repair tries again.'
    case 'token_expired':
      return 'The account token in the workspace is no longer valid. Repair mints a new one.'
    case 'workspace':
      return 'The account workspace could not be created or read. Repair tries again — but if the folder already belongs to a different Cinna account, move it aside first.'
    case 'account_mismatch':
      return 'The workspace folder belongs to a different Cinna account, which Repair cannot change. Reconnect sets this account up fresh.'
  }
}

function hostOf(url: string | undefined): string | null {
  if (!url) return null
  try {
    return new URL(url).host || null
  } catch {
    return null
  }
}

function clampPercent(percent: number): number {
  return Math.min(100, Math.max(0, Math.round(percent)))
}

function SectionTitle({
  children,
  info
}: {
  children: React.ReactNode
  info?: React.ReactNode
}): React.JSX.Element {
  return (
    <div className="mb-2 flex min-h-[26px] items-center gap-1.5">
      <h2 className="text-[14px] font-semibold text-[var(--color-text-muted)] uppercase tracking-wider">
        {children}
      </h2>
      {info}
    </div>
  )
}

function Card({ children }: { children: React.ReactNode }): React.JSX.Element {
  return (
    <div className="rounded-lg border border-[var(--color-border)] bg-[var(--color-bg)] p-4">
      {children}
    </div>
  )
}

function Line({ children }: { children: React.ReactNode }): React.JSX.Element {
  return <p className="text-[13px] text-[var(--color-text-muted)] leading-relaxed">{children}</p>
}

function Actions({ children }: { children: React.ReactNode }): React.JSX.Element {
  return <div className="flex flex-wrap items-center gap-2 pt-0.5">{children}</div>
}

function Field({ label, value }: { label: string; value: string }): React.JSX.Element {
  return (
    <div className="flex flex-wrap items-baseline gap-x-2 gap-y-0.5">
      <span className="text-[13px] text-[var(--color-text-muted)]">{label}</span>
      <span className="font-mono text-[12px] text-[var(--color-text-secondary)] break-all">
        {value}
      </span>
    </div>
  )
}

function PrimaryButton({
  children,
  onClick,
  busy
}: {
  children: React.ReactNode
  onClick?: () => void | Promise<void>
  busy?: boolean
}): React.JSX.Element {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={busy}
      className="inline-flex items-center gap-1.5 rounded-md bg-[var(--color-accent)] px-3 py-1.5 text-xs font-medium text-white hover:bg-[var(--color-accent-hover)] transition-colors disabled:opacity-50"
    >
      {children}
    </button>
  )
}
