import { DASHBOARD_BRIDGE_PROTOCOL, type DashboardCallOutcome } from '../../../../shared/dashboards'

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
 *   to `onContext` (D3: the chat panel's context).
 * - **D4 methods**, each only where the host gives the dependency (otherwise
 *   a JSON-RPC error, so the page's promise rejects with `{message}`):
 *   `tools/call` (`cinna.call`) runs one of the component's own endpoints
 *   through `call` and is answered as an MCP tool result — `structuredContent`
 *   plus the JSON as text, or `isError` with the message as text;
 *   `cinna/params-changed` (`setParams`, a notification) hands the params to
 *   `onParams`; `ui/message` (`cinna.ask`) hands the text to `onAsk`, which
 *   fills the panel's composer and never sends (D14); `ui/open-link`
 *   (`cinna.openLink`) refuses anything but http(s) and mailto, allows one waiting link
 *   at a time, and is answered only after the owner decides in `openLink`
 *   (D17). An answer that arrives after the page re-initialised is dropped:
 *   the request died with the old document.
 * - Any other request gets a JSON-RPC error; any other notification is dropped.
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
  /** `tools/call`: run one of the component's own endpoints once (main checks the spec, the rate and the timeout). */
  call?: (endpoint: string, params: Record<string, unknown>) => Promise<DashboardCallOutcome>
  /** `cinna/params-changed`: the page's new params for its tile (or preview). */
  onParams?: (params: Record<string, unknown>) => void
  /** `ui/message`: text for the chat panel's composer, never sent; false when there is no panel here. */
  onAsk?: (text: string) => boolean
  /** `ui/open-link`: ask the owner; resolves true once the link opened, false when declined or it failed. */
  openLink?: (url: string) => Promise<boolean>
  newNonce?: () => string
}

export type BridgeVerdict = 'ignored' | 'rejected' | 'accepted'

function randomNonce(): string {
  const bytes = new Uint8Array(16)
  crypto.getRandomValues(bytes)
  return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('')
}

const METHOD_NOT_FOUND = -32601
const INVALID_PARAMS = -32602
const REQUEST_FAILED = -32000

/** `cinna.ask` text beyond this is cut: a page cannot fill the composer with a book. */
export const MAX_ASK_TEXT = 4000

/** Only these leave the app from a page (http, https, mailto), and only after the owner confirms (D17). */
export function linkTarget(raw: unknown): URL | null {
  if (typeof raw !== 'string' || raw.length > 4096) return null
  try {
    const url = new URL(raw)
    return url.protocol === 'http:' || url.protocol === 'https:' || url.protocol === 'mailto:' ? url : null
  } catch {
    return null
  }
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value)
}

/** A copy without the bridge's `_meta`. */
function withoutMeta(record: Record<string, unknown>): Record<string, unknown> {
  const { _meta: _ignored, ...rest } = record
  return rest
}

/** The text parts of an MCP `content` array, joined. */
function contentText(content: unknown): string {
  if (!Array.isArray(content)) return ''
  return content
    .map((part) => (isPlainObject(part) && part.type === 'text' && typeof part.text === 'string' ? part.text : null))
    .filter((part): part is string => part !== null)
    .join('\n')
}

/** An endpoint's answer as an MCP tool result, which the kit's `cinna.call` reads. */
export function toolResult(outcome: DashboardCallOutcome): Record<string, unknown> {
  if (!outcome.ok) return { isError: true, content: [{ type: 'text', text: outcome.message }] }
  const value = outcome.value === undefined ? null : outcome.value
  return { structuredContent: value, content: [{ type: 'text', text: JSON.stringify(value) }] }
}

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
  /** A `ui/open-link` confirm is on screen: a second one is refused, never stacked. */
  let linkWaiting = false
  /**
   * The owner declined a link from this document: the rest are refused
   * without asking, so a page cannot loop the dialog. A new `ui/initialize`
   * (a reload) asks again.
   */
  let linksDeclined = false

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
        linksDeclined = false
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
      if (message.method === 'cinna/params-changed' && !isRequest) {
        const params = isPlainObject(message.params) ? message.params.params : undefined
        if (!deps.onParams || !isPlainObject(params)) return 'ignored'
        deps.onParams(withoutMeta(params))
        return 'accepted'
      }
      if (!isRequest) return 'ignored'

      const fail = (code: number, text: string): void => {
        deps.post({ jsonrpc: '2.0', id, error: { code, message: text } })
      }
      // Answered later: only to the document that asked (a reload starts a new nonce).
      const asked = nonce
      const answerLater = (reply: Record<string, unknown>): void => {
        if (nonce === asked) deps.post({ jsonrpc: '2.0', id, ...reply })
      }
      const params = isPlainObject(message.params) ? message.params : {}

      if (message.method === 'tools/call' && deps.call) {
        const name = params.name
        const args = params.arguments === undefined ? {} : params.arguments
        if (typeof name !== 'string' || name === '' || !isPlainObject(args)) {
          fail(INVALID_PARAMS, 'tools/call needs an endpoint name and an object of arguments.')
          return 'accepted'
        }
        deps
          .call(name, withoutMeta(args))
          .catch((): DashboardCallOutcome => ({ ok: false, code: 'invalid_input', message: `${name} could not be run.` }))
          .then((outcome) => answerLater({ result: toolResult(outcome) }))
        return 'accepted'
      }
      if (message.method === 'ui/message' && deps.onAsk) {
        const text = contentText(params.content).trim().slice(0, MAX_ASK_TEXT)
        if (text === '') {
          fail(INVALID_PARAMS, 'ui/message needs text content.')
          return 'accepted'
        }
        if (deps.onAsk(text)) deps.post({ jsonrpc: '2.0', id, result: {} })
        else fail(METHOD_NOT_FOUND, 'There is no chat to ask here.')
        return 'accepted'
      }
      if (message.method === 'ui/open-link' && deps.openLink) {
        const url = linkTarget(params.url)
        if (!url) {
          fail(INVALID_PARAMS, 'Only web (http, https) and mailto links open from a dashboard.')
          return 'accepted'
        }
        if (linksDeclined) {
          fail(REQUEST_FAILED, 'The owner declined a link from this page.')
          return 'accepted'
        }
        if (linkWaiting) {
          fail(REQUEST_FAILED, 'Another link is waiting for the owner.')
          return 'accepted'
        }
        linkWaiting = true
        deps
          .openLink(url.href)
          // A failure to ask is not the owner's no: it does not close links for the page.
          .catch(() => null)
          .then((opened) => {
            linkWaiting = false
            if (opened === false && nonce === asked) linksDeclined = true
            answerLater(opened ? { result: {} } : { error: { code: REQUEST_FAILED, message: 'The link was not opened.' } })
          })
        return 'accepted'
      }
      fail(METHOD_NOT_FOUND, `${message.method} is not available here.`)
      return 'accepted'
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
