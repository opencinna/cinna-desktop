import { useEffect, useRef, useState } from 'react'
import { DASHBOARD_FRAME_SANDBOX } from '../../../../../shared/htmlPreview'
import type { DashboardFrameTarget } from '../../../../../shared/dashboards'
import { useUIStore } from '../../../stores/ui.store'
import { createBridgeSession, readHostContext, type BridgeSession, type BridgeTileMeta } from '../componentBridge'
import { coalescePerKey } from '../dashboardContext'
import { OpenLinkDialog } from '../OpenLinkDialog'

/** What the page may ask of its host beyond data and context (D4); each absent one is refused. */
export interface BridgeActions {
  /** `cinna.setParams`: persisted on the tile, or kept by a preview. Coalesced: the partials of a window merged, oldest first. */
  onParams?: (params: Record<string, unknown>) => void
  /** `cinna.ask`: fill the panel's composer (never send); false when there is no panel. Coalesced like setParams. */
  onAsk?: (text: string) => boolean
}

type LinkAsk = { url: string; resolve: (opened: boolean) => void }

/**
 * Talk to one frame: answer its handshake, hand it the data — the cached
 * result first, then fresh ones as they arrive — and the theme. The checks
 * are {@link createBridgeSession}'s; this only wires it to the window.
 */
export function useComponentBridge(
  iframeRef: React.RefObject<HTMLIFrameElement | null>,
  meta: BridgeTileMeta,
  data: { value: unknown; fetchedAt: number | null; stale: boolean } | null,
  onContext?: (context: { summary: string; selection: string[] }) => void,
  bridge: {
    target?: DashboardFrameTarget
    actions?: BridgeActions
    /** The owner is asked before a page's link opens; resolves whether it opened. */
    askLink?: (url: string) => Promise<boolean>
  } = {}
): void {
  const theme = useUIStore((s) => s.theme)
  const latest = useRef({ meta, data, theme, onContext, ...bridge })
  latest.current = { meta, data, theme, onContext, ...bridge }
  const sessionRef = useRef<BridgeSession | null>(null)
  const sentAt = useRef<number | null>(null)

  useEffect(() => {
    const send = (session: BridgeSession): void => {
      const current = latest.current.data
      if (!current) return
      if (session.sendData(current.value, { stale: current.stale, fetchedAt: current.fetchedAt })) sentAt.current = current.fetchedAt
    }
    const session = createBridgeSession({
      frameWindow: () => iframeRef.current?.contentWindow ?? null,
      // The frame's origin is opaque: it cannot be named, so the target is '*'.
      post: (message) => iframeRef.current?.contentWindow?.postMessage(message, '*'),
      hostContext: () => readHostContext(latest.current.theme),
      meta: () => latest.current.meta,
      onInitialized: () => send(session),
      onContext: (context) => latest.current.onContext?.(context),
      call: (endpoint, params) => {
        const target = latest.current.target
        if (!target) return Promise.resolve({ ok: false as const, code: 'invalid_input' as const, message: 'This page cannot call its endpoints here.' })
        return window.api.dashboards.call({ target, endpoint, params })
      },
      // A page posting on every keystroke or pointer move reaches the tile a few times a second; params are merged, the ask is the latest.
      onParams: (params) => queue.push('params', { params }),
      onAsk: (text) => {
        if (!latest.current.actions?.onAsk) return false
        queue.push('ask', { text })
        return true
      },
      openLink: (url) => latest.current.askLink?.(url) ?? Promise.resolve(false)
    })
    const queue = coalescePerKey<{ params?: Record<string, unknown>; text?: string }>((key, value) => {
      const actions = latest.current.actions
      if (key === 'params' && value.params) actions?.onParams?.(value.params)
      else if (key === 'ask' && value.text !== undefined) actions?.onAsk?.(value.text)
    }, undefined, (waiting, next) =>
      // Each setParams names only what it changed: a burst of month, then owner, keeps both.
      waiting.params && next.params ? { params: { ...waiting.params, ...next.params } } : next
    )
    sessionRef.current = session
    const onMessage = (event: MessageEvent): void => {
      session.receive({ source: event.source, origin: event.origin, data: event.data })
    }
    window.addEventListener('message', onMessage)
    return () => {
      window.removeEventListener('message', onMessage)
      queue.cancel()
      sessionRef.current = null
    }
  }, [iframeRef])

  // A fresh result: send it, once per computation.
  useEffect(() => {
    const session = sessionRef.current
    if (!session || !data || sentAt.current === data.fetchedAt) return
    if (session.sendData(data.value, { stale: data.stale, fetchedAt: data.fetchedAt })) sentAt.current = data.fetchedAt
  }, [data])

  useEffect(() => {
    // After the theme class lands on the document, so the variables read are the new ones.
    const id = requestAnimationFrame(() => sessionRef.current?.sendHostContext())
    return () => cancelAnimationFrame(id)
  }, [theme])
}

type FrameState = { status: 'loading' } | { status: 'ready'; url: string } | { status: 'failed'; error: string }

/**
 * An html component's page in its sandboxed frame. The URL is minted for this
 * mount (`cinna-preview://dash-<H>/<tile>/…`) and released on unmount.
 */
export function WebView({
  target,
  meta,
  data,
  title,
  onContext,
  actions
}: {
  target: DashboardFrameTarget
  meta: BridgeTileMeta
  data: { value: unknown; fetchedAt: number | null; stale: boolean } | null
  title: string
  /** The page's `setContext`; a tile keeps the last one for the chat panel (D3). */
  onContext?: (context: { summary: string; selection: string[] }) => void
  /** setParams and ask (D4). */
  actions?: BridgeActions
}): React.JSX.Element {
  const [state, setState] = useState<FrameState>({ status: 'loading' })
  const [link, setLink] = useState<LinkAsk | null>(null)
  const linkRef = useRef<LinkAsk | null>(null)
  linkRef.current = link
  const iframeRef = useRef<HTMLIFrameElement | null>(null)
  const key = 'tileId' in target ? `tile:${target.tileId}` : `component:${target.agentId}:${target.component}`
  const targetRef = useRef(target)
  targetRef.current = target
  useComponentBridge(iframeRef, meta, data, onContext, {
    target,
    actions,
    // The bridge allows one waiting link per frame; the page hears the answer after the owner decides.
    askLink: (url) => new Promise<boolean>((resolve) => setLink({ url, resolve }))
  })
  // A frame that goes away with a link on screen answers it: not opened.
  useEffect(() => () => linkRef.current?.resolve(false), [])
  const closeLink = (opened: boolean): void => {
    link?.resolve(opened)
    setLink(null)
  }

  useEffect(() => {
    let cancelled = false
    let token: string | null = null
    setState({ status: 'loading' })
    window.api.dashboards
      .openFrame(targetRef.current)
      .then((result) => {
        if (!result.ok) {
          if (!cancelled) setState({ status: 'failed', error: result.message })
          return
        }
        if (cancelled) {
          void window.api.dashboards.releaseFrame(result.token).catch(() => {})
          return
        }
        token = result.token
        setState({ status: 'ready', url: result.url })
      })
      .catch(() => {
        if (!cancelled) setState({ status: 'failed', error: 'The page could not be opened.' })
      })
    return () => {
      cancelled = true
      if (token) void window.api.dashboards.releaseFrame(token).catch(() => {})
    }
  }, [key])

  const linkDialog = link && <OpenLinkDialog url={link.url} onDone={closeLink} />
  if (state.status === 'failed') return <p className="px-3 py-2 text-[11px] text-[var(--color-danger)]">{state.error}</p>
  if (state.status === 'loading') return <div className="h-full w-full" />
  return (
    <>
    <iframe
      // Keyed by URL: a new token is a new frame, never a navigation from the old path.
      key={state.url}
      ref={iframeRef}
      data-testid="dashboard-frame"
      src={state.url}
      title={title}
      sandbox={DASHBOARD_FRAME_SANDBOX}
      referrerPolicy="no-referrer"
      className="block h-full w-full border-0 bg-transparent"
    />
    {linkDialog}
    </>
  )
}
