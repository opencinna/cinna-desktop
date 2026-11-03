import { useEffect } from 'react'
import { createPortal } from 'react-dom'
import { usePopover } from '../ui/usePopover'
import { useMarkGuidedBuildDone } from '../../hooks/useLocalAgents'
import { unwrapIpcError } from '../../utils/ipcError'
import {
  BUILD_BRIEF_CAPABILITY_HINTS,
  BUILD_BRIEF_CAPABILITY_IDS,
  BUILD_BRIEF_CAPABILITY_LABELS
} from '../../../../shared/buildBrief'

/** The starters: each fills the composer, its first `⟨…⟩` selected. Never sends. */
export const GUIDED_BUILD_STARTERS: readonly { label: string; text: string }[] = [
  {
    label: 'Help me with a job',
    text: 'You’ll help me with ⟨job⟩. You’ll work with ⟨Gmail / a folder / a website⟩, and I’ll add the access you need in Credentials.'
  },
  {
    label: 'Check something daily',
    text: 'Every ⟨weekday morning⟩, check ⟨where⟩ and tell me ⟨what⟩.'
  },
  {
    label: 'Work on files I send',
    text: 'When I send you ⟨a file / a link⟩, ⟨what to do with it⟩ and give me back ⟨what⟩.'
  },
  {
    label: 'Interview me',
    text: 'I’m not sure yet what you should do — interview me.'
  }
]

/** The invitation's heading, for the agent it sets up. */
export function guidedBuildHeading(name: string): string {
  return `Set up ${name}`
}

/** The invitation's one line under its heading. */
export const GUIDED_BUILD_LINE =
  'A blank agent. Say what job it should do — it asks a few questions, then builds itself with you.'

/** The composer's placeholder while the invitation shows. */
export function guidedBuildPlaceholder(name: string): string {
  return `Describe what ${name} should do for you…`
}

interface GuidedBuildInvitationProps {
  agentId: string
  agentName: string
  /** Why the starters are inert right now (the agent's prompts are being drafted), or null. */
  hold: string | null
  /** Put a starter in the composer. */
  onFill: (text: string) => void
  /**
   * False where the screen's own heading box says {@link guidedBuildHeading}
   * and {@link GUIDED_BUILD_LINE} (the main New chat screen): the invitation is
   * then only its starters and links, 52 px like the example-prompt row and
   * its margin, so picking the agent changes text instead of adding a block.
   */
  withHeading?: boolean
}

/**
 * The new-chat screen's invitation for one blank kit agent, in place of the
 * example prompts — those are tasks the agent cannot do yet, and a click on
 * one sends. The caller decides from the folder list, which a created agent
 * is written into before its page opens, and shows neither this nor the
 * prompts while that list cannot answer — never one and then the other (rule 1).
 *
 * Skip guidance is the only thing here that writes: it marks the agent's
 * guided build dismissed, and the agent then reads as built everywhere.
 */
export function GuidedBuildInvitation({ agentId, agentName, hold, onFill, withHeading = true }: GuidedBuildInvitationProps): React.JSX.Element {
  const skip = useMarkGuidedBuildDone()
  const popover = usePopover<HTMLButtonElement, HTMLDivElement>('below-left', { flipWhenNoRoom: true })
  useEffect(() => {
    if (!popover.open) return
    const onKey = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') popover.setOpen(false)
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [popover])

  const skipError = skip.error ? unwrapIpcError(skip.error, 'Could not skip the guidance.') : null

  return (
    <section
      aria-label={guidedBuildHeading(agentName)}
      className={`w-full max-w-3xl mx-auto px-4 text-center${withHeading ? ' mb-3' : ''}`}
    >
      {withHeading && <>
        <h2 className="text-sm font-semibold text-[var(--color-text)]">{guidedBuildHeading(agentName)}</h2>
        <p className="mt-1 text-xs text-[var(--color-text-secondary)]">{GUIDED_BUILD_LINE}</p>
      </>}
      <div
        className={`${withHeading ? 'mt-3 ' : ''}flex flex-wrap justify-center gap-2${hold ? ' cursor-not-allowed' : ''}`}
        title={hold ?? undefined}
        aria-disabled={hold ? true : undefined}
      >
        {GUIDED_BUILD_STARTERS.map((starter) => (
          <button
            key={starter.label}
            type="button"
            disabled={!!hold}
            onClick={() => onFill(starter.text)}
            className="h-7 rounded-full border border-[var(--color-accent)]/40 bg-[var(--color-accent)]/10 px-3
              text-xs text-[var(--color-accent)] transition-colors hover:border-[var(--color-accent)]/70
              hover:bg-[var(--color-accent)]/20 disabled:pointer-events-none disabled:opacity-50"
          >
            {starter.label}
          </button>
        ))}
      </div>
      {/* h-7 starters + mt-1 + h-5 links: 52 px, the prompt row's 40 + its 12 margin. */}
      <div className="mt-1 flex h-5 items-center justify-center gap-4 text-[11px]">
        <button
          ref={popover.triggerRef}
          type="button"
          aria-expanded={popover.open}
          onClick={() => popover.setOpen(!popover.open)}
          className="font-medium text-[var(--color-accent)] hover:text-[var(--color-accent-hover)]"
        >
          What can agents do?
        </button>
        <button
          type="button"
          disabled={skip.isPending}
          onClick={() => skip.mutate({ agentId })}
          className="font-medium text-[var(--color-accent)] hover:text-[var(--color-accent-hover)] disabled:opacity-50"
        >
          {skip.isPending ? 'Skipping…' : 'Skip guidance'}
        </button>
      </div>
      {skipError && (
        <p role="alert" className="mt-1 text-[11px] text-[var(--color-danger)]">{skipError}</p>
      )}
      {popover.open &&
        popover.style &&
        createPortal(
          <div
            ref={popover.popoverRef}
            role="dialog"
            aria-label="What can agents do?"
            style={popover.style}
            className="app-popover-surface z-50 w-[22rem] max-w-[calc(100vw-2rem)] rounded-lg border
              border-[var(--color-border)] p-3 text-left shadow-xl"
          >
            <ul className="space-y-1.5">
              {BUILD_BRIEF_CAPABILITY_IDS.map((id) => (
                <li key={id} className="text-xs leading-snug text-[var(--color-text-secondary)]">
                  <span className="font-medium text-[var(--color-text)]">{BUILD_BRIEF_CAPABILITY_LABELS[id]}</span>
                  {' — '}
                  {BUILD_BRIEF_CAPABILITY_HINTS[id]}
                </li>
              ))}
            </ul>
          </div>,
          document.body
        )}
    </section>
  )
}
