import { io } from 'socket.io-client'
import { CinnaReauthRequired } from '../../../auth/cinna-oauth'
import { cinnaSessionGeneration } from '../../../auth/cinna-session'
import { getCinnaAccessToken } from '../../../auth/cinna-tokens'
import { createLogger } from '../../../logger/logger'
import { resolveBaseUrl } from '../../cinna-http'

const logger = createLogger('dashboards')

/**
 * Core's events for cloud tiles over socket.io (D6.7).
 *
 * - One connection to `<server>` with `path: '/ws'` and `auth: {token}` (the
 *   profile's Cinna access token), open while `want(userId, true)` holds, i.e.
 *   while a dashboard with cloud tiles is on screen (the refresh service says
 *   so from its leases). socket.io asks for `auth` again on every reconnect,
 *   so each one gets a fresh token (`getCinnaAccessToken` refreshes it near
 *   expiry), as core's web client does.
 * - Closed {@link CLOSE_DEBOUNCE_MS} after `want(…, false)` (a dashboard
 *   switch does not drop and reopen it), on `closeAll`, when another profile
 *   wants one, and when the profile's Cinna session changed
 *   (`cinnaSessionGeneration`): the next reconnect then opens a new one. A
 *   session that needs a new sign-in stops it until the session changes.
 * - Core emits every event as `event` with `{type, model_id, meta, …}`;
 *   handled: `dashboard_tile_updated` (`meta.block_id`) and
 *   `dashboard_tile_highlight` (`meta.block_id`, `meta.ids`), handed to the
 *   handlers below by block id. Matching a block to a tile is the handler's job.
 * - `isLive(userId)`: connected now. Without it, the refresh service re-reads
 *   on-screen cloud tiles every `CLOUD_TILE_POLL_MS`.
 *
 * Never logs the server URL or a token. Core module: plain Node, no Electron.
 */
export interface CoreEventHandlers {
  tileUpdated: (userId: string, coreBlockId: string) => void
  tileHighlight: (userId: string, coreBlockId: string, ids: string[]) => void
  /**
   * The socket (re)connected: core may have recovered from an outage, and
   * events sent while it was down are lost, so on-screen tiles re-read.
   */
  connected?: (userId: string) => void
}

export interface CoreEvents {
  /** Whether a dashboard with cloud tiles is on screen for this profile. */
  want: (userId: string, on: boolean) => void
  isLive: (userId: string) => boolean
  /** Set once at startup (hub/core.ts). */
  setHandlers: (handlers: CoreEventHandlers) => void
  /** Profile closing or quit. */
  closeAll: () => void
}

/** How long a connection outlives the last dashboard that wanted it. */
export const CLOSE_DEBOUNCE_MS = 5_000
/** A connection core closed itself is opened again after this. */
export const SERVER_CLOSE_RETRY_MS = 5_000
/**
 * A connect core refused (its `connect` returned False: a token it did not
 * take, or an empty one after a failed refresh) is tried again after this,
 * doubling per refusal up to {@link CONNECT_REFUSED_RETRY_MAX_MS}. socket.io
 * gives up on such a refusal (CONNECT_ERROR → `destroy()`), so this is the
 * only retry it gets.
 */
export const CONNECT_REFUSED_RETRY_MS = 5_000
export const CONNECT_REFUSED_RETRY_MAX_MS = 5 * 60_000

/** The part of a socket.io client socket this module uses. */
export interface CoreSocket {
  readonly connected: boolean
  /** False once socket.io stopped trying on its own (a refused connect, a server disconnect). */
  readonly active?: boolean
  on(event: string, listener: (...args: unknown[]) => void): unknown
  connect(): unknown
  disconnect(): unknown
}

export interface CoreSocketOptions {
  path: string
  transports: string[]
  reconnection: boolean
  reconnectionDelayMax: number
  auth: (cb: (data: Record<string, unknown>) => void) => void
}

export interface CoreEventsDeps {
  socket: (url: string, options: CoreSocketOptions) => CoreSocket
  /** The profile's server URL; throws when the profile is not signed in to Cinna. */
  baseUrl: (userId: string) => string
  token: (userId: string) => Promise<string>
  generation: (userId: string) => number
  isReauth: (err: unknown) => boolean
  setTimeout?: (fn: () => void, ms: number) => unknown
  clearTimeout?: (handle: unknown) => void
}

interface Connection {
  userId: string
  generation: number
  socket: CoreSocket
  wanted: boolean
  closeTimer: unknown
  retryTimer: unknown
  /** Refused connects in a row, for the backoff; reset on connect. */
  refusals: number
  closed: boolean
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value)
}

export function createCoreEvents(deps: CoreEventsDeps): CoreEvents & { coreEventHandlers: () => CoreEventHandlers | null } {
  const later = deps.setTimeout ?? ((fn: () => void, ms: number) => {
    const handle = setTimeout(fn, ms)
    handle.unref?.()
    return handle
  })
  const cancel = deps.clearTimeout ?? ((handle: unknown) => clearTimeout(handle as ReturnType<typeof setTimeout>))
  let handlers: CoreEventHandlers | null = null
  let conn: Connection | null = null
  /** A profile whose session needs a new sign-in, at that session generation: no socket until it changes. */
  const blocked = new Map<string, number>()

  function close(target: Connection | null): void {
    if (!target || target.closed) return
    target.closed = true
    if (target.closeTimer !== null) cancel(target.closeTimer)
    if (target.retryTimer !== null) cancel(target.retryTimer)
    target.closeTimer = null
    target.retryTimer = null
    try {
      target.socket.disconnect()
    } catch {
      /* already gone */
    }
    if (conn === target) conn = null
  }

  function route(userId: string, data: unknown): void {
    if (!isRecord(data) || !handlers) return
    const meta = isRecord(data.meta) ? data.meta : {}
    const blockId = typeof meta.block_id === 'string' && meta.block_id ? meta.block_id : null
    if (!blockId) return
    try {
      if (data.type === 'dashboard_tile_updated') handlers.tileUpdated(userId, blockId)
      else if (data.type === 'dashboard_tile_highlight') {
        const ids = Array.isArray(meta.ids) ? meta.ids.filter((id): id is string => typeof id === 'string') : []
        handlers.tileHighlight(userId, blockId, ids)
      }
    } catch (err) {
      logger.warn('a core event handler failed', { type: String(data.type), error: err instanceof Error ? err.message : String(err) })
    }
  }

  function open(userId: string): void {
    let url: string
    try {
      url = deps.baseUrl(userId)
    } catch {
      return // not a Cinna profile, or no server: nothing to connect to
    }
    const generation = deps.generation(userId)
    let current: Connection | null = null
    const socket = deps.socket(url, {
      path: '/ws',
      transports: ['websocket', 'polling'],
      reconnection: true,
      reconnectionDelayMax: 30_000,
      // Asked on every (re)connect: a fresh token each time.
      auth: (cb) => {
        const self = current
        if (!self || self.closed) return
        if (deps.generation(userId) !== self.generation) {
          // The profile signed in again (or out): this connection's session is over.
          const reopen = self.wanted
          close(self)
          if (reopen && !conn) open(userId)
          return
        }
        deps.token(userId).then(
          (token) => {
            if (!self.closed) cb({ token })
          },
          (err) => {
            if (self.closed) return
            if (deps.isReauth(err)) {
              logger.info('core events stopped: the Cinna session needs a new sign-in')
              blocked.set(userId, self.generation)
              close(self)
              return
            }
            // A transient failure: socket.io refuses the empty token and retries with backoff.
            cb({ token: '' })
          }
        )
      }
    })
    current = { userId, generation, socket, wanted: true, closeTimer: null, retryTimer: null, refusals: 0, closed: false }
    conn = current
    const self = current
    socket.on('event', (data: unknown) => {
      if (!self.closed) route(userId, data)
    })
    socket.on('connect', () => {
      self.refusals = 0
      logger.debug('core events connected')
      if (self.closed || !handlers?.connected) return
      try {
        handlers.connected(userId)
      } catch (err) {
        logger.warn('a core event handler failed', { type: 'connect', error: err instanceof Error ? err.message : String(err) })
      }
    })
    socket.on('disconnect', (reason: unknown) => {
      if (self.closed) return
      // Core closed it: socket.io does not reconnect on its own then.
      if (reason === 'io server disconnect' && self.retryTimer === null) {
        self.retryTimer = later(() => {
          self.retryTimer = null
          if (!self.closed) self.socket.connect()
        }, SERVER_CLOSE_RETRY_MS)
      }
    })
    socket.on('connect_error', () => {
      if (self.closed) return
      // A transport failure: socket.io is still reconnecting on its own.
      if (socket.active !== false) {
        logger.debug('core events could not connect; socket.io retries')
        return
      }
      // Core refused the connect: socket.io has given up, so retry here with a backoff (a fresh token each time).
      if (self.retryTimer !== null) return
      const delay = Math.min(CONNECT_REFUSED_RETRY_MS * 2 ** self.refusals, CONNECT_REFUSED_RETRY_MAX_MS)
      self.refusals += 1
      logger.debug('core refused the events connection; trying again later', { delayMs: delay })
      self.retryTimer = later(() => {
        self.retryTimer = null
        if (!self.closed) self.socket.connect()
      }, delay)
    })
  }

  return {
    want(userId, on) {
      if (on) {
        if (conn && conn.userId !== userId) close(conn) // another profile is active now
        const stuck = blocked.get(userId)
        if (stuck !== undefined) {
          if (stuck === deps.generation(userId)) return
          blocked.delete(userId)
        }
        if (conn && conn.generation !== deps.generation(userId)) close(conn)
        if (conn) {
          conn.wanted = true
          if (conn.closeTimer !== null) cancel(conn.closeTimer)
          conn.closeTimer = null
          return
        }
        open(userId)
        return
      }
      const target = conn
      if (!target || target.userId !== userId || !target.wanted) return
      target.wanted = false
      target.closeTimer = later(() => {
        target.closeTimer = null
        if (!target.wanted) close(target)
      }, CLOSE_DEBOUNCE_MS)
    },

    isLive(userId) {
      return !!conn && conn.userId === userId && !conn.closed && conn.socket.connected
    },

    setHandlers(next) {
      handlers = next
    },

    closeAll() {
      close(conn)
      blocked.clear()
    },

    coreEventHandlers: () => handlers
  }
}

const instance = createCoreEvents({
  socket: (url, options) => io(url, options) as unknown as CoreSocket,
  baseUrl: resolveBaseUrl,
  token: getCinnaAccessToken,
  generation: cinnaSessionGeneration,
  isReauth: (err) => err instanceof CinnaReauthRequired
})

export const coreEvents: CoreEvents = {
  want: instance.want,
  isLive: instance.isLive,
  setHandlers: instance.setHandlers,
  closeAll: instance.closeAll
}

/** For the implementation and tests. */
export function coreEventHandlers(): CoreEventHandlers | null {
  return instance.coreEventHandlers()
}
