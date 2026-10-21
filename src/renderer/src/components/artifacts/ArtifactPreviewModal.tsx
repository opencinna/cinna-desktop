import { useCallback, useEffect, useId, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { ExternalLink, FileText, Globe, Loader2, PanelLeft, PanelLeftClose, Share2, X } from 'lucide-react'
import { HTML_PREVIEW_SANDBOX } from '../../../../shared/htmlPreview'
import { agentFilePreviewKindFor } from '../../../../shared/agentFiles'
import { previewKindFor, type PreviewRenderKind } from '../../../../shared/filePreview'
import type { ArtifactPreviewOpenResult, ArtifactViewFile, PublishedArtifact } from '../../../../shared/artifacts'
import { useArtifactPreviewStore } from '../../stores/artifactPreview.store'
import { unwrapIpcError } from '../../utils/ipcError'
import { CopyButton, SharePopover } from './ArtifactCard'
import { useArtifactDetail } from '../../hooks/useArtifacts'
import { usePopover } from '../ui/usePopover'
import { useFrontmatter } from '../ui/FrontmatterTable'
import { parseXml } from '../../utils/xmlDocument'
import type { XmlReveal } from '../chat/XmlTree'
import { MarkdownPreview, PreviewBody, XmlPreview } from '../chat/PreviewBody'

/** The file preview's entrance: short enough to never be waited on. */
const ENTRANCE: KeyframeAnimationOptions = { duration: 170, easing: 'cubic-bezier(0.2, 0, 0, 1)' }

/** A press outside the card this soon after the open is the second half of a double-click. */
const OPEN_PRESS_GUARD_MS = 500

/** The file preview's labelled header action. */
const HEADER_ACTION_CLASS =
  'inline-flex items-center gap-1 px-2 py-0.5 rounded-md text-xs font-medium border ' +
  'border-[var(--color-border)] text-[var(--color-text)] hover:bg-[var(--color-bg-hover)] disabled:opacity-50 transition-colors'

type PreviewState =
  | { status: 'loading' }
  | { status: 'ready'; result: Extract<ArtifactPreviewOpenResult, { ok: true }> }
  | { status: 'gone' }
  | { status: 'failed'; message: string }

const encodePath = (path: string): string => path.split('/').map(encodeURIComponent).join('/')

function mimeType(file: ArtifactViewFile): string {
  return file.mime.split(';')[0].trim().toLowerCase()
}

function isHtml(file: ArtifactViewFile): boolean {
  const type = mimeType(file)
  return type === 'text/html' || type === 'application/xhtml+xml'
}

/** A type a frame shows as text once served as `text/plain`. */
function isTextLike(file: ArtifactViewFile): boolean {
  const type = mimeType(file)
  return (
    type.startsWith('text/') ||
    type === 'application/json' ||
    type === 'application/xml' ||
    type === 'application/javascript' ||
    type.endsWith('+json') ||
    (type.endsWith('+xml') && type !== 'image/svg+xml')
  )
}

/** Kinds read as text by main and shown by the file preview's renderers. */
type TextKind = Exclude<PreviewRenderKind, 'html' | 'image'>

/**
 * How one file is shown: a text kind by the file preview's renderer for it
 * (markdown rendered, CSV as a table, …), read as text through main; a page,
 * an image or media in the sandboxed frame; anything else not at all (an
 * archive, a PDF). The kind is the file preview's, by name and then type.
 */
export type ArtifactFileView = { type: 'text'; kind: TextKind } | { type: 'frame'; url: string } | { type: 'none' }

export function artifactFileView(baseUrl: string, file: ArtifactViewFile): ArtifactFileView {
  const url = baseUrl + encodePath(file.path)
  const kind = previewKindFor(file.path, mimeType(file)) ?? agentFilePreviewKindFor(file.path)
  if (kind === 'html' || isHtml(file)) return { type: 'frame', url }
  if (kind === 'image') return { type: 'frame', url }
  if (kind) return { type: 'text', kind }
  if (isTextLike(file)) return { type: 'text', kind: 'text' }
  const type = mimeType(file)
  if (type.startsWith('image/') || type.startsWith('video/') || type.startsWith('audio/')) return { type: 'frame', url }
  return { type: 'none' }
}

/**
 * Whether the file list starts open: only for a files artifact of more than
 * one file. A single file, and a site (it opens its start page), start with
 * the list collapsed.
 */
export function filesPanelOpenByDefault(view: { entry: string | null; files: ArtifactViewFile[] }): boolean {
  return view.entry === null && view.files.length > 1
}

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(bytes < 10 * 1024 ? 1 : 0)} KB`
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
}

/**
 * The in-app preview of a published artifact: the revision core serves now,
 * read through a view capability that main keeps and serves over
 * `cinna-preview:` — the renderer only holds a token. A site shows its start
 * page in the sandboxed frame, files show their first; the file list on the
 * left is open by default only for more than one file of a files artifact
 * (a header toggle shows or hides it). Built like the file preview (expands from the click, pinned to
 * the top, fixed height so nothing moves as it loads). Loading, a failure and
 * a deleted artifact are said inside; nothing closes on an error. The owner
 * also gets Share… in the header, the card's popover, portaled into the
 * dialog: Escape or a press outside closes that popover first, the preview
 * only on the next one. Mounted once, in the artifacts host.
 */
export function ArtifactPreviewModal(): React.JSX.Element | null {
  const artifact = useArtifactPreviewStore((s) => s.artifact)
  const openSeq = useArtifactPreviewStore((s) => s.openSeq)
  const close = useArtifactPreviewStore((s) => s.close)
  if (!artifact) return null
  return <PreviewCard key={openSeq} artifact={artifact} onClose={close} />
}

function PreviewCard({ artifact, onClose }: { artifact: PublishedArtifact; onClose: () => void }): React.JSX.Element {
  const instanceName = useArtifactPreviewStore((s) => s.instanceName)
  const [state, setState] = useState<PreviewState>({ status: 'loading' })
  const [selected, setSelected] = useState<string | null>(null)
  /** The user's choice for the file list; null until they toggle it, when the default applies. */
  const [panelChoice, setPanelChoice] = useState<boolean | null>(null)
  const panelId = useId()
  const [message, setMessage] = useState<string | null>(null)
  const cardRef = useRef<HTMLDivElement>(null)
  /** The card as state too: Share…'s popover is portaled into it once it exists. */
  const [cardElement, setCardElement] = useState<HTMLDivElement | null>(null)
  const setCard = useCallback((element: HTMLDivElement | null) => {
    cardRef.current = element
    setCardElement(element)
  }, [])
  // Share… is the owner's: core says who that is (hidden until it answers).
  const detailQuery = useArtifactDetail(artifact.id)
  const isOwner = detailQuery.data?.ok === true && detailQuery.data.detail.isOwner
  const share = usePopover<HTMLButtonElement, HTMLDivElement>('below-right')
  /** Read by the window listeners below: while Share… is open, Escape and an outside press are its. */
  const shareOpen = useRef(false)
  shareOpen.current = share.open
  const backdropRef = useRef<HTMLDivElement>(null)
  const openedAt = useRef(Date.now())
  const Icon = artifact.kind === 'site' ? Globe : FileText

  // Ask main for a view; the token is released when this preview closes.
  useEffect(() => {
    let cancelled = false
    let token: string | null = null
    window.api.htmlPreview
      .openArtifact(artifact.id)
      .then((result) => {
        if (cancelled) {
          if (result.ok) void window.api.htmlPreview.release(result.token).catch(() => {})
          return
        }
        if (!result.ok) {
          setState(result.code === 'gone' ? { status: 'gone' } : { status: 'failed', message: result.message })
          return
        }
        token = result.token
        setState({ status: 'ready', result })
      })
      .catch((err) => {
        if (!cancelled) setState({ status: 'failed', message: unwrapIpcError(err) })
      })
    return () => {
      cancelled = true
      if (token) void window.api.htmlPreview.release(token).catch(() => {})
    }
  }, [artifact.id])

  // The entrance: from the click that opened it (the centre after a keyboard
  // open), or a fade under reduced motion. Focus moves into the card, and
  // back to what held it on close after a keyboard open.
  useLayoutEffect(() => {
    const card = cardRef.current
    const { origin } = useArtifactPreviewStore.getState()
    const previous = document.activeElement instanceof HTMLElement ? document.activeElement : null
    const animations: Animation[] = []
    if (card && typeof card.animate === 'function') {
      const rect = card.getBoundingClientRect()
      card.style.transformOrigin = origin ? `${origin.x - rect.left}px ${origin.y - rect.top}px` : 'center'
      const reduceMotion = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches ?? false
      animations.push(
        card.animate(
          reduceMotion ? [{ opacity: 0 }, { opacity: 1 }] : [{ opacity: 0, transform: 'scale(0.92)' }, { opacity: 1, transform: 'scale(1)' }],
          ENTRANCE
        )
      )
      const fade = backdropRef.current?.animate?.([{ opacity: 0 }, { opacity: 1 }], ENTRANCE)
      if (fade) animations.push(fade)
    }
    card?.focus({ preventScroll: true })
    return () => {
      for (const animation of animations) animation.cancel()
      if (origin === null && previous?.isConnected) previous.focus({ preventScroll: true })
    }
  }, [])

  // Escape and a press outside close it — unless Share… is open, whose own
  // listeners close it first (its popover lives inside the card, so a press
  // in it is inside).
  useEffect(() => {
    const onKey = (event: KeyboardEvent): void => {
      if (event.key === 'Escape' && !shareOpen.current) onClose()
    }
    const onMouse = (event: MouseEvent): void => {
      if (!cardRef.current || cardRef.current.contains(event.target as Node)) return
      if (shareOpen.current) return
      if (Date.now() - openedAt.current < OPEN_PRESS_GUARD_MS) return
      event.preventDefault()
      onClose()
    }
    window.addEventListener('keydown', onKey)
    window.addEventListener('mousedown', onMouse, true)
    return () => {
      window.removeEventListener('keydown', onKey)
      window.removeEventListener('mousedown', onMouse, true)
    }
  }, [onClose])

  const openInBrowser = async (): Promise<void> => {
    setMessage(null)
    try {
      const result = await window.api.system.openExternal(artifact.url)
      if (!result.success) setMessage(result.error || 'Couldn’t open the browser.')
    } catch (err) {
      setMessage(unwrapIpcError(err, 'Couldn’t open the browser.'))
    }
  }

  const ready = state.status === 'ready' ? state.result : null
  const revision = ready?.revision ?? artifact.revision
  const panelOpen = ready ? (panelChoice ?? filesPanelOpenByDefault(ready)) : false
  const panelLabel = panelOpen ? 'Hide files' : 'Show files'
  const shownPath = ready ? (selected ?? ready.entry ?? ready.files[0]?.path ?? null) : null
  /** With the list hidden, nothing else says which of several files is shown (a site's start page needs no name). */
  const headerPath = ready && !panelOpen && ready.files.length > 1 && shownPath !== ready.entry ? shownPath : null

  return createPortal(
    <div className="fixed inset-0 z-50 flex items-start justify-center px-4 pt-[10vh]">
      <div ref={backdropRef} aria-hidden className="absolute inset-0 bg-black/25" />
      <div
        ref={setCard}
        tabIndex={-1}
        role="dialog"
        aria-modal="true"
        aria-label={`Preview of ${artifact.title}`}
        data-artifact-preview={artifact.id}
        className="relative flex h-[80vh] w-full max-w-6xl flex-col rounded-xl border border-[var(--color-border)] bg-[var(--color-bg-secondary)] shadow-lg focus:outline-none"
      >
        <div className="flex items-center justify-between gap-2 border-b border-[var(--color-border)] px-5 py-3">
          <div className="flex min-w-0 items-center gap-2">
            {/* There from the first frame, disabled until the view is in, so the title never shifts. */}
            <button
              type="button"
              onClick={() => setPanelChoice(!panelOpen)}
              disabled={!ready}
              aria-expanded={panelOpen}
              aria-controls={panelOpen ? panelId : undefined}
              aria-label={panelLabel}
              title={panelLabel}
              className="inline-flex shrink-0 items-center rounded-md border border-[var(--color-border)] p-1 text-[var(--color-text)] transition-colors hover:bg-[var(--color-bg-hover)] disabled:opacity-50 disabled:hover:bg-transparent"
            >
              {panelOpen ? <PanelLeftClose size={12} aria-hidden /> : <PanelLeft size={12} aria-hidden />}
            </button>
            <Icon size={16} className="shrink-0 text-[var(--color-text-muted)]" aria-hidden />
            <div title={artifact.title} className="truncate text-sm font-semibold text-[var(--color-text)]">{artifact.title}</div>
            <span className="shrink-0 text-xs text-[var(--color-text-muted)]">rev {revision}</span>
            {headerPath && (
              <span data-artifact-preview-path title={headerPath} className="min-w-0 truncate text-xs text-[var(--color-text-muted)]">
                · {headerPath}
              </span>
            )}
          </div>
          <div className="flex shrink-0 items-center gap-1.5">
            {/* First in the right-aligned row: appearing when core answers moves none of the others. */}
            {isOwner && (
              <button
                ref={share.triggerRef}
                type="button"
                onClick={() => share.setOpen(!share.open)}
                className={HEADER_ACTION_CLASS}
                aria-haspopup="dialog"
                aria-expanded={share.open}
              >
                <Share2 size={12} aria-hidden />
                Share…
              </button>
            )}
            <button type="button" onClick={() => void openInBrowser()} className={HEADER_ACTION_CLASS} aria-label={`Open ${artifact.title} in the browser`}>
              <ExternalLink size={12} aria-hidden />
              Open in browser
            </button>
            <CopyButton
              text={artifact.url}
              label="Copy link"
              ariaLabel={`Copy link to ${artifact.title}`}
              onFailed={setMessage}
              className={HEADER_ACTION_CLASS}
              minWidth="min-w-[5.5rem] justify-center"
            />
            <button
              type="button"
              onClick={onClose}
              className="rounded p-1 text-[var(--color-text-muted)] transition-colors hover:bg-[var(--color-bg-hover)] hover:text-[var(--color-text)]"
              title="Close"
              aria-label="Close preview"
            >
              <X size={14} />
            </button>
          </div>
        </div>
        {message && (
          <div role="alert" className="border-b border-[var(--color-border)] px-5 py-2 text-xs text-[var(--color-danger)]">{message}</div>
        )}
        <div className="flex min-h-0 flex-1">
          {state.status === 'loading' ? (
            <div className="flex h-fit items-center gap-2 px-5 py-4 text-xs text-[var(--color-text-muted)]">
              <Loader2 size={12} className="animate-spin motion-reduce:animate-none" aria-hidden />
              <span>Loading preview…</span>
            </div>
          ) : state.status === 'gone' ? (
            <div className="px-5 py-4 text-xs text-[var(--color-text-muted)]">
              This artifact was deleted on {instanceName || 'the instance'}.
            </div>
          ) : state.status === 'failed' ? (
            <div className="space-y-2 px-5 py-4 text-xs">
              <p className="text-[var(--color-danger)]">Could not open the preview. Open it in the browser instead.</p>
              <p className="text-[var(--color-text-muted)]">{state.message}</p>
              <button type="button" onClick={() => void openInBrowser()} className={HEADER_ACTION_CLASS}>
                <ExternalLink size={12} aria-hidden />
                Open in browser
              </button>
            </div>
          ) : ready ? (
            <FilesView
              title={artifact.title}
              token={ready.token}
              baseUrl={ready.baseUrl}
              files={ready.files}
              entry={ready.entry}
              selected={shownPath}
              onSelect={setSelected}
              panelOpen={panelOpen}
              panelId={panelId}
              onOpenInBrowser={() => void openInBrowser()}
            />
          ) : null}
        </div>
        {isOwner && <SharePopover artifact={artifact} instanceName={instanceName} popover={share} container={cardElement} />}
      </div>
    </div>,
    document.body
  )
}

function FilesView({
  title,
  token,
  baseUrl,
  files,
  entry,
  selected,
  onSelect,
  panelOpen,
  panelId,
  onOpenInBrowser
}: {
  title: string
  token: string
  baseUrl: string
  files: ArtifactViewFile[]
  /** A site's start page: shown in the frame and titled as the artifact. */
  entry: string | null
  selected: string | null
  onSelect: (path: string) => void
  panelOpen: boolean
  panelId: string
  onOpenInBrowser: () => void
}): React.JSX.Element {
  const file = files.find((candidate) => candidate.path === selected) ?? null
  const shown = file ? artifactFileView(baseUrl, file) : null
  /** Bumped when the shown file is picked again: a page navigated inside its frame starts over. */
  const [reload, setReload] = useState(0)
  const pick = (path: string): void => {
    if (path === selected) setReload((n) => n + 1)
    else onSelect(path)
  }
  const corner = panelOpen ? 'rounded-br-xl' : 'rounded-b-xl'
  return (
    <>
      {panelOpen && <ul id={panelId} aria-label="Files" className="w-64 shrink-0 overflow-auto border-r border-[var(--color-border)] py-2">
        {files.map((candidate) => {
          const current = candidate.path === selected
          return (
            <li key={candidate.path}>
              <button
                type="button"
                aria-current={current || undefined}
                onClick={() => pick(candidate.path)}
                title={candidate.path}
                className={
                  'flex w-full items-center gap-2 px-3 py-1 text-left text-xs transition-colors ' +
                  (current
                    ? 'bg-[var(--color-accent)]/15 text-[var(--color-accent)]'
                    : 'text-[var(--color-text)] hover:bg-[var(--color-bg-hover)]')
                }
              >
                <FileText size={12} className="shrink-0" aria-hidden />
                <span className="min-w-0 flex-1 truncate">{candidate.path}</span>
                <span className="shrink-0 text-[10px] text-[var(--color-text-muted)]">{formatSize(candidate.size)}</span>
              </button>
            </li>
          )
        })}
        {files.length === 0 && <li className="px-3 py-1 text-xs text-[var(--color-text-muted)]">No files.</li>}
      </ul>}
      <div className="min-w-0 flex-1">
        {file && shown?.type === 'text' ? (
          <TextFile key={file.path} token={token} path={file.path} kind={shown.kind} corner={corner} />
        ) : file && shown?.type === 'frame' ? (
          <iframe
            key={`${file.path}#${reload}`}
            data-testid="artifact-preview-frame"
            src={shown.url}
            title={file.path === entry ? title : `${title}: ${file.path}`}
            sandbox={HTML_PREVIEW_SANDBOX}
            referrerPolicy="no-referrer"
            className={`block h-full w-full ${corner} border-0 bg-[var(--color-html-page)]`}
          />
        ) : file ? (
          <div className="space-y-2 px-5 py-4 text-xs text-[var(--color-text-muted)]">
            <p>No preview for this file type.</p>
            <button type="button" onClick={onOpenInBrowser} className={HEADER_ACTION_CLASS}>
              <ExternalLink size={12} aria-hidden />
              Open in browser
            </button>
          </div>
        ) : null}
      </div>
    </>
  )
}

type TextState =
  | { status: 'loading' }
  | { status: 'ready'; text: string; truncated: boolean }
  | { status: 'failed'; message: string }

/**
 * One text file of a files artifact, read by main through the preview's token
 * and shown by the file preview's renderer for its kind. Keyed by the path, so
 * another file starts over at loading; an answer for a file no longer shown is
 * dropped.
 */
function TextFile({ token, path, kind, corner }: { token: string; path: string; kind: TextKind; corner: string }): React.JSX.Element {
  const [state, setState] = useState<TextState>({ status: 'loading' })
  useEffect(() => {
    let cancelled = false
    window.api.htmlPreview
      .readArtifactText(token, path)
      .then((result) => {
        if (cancelled) return
        setState(result.ok ? { status: 'ready', text: result.text, truncated: result.truncated } : { status: 'failed', message: result.message })
      })
      .catch((err) => {
        if (!cancelled) setState({ status: 'failed', message: unwrapIpcError(err, 'The file could not be read.') })
      })
    return () => {
      cancelled = true
    }
  }, [token, path])

  return (
    <div data-testid="artifact-preview-text" className={`h-full overflow-auto ${corner} px-5 py-4`}>
      {state.status === 'loading' ? (
        <div className="flex items-center gap-2 text-xs text-[var(--color-text-muted)]">
          <Loader2 size={12} className="animate-spin motion-reduce:animate-none" aria-hidden />
          <span>Loading file…</span>
        </div>
      ) : state.status === 'failed' ? (
        <div className="text-xs text-[var(--color-danger)]">{state.message}</div>
      ) : (
        <>
          <TextBody kind={kind} text={state.text} truncated={state.truncated} />
          {state.truncated && (
            <div className="mt-3 text-[10px] italic text-[var(--color-text-muted)]">
              Preview truncated — open it in the browser to see the full file.
            </div>
          )}
        </>
      )}
    </div>
  )
}

/** The file preview's renderers, with the parsing its modal does around them. */
function TextBody({ kind, text, truncated }: { kind: TextKind; text: string; truncated: boolean }): React.JSX.Element {
  const markdown = useFrontmatter(kind === 'markdown' ? text : '')
  const xml = useMemo(() => (kind === 'xml' ? parseXml(text) : null), [kind, text])
  const xmlReveal = useRef<XmlReveal | null>(null)
  if (kind === 'markdown') return <MarkdownPreview card={markdown.card} body={markdown.body} />
  if (kind === 'xml') return <XmlPreview text={text} parsed={xml} truncated={truncated} revealRef={xmlReveal} />
  return <PreviewBody kind={kind} text={text} filtersEnabled={false} />
}
