import {
  Check,
  Copy,
  Download,
  FileText,
  Filter,
  Folder,
  Globe,
  Image as ImageIcon,
  ListTree,
  Loader2,
  SquareTerminal,
  Table2,
  TableOfContents,
  X
} from 'lucide-react'
import { useCallback, useContext, useEffect, useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore, type RefObject } from 'react'
import { QueryClientContext } from '@tanstack/react-query'
import { createPortal } from 'react-dom'
import { useFrontmatter } from '../ui/FrontmatterTable'
import { markdownToc } from '../../utils/markdownToc'
import { pythonOutline } from '../../utils/pythonOutline'
import { diffOutline, parseDiff } from '../../utils/diffDocument'
import { rememberPreviewView, rememberedPreviewView } from '../../utils/previewViewMemory'
import { parseXml } from '../../utils/xmlDocument'
import { xmlOutline } from '../../utils/xmlOutline'
import { useUIStore } from '../../stores/ui.store'
import { FileActionsMenu, PREVIEW_POPOVER_ATTR } from './FileActionsMenu'
import { CONTENTS_PANEL_ID, CONTENTS_PANEL_WIDTH, FilePreviewContents } from './FilePreviewContents'
import { MAX_HIGHLIGHT_CHARS } from './CodePreview'
import { DiffPreview } from './DiffPreview'
import { FULL_WINDOW_CARD_STYLE, PreviewFullWindowButton, usePreviewFullWindow } from './PreviewFullWindow'
import { TRAFFIC_LIGHT_GUTTER } from '../layout/TopBar'
import type { XmlReveal } from './XmlTree'
import { MarkdownPreview, PreviewBody, XmlPreview, type JsonLinesView } from './PreviewBody'
import { jsonLinesShape } from './JsonTree'
import {
  MODAL_HEADER_ACTION,
  MODAL_HEADER_ICON,
  MODAL_HEADER_SEGMENT,
  MODAL_HEADER_SEGMENTS
} from '../ui/modalHeader'
import { HtmlPreview, type HtmlPreviewView } from './HtmlPreview'
import {
  actionErrorRepeatsBody,
  actionErrorText,
  agentFileErrorText,
  isRunnableScriptRef,
  previewRunSource,
  useFilePreviewStore
} from '../../stores/filePreview.store'
import { useFileDownloadStore } from '../../stores/fileDownload.store'
import { MAX_PREVIEW_BYTES } from '../../../../shared/filePreview'
import { agentFileName, isCredentialFileRef } from '../../../../shared/agentFiles'
import { useArtifactsSupport } from '../../hooks/useArtifacts'
import { useArtifactPublishStore } from '../../stores/artifactPublish.store'
import { useChatStore } from '../../stores/chat.store'
import { CARD_MOTION, playCardEntrance, playCardExit } from '../../utils/cardMotion'

/** Entrance timing: short enough to never be waited on. */
const ENTRANCE = CARD_MOTION

/** The card's widest closed width, `max-w-3xl`, in rem. */
const CARD_MAX_WIDTH_REM = 48
/** The overlay's horizontal padding (`px-4`), both sides together, in rem. */
const OVERLAY_PADDING_X_REM = 2
/** The card's left and right borders together, inside its border-box width. */
const CARD_BORDER_X = 2
/** The text read cap, as the truncation notices name it. */
const MAX_PREVIEW_MB = MAX_PREVIEW_BYTES / (1024 * 1024)
/** How long the ⋯ trigger says "copied". */
const COPIED_MARK_MS = 1200

/**
 * Where the Contents panel goes, from the window width alone.
 *
 * The closed card is `min(768, window - padding)` wide and centred. Opening
 * the panel widens it by the panel's width and it stays centred, so the body —
 * pinned at the closed width — moves left by half the panel. Growing to the
 * right only kept the body still but left the card off-centre in every window
 * without room for the whole panel on that side. Only a window too narrow for
 * the closed card and the panel side by side gets the overlay: the card keeps
 * its width and the panel lies over the body's right side.
 */
export function contentsGeometry(
  windowWidth: number,
  /** The root font size: the Tailwind widths are in rem, and it is not always 16. */
  rem = 16
): {
  closedWidth: number
  sideBySide: boolean
} {
  const padding = OVERLAY_PADDING_X_REM * rem
  const closedWidth = Math.min(CARD_MAX_WIDTH_REM * rem, windowWidth - padding)
  const wideWidth = closedWidth + CONTENTS_PANEL_WIDTH
  const sideBySide = wideWidth <= windowWidth - padding
  return { closedWidth, sideBySide }
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
      // only fades (`playCardEntrance`).
      card.style.opacity = ''
      const backdrop = backdropRef.current
      if (backdrop) backdrop.style.opacity = ''
      state.animations = playCardEntrance(card, backdrop, useFilePreviewStore.getState().origin)
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

const NO_SUBSCRIPTION = (): (() => void) => () => undefined

/**
 * The agent of `chatId` as the chat query last loaded it, followed as the
 * cache changes; undefined before it loaded, and where no query client is
 * mounted. Read from the cache rather than fetched: the preview never asks
 * for a chat the transcript does not already hold.
 */
function useCachedChatAgentId(chatId: string | null): string | null | undefined {
  const client = useContext(QueryClientContext)
  const subscribe = useMemo(
    () => (client ? (notify: () => void) => client.getQueryCache().subscribe(notify) : NO_SUBSCRIPTION),
    [client]
  )
  return useSyncExternalStore(subscribe, () =>
    chatId && client ? client.getQueryData<{ agentId?: string | null } | null>(['chat', chatId])?.agentId : undefined
  )
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
  const { close, openAgentFileExternally, revealAgentFile, openInBrowser, runAgentFile } = live
  const activeChatId = useChatStore((s) => s.activeChatId)
  const activeChatAgentId = useCachedChatAgentId(activeChatId)
  const contentsOpen = useUIStore((s) => s.previewContentsOpen)
  const { supported: canPublish } = useArtifactsSupport()
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
    image,
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
  // The frontmatter split (markdown only) and the Contents entries, computed
  // here once because the header's Contents button needs the verdict too.
  // Markdown headings are parsed from exactly the body handed to <Markdown>;
  // a Python file lists its functions, classes and methods, and CodePreview
  // marks their lines.
  const markdown = useFrontmatter(kind === 'markdown' ? text : '')
  // XML is parsed once, here: the outline and the tree share the document.
  const xml = useMemo(() => (kind === 'xml' ? parseXml(text) : null), [kind, text])
  const xmlReveal = useRef<XmlReveal | null>(null)
  // A diff too: the Contents list and the body share the reading.
  const diff = useMemo(
    () => (kind === 'diff' && !isLoading && text.length <= MAX_HIGHLIGHT_CHARS ? parseDiff(text) : null),
    [kind, isLoading, text]
  )
  const toc = useMemo(
    () =>
      kind === 'markdown'
        ? // Shown plain over the limit (see MarkdownPreview): no headings to list.
          markdown.body.length > MAX_HIGHLIGHT_CHARS
          ? null
          : markdownToc(markdown.body)
        : kind === 'python'
          ? pythonOutline(text)
          : kind === 'xml'
            ? xmlOutline(xml)
            : kind === 'diff'
              ? diffOutline(diff)
              : null,
    [kind, markdown.body, text, xml, diff]
  )
  const anchorLines = useMemo(() => toc?.entries.map((entry) => entry.line), [toc])
  const targetKey = !target
    ? null
    : target.type === 'attachment'
      ? `attachment:${target.attachment.id}`
      : target.type === 'path'
        ? `path:${target.path}`
        : `agent-file:${target.agentId}:${target.ref.path}`
  const canFillWindow = error === null && !notice
  const fill = usePreviewFullWindow(canFillWindow)
  const fullWindow = fill.on
  const { justToggled } = fill
  // CSV-only: toggles the per-column filter/sort controls. Reset whenever a
  // different file opens so the controls don't carry over between previews.
  const [filtersEnabled, setFiltersEnabled] = useState(false)
  useEffect(() => {
    setFiltersEnabled(false)
  }, [targetKey])
  // HTML: Rendered or Source, for this open only — every open starts Rendered.
  const [htmlViewFor, setHtmlViewFor] = useState<{ openSeq: number; view: HtmlPreviewView } | null>(null)
  const htmlView: HtmlPreviewView = htmlViewFor?.openSeq === openSeq ? htmlViewFor.view : 'rendered'
  // JSON Lines: Tree or Table, for this open only — every open starts as the tree.
  const [jsonLinesViewFor, setJsonLinesViewFor] = useState<{ openSeq: number; view: JsonLinesView } | null>(null)
  const jsonLinesView: JsonLinesView = jsonLinesViewFor?.openSeq === openSeq ? jsonLinesViewFor.view : 'tree'
  // Tree / Table only for a file of records: a pretty-printed document or text
  // with no JSON line has one view, and a toggle there would change nothing.
  const jsonLinesRecords = useMemo(
    () => kind === 'jsonl' && !isLoading && jsonLinesShape(text, truncated)?.kind === 'records',
    [kind, isLoading, text, truncated]
  )

  const loaded = target !== null && !isLoading && error === null && !notice && kind !== null
  const showContents = loaded && toc?.show === true
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
  // Where the reader is, as a share of the body, across a change that rewraps
  // the text: the pixel offset would land somewhere else.
  const pendingScrollShare = useRef<number | null>(null)
  const holdScrollShare = (): void => {
    const body = bodyRef.current
    if (!body) return
    const range = body.scrollHeight - body.clientHeight
    pendingScrollShare.current = range > 0 ? body.scrollTop / range : 0
  }
  const toggleFullWindow = (): void => {
    holdScrollShare()
    setAnimateWidthFor(null)
    fill.toggle()
  }
  const toggleContents = (): void => {
    // Filling the window, the body takes what the panel leaves, so its text rewraps.
    if (fullWindow) holdScrollShare()
    setSlowOpenFor(null)
    toggledAt.current = Date.now()
    setAnimateWidthFor(openSeq)
    setClosingFor(contentsOpen ? openSeq : null)
    togglePreviewContents()
  }

  // Copy content's answer, for this open only: the mark on the trigger, or a
  // row under the header for what a mark cannot say.
  const [copyFor, setCopyFor] = useState<{ openSeq: number; result: 'copied' | 'partial' | 'failed' } | null>(null)
  const copyResult = copyFor?.openSeq === openSeq ? copyFor.result : null
  const [copiedMarkFor, setCopiedMarkFor] = useState<number | null>(null)
  useEffect(() => {
    if (copiedMarkFor === null) return
    const timer = setTimeout(() => setCopiedMarkFor(null), COPIED_MARK_MS)
    return () => clearTimeout(timer)
  }, [copiedMarkFor])
  const copyContent = async (): Promise<void> => {
    try {
      await navigator.clipboard.writeText(text)
      setCopyFor({ openSeq, result: truncated ? 'partial' : 'copied' })
      setCopiedMarkFor(openSeq)
    } catch {
      setCopyFor({ openSeq, result: 'failed' })
    }
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
      if (Date.now() - toggledAt.current < OPEN_PRESS_GUARD_MS || justToggled()) return
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
  }, [targetKey, exiting, close, justToggled])

  useCardEntrance({ cardRef, backdropRef, open: target !== null, openSeq, settled: !isLoading, exiting })

  // Back to where the user left this file, before anything paints. The body
  // element outlives the file in it, so a file with nothing remembered starts
  // from the top rather than wherever the last one was. A rendered HTML page
  // scrolls inside its own frame, out of reach, and its body must not move.
  const scrollKnownFor = useRef<string | null>(null)
  // The position the restore landed on. Its own scroll event is not the user
  // moving: where the content came back shorter (folds and filters reset on
  // reopen) it clamped, and saving that would lose where they were for good.
  const restoredTop = useRef<number | null>(null)
  useLayoutEffect(() => {
    const body = bodyRef.current
    scrollKnownFor.current = null
    if (!body || !targetKey || exiting) return
    body.scrollTop = 0
    if (isLoading || kind === null || kind === 'html') return
    const view = rememberedPreviewView(targetKey)
    body.scrollTop = !view
      ? 0
      : view.width === body.clientWidth
        ? view.scrollTop
        : view.share * (body.scrollHeight - body.clientHeight)
    restoredTop.current = body.scrollTop
    scrollKnownFor.current = targetKey
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [targetKey, openSeq, isLoading, kind])

  // After the body took its new width (Contents is laid out by then too).
  useLayoutEffect(() => {
    const body = bodyRef.current
    const share = pendingScrollShare.current
    if (!body || share === null) return
    pendingScrollShare.current = null
    body.scrollTop = share * (body.scrollHeight - body.clientHeight)
  })

  // The exit: the entrance played backwards, from the same origin and at the
  // same speed, holding its last frame until the modal unmounts. A card closed
  // while it was still hidden, waiting for its first settled state, was never
  // seen: it unmounts at once rather than flashing in to fade out.
  useLayoutEffect(() => {
    if (!exiting) return
    const card = cardRef.current
    const neverShown = card?.style.opacity === '0'
    const animations: Animation[] = []
    if (card && !neverShown) animations.push(...playCardExit(card, backdropRef.current))
    const timer = setTimeout(() => setExitView(null), animations.length > 0 ? Number(ENTRANCE.duration) : 0)
    return () => {
      clearTimeout(timer)
      for (const animation of animations) animation.cancel()
    }
  }, [exiting])

  if (!target) return null
  const agentFile = target.type === 'agentFile' ? target : null
  const attachmentTarget = target.type === 'attachment' ? target.attachment : null
  // A file still in the composer is the user's own and not sent yet: no Download.
  const downloadable = attachmentTarget !== null && !(target.type === 'attachment' && target.composer)
  const filename = agentFile
    ? agentFileName(agentFile.ref.path)
    : target.type === 'path'
      ? target.filename
      : (attachmentTarget?.filename ?? '')
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
    actionError !== null &&
    (agentFile === null || !actionErrorRepeatsBody({ actionError, error, errorCode, isLoading }))
  // A composer file not sent yet has no preview frame to serve it: its HTML
  // shows as source (see PreviewBody).
  const html = kind === 'html' && target.type !== 'path'
  const imageShown = kind === 'image' && image !== null && !isLoading && bodyError === null
  // The page fills a fixed-height body, so the card never resizes as the frame loads.
  const htmlRendered = html && htmlView === 'rendered' && !isLoading && bodyError === null && !notice
  // Run…: a script inside the folder, with a chat to run it in (main builds the command).
  const runSource =
    agentFile && isRunnableScriptRef(agentFile.ref, text)
      ? previewRunSource(target, activeChatId, activeChatAgentId)
      : null
  const nothingToCopy = isLoading || error !== null || notice !== null || text === ''
  const TitleIcon = agentFile?.ref.kind === 'dir' ? Folder : kind === 'image' ? ImageIcon : FileText

  const rem = parseFloat(getComputedStyle(document.documentElement).fontSize) || 16
  const geometry = contentsGeometry(windowWidth, rem)
  const { closedWidth } = geometry
  const sideBySide = fullWindow || (geometry.sideBySide && slowOpenFor !== openSeq)
  const widened = panelOpen && sideBySide && !fullWindow
  const reduceMotion = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches ?? false
  const widthTransition = 'width 170ms cubic-bezier(0.2, 0, 0, 1)'
  // Explicit only while the Contents button exists, so opening the panel is a
  // change between two pixel widths that can animate; `flexShrink` keeps the
  // widened card from being squeezed back into the overlay's padding.
  const cardStyle: React.CSSProperties | undefined = fullWindow
    ? FULL_WINDOW_CARD_STYLE
    : showContents
    ? {
        width: widened ? closedWidth + CONTENTS_PANEL_WIDTH : closedWidth,
        maxWidth: 'none',
        flexShrink: 0,
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
      className={`fixed inset-0 z-50 flex items-start justify-center${fullWindow ? '' : ' px-4 pt-[10vh]'}${exiting ? ' pointer-events-none' : ''}`}
    >
      <div ref={backdropRef} aria-hidden className="app-modal-scrim absolute inset-0" />
      <div
        ref={cardRef}
        tabIndex={-1}
        style={cardStyle}
        onClickCapture={fill.onClickCapture}
        className={
          'relative w-full flex flex-col app-modal-panel focus:outline-none ' +
          (fullWindow
            ? 'h-full'
            : 'max-h-[80vh] rounded-xl border ' + (html ? 'max-w-6xl h-[80vh]' : 'max-w-3xl'))
        }
      >
        <div
          // Clear of the traffic lights, which stay on top of everything.
          className={
            'flex items-center justify-between gap-2 py-3 pr-5 border-b border-[var(--color-border)] ' +
            (fullWindow ? `app-drag-strip ${TRAFFIC_LIGHT_GUTTER}` : 'pl-5')
          }
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
            {canFillWindow && <PreviewFullWindowButton on={fullWindow} onToggle={toggleFullWindow} />}
            {(kind === 'csv' || (jsonLinesRecords && jsonLinesView === 'table')) && !notice && (
              <button
                type="button"
                onClick={() => setFiltersEnabled((v) => !v)}
                aria-pressed={filtersEnabled}
                className={
                  MODAL_HEADER_ICON + ' ' +
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
            {/* After the filter button, which appears on Table: placed before, it would
                push this group out from under the pointer. */}
            {jsonLinesRecords && !notice && (
              <div
                role="group"
                aria-label="View"
                className={MODAL_HEADER_SEGMENTS}
              >
                {(['tree', 'table'] as const).map((view) => (
                  <button
                    key={view}
                    type="button"
                    aria-pressed={jsonLinesView === view}
                    onClick={() => setJsonLinesViewFor({ openSeq, view })}
                    aria-label={view === 'tree' ? 'Tree' : 'Table'}
                    title={view === 'tree' ? 'Tree: one record per line' : 'Table: a column per value path'}
                    className={
                      MODAL_HEADER_SEGMENT + ' w-6 ' +
                      (jsonLinesView === view
                        ? 'bg-[var(--color-accent)]/15 text-[var(--color-accent)]'
                        : 'text-[var(--color-text-muted)] hover:bg-[var(--color-bg-hover)] hover:text-[var(--color-text)]')
                    }
                  >
                    {view === 'tree' ? <ListTree size={14} /> : <Table2 size={14} />}
                  </button>
                ))}
              </div>
            )}
            {html && bodyError === null && !notice && (
              <div
                role="group"
                aria-label="View"
                className={MODAL_HEADER_SEGMENTS}
              >
                {(['rendered', 'source'] as const).map((view) => (
                  <button
                    key={view}
                    type="button"
                    aria-pressed={htmlView === view}
                    onClick={() => setHtmlViewFor({ openSeq, view })}
                    className={
                      MODAL_HEADER_SEGMENT + ' px-2 text-xs font-medium ' +
                      (htmlView === view
                        ? 'bg-[var(--color-accent)]/15 text-[var(--color-accent)]'
                        : 'text-[var(--color-text-muted)] hover:bg-[var(--color-bg-hover)] hover:text-[var(--color-text)]')
                    }
                  >
                    {view === 'rendered' ? 'Rendered' : 'Source'}
                  </button>
                ))}
              </div>
            )}
            {showContents && (
              <button
                type="button"
                onClick={toggleContents}
                aria-expanded={contentsOpen}
                aria-controls={CONTENTS_PANEL_ID}
                title={contentsOpen ? 'Hide contents' : 'Show contents'}
                className={
                  MODAL_HEADER_ACTION +
                  (contentsOpen
                    ? ' bg-[var(--color-accent)]/15 text-[var(--color-accent)]'
                    : ' text-[var(--color-text-muted)] hover:bg-[var(--color-bg-hover)] hover:text-[var(--color-text)]')
                }
              >
                <TableOfContents size={12} />
                Contents
              </button>
            )}
            {runSource && (
              <button
                type="button"
                onClick={(event) => {
                  // The Run Script window grows from the click; the preview steps aside for it.
                  const origin = event.detail > 0 ? { x: event.clientX, y: event.clientY } : null
                  void runAgentFile(runSource, origin)
                }}
                disabled={pendingAction !== null || fileGone}
                aria-busy={pendingAction === 'run' || undefined}
                title="Open in the Run Script window (nothing runs until you press Run)"
                className={MODAL_HEADER_ACTION + ' text-[var(--color-text)] hover:bg-[var(--color-bg-hover)]'}
              >
                {pendingAction === 'run' ? (
                  <Loader2 size={12} className="animate-spin motion-reduce:animate-none" aria-hidden />
                ) : (
                  <SquareTerminal size={12} aria-hidden />
                )}
                Run…
              </button>
            )}
            {fileActions && (
              <FileActionsMenu
                key={targetKey}
                dismissed={exiting}
                pendingAction={pendingAction === 'run' ? null : pendingAction}
                fileGone={fileGone}
                onOpen={() => void openAgentFileExternally()}
                onReveal={() => void revealAgentFile()}
                onOpenInBrowser={html ? () => void openInBrowser() : undefined}
                onCopy={() => void copyContent()}
                copyDisabled={nothingToCopy}
                copied={copiedMarkFor === openSeq}
                onPublish={
                  canPublish && agentFile.ref.inside && !isCredentialFileRef(agentFile.ref)
                    ? () => {
                        // The card lands in the chat: the preview steps aside for the dialog.
                        const { agentId, ref, messageId } = agentFile
                        close()
                        useArtifactPublishStore.getState().open({
                          agentId,
                          path: ref.path,
                          kind: ref.kind,
                          chatId: useChatStore.getState().activeChatId,
                          messageId: messageId ?? null
                        })
                      }
                    : undefined
                }
              />
            )}
            {attachmentTarget && html && (
              <button
                type="button"
                onClick={() => void openInBrowser()}
                disabled={pendingAction !== null}
                className={MODAL_HEADER_ICON + ` text-[var(--color-text-muted)]
                  hover:bg-[var(--color-bg-hover)] hover:text-[var(--color-text)] disabled:opacity-50`}
                title="Open in browser"
                aria-label={`Open ${attachmentTarget.filename} in browser`}
              >
                {pendingAction === 'browser' ? <Loader2 size={14} className="animate-spin" /> : <Globe size={14} />}
              </button>
            )}
            {/* An agent file has this in its ⋯ menu. */}
            {!agentFile && kind !== null && kind !== 'image' && !notice && (
              <button
                type="button"
                onClick={() => void copyContent()}
                disabled={nothingToCopy}
                className={MODAL_HEADER_ICON + ` text-[var(--color-text-muted)]
                  hover:bg-[var(--color-bg-hover)] hover:text-[var(--color-text)] disabled:opacity-50`}
                title="Copy content"
                aria-label={`Copy content of ${filename}`}
              >
                {copiedMarkFor === openSeq ? (
                  <Check size={14} className="text-[var(--color-success)]" />
                ) : (
                  <Copy size={14} />
                )}
              </button>
            )}
            <span aria-live="polite" className="sr-only">
              {copiedMarkFor === openSeq ? 'Copied' : ''}
            </span>
            {attachmentTarget && downloadable && (
              <button
                type="button"
                onClick={() => void download(attachmentTarget)}
                disabled={isDownloading}
                className={MODAL_HEADER_ICON + ` text-[var(--color-text-muted)]
                  hover:bg-[var(--color-bg-hover)] hover:text-[var(--color-text)] disabled:opacity-50`}
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
              className={MODAL_HEADER_ICON + ` hover:bg-[var(--color-bg-hover)]
                text-[var(--color-text-muted)] hover:text-[var(--color-text)]`}
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
        {copyResult === 'failed' && (
          <div
            role="alert"
            className="px-5 py-2 text-xs text-[var(--color-danger)] border-b border-[var(--color-border)]"
          >
            Couldn't copy the content: the clipboard refused it.
          </div>
        )}
        {copyResult === 'partial' && (
          <div
            role="status"
            className="px-5 py-2 text-xs text-[var(--color-text-muted)] border-b border-[var(--color-border)]"
          >
            Copied the first {MAX_PREVIEW_MB} MB: the file is larger than the preview reads.
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
            onScroll={(event) => {
              if (!targetKey || scrollKnownFor.current !== targetKey) return
              const { scrollTop } = event.currentTarget
              if (restoredTop.current === scrollTop) return
              restoredTop.current = null
              const { scrollHeight, clientHeight, clientWidth } = event.currentTarget
              const range = scrollHeight - clientHeight
              rememberPreviewView(targetKey, {
                scrollTop,
                share: range > 0 ? scrollTop / range : 0,
                width: clientWidth
              })
            }}
            style={
              !showContents
                ? undefined
                : fullWindow
                  ? panelOpen
                    ? { width: windowWidth - CONTENTS_PANEL_WIDTH, flex: 'none' }
                    : undefined
                  : { width: closedWidth - CARD_BORDER_X, flex: 'none' }
            }
            className={
              (htmlRendered
                ? 'overflow-hidden'
                : imageShown
                  ? 'px-5 py-4 overflow-auto flex items-center justify-center'
                  : 'px-5 py-4 overflow-auto') +
              ' flex-1 min-w-0 rounded-b-xl focus-visible:outline-2' +
              ' focus-visible:-outline-offset-2 focus-visible:outline-[var(--color-accent)]'
            }
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
                {kind === 'image' ? (
                  image && <ImagePreview image={image} alt={filename} fullWindow={fullWindow} />
                ) : kind === 'markdown' ? (
                  <div
                    // Prose stays at the card's measure: filling a wide window, its lines would run to 150 characters.
                    className={fullWindow ? 'mx-auto' : undefined}
                    style={fullWindow ? { maxWidth: closedWidth } : undefined}
                  >
                    <MarkdownPreview key={targetKey} card={markdown.card} body={markdown.body} />
                  </div>
                ) : kind === 'diff' ? (
                  <DiffPreview key={targetKey} text={text} parsed={diff} />
                ) : kind === 'xml' ? (
                  <XmlPreview key={targetKey} text={text} parsed={xml} truncated={truncated} revealRef={xmlReveal} />
                ) : html && targetKey ? (
                  <HtmlPreview
                    key={targetKey}
                    inputKey={targetKey}
                    input={
                      agentFile
                        ? { type: 'agentFile', agentId: agentFile.agentId, path: agentFile.ref.path }
                        : {
                            type: 'attachment',
                            fileId: attachmentTarget?.id ?? '',
                            source: attachmentTarget?.source ?? 'cinna',
                            filename: attachmentTarget?.filename ?? '',
                            mimeType: attachmentTarget?.mimeType
                          }
                    }
                    view={htmlView}
                    text={text}
                    title={filename}
                    square={fullWindow}
                  />
                ) : (
                  <PreviewBody
                    key={targetKey}
                    kind={kind}
                    text={text}
                    filtersEnabled={filtersEnabled}
                    anchorLines={anchorLines}
                    jsonLinesView={jsonLinesView}
                    truncated={truncated}
                  />
                )}
                {truncated && !htmlRendered && (
                  <div className="mt-3 text-[10px] italic text-[var(--color-text-muted)]">
                    {agentFile
                      ? 'Preview truncated — open the file to see the full content.'
                      : downloadable
                        ? 'Preview truncated — download the file to see the full content.'
                        : `Preview truncated at ${MAX_PREVIEW_MB} MB.`}
                  </div>
                )}
              </>
            ) : null}
          </div>
          {showContents && toc && (panelOpen || (closingFor === openSeq && animateWidth && sideBySide && !fullWindow && !reduceMotion)) && (
            <FilePreviewContents
              key={targetKey}
              entries={toc.entries}
              bodyRef={bodyRef}
              overlay={!sideBySide}
              left={fullWindow ? windowWidth - CONTENTS_PANEL_WIDTH : closedWidth - CARD_BORDER_X}
              onBeforeGo={kind === 'xml' ? (line) => xmlReveal.current?.(line) : undefined}
            />
          )}
        </div>
      </div>
    </div>,
    document.body
  )
}

/**
 * The card's height above and below the body — the header and the body's
 * padding — so an image fits the `max-h-[80vh]` card without a scrollbar.
 */
const IMAGE_CHROME_REM = 6

/**
 * An image, fitted inside the card and centred. It renders only once decoded
 * (the store settles after `decode()`), and with its natural size as `width`
 * and `height` so the box is final on the first paint.
 */
function ImagePreview({
  image,
  alt,
  fullWindow
}: {
  image: { url: string; width: number; height: number }
  alt: string
  fullWindow: boolean
}): React.JSX.Element {
  return (
    <img
      data-testid="image-preview"
      src={image.url}
      alt={alt}
      width={image.width || undefined}
      height={image.height || undefined}
      draggable={false}
      className="block max-w-full object-contain"
      style={{ width: 'auto', height: 'auto', maxHeight: `calc(${fullWindow ? 100 : 80}vh - ${IMAGE_CHROME_REM}rem)` }}
    />
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
