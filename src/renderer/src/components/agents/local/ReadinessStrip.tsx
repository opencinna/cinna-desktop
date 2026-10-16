import { Info } from 'lucide-react'
import type { LocalAgentDto } from '../../../../../shared/localAgents'

const INFO = {
  wrap: 'border-[var(--color-severity-info)]/40 bg-[var(--color-severity-info)]/10',
  icon: 'text-[var(--color-severity-info-text)]'
}

interface ReadinessStripProps {
  agent: LocalAgentDto
  /** Shown alongside readiness while the one-shot AI draft is running. */
  drafting?: boolean
  /** A `skipped`/`failed` draft outcome, in the words main used. */
  draftNote?: string | null
  /** Write a fresh `id` into the manifest. Absent hides the affordance. */
  onStampIdentity?: () => void
  stamping?: boolean
  /** Why the last stamp attempt was refused, in main's words. */
  stampError?: string | null
  /** Where the full findings live now — the Folder tab. */
  onShowDetails?: () => void
}

/**
 * The lines at the top of the agent page that need attention — and nothing
 * when nothing does: a legacy identity, and the one-shot draft's progress or
 * outcome.
 *
 * The folder's readiness is not repeated here. The readiness dot beside the
 * name says it, the composer's notice panel says what is wrong with it (its
 * findings, missing credentials with Finish setup, the AI credential), and the
 * Folder tab lists the validator's own findings in full — same codes, same
 * messages as `kit.py validate`. A second line above the page restating the
 * first finding was the same warning twice.
 */
export function ReadinessStrip({
  agent,
  drafting,
  draftNote,
  onStampIdentity,
  stamping,
  stampError,
  onShowDetails
}: ReadinessStripProps): React.JSX.Element | null {
  const findings = agent.validation.errors.length + agent.validation.warnings.length
  const showLegacy = agent.identity === 'legacy'

  if (!showLegacy && !drafting && !draftNote) return null

  return (
    <div className="space-y-1.5">
      {/*
        A legacy folder is a supported agent, not a broken one: the kit contract
        tolerates a manifest with no `id` on purpose, so this says what is
        actually at stake — the identity is the folder's place, so a rename or a
        move starts a different agent — rather than dressing it up as a failure.
        Stamping is offered, never performed: it writes to a file the user's
        assistant may have open.
      */}
      {showLegacy && (
        <div className={`flex items-start gap-2 rounded-lg border px-3 py-2 ${INFO.wrap}`}>
          <Info size={13} className={`mt-px shrink-0 ${INFO.icon}`} />
          <div className="min-w-0 flex-1 text-[11px] text-[var(--color-text-secondary)]">
            <div>
              Legacy folder: <code>cinna-agent.json</code> has no <code>id</code>, so renaming
              or moving the folder starts a new agent and its chats stay behind.
            </div>
            {stampError && (
              <div className="mt-1 text-[var(--color-danger)]">{stampError}</div>
            )}
          </div>
          {findings > 0 && onShowDetails && (
            <button
              type="button"
              onClick={onShowDetails}
              className="shrink-0 self-center text-[10px] font-medium text-[var(--color-text)] underline-offset-2 hover:underline"
            >
              {findings} finding{findings === 1 ? '' : 's'}
            </button>
          )}
          {onStampIdentity && (
            <button
              type="button"
              onClick={onStampIdentity}
              disabled={stamping}
              title="Write a fresh id into cinna-agent.json"
              className="shrink-0 rounded-md bg-[var(--color-bg-tertiary)] px-2 py-1 text-[10px] font-medium
                text-[var(--color-text)] hover:bg-[var(--color-bg-hover)] transition-colors
                disabled:cursor-not-allowed disabled:opacity-40"
            >
              {stamping ? 'Stamping…' : 'Stamp identity'}
            </button>
          )}
        </div>
      )}

      {drafting && (
        <div
          className={`flex items-center gap-2 rounded-lg border px-3 py-2 text-[11px] ${INFO.wrap}`}
        >
          <Info size={13} className={`shrink-0 ${INFO.icon}`} />
          <span className="text-[var(--color-text-secondary)]">
            Drafting the workflow prompt, example prompts and router trigger…
          </span>
        </div>
      )}

      {!drafting && draftNote && (
        <div
          className={`flex items-start gap-2 rounded-lg border px-3 py-2 text-[11px] ${INFO.wrap}`}
        >
          <Info size={13} className={`mt-px shrink-0 ${INFO.icon}`} />
          <span className="text-[var(--color-text-secondary)]">{draftNote}</span>
        </div>
      )}
    </div>
  )
}
