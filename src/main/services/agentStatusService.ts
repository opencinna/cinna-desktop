import { runtimeHost } from '../host/runtimeHost'
import { agentRepo, agentOverrideRepo } from '../db/agents'
import { CinnaReauthRequired } from '../auth/cinna-oauth'
import { AgentStatusError, ipcErrorShape } from '../errors'
import { createLogger } from '../logger/logger'
import { isStatusRefreshIntent, type AgentStatusSnapshot, type StatusRefreshIntent } from '../../shared/agentStatus'
import { statusSourceFor } from '../agents/status'
import { getCinnaContext, errorFromStatus, toSnapshot, type AgentStatusPublicRaw } from '../agents/status/cinnaStatusSource'
import { agentService } from './agentService'
import { localAgentService } from './localAgents/localAgentService'
import { readFolderAgentSnapshot } from './localAgents/statusRefresh'

export type { AgentStatusSnapshot, AgentStatusSeverity } from '../../shared/agentStatus'
const logger = createLogger('agent-status')

/**
 * Every folder agent's on-disk status — **cache-only, and it runs nothing**.
 *
 * This is the batch path: polled every 45 s by `useAgentStatus` and fanned out
 * by "Refresh all". It reads `app-data/storage/STATUS.md` and stops there, for
 * the same reason the remote batch route is cache-only — and for one more that
 * is local-only. `commandService.run()` takes the per-agent turn lock as owner
 * `'command'`, so a periodic tick that ran `status_refresh_command` would make
 * an editor save, and the user's next message, refuse *on a timer*, for work
 * nobody asked for. Running the command belongs to the folder status source
 * handling an explicit manual refresh.
 *
 * Never throws, and one bad folder never costs another its row: an agent whose
 * row has gone stale, whose folder has moved, or whose kit contract will not
 * load is skipped, not propagated. **The per-agent source instead throws**, which throws for a folder it cannot locate: nobody
 * asked about that agent here, and taking the whole panel down over one moved
 * directory would be a worse answer than a shorter list — whereas `get` is
 * reached by a user pressing Refresh *on that agent*, and owes them a reason.
 */
function listFolderSnapshots(defaultUserId: string): AgentStatusSnapshot[] {
  let rows: ReturnType<typeof agentRepo.listFolder>
  try {
    rows = agentRepo.listFolder(defaultUserId)
  } catch (err) {
    logger.error('folder agent status: index unreadable', { error: String(err) })
    return []
  }
  // One timestamp for the whole batch: these snapshots were all fetched by the
  // same poll, and per-agent `new Date()`s would only encode loop order.
  const fetchedAt = new Date()
  const snapshots: AgentStatusSnapshot[] = []
  for (const row of rows) {
    try {
      const { root, agentDir } = localAgentService.locate(defaultUserId, row.id)
      const snapshot = readFolderAgentSnapshot(row.id, row.name, root.path, agentDir, fetchedAt)
      // No STATUS.md is not a status. Omitting the agent is what the remote
      // route already does with a sentinel snapshot (`:153`): a surface listing
      // agents that have reported should not list one that has not.
      if (snapshot) snapshots.push(snapshot)
    } catch (err) {
      logger.warn('folder agent status: agent skipped', { agentId: row.id, error: String(err) })
    }
  }
  return snapshots
}

/** What a failed remote leg looks like when folder rows survived it. */
export interface RemoteStatusFailure {
  code: string
  message: string
}

export interface AgentStatusListResult {
  items: AgentStatusSnapshot[]
  /**
   * Set when the Cinna leg failed but folder rows were still returned. The
   * alternative — swallowing it — would let a cinna user's remote agents go
   * silently stale behind a panel that looks healthy, which is worse than the
   * blanking it replaces. The caller must surface it.
   */
  remoteError: RemoteStatusFailure | null
}

/**
 * The two user ids this service needs, together, because it serves **two
 * differently-scoped kinds of agent** and a single id can only ever be right
 * for one of them.
 *
 * Folder agents are shared machine resources: every write goes through
 * `local_agent.ipc.ts`, which passes `getSettingsScopeUserId()` — unconditionally
 * `DEFAULT_SCOPE_USER_ID` — so their rows are *always* default-scoped
 * (`scope.ts:5-8`: "available regardless of which profile is currently active").
 * Remote agents are the opposite: sync-owned and bound to the active profile.
 *
 * They arrive as one object rather than two strings because two same-typed
 * positional parameters can be transposed silently, and the failure that
 * produces is invisible — `listFolder(<profile id>)` is a valid call that
 * returns `[]`, which reads as "this user has no folder agents" rather than as
 * a bug. That is exactly the defect this type exists to make unrepresentable:
 * the folder leg was handed the profile scope and went quietly dead for every
 * user except the Default profile.
 */
export interface AgentStatusScope {
  /** Where folder agents live. Always `DEFAULT_SCOPE_USER_ID`. */
  defaultUserId: string
  /** Where remote agents, the Cinna account and its tokens live. */
  profileUserId: string
}

export const agentStatusService = {
  /**
   * Batch list — cache-only, safe to poll. Two legs.
   *
   * **Folder agents come first, and are computed before anything can fail.**
   * `getCinnaContext` returns `null` for any user who is not a `cinna_user`
   * with a server URL, and the old `if (!ctx) return []` made this whole
   * surface dead for exactly the local-only user Local Agents exists for —
   * before the `remoteTargetId` filter that seam 11 named ever came into it.
   * Both gates are now downstream of the folder leg, and so is the network
   * fetch: a remote failure returns `remoteError` alongside the folder rows
   * rather than taking them down with it.
   *
   * The remote leg is unchanged: backend rows filtered to agents the local DB
   * knows about (by `remoteTargetId`), sentinel snapshots (severity == null &&
   * raw == null) hidden per the integration spec.
   */
  async list(scope: AgentStatusScope): Promise<AgentStatusListResult> {
    // Default scope, unconditionally — not a union with the profile. A union
    // would say folder rows *might* be profile-scoped, which is false, and
    // would leave the next reader believing there is a case to handle.
    const folderItems = listFolderSnapshots(scope.defaultUserId)
    /**
     * Keep the folder rows; hand the caller the remote failure to surface.
     *
     * **With no folder rows this still throws, and that is not an
     * inconsistency.** Nothing to show plus something failed means the error is
     * the whole answer: degrading to an empty list there would report "no
     * agents have reported status yet" for what is actually a network fault or
     * an expired session, which is the silent-staleness failure this function
     * exists to avoid. The asymmetry is the point — degrade only when there is
     * something the failure does not invalidate.
     */
    const degraded = (err: unknown): AgentStatusListResult => {
      if (folderItems.length === 0) throw err
      const shape =
        err instanceof CinnaReauthRequired
          ? { code: 'reauth_required', message: err.message }
          : ipcErrorShape(err)
      logger.warn('agent status list: remote leg failed, folder rows kept', {
        code: shape.code,
        folderItems: folderItems.length
      })
      return { items: folderItems, remoteError: { code: shape.code, message: shape.message } }
    }

    let ctx: Awaited<ReturnType<typeof getCinnaContext>>
    try {
      ctx = await getCinnaContext(scope.profileUserId)
    } catch (err) {
      // `getCinnaAccessToken` throws `CinnaReauthRequired` — a failure that
      // happens before the fetch and would otherwise take the folder rows with
      // it just as surely as a network error.
      return degraded(err)
    }
    if (!ctx) return { items: folderItems, remoteError: null }

    const url = `${ctx.baseUrl}/api/v1/agents/status`
    logger.info('agent status list request', { url })
    const t0 = Date.now()

    let response: Response
    try {
      response = await runtimeHost.http.fetch(url, {
        headers: {
          Authorization: `Bearer ${ctx.accessToken}`,
          Accept: 'application/json'
        }
      })
    } catch (err) {
      const durationMs = Date.now() - t0
      logger.error('agent status list network error', {
        url,
        durationMs,
        error: String(err)
      })
      return degraded(
        new AgentStatusError('remote_unreachable', 'Failed to reach Cinna backend', String(err))
      )
    }

    const durationMs = Date.now() - t0
    if (!response.ok) {
      logger.warn('agent status list non-OK response', {
        url,
        status: response.status,
        statusText: response.statusText,
        durationMs
      })
      return degraded(errorFromStatus(response.status, response.statusText, url))
    }

    let data: { items?: AgentStatusPublicRaw[] }
    try {
      data = (await response.json()) as { items?: AgentStatusPublicRaw[] }
    } catch (err) {
      // A 200 whose body is not JSON is a captive portal or a proxy, not a
      // status list. Before this it rejected out of `list` unguarded.
      return degraded(
        new AgentStatusError('remote_unreachable', 'Cinna backend returned an unreadable response', String(err))
      )
    }

    const hidden = new Set(agentOverrideRepo.listForUser(scope.profileUserId).filter((row) => !row.enabled).map((row) => row.agentId))
    const localAgents = agentRepo.listRemote(scope.profileUserId).filter((agent) => agent.enabled !== false && !hidden.has(agent.id))
    const byRemoteId = new Map(localAgents.map((a) => [a.remoteTargetId!, a]))

    const snapshots: AgentStatusSnapshot[] = [...folderItems]
    for (const item of data.items ?? []) {
      const local = byRemoteId.get(item.agent_id)
      if (!local) continue
      if (item.severity === null && item.raw === null) continue
      snapshots.push(toSnapshot(item, local.id, local.name))
    }

    logger.info('agent status list response', {
      url,
      status: response.status,
      durationMs,
      totalItems: data.items?.length ?? 0,
      localMatches: snapshots.length - folderItems.length,
      folderItems: folderItems.length
    })
    return { items: snapshots, remoteError: null }
  },

  /** Resolve from a fresh owned row; callers express intent, never a command policy. */
  async get(scope: AgentStatusScope, agentId: string, intent: StatusRefreshIntent): Promise<AgentStatusSnapshot | null> {
    if (!isStatusRefreshIntent(intent)) throw new AgentStatusError('unknown', 'Unknown agent status refresh intent.')
    const found = agentService.findAgent(scope.defaultUserId, scope.profileUserId, agentId)
    if (!found) return null
    return statusSourceFor(found.userId, found.row)?.read(intent) ?? null
  }
}

export { CinnaReauthRequired }
