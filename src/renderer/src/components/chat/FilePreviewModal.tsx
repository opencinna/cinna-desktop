import {
  ArrowDown,
  ArrowUp,
  ArrowUpDown,
  Download,
  FileText,
  Filter,
  Folder,
  Loader2,
  TableOfContents,
  X
} from 'lucide-react'
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type RefObject } from 'react'
import { createPortal } from 'react-dom'
import Markdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import rehypeHighlight from 'rehype-highlight'
import { useFrontmatter } from '../ui/FrontmatterTable'
import { markdownToc } from '../../utils/markdownToc'
import { useUIStore } from '../../stores/ui.store'
import { FileActionsMenu, PREVIEW_POPOVER_ATTR } from './FileActionsMenu'
import {
  CONTENTS_PANEL_ID,
  CONTENTS_PANEL_WIDTH,
  FilePreviewContents,
  previewMarkdownComponents
} from './FilePreviewContents'
import { JsonTree, JsonTreeBoundary, useParsedJson } from './JsonTree'
import {
  actionErrorRepeatsBody,
  actionErrorText,
  agentFileErrorText,
  useFilePreviewStore
} from '../../stores/filePreview.store'
import { useFileDownloadStore } from '../../stores/fileDownload.store'
import type { PreviewRenderKind } from '../../../../shared/filePreview'
import { agentFileName } from '../../../../shared/agentFiles'

/** Labelled secondary button at the app-chrome scale (Contents); colours by state. */
const HEADER_ACTION_CLASS =
  'inline-flex items-center gap-1 px-2 py-0.5 rounded-md text-xs font-medium border ' +
  'border-[var(--color-border)] disabled:opacity-50 transition-colors'

/** Entrance timing: short enough to never be waited on. */
const ENTRANCE: KeyframeAnimationOptions = { duration: 170, easing: 'cubic-bezier(0.2, 0, 0, 1)' }

/** The card's widest closed width, `max-w-3xl`, in rem. */
const CARD_MAX_WIDTH_REM = 48
/** The overlay's horizontal padding (`px-4`), both sides together, in rem. */
const OVERLAY_PADDING_X_REM = 2
/** The gap the widened card keeps from the window's right edge. */
const WINDOW_MARGIN = 16
/** The card's left and right borders together, inside its border-box width. */
const CARD_BORDER_X = 2

/**
 * Where the Contents panel goes, from the window width alone.
 *
 * The closed card is `min(768, window - padding)` wide and centred. Opening
 * the panel widens it by the panel's width, **to the right** where the window
 * has room: the card gets that explicit width and is shifted right by
 * `shift`. With room for the whole panel (`shift` is half its width) the left
 * edge — and the body, pinned at the closed width — stays exactly where it
 * was. With less, the card still widens and moves left only as far as it must
 * to keep {@link WINDOW_MARGIN} from the right edge. Only a window too narrow
 * for the closed card and the panel side by side gets the overlay: the card
 * keeps its width and the panel lies over the body's right side.
 */
export function contentsGeometry(
  windowWidth: number,
  /** The root font size: the Tailwind widths are in rem, and it is not always 16. */
  rem = 16
): {
  closedWidth: number
  sideBySide: boolean
  shift: number
} {
  const padding = OVERLAY_PADDING_X_REM * rem
  const closedWidth = Math.min(CARD_MAX_WIDTH_REM * rem, windowWidth - padding)
  const wideWidth = closedWidth + CONTENTS_PANEL_WIDTH
  const sideBySide = wideWidth <= windowWidth - padding
  // Centred at the wide width, the right edge sits at (window + wide) / 2.
  const roomRight = windowWidth - WINDOW_MARGIN - (windowWidth + wideWidth) / 2
  const shift = sideBySide ? Math.max(0, Math.min(CONTENTS_PANEL_WIDTH / 2, roomRight)) : 0
  return { closedWidth, sideBySide, shift }
}

/**
 * How long the card stays hidden waiting for its first settled state (content,
 * a notice or an error). A slower load runs the entrance on the loading card.
 */
export const ENTRANCE_WAIT_MS = 150

/**
 * How long after an open a press outside the card is ignored. The second press
 * of a double-click on a link lands on the overlay the first click just
 * opened, and would close it again.
 */
export const OPEN_PRESS_GUARD_MS = 500

/**
 * The card's entrance, and focus in and out of it.
 *
 * The card expands from the click, so the origin has to be measured on the
 * rect the user will see. The loading card is a fraction of the loaded one, so
 * a new open keeps card and backdrop invisible (opacity only — the layout is
 * already final) until the first settled state, then measures and animates.
 * A load slower than {@link ENTRANCE_WAIT_MS} animates the loading card
 * instead; the card is pinned to the top, so its growth cannot move the origin.
 *
 * Once the entrance starts, focus moves into the card so Tab reaches its
 * buttons. On close it returns to whatever held it before the open, if that
 * is still in the document — but only after a keyboard open (no origin). After
 * a click, focus handed back to the link would wear its focus-visible ring
 * once the user closes with Escape; the card's focus is simply let go.
 */
function useCardEntrance({
  cardRef,
  backdropRef,
  open,
  openSeq,
  settled,
  exiting
}: {
  cardRef: RefObject<HTMLDivElement | null>
  backdropRef: RefObject<HTMLDivElement | null>
  open: boolean
  openSeq: number
  settled: boolean
  /** The preview is fading out: an entrance still waiting must never start. */
  exiting: boolean
}): void {
  const exitingRef = useRef(exiting)
  exitingRef.current = exiting
  const entrance = useRef<{ started: boolean; timer: ReturnType<typeof setTimeout> | null; animations: Animation[] }>({
    started: false,
    timer: null,
    animations: []
  })
  const returnFocus = useRef<HTMLElement | null>(null)
  /** Whether the latest open came from the keyboard, which is when focus is returned. */
  const keyboardOpen = useRef(false)

  const start = useCallback((): void => {
    const state = entrance.current
    const card = cardRef.current
    if (state.started || !card || exitingRef.current) return
    state.started = true
    if (state.timer) clearTimeout(state.timer)
    state.timer = null
    if (typeof card.animate === 'function') {
      // Keyboard opens have no point and grow from the centre; reduced motion
      // only fades. The rect is read before any transform applies.
      const { origin } = useFilePreviewStore.getState()
      const rect = card.getBoundingClientRect()
      card.style.transformOrigin = origin ? `${origin.x - rect.left}px ${origin.y - rect.top}px` : 'center'
      const reduceMotion = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches ?? false
      card.style.opacity = ''
      const animations = [
        card.animate(
          reduceMotion
            ? [{ opacity: 0 }, { opacity: 1 }]
            : [
                { opacity: 0, transform: 'scale(0.92)' },
                { opacity: 1, transform: 'scale(1)' }
              ],
          ENTRANCE
        )
      ]
      const backdrop = backdropRef.current
      if (backdrop) {
        backdrop.style.opacity = ''
        const fade = backdrop.animate?.([{ opacity: 0 }, { opacity: 1 }], ENTRANCE)
        if (fade) animations.push(fade)
      }
      state.animations = animations
    }
    card.focus({ preventScroll: true })
  }, [cardRef, backdropRef])

  // Give focus back on close. Declared first so its cleanup sees the element
  // captured by the open below.
  useLayoutEffect(() => {
    if (!open) return
    return () => {
      const element = returnFocus.current
      returnFocus.current = null
      if (keyboardOpen.current && element?.isConnected) element.focus({ preventScroll: true })
    }
  }, [open])

  // A new open: remember who had focus, hide until settled or the wait ends.
  useLayoutEffect(() => {
    if (!open) return
    const card = cardRef.current
    const state = entrance.current
    state.started = false
    keyboardOpen.current = useFilePreviewStore.getState().origin === null
    // Replacing an open preview keeps the element from before the first open.
    const active = document.activeElement
    if (!returnFocus.current && active instanceof HTMLElement && active !== document.body && !card?.contains(active)) {
      returnFocus.current = active
    }
    if (card && typeof card.animate === 'function') {
      card.style.opacity = '0'
      if (backdropRef.current) backdropRef.current.style.opacity = '0'
    }
    state.timer = setTimeout(start, ENTRANCE_WAIT_MS)
    return () => {
      if (state.timer) clearTimeout(state.timer)
      state.timer = null
      for (const animation of state.animations) animation.cancel()
      state.animations = []
    }
  }, [open, openSeq, start, cardRef, backdropRef])

  // Runs after the open above in the same commit, so an open that is settled
  // at once (a notice, an error) animates without waiting.
  useLayoutEffect(() => {
    if (open && settled) start()
  }, [open, openSeq, settled, start])
}

/**
 * Single global modal that previews a small text file: a message attachment
 * (txt / csv / md / json / yaml) or a file a folder agent named in its chat.
 * Driven by {@link useFilePreviewStore}. For an attachment the header's
 * Download button reuses the standard `files:download` save-as flow so preview
 * never replaces the ability to keep the file; an agent file is already on
 * disk, so its header offers Open folder and Open instead. The card expands
 * from the click that opened it. Mounted once at the app root.
 */
export function FilePreviewModal(): React.JSX.Element | null {
  const live = useFilePreviewStore()
  const { close, openAgentFileExternally, revealAgentFile } = live
  const contentsOpen = useUIStore((s) => s.previewContentsOpen)
  const togglePreviewContents = useUIStore((s) => s.togglePreviewContents)
  // Closing fades out as fast as opening faded in. The store closes at once;
  // the modal keeps rendering the last open state until its exit ends. A new
  // open during the fade cancels it.
  const lastOpen = useRef(live)
  useLayoutEffect(() => {
    if (live.target) lastOpen.current = live
  })
  const [prevTarget, setPrevTarget] = useState(live.target)
  const [exitView, setExitView] = useState<typeof live | null>(null)
  if (live.target !== prevTarget) {
    setPrevTarget(live.target)
    setExitView(live.target === null && prevTarget !== null ? lastOpen.current : null)
  }
  const exiting = live.target === null && exitView !== null
  const {
    target,
    attachment,
    kind,
    text,
    isLoading,
    truncated,
    error,
    errorCode,
    failedStep,
    notice,
    openSeq,
    pendingAction,
    actionError
  } = exiting && exitView ? exitView : live
  const download = useFileDownloadStore((s) => s.download)
  const isDownloading = useFileDownloadStore((s) =>
    attachment ? s.downloadingIds.has(attachment.id) : false
  )
  const cardRef = useRef<HTMLDivElement>(null)
  const backdropRef = useRef<HTMLDivElement>(null)
  const overlayRef = useRef<HTMLDivElement>(null)
  const bodyRef = useRef<HTMLDivElement>(null)
  // Markdown only: the frontmatter split and the headings, computed here once
  // because the header's Contents button needs the verdict too. The headings
  // are parsed from exactly the body handed to <Markdown>.
  const markdown = useFrontmatter(kind === 'markdown' ? text : '')
  const toc = useMemo(
    () => (kind === 'markdown' ? markdownToc(markdown.body) : null),
    [kind, markdown.body]
  )
  const targetKey = !target
    ? null
    : target.type === 'attachment'
      ? `attachment:${target.attachment.id}`
      : `agent-file:${target.agentId}:${target.ref.path}`
  // CSV-only: toggles the per-column filter/sort controls. Reset whenever a
  // different file opens so the controls don't carry over between previews.
  const [filtersEnabled, setFiltersEnabled] = useState(false)
  useEffect(() => {
    setFiltersEnabled(false)
  }, [targetKey])

  const loaded = target !== null && !isLoading && error === null && !notice && kind !== null
  const showContents = loaded && kind === 'markdown' && toc?.show === true
  const panelOpen = showContents && contentsOpen
  // The window width, followed for as long as the modal is mounted: a value
  // left stale between previews would widen the card by the wrong amount, and
  // the entrance measures its origin before a correction could land.
  const [windowWidth, setWindowWidth] = useState(() => window.innerWidth)
  // The width only animates when the Contents button changed it: a preview
  // that opens with the panel already open appears at its final width, and a
  // window being resized is followed, not chased.
  // Keyed to the open it was asked for in, so a new preview never inherits it.
  const [animateWidthFor, setAnimateWidthFor] = useState<number | null>(null)
  const animateWidth = animateWidthFor === openSeq
  useEffect(() => {
    const measure = (): void => {
      setAnimateWidthFor(null)
      setWindowWidth(window.innerWidth)
    }
    window.addEventListener('resize', measure)
    return () => window.removeEventListener('resize', measure)
  }, [])
  // Closing a side-by-side panel keeps it rendered while the card narrows, so
  // the card clips it away instead of leaving an empty strip.
  const [closingFor, setClosingFor] = useState<number | null>(null)
  useEffect(() => {
    if (closingFor === null) return
    const timer = setTimeout(() => setClosingFor(null), Number(ENTRANCE.duration))
    return () => clearTimeout(timer)
  }, [closingFor])
  // When Contents was last toggled, for the press guard below.
  const toggledAt = useRef(0)
  // A load that outlasted the entrance wait was shown on the narrow loading
  // card: widening it when content lands would move the header's buttons
  // under a pointer that may be on its way to them. That preview lays the
  // panel over the body instead, until the user toggles Contents themselves.
  const [slowOpenFor, setSlowOpenFor] = useState<number | null>(null)
  useEffect(() => {
    if (!isLoading) return
    const timer = setTimeout(() => setSlowOpenFor(openSeq), ENTRANCE_WAIT_MS)
    return () => clearTimeout(timer)
  }, [isLoading, openSeq])
  const toggleContents = (): void => {
    setSlowOpenFor(null)
    toggledAt.current = Date.now()
    setAnimateWidthFor(openSeq)
    setClosingFor(contentsOpen ? openSeq : null)
    togglePreviewContents()
  }

  // When the current preview opened, for the press guard below.
  const openedAt = useRef(0)
  useLayoutEffect(() => {
    openedAt.current = Date.now()
  }, [openSeq])

  useEffect(() => {
    // A preview that is fading out is already closed.
    if (!targetKey || exiting) return
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') close()
    }
    const onMouse = (e: MouseEvent): void => {
      if (!cardRef.current || cardRef.current.contains(e.target as Node)) return
      // The ⋯ menu is portaled out of the card, and is the card's.
      if ((e.target as Element).closest?.(`[${PREVIEW_POPOVER_ATTR}]`)) return
      // A press outside with the menu open only closes the menu (its own
      // outside-press handling does that), as Escape does. This listener
      // captures on the window, so it runs before the menu's and still finds
      // it mounted.
      if (document.querySelector(`[role="menu"][${PREVIEW_POPOVER_ATTR}]`)) return
      // The second press of a double-click on the link that opened this lands
      // outside the card: leave it alone entirely, focus included.
      if (Date.now() - openedAt.current < OPEN_PRESS_GUARD_MS) return
      // Toggling Contents moves the card's edge from under the pointer: a
      // second press on the spot must not land on the backdrop and close.
      if (Date.now() - toggledAt.current < OPEN_PRESS_GUARD_MS) return
      // A press on the backdrop would otherwise move focus to the page after
      // close has handed it back to the element that opened the preview.
      if (overlayRef.current?.contains(e.target as Node)) e.preventDefault()
      close()
    }
    window.addEventListener('keydown', onKey)
    window.addEventListener('mousedown', onMouse, true)
    return () => {
      window.removeEventListener('keydown', onKey)
      window.removeEventListener('mousedown', onMouse, true)
    }
  }, [targetKey, exiting, close])

  useCardEntrance({ cardRef, backdropRef, open: target !== null, openSeq, settled: !isLoading, exiting })

  // The exit: the entrance played backwards, from the same origin and at the
  // same speed, holding its last frame until the modal unmounts. A card closed
  // while it was still hidden, waiting for its first settled state, was never
  // seen: it unmounts at once rather than flashing in to fade out.
  useLayoutEffect(() => {
    if (!exiting) return
    const card = cardRef.current
    const neverShown = card?.style.opacity === '0'
    const animations: Animation[] = []
    if (card && !neverShown && typeof card.animate === 'function') {
      const reduceMotion = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches ?? false
      const exit: KeyframeAnimationOptions = { ...ENTRANCE, fill: 'forwards' }
      animations.push(
        card.animate(
          reduceMotion
            ? [{ opacity: 1 }, { opacity: 0 }]
            : [
                { opacity: 1, transform: 'scale(1)' },
                { opacity: 0, transform: 'scale(0.92)' }
              ],
          exit
        )
      )
      const fade = backdropRef.current?.animate?.([{ opacity: 1 }, { opacity: 0 }], exit)
      if (fade) animations.push(fade)
    }
    const timer = setTimeout(() => setExitView(null), animations.length > 0 ? Number(ENTRANCE.duration) : 0)
    return () => {
      clearTimeout(timer)
      for (const animation of animations) animation.cancel()
    }
  }, [exiting])

  if (!target) return null
  const agentFile = target.type === 'agentFile' ? target : null
  const attachmentTarget = target.type === 'attachment' ? target.attachment : null
  const filename = agentFile ? agentFileName(agentFile.ref.path) : (attachmentTarget?.filename ?? '')
  // A folder only reaches the modal when showing it failed: no file actions.
  const fileActions = agentFile?.ref.kind === 'file'
  // A file the body already says has gone: its actions could only fail, and
  // their error would repeat the body, so a click would look like nothing.
  const fileGone = !isLoading && error !== null && errorCode === 'not_found'
  const bodyError =
    error === null
      ? null
      : agentFile
        ? agentFileErrorText(agentFile.ref, failedStep, errorCode, error)
        : `Couldn't load preview: ${error}`
  const showActionError =
    agentFile !== null && actionError !== null && !actionErrorRepeatsBody({ actionError, error, errorCode, isLoading })
  const TitleIcon = agentFile?.ref.kind === 'dir' ? Folder : FileText

  const rem = parseFloat(getComputedStyle(document.documentElement).fontSize) || 16
  const geometry = contentsGeometry(windowWidth, rem)
  const { closedWidth, shift } = geometry
  const sideBySide = geometry.sideBySide && slowOpenFor !== openSeq
  const widened = panelOpen && sideBySide
  const reduceMotion = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches ?? false
  const widthTransition = 'width 170ms cubic-bezier(0.2, 0, 0, 1), left 170ms cubic-bezier(0.2, 0, 0, 1)'
  // Explicit only while the Contents button exists, so opening the panel is a
  // change between two pixel widths that can animate; `flexShrink` keeps the
  // widened card from being squeezed back into the overlay's padding.
  const cardStyle: React.CSSProperties | undefined = showContents
    ? {
        width: widened ? closedWidth + CONTENTS_PANEL_WIDTH : closedWidth,
        maxWidth: 'none',
        flexShrink: 0,
        left: widened ? shift : 0,
        // Clips the side-by-side panel while the width animates.
        overflow: 'hidden',
        transition: animateWidth && !reduceMotion ? widthTransition : undefined
      }
    : undefined

  return createPortal(
    // Pinned to the top rather than centred: the card only grows downward, so
    // content landing or an error row appearing never moves the button the
    // user just pressed.
    <div
      ref={overlayRef}
      className={`fixed inset-0 z-50 flex items-start justify-center px-4 pt-[10vh]${exiting ? ' pointer-events-none' : ''}`}
    >
      <div ref={backdropRef} aria-hidden className="absolute inset-0 bg-black/25" />
      <div
        ref={cardRef}
        tabIndex={-1}
        style={cardStyle}
        className="relative w-full max-w-3xl max-h-[80vh] flex flex-col rounded-xl border
          border-[var(--color-border)] bg-[var(--color-bg-secondary)] shadow-lg focus:outline-none"
      >
        <div
          className="flex items-center justify-between gap-2 px-5 py-3 border-b
            border-[var(--color-border)]"
        >
          <div className="flex items-center gap-2 min-w-0">
            <TitleIcon size={16} className="text-[var(--color-text-muted)] shrink-0" />
            <div
              title={filename}
              className={
                'text-sm font-semibold text-[var(--color-text)] truncate' +
                (agentFile ? ' shrink-0 max-w-[60%]' : '')
              }
            >
              {filename}
            </div>
            {/* A file at the agent folder's top level would show its name twice. */}
            {agentFile && agentFile.ref.displayPath !== filename && (
              <CopyablePath path={agentFile.ref.displayPath} />
            )}
          </div>
          <div className={`flex items-center shrink-0 ${agentFile ? 'gap-1.5' : 'gap-1'}`}>
            {kind === 'csv' && !notice && (
              <button
                type="button"
                onClick={() => setFiltersEnabled((v) => !v)}
                aria-pressed={filtersEnabled}
                className={
                  'p-1 rounded transition-colors ' +
                  (filtersEnabled
                    ? 'bg-[var(--color-accent)]/15 text-[var(--color-accent)]'
                    : 'text-[var(--color-text-muted)] hover:bg-[var(--color-bg-hover)] hover:text-[var(--color-text)]')
                }
                title={filtersEnabled ? 'Hide filters & sorting' : 'Filter & sort columns'}
                aria-label="Toggle column filters and sorting"
              >
                <Filter size={14} />
              </button>
            )}
            {showContents && (
              <button
                type="button"
                onClick={toggleContents}
                aria-expanded={contentsOpen}
                aria-controls={CONTENTS_PANEL_ID}
                title={contentsOpen ? 'Hide contents' : 'Show contents'}
                className={
                  HEADER_ACTION_CLASS +
                  (contentsOpen
                    ? ' bg-[var(--color-accent)]/15 text-[var(--color-accent)]'
                    : ' text-[var(--color-text-muted)] hover:bg-[var(--color-bg-hover)] hover:text-[var(--color-text)]')
                }
              >
                <TableOfContents size={12} />
                Contents
              </button>
            )}
            {fileActions && (
              <FileActionsMenu
                key={targetKey}
                dismissed={exiting}
                pendingAction={pendingAction}
                fileGone={fileGone}
                onOpen={() => void openAgentFileExternally()}
                onReveal={() => void revealAgentFile()}
              />
            )}
            {attachmentTarget && (
              <button
                type="button"
                onClick={() => void download(attachmentTarget)}
                disabled={isDownloading}
                className="p-1 rounded text-[var(--color-text-muted)]
                  hover:bg-[var(--color-bg-hover)] hover:text-[var(--color-text)]
                  disabled:opacity-50 transition-colors"
                title={`Download ${attachmentTarget.filename}`}
                aria-label={`Download ${attachmentTarget.filename}`}
              >
                {isDownloading ? (
                  <Loader2 size={14} className="animate-spin" />
                ) : (
                  <Download size={14} />
                )}
              </button>
            )}
            <button
              type="button"
              onClick={close}
              className="p-1 rounded hover:bg-[var(--color-bg-hover)]
                text-[var(--color-text-muted)] hover:text-[var(--color-text)] transition-colors"
              title="Close"
              aria-label="Close preview"
            >
              <X size={14} />
            </button>
          </div>
        </div>
        {showActionError && actionError && (
          <div
            role="alert"
            className="px-5 py-2 text-xs text-[var(--color-danger)] border-b border-[var(--color-border)]"
          >
            {actionErrorText(actionError)}
          </div>
        )}

        {/* The body, and beside it (or over its right edge) the Contents
            panel. The body keeps the closed card's width whether the panel is
            open or not, so its text never reflows when the panel toggles. */}
        <div className="relative flex min-h-0 flex-1">
          {/* Scrollable, so Tab reaches it: the accent ring the links wear, drawn
              inside so it does not cover the header's rule. */}
          <div
            ref={bodyRef}
            style={showContents ? { width: closedWidth - CARD_BORDER_X, flex: 'none' } : undefined}
            className="px-5 py-4 overflow-auto flex-1 min-w-0 rounded-b-xl focus-visible:outline-2
              focus-visible:-outline-offset-2 focus-visible:outline-[var(--color-accent)]"
          >
            {isLoading ? (
              <div className="flex items-center gap-2 text-xs text-[var(--color-text-muted)]">
                <Loader2 size={12} className="animate-spin" />
                <span>Loading preview…</span>
              </div>
            ) : bodyError ? (
              <div className="text-xs text-[var(--color-danger)]">{bodyError}</div>
            ) : notice ? (
              <div className="text-xs text-[var(--color-text-muted)]">
                {notice === 'credential'
                  ? 'Preview is off for credential files.'
                  : 'No preview for this file type.'}
              </div>
            ) : kind ? (
              <>
                {kind === 'markdown' ? (
                  <MarkdownPreview key={targetKey} card={markdown.card} body={markdown.body} />
                ) : (
                  <PreviewBody key={targetKey} kind={kind} text={text} filtersEnabled={filtersEnabled} />
                )}
                {truncated && (
                  <div className="mt-3 text-[10px] italic text-[var(--color-text-muted)]">
                    {agentFile
                      ? 'Preview truncated — open the file to see the full content.'
                      : 'Preview truncated — download the file to see the full content.'}
                  </div>
                )}
              </>
            ) : null}
          </div>
          {showContents && toc && (panelOpen || (closingFor === openSeq && animateWidth && sideBySide && !reduceMotion)) && (
            <FilePreviewContents
              key={targetKey}
              entries={toc.entries}
              bodyRef={bodyRef}
              overlay={!sideBySide}
              left={closedWidth - CARD_BORDER_X}
            />
          )}
        </div>
      </div>
    </div>,
    document.body
  )
}

/** How long "Copied" stands before the hint fades out. */
const COPIED_HINT_MS = 1200

/**
 * The header path, copied on click. A hint under it says so on hover or focus,
 * turns into "Copied" after a click and then fades; it stays hidden until the
 * pointer leaves, so it does not flip straight back to "Click to copy". The
 * hint is absolutely positioned, so showing it moves nothing.
 */
function CopyablePath({ path }: { path: string }): React.JSX.Element {
  const [hovered, setHovered] = useState(false)
  const [result, setResult] = useState<'copied' | 'failed' | null>(null)
  const [suppressed, setSuppressed] = useState(false)
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null)
  useEffect(() => () => clearTimeout(timer.current ?? undefined), [])

  const copy = async (): Promise<void> => {
    let outcome: 'copied' | 'failed' = 'copied'
    try {
      await navigator.clipboard.writeText(path)
    } catch {
      outcome = 'failed'
    }
    setResult(outcome)
    setSuppressed(false)
    clearTimeout(timer.current ?? undefined)
    timer.current = setTimeout(() => {
      setResult(null)
      setSuppressed(true)
    }, COPIED_HINT_MS)
  }

  const visible = result !== null || (hovered && !suppressed)
  const hint = result === 'copied' ? 'Copied' : result === 'failed' ? "Couldn't copy" : 'Click to copy'
  // The text stays what it was while the hint fades out, so "Copied" does not
  // flip back to "Click to copy" (or go blank) mid-fade.
  const shownHint = useRef(hint)
  if (visible) shownHint.current = hint

  return (
    <div className="relative min-w-0 flex">
      <button
        type="button"
        onClick={() => void copy()}
        onMouseEnter={() => setHovered(true)}
        onMouseLeave={() => {
          setHovered(false)
          setSuppressed(false)
        }}
        onFocus={() => setHovered(true)}
        onBlur={() => {
          setHovered(false)
          setSuppressed(false)
        }}
        className="min-w-0 truncate text-left text-xs text-[var(--color-text-muted)]
          hover:text-[var(--color-text-secondary)] cursor-pointer transition-colors"
        title={path}
      >
        {path}
      </button>
      <span
        role="status"
        aria-live="polite"
        className={
          'pointer-events-none absolute left-0 top-full mt-1 z-10 whitespace-nowrap rounded-md border ' +
          'border-[var(--color-border)] bg-[var(--color-bg-tertiary)] px-2 py-0.5 text-[10px] ' +
          'text-[var(--color-text)] shadow-sm transition-opacity duration-200 ' +
          (visible ? 'opacity-100' : 'opacity-0')
        }
      >
        {shownHint.current}
      </span>
    </div>
  )
}

function PreviewBody({
  kind,
  text,
  filtersEnabled
}: {
  kind: PreviewRenderKind
  text: string
  filtersEnabled: boolean
}): React.JSX.Element {
  if (kind === 'json') {
    return <JsonPreview text={text} />
  }

  if (kind === 'csv') {
    return <CsvPreview text={text} filtersEnabled={filtersEnabled} />
  }

  return (
    <pre
      className="text-xs font-mono whitespace-pre-wrap break-words
        text-[var(--color-text)]"
    >
      {text}
    </pre>
  )
}

/** Split by the modal (see `useFrontmatter` there), which also reads the headings. */
function MarkdownPreview({ card, body }: { card: React.JSX.Element | null; body: string }): React.JSX.Element {
  return (
    <>
      {card}
      <div className="file-preview-markdown markdown-body text-sm text-[var(--color-text)] leading-relaxed">
        <Markdown
          remarkPlugins={[remarkGfm]}
          rehypePlugins={[rehypeHighlight]}
          components={previewMarkdownComponents}
        >
          {body}
        </Markdown>
      </div>
    </>
  )
}

function JsonPreview({ text }: { text: string }): React.JSX.Element {
  // A tree when it parses; the raw text otherwise, so a malformed or
  // truncated file still shows something instead of erroring.
  const parsed = useParsedJson(text)
  const raw = (
    <pre
      className="text-xs font-mono whitespace-pre-wrap break-words
        text-[var(--color-text)]"
    >
      {text}
    </pre>
  )
  if (!parsed) return raw
  return (
    <JsonTreeBoundary key={text} fallback={raw}>
      <JsonTree value={parsed.value} />
    </JsonTreeBoundary>
  )
}

/**
 * Parse delimited text into rows, honoring double-quoted fields that may
 * contain the delimiter, embedded newlines, and `""` escaped quotes
 * (RFC-4180-ish). A single pass over the whole text — not line-by-line — so a
 * quoted cell spanning multiple physical lines stays one cell instead of
 * splitting into bogus rows. Returns one array of cells per record.
 */
function parseDelimited(text: string, delimiter: string): string[][] {
  const rows: string[][] = []
  let row: string[] = []
  let field = ''
  let inQuotes = false
  const src = text.replace(/\r\n/g, '\n').replace(/\r/g, '\n')
  for (let i = 0; i < src.length; i++) {
    const ch = src[i]
    if (inQuotes) {
      if (ch === '"') {
        if (src[i + 1] === '"') {
          field += '"'
          i++
        } else {
          inQuotes = false
        }
      } else {
        field += ch
      }
    } else if (ch === '"') {
      inQuotes = true
    } else if (ch === delimiter) {
      row.push(field)
      field = ''
    } else if (ch === '\n') {
      row.push(field)
      rows.push(row)
      row = []
      field = ''
    } else {
      field += ch
    }
  }
  // Flush a trailing partial record. A file ending in a newline already
  // pushed its last row and leaves nothing buffered, so this skips the empty
  // phantom row that would otherwise appear.
  if (field !== '' || row.length > 0) {
    row.push(field)
    rows.push(row)
  }
  return rows
}

/** Cap on rendered rows so a large CSV doesn't lock up layout. */
const MAX_PREVIEW_ROWS = 500

type SortDir = 'asc' | 'desc'

/** Numeric compare when both cells parse as finite numbers, else locale
 *  string compare — so a "count" column sorts 2 < 10, not "10" < "2". */
function compareCells(a: string, b: string): number {
  const na = Number(a)
  const nb = Number(b)
  const bothNumeric = a.trim() !== '' && b.trim() !== '' && !isNaN(na) && !isNaN(nb)
  if (bothNumeric) return na - nb
  return a.localeCompare(b)
}

function CsvPreview({
  text,
  filtersEnabled
}: {
  text: string
  filtersEnabled: boolean
}): React.JSX.Element {
  const { rows, clipped } = useMemo(() => {
    const delimiter = text.includes('\t') && !text.includes(',') ? '\t' : ','
    // Drop fully-blank records (a blank physical line parses to a single
    // empty cell) so they don't show as empty table rows.
    const all = parseDelimited(text, delimiter).filter(
      (r) => !(r.length === 1 && r[0] === '')
    )
    const clipped = all.length > MAX_PREVIEW_ROWS
    return { rows: clipped ? all.slice(0, MAX_PREVIEW_ROWS) : all, clipped }
  }, [text])

  // Column index → substring filter; null sort means original order.
  const [filters, setFilters] = useState<Record<number, string>>({})
  const [sort, setSort] = useState<{ col: number; dir: SortDir } | null>(null)

  const header = rows[0] ?? []
  const body = useMemo(() => rows.slice(1), [rows])

  // Filter then sort, preserving each row's original index for a stable key.
  // Both controls are gated on `filtersEnabled` — disabled = raw order.
  const processed = useMemo(() => {
    let out = body.map((row, originalIndex) => ({ row, originalIndex }))
    if (filtersEnabled) {
      const active = Object.entries(filters).filter(([, v]) => v.trim() !== '')
      if (active.length > 0) {
        out = out.filter(({ row }) =>
          active.every(([col, v]) =>
            (row[Number(col)] ?? '').toLowerCase().includes(v.toLowerCase())
          )
        )
      }
      if (sort) {
        out = [...out].sort((a, b) => {
          const cmp = compareCells(a.row[sort.col] ?? '', b.row[sort.col] ?? '')
          return sort.dir === 'asc' ? cmp : -cmp
        })
      }
    }
    return out
  }, [body, filters, sort, filtersEnabled])

  if (rows.length === 0) {
    return <div className="text-xs italic text-[var(--color-text-muted)]">Empty file.</div>
  }

  // Click a header to cycle no-sort → asc → desc → no-sort for that column.
  const cycleSort = (col: number): void => {
    setSort((prev) => {
      if (!prev || prev.col !== col) return { col, dir: 'asc' }
      if (prev.dir === 'asc') return { col, dir: 'desc' }
      return null
    })
  }

  const sortIconFor = (col: number): React.JSX.Element => {
    if (!sort || sort.col !== col) {
      return <ArrowUpDown size={11} className="shrink-0 opacity-40" />
    }
    return sort.dir === 'asc' ? (
      <ArrowUp size={11} className="shrink-0 text-[var(--color-accent)]" />
    ) : (
      <ArrowDown size={11} className="shrink-0 text-[var(--color-accent)]" />
    )
  }

  return (
    <div className="overflow-x-auto">
      <table className="file-preview-table text-xs border-collapse w-full">
        <thead>
          <tr>
            {header.map((cell, i) => (
              <th
                key={i}
                className="text-left font-semibold px-2 py-1 border
                  border-[var(--color-border)] bg-[var(--color-bg-elevated)]
                  text-[var(--color-text)] whitespace-nowrap"
              >
                {filtersEnabled ? (
                  <button
                    type="button"
                    onClick={() => cycleSort(i)}
                    className="flex items-center gap-1 w-full text-left
                      hover:text-[var(--color-accent)] transition-colors"
                    title="Sort by this column"
                  >
                    <span className="truncate">{cell}</span>
                    {sortIconFor(i)}
                  </button>
                ) : (
                  cell
                )}
              </th>
            ))}
          </tr>
          {filtersEnabled && (
            <tr>
              {header.map((_, i) => (
                <th
                  key={i}
                  className="p-1 border border-[var(--color-border)]
                    bg-[var(--color-bg-elevated)]"
                >
                  <input
                    type="text"
                    value={filters[i] ?? ''}
                    onChange={(e) =>
                      setFilters((prev) => ({ ...prev, [i]: e.target.value }))
                    }
                    placeholder="Filter…"
                    aria-label={`Filter ${header[i] || `column ${i + 1}`}`}
                    className="w-full min-w-[5rem] px-1 py-0.5 text-[10px] rounded
                      border border-[var(--color-border)] bg-[var(--color-bg-secondary)]
                      text-[var(--color-text)] placeholder:text-[var(--color-text-muted)]
                      focus:outline-none focus:border-[var(--color-accent)]"
                  />
                </th>
              ))}
            </tr>
          )}
        </thead>
        <tbody>
          {processed.map(({ row, originalIndex }) => (
            <tr key={originalIndex}>
              {row.map((cell, c) => (
                <td
                  key={c}
                  className="px-2 py-1 border border-[var(--color-border)]
                    text-[var(--color-text-secondary)] align-top"
                >
                  {cell}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
      {filtersEnabled && processed.length === 0 && body.length > 0 && (
        <div className="mt-2 text-[10px] italic text-[var(--color-text-muted)]">
          No rows match the current filters.
        </div>
      )}
      {clipped && (
        <div className="mt-2 text-[10px] italic text-[var(--color-text-muted)]">
          Showing first {MAX_PREVIEW_ROWS} rows.
        </div>
      )}
    </div>
  )
}
