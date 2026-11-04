import { createLogger } from '../../../logger/logger'
import type { CoreErrorCode, CoreFrame, CoreOutcome } from './coreDashboardsClient'

const logger = createLogger('dashboard-frame')

/**
 * A cloud tile's frame, relayed through main (D6.3).
 *
 * Main mints the frame (`POST …/component/frame` for a block, the agent's
 * component frame with tile key `preview` for a preview) and keeps what core
 * answered here, in memory only: `frame_url` holds the cap, which is the
 * credential for every file of the frame. The `dash-` handler asks this
 * object for a file by its component-relative path; it fetches
 * `<content base><path>` (GET or HEAD, no Authorization, no redirect
 * followed), and hands back core's status, `Content-Type` and bytes, never
 * core's other headers: the frame server puts its own on.
 *
 * The cap is minted again lazily, at the next request, once it is within
 * {@link REMOTE_FRAME_REFRESH_MS} of `expires_at`, and when `/d/v/` answers
 * 404 (core's answer to an expired or invalid cap, deliberately the same as a
 * missing file; 401/403 are treated alike): at most one re-mint per request,
 * then the request is tried once more and the second answer stands. A mint
 * wakes the environment, so a page of missing files must not mint in a loop:
 * a frame re-mints on a refusal at most once per {@link REMOTE_FRAME_REMINT_GAP_MS};
 * a request refused in between retries with a cap another request minted
 * since its own fetch, else answers the 404. No timer: a released frame is
 * just dropped.
 *
 * Never logs a frame URL, the cap or a path. Core module: no Electron.
 */

/** A cap this close to its expiry is minted again before it is used. */
export const REMOTE_FRAME_REFRESH_MS = 5 * 60_000

/** A frame re-mints on a refused request at most this often. */
export const REMOTE_FRAME_REMINT_GAP_MS = 60_000

/** The text of the relay's own error pages. */
export const REMOTE_FRAME_MESSAGES = {
  envNotRunning: 'The agent’s environment isn’t running.',
  unreachable: 'Can’t reach the Cinna server.',
  unreadable: 'The file could not be read from Cinna.',
  signIn: 'Sign in to Cinna again.',
  tooLarge: 'This file is too large to show.',
  notFound: 'Not found'
} as const

export interface RemoteFrameDeps {
  /** `runtimeHost.http.fetch`: a plain request to core's content origin. */
  fetch: (url: string, init: { method: string; headers: Record<string, string>; redirect: 'manual' }) => Promise<Response>
  /** Mints the frame again (the same call that opened it). */
  mint: () => Promise<CoreOutcome<CoreFrame>>
  maxBytes: number
  now?: () => number
}

export type RemoteFileResult =
  | { ok: true; contentType: string; body: Uint8Array<ArrayBuffer> | null }
  | { ok: false; status: number; message: string }

export type RemoteFrameOpen =
  | { ok: true; frame: RemoteFrame }
  | { ok: false; code: CoreErrorCode | 'invalid_input'; message: string }

/**
 * `frame_url` split into the content base (`<origin>/…/d/v/<cap>/`, core's
 * `frame_cap.content_base`) and the entry path under it (still URL-encoded),
 * or null when it is not that shape.
 */
export function parseFrameUrl(frameUrl: string): { base: string; entry: string } | null {
  let url: URL
  try {
    url = new URL(frameUrl)
  } catch {
    return null
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') return null
  if (url.username || url.password) return null
  const marker = '/d/v/'
  const at = url.pathname.indexOf(marker)
  if (at < 0) return null
  const rest = url.pathname.slice(at + marker.length)
  const slash = rest.indexOf('/')
  if (slash <= 0) return null
  const entry = rest.slice(slash + 1)
  if (!entry) return null
  return { base: `${url.origin}${url.pathname.slice(0, at + marker.length + slash + 1)}`, entry }
}

const TOKEN = /^[\w!#$&^.+-]+\/[\w!#$&^.+-]+$/

/** Core's `Content-Type`, when it is one; anything else is served as bytes. */
export function safeContentType(raw: string | null): string {
  if (!raw || raw.length > 200 || /[\r\n\0]/.test(raw)) return 'application/octet-stream'
  const [type, ...params] = raw.split(';')
  if (!TOKEN.test(type.trim())) return 'application/octet-stream'
  return [type.trim().toLowerCase(), ...params.map((p) => p.trim()).filter(Boolean)].join('; ')
}

/** At most `maxBytes` of a body, or null when there was more (the rest is not read). */
async function readCapped(body: ReadableStream<Uint8Array> | null, maxBytes: number): Promise<Uint8Array<ArrayBuffer> | null> {
  if (!body) return new Uint8Array(0)
  const reader = body.getReader()
  const chunks: Uint8Array[] = []
  let total = 0
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    total += value.length
    if (total > maxBytes) {
      await reader.cancel().catch(() => {})
      return null
    }
    chunks.push(value)
  }
  const bytes = new Uint8Array(total)
  let offset = 0
  for (const chunk of chunks) {
    bytes.set(chunk, offset)
    offset += chunk.length
  }
  return bytes
}

function mintFailure(code: CoreErrorCode): { status: number; message: string } {
  if (code === 'env_unavailable') return { status: 503, message: REMOTE_FRAME_MESSAGES.envNotRunning }
  if (code === 'reauth_required') return { status: 502, message: REMOTE_FRAME_MESSAGES.signIn }
  if (code === 'not_found' || code === 'not_owner') return { status: 404, message: REMOTE_FRAME_MESSAGES.notFound }
  if (code === 'unreachable') return { status: 502, message: REMOTE_FRAME_MESSAGES.unreachable }
  return { status: 502, message: REMOTE_FRAME_MESSAGES.unreadable }
}

interface Cap {
  base: string
  expiresAt: number
}

export class RemoteFrame {
  /** The entry page, component-relative, decoded (`index.html`, `app/index.html`). */
  readonly entry: string
  private cap: Cap
  private minting: Promise<Cap | { failed: CoreErrorCode }> | null = null
  /** When a refusal last made this frame re-mint; null before any. */
  private lastRefusalMint: number | null = null
  /** The last ahead-of-expiry mint that failed, when and why; null after a good one. */
  private lastExpiryFailure: { at: number; code: CoreErrorCode } | null = null
  private readonly now: () => number

  constructor(
    private readonly deps: RemoteFrameDeps,
    first: { base: string; expiresAt: number; entry: string }
  ) {
    this.entry = first.entry
    this.cap = { base: first.base, expiresAt: first.expiresAt }
    this.now = deps.now ?? Date.now
  }

  private remint(): Promise<Cap | { failed: CoreErrorCode }> {
    this.minting ??= this.deps
      .mint()
      .then((outcome): Cap | { failed: CoreErrorCode } => {
        if (!outcome.ok) {
          logger.info('could not mint a cloud frame again', { code: outcome.code })
          return { failed: outcome.code }
        }
        const parsed = parseFrameUrl(outcome.value.frame_url)
        const expiresAt = Date.parse(outcome.value.expires_at)
        if (!parsed || Number.isNaN(expiresAt)) return { failed: 'call_failed' }
        this.cap = { base: parsed.base, expiresAt }
        return this.cap
      })
      .catch((): { failed: CoreErrorCode } => ({ failed: 'unreachable' }))
      .finally(() => {
        this.minting = null
      })
    return this.minting
  }

  /**
   * The cap to retry a refused request with: one another request minted
   * since `used`, or a fresh one when the frame may re-mint now; null to
   * answer the refusal as it is.
   */
  private afterRefusal(used: Cap): Promise<Cap | { failed: CoreErrorCode }> | null {
    if (this.minting) return this.minting
    if (this.cap !== used) return Promise.resolve(this.cap)
    const at = this.now()
    if (this.lastRefusalMint !== null && at - this.lastRefusalMint < REMOTE_FRAME_REMINT_GAP_MS) return null
    this.lastRefusalMint = at
    return this.remint()
  }

  /**
   * The cap for a request. Within {@link REMOTE_FRAME_REFRESH_MS} of expiry
   * it is minted again ahead of time; a mint that failed (every mint wakes the
   * environment) is not tried again for {@link REMOTE_FRAME_REMINT_GAP_MS}:
   * meanwhile the old cap serves while it lasts, and its failure after.
   */
  private async current(): Promise<Cap | { failed: CoreErrorCode }> {
    const at = this.now()
    if (this.cap.expiresAt - REMOTE_FRAME_REFRESH_MS > at) return this.cap
    if (this.minting) return this.minting
    const failed = this.lastExpiryFailure
    if (failed && at - failed.at < REMOTE_FRAME_REMINT_GAP_MS) {
      return this.cap.expiresAt > at ? this.cap : { failed: failed.code }
    }
    const next = await this.remint()
    this.lastExpiryFailure = 'failed' in next ? { at, code: next.failed } : null
    return next
  }

  /**
   * One file of the frame, by its component-relative segments (already
   * checked by the frame server: no empty or dot segment, never `api/`).
   */
  async file(segments: string[], method: 'GET' | 'HEAD'): Promise<RemoteFileResult> {
    const rel = segments.map(encodeURIComponent).join('/')
    let cap = await this.current()
    for (let attempt = 0; ; attempt++) {
      if ('failed' in cap) return { ok: false, ...mintFailure(cap.failed) }
      const target = new URL(rel, cap.base)
      if (!target.href.startsWith(cap.base)) return { ok: false, status: 404, message: REMOTE_FRAME_MESSAGES.notFound }
      let answer: Response
      try {
        answer = await this.deps.fetch(target.href, { method, headers: {}, redirect: 'manual' })
      } catch {
        return { ok: false, status: 502, message: REMOTE_FRAME_MESSAGES.unreachable }
      }
      const refused = answer.status === 401 || answer.status === 403 || answer.status === 404
      if (refused && attempt === 0) {
        const next = this.afterRefusal(cap)
        if (next) {
          await answer.body?.cancel().catch(() => {})
          cap = await next
          continue
        }
      }
      if (answer.status !== 200) {
        await answer.body?.cancel().catch(() => {})
        if (answer.status === 503) return { ok: false, status: 503, message: REMOTE_FRAME_MESSAGES.envNotRunning }
        if (answer.status === 404 || answer.status === 401 || answer.status === 403 || (answer.status >= 300 && answer.status < 400)) {
          return { ok: false, status: 404, message: REMOTE_FRAME_MESSAGES.notFound }
        }
        logger.info('core refused a cloud frame file', { status: answer.status })
        return { ok: false, status: 502, message: REMOTE_FRAME_MESSAGES.unreadable }
      }
      const contentType = safeContentType(answer.headers.get('content-type'))
      if (method === 'HEAD') {
        await answer.body?.cancel().catch(() => {})
        return { ok: true, contentType, body: null }
      }
      const declared = Number(answer.headers.get('content-length'))
      if (Number.isFinite(declared) && declared > this.deps.maxBytes) {
        await answer.body?.cancel().catch(() => {})
        return { ok: false, status: 413, message: REMOTE_FRAME_MESSAGES.tooLarge }
      }
      let body: Uint8Array<ArrayBuffer> | null
      try {
        body = await readCapped(answer.body, this.deps.maxBytes)
      } catch {
        return { ok: false, status: 502, message: REMOTE_FRAME_MESSAGES.unreachable }
      }
      if (!body) return { ok: false, status: 413, message: REMOTE_FRAME_MESSAGES.tooLarge }
      return { ok: true, contentType, body }
    }
  }
}

/**
 * Mint a frame and keep it: the IPC's open-frame for a cloud tile or a cloud
 * preview. Core's refusals come back as their codes, for the renderer's marks.
 */
export async function openRemoteFrame(deps: RemoteFrameDeps): Promise<RemoteFrameOpen> {
  let outcome: CoreOutcome<CoreFrame>
  try {
    outcome = await deps.mint()
  } catch {
    return { ok: false, code: 'unreachable', message: REMOTE_FRAME_MESSAGES.unreachable }
  }
  if (!outcome.ok) return { ok: false, code: outcome.code, message: outcome.message }
  const parsed = parseFrameUrl(outcome.value.frame_url)
  const expiresAt = Date.parse(outcome.value.expires_at)
  let entry: string | null = null
  try {
    entry = parsed ? parsed.entry.split('/').map((segment) => decodeURIComponent(segment)).join('/') : null
  } catch {
    entry = null
  }
  if (!parsed || !entry || Number.isNaN(expiresAt)) {
    logger.warn('core answered a frame that is not a /d/v/ URL')
    return { ok: false, code: 'call_failed', message: 'Cinna answered a frame this app cannot show.' }
  }
  return { ok: true, frame: new RemoteFrame(deps, { base: parsed.base, expiresAt, entry }) }
}
