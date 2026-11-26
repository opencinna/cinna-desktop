import { useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { BookOpenText, Loader2, RefreshCw, X } from 'lucide-react'
import Markdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import {
  AGENT_DETAILS_FRAME_SANDBOX,
  agentDetailsTargetKey,
  type AgentDetailsResult,
  type AgentDetailsTarget
} from '../../../../shared/agentDetails'
import { useAgentDetails } from '../../hooks/useAgentDetails'
import { documentMarkdownComponents, remarkStripHtml } from '../../utils/markdownComponents'
import { unwrapIpcError } from '../../utils/ipcError'
import { MODAL_HEADER_ACTION, MODAL_HEADER_ICON, MODAL_HEADER_SEGMENT, MODAL_HEADER_SEGMENTS } from '../ui/modalHeader'

/** core's P4 labels for the two views of a custom page. */
export const AGENT_DETAILS_TEXT = {
  button: 'Details',
  buttonLabel: (name: string) => `Details of ${name}`,
  versionButtonLabel: (version: string) => `Details of ${version}`,
  title: 'Details',
  publisher: 'Publisher’s page',
  summary: 'Platform summary',
  loading: 'Loading Details…',
  failed: 'Details could not be loaded.',
  retry: 'Retry',
  close: 'Close Details',
  frameTitle: (name: string) => `Details of ${name}`
} as const

/** Whether a Details answer earns a button: an answer, or a failure worth retrying. */
export function agentDetailsShown(result: AgentDetailsResult | undefined): boolean {
  return !!result && (result.ok || result.code === 'unavailable')
}

/** A press outside the card this soon after the open is the second half of a double-click. */
const OPEN_PRESS_GUARD_MS = 500

const HEADER_ACTION_CLASS = MODAL_HEADER_ACTION + ' text-[var(--color-text)] hover:bg-[var(--color-bg-hover)]'

type View = 'publisher' | 'summary'

/**
 * An agent's Details page in a modal: core's answer for a catalog item or a
 * Cinna agent, or a folder agent's own file. Markdown is rendered as a
 * document (raw HTML dropped, images as their alt text, `http(s)` links out);
 * the publisher's HTML is shown in a `cinna-preview://det-…/` frame with no
 * scripts and no same origin, at a fixed height that scrolls inside. A custom
 * page from core also offers the Platform summary. Loading and errors stay in
 * the body with Retry; nothing closes on an error. Escape is taken in the
 * capture phase, so opened inside the catalog dialog it closes only this.
 */
export function AgentDetailsModal({
  target,
  agentName,
  versionLabel,
  onClose,
  overlayAttrs
}: {
  target: AgentDetailsTarget
  agentName: string
  /** The version shown, when one was chosen (a catalog version row). */
  versionLabel?: string
  onClose: () => void
  /** Marks the overlay as part of a surface that closes on an outside press (the catalog dialog). */
  overlayAttrs?: Record<string, string>
}): React.JSX.Element {
  const details = useAgentDetails(target)
  const [view, setView] = useState<View>('publisher')
  const cardRef = useRef<HTMLDivElement>(null)
  const openedAt = useRef(Date.now())
  const onCloseRef = useRef(onClose)
  onCloseRef.current = onClose

  useEffect(() => {
    const previous = document.activeElement instanceof HTMLElement ? document.activeElement : null
    cardRef.current?.focus({ preventScroll: true })
    const onKey = (event: KeyboardEvent): void => {
      if (event.key !== 'Escape') return
      event.stopImmediatePropagation()
      event.preventDefault()
      onCloseRef.current()
    }
    window.addEventListener('keydown', onKey, true)
    // Escape pressed inside the HTML frame, which this document never hears: main forwards it.
    const offFrameEscape = window.api.agentDetails.onEscape(() => onCloseRef.current())
    return () => {
      offFrameEscape()
      window.removeEventListener('keydown', onKey, true)
      if (previous?.isConnected) previous.focus({ preventScroll: true })
    }
  }, [])

  const result = details.data
  const answer = result?.ok ? result.details : null
  const offersSummary = answer?.source === 'custom' && answer.generated !== null
  const shown: View = offersSummary ? view : 'publisher'
  const failure = details.isError
    ? unwrapIpcError(details.error, AGENT_DETAILS_TEXT.failed)
    : result && !result.ok
      ? result.message
      : null

  return createPortal(
    <div {...overlayAttrs} data-agent-details-modal className="fixed inset-0 z-50 flex items-start justify-center px-4 pt-[10vh]">
      <div
        aria-hidden
        className="app-modal-scrim absolute inset-0"
        onMouseDown={(event) => {
          event.preventDefault()
          if (Date.now() - openedAt.current < OPEN_PRESS_GUARD_MS) return
          onClose()
        }}
      />
      <div
        ref={cardRef}
        tabIndex={-1}
        role="dialog"
        aria-modal="true"
        aria-label={`${AGENT_DETAILS_TEXT.title}: ${agentName}`}
        className="relative flex h-[80vh] w-full max-w-4xl flex-col rounded-xl border app-modal-panel focus:outline-none"
      >
        <div className="flex items-center justify-between gap-2 border-b border-[var(--color-border)] py-3 pl-5 pr-5">
          <div className="flex min-w-0 items-center gap-2">
            <BookOpenText size={16} className="shrink-0 text-[var(--color-text-muted)]" aria-hidden />
            <span className="shrink-0 text-sm font-semibold text-[var(--color-text)]">{AGENT_DETAILS_TEXT.title}</span>
            <span title={agentName} className="min-w-0 truncate text-sm text-[var(--color-text-secondary)]">
              {agentName}
            </span>
            {versionLabel && (
              <span data-agent-details-version className="shrink-0 text-xs text-[var(--color-text-muted)]">
                {versionLabel}
              </span>
            )}
          </div>
          <div className="flex shrink-0 items-center gap-1.5">
            {offersSummary && (
              <div role="group" aria-label="Show" className={MODAL_HEADER_SEGMENTS}>
                {(['publisher', 'summary'] as const).map((option) => (
                  <button
                    key={option}
                    type="button"
                    aria-pressed={shown === option}
                    onClick={() => setView(option)}
                    className={
                      MODAL_HEADER_SEGMENT +
                      ' px-2 text-xs font-medium ' +
                      (shown === option
                        ? 'bg-[var(--color-accent)]/15 text-[var(--color-accent)]'
                        : 'text-[var(--color-text-muted)] hover:bg-[var(--color-bg-hover)] hover:text-[var(--color-text)]')
                    }
                  >
                    {option === 'publisher' ? AGENT_DETAILS_TEXT.publisher : AGENT_DETAILS_TEXT.summary}
                  </button>
                ))}
              </div>
            )}
            <button
              type="button"
              onClick={onClose}
              className={MODAL_HEADER_ICON + ' text-[var(--color-text-muted)] hover:bg-[var(--color-bg-hover)] hover:text-[var(--color-text)]'}
              title="Close"
              aria-label={AGENT_DETAILS_TEXT.close}
            >
              <X size={14} />
            </button>
          </div>
        </div>
        <div className="flex min-h-0 flex-1 flex-col">
          {answer ? (
            shown === 'summary' && answer.generated !== null ? (
              <DetailsMarkdown text={answer.generated} />
            ) : answer.format === 'markdown' && answer.markdown !== null ? (
              <DetailsMarkdown text={answer.markdown} />
            ) : (
              <DetailsFrame target={target} title={AGENT_DETAILS_TEXT.frameTitle(agentName)} />
            )
          ) : failure !== null ? (
            <BodyError
              message={failure}
              retrying={details.isFetching}
              // Nothing to retry for a page that is not there (an older version without Details).
              onRetry={result && !result.ok && result.code === 'not_found' ? null : () => void details.refetch()}
            />
          ) : (
            <BodyLoading />
          )}
        </div>
      </div>
    </div>,
    document.body
  )
}

function BodyLoading(): React.JSX.Element {
  return (
    <div role="status" className="flex items-center gap-2 px-5 py-4 text-xs text-[var(--color-text-muted)]">
      <Loader2 size={12} className="animate-spin motion-reduce:animate-none" aria-hidden />
      <span>{AGENT_DETAILS_TEXT.loading}</span>
    </div>
  )
}

function BodyError({ message, retrying, onRetry }: { message: string; retrying: boolean; onRetry: (() => void) | null }): React.JSX.Element {
  if (onRetry === null) return <p className="px-5 py-4 text-xs text-[var(--color-text-muted)]">{message}</p>
  return (
    <div className="space-y-2 px-5 py-4 text-xs">
      <p role="alert" className="text-[var(--color-danger)]">{message}</p>
      <button type="button" onClick={onRetry} disabled={retrying} className={HEADER_ACTION_CLASS}>
        <RefreshCw size={12} className={retrying ? 'animate-spin motion-reduce:animate-none' : ''} aria-hidden />
        {AGENT_DETAILS_TEXT.retry}
      </button>
    </div>
  )
}

function DetailsMarkdown({ text }: { text: string }): React.JSX.Element {
  return (
    <div data-agent-details-markdown tabIndex={0} className="min-h-0 flex-1 overflow-y-auto px-6 py-5">
      <div className="markdown-body mx-auto max-w-3xl break-words text-sm leading-relaxed text-[var(--color-text)]">
        <Markdown remarkPlugins={[remarkGfm, remarkStripHtml]} components={documentMarkdownComponents}>
          {text}
        </Markdown>
      </div>
    </div>
  )
}

type FrameState = { status: 'loading' } | { status: 'ready'; url: string } | { status: 'failed'; message: string }

/**
 * The publisher's HTML: main registers the copy it holds with the `det-`
 * frame server and answers a token, released when this unmounts or the
 * reader switches to the summary. The frame is keyed by its URL, so a new
 * page is a new frame and never an in-frame navigation (main blocks those).
 */
function DetailsFrame({ target, title }: { target: AgentDetailsTarget; title: string }): React.JSX.Element {
  const [state, setState] = useState<FrameState>({ status: 'loading' })
  const [attempt, setAttempt] = useState(0)
  const targetKey = agentDetailsTargetKey(target)
  const targetRef = useRef(target)
  targetRef.current = target

  useEffect(() => {
    let cancelled = false
    let token: string | null = null
    setState({ status: 'loading' })
    window.api.agentDetails
      .openFrame(targetRef.current)
      .then((result) => {
        if (cancelled) {
          if (result.ok) void window.api.agentDetails.releaseFrame(result.token).catch(() => {})
          return
        }
        if (!result.ok) {
          setState({ status: 'failed', message: result.message })
          return
        }
        token = result.token
        setState({ status: 'ready', url: result.url })
      })
      .catch((err) => {
        if (!cancelled) setState({ status: 'failed', message: unwrapIpcError(err, AGENT_DETAILS_TEXT.failed) })
      })
    return () => {
      cancelled = true
      if (token) void window.api.agentDetails.releaseFrame(token).catch(() => {})
    }
  }, [targetKey, attempt])

  if (state.status === 'loading') return <BodyLoading />
  if (state.status === 'failed') {
    return <BodyError message={state.message} retrying={false} onRetry={() => setAttempt((n) => n + 1)} />
  }
  return (
    <iframe
      key={state.url}
      src={state.url}
      sandbox={AGENT_DETAILS_FRAME_SANDBOX}
      title={title}
      referrerPolicy="no-referrer"
      className="min-h-0 w-full flex-1 rounded-b-xl border-0 bg-[var(--color-html-page)]"
    />
  )
}
