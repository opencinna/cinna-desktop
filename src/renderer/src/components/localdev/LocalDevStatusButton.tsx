import { Loader2, TerminalSquare } from 'lucide-react'
import { useLocalDevStore } from '../../stores/localDev.store'
import { useLocalDev } from '../../hooks/useLocalDev'

const ICON_SIZE = 14

/**
 * The sidebar footer's local-development indicator.
 *
 * It renders **nothing** in every state the user has no reason to think about:
 * before anything has been checked, on a server that does not offer local
 * development, for an account without the role, and — crucially — when
 * everything is ready. A permanent tick for "the thing you never asked about is
 * fine" is footer noise; the footer's job is to say when something wants
 * attention.
 *
 * So there are exactly two visible states: working, and needs you. Consent is
 * not one of them — that question is asked properly, in onboarding or in a
 * modal, not by a glyph the user has to discover.
 */
export function LocalDevStatusButton(): React.JSX.Element | null {
  const state = useLocalDev()
  const repair = useLocalDevStore((s) => s.repair)

  if (state.phase === 'installing') {
    return (
      <div
        title={`Setting up local development — ${state.step}`}
        aria-label="Setting up local development"
        className="p-1.5 rounded-md text-[var(--color-text-muted)]"
      >
        <Loader2 size={ICON_SIZE} className="animate-spin" />
      </div>
    )
  }

  if (state.phase === 'attention') {
    return (
      <button
        type="button"
        onClick={() => void repair()}
        title={`Local development needs attention — ${state.detail}`}
        aria-label="Local development needs attention"
        className="relative p-1.5 rounded-md text-[var(--color-text)] hover:bg-[var(--color-bg-hover)] transition-colors"
      >
        <TerminalSquare size={ICON_SIZE} />
        <span className="absolute top-0.5 right-0.5 w-1.5 h-1.5 rounded-full bg-[var(--color-warning)]" />
      </button>
    )
  }

  return null
}
