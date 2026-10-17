import { randomBytes } from 'node:crypto'
import { createLogger } from '../../logger/logger'
import type { ArtifactPreviewTextResult, ArtifactsViewOutcome, ArtifactView } from '../../../shared/artifacts'
import { MAX_PREVIEW_BYTES, decodePreviewText } from '../../../shared/filePreview'
import { HTML_PREVIEW_SCHEME, MAX_HTML_PREVIEW_BYTES } from './htmlPreviewServer'
import { injectPreviewLinkHelper } from './previewLinkHelper'

const logger = createLogger('artifact-preview')

/**
 * A token's host prefix. The HTML preview's tokens are bare hex, so a host
 * starting with this is always an artifact preview's.
 */
export const ARTIFACT_PREVIEW_HOST_PREFIX = 'art-'

/** Open artifact previews at once; the oldest is dropped past it. */
export const MAX_ARTIFACT_PREVIEW_TOKENS = 16

/** A capability this close to its expiry is minted again before it is used. */
export const ARTIFACT_VIEW_REFRESH_MS = 60_000

/**
 * The query a frame adds to show a file on its own rather than as part of a
 * page: a text type is then served as `text/plain`, which a frame displays
 * where a `text/csv` or `text/markdown` would be a download.
 */
export const ARTIFACT_PREVIEW_AS_TEXT = 'cinna-view=text'

/**
 * Core's content policy (`artifact_content.content_csp`), scoped to this
 * scheme instead of core's content origin: the page loads only what the
 * artifact itself holds, plus inline and `data:`/`blob:` as on core. No
 * `frame-ancestors` — the frame is the app's own.
 */
export const ARTIFACT_PREVIEW_CSP =
  "default-src 'none'; " +
  `script-src ${HTML_PREVIEW_SCHEME}: 'unsafe-inline' 'wasm-unsafe-eval' blob:; ` +
  `style-src ${HTML_PREVIEW_SCHEME}: 'unsafe-inline'; ` +
  `img-src ${HTML_PREVIEW_SCHEME}: data: blob:; ` +
  `font-src ${HTML_PREVIEW_SCHEME}: data:; ` +
  `connect-src ${HTML_PREVIEW_SCHEME}: data: blob:; ` +
  `media-src ${HTML_PREVIEW_SCHEME}: data: blob:; ` +
  'worker-src blob:; ' +
  `frame-src ${HTML_PREVIEW_SCHEME}:; ` +
  "form-action 'none'; " +
  "base-uri 'none'"

interface Entry {
  artifactId: string
  /** The profile that asked; the token serves nothing to another. */
  userId: string
  view: ArtifactView
  /** A re-mint in flight, shared by the requests that need it. */
  minting: Promise<ArtifactView | null> | null
}

export interface ArtifactPreviewServerDeps {
  /** The active profile, read on every request. */
  currentUserId: () => string
  /** A fresh view capability (`artifactService.view`) under that profile. */
  mint: (artifactId: string, userId: string) => Promise<ArtifactsViewOutcome>
  /** A plain GET of core's content origin: the capability in the path is the credential, nothing else is sent. */
  fetch: (url: string, init: { method: string; headers: Record<string, string>; redirect: 'manual' }) => Promise<Response>
  now?: () => number
  maxTokens?: number
  newToken?: () => string
}

function securityHeaders(): Record<string, string> {
  return {
    'Content-Security-Policy': ARTIFACT_PREVIEW_CSP,
    'Access-Control-Allow-Origin': '*',
    'Cache-Control': 'no-store',
    'Referrer-Policy': 'no-referrer',
    'X-Content-Type-Options': 'nosniff'
  }
}

function status(code: number, text: string): Response {
  return new Response(text, { status: code, headers: { ...securityHeaders(), 'Content-Type': 'text/plain; charset=utf-8' } })
}

const notFound = (): Response => status(404, 'Not found')

/** A type a frame can show as text: anything `text/*`, JSON, XML, JavaScript. */
export function isTextLike(mime: string): boolean {
  const type = mime.split(';')[0].trim().toLowerCase()
  return (
    type.startsWith('text/') ||
    type === 'application/json' ||
    type === 'application/xml' ||
    type === 'application/javascript' ||
    type.endsWith('+json') ||
    (type.endsWith('+xml') && type !== 'image/svg+xml')
  )
}

/**
 * The relative path under the content base, or null when it would leave it:
 * no empty, `.` or `..` segment, no backslash or NUL, after decoding.
 */
export function artifactRelativePath(pathname: string): string | null {
  const raw = pathname.replace(/^\//, '')
  if (raw === '') return ''
  const segments: string[] = []
  for (const encoded of raw.split('/')) {
    let segment: string
    try {
      segment = decodeURIComponent(encoded)
    } catch {
      return null
    }
    if (segment === '.' || segment === '..' || segment.includes('/') || segment.includes('\\') || segment.includes('\0')) return null
    segments.push(segment)
  }
  // A trailing `/` (a folder's index) is allowed; an empty segment elsewhere is not.
  if (segments.slice(0, -1).some((segment) => segment === '')) return null
  return segments.map((segment) => encodeURIComponent(segment)).join('/')
}

/** At most `maxBytes` of a body, and whether there was more; the rest is not read. */
async function readCapped(body: ReadableStream<Uint8Array> | null, maxBytes: number): Promise<{ bytes: Uint8Array; truncated: boolean }> {
  if (!body) return { bytes: new Uint8Array(0), truncated: false }
  const reader = body.getReader()
  const chunks: Uint8Array[] = []
  let total = 0
  let truncated = false
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    if (total + value.length > maxBytes) {
      chunks.push(value.subarray(0, maxBytes - total))
      total = maxBytes
      truncated = true
      await reader.cancel().catch(() => {})
      break
    }
    chunks.push(value)
    total += value.length
  }
  const bytes = new Uint8Array(total)
  let offset = 0
  for (const chunk of chunks) {
    bytes.set(chunk, offset)
    offset += chunk.length
  }
  return { bytes, truncated }
}

const CLOSED = 'This preview has closed. Open it again.'
const UNREADABLE = 'The file could not be read from Cinna.'

/**
 * The in-app preview of a published artifact: `cinna-preview://art-<token>/<path>`
 * maps to `<content base>/<path>` of a view capability core minted for the
 * active profile. The capability stays here; the renderer only ever holds
 * the token. Every request is re-checked — the profile is still the one that
 * asked, the path stays under the base — and the capability is minted again
 * when it is about to expire. Responses stream through with core's content
 * type and this scheme's sandboxing headers; an HTML page gets the preview's
 * link helper, so a web link opens in the browser.
 */
export function createArtifactPreviewServer(deps: ArtifactPreviewServerDeps) {
  const now = deps.now ?? Date.now
  const maxTokens = deps.maxTokens ?? MAX_ARTIFACT_PREVIEW_TOKENS
  const newToken = deps.newToken ?? (() => `${ARTIFACT_PREVIEW_HOST_PREFIX}${randomBytes(24).toString('hex')}`)
  const entries = new Map<string, Entry>()

  const expired = (view: ArtifactView): boolean => {
    const at = Date.parse(view.expiresAt)
    return Number.isNaN(at) || at - ARTIFACT_VIEW_REFRESH_MS <= now()
  }

  async function freshView(entry: Entry): Promise<ArtifactView | null> {
    if (!expired(entry.view)) return entry.view
    if (!entry.minting) {
      entry.minting = deps
        .mint(entry.artifactId, entry.userId)
        .then((outcome) => {
          if (!outcome.ok) {
            logger.info('could not mint a fresh view', { code: outcome.code })
            return null
          }
          entry.view = outcome.view
          return outcome.view
        })
        .catch(() => null)
        .finally(() => {
          entry.minting = null
        })
    }
    return entry.minting
  }

  return {
    /** Whether a `cinna-preview:` host is an artifact preview's. */
    owns(host: string): boolean {
      return host.startsWith(ARTIFACT_PREVIEW_HOST_PREFIX)
    },

    /** Issue a token for a view core minted for the active profile. */
    /** `userId` is the profile the view was minted for; the active one when omitted. */
    register(artifactId: string, view: ArtifactView, userId: string = deps.currentUserId()): { token: string; baseUrl: string } {
      const token = newToken()
      entries.set(token, { artifactId, userId, view, minting: null })
      while (entries.size > maxTokens) {
        const oldest = entries.keys().next().value
        if (oldest === undefined) break
        entries.delete(oldest)
      }
      return { token, baseUrl: `${HTML_PREVIEW_SCHEME}://${token}/` }
    },

    release(token: unknown): boolean {
      return typeof token === 'string' && entries.delete(token)
    },

    size(): number {
      return entries.size
    },

    /**
     * One file's text, for the preview's own renderers (markdown, a table, a
     * tree): read here through the token's capability under the same checks
     * as a request — the profile that asked, a path under the base — cut at
     * `maxBytes` and decoded as UTF-8. Failures are data.
     */
    async readText(token: unknown, path: unknown, maxBytes = MAX_PREVIEW_BYTES): Promise<ArtifactPreviewTextResult> {
      if (typeof token !== 'string' || typeof path !== 'string' || path === '') {
        return { ok: false, code: 'invalid_input', message: 'Nothing to preview.' }
      }
      const entry = entries.get(token)
      if (!entry) return { ok: false, code: 'not_found', message: CLOSED }
      if (entry.userId !== deps.currentUserId()) {
        entries.delete(token)
        return { ok: false, code: 'not_found', message: CLOSED }
      }
      const rel = artifactRelativePath(path.split('/').map(encodeURIComponent).join('/'))
      if (rel === null || rel === '' || rel.endsWith('/')) {
        logger.info('refused a path outside the artifact')
        return { ok: false, code: 'path_refused', message: 'This file is not part of the artifact.' }
      }
      const view = await freshView(entry)
      if (!view) return { ok: false, code: 'request_failed', message: UNREADABLE }
      const target = new URL(rel, view.contentBase)
      if (!target.href.startsWith(view.contentBase)) {
        return { ok: false, code: 'path_refused', message: 'This file is not part of the artifact.' }
      }
      try {
        const answer = await deps.fetch(target.href, { method: 'GET', headers: {}, redirect: 'manual' })
        if (answer.status !== 200) {
          logger.info('core refused an artifact file', { status: answer.status })
          await answer.body?.cancel().catch(() => {})
          return answer.status === 404 || (answer.status >= 300 && answer.status < 400)
            ? { ok: false, code: 'not_found', message: 'This file is no longer in the artifact.' }
            : { ok: false, code: 'request_failed', message: UNREADABLE }
        }
        const { bytes, truncated } = await readCapped(answer.body, maxBytes)
        return { ok: true, text: decodePreviewText(bytes, truncated), truncated }
      } catch {
        return { ok: false, code: 'request_failed', message: UNREADABLE }
      }
    },

    async handle(request: { url: string; method: string; headers?: Headers }): Promise<Response> {
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
      const rel = artifactRelativePath(url.pathname)
      if (rel === null) {
        logger.info('refused a path outside the artifact')
        return notFound()
      }
      const view = await freshView(entry)
      if (!view) return status(502, 'The artifact could not be read from Cinna.')
      const target = new URL(rel, view.contentBase)
      if (!target.href.startsWith(view.contentBase)) return notFound()
      const headers: Record<string, string> = {}
      const range = request.headers?.get('range')
      if (range) headers.Range = range
      let answer: Response
      try {
        answer = await deps.fetch(target.href, { method: request.method, headers, redirect: 'manual' })
      } catch {
        return status(502, 'The artifact could not be read from Cinna.')
      }
      // Core redirects a folder to its trailing slash: follow it here, inside the base.
      if (answer.status >= 300 && answer.status < 400) {
        const location = answer.headers.get('location')
        const next = location ? new URL(location, target) : null
        if (!next || !next.href.startsWith(view.contentBase)) return notFound()
        const mapped = `${HTML_PREVIEW_SCHEME}://${url.hostname}/${next.href.slice(view.contentBase.length)}`
        return new Response(null, { status: 307, headers: { ...securityHeaders(), Location: mapped } })
      }
      if (!answer.ok && answer.status !== 206) {
        logger.info('core refused an artifact file', { status: answer.status })
        return answer.status === 404 ? notFound() : status(502, 'The artifact could not be read from Cinna.')
      }
      const coreType = answer.headers.get('content-type') ?? 'application/octet-stream'
      const asText = url.search.slice(1).split('&').includes(ARTIFACT_PREVIEW_AS_TEXT) && isTextLike(coreType)
      const contentType = asText ? 'text/plain; charset=utf-8' : coreType
      const out: Record<string, string> = { ...securityHeaders(), 'Content-Type': contentType }
      for (const name of ['content-length', 'content-range', 'accept-ranges']) {
        const value = answer.headers.get(name)
        if (value) out[name.replace(/(^|-)\w/g, (c) => c.toUpperCase())] = value
      }
      const isHtml = !asText && /^(text\/html|application\/xhtml\+xml)\b/i.test(coreType)
      if (request.method === 'HEAD') return new Response(null, { status: answer.status, headers: out })
      if (isHtml && answer.status === 200) {
        const bytes = Buffer.from(await answer.arrayBuffer())
        if (bytes.length > MAX_HTML_PREVIEW_BYTES) return status(413, 'This page is too large to show.')
        const body = injectPreviewLinkHelper(bytes)
        out['Content-Length'] = String(body.length)
        return new Response(new Uint8Array(body), { status: 200, headers: out })
      }
      return new Response(answer.body, { status: answer.status, headers: out })
    }
  }
}

export type ArtifactPreviewServer = ReturnType<typeof createArtifactPreviewServer>
