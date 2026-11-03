import { DASHBOARD_BRIDGE_PROTOCOL } from '../../../../shared/dashboards'

/**
 * The host side of one dashboard frame's bridge (MCP Apps JSON-RPC over
 * postMessage), without React or the DOM, so its checks can be tested. The
 * page side is the kit's `protocols/dashboards-bridge.js`, injected unchanged;
 * this follows its `host_contract` (`x-web-view.bridge` in the schema):
 *
 * - **Whose message.** Only one whose `event.source` is this tile's frame
 *   window and whose origin is `"null"` — the frame's sandbox gives it an
 *   opaque origin, so anything else is not this frame's page.
 * - **The nonce.** Issued in the `ui/initialize` result
 *   (`_meta.cinna.nonce`) and rotated on every `ui/initialize`, which is
 *   accepted from the tile's frame at any time: a reloaded or navigated
 *   document starts over, and the old document's nonce dies with it. It is
 *   not reset on the iframe's `load` event: a new document's handshake
 *   arrives before that event. Every other message must carry the current
 *   nonce, where the bridge puts it: `params._meta.cinna.nonce` on a request
 *   or notification, `result._meta.cinna.nonce` / `error.data._meta.cinna.nonce`
 *   on an answer.
 * - **Data only after `initialized`** from the document that holds the nonce.
 * - **D1 methods**: `ui/initialize`, `ui/notifications/initialized`; the host
 *   sends `ui/notifications/tool-result` and
 *   `ui/notifications/host-context-changed`. `ui/update-model-context`
 *   (`cinna.setContext`) is answered `{}` and its `{summary, selection}` handed
 *   to `onContext` (D3: the chat panel's context). `cinna/params-changed`
 *   (`setParams`) is dropped until D4. Any other request —
 *   `tools/call`, `ui/message`, `ui/open-link` — gets a JSON-RPC error, so
 *   `cinna.call` rejects with `{message}`; any other notification is dropped.
 */

export interface BridgeHostContext {
  theme: 'light' | 'dark'
  styles: { variables: Record<string, string> }
}

export interface BridgeTileMeta {
  component: string
  title: string
  params: Record<string, unknown>
  size: string
}

export interface BridgeMessageEvent {
  source: unknown
  origin: string
  data: unknown
}

export interface BridgeSessionDeps {
  /** The tile's frame window now (`iframe.contentWindow`), or null. */
  frameWindow: () => unknown
  /** Post to the frame; the origin is opaque, so the target is `'*'`. */
  post: (message: unknown) => void
  hostContext: () => BridgeHostContext
  meta: () => BridgeTileMeta
  /** The page finished its handshake: send it the data. */
  onInitialized: () => void
  /**
   * The page's `setContext` (`ui/update-model-context`): what it shows and
   * what is selected, kept as the tile's last context for the chat panel (D3).
   */
  onContext?: (context: { summary: string; selection: string[] }) => void
  newNonce?: () => string
}

export type BridgeVerdict = 'ignored' | 'rejected' | 'accepted'

function randomNonce(): string {
  const bytes = new Uint8Array(16)
  crypto.getRandomValues(bytes)
  return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('')
}

const METHOD_NOT_FOUND = -32601

/** Where the bridge carries the nonce on a message it sends. */
function nonceOf(message: Record<string, unknown>): unknown {
  const pick = (holder: unknown): unknown => {
    const meta = holder && typeof holder === 'object' ? (holder as { _meta?: { cinna?: { nonce?: unknown } } })._meta : undefined
    return meta?.cinna?.nonce
  }
  if (message.method !== undefined) return pick(message.params)
  if (message.result !== undefined) return pick(message.result)
  const error = message.error as { data?: unknown } | undefined
  return pick(error?.data)
}

/** At most this many selected ids from one page; a page cannot flood the context. */
const MAX_PAGE_SELECTION = 200
/** A page's summary is capped again when the context is built; this only bounds what is kept. */
const MAX_PAGE_SUMMARY = 16_000

/**
 * `{summary, selection}` from a `ui/update-model-context` request, as the
 * kit's bridge sends it: `structuredContent.summary` / `.selection`, else the
 * text content. Anything else is dropped; ids become strings.
 */
export function readModelContext(params: unknown): { summary: string; selection: string[] } {
  const record = params && typeof params === 'object' ? (params as Record<string, unknown>) : {}
  const structured = record.structuredContent && typeof record.structuredContent === 'object'
    ? (record.structuredContent as Record<string, unknown>)
    : {}
  let summary = typeof structured.summary === 'string' ? structured.summary : ''
  if (!summary && Array.isArray(record.content)) {
    summary = record.content
      .map((part) => (part && typeof part === 'object' && (part as { type?: unknown }).type === 'text' ? (part as { text?: unknown }).text : null))
      .filter((part): part is string => typeof part === 'string')
      .join('\n')
  }
  const selection = Array.isArray(structured.selection)
    ? structured.selection
        .filter((id): id is string | number => (typeof id === 'string' && id !== '') || (typeof id === 'number' && Number.isFinite(id)))
        .slice(0, MAX_PAGE_SELECTION)
        .map(String)
    : []
  return { summary: summary.slice(0, MAX_PAGE_SUMMARY), selection }
}

export function createBridgeSession(deps: BridgeSessionDeps) {
  const newNonce = deps.newNonce ?? randomNonce
  let nonce: string | null = null
  let initialized = false

  return {
    /** Judge one `message` event from the window; answers the page when it should. */
    receive(event: BridgeMessageEvent): BridgeVerdict {
      const frame = deps.frameWindow()
      if (!frame || event.source !== frame) return 'ignored'
      if (event.origin !== 'null') return 'rejected'
      const message = event.data as Record<string, unknown> | null
      if (!message || typeof message !== 'object' || message.jsonrpc !== '2.0') return 'rejected'
      const id = message.id
      const isRequest = typeof id === 'number' || typeof id === 'string'

      if (typeof message.method !== 'string') {
        // An answer to a host request: the host sends none in D1.
        return nonce && nonceOf(message) === nonce ? 'ignored' : 'rejected'
      }

      if (message.method === 'ui/initialize') {
        if (!isRequest) return 'rejected'
        nonce = newNonce()
        initialized = false
        const meta = deps.meta()
        deps.post({
          jsonrpc: '2.0',
          id,
          result: {
            protocolVersion: DASHBOARD_BRIDGE_PROTOCOL,
            hostInfo: { name: 'cinna-desktop', version: '1' },
            hostCapabilities: {},
            hostContext: deps.hostContext(),
            _meta: { cinna: { nonce, ...meta } }
          }
        })
        return 'accepted'
      }

      if (!nonce || nonceOf(message) !== nonce) return 'rejected'

      if (message.method === 'ui/notifications/initialized') {
        if (!initialized) {
          initialized = true
          deps.onInitialized()
        }
        return 'accepted'
      }
      if (message.method === 'ui/update-model-context' && isRequest) {
        // setContext: the tile's last {summary, selection}, for the chat panel's context.
        deps.onContext?.(readModelContext(message.params))
        deps.post({ jsonrpc: '2.0', id, result: {} })
        return 'accepted'
      }
      if (isRequest) {
        deps.post({ jsonrpc: '2.0', id, error: { code: METHOD_NOT_FOUND, message: `${message.method} is not available here.` } })
        return 'accepted'
      }
      return 'ignored'
    },

    /** The source's data: the cached result (`stale`) first, then fresh. Only after `initialized`. */
    sendData(data: unknown, meta: { stale: boolean; fetchedAt: number | null }): boolean {
      if (!initialized) return false
      deps.post({
        jsonrpc: '2.0',
        method: 'ui/notifications/tool-result',
        params: { structuredContent: data, content: [], _meta: { cinna: { stale: meta.stale, fetched_at: meta.fetchedAt } } }
      })
      return true
    },

    /** The theme changed. Only after `initialized`. */
    sendHostContext(): boolean {
      if (!initialized) return false
      deps.post({ jsonrpc: '2.0', method: 'ui/notifications/host-context-changed', params: deps.hostContext() })
      return true
    },

    isInitialized(): boolean {
      return initialized
    }
  }
}

export type BridgeSession = ReturnType<typeof createBridgeSession>

/** The app's colours a page can match, as `--cinna-*` variables. */
const THEME_VARIABLES = ['bg', 'bg-secondary', 'bg-tertiary', 'text', 'text-secondary', 'text-muted', 'border', 'accent', 'danger', 'success', 'warning'] as const

/** The host context from the app's own CSS variables, read now. */
export function readHostContext(theme: 'light' | 'dark'): BridgeHostContext {
  const style = typeof document !== 'undefined' ? getComputedStyle(document.documentElement) : null
  const variables: Record<string, string> = {}
  for (const name of THEME_VARIABLES) {
    const value = style?.getPropertyValue(`--color-${name}`).trim()
    if (value) variables[`--cinna-${name}`] = value
  }
  return { theme, styles: { variables } }
}
