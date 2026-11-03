import { randomBytes } from 'node:crypto'
import { readFile, realpath, stat } from 'node:fs/promises'
import { join, relative, sep } from 'node:path'
import { createLogger } from '../../logger/logger'
import { isCredentialFilePath } from '../../../shared/agentFiles'
import { isSafeAssetSegment } from '../agentFiles/agentFileService'
import { HTML_PREVIEW_SCHEME, MAX_HTML_PREVIEW_BYTES, htmlPreviewContentType } from './htmlPreviewServer'
import { injectDashboardHelper } from './dashboardHelper'
import { DASHBOARD_FRAME_HOST_PREFIX } from '../../../shared/htmlPreview'

const logger = createLogger('dashboard-frame')

export { DASHBOARD_FRAME_HOST_PREFIX }

/** Mounted frames at once (tiles, previews); the oldest is dropped past it. */
export const MAX_DASHBOARD_FRAMES = 64

/** What a frame shows: a component folder of an agent, found again on every request. */
export interface DashboardFrameTargetRef {
  agentId: string
  component: string
  /** The skill that ships it (its folder may be a read-only cache outside the agent), or null for the agent's own. */
  skill?: string | null
}

export interface ResolvedComponentDir {
  /** Absolute agent folder (for the credential-file rule). */
  agentDir: string
  /** Absolute component folder. */
  componentDir: string
  /**
   * The component folder's agent-relative path (`skills/crm/dashboards/deals`),
   * which the secret rule judges a served file by when the folder is not
   * inside the agent (a skill's cache copy). Unset: the path from `agentDir`.
   */
  agentRelDir?: string
  /** The page the frame opens, relative to the component folder. */
  entry: string
  /** Whether an agent-relative path is secret by the kit's `secret_files` rules. */
  isSecret?: (agentRelPath: string) => boolean
}

export interface DashboardFrameServerDeps {
  /** The active profile, read on every request. */
  currentUserId: () => string
  /** The component's folder now, or null when it is gone (re-read on every request). */
  resolve: (target: DashboardFrameTargetRef) => Promise<ResolvedComponentDir | null> | ResolvedComponentDir | null
  maxFrames?: number
  newToken?: (bytes: number) => string
  maxBytes?: number
}

interface Frame {
  target: DashboardFrameTargetRef
  userId: string
}

/**
 * The frame's content policy, scoped to its own path on the shared host: the
 * page loads and fetches only its own component's files. Never `'self'`
 * (every tile on the host matches it) and never the scheme source (it loads
 * other tokens and the HTML preview's files). `frame-src 'none'`, because the
 * navigation guard lets a frame nested in a preview load the web.
 */
export function dashboardFrameCsp(host: string, tile: string): string {
  const src = `${HTML_PREVIEW_SCHEME}://${host}/${tile}/`
  return (
    "default-src 'none'; " +
    `connect-src ${src}; ` +
    `script-src ${src} 'unsafe-inline'; ` +
    `style-src ${src} 'unsafe-inline'; ` +
    `img-src ${src} data: blob:; ` +
    `font-src ${src} data:; ` +
    `media-src ${src} blob:; ` +
    "form-action 'none'; base-uri 'none'; frame-src 'none'; worker-src 'none'"
  )
}

function headers(contentType: string, csp: string | null): Record<string, string> {
  const out: Record<string, string> = {
    'Content-Type': contentType,
    'Access-Control-Allow-Origin': '*',
    'Cache-Control': 'no-store',
    'Referrer-Policy': 'no-referrer',
    'X-Content-Type-Options': 'nosniff'
  }
  if (csp) out['Content-Security-Policy'] = csp
  return out
}

function status(code: number, text: string, csp: string | null = null): Response {
  return new Response(text, { status: code, headers: headers('text/plain; charset=utf-8', csp) })
}

function isWithin(root: string, candidate: string): boolean {
  return candidate === root || candidate.startsWith(root + sep)
}

/**
 * The dashboard frames' token registry and request handler, without Electron.
 *
 * One host token per profile (`dash-<H>`), minted on first use and dropped
 * when another profile is active; one unguessable path token per mounted
 * frame, released on unmount. Tiles share the host, because each host is its
 * own site to Chromium and costs a renderer process.
 *
 * This handler is the only place a component's page can send a request to
 * (its CSP allows `connect-src` to its own path), so it:
 * - answers GET and HEAD only;
 * - never logs or stores a request's URL or query;
 * - picks the file from the path alone;
 * - serves only files inside the component folder, after realpath: never
 *   `api/` (endpoints run through the bridge), no dot segments, no credential
 *   or secret files.
 */
export function createDashboardFrameServer(deps: DashboardFrameServerDeps) {
  const maxFrames = deps.maxFrames ?? MAX_DASHBOARD_FRAMES
  const maxBytes = deps.maxBytes ?? MAX_HTML_PREVIEW_BYTES
  const newToken = deps.newToken ?? ((bytes: number) => randomBytes(bytes).toString('hex'))
  let host: { userId: string; token: string } | null = null
  const frames = new Map<string, Frame>()

  /** The active profile's host, minted on first use; a host of another profile is dropped with its frames. */
  function hostFor(userId: string): string {
    if (!host || host.userId !== userId) {
      host = { userId, token: newToken(16) }
      frames.clear()
    }
    return `${DASHBOARD_FRAME_HOST_PREFIX}${host.token}`
  }

  return {
    owns(hostname: string): boolean {
      return hostname.startsWith(DASHBOARD_FRAME_HOST_PREFIX)
    },

    /**
     * A frame for `target`, under the active profile: its URL (the entry page)
     * and the path token to release. `entry` is the component's page,
     * already validated.
     */
    register(target: DashboardFrameTargetRef, entry: string, userId: string = deps.currentUserId()): { token: string; url: string } {
      const h = hostFor(userId)
      const token = newToken(16)
      frames.set(token, { target, userId })
      while (frames.size > maxFrames) {
        const oldest = frames.keys().next().value
        if (oldest === undefined) break
        frames.delete(oldest)
      }
      const path = entry.split('/').map(encodeURIComponent).join('/')
      return { token, url: `${HTML_PREVIEW_SCHEME}://${h}/${token}/${path}` }
    },

    release(token: unknown): boolean {
      return typeof token === 'string' && frames.delete(token)
    },

    size(): number {
      return frames.size
    },

    /** Drop the host and every frame (a profile is being left). */
    reset(): void {
      host = null
      frames.clear()
    },

    async handle(request: { url: string; method: string }): Promise<Response> {
      if (request.method !== 'GET' && request.method !== 'HEAD') return status(405, 'Method not allowed')
      let url: URL
      try {
        url = new URL(request.url)
      } catch {
        return status(404, 'Not found')
      }
      const userId = deps.currentUserId()
      if (url.protocol !== `${HTML_PREVIEW_SCHEME}:` || !host) return status(404, 'Not found')
      if (host.userId !== userId) {
        // Another profile is active: nothing minted under the last one serves.
        host = null
        frames.clear()
        return status(404, 'Not found')
      }
      if (url.hostname !== `${DASHBOARD_FRAME_HOST_PREFIX}${host.token}`) return status(404, 'Not found')
      let segments: string[]
      try {
        segments = url.pathname.split('/').slice(1).map((segment) => decodeURIComponent(segment))
      } catch {
        return status(404, 'Not found')
      }
      const [tile, ...file] = segments
      const frame = tile ? frames.get(tile) : undefined
      if (!tile || !frame || frame.userId !== userId) return status(404, 'Not found')
      const csp = dashboardFrameCsp(url.hostname, tile)
      // The file from the path alone: safe segments, never the endpoints.
      if (file.length === 0 || !file.every(isSafeAssetSegment) || file[0].toLowerCase() === 'api') {
        logger.info('refused a dashboard frame request', { status: 404 })
        return status(404, 'Not found', csp)
      }
      const resolved = await deps.resolve(frame.target)
      if (!resolved) return status(404, 'Not found', csp)
      let real: string
      let root: string
      try {
        root = await realpath(resolved.componentDir)
        real = await realpath(join(root, ...file))
      } catch {
        return status(404, 'Not found', csp)
      }
      const rel = relative(root, real).split(sep)
      if (!isWithin(root, real) || real === root || rel[0]?.toLowerCase() === 'api') return status(404, 'Not found', csp)
      let agentReal: string
      try {
        agentReal = await realpath(resolved.agentDir)
      } catch {
        return status(404, 'Not found', csp)
      }
      const agentRel = isWithin(agentReal, real) || !resolved.agentRelDir
        ? relative(agentReal, real).split(sep).join('/')
        : `${resolved.agentRelDir}/${rel.join('/')}`
      if (isCredentialFilePath(real, agentReal) || resolved.isSecret?.(agentRel)) {
        logger.info('refused a credential file to a dashboard frame')
        return status(404, 'Not found', csp)
      }
      let bytes: Buffer
      try {
        const info = await stat(real)
        if (!info.isFile()) return status(404, 'Not found', csp)
        if (info.size > maxBytes) return status(413, 'This file is too large to show.', csp)
        bytes = await readFile(real)
      } catch {
        return status(404, 'Not found', csp)
      }
      const name = file[file.length - 1]
      const contentType = htmlPreviewContentType(name)
      const isHtml = contentType === 'text/html' || contentType === 'application/xhtml+xml'
      const body = isHtml ? injectDashboardHelper(bytes) : bytes
      return new Response(request.method === 'HEAD' ? null : new Uint8Array(body), { status: 200, headers: headers(contentType, csp) })
    }
  }
}

export type DashboardFrameServer = ReturnType<typeof createDashboardFrameServer>
