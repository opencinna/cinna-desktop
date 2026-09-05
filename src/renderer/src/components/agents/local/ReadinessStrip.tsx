import { AlertTriangle, Info } from 'lucide-react'
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
      return { severity: 'ok', text: 'This folder is valid.' }
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
  /** Where the full findings live now — the Folder tab. */
  onShowDetails?: () => void
}

/**
 * The lines at the top of the agent page that need attention — and nothing
 * when nothing does.
 *
 * A folder that is `ok` renders no strip at all: the readiness dot beside the
 * name already says so, and a green banner on every page taught users to skip
 * the banner. What does appear is short and points at the Folder tab, where
 * the validator's own findings — same codes, same messages as
 * `kit.py validate` — are listed in full, so the page agrees with whatever the
 * user's assistant sees in the terminal.
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
  const { severity, text } = readinessMessage(agent)
  const tone = TONE[severity]
  const Icon = severity === 'info' ? Info : AlertTriangle
  const findings = agent.validation.errors.length + agent.validation.warnings.length
  const showLegacy = agent.identity === 'legacy'
  // The validator requires `id` unconditionally, so every legacy folder is
  // `invalid` with "`id` is required." as its reason — which the legacy banner
  // below already says, with the button that fixes it. Two banners about one
  // missing field is one too many; the readiness line is kept only when
  // something *else* is wrong with the folder.
  const onlyIdMissing =
    showLegacy && agent.validation.errors.every((finding) => finding.code.startsWith('manifest.id.'))
  const showReadiness = agent.readiness !== 'ok' && !onlyIdMissing

  if (!showReadiness && !showLegacy && !drafting && !draftNote) return null

  return (
    <div className="space-y-1.5">
      {showReadiness && (
        <div className={`flex items-start gap-2 rounded-lg border px-3 py-2 ${tone.wrap}`}>
          <Icon size={13} className={`mt-px shrink-0 ${tone.icon}`} />
          <div className="min-w-0 flex-1 text-[11px] text-[var(--color-text-secondary)]">
            {text}
          </div>
          {findings > 0 && onShowDetails && (
            <button
              type="button"
              onClick={onShowDetails}
              className="shrink-0 text-[10px] font-medium text-[var(--color-text)] underline-offset-2 hover:underline"
            >
              {findings} finding{findings === 1 ? '' : 's'}
            </button>
          )}
        </div>
      )}

      {/*
        A legacy folder is a supported agent, not a broken one: the kit contract
        tolerates a manifest with no `id` on purpose, so this says what is
        actually at stake — the identity is the folder's place, so a rename or a
        move starts a different agent — rather than dressing it up as a failure.
        Stamping is offered, never performed: it writes to a file the user's
        assistant may have open.
      */}
      {showLegacy && (
        <div className={`flex items-start gap-2 rounded-lg border px-3 py-2 ${TONE.info.wrap}`}>
          <Info size={13} className={`mt-px shrink-0 ${TONE.info.icon}`} />
          <div className="min-w-0 flex-1 text-[11px] text-[var(--color-text-secondary)]">
            <div>
              Legacy folder: <code>cinna-agent.json</code> has no <code>id</code>, so renaming
              or moving the folder starts a new agent and its chats stay behind.
            </div>
            {stampError && (
              <div className="mt-1 text-[var(--color-danger)]">{stampError}</div>
            )}
          </div>
          {!showReadiness && findings > 0 && onShowDetails && (
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
