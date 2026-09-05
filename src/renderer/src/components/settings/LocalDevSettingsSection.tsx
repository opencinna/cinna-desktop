import { useState } from 'react'
import {
  AlertTriangle,
  FolderOpen,
  Link2,
  Loader2,
  RefreshCw,
  TerminalSquare
} from 'lucide-react'
import { useLocalDev } from '../../hooks/useLocalDev'
import { useLocalDevStore } from '../../stores/localDev.store'
import { useAuthStore } from '../../stores/auth.store'
import type { LocalDevAttentionReason } from '../../../../shared/localDevState'

/**
 * Settings → Local Development.
 *
 * The only screen that shows every phase of {@link LocalDevState}. The sidebar
 * button speaks up for two of them and onboarding asks the consent question;
 * everything else — "why is there no Set up button", "where did it install to",
 * "how do I run `cinna` myself" — has to be answerable here or nowhere.
 *
 * It renders state, never derives it: main owns the reconciler, so every button
 * is a call that comes back as the next state rather than a local optimistic
 * flip. The one thing read from elsewhere is the active profile's host, and
 * only because `ready` does not carry one.
 */
export function LocalDevSettingsSection(): React.JSX.Element {
  const state = useLocalDev()
  const consent = useLocalDevStore((s) => s.consent)
  const resetConsent = useLocalDevStore((s) => s.resetConsent)
  const repair = useLocalDevStore((s) => s.repair)
  const openWorkspace = useLocalDevStore((s) => s.openWorkspace)
  const cinnaServerUrl = useAuthStore((s) => s.currentUser?.cinnaServerUrl)

  const [busy, setBusy] = useState(false)
  const [pathResult, setPathResult] = useState<{ ok: boolean; text: string } | null>(null)

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
    try {
      await fn()
    } finally {
      setBusy(false)
    }
  }

  const handleAddToPath = async (): Promise<void> => {
    setPathResult(null)
    setBusy(true)
    try {
      const result = await window.api.localDev.addToPath()
      setPathResult(
        result.ok
          ? {
              ok: true,
              text: result.path
                ? `Linked. cinna is now at ${result.path} — open a new terminal for it to be found.`
                : 'Linked. Open a new terminal for it to be found.'
            }
          : { ok: false, text: result.reason ?? 'The link could not be created.' }
      )
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="space-y-6">
      <section>
        <SectionTitle>Local development</SectionTitle>
        <Card>
          <div className="flex items-start gap-3">
            <div className="mt-0.5 text-[var(--color-accent)]">
              <TerminalSquare size={18} />
            </div>
            <div className="min-w-0 flex-1 space-y-1.5">
              <div className="text-[14px] font-medium text-[var(--color-text)]">
                Working on agents from this machine
              </div>
              <p className="text-[13px] text-[var(--color-text-muted)] leading-relaxed">
                Cinna installs uv, cinna-cli and Mutagen into its own data folder, and asks
                cinna-cli to prepare an account workspace under your Agents Home. That is what lets
                agent work happen on this machine without setting a terminal up yourself. Nothing is
                installed system-wide and nothing is changed outside those two folders.
              </p>
            </div>
          </div>
        </Card>
      </section>

      <section>
        <SectionTitle>Status</SectionTitle>
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
                  <SecondaryButton onClick={() => run(() => consent(state.host, false))} busy={busy}>
                    Not now
                  </SecondaryButton>
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
                <Field label="cinna-cli" value={state.cliVersion} />
                <Field label="Managed binary" value={state.cinnaBinPath} />
                <Actions>
                  <PrimaryButton onClick={() => run(openWorkspace)} busy={busy}>
                    <FolderOpen size={13} /> Open folder
                  </PrimaryButton>
                  <SecondaryButton onClick={() => run(repair)} busy={busy}>
                    <RefreshCw size={13} /> Repair
                  </SecondaryButton>
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
                  <PrimaryButton onClick={() => run(repair)} busy={busy}>
                    <RefreshCw size={13} /> Repair
                  </PrimaryButton>
                </Actions>
              </>
            )}
          </div>
        </Card>
      </section>

      {state.phase === 'ready' && (
        <section>
          <SectionTitle>Your terminal</SectionTitle>
          <Card>
            <div className="space-y-2">
              <div className="text-[14px] font-medium text-[var(--color-text)]">
                Add <span className="font-mono">cinna</span> to my PATH
              </div>
              <p className="text-[13px] text-[var(--color-text-muted)] leading-relaxed">
                Links the managed cinna-cli into <span className="font-mono">~/.local/bin</span> so
                you can run <span className="font-mono">cinna</span> in your own terminal. This is
                only for you — Cinna Desktop always uses its own copy and does not need the link.
              </p>
              <Actions>
                <SecondaryButton onClick={handleAddToPath} busy={busy}>
                  <Link2 size={13} /> Add to PATH
                </SecondaryButton>
              </Actions>
              {pathResult && (
                <div
                  className={`text-[13px] leading-relaxed break-words ${
                    pathResult.ok
                      ? 'text-[var(--color-text-secondary)]'
                      : 'text-[var(--color-danger)]'
                  }`}
                >
                  {pathResult.text}
                </div>
              )}
            </div>
          </Card>
        </section>
      )}

      {host && (
        <section>
          <SectionTitle>Consent</SectionTitle>
          <Card>
            <div className="space-y-2">
              <p className="text-[13px] text-[var(--color-text-muted)] leading-relaxed">
                Cinna remembers your answer for{' '}
                <span className="font-mono text-[var(--color-text-secondary)]">{host}</span>.
                Resetting it forgets that answer, so you are asked again the next time this account
                is checked.
              </p>
              <Actions>
                <SecondaryButton onClick={() => run(() => resetConsent(host))} busy={busy}>
                  Reset consent
                </SecondaryButton>
              </Actions>
            </div>
          </Card>
        </section>
      )}
    </div>
  )
}

/**
 * What Repair will and will not do, per reason. `toolchain` is the one that
 * earns real copy: it is the only reason whose commonest cause — a desktop
 * older than the versions the server pinned — Repair cannot fix, and a user
 * left pressing it would never find that out.
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
      return 'The account workspace could not be created or read. Repair rebuilds it.'
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

function SectionTitle({ children }: { children: React.ReactNode }): React.JSX.Element {
  return (
    <h2 className="text-[14px] font-semibold text-[var(--color-text-muted)] uppercase tracking-wider mb-2">
      {children}
    </h2>
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
  return (
    <p className="text-[13px] text-[var(--color-text-muted)] leading-relaxed">{children}</p>
  )
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
      className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-md text-[13px] font-medium bg-[var(--color-accent)] hover:bg-[var(--color-accent-hover)] text-[var(--color-on-accent)] transition-colors disabled:opacity-50"
    >
      {children}
    </button>
  )
}

function SecondaryButton({
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
      className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-md text-[13px] font-medium bg-[var(--color-bg-secondary)] hover:bg-[var(--color-bg-hover)] text-[var(--color-text)] border border-[var(--color-border)] transition-colors disabled:opacity-50"
    >
      {children}
    </button>
  )
}
