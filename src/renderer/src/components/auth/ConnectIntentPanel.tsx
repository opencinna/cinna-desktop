import { useState } from 'react'
import { Loader2, ShieldQuestion } from 'lucide-react'
import { useRegister, useLogin, useUsers, useCinnaOAuthAbort } from '../../hooks/useAuth'
import {
  prependSelfHostedHistory,
  readSelfHostedHistory,
  writeSelfHostedHistory
} from '../../constants/selfHostedHistory'
import type { ConnectIntent } from '../../../../shared/connectIntent'

const btnSecondaryClass =
  'px-4 py-2 text-sm rounded-md border border-[var(--color-border)] text-[var(--color-text-secondary)] hover:bg-[var(--color-bg-hover)] transition-colors disabled:opacity-50'

const btnPrimaryClass =
  'px-5 py-2 text-sm rounded-md bg-[var(--color-accent)] text-white hover:opacity-90 transition-opacity disabled:opacity-50'

/**
 * How the panel finished. The caller drops the intent either way; only the
 * onboarding screen cares about the difference, because a user who connected an
 * account is finished with first-run and a user who declined is not.
 */
export type ConnectIntentOutcome = 'connected' | 'switched' | 'declined'

export interface ConnectIntentPanelProps {
  intent: ConnectIntent
  onDone: (outcome: ConnectIntentOutcome) => void
}

/**
 * "Connect to **cinna.acme.com**?" — the one screen a `cinna://connect` link
 * is allowed to reach.
 *
 * This component is the security boundary of the deep link, not the URL
 * validation in main. Anything on the machine can fire a `cinna://` URL, so the
 * app must never authorize against a link-supplied host without a human reading
 * the host and saying yes. That is why the origin is rendered large and
 * unabbreviated, why there is no "remember this" affordance, and why declining
 * is a plain, always-available button rather than a corner ×.
 *
 * When a profile for that exact origin already exists the primary action
 * becomes **Switch to it**: re-running OAuth would work, but it sends the user
 * through the browser to arrive at an account they already have on this
 * machine. Switching is never automatic — the same link that could connect a
 * server it should not could also flip the user into a different profile
 * without them noticing.
 *
 * Shared by the onboarding screen's `cinna-confirm` step and the modal an
 * already-onboarded install shows, so the two cannot drift into offering
 * different guarantees.
 */
export function ConnectIntentPanel({
  intent,
  onDone
}: ConnectIntentPanelProps): React.JSX.Element {
  const [error, setError] = useState('')
  const [waiting, setWaiting] = useState(false)

  const register = useRegister()
  const login = useLogin()
  const abort = useCinnaOAuthAbort()
  const { data: users } = useUsers()

  // Matched on the normalized origin main produced, against the URL the profile
  // was created with. `registerCinna` stores the string it was handed, which is
  // this same origin for anything created through this panel; a profile added
  // by typing a URL with a trailing slash is compared without it.
  const host = safeHost(intent.serverUrl)
  const existing = users?.find(
    (u) =>
      u.type === 'cinna_user' &&
      typeof u.cinnaServerUrl === 'string' &&
      u.cinnaServerUrl.replace(/\/$/, '') === intent.serverUrl.replace(/\/$/, '')
  )

  const handleConnect = async (): Promise<void> => {
    setError('')
    setWaiting(true)
    const result = await register.mutateAsync({
      accountType: 'cinna',
      cinnaHostingType: 'self_hosted',
      cinnaServerUrl: intent.serverUrl
    })
    setWaiting(false)
    if (!result.success) {
      setError(result.error ?? 'Authentication failed')
      return
    }
    // Remember it the same way a typed URL is remembered, so the paste fallback
    // and the deep link build one history rather than two.
    writeSelfHostedHistory(prependSelfHostedHistory(readSelfHostedHistory(), intent.serverUrl))
    onDone('connected')
  }

  const handleSwitch = async (): Promise<void> => {
    if (!existing) return
    setError('')
    const result = await login.mutateAsync({ userId: existing.id })
    if (!result.success) {
      // The profile is password-locked. Sending the user to the ordinary
      // account switcher is better than growing a second password prompt here
      // that has to keep up with the first one.
      setError('That account needs its password. Switch to it from the account menu.')
      return
    }
    onDone('switched')
  }

  const handleCancelWaiting = (): void => {
    abort.mutate()
    setWaiting(false)
    setError('Authorization cancelled')
  }

  if (waiting) {
    return (
      <div className="space-y-4">
        <div className="flex flex-col items-center gap-3 py-6">
          <Loader2 size={28} className="text-[var(--color-accent)] animate-spin" />
          <div className="text-sm text-[var(--color-text-secondary)] text-center">
            Waiting for browser authorization…
          </div>
          <div className="text-xs text-[var(--color-text-muted)] text-center">
            Complete the sign-in in your browser to continue
          </div>
        </div>
        <button
          type="button"
          onClick={handleCancelWaiting}
          className={`w-full ${btnSecondaryClass}`}
        >
          Cancel
        </button>
      </div>
    )
  }

  return (
    <div className="space-y-4">
      <div className="flex flex-col items-center gap-2 text-center">
        <div className="inline-flex items-center justify-center w-12 h-12 rounded-2xl bg-[var(--color-accent)]/10">
          <ShieldQuestion size={24} className="text-[var(--color-accent)]" />
        </div>
        <div className="text-sm font-semibold text-[var(--color-text)]">
          {existing ? `Open ${host}?` : `Connect to ${host}?`}
        </div>
        <div className="text-[11px] text-[var(--color-text-muted)]">
          {existing
            ? 'You already have an account on this server on this device.'
            : 'A link asked Cinna to connect to this Cinna server. Only continue if you recognise it.'}
        </div>
      </div>

      <div className="rounded-md border border-[var(--color-border)] bg-[var(--color-bg-hover)] px-3 py-2">
        <div className="text-[11px] text-[var(--color-text-muted)]">Server</div>
        <div className="text-sm text-[var(--color-text)] break-all">{intent.serverUrl}</div>
      </div>

      {error && <div className="text-xs text-[var(--color-danger)] break-words">{error}</div>}

      <div className="flex justify-end gap-2 pt-1">
        <button
          type="button"
          onClick={() => onDone('declined')}
          className={btnSecondaryClass}
        >
          Not now
        </button>
        {existing ? (
          <button
            type="button"
            onClick={handleSwitch}
            disabled={login.isPending}
            className={btnPrimaryClass}
          >
            Switch to it
          </button>
        ) : (
          <button
            type="button"
            onClick={handleConnect}
            disabled={register.isPending}
            className={btnPrimaryClass}
          >
            Connect
          </button>
        )}
      </div>
    </div>
  )
}

/**
 * The host to put in the heading. Falls back to the whole origin: main already
 * guaranteed this parses, but a heading is not the place to throw if that ever
 * stops being true.
 */
function safeHost(origin: string): string {
  try {
    return new URL(origin).host
  } catch {
    return origin
  }
}
