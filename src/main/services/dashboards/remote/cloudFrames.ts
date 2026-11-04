import { dashboardRepo, isCloudTileRow } from '../../../db/dashboards'
import { runtimeHost } from '../../../host/runtimeHost'
import { createLogger } from '../../../logger/logger'
import { resolveBaseUrl } from '../../cinna-http'
import { MAX_HTML_PREVIEW_BYTES } from '../../htmlPreview/htmlPreviewServer'
import type { DashboardsErrorCode } from '../../../../shared/dashboards'
import { coreDashboardsClient, type CoreFrame, type CoreOutcome } from './coreDashboardsClient'
import { findCloudAgent, onOtherCoreServer } from './cloudComponent'
import { openRemoteFrame, type RemoteFrame, type RemoteFrameDeps } from './remoteFrames'

const logger = createLogger('dashboard-frame')

/**
 * Cloud frames and their page state (D6.3, D6.5), behind the dashboards IPC:
 * which core frame a tile or a preview mints, and what the tile's page tells
 * core about the agent's highlights.
 *
 * Page state follows core's web host (`bridgeHost.ts`): a page document id per
 * loaded page, `PUT page-state {page_doc, highlight_ready, seq}` when the page
 * says it listens, written again every {@link PAGE_STATE_RESEND_MS} (core
 * forgets one older than 15 minutes), and withdrawn with `if_page_doc` when the
 * page loads again or the frame is released, so a newer page's state stays.
 * `seq` is microseconds since the epoch, strictly increasing per tile.
 *
 * Core module: no Electron.
 */

export const PAGE_STATE_RESEND_MS = 10 * 60_000

/** What `dashboards:open-frame` needs registered: the relay, and the tile it belongs to (null for a preview). */
export type CloudFrameOpen =
  | { ok: true; frame: RemoteFrame; tileId: string | null }
  | { ok: false; code: DashboardsErrorCode; message: string }

export interface CloudFramesDeps {
  /** A cloud tile's backing: core dashboard and block, and whether it was made on this server. */
  tile: (userId: string, tileId: string) => { coreDashboardId: string | null; coreBlockId: string | null; wrongServer: boolean; view: string | null } | null
  /** A remote agent row of this profile: its core agent id, or null when the row is not one. */
  remoteAgent: (userId: string, agentId: string) => { remoteTargetId: string } | null
  mintTile: (userId: string, coreDashboardId: string, coreBlockId: string) => Promise<CoreOutcome<CoreFrame>>
  mintComponent: (userId: string, remoteAgentId: string, component: string, skill: string | null) => Promise<CoreOutcome<CoreFrame>>
  putPageState: (
    userId: string,
    coreDashboardId: string,
    coreBlockId: string,
    state: { pageDoc: string | null; highlightReady: boolean; seq: number; ifPageDoc?: string | null }
  ) => Promise<CoreOutcome<unknown>>
  fetch: RemoteFrameDeps['fetch']
  newPageDoc?: () => string
  now?: () => number
  setInterval?: (fn: () => void, ms: number) => unknown
  clearInterval?: (handle: unknown) => void
}

const refuse = (code: DashboardsErrorCode, message: string): { ok: false; code: DashboardsErrorCode; message: string } => ({ ok: false, code, message })

interface PageState {
  userId: string
  coreDashboardId: string
  coreBlockId: string
  pageDoc: string | null
  timer: unknown
}

export function createCloudFrames(deps: CloudFramesDeps) {
  const now = deps.now ?? Date.now
  const newPageDoc = deps.newPageDoc ?? (() => globalThis.crypto.randomUUID().replace(/-/g, ''))
  const every = deps.setInterval ?? ((fn: () => void, ms: number) => {
    const handle = setInterval(fn, ms)
    handle.unref?.()
    return handle
  })
  const stop = deps.clearInterval ?? ((handle: unknown) => clearInterval(handle as ReturnType<typeof setInterval>))
  /** Frame token → its cloud tile, for the release. */
  const tokens = new Map<string, string>()
  const pages = new Map<string, PageState>()
  const lastSeq = new Map<string, number>()
  /** Per tile, so a withdraw never overtakes the write before it (seq orders them at core too). */
  const chains = new Map<string, Promise<unknown>>()

  function seqFor(tileId: string): number {
    const seq = Math.max(now() * 1000, (lastSeq.get(tileId) ?? 0) + 1)
    lastSeq.set(tileId, seq)
    return seq
  }

  function put(tileId: string, page: PageState, state: { pageDoc: string | null; highlightReady: boolean; ifPageDoc?: string | null }): Promise<boolean> {
    const seq = seqFor(tileId)
    const next = (chains.get(tileId) ?? Promise.resolve())
      .catch(() => {})
      .then(() => deps.putPageState(page.userId, page.coreDashboardId, page.coreBlockId, { ...state, seq }))
      .then((outcome) => {
        if (!outcome.ok) logger.info('core did not take a tile page state', { code: outcome.code })
        return outcome.ok
      })
      .catch(() => false)
    chains.set(tileId, next)
    void next.finally(() => {
      if (chains.get(tileId) === next) chains.delete(tileId)
    })
    return next
  }

  function withdraw(tileId: string): Promise<boolean> {
    const page = pages.get(tileId)
    if (!page) return Promise.resolve(false)
    pages.delete(tileId)
    if (page.timer !== null) stop(page.timer)
    if (!page.pageDoc) return Promise.resolve(false)
    return put(tileId, page, { pageDoc: null, highlightReady: false, ifPageDoc: page.pageDoc })
  }

  return {
    /** A cloud tile's frame: core's block frame (wakes the environment). Not a cloud tile → null. */
    async openTile(userId: string, tileId: string): Promise<CloudFrameOpen | null> {
      const tile = deps.tile(userId, tileId)
      if (!tile) return null
      if (tile.wrongServer) return refuse('wrong_server', 'This tile was added on another Cinna server.')
      if (!tile.coreDashboardId || !tile.coreBlockId) return refuse('not_found', 'That tile is gone.')
      if (tile.view !== null && tile.view !== 'html') return refuse('invalid_input', 'This component has no page.')
      const { coreDashboardId, coreBlockId } = tile
      const opened = await openRemoteFrame({
        fetch: deps.fetch,
        mint: () => deps.mintTile(userId, coreDashboardId, coreBlockId),
        maxBytes: MAX_HTML_PREVIEW_BYTES,
        now
      })
      return opened.ok ? { ok: true, frame: opened.frame, tileId } : opened
    },

    /** A cloud component's preview frame (tile key `preview`). Not a remote agent row → null. */
    async openPreview(userId: string, agentId: unknown, component: unknown, skill: unknown): Promise<CloudFrameOpen | null> {
      if (typeof agentId !== 'string' || !agentId) return null
      const agent = deps.remoteAgent(userId, agentId)
      if (!agent) return null
      if (typeof component !== 'string' || !component || (skill !== null && skill !== undefined && typeof skill !== 'string')) {
        return refuse('invalid_input', 'Nothing to show.')
      }
      const opened = await openRemoteFrame({
        fetch: deps.fetch,
        mint: () => deps.mintComponent(userId, agent.remoteTargetId, component, typeof skill === 'string' && skill ? skill : null),
        maxBytes: MAX_HTML_PREVIEW_BYTES,
        now
      })
      return opened.ok ? { ok: true, frame: opened.frame, tileId: null } : opened
    },

    /** The frame server gave the tile's frame this token. */
    registered(token: string, tileId: string | null): void {
      if (tileId) tokens.set(token, tileId)
    },

    /** Whether a tile is a cloud one (`highlight-ready` then goes to core). */
    isCloudTile(userId: string, tileId: string): boolean {
      return !!deps.tile(userId, tileId)
    },

    /**
     * The tile's page listens for highlights (`ready`), or a page loaded
     * again (`!ready`): core is told, as the web host tells it. False when
     * the tile is not a usable cloud tile.
     */
    async highlightReady(userId: string, tileId: string, ready: boolean): Promise<boolean> {
      const tile = deps.tile(userId, tileId)
      if (!tile || tile.wrongServer || !tile.coreDashboardId || !tile.coreBlockId) return false
      if (!ready) {
        await withdraw(tileId)
        return true
      }
      let page = pages.get(tileId)
      if (!page) {
        page = { userId, coreDashboardId: tile.coreDashboardId, coreBlockId: tile.coreBlockId, pageDoc: newPageDoc(), timer: null }
        pages.set(tileId, page)
        const current = page
        current.timer = every(() => {
          if (pages.get(tileId) === current) void put(tileId, current, { pageDoc: current.pageDoc, highlightReady: true })
        }, PAGE_STATE_RESEND_MS)
      }
      return put(tileId, page, { pageDoc: page.pageDoc, highlightReady: true })
    },

    /** The frame is gone: its page's readiness is withdrawn. */
    released(token: unknown): void {
      if (typeof token !== 'string') return
      const tileId = tokens.get(token)
      if (!tileId) return
      tokens.delete(token)
      // Another frame of the same tile (a remount) keeps the page state.
      if ([...tokens.values()].includes(tileId)) return
      void withdraw(tileId)
    },

    /** Profile closing: forget everything without writing. */
    reset(): void {
      for (const page of pages.values()) if (page.timer !== null) stop(page.timer)
      pages.clear()
      tokens.clear()
    }
  }
}

export type CloudFrames = ReturnType<typeof createCloudFrames>

function viewOf(json: string | null): string | null {
  if (!json) return null
  try {
    const parsed = JSON.parse(json) as { view?: unknown }
    return typeof parsed.view === 'string' ? parsed.view : null
  } catch {
    return null
  }
}

export const cloudFrames = createCloudFrames({
  tile: (userId, tileId) => {
    const row = dashboardRepo.tile(userId, tileId)
    if (!row || !isCloudTileRow(row)) return null
    const dashboard = dashboardRepo.get(userId, row.dashboardId)
    let server: string | null = null
    try {
      server = resolveBaseUrl(userId)
    } catch {
      server = null
    }
    const wrongServer = onOtherCoreServer(dashboard?.coreServer, server)
    return { coreDashboardId: dashboard?.coreDashboardId ?? null, coreBlockId: row.coreBlockId, wrongServer, view: viewOf(row.cloudComponentJson) }
  },
  remoteAgent: (userId, agentId) => {
    const agent = findCloudAgent(userId, agentId)
    return agent ? { remoteTargetId: agent.remoteTargetId } : null
  },
  mintTile: (userId, dashboardId, blockId) => coreDashboardsClient.mintTileFrame(userId, dashboardId, blockId),
  mintComponent: (userId, agentId, component, skill) => coreDashboardsClient.mintComponentFrame(userId, agentId, component, { skill, tileKey: 'preview' }),
  putPageState: (userId, dashboardId, blockId, state) => coreDashboardsClient.putPageState(userId, dashboardId, blockId, state),
  fetch: (url, init) => runtimeHost.http.fetch(url, init)
})
