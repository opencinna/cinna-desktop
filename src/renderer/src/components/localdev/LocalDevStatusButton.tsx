import { Loader2, TerminalSquare } from 'lucide-react'
import { useLocalDev } from '../../hooks/useLocalDev'
import { useUIStore } from '../../stores/ui.store'
import { useLocalDevStore } from '../../stores/localDev.store'

const ICON_SIZE = 14

/** One click opens the build composer, or the setup steps that lead to it. */
export function LocalDevStatusButton(): React.JSX.Element | null {
  const state = useLocalDev()

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
        : 'Local development is ready — start building'

  const label =
    state.phase === 'installing'
      ? 'Setting up local development'
      : state.phase === 'attention'
        ? 'Local development needs attention'
        : 'Local development is ready — start building'

  return (
    <>
      <button
        type="button"
        onClick={() => { useLocalDevStore.getState().setPageMode('chat'); useUIStore.getState().setActiveView('local-development') }}
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
    </>
  )
}
