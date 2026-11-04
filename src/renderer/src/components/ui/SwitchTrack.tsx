/**
 * The app's toggle switch visual (the Toggle Switch Pattern in
 * ui_guidelines_llm.md), in two sizes: `md` is the settings switch, `sm` the
 * same switch scaled to a menu row. Only the look lives here; the control
 * around it (a `role="switch"` button, or a whole menu row) is the caller's.
 */
export type SwitchSize = 'md' | 'sm'

const TRACK: Record<SwitchSize, string> = {
  md: 'relative h-5 w-9 shrink-0 rounded-full transition-colors',
  sm: 'relative h-4 w-7 shrink-0 rounded-full transition-colors'
}

const THUMB: Record<SwitchSize, string> = {
  md: 'absolute top-0.5 h-4 w-4 rounded-full bg-white transition-transform',
  sm: 'absolute top-0.5 h-3 w-3 rounded-full bg-white transition-transform'
}

const THUMB_ON: Record<SwitchSize, string> = { md: 'left-[18px]', sm: 'left-[14px]' }

/** The track's classes: shape plus the on/off colour. */
export function switchTrackClass(checked: boolean, size: SwitchSize = 'md'): string {
  return `${TRACK[size]} ${checked ? 'bg-[var(--color-accent)]' : 'bg-[var(--color-border)]'}`
}

/** The thumb's classes: shape plus its on/off position. */
export function switchThumbClass(checked: boolean, size: SwitchSize = 'md'): string {
  return `${THUMB[size]} ${checked ? THUMB_ON[size] : 'left-0.5'}`
}

/** The switch as a decoration, for a row that is itself the control. */
export function SwitchTrack({ checked, size = 'md' }: { checked: boolean; size?: SwitchSize }): React.JSX.Element {
  return (
    <span aria-hidden="true" data-switch-track={checked ? 'on' : 'off'} className={switchTrackClass(checked, size)}>
      <span className={switchThumbClass(checked, size)} />
    </span>
  )
}
