import { useState } from 'react'
import { Check, Loader2, ShieldAlert, ShieldCheck, X } from 'lucide-react'
import {
  describeGrantScope,
  describePermissionAction,
  permissionGrantPatterns,
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
  onAnswer: (
    requestId: string,
    reply: 'once' | 'always' | 'reject'
    /**
     * Resolves with what the answer did. `remembered` is false when *Always
     * allow* could not be written to the agent folder — the action still went
     * ahead, but no rule was stored and this block must not say one was.
     */
  ) => Promise<{ remembered?: boolean } | void>
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
 * than a desktop vocabulary mapped onto it — with one deliberate exception.
 * **`always` stops in the main process:** the runner records the grant against
 * this agent's folder and replies `once`, because OpenCode's own saved grants
 * are user-global and would silently authorise every other folder agent. That
 * is why the button can say "for this agent" and mean it, and why the line
 * under the buttons names the pattern that will be remembered — a grant is
 * wider than the ask exactly once, when a URL becomes its origin, and that is
 * the case a user would not otherwise see coming.
 */
export function PermissionRequestBlock({
  request,
  requestId,
  interactive,
  decision,
  onAnswer
}: PermissionRequestBlockProps): React.JSX.Element {
  // **Which** answer is in flight, not merely that one is. Three buttons all
  // dimming together tells the user nothing about the decision they just made,
  // and this is the one widget in the app where that decision is a permission
  // (ux_rules §1: async state is inline, in the button).
  const [busy, setBusy] = useState<'once' | 'always' | 'reject' | null>(null)
  const [answered, setAnswered] = useState<{
    reply: 'once' | 'always' | 'reject'
    remembered?: boolean
  } | null>(null)
  const [error, setError] = useState<string | null>(null)

  const live = interactive && !!requestId && !answered
  // What *Always allow* would write, in the same words the main process will
  // store it in — derived from the shared helper rather than restated here, so
  // the promise on screen and the rule in `desktop.json` cannot drift apart.
  const grantPatterns = permissionGrantPatterns(request)
  const grantScope = describeGrantScope(request.action, grantPatterns)
  // **Only when the rule is wider than the ask.** For a path or a command the
  // pattern *is* the resource listed two rows above, so the line restated it in
  // prose with no delimiters — a sub-line that repeats what it sits under
  // (ux_rules §7). It survives for the two cases where the grant genuinely
  // covers more than what is on screen: a URL widened to its origin, and an ask
  // with no resources at all, which can only be remembered as the whole action.
  const scopeIsWider = grantPatterns.some((entry) => entry.scope !== 'exact')

  const answer = async (reply: 'once' | 'always' | 'reject'): Promise<void> => {
    if (!requestId || busy) return
    setBusy(reply)
    setError(null)
    try {
      const outcome = await onAnswer(requestId, reply)
      setAnswered({ reply, remembered: outcome?.remembered })
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setBusy(null)
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
            {/*
              The action as a phrase: `external_directory` and `webfetch` are
              the engine's names for these, and "asking to run
              external_directory" is not a question anyone can answer. An
              action this table has never seen still names itself.
            */}
            {live
              ? `The agent is asking to ${describePermissionAction(request.action)}`
              : `Permission to ${describePermissionAction(request.action)}`}
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
              {/*
                "Remembered" is claimed only where main says the rule was
                actually written. A store that refused the write still allows
                the action — the user said yes — so the honest line is that it
                was allowed once and will be asked again.
              */}
              {/*
                Full stops, because the same block re-rendered from history
                shows `decision` — the runner's own sentence — and the two
                spellings sat side by side across a reload of one conversation.
              */}
              {decision ??
                (answered?.reply === 'reject'
                  ? 'Denied.'
                  : answered?.reply === 'always'
                    ? answered.remembered
                      ? 'Allowed, and remembered for this agent.'
                      : 'Allowed once — the rule could not be saved.'
                    : 'Allowed once.')}
            </div>
          )}

          {error && <div className="mt-2 text-[12px] text-[var(--color-danger)]">{error}</div>}

          {live && (
            <div className="mt-2.5 flex flex-wrap items-center gap-2">
              <button
                type="button"
                disabled={busy !== null}
                onClick={() => void answer('once')}
                className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-medium
                  bg-[var(--color-accent)] hover:bg-[var(--color-accent-hover)] text-white
                  disabled:opacity-50 transition-colors"
              >
                {busy === 'once' ? (
                  <Loader2 size={13} className="animate-spin" />
                ) : (
                  <Check size={13} />
                )}
                {busy === 'once' ? 'Allowing…' : 'Allow once'}
              </button>
              {/*
                Offered for every ask, including one the engine calls unsavable.
                `request.savable` is OpenCode's `save[]` and it is deliberately
                not consulted: it describes what *its* store would keep — only
                ever `["*"]`, everything, for every agent on the machine — and
                this button does not write there. The grant is derived from the
                resources above and kept in this agent's folder.
              */}
              <button
                type="button"
                disabled={busy !== null}
                onClick={() => void answer('always')}
                className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-medium
                  border border-[var(--color-border)] hover:bg-[var(--color-bg-hover)]
                  text-[var(--color-text)] disabled:opacity-50 transition-colors"
              >
                {busy === 'always' ? (
                  <Loader2 size={13} className="animate-spin" />
                ) : (
                  <ShieldCheck size={13} />
                )}
                {busy === 'always' ? 'Remembering…' : 'Always allow'}
              </button>
              <button
                type="button"
                disabled={busy !== null}
                onClick={() => void answer('reject')}
                className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-medium
                  border border-[var(--color-border)] hover:bg-[var(--color-bg-hover)]
                  text-[var(--color-text-secondary)] disabled:opacity-50 transition-colors"
              >
                {busy === 'reject' ? (
                  <Loader2 size={13} className="animate-spin" />
                ) : (
                  <X size={13} />
                )}
                {busy === 'reject' ? 'Denying…' : 'Deny'}
              </button>
            </div>
          )}

          {/*
            Below the buttons, not above them: a line that sits over a control
            the user is about to click would move it as it renders (ux_rules
            §1). It is static for the life of the block — the pattern is a
            function of the ask, not of what has been clicked — so nothing here
            moves while the user decides.
          */}
          {live && scopeIsWider && (
            <div className="mt-2 text-[11px] text-[var(--color-text-muted)] break-all">
              Always allow remembers {grantScope} for this agent only.
            </div>
          )}
        </div>
      </div>
    </div>
  )
}
