import { useEffect, useId, useLayoutEffect, useRef, useState, type DragEvent, type MouseEvent } from 'react'
import { createPortal } from 'react-dom'
import { create } from 'zustand'
import { AlertTriangle, ChevronDown, File, Pin } from 'lucide-react'
import type { AgentFileRef, PinnedAgentFile } from '../../../../shared/agentFiles'
import { pathRefLabel } from '../../../../shared/pathMentions'
import { useMovePinnedFile, usePinnedFiles } from '../../hooks/usePinnedFiles'
import { useChatStore } from '../../stores/chat.store'
import { useFilePreviewStore } from '../../stores/filePreview.store'
import { useUIStore } from '../../stores/ui.store'
import { usePopover } from '../ui/usePopover'
import { dropRank } from './chatGroups'
import { useFileRefContextMenu } from './MessageContextMenu'
import type { FileRefTarget } from './fileRefs'

/** The card's width (`w-56`). */
export const PINNED_FILES_CARD_WIDTH = 224
/** From the card's right edge to the chat area's (`right-5`). */
export const PINNED_FILES_RIGHT_MARGIN = 20
/** Kept clear between the transcript column and the card's left edge. */
export const PINNED_FILES_COLUMN_GAP = 12
/** The room right of the transcript column the card needs, its margins included. */
export const PINNED_FILES_GUTTER_PX = PINNED_FILES_CARD_WIDTH + PINNED_FILES_RIGHT_MARGIN + PINNED_FILES_COLUMN_GAP

/** Where the card sits: under the top bar's strip, with the transcript's own top gap. */
export const PINNED_FILES_TOP = 'calc(var(--topbar-h) + 12px)'

/** The transcript's message column (`max-w-3xl mx-auto` in `MessageStream`). */
const COLUMN_SELECTOR = '[data-sidebar-band-limit]'
/** That column's max width, for a chat area whose transcript has not rendered it yet. */
const COLUMN_MAX_PX = 768
/** `MessageStream`'s horizontal padding (`px-4`), on each side. */
const TRANSCRIPT_PADDING_PX = 16

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

/**
 * Whether the card fits right of the transcript's message column, covering
 * no message: the chat area's right edge minus the column's, measured, against
 * {@link PINNED_FILES_GUTTER_PX}. A chat area not laid out (no width) is
 * taken to fit; one whose column has not rendered yet is measured against the
 * column it will have.
 */
export function gutterFits(area: DOMRect, column: DOMRect | null): boolean {
  if (area.width <= 0) return true
  const columnRight = column && column.width > 0
    ? column.right
    : area.left + area.width / 2 + Math.min(COLUMN_MAX_PX, area.width - 2 * TRANSCRIPT_PADDING_PX) / 2
  return area.right - columnRight >= PINNED_FILES_GUTTER_PX
}

/**
 * The chat whose pins show as the top bar's chip rather than as the card:
 * set by the chat area when the card would cover a message, read by
 * {@link PinnedFilesChip}. Null when the card shows, or nothing does.
 */
export const usePinnedFilesChipStore = create<{
  target: { chatId: string; agentId: string } | null
  setTarget: (target: { chatId: string; agentId: string } | null) => void
}>((set) => ({
  target: null,
  setTarget: (target) => set({ target })
}))

/**
 * The chat's Pinned files, for the chat's root agent when it is a folder
 * agent (`agentId`; null hides them). Mounted in the chat area; never in
 * Minimal view, and nothing with no pins.
 *
 * At rest nothing of it covers a message: where the room right of the
 * transcript's column holds it, a card floats there (folds to its header, the
 * choice kept for every chat); where it does not, the chat area hands the
 * pins to a compact chip in the top bar ({@link PinnedFilesChip}).
 */
export function PinnedFilesCard({ chatId, agentId }: { chatId: string | null; agentId: string | null }): React.JSX.Element | null {
  const minimal = useUIStore((s) => s.minimalView)
  const setChip = usePinnedFilesChipStore((s) => s.setTarget)
  const off = minimal || chatId === null || agentId === null
  useEffect(() => {
    if (off) setChip(null)
  }, [off, setChip])
  if (off) return null
  return <PinnedFilesHost chatId={chatId} agentId={agentId} />
}

/** {@link gutterFits} for the chat area the anchor sits in, kept up to date as it or the column resizes. */
function useGutterFits(anchorRef: React.RefObject<HTMLElement | null>): boolean {
  const [fits, setFits] = useState(true)
  useLayoutEffect(() => {
    const area = anchorRef.current?.parentElement
    if (!area) return
    const measure = (): void => {
      const column = area.querySelector<HTMLElement>(COLUMN_SELECTOR)
      setFits(gutterFits(area.getBoundingClientRect(), column?.getBoundingClientRect() ?? null))
    }
    measure()
    if (typeof ResizeObserver === 'undefined') return
    const observer = new ResizeObserver(measure)
    observer.observe(area)
    const column = area.querySelector<HTMLElement>(COLUMN_SELECTOR)
    if (column) observer.observe(column)
    return () => observer.disconnect()
  }, [anchorRef])
  return fits
}

function PinnedFilesHost({ chatId, agentId }: { chatId: string; agentId: string }): React.JSX.Element {
  const { data: pins } = usePinnedFiles(agentId)
  const shown = !!pins && pins.length > 0
  const anchorRef = useRef<HTMLSpanElement>(null)
  const fits = useGutterFits(anchorRef)
  const setChip = usePinnedFilesChipStore((s) => s.setTarget)
  const chip = shown && !fits
  useEffect(() => {
    setChip(chip ? { chatId, agentId } : null)
  }, [chip, chatId, agentId, setChip])
  useEffect(() => () => setChip(null), [setChip])

  // The card's right-click menu, owned here: unpinning the last pin from it
  // takes the card away, and the menu may still have to say why it failed.
  const menu = useFileRefContextMenu(chatId)
  return (
    <>
      {/* Measures the chat area it is placed in; takes no room and no clicks. */}
      <span ref={anchorRef} aria-hidden="true" className="pointer-events-none absolute h-0 w-0" />
      {shown && fits && <GutterCard chatId={chatId} agentId={agentId} pins={pins} openMenu={menu.openFor} />}
      {menu.menu}
    </>
  )
}

function GutterCard({ chatId, agentId, pins, openMenu }: {
  chatId: string
  agentId: string
  pins: PinnedAgentFile[]
  openMenu: OpenMenu
}): React.JSX.Element {
  const listId = useId()
  const collapsed = useUIStore((s) => s.pinnedFilesCollapsed)
  const setCollapsed = useUIStore((s) => s.setPinnedFilesCollapsed)
  return (
    <div
      data-pinned-files-card
      className="absolute right-5 z-20 w-56 [-webkit-app-region:no-drag] rounded-xl border border-[var(--color-border)] bg-[var(--color-bg-secondary)]/70 shadow-sm backdrop-blur"
      // Under the top bar's drag strip, never beneath it: a click there would
      // drag the window. `no-drag` as well, so no strip can ever take its clicks.
      style={{ top: PINNED_FILES_TOP }}
    >
      <button
        type="button"
        aria-expanded={!collapsed}
        aria-controls={listId}
        onClick={() => setCollapsed(!collapsed)}
        className="flex w-full items-center gap-1.5 rounded-xl px-2.5 py-1.5 text-left text-xs text-[var(--color-text)] hover:bg-[var(--color-bg-hover)]/60 transition-colors"
      >
        <Pin size={12} className="shrink-0 text-[var(--color-accent)]" aria-hidden />
        <span className="font-medium">Pinned files</span>
        <span className="text-[10px] tabular-nums text-[var(--color-text-muted)]">{pins.length}</span>
        <ChevronDown
          size={12}
          aria-hidden
          className={`ml-auto shrink-0 text-[var(--color-text-muted)] transition-transform duration-150 motion-reduce:transition-none ${collapsed ? '-rotate-90' : ''}`}
        />
      </button>
      {!collapsed && <PinnedFilesList id={listId} chatId={chatId} agentId={agentId} pins={pins} openMenu={openMenu} className="px-1 pb-1" />}
    </div>
  )
}

type OpenMenu = (target: FileRefTarget, point: { x: number; y: number }, highlight?: HTMLElement, options?: { missing?: boolean }) => void

/**
 * The pins as rows, shared by the card and the chip's popover: a click opens
 * the preview as a reference in the transcript does, a right-click opens the
 * transcript's menu (Unpin file first), a drag reorders. A missing file is
 * dimmed, with a glyph that says so; its menu offers only Unpin file and
 * Copy full path.
 */
function PinnedFilesList({ id, chatId, agentId, pins, openMenu, onOpened, className = '' }: {
  id?: string
  chatId: string
  agentId: string
  pins: PinnedAgentFile[]
  openMenu: OpenMenu
  /** After a row opened the preview. */
  onOpened?: () => void
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
    onOpened?.()
  }

  return (
    <>
      <ul id={id} aria-label="Pinned files" data-pinned-files-chat={chatId} className={`max-h-56 overflow-y-auto ${className}`}>
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

/**
 * The pins as a chip in the top bar, beside the origin pills, where the card
 * would cover a message (see {@link PinnedFilesCard}): the pin and the count;
 * a click opens the same rows as a popover. A child of the top bar's
 * `.app-drag-strip`, so — like the origin pills — the button inherits
 * `-webkit-app-region: no-drag` from main.css and stays clickable.
 */
export function PinnedFilesChip(): React.JSX.Element | null {
  const target = usePinnedFilesChipStore((s) => s.target)
  // The rows' right-click menu, owned here, where nothing unmounts it:
  // unpinning the last pin takes the chip (and the target) away, and the menu
  // may still have to say why it failed. Kept on the last chat the chip showed
  // for, so the menu outlives the target. A switch of the active chat closes
  // it, to a chat with no chip too; the last unpin never switches chats.
  const [lastChatId, setLastChatId] = useState<string | null>(null)
  if (target && target.chatId !== lastChatId) setLastChatId(target.chatId)
  const menu = useFileRefContextMenu(target?.chatId ?? lastChatId ?? '')
  const activeChatId = useChatStore((s) => s.activeChatId)
  const { close: closeMenu } = menu
  useEffect(closeMenu, [activeChatId, closeMenu])
  return (
    <>
      {target && (
        <PinnedFilesChipBody
          key={`${target.chatId}\0${target.agentId}`}
          chatId={target.chatId}
          agentId={target.agentId}
          openMenu={menu.openFor}
          menuOpen={menu.menu !== null}
        />
      )}
      {menu.menu}
    </>
  )
}

function PinnedFilesChipBody({ chatId, agentId, openMenu, menuOpen }: {
  chatId: string
  agentId: string
  openMenu: OpenMenu
  /** The rows' menu is open: it takes Escape first. */
  menuOpen: boolean
}): React.JSX.Element | null {
  const { data: pins } = usePinnedFiles(agentId)
  const popover = usePopover<HTMLButtonElement>('below-right', { flipWhenNoRoom: true })
  const { open, setOpen, triggerRef } = popover

  useEffect(() => {
    if (!open) return
    const escape = (event: KeyboardEvent): void => {
      // The row's menu takes Escape first; the popover waits for the next one.
      if (event.key !== 'Escape' || menuOpen) return
      setOpen(false)
      triggerRef.current?.focus({ preventScroll: true })
    }
    document.addEventListener('keydown', escape)
    return () => document.removeEventListener('keydown', escape)
  }, [open, menuOpen, setOpen, triggerRef])

  // Opened, the popover takes focus on its first row; Escape gives it back to the chip.
  const placed = open && !!popover.style
  const { popoverRef } = popover
  useEffect(() => {
    if (placed) popoverRef.current?.querySelector<HTMLButtonElement>('[data-pinned-file]')?.focus({ preventScroll: true })
  }, [placed, popoverRef])

  if (!pins || pins.length === 0) return null
  const label = `Pinned files, ${pins.length}`
  return (
    <>
      <button
        ref={triggerRef}
        type="button"
        data-pinned-files-chip
        aria-label={label}
        title="Pinned files"
        aria-haspopup="dialog"
        aria-expanded={open}
        onClick={() => setOpen(!open)}
        className="inline-flex shrink-0 items-center gap-1 px-2.5 py-1 rounded-full text-xs tabular-nums
          text-[var(--color-text-secondary)] hover:text-[var(--color-text)]
          bg-[var(--color-bg-secondary)]/70 hover:bg-[var(--color-bg-secondary)]/90
          border border-[var(--color-border)] shadow-sm backdrop-blur transition-colors"
      >
        <Pin size={12} className="shrink-0 text-[var(--color-accent)]" aria-hidden />
        {pins.length}
      </button>
      {open && popover.style && createPortal(
        <div
          ref={popover.popoverRef}
          role="dialog"
          aria-label="Pinned files"
          data-pinned-files-popover
          style={popover.style}
          className="app-popover-surface z-50 w-56 rounded-lg border border-[var(--color-border)] p-1 shadow-xl"
        >
          <PinnedFilesList chatId={chatId} agentId={agentId} pins={pins} openMenu={openMenu} onOpened={() => setOpen(false)} />
        </div>,
        document.body
      )}
    </>
  )
}
