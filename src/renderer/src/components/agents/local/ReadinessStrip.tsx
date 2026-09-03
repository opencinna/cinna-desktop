import { AlertTriangle, CheckCircle2, Info } from 'lucide-react'
import type { LocalAgentDto } from '../../../../../shared/localAgents'

type Severity = 'ok' | 'warning' | 'error' | 'info'

const TONE: Record<Severity, { wrap: string; icon: string }> = {
  ok: {
    wrap: 'border-[var(--color-severity-ok)]/40 bg-[var(--color-severity-ok)]/10',
    icon: 'text-[var(--color-severity-ok-text)]'
  },
  warning: {
    wrap: 'border-[var(--color-severity-warning)]/40 bg-[var(--color-severity-warning)]/10',
    icon: 'text-[var(--color-severity-warning-text)]'
  },
  error: {
    wrap: 'border-[var(--color-severity-error)]/40 bg-[var(--color-severity-error)]/10',
    icon: 'text-[var(--color-severity-error-text)]'
  },
  info: {
    wrap: 'border-[var(--color-severity-info)]/40 bg-[var(--color-severity-info)]/10',
    icon: 'text-[var(--color-severity-info-text)]'
  }
}

/** What the folder's readiness means, and what to do about it. */
function readinessMessage(agent: LocalAgentDto): { severity: Severity; text: string } {
  switch (agent.readiness) {
    case 'ok':
      return { severity: 'ok', text: 'This folder is valid and every credential it needs is set.' }
    case 'credentials_needed':
      return {
        severity: 'warning',
        text:
          agent.readinessReason ??
          'A credential this agent declares is not set in credentials/.env.'
      }
    case 'contract_too_new':
      return {
        severity: 'error',
        text:
          agent.readinessReason ??
          'This folder was built against a newer kit than this app understands. Update the app to edit it.'
      }
    default:
      return {
        severity: 'error',
        text: agent.readinessReason ?? 'This folder does not validate.'
      }
  }
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
}

/**
 * One line at the top of the agent page saying whether this folder can run, and
 * what to add if it cannot.
 *
 * The findings underneath are the validator's own — same codes, same messages
 * as `kit.py validate` — so the page agrees with whatever the user's assistant
 * sees in the terminal.
 */
export function ReadinessStrip({
  agent,
  drafting,
  draftNote,
  onStampIdentity,
  stamping,
  stampError
}: ReadinessStripProps): React.JSX.Element {
  const { severity, text } = readinessMessage(agent)
  const tone = TONE[severity]
  const Icon = severity === 'ok' ? CheckCircle2 : severity === 'info' ? Info : AlertTriangle
  const errors = agent.validation.errors
  const warnings = agent.validation.warnings

  return (
    <div className="space-y-1.5">
      <div className={`flex items-start gap-2 rounded-lg border px-3 py-2 ${tone.wrap}`}>
        <Icon size={13} className={`mt-px shrink-0 ${tone.icon}`} />
        <div className="min-w-0 flex-1 text-[11px] text-[var(--color-text-secondary)]">
          <div>{text}</div>
          {(errors.length > 0 || warnings.length > 0) && (
            <ul className="mt-1 space-y-0.5">
              {[...errors, ...warnings].slice(0, 6).map((finding, index) => (
                <li key={`${finding.code}:${index}`} className="text-[10px]">
                  <span className="font-mono text-[var(--color-text-muted)]">
                    {finding.path ?? finding.code}
                  </span>{' '}
                  {finding.message}
                </li>
              ))}
            </ul>
          )}
        </div>
      </div>

      {/*
        A legacy folder is a supported agent, not a broken one: the kit contract
        tolerates a manifest with no `id` on purpose, so this says what is
        actually at stake — the identity is the folder's place, so a rename or a
        move starts a different agent — rather than dressing it up as a failure.
        Stamping is offered, never performed: it writes to a file the user's
        assistant may have open.
      */}
      {agent.identity === 'legacy' && (
        <div className={`flex items-start gap-2 rounded-lg border px-3 py-2 ${TONE.info.wrap}`}>
          <Info size={13} className={`mt-px shrink-0 ${TONE.info.icon}`} />
          <div className="min-w-0 flex-1 text-[11px] text-[var(--color-text-secondary)]">
            <div>
              This agent predates the current kit: <code>cinna-agent.json</code> has no{' '}
              <code>id</code>, so it is identified by its folder name. It works as it is — but
              renaming the folder, or moving it to another agents folder, makes it a new agent and
              its chats stay behind.
            </div>
            {stampError && (
              <div className="mt-1 text-[var(--color-danger)]">{stampError}</div>
            )}
          </div>
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
          className={`flex items-center gap-2 rounded-lg border px-3 py-2 text-[11px] ${TONE.info.wrap}`}
        >
          <Info size={13} className={`shrink-0 ${TONE.info.icon}`} />
          <span className="text-[var(--color-text-secondary)]">
            Drafting the workflow prompt, example prompts and router trigger…
          </span>
        </div>
      )}

      {!drafting && draftNote && (
        <div
          className={`flex items-start gap-2 rounded-lg border px-3 py-2 text-[11px] ${TONE.info.wrap}`}
        >
          <Info size={13} className={`mt-px shrink-0 ${TONE.info.icon}`} />
          <span className="text-[var(--color-text-secondary)]">{draftNote}</span>
        </div>
      )}
    </div>
  )
}
