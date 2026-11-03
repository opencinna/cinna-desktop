import { useEffect, useRef, useState } from 'react'
import { DASHBOARD_FRAME_SANDBOX } from '../../../../../shared/htmlPreview'
import type { DashboardFrameTarget } from '../../../../../shared/dashboards'
import { useUIStore } from '../../../stores/ui.store'
import { createBridgeSession, readHostContext, type BridgeSession, type BridgeTileMeta } from '../componentBridge'

/**
 * Talk to one frame: answer its handshake, hand it the data — the cached
 * result first, then fresh ones as they arrive — and the theme. The checks
 * are {@link createBridgeSession}'s; this only wires it to the window.
 */
export function useComponentBridge(
  iframeRef: React.RefObject<HTMLIFrameElement | null>,
  meta: BridgeTileMeta,
  data: { value: unknown; fetchedAt: number | null; stale: boolean } | null,
  onContext?: (context: { summary: string; selection: string[] }) => void
): void {
  const theme = useUIStore((s) => s.theme)
  const latest = useRef({ meta, data, theme, onContext })
  latest.current = { meta, data, theme, onContext }
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
      onContext: (context) => latest.current.onContext?.(context)
    })
    sessionRef.current = session
    const onMessage = (event: MessageEvent): void => {
      session.receive({ source: event.source, origin: event.origin, data: event.data })
    }
    window.addEventListener('message', onMessage)
    return () => {
      window.removeEventListener('message', onMessage)
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
  onContext
}: {
  target: DashboardFrameTarget
  meta: BridgeTileMeta
  data: { value: unknown; fetchedAt: number | null; stale: boolean } | null
  title: string
  /** The page's `setContext`; a tile keeps the last one for the chat panel (D3). */
  onContext?: (context: { summary: string; selection: string[] }) => void
}): React.JSX.Element {
  const [state, setState] = useState<FrameState>({ status: 'loading' })
  const iframeRef = useRef<HTMLIFrameElement | null>(null)
  const key = 'tileId' in target ? `tile:${target.tileId}` : `component:${target.agentId}:${target.component}`
  const targetRef = useRef(target)
  targetRef.current = target
  useComponentBridge(iframeRef, meta, data, onContext)

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

  if (state.status === 'failed') return <p className="px-3 py-2 text-[11px] text-[var(--color-danger)]">{state.error}</p>
  if (state.status === 'loading') return <div className="h-full w-full" />
  return (
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
  )
}
