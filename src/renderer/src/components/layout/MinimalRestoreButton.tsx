import { Maximize2 } from 'lucide-react'

/**
 * Minimal view's way back: a square frosted button in the chat area's
 * bottom-right corner, the size of a top-bar button. It fades in once the
 * composer's exit is done (`shown`) and out as everything returns; while
 * hidden it takes no clicks and no focus.
 */
export function MinimalRestoreButton({ shown, onRestore }: { shown: boolean; onRestore: () => void }): React.JSX.Element {
  return (
    <button
      type="button"
      data-testid="minimal-restore-button"
      data-shown={shown || undefined}
      inert={!shown || undefined}
      onClick={onRestore}
      title="Exit minimal view"
      aria-label="Exit minimal view"
      className="minimal-restore app-popover-surface absolute bottom-3 right-3 z-20 p-1.5 rounded-md border border-[var(--color-border)]
        shadow-sm text-[var(--color-text-muted)] hover:text-[var(--color-text)]"
    >
      <Maximize2 size={15} />
    </button>
  )
}
