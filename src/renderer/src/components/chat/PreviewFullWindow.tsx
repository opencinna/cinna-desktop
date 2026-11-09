import { Maximize2, Minimize2 } from 'lucide-react'
import { useCallback, useRef, type MouseEvent } from 'react'
import { useUIStore } from '../../stores/ui.store'
import { MODAL_HEADER_ICON } from '../ui/modalHeader'

/** How long after a toggle a press is taken for the second half of a double press. */
const TOGGLE_PRESS_GUARD_MS = 500

const TOGGLE_ATTR = 'data-full-window-toggle'

/**
 * A preview card filling the window. The app's drag strip runs under the top of
 * it, so the card carves itself out of the strip (its header takes the strip's
 * place, `.app-drag-strip`). With no surround left to frost, it is solid: the
 * glass would only blur the app's shapes behind the text.
 */
export const FULL_WINDOW_CARD_STYLE = {
  WebkitAppRegion: 'no-drag',
  backgroundColor: 'var(--color-bg)',
  backdropFilter: 'none',
  WebkitBackdropFilter: 'none'
} as React.CSSProperties

/**
 * Filling the window: one choice for every preview, the file preview and the
 * artifact preview alike, until the app restarts. `canFill` is false for a body
 * that is only a sentence, which has nothing to fill it with and offers no button.
 */
export function usePreviewFullWindow(canFill: boolean): {
  on: boolean
  toggle: () => void
  /** The card just changed size: a second press where the button was must not close the preview. */
  justToggled: () => boolean
  /** On the card: a double press must not land on whatever now sits where the button was. */
  onClickCapture: (event: MouseEvent) => void
} {
  const chosen = useUIStore((s) => s.previewFullWindow)
  const togglePreviewFullWindow = useUIStore((s) => s.togglePreviewFullWindow)
  const toggledAt = useRef(0)
  const toggle = useCallback(() => {
    toggledAt.current = Date.now()
    togglePreviewFullWindow()
  }, [togglePreviewFullWindow])
  const justToggled = useCallback(() => Date.now() - toggledAt.current < TOGGLE_PRESS_GUARD_MS, [])
  const onClickCapture = useCallback(
    (event: MouseEvent) => {
      // A keyboard press (`detail` 0) was aimed: only a pointer can land by accident.
      if (event.detail === 0 || !justToggled()) return
      if ((event.target as Element).closest?.(`[${TOGGLE_ATTR}]`)) return
      event.preventDefault()
      event.stopPropagation()
    },
    [justToggled]
  )
  return { on: chosen && canFill, toggle, justToggled, onClickCapture }
}

export function PreviewFullWindowButton({ on, onToggle }: { on: boolean; onToggle: () => void }): React.JSX.Element {
  return (
    <button
      type="button"
      {...{ [TOGGLE_ATTR]: '' }}
      onClick={onToggle}
      aria-pressed={on}
      aria-label="Fill the window"
      title={on ? 'Back to the smaller preview' : 'Fill the window'}
      className={
        MODAL_HEADER_ICON +
        ' ' +
        (on
          ? 'bg-[var(--color-accent)]/15 text-[var(--color-accent)]'
          : 'text-[var(--color-text-muted)] hover:bg-[var(--color-bg-hover)] hover:text-[var(--color-text)]')
      }
    >
      {on ? <Minimize2 size={14} /> : <Maximize2 size={14} />}
    </button>
  )
}
