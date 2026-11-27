import { randomBytes } from 'node:crypto'
import { AGENT_DETAILS_CSP, AGENT_DETAILS_FRAME_HOST_PREFIX } from '../../../shared/agentDetails'
import { HTML_PREVIEW_SCHEME } from './htmlPreviewServer'

/** Open details frames at once; the oldest is dropped past it. */
export const MAX_AGENT_DETAILS_FRAME_TOKENS = 16

interface Entry {
  html: Buffer
  /** The profile that asked; the token serves nothing to another. */
  userId: string
}

export interface AgentDetailsFrameServerDeps {
  /** The active profile, read on every request. */
  currentUserId: () => string
  maxTokens?: number
  newToken?: () => string
}

function securityHeaders(): Record<string, string> {
  return {
    'Content-Security-Policy': AGENT_DETAILS_CSP,
    'Cache-Control': 'no-store',
    'Referrer-Policy': 'no-referrer',
    'X-Content-Type-Options': 'nosniff'
  }
}

function status(code: number, text: string): Response {
  return new Response(text, { status: code, headers: { ...securityHeaders(), 'Content-Type': 'text/plain; charset=utf-8' } })
}

const notFound = (): Response => status(404, 'Not found')

/** One `<meta …>` start tag, attributes quoted or not, `/` as a separator as the HTML parser reads it. */
const META_TAG = /<meta(?=[\s/>])(?:[\s/]+(?:[^\s"'>/=]+(?:\s*=\s*(?:"[^"]*"|'[^']*'|[^\s"'>]+))?))*[\s/]*>/gi
const ATTRIBUTE = /([^\s"'>/=]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'>]+)))?/g

/** An attribute value as the parser reads it: character references decoded, for the ones a page could hide `refresh` behind. */
function decodeAttribute(value: string): string {
  return value
    .replace(/&#x([0-9a-f]+);?/gi, (_m, hex: string) => String.fromCodePoint(parseInt(hex, 16)))
    .replace(/&#([0-9]+);?/g, (_m, dec: string) => String.fromCodePoint(parseInt(dec, 10)))
}

function isRefreshMeta(tag: string): boolean {
  const attributes = tag.replace(/^<meta/i, '').replace(/>$/, '')
  for (const match of attributes.matchAll(ATTRIBUTE)) {
    if (match[1].toLowerCase() !== 'http-equiv') continue
    const value = decodeAttribute(match[2] ?? match[3] ?? match[4] ?? '')
    return value.trim().toLowerCase() === 'refresh'
  }
  return false
}

/**
 * The page without its `<meta http-equiv="refresh">` tags (any case, quoting
 * or attribute order). Belt and braces beside the navigation guard: a page
 * shown here must never send the window, or the browser, anywhere on its own.
 */
export function stripMetaRefresh(html: string): string {
  return html.replace(META_TAG, (tag) => (isRefreshMeta(tag) ? '' : tag))
}

/** One `<a …>` or `<area …>` start tag, parsed like {@link META_TAG}. */
const LINK_TAG = /<(a|area)(?=[\s/>])((?:[\s/]+(?:[^\s"'>/=]+(?:\s*=\s*(?:"[^"]*"|'[^']*'|[^\s"'>]+))?))*)([\s/]*)>/gi

/**
 * Every `https:` link sent to `target="_top"`, its own target replaced. The
 * app window's CSP refuses an `https:` load in a subframe before main's
 * navigation guard sees it, so a plain link would turn the frame into an
 * error page; a `_top` navigation inside a click (the sandbox's
 * `allow-top-navigation-by-user-activation`) reaches the guard, which sends it
 * to the browser. Fragment links stay in the frame. A link this misses only
 * goes dead: the enforcement is the sandbox and the guard, not this.
 */
export function retargetWebLinks(html: string): string {
  return html.replace(LINK_TAG, (tag, name: string, attributes: string, tail: string) => {
    let href: string | null = null
    const kept: string[] = []
    for (const match of attributes.matchAll(ATTRIBUTE)) {
      const attr = match[1].toLowerCase()
      if (attr === 'href' && href === null) href = decodeAttribute(match[2] ?? match[3] ?? match[4] ?? '')
      if (attr === 'target') continue
      kept.push(match[0])
    }
    if (href === null || !/^\s*https:/i.test(href)) return tag
    return `<${name}${kept.map((a) => ` ${a}`).join('')} target="_top"${tail.includes('/') ? ' /' : ''}>`
  })
}

/** C4's viewport tag, word for word. */
export const AGENT_DETAILS_VIEWPORT_META = '<meta name="viewport" content="width=device-width, initial-scale=1">'

function isViewportMeta(tag: string): boolean {
  const attributes = tag.replace(/^<meta/i, '').replace(/>$/, '')
  for (const match of attributes.matchAll(ATTRIBUTE)) {
    if (match[1].toLowerCase() !== 'name') continue
    return decodeAttribute(match[2] ?? match[3] ?? match[4] ?? '').trim().toLowerCase() === 'viewport'
  }
  return false
}

/**
 * C4's viewport rule for a page core never normalised (a folder agent's own
 * file): the tag goes in as the first child of `<head>` — a `<head>` is made
 * after `<html …>`, else after a leading doctype, else at the start — and only
 * when the page has no viewport tag. Nothing else changes.
 */
export function ensureViewportMeta(html: string): string {
  for (const tag of html.match(META_TAG) ?? []) if (isViewportMeta(tag)) return html
  const head = /<head(?=[\s/>])[^>]*>/i.exec(html)
  if (head) return html.slice(0, head.index + head[0].length) + AGENT_DETAILS_VIEWPORT_META + html.slice(head.index + head[0].length)
  const insert = `<head>${AGENT_DETAILS_VIEWPORT_META}</head>`
  const root = /<html(?=[\s/>])[^>]*>/i.exec(html)
  if (root) return html.slice(0, root.index + root[0].length) + insert + html.slice(root.index + root[0].length)
  const prolog = /^(?:\ufeff)?\s*(?:<!doctype[^>]*>)?/i.exec(html)
  const at = prolog ? prolog[0].length : 0
  return html.slice(0, at) + insert + html.slice(at)
}

/**
 * An agent's Details page in the app: `cinna-preview://det-<token>/` serves one
 * HTML document main already holds (core's answer or a folder agent's file),
 * and nothing else — every other path is a 404, so the page can load nothing.
 * The C4 policy is sent as a header beside core's meta tag; the bytes are
 * served as received except for any `<meta http-equiv="refresh">` and the
 * target of `https:` links ({@link retargetWebLinks}), with no link helper (no script could run it: the frame
 * has no `allow-scripts` and the policy has no `script-src`).
 */
export function createAgentDetailsFrameServer(deps: AgentDetailsFrameServerDeps) {
  const maxTokens = deps.maxTokens ?? MAX_AGENT_DETAILS_FRAME_TOKENS
  const newToken = deps.newToken ?? (() => `${AGENT_DETAILS_FRAME_HOST_PREFIX}${randomBytes(24).toString('hex')}`)
  const entries = new Map<string, Entry>()

  return {
    /** Whether a `cinna-preview:` host is a details frame's. */
    owns(host: string): boolean {
      return host.startsWith(AGENT_DETAILS_FRAME_HOST_PREFIX)
    },

    /** A token for one document, served to `userId` (the active profile when omitted). */
    /** `addViewport`: a folder agent's own file, which core's C4 normalisation never saw. */
    register(html: string, userId: string = deps.currentUserId(), options: { addViewport?: boolean } = {}): { token: string; url: string } {
      const token = newToken()
      const page = retargetWebLinks(stripMetaRefresh(html))
      entries.set(token, { html: Buffer.from(options.addViewport ? ensureViewportMeta(page) : page, 'utf8'), userId })
      while (entries.size > maxTokens) {
        const oldest = entries.keys().next().value
        if (oldest === undefined) break
        entries.delete(oldest)
      }
      return { token, url: `${HTML_PREVIEW_SCHEME}://${token}/` }
    },

    release(token: unknown): boolean {
      return typeof token === 'string' && entries.delete(token)
    },

    size(): number {
      return entries.size
    },

    async handle(request: { url: string; method: string }): Promise<Response> {
      if (request.method !== 'GET' && request.method !== 'HEAD') return status(405, 'Method not allowed')
      let url: URL
      try {
        url = new URL(request.url)
      } catch {
        return notFound()
      }
      if (url.protocol !== `${HTML_PREVIEW_SCHEME}:`) return notFound()
      const entry = entries.get(url.hostname)
      if (!entry) return notFound()
      if (entry.userId !== deps.currentUserId()) {
        entries.delete(url.hostname)
        return notFound()
      }
      if (url.pathname !== '/') return notFound()
      const headers = {
        ...securityHeaders(),
        'Content-Type': 'text/html; charset=utf-8',
        'Content-Length': String(entry.html.length)
      }
      if (request.method === 'HEAD') return new Response(null, { status: 200, headers })
      return new Response(new Uint8Array(entry.html), { status: 200, headers })
    }
  }
}

export type AgentDetailsFrameServer = ReturnType<typeof createAgentDetailsFrameServer>
