/**
 * Controls in a preview modal's header (File Preview, Artifact Preview). All
 * are 26 px tall with `rounded-lg` corners — the agent chip under the composer
 * — so a labelled action, an icon button and a segmented toggle line up as one
 * row, and the header's controls read as the same family as the chips.
 */

/** A labelled action (Publish…, Run…, Contents). Add the colours. */
export const MODAL_HEADER_ACTION =
  'inline-flex h-[26px] items-center gap-1 px-2 rounded-lg text-xs font-medium border ' +
  'border-[var(--color-border)] disabled:opacity-50 transition-colors'

/** An icon-only button (Filter, Download, ⋯, Close), a 14 px icon. Add the colours. */
export const MODAL_HEADER_ICON =
  'inline-flex size-[26px] shrink-0 items-center justify-center rounded-lg transition-colors'

/** The bordered group of a segmented toggle (Tree / Table, Rendered / Source). */
export const MODAL_HEADER_SEGMENTS = 'inline-flex rounded-lg border border-[var(--color-border)]'

/** One segment: 24 px, so with the group's border it is 26 px. Add a width or padding and the colours. */
export const MODAL_HEADER_SEGMENT = 'inline-flex h-6 items-center justify-center rounded-[7px] transition-colors'
