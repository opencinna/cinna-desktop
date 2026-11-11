import { useId, useLayoutEffect, useRef, useState, type DragEvent, type MouseEvent } from 'react'
import { AlertTriangle, File, Pin } from 'lucide-react'
import type { AgentFileRef, PinnedAgentFile } from '../../../../shared/agentFiles'
import { pathRefLabel } from '../../../../shared/pathMentions'
import { useMovePinnedFile, usePinnedFiles } from '../../hooks/usePinnedFiles'
import { useFilePreviewStore } from '../../stores/filePreview.store'
import { useUIStore } from '../../stores/ui.store'
import { dropRank } from './chatGroups'
import { useFileRefContextMenu } from './MessageContextMenu'
import type { FileRefTarget } from './fileRefs'

/** The block's width beside the transcript, in px (set inline: the app's rem is 17 px, not 16). */
export const PINNED_FILES_CARD_WIDTH = 224
/** From the block's right edge to the chat area's, in px. */
export const PINNED_FILES_RIGHT_MARGIN = 20
/** Kept clear between the transcript column and the block's left edge. */
export const PINNED_FILES_COLUMN_GAP = 12
/** The room right of the transcript column the block needs, its margins included. */
export const PINNED_FILES_GUTTER_PX = PINNED_FILES_CARD_WIDTH + PINNED_FILES_RIGHT_MARGIN + PINNED_FILES_COLUMN_GAP

/** Where the block sits: under the top bar's strip, with the transcript's own top gap. */
export const PINNED_FILES_TOP = 'calc(var(--topbar-h) + 12px)'

/** The transcript's message column's max width, in rem (`max-w-3xl` in `MessageStream`). */
const COLUMN_MAX_REM = 48
/** `MessageStream`'s horizontal padding (`px-4`), on each side, in rem. */
const TRANSCRIPT_PADDING_REM = 1

/** The root font size the column is laid out in (main.css sets 17 px). */
function rootRemPx(): number {
  return parseFloat(getComputedStyle(document.documentElement).fontSize) || 16
}

const DRAG_TYPE = 'application/x-cinna-pinned-file'

/**
 * The rank a dropped pin takes, from the neighbours shown: between them, or
 * one past the end it was dropped at. Pins are listed by ascending rank, the
 * opposite of the chats' Pinned block, so the chats' rule runs on negated ranks.
 */
export function pinDropRank(
  pins: readonly PinnedAgentFile[],
  draggedPath: string,
  targetPath: string,
  place: 'before' | 'after'
): number | 'unchanged' | 'no-room' {
  const rows = pins.map((pin) => ({ id: pin.path, rank: pin.rank }))
  const next = dropRank(rows, (row) => -row.rank, draggedPath, targetPath, place)
  return typeof next === 'number' ? 0 - next : next
}

/** The reference a pin stands for, as the transcript's references are shaped. */
export function pinnedFileRef(pin: PinnedAgentFile): AgentFileRef {
  return { text: pin.displayPath, path: pin.path, displayPath: pin.displayPath, kind: 'file', inside: pin.inside }
}

/** Characters of a name's stem kept after the ellipsis, before its extension. */
const LABEL_TAIL_STEM = 6

/**
 * A row's label split for a middle ellipsis: `head` truncates, `tail` always
 * shows, so names that differ only at the end (`report_03.md`,
 * `report_04.md`) stay apart. The tail is the extension (up to 6 characters
 * with its dot) and the last few characters of the stem; a short name is not
 * split. The cut happens only when the row is too narrow, in CSS.
 */
export function middleEllipsisParts(label: string): { head: string; tail: string } {
  const dot = label.lastIndexOf('.')
  const ext = dot > 0 && label.length - dot <= 6 ? label.slice(dot) : ''
  const tailLength = ext.length + LABEL_TAIL_STEM
  if (label.length <= tailLength + 2) return { head: label, tail: '' }
  return { head: label.slice(0, label.length - tailLength), tail: label.slice(label.length - tailLength) }
}

/** Below this chat-area width the transcript's column is too narrow to give up a gutter: the block goes above it. */
export const PINNED_FILES_RESERVE_MIN_PX = 640

/**
 * Whether the block fits right of the transcript's message column, covering
 * no message: the room between the chat area's right edge and the column's,
 * against {@link PINNED_FILES_GUTTER_PX}. Computed from the chat area's width
 * and the column it lays out (centred, at most 48 rem, inside the scroller's
 * 1 rem padding; `remPx` is the root font size), never measured from the
 * column: where the transcript makes room for the block, the column has
 * moved, and measuring it would flip the answer.
 */
export function gutterFits(areaWidth: number, remPx = 16): boolean {
  const column = Math.min(COLUMN_MAX_REM * remPx, areaWidth - 2 * TRANSCRIPT_PADDING_REM * remPx)
  return (areaWidth - column) / 2 >= PINNED_FILES_GUTTER_PX
}

/**
 * Where the transcript makes room for the block. `right`: a right-hand column
 * as wide as the gutter the block needs (the scroller's right padding);
 * `top`: the block's own band above the transcript. Null while the block
 * floats in a gutter that already holds it, or does not show at all.
 */
export type PinnedFilesReserve = 'right' | 'top' | null

/**
 * How the block sits in a chat area this wide: floating in the right gutter
 * when it fits there; else beside a transcript that keeps a column clear for
 * it; else, on a chat area under {@link PINNED_FILES_RESERVE_MIN_PX}, above the
 * transcript. A chat area not laid out (no width) is taken to fit.
 */
export function pinnedFilesMode(areaWidth: number, remPx = 16): 'gutter' | 'reserve' | 'top' {
  if (areaWidth <= 0 || gutterFits(areaWidth, remPx)) return 'gutter'
  return areaWidth >= PINNED_FILES_RESERVE_MIN_PX ? 'reserve' : 'top'
}

/**
 * The chat's Pinned files, for the chat's root agent when it is a folder
 * agent (`agentId`; null hides them). Mounted in the chat area; never in
 * Minimal view, and nothing with no pins.
 *
 * Always open, the header and every row: one click to a file. It never covers
 * a message. Where the room right of the transcript's column holds it, it
 * floats there and nothing moves; where it does not, the chat area is told
 * through `onReserveChange` to make room for it (see {@link PinnedFilesReserve}),
 * only while it shows, so the transcript reflows when the first pin comes or
 * the last one goes, and as the window crosses a width.
 */
export function PinnedFilesCard({ chatId, agentId, onReserveChange }: {
  chatId: string | null
  agentId: string | null
  onReserveChange?: (reserve: PinnedFilesReserve) => void
}): React.JSX.Element | null {
  const minimal = useUIStore((s) => s.minimalView)
  const off = minimal || chatId === null || agentId === null
  useLayoutEffect(() => {
    if (off) onReserveChange?.(null)
  }, [off, onReserveChange])
  if (off) return null
  return <PinnedFilesHost chatId={chatId} agentId={agentId} onReserveChange={onReserveChange} />
}

/** {@link pinnedFilesMode} for the chat area the anchor sits in, kept up to date as it resizes. */
function usePinnedFilesMode(anchorRef: React.RefObject<HTMLElement | null>): 'gutter' | 'reserve' | 'top' {
  const [mode, setMode] = useState<'gutter' | 'reserve' | 'top'>('gutter')
  useLayoutEffect(() => {
    const area = anchorRef.current?.parentElement
    if (!area) return
    const measure = (): void => setMode(pinnedFilesMode(area.getBoundingClientRect().width, rootRemPx()))
    measure()
    if (typeof ResizeObserver === 'undefined') return
    const observer = new ResizeObserver(measure)
    observer.observe(area)
    return () => observer.disconnect()
  }, [anchorRef])
  return mode
}

function PinnedFilesHost({ chatId, agentId, onReserveChange }: {
  chatId: string
  agentId: string
  onReserveChange?: (reserve: PinnedFilesReserve) => void
}): React.JSX.Element {
  // Switching to a chat whose agent's pins are not cached yet keeps the
  // previous list (inert) until the new one is known, so neither the block nor
  // the transcript's room for it goes and comes back; only a list known to be
  // empty takes them away.
  const { data: pins, isPlaceholderData: loading } = usePinnedFiles(agentId, { keepPrevious: true })
  const shown = !!pins && pins.length > 0
  const anchorRef = useRef<HTMLSpanElement>(null)
  const mode = usePinnedFilesMode(anchorRef)
  // Before paint, so no frame shows the block over a message.
  const reserve: PinnedFilesReserve = !shown || mode === 'gutter' ? null : mode === 'reserve' ? 'right' : 'top'
  useLayoutEffect(() => {
    onReserveChange?.(reserve)
  }, [reserve, onReserveChange])
  useLayoutEffect(() => () => onReserveChange?.(null), [onReserveChange])

  // The rows' right-click menu, owned here: unpinning the last pin from it
  // takes the block away, and the menu may still have to say why it failed.
  const menu = useFileRefContextMenu(chatId)
  return (
    <>
      {/* Measures the chat area it is placed in; takes no room and no clicks. */}
      <span ref={anchorRef} aria-hidden="true" className="pointer-events-none absolute h-0 w-0" />
      {shown && <PinnedFilesBlock chatId={chatId} agentId={agentId} pins={pins} above={mode === 'top'} loading={loading} openMenu={menu.openFor} />}
      {menu.menu}
    </>
  )
}

/**
 * The block: the header and the rows, always open. Beside the transcript it
 * floats at the chat area's right edge (the transcript keeps clear of it);
 * `above` it is the chat area's first row in the flow, full width, with the
 * transcript below it.
 */
function PinnedFilesBlock({ chatId, agentId, pins, above, loading, openMenu }: {
  chatId: string
  agentId: string
  pins: PinnedAgentFile[]
  above: boolean
  /** The rows are the previous agent's, held while this one's load: shown, not clickable. */
  loading: boolean
  openMenu: OpenMenu
}): React.JSX.Element {
  const titleId = useId()
  return (
    <section
      data-pinned-files-card
      data-pinned-files-placement={above ? 'top' : 'side'}
      aria-labelledby={titleId}
      aria-busy={loading || undefined}
      inert={loading || undefined}
      className={`${above ? 'relative order-first shrink-0' : 'absolute'} z-20 [-webkit-app-region:no-drag] rounded-xl border border-[var(--color-border)] bg-[var(--color-bg-secondary)]/70 shadow-sm backdrop-blur`}
      // Under the top bar's drag strip, never beneath it: a click there would
      // drag the window. `no-drag` as well, so no strip can ever take its clicks.
      // Sizes in px, not Tailwind's rem: the transcript's reserve is in px too.
      style={above
        ? { marginTop: PINNED_FILES_TOP, marginLeft: PINNED_FILES_RIGHT_MARGIN, marginRight: PINNED_FILES_RIGHT_MARGIN }
        : { top: PINNED_FILES_TOP, right: PINNED_FILES_RIGHT_MARGIN, width: PINNED_FILES_CARD_WIDTH }}
    >
      <h2 id={titleId} className="flex items-center gap-1.5 px-2.5 py-1.5 text-xs text-[var(--color-text)]">
        <Pin size={12} className="shrink-0 text-[var(--color-accent)]" aria-hidden />
        <span className="font-medium">Pinned files</span>
        <span className="text-[10px] tabular-nums text-[var(--color-text-muted)]">{pins.length}</span>
      </h2>
      <PinnedFilesList chatId={chatId} agentId={agentId} pins={pins} openMenu={openMenu} className="px-1 pb-1" />
    </section>
  )
}

type OpenMenu = (target: FileRefTarget, point: { x: number; y: number }, highlight?: HTMLElement, options?: { missing?: boolean }) => void

/**
 * The pins as rows: a click opens
 * the preview as a reference in the transcript does, a right-click opens the
 * transcript's menu (Unpin file first), a drag reorders. A missing file is
 * dimmed, with a glyph that says so; its menu offers only Unpin file and
 * Copy full path.
 */
function PinnedFilesList({ chatId, agentId, pins, openMenu, className = '' }: {
  chatId: string
  agentId: string
  pins: PinnedAgentFile[]
  openMenu: OpenMenu
  className?: string
}): React.JSX.Element {
  const move = useMovePinnedFile()
  const [drag, setDrag] = useState<string | null>(null)
  const [dropAt, setDropAt] = useState<{ path: string; place: 'before' | 'after' } | null>(null)
  const [dropError, setDropError] = useState<string | null>(null)
  const moveFailed = move.isError || (move.data !== undefined && !move.data.success)
  const error = dropError ?? (moveFailed ? 'Could not move the file there.' : null)

  const placeOf = (event: DragEvent<HTMLElement>): 'before' | 'after' => {
    const rect = event.currentTarget.getBoundingClientRect()
    return event.clientY < rect.top + rect.height / 2 ? 'before' : 'after'
  }

  const drop = (targetPath: string, place: 'before' | 'after'): void => {
    const dragged = drag
    setDrag(null)
    setDropAt(null)
    if (!dragged) return
    const rank = pinDropRank(pins, dragged, targetPath, place)
    if (rank === 'unchanged') return
    if (rank === 'no-room') {
      setDropError('Could not move the file there.')
      return
    }
    move.mutate({ agentId, path: dragged, rank })
  }

  const open = (pin: PinnedAgentFile, event: MouseEvent<HTMLButtonElement>): void => {
    // Enter or Space arrives as a click with no detail: the preview grows from its centre.
    const origin = event.detail > 0 ? { x: event.clientX, y: event.clientY } : null
    void useFilePreviewStore.getState().openAgentFile(agentId, pinnedFileRef(pin), origin)
  }

  return (
    <>
      <ul aria-label="Pinned files" data-pinned-files-chat={chatId} className={`max-h-56 overflow-y-auto ${className}`}>
        {pins.map((pin) => {
          const ref = pinnedFileRef(pin)
          const accepts = drag !== null && drag !== pin.path
          const line = accepts && dropAt?.path === pin.path ? dropAt.place : null
          return (
            <li key={pin.path} className="relative">
              {line && (
                <span
                  aria-hidden="true"
                  data-drop-indicator={line}
                  className={`pointer-events-none absolute inset-x-1 h-0.5 rounded-full bg-[var(--color-accent)] ${line === 'before' ? '-top-px' : '-bottom-px'}`}
                />
              )}
              <button
                type="button"
                draggable
                title={pin.displayPath}
                data-pinned-file={pin.path}
                onClick={(event) => open(pin, event)}
                onContextMenu={(event) => {
                  event.preventDefault()
                  const rect = event.currentTarget.getBoundingClientRect()
                  openMenu({ agentId, ref }, { x: event.clientX || rect.left, y: event.clientY || rect.bottom }, event.currentTarget, { missing: !pin.exists })
                }}
                onDragStart={(event) => {
                  event.dataTransfer.effectAllowed = 'move'
                  event.dataTransfer.setData(DRAG_TYPE, pin.path)
                  setDropError(null)
                  move.reset()
                  setDrag(pin.path)
                }}
                onDragEnd={() => {
                  setDrag(null)
                  setDropAt(null)
                }}
                onDragOver={(event) => {
                  if (!accepts) return
                  event.preventDefault()
                  event.dataTransfer.dropEffect = 'move'
                  const place = placeOf(event)
                  if (dropAt?.path !== pin.path || dropAt.place !== place) setDropAt({ path: pin.path, place })
                }}
                onDragLeave={(event) => {
                  if (event.relatedTarget instanceof Node && event.currentTarget.contains(event.relatedTarget)) return
                  setDropAt(null)
                }}
                onDrop={(event) => {
                  if (!accepts) return
                  event.preventDefault()
                  // From the pointer, not the line's state: a dragleave may have cleared that.
                  drop(pin.path, placeOf(event))
                }}
                className={`flex w-full items-center gap-1.5 rounded-md px-2 py-1 text-left text-xs text-[var(--color-text-secondary)] hover:bg-[var(--color-bg-hover)] hover:text-[var(--color-text)] transition-colors ${
                  drag === pin.path ? 'opacity-40' : ''}`}
              >
                <File size={12} aria-hidden className={`shrink-0 text-[var(--color-accent)] ${pin.exists ? '' : 'opacity-50'}`} />
                <PinLabel label={pathRefLabel(pin.path)} dimmed={!pin.exists} />
                {!pin.exists && (
                  <span role="img" aria-label="File not found" title="File not found" className="ml-auto shrink-0 text-[var(--color-warning)]">
                    <AlertTriangle size={12} aria-hidden />
                  </span>
                )}
              </button>
            </li>
          )
        })}
      </ul>
      {error && <p role="alert" className="px-2.5 pb-1.5 text-[10px] text-[var(--color-danger)]">{error}</p>}
    </>
  )
}

/** A row's name, cut in the middle when the row is too narrow ({@link middleEllipsisParts}). */
function PinLabel({ label, dimmed }: { label: string; dimmed: boolean }): React.JSX.Element {
  const { head, tail } = middleEllipsisParts(label)
  return (
    <span data-pin-label className={`flex min-w-0 ${dimmed ? 'opacity-50' : ''}`}>
      <span className="min-w-0 truncate">{head}</span>
      {tail && <span className="shrink-0 whitespace-pre">{tail}</span>}
    </span>
  )
}
