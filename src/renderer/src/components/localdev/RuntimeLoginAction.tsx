import { useState } from 'react'
import { KeyRound, Loader2 } from 'lucide-react'
import type { EngineLoginControl } from '../../hooks/useLocalTools'
import { DEVELOPMENT_RUNTIME_NAMES } from '../../../../shared/developmentSession'
import { loginFailureLead, loginPendingText, type EngineLoginId } from '../../../../shared/engine'

const buttonClass = 'inline-flex items-center justify-center gap-2 rounded-md bg-[var(--color-accent)] px-3 py-2 text-xs font-medium text-white hover:bg-[var(--color-accent-hover)] aria-disabled:opacity-60 transition-colors'
const secondaryClass = 'ambient-button inline-flex items-center justify-center gap-2 rounded-md border border-[var(--color-border)] px-3 py-2 text-xs font-medium text-[var(--color-text)] hover:bg-[var(--color-bg-hover)] transition-colors'

/**
 * The build page's in-app login, in three pieces around its `flex-wrap` action
 * row, all driven by **one** `useEngineLogin` the page owns:
 *
 * - {@link RuntimeLoginButton} sits in the row beside Install. Its label and
 *   its 13px icon slot are the same in every state — the spinner takes the
 *   key's place — so the row cannot re-wrap under the user's click.
 * - {@link RuntimeLoginCancel} is appended at the **end** of the row, after
 *   Check again: appearing and disappearing, it moves nothing before it.
 * - {@link RuntimeLoginStatus} renders **below** the row, outside it: what is
 *   happening while the login runs, and why it did not finish.
 *
 * The login is the vendor's own, run on the binary the build session uses —
 * usually Cinna's managed copy, not on PATH. When it ends the hook re-reads
 * this page's context, so the blocker clears on its own.
 */
export function RuntimeLoginButton({ tool, login }: { tool: EngineLoginId; login: EngineLoginControl }): React.JSX.Element {
  return <button type="button" className={buttonClass} aria-disabled={login.pending || undefined} aria-busy={login.pending}
    onClick={() => { if (!login.pending) login.start() }}>
    {login.pending ? <Loader2 size={13} className="animate-spin" /> : <KeyRound size={13} />}
    Log in to {DEVELOPMENT_RUNTIME_NAMES[tool]}
  </button>
}

/** Stops a running login. Last in the row, so its coming and going moves nothing. */
export function RuntimeLoginCancel({ login }: { login: EngineLoginControl }): React.JSX.Element | null {
  if (!login.pending) return null
  return <button type="button" className={secondaryClass} onClick={login.cancel}>Cancel</button>
}

/** Below the action row: the running login's phase, or why the last one did not finish. */
export function RuntimeLoginStatus({ tool, login }: { tool: EngineLoginId; login: EngineLoginControl }): React.JSX.Element | null {
  const lead = loginFailureLead(login.failure)
  if (login.pending) {
    return <p role="status" className="text-xs text-[var(--color-text-secondary)]">{loginPendingText(tool, login.phase)}</p>
  }
  if (!lead || !login.failure) return null
  const command = login.failure.command
  return <div role="alert" className="text-xs text-[var(--color-danger)]">
    <p>{lead}{command && ' You can also run this in a terminal:'}</p>
    {command && <LoginCommand key={command} command={command} />}
  </div>
}

function LoginCommand({ command }: { command: string }): React.JSX.Element {
  const [copied, setCopied] = useState<'yes' | 'failed' | null>(null)
  return <div className="mt-1 flex min-w-0 items-center gap-2">
    <code className="min-w-0 truncate font-mono text-[var(--color-text-secondary)]" title={command}>{command}</code>
    <button type="button" className={secondaryClass} onClick={() => {
      // Main's clipboard: `navigator.clipboard` rejects without document focus.
      void window.api.clipboard.writeText(command)
        .then((result) => setCopied(result.success ? 'yes' : 'failed'))
        .catch(() => setCopied('failed'))
    }}>{copied === 'yes' ? 'Copied' : copied === 'failed' ? 'Copy failed' : 'Copy'}</button>
  </div>
}
