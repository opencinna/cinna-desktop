import { useEffect, useRef, useState } from 'react'
import { DASHBOARD_FRAME_SANDBOX } from '../../../../../shared/htmlPreview'
import type { CollectedPageContext, DashboardFrameTarget } from '../../../../../shared/dashboards'
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

/** What an agent highlighted on this tile (D5); a preview has no tile and passes none. */
export interface FrameHighlight {
  ids: string[]
  /** The page sent `cinna/highlight-ready`: it draws highlights (once per document). */
  onReady: () => void
  /** That document was replaced by a new load: it is not ready until it says so again. */
  onLost?: () => void
  /** What a highlighted native row says it is: "Highlighted by Sales Agent" (its title and aria-description). */
  label?: string
}

/** `cinna/collect-context` for the focused tile (D5): asked only while `enabled`. */
export interface FrameCollect {
  enabled: boolean
  onCollected: (collected: CollectedPageContext) => void
  /**
   * Bumped by the owner to ask now: focus entering the chat panel's composer.
   * Focus leaving a cross-origin frame for the parent page fires no blur on
   * the iframe element, so the frame itself cannot tell when to ask.
   */
  request?: number
}

/** After data reaches the page, its context is asked once it has drawn it; a burst (cached, then fresh) asks once. */
export const COLLECT_AFTER_DATA_MS = 300

type LinkAsk = { url: string; resolve: (opened: boolean) => void }

/**
 * Talk to one frame: answer its handshake, hand it the data — the cached
 * result first, then fresh ones as they arrive — and the theme. The checks
 * are {@link createBridgeSession}'s; this only wires it to the window.
 *
 * D5: the agent's highlight goes to a page that said it draws one (and again
 * to each re-initialised document that says so), and a focused tile's page is
 * asked what it shows after data reaches it and on each `collect.request`
 * (the composer gained focus), one request at a time.
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
    highlight?: FrameHighlight
    collect?: FrameCollect
  } = {}
): void {
  const theme = useUIStore((s) => s.theme)
  const latest = useRef({ meta, data, theme, onContext, ...bridge })
  latest.current = { meta, data, theme, onContext, ...bridge }
  const sessionRef = useRef<BridgeSession | null>(null)
  const sentAt = useRef<number | null>(null)
  const collectRef = useRef<{ now: () => void; afterData: () => void }>({ now: () => {}, afterData: () => {} })

  useEffect(() => {
    const send = (session: BridgeSession): void => {
      const current = latest.current.data
      if (!current) return
      if (session.sendData(current.value, { stale: current.stale, fetchedAt: current.fetchedAt })) {
        sentAt.current = current.fetchedAt
        collectAfterData()
      }
    }
    // One collect-context in flight; a trigger meanwhile asks once more when it settles.
    let collecting = false
    let collectAgain = false
    let disposed = false
    let afterDataTimer: ReturnType<typeof setTimeout> | null = null
    const collectNow = (): void => {
      if (disposed || !latest.current.collect?.enabled || !session.isInitialized()) return
      if (collecting) {
        collectAgain = true
        return
      }
      collecting = true
      void session.collectContext().then((collected) => {
        collecting = false
        if (disposed) return
        // Focus may have moved to another tile meanwhile: the answer is not this tile's context any more.
        if (collected && latest.current.collect?.enabled) latest.current.collect.onCollected(collected)
        if (collectAgain) {
          collectAgain = false
          collectNow()
        }
      })
    }
    const collectAfterData = (): void => {
      if (!latest.current.collect?.enabled) return
      if (afterDataTimer) clearTimeout(afterDataTimer)
      afterDataTimer = setTimeout(() => {
        afterDataTimer = null
        collectNow()
      }, COLLECT_AFTER_DATA_MS)
    }
    collectRef.current = { now: collectNow, afterData: collectAfterData }
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
      openLink: (url) => latest.current.askLink?.(url) ?? Promise.resolve(false),
      // A tile's page only: a preview has no highlight, and its page's highlight-ready is ignored.
      onHighlightReady: latest.current.highlight
        ? () => {
            latest.current.highlight?.onReady()
            const ids = latest.current.highlight?.ids ?? []
            if (ids.length > 0) session.sendHighlight(ids)
          }
        : undefined,
      onHighlightLost: latest.current.highlight ? () => latest.current.highlight?.onLost?.() : undefined
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
      disposed = true
      if (afterDataTimer) clearTimeout(afterDataTimer)
      window.removeEventListener('message', onMessage)
      queue.cancel()
      session.dispose()
      collectRef.current = { now: () => {}, afterData: () => {} }
      sessionRef.current = null
    }
  }, [iframeRef])

  // A fresh result: send it, once per computation.
  useEffect(() => {
    const session = sessionRef.current
    if (!session || !data || sentAt.current === data.fetchedAt) return
    if (session.sendData(data.value, { stale: data.stale, fetchedAt: data.fetchedAt })) {
      sentAt.current = data.fetchedAt
      collectRef.current.afterData()
    }
  }, [data])

  // The agent's highlight changed (`[]` clears): to a page that draws one.
  const highlightKey = bridge.highlight ? bridge.highlight.ids.join('\u0000') : null
  useEffect(() => {
    if (highlightKey === null) return
    sessionRef.current?.sendHighlight(latest.current.highlight?.ids ?? [])
  }, [highlightKey])

  useEffect(() => {
    // After the theme class lands on the document, so the variables read are the new ones.
    const id = requestAnimationFrame(() => sessionRef.current?.sendHostContext())
    return () => cancelAnimationFrame(id)
  }, [theme])

  // The owner asked for what the page shows now (the composer gained focus); none on mount.
  const collectRequest = bridge.collect?.request ?? 0
  useEffect(() => {
    if (collectRequest > 0) collectRef.current.now()
  }, [collectRequest])
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
  actions,
  highlight,
  collect
}: {
  target: DashboardFrameTarget
  meta: BridgeTileMeta
  data: { value: unknown; fetchedAt: number | null; stale: boolean } | null
  title: string
  /** The page's `setContext`; a tile keeps the last one for the chat panel (D3). */
  onContext?: (context: { summary: string; selection: string[] }) => void
  /** setParams and ask (D4). */
  actions?: BridgeActions
  /** The agent's highlight on this tile (D5); none in a preview. */
  highlight?: FrameHighlight
  /** collect-context while the tile is focused (D5). */
  collect?: FrameCollect
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
    highlight,
    collect,
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
