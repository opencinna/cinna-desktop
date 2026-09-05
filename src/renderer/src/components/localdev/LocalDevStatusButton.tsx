import { useState } from 'react'
import { Loader2, TerminalSquare } from 'lucide-react'
import { useLocalDev } from '../../hooks/useLocalDev'
import { LocalDevDetailModal } from './LocalDevDetailModal'

const ICON_SIZE = 14

/**
 * The sidebar footer's local-development indicator, and the way into
 * {@link LocalDevDetailModal}.
 *
 * It renders nothing in the states a user has no reason to think about: before
 * anything has been checked, on a server that does not offer local development,
 * for an account without the role, and while the consent question is pending —
 * that one is asked properly, in onboarding or a modal, not by a glyph someone
 * has to discover.
 *
 * It *is* rendered when ready, quietly and with no dot. That is a deliberate
 * change from "hide it once everything works": clicking it is the only way to
 * see which cinna-cli is installed and where the workspace went, and a control
 * that vanishes on success is a control nobody learns exists. The dot, not the
 * icon, is what distinguishes "fine" from "wants you".
 */
export function LocalDevStatusButton(): React.JSX.Element | null {
  const state = useLocalDev()
  const [open, setOpen] = useState(false)

  const visible =
    state.phase === 'installing' || state.phase === 'attention' || state.phase === 'ready'
  if (!visible) return null

  const title =
    state.phase === 'installing'
      ? state.percent === undefined
        ? `Setting up local development — ${state.step}`
        : `Setting up local development — ${state.step} (${Math.round(state.percent)}%)`
      : state.phase === 'attention'
        ? `Local development needs attention — ${state.detail}`
        : 'Local development is ready'

  const label =
    state.phase === 'installing'
      ? 'Setting up local development'
      : state.phase === 'attention'
        ? 'Local development needs attention'
        : 'Local development is ready'

  return (
    <>
      <button
        type="button"
        onClick={() => setOpen(true)}
        title={title}
        aria-label={label}
        className="relative p-1.5 rounded-md text-[var(--color-text-muted)] hover:text-[var(--color-text)] hover:bg-[var(--color-bg-hover)] transition-colors"
      >
        {state.phase === 'installing' ? (
          <Loader2 size={ICON_SIZE} className="animate-spin" />
        ) : (
          <TerminalSquare size={ICON_SIZE} />
        )}
        {state.phase === 'attention' && (
          <span className="absolute top-0.5 right-0.5 w-1.5 h-1.5 rounded-full bg-[var(--color-warning)]" />
        )}
      </button>
      {/* Repair stays reachable from the modal; the button itself only opens
          it, so a mis-click on a footer glyph can never start a reinstall. */}
      {open && <LocalDevDetailModal onClose={() => setOpen(false)} />}
    </>
  )
}
