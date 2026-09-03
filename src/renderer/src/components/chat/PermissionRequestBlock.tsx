import { useState } from 'react'
import { Check, ShieldAlert, ShieldCheck, X } from 'lucide-react'
import {
  ALWAYS_GRANTS_ENABLED,
  type LocalPermissionRequest
} from '../../../../shared/localAgentRequests'

interface PermissionRequestBlockProps {
  request: LocalPermissionRequest
  /**
   * The engine's request id (`per_*`), which is also the address the answer is
   * posted to. Absent for a historical block re-rendered from a persisted
   * message, which is read-only.
   */
  requestId?: string
  /** True while the engine is still parked on this request. */
  interactive: boolean
  /**
   * What the transcript records was decided, when this block is replayed from
   * history. Comes from the paired `tool_result` the runner emits on settle.
   */
  decision?: string
  onAnswer: (requestId: string, reply: 'once' | 'always' | 'reject') => Promise<void>
}

/**
 * An agent asking to do something its permission profile does not already
 * allow, rendered inline in the transcript.
 *
 * The sibling of {@link AskUserQuestionBlock}, and deliberately built the same
 * way: a `tool`-kind part with a reserved tool name, matched in `MessageStream`
 * and rendered as a widget. No new stream-part kind exists for either.
 *
 * The three buttons are OpenCode's own `once | always | reject` enum rather
 * than a desktop vocabulary mapped onto it, so nothing is translated at the
 * boundary — Allow once / Always / Deny is what the design asked for and what
 * the engine already accepts.
 */
export function PermissionRequestBlock({
  request,
  requestId,
  interactive,
  decision,
  onAnswer
}: PermissionRequestBlockProps): React.JSX.Element {
  const [busy, setBusy] = useState(false)
  const [answered, setAnswered] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)

  const live = interactive && !!requestId && !answered

  const answer = async (reply: 'once' | 'always' | 'reject'): Promise<void> => {
    if (!requestId || busy) return
    setBusy(true)
    setError(null)
    try {
      await onAnswer(requestId, reply)
      setAnswered(reply)
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setBusy(false)
    }
  }

  return (
    <div
      className={
        'rounded-lg border px-3.5 py-3 ' +
        (live
          ? 'border-[var(--color-warning)]/50 bg-[var(--color-warning)]/8'
          : 'border-[var(--color-border)] bg-[var(--color-bg-secondary)] opacity-90')
      }
    >
      <div className="flex items-start gap-2.5">
        {live ? (
          <ShieldAlert size={16} className="shrink-0 mt-0.5 text-[var(--color-warning)]" />
        ) : (
          <ShieldCheck size={16} className="shrink-0 mt-0.5 text-[var(--color-text-muted)]" />
        )}
        <div className="min-w-0 flex-1">
          <div className="text-[13px] font-medium text-[var(--color-text)]">
            {live
              ? `The agent is asking to run ${request.action}`
              : `Permission for ${request.action}`}
          </div>
          {request.resources.length > 0 && (
            <ul className="mt-1 space-y-0.5">
              {request.resources.map((resource, i) => (
                <li
                  key={i}
                  className="text-[12px] font-mono text-[var(--color-text-secondary)] break-all"
                >
                  {resource}
                </li>
              ))}
            </ul>
          )}

          {(answered || decision) && (
            <div className="mt-2 inline-flex items-center gap-1.5 text-[12px] text-[var(--color-text-muted)]">
              <Check size={12} />
              {decision ??
                (answered === 'reject'
                  ? 'Denied'
                  : answered === 'always'
                    ? 'Allowed, and remembered'
                    : 'Allowed once')}
            </div>
          )}

          {error && (
            <div className="mt-2 text-[12px] text-[var(--color-danger)]">{error}</div>
          )}

          {live && (
            <div className="mt-2.5 flex flex-wrap items-center gap-2">
              <button
                type="button"
                disabled={busy}
                onClick={() => void answer('once')}
                className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-medium
                  bg-[var(--color-accent)] hover:bg-[var(--color-accent-hover)] text-white
                  disabled:opacity-50 transition-colors"
              >
                <Check size={13} />
                Allow once
              </button>
              {/*
                `savable` is OpenCode's `save[]` — the patterns an "always"
                answer would actually persist. When it is empty the engine has
                nothing to save, so offering the button would show the user a
                decision that silently does not stick.
              */}
              {/*
                Gated on `ALWAYS_GRANTS_ENABLED`, which is `false` because the
                leak is **proven**, not suspected: one `always` reply writes a
                `{projectID: "global", resource: "*"}` row into a user-global
                store, and a different folder agent was then observed acting
                with no prompt at all. The engine also only ever offers `["*"]`
                as the savable pattern, so no wording on this button could
                describe honestly what it does. See the constant.
              */}
              {ALWAYS_GRANTS_ENABLED && request.savable.length > 0 && (
                <button
                  type="button"
                  disabled={busy}
                  onClick={() => void answer('always')}
                  className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-medium
                    border border-[var(--color-border)] hover:bg-[var(--color-bg-hover)]
                    text-[var(--color-text)] disabled:opacity-50 transition-colors"
                >
                  <ShieldCheck size={13} />
                  Always for this agent
                </button>
              )}
              <button
                type="button"
                disabled={busy}
                onClick={() => void answer('reject')}
                className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-medium
                  border border-[var(--color-border)] hover:bg-[var(--color-bg-hover)]
                  text-[var(--color-text-secondary)] disabled:opacity-50 transition-colors"
              >
                <X size={13} />
                Deny
              </button>
            </div>
          )}
        </div>
      </div>
    </div>
  )
}
