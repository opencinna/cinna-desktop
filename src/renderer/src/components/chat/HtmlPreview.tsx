import { useEffect, useRef, useState } from 'react'
import { Loader2 } from 'lucide-react'
import { HTML_PREVIEW_SANDBOX, type HtmlPreviewOpenInput } from '../../../../shared/htmlPreview'
import { unwrapIpcError } from '../../utils/ipcError'
import { CodePreview } from './CodePreview'

/** Rendered like a browser, or the markup highlighted. */
export type HtmlPreviewView = 'rendered' | 'source'

/**
 * The html body of the file preview. **Rendered** is the page in a sandboxed
 * frame that main serves over `cinna-preview:` — scripts and remote content
 * run, but the page has an opaque origin, cannot navigate the app and gets no
 * permission (see `host/desktop/htmlPreviewGuards.ts`). **Source** is the text
 * the modal already read, highlighted as HTML.
 *
 * The frame stays mounted while Source shows, so switching back does not
 * reload the page. Its token is released when this unmounts — the preview
 * closing or showing another file.
 */
export function HtmlPreview({
  input,
  inputKey,
  view,
  text,
  title
}: {
  input: HtmlPreviewOpenInput
  /** Identifies `input`: a new key opens a new frame. */
  inputKey: string
  view: HtmlPreviewView
  text: string
  title: string
}): React.JSX.Element {
  return (
    <>
      <div className={view === 'rendered' ? 'h-full' : 'hidden'}>
        <HtmlFrame input={input} inputKey={inputKey} title={title} />
      </div>
      {view === 'source' && <CodePreview text={text} language="xml" />}
    </>
  )
}

type FrameState = { status: 'loading' } | { status: 'ready'; url: string } | { status: 'failed'; error: string }

function HtmlFrame({
  input,
  inputKey,
  title
}: {
  input: HtmlPreviewOpenInput
  inputKey: string
  title: string
}): React.JSX.Element {
  const [state, setState] = useState<FrameState>({ status: 'loading' })
  const latest = useRef(input)
  latest.current = input

  useEffect(() => {
    let cancelled = false
    let token: string | null = null
    setState({ status: 'loading' })
    window.api.htmlPreview
      .open(latest.current)
      .then((result) => {
        if (!result.success) {
          if (!cancelled) setState({ status: 'failed', error: result.error })
          return
        }
        // Closed while main was issuing it: nothing will ever load it.
        if (cancelled) {
          void window.api.htmlPreview.release(result.token).catch(() => {})
          return
        }
        token = result.token
        setState({ status: 'ready', url: result.url })
      })
      .catch((err) => {
        if (!cancelled) setState({ status: 'failed', error: unwrapIpcError(err) })
      })
    return () => {
      cancelled = true
      if (token) void window.api.htmlPreview.release(token).catch(() => {})
    }
  }, [inputKey])

  if (state.status === 'failed') {
    return <div className="px-5 py-4 text-xs text-[var(--color-danger)]">Couldn&apos;t render the page: {state.error}</div>
  }
  if (state.status === 'loading') {
    return (
      <div className="flex items-center gap-2 px-5 py-4 text-xs text-[var(--color-text-muted)]">
        <Loader2 size={12} className="animate-spin" />
        <span>Loading page…</span>
      </div>
    )
  }
  return (
    <iframe
      data-testid="html-preview-frame"
      src={state.url}
      title={title}
      sandbox={HTML_PREVIEW_SANDBOX}
      referrerPolicy="no-referrer"
      className="block h-full w-full border-0 rounded-b-xl bg-[var(--color-html-page)]"
    />
  )
}
