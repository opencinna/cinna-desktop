import { randomBytes } from 'node:crypto'
import { createLogger } from '../../logger/logger'
import { agentFileExtension, agentFileName, type AgentFileFailure } from '../../../shared/agentFiles'
import type { AgentFileBytesResult } from '../agentFiles/agentFileService'
import { injectPreviewLinkHelper } from './previewLinkHelper'

const logger = createLogger('html-preview')

/** The scheme the preview frame loads from; registered privileged before `app` is ready. */
export const HTML_PREVIEW_SCHEME = 'cinna-preview'

/** The most a document or asset served to the frame may weigh. */
export const MAX_HTML_PREVIEW_BYTES = 25 * 1024 * 1024

/** Open previews at once; the oldest is dropped past it (a modal that never released). */
export const MAX_HTML_PREVIEW_TOKENS = 16

/** What a token stands for. Names come from the renderer and were checked when it was issued. */
export type HtmlPreviewTarget =
  | { type: 'attachment'; attachmentId: string; source: 'cinna' | 'local'; filename: string }
  | { type: 'agentFile'; agentId: string; path: string }

interface Entry {
  target: HtmlPreviewTarget
  /** The profile that asked; the token serves nothing to another. */
  userId: string
  /** The document's URL segment, decoded. */
  name: string
}

export interface HtmlPreviewServerDeps {
  /** The active profile, read on every request. */
  currentUserId: () => string
  readAttachment: (input: {
    userId: string
    attachmentId: string
    source: 'cinna' | 'local'
    maxBytes: number
  }) => Promise<{ bytes: Buffer; truncated: boolean }>
  readAgentDocument: (input: { agentId: string; path: string }, maxBytes: number) => Promise<AgentFileBytesResult>
  readAgentAsset: (
    input: { agentId: string; path: string },
    segments: string[],
    maxBytes: number
  ) => Promise<AgentFileBytesResult>
  maxBytes?: number
  maxTokens?: number
  /** Unguessable, and lower-case: a standard scheme's host is lower-cased by the URL parser. */
  newToken?: () => string
}

const CONTENT_TYPES: Record<string, string> = {
  html: 'text/html',
  htm: 'text/html',
  xhtml: 'application/xhtml+xml',
  css: 'text/css',
  js: 'text/javascript',
  mjs: 'text/javascript',
  cjs: 'text/javascript',
  json: 'application/json',
  map: 'application/json',
  geojson: 'application/geo+json',
  csv: 'text/csv',
  tsv: 'text/tab-separated-values',
  txt: 'text/plain',
  md: 'text/markdown',
  xml: 'application/xml',
  svg: 'image/svg+xml',
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  webp: 'image/webp',
  avif: 'image/avif',
  bmp: 'image/bmp',
  ico: 'image/x-icon',
  woff: 'font/woff',
  woff2: 'font/woff2',
  ttf: 'font/ttf',
  otf: 'font/otf',
  wasm: 'application/wasm',
  mp4: 'video/mp4',
  webm: 'video/webm',
  mp3: 'audio/mpeg',
  wav: 'audio/wav',
  ogg: 'audio/ogg',
  pdf: 'application/pdf'
}

/** The Content-Type a served file gets, from its extension alone. */
export function htmlPreviewContentType(name: string): string {
  return CONTENT_TYPES[agentFileExtension(name)] ?? 'application/octet-stream'
}

/**
 * Headers on every response. `*` because the frame's origin is opaque (no
 * `allow-same-origin`), so its own script fetching `data.json` is a
 * cross-origin request; nothing is sent with credentials. `no-referrer` keeps
 * the token out of the Referer of the remote requests the page makes.
 */
function headers(contentType: string): Record<string, string> {
  return {
    'Content-Type': contentType,
    'Access-Control-Allow-Origin': '*',
    'Cache-Control': 'no-store',
    'Referrer-Policy': 'no-referrer',
    'X-Content-Type-Options': 'nosniff'
  }
}

function status(code: number, text: string): Response {
  return new Response(text, { status: code, headers: headers('text/plain; charset=utf-8') })
}

const notFound = (): Response => status(404, 'Not found')

function isFailure(result: AgentFileBytesResult): result is AgentFileFailure {
  return !result.success
}

/**
 * The HTML preview's token registry and the `cinna-preview:` request handler,
 * without Electron: `handle` takes a request and answers a `Response`.
 *
 * A token is issued by `html-preview:open` after the same checks the text
 * preview makes, and stands for one document: `cinna-preview://<token>/<name>`.
 * Every request is re-checked — the profile that asked is still the active
 * one, an agent file still passes the agent-file gate (`readHtmlDocument` /
 * `readHtmlAsset`), an attachment is still the user's to read. An attachment
 * serves only its document; an agent file also serves files beside it,
 * inside its folder. No listings, no writes, nothing over the byte cap.
 */
export function createHtmlPreviewServer(deps: HtmlPreviewServerDeps) {
  const maxBytes = deps.maxBytes ?? MAX_HTML_PREVIEW_BYTES
  const maxTokens = deps.maxTokens ?? MAX_HTML_PREVIEW_TOKENS
  const newToken = deps.newToken ?? (() => randomBytes(24).toString('hex'))
  /** Insertion-ordered, so the first key is the oldest. */
  const entries = new Map<string, Entry>()

  async function serveDocument(entry: Entry): Promise<{ bytes: Buffer } | Response> {
    const { target, userId } = entry
    if (target.type === 'attachment') {
      try {
        const read = await deps.readAttachment({
          userId,
          attachmentId: target.attachmentId,
          source: target.source,
          maxBytes
        })
        if (read.truncated) return status(413, 'This file is too large to show.')
        return { bytes: read.bytes }
      } catch {
        return notFound()
      }
    }
    const read = await deps.readAgentDocument({ agentId: target.agentId, path: target.path }, maxBytes)
    if (isFailure(read)) return read.code === 'too_large' ? status(413, read.error) : notFound()
    return { bytes: read.bytes }
  }

  async function serveAsset(entry: Entry, segments: string[]): Promise<{ bytes: Buffer } | Response> {
    const { target } = entry
    // An attachment is one file: there is nothing beside it to serve.
    if (target.type !== 'agentFile') return notFound()
    const read = await deps.readAgentAsset({ agentId: target.agentId, path: target.path }, segments, maxBytes)
    if (isFailure(read)) return read.code === 'too_large' ? status(413, read.error) : notFound()
    return { bytes: read.bytes }
  }

  return {
    /** Issue a token for an already-checked target, for the active profile. */
    register(target: HtmlPreviewTarget): { token: string; url: string } {
      const token = newToken()
      const name = target.type === 'attachment' ? agentFileName(target.filename) : agentFileName(target.path)
      entries.set(token, { target, userId: deps.currentUserId(), name })
      while (entries.size > maxTokens) {
        const oldest = entries.keys().next().value
        if (oldest === undefined) break
        entries.delete(oldest)
      }
      return { token, url: `${HTML_PREVIEW_SCHEME}://${token}/${encodeURIComponent(name)}` }
    },

    /** Forget a token; the frame that used it can load nothing more. */
    release(token: unknown): boolean {
      return typeof token === 'string' && entries.delete(token)
    },

    /** How many tokens are live (for tests and the cap). */
    size(): number {
      return entries.size
    },

    async handle(request: { url: string; method: string }): Promise<Response> {
      const started = Date.now()
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
      // A token outlives nothing: after a profile switch it serves nothing.
      if (entry.userId !== deps.currentUserId()) {
        entries.delete(url.hostname)
        return notFound()
      }
      let segments: string[]
      try {
        segments = url.pathname.split('/').slice(1).map((segment) => decodeURIComponent(segment))
      } catch {
        return notFound()
      }
      const isDocument = segments.length === 1 && segments[0] === entry.name
      const served = isDocument ? await serveDocument(entry) : await serveAsset(entry, segments)
      if (served instanceof Response) {
        logger.info('refused a preview request', { kind: isDocument ? 'document' : 'asset', status: served.status })
        return served
      }
      const name = segments[segments.length - 1] ?? ''
      // The document is HTML whatever its name says (an attachment named by its MIME type).
      const contentType = isDocument
        ? agentFileExtension(name) === 'xhtml'
          ? 'application/xhtml+xml'
          : 'text/html'
        : htmlPreviewContentType(name)
      logger.debug('served a preview request', {
        kind: isDocument ? 'document' : 'asset',
        bytes: served.bytes.length,
        durationMs: Date.now() - started
      })
      // Every HTML page gets the link helper — the entry document and a sibling
      // page reached by a relative link — so its links open in the browser on a click.
      const isHtml = contentType === 'text/html' || contentType === 'application/xhtml+xml'
      const body = isHtml ? injectPreviewLinkHelper(served.bytes) : served.bytes
      return new Response(request.method === 'HEAD' ? null : new Uint8Array(body), {
        status: 200,
        headers: headers(contentType)
      })
    }
  }
}

export type HtmlPreviewServer = ReturnType<typeof createHtmlPreviewServer>
