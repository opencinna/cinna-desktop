import { net } from 'electron'
import { agentRepo } from '../db/agents'
import { userRepo } from '../db/users'
import { getCinnaAccessToken } from '../auth/cinna-tokens'
import { CinnaReauthRequired } from '../auth/cinna-oauth'
import { AgentStatusError, ipcErrorShape } from '../errors'
import { createLogger } from '../logger/logger'
import { FOLDER_AGENT_SOURCE } from '../../shared/localAgents'
import { manifestPath, readManifest } from '../kit/manifestIo'
import { agentService } from './agentService'
import { localAgentService } from './localAgents/localAgentService'
import { readFolderAgentSnapshot, runStatusRefresh } from './localAgents/statusRefresh'

const logger = createLogger('agent-status')

export type AgentStatusSeverity = 'ok' | 'warning' | 'error' | 'info' | 'unknown'

export interface AgentStatusSnapshot {
  agentId: string
  remoteAgentId: string
  name: string
  environmentId: string | null
  severity: AgentStatusSeverity | null
  summary: string | null
  reportedAt: string | null
  reportedAtSource: 'frontmatter' | 'file_mtime' | null
  fetchedAt: string | null
  raw: string | null
  body: string | null
  hasStructuredMetadata: boolean
  prevSeverity: string | null
  severityChangedAt: string | null
}

interface AgentStatusPublicRaw {
  agent_id: string
  environment_id: string | null
  severity: AgentStatusSeverity | null
  summary: string | null
  reported_at: string | null
  reported_at_source: 'frontmatter' | 'file_mtime' | null
  fetched_at: string | null
  raw: string | null
  body: string | null
  has_structured_metadata: boolean
  prev_severity: string | null
  severity_changed_at: string | null
}

function toSnapshot(
  raw: AgentStatusPublicRaw,
  localId: string,
  name: string
): AgentStatusSnapshot {
  return {
    agentId: localId,
    remoteAgentId: raw.agent_id,
    name,
    environmentId: raw.environment_id,
    severity: raw.severity,
    summary: raw.summary,
    reportedAt: raw.reported_at,
    reportedAtSource: raw.reported_at_source,
    fetchedAt: raw.fetched_at,
    raw: raw.raw,
    body: raw.body,
    hasStructuredMetadata: raw.has_structured_metadata,
    prevSeverity: raw.prev_severity,
    severityChangedAt: raw.severity_changed_at
  }
}

async function getCinnaContext(
  userId: string
): Promise<{ baseUrl: string; accessToken: string } | null> {
  const user = userRepo.get(userId)
  if (!user || user.type !== 'cinna_user' || !user.cinnaServerUrl) return null
  const accessToken = await getCinnaAccessToken(userId)
  return { baseUrl: user.cinnaServerUrl.replace(/\/$/, ''), accessToken }
}

/**
 * Maps an HTTP failure to a typed {@link AgentStatusError}. Keeps error codes
 * stable across the IPC boundary so the renderer can branch on them.
 */
function errorFromStatus(status: number, statusText: string, url: string): AgentStatusError {
  if (status === 404) return new AgentStatusError('not_found', 'Agent status not found')
  if (status === 403) return new AgentStatusError('forbidden', 'Not authorized to view this agent')
  if (status >= 500)
    return new AgentStatusError(
      'remote_unreachable',
      `Backend returned ${status} ${statusText}`,
      url
    )
  return new AgentStatusError(
    'unknown',
    `Status fetch failed: ${status} ${statusText}`,
    url
  )
}


/**
 * Every folder agent's on-disk status — **cache-only, and it runs nothing**.
 *
 * This is the batch path: polled every 45 s by `useAgentStatus` and fanned out
 * by "Refresh all". It reads `app-data/storage/STATUS.md` and stops there, for
 * the same reason the remote batch route is cache-only — and for one more that
 * is local-only. `commandService.run()` takes the per-agent turn lock as owner
 * `'command'`, so a periodic tick that ran `status_refresh_command` would make
 * an editor save, and the user's next message, refuse *on a timer*, for work
 * nobody asked for. Running the command belongs to {@link folderStatus} with
 * `forceRefresh`, where a user asked for it.
 *
 * Never throws, and one bad folder never costs another its row: an agent whose
 * row has gone stale, whose folder has moved, or whose kit contract will not
 * load is skipped, not propagated. **That is deliberately the opposite of
 * {@link folderStatus}**, which throws for a folder it cannot locate: nobody
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

/**
 * One folder agent's status. `forceRefresh` runs the manifest's
 * `status_refresh_command` first; see `statusRefresh.ts` for why only the
 * `/run:<name>` form executes.
 *
 * Failure semantics deliberately mirror the remote `get` one line for one line:
 * a refusal that means "not now" — the turn lock is held, or the caller
 * cancelled — is swallowed and the on-disk snapshot is returned, exactly as a
 * 429 is (`:212`); anything else **throws**, so the overlay's per-agent refresh
 * and "Refresh all"'s `failed` counter tell the truth instead of flashing green
 * over a refresh script that is broken. Because the poll never runs a command,
 * that error can only ever reach a user who pressed Refresh.
 *
 * A refresh that fails does not cost the user the status they already had: the
 * throw leaves the batch cache untouched, so the last good snapshot stays on
 * screen behind the error.
 */
async function folderStatus(
  /** Always the default scope — see {@link AgentStatusScope}. */
  defaultUserId: string,
  agentId: string,
  name: string,
  forceRefresh: boolean
): Promise<AgentStatusSnapshot | null> {
  let located: ReturnType<typeof localAgentService.locate>
  try {
    located = localAgentService.locate(defaultUserId, agentId)
  } catch (err) {
    // **`null` means two different things here and only one of them is a
    // non-event.** The renderer treats `item: null` as the swallowed 429
    // (`useAgentStatus.ts`: `if (!result.success || !result.item) return`),
    // which is right for a rate limit and right for "this agent has never
    // written a STATUS.md" — the same nothing `list` deliberately omits rather
    // than showing a blank card. It is wrong for *the folder is gone*: the user
    // pressed Refresh on an agent whose directory has been moved or deleted,
    // and got a spinner that stopped and a stale card that sits there until the
    // next poll drops it. That failure is thrown so it reaches the surface;
    // everything else keeps the quiet semantics it should have.
    logger.warn('folder agent status: agent could not be located', { agentId, error: String(err) })
    throw new AgentStatusError(
      'not_found',
      err instanceof Error ? err.message : 'That agent is no longer in your agents folder.',
      agentId
    )
  }

  if (forceRefresh) {
    let refreshCommand: unknown = null
    try {
      refreshCommand = readManifest(manifestPath(located.agentDir)).status_refresh_command ?? null
    } catch (err) {
      // An unreadable manifest is the agent page's finding to report, not a
      // reason to withhold a STATUS.md that is sitting right there.
      logger.warn('folder agent status: manifest unreadable', { agentId, error: String(err) })
    }
    const outcome = await runStatusRefresh(defaultUserId, agentId, refreshCommand)
    if (outcome.error) throw new AgentStatusError('unknown', outcome.error, agentId)
  }

  return readFolderAgentSnapshot(agentId, name, located.root.path, located.agentDir)
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
      response = await net.fetch(url, {
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

    const localAgents = agentRepo.listRemote(scope.profileUserId)
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

  /**
   * Per-agent fetch. `forceRefresh=true` asks the backend to re-read STATUS.md
   * from the running env; 429 is swallowed (returns null) so callers fall back
   * to whatever the cache already surfaced.
   */
  async get(
    scope: AgentStatusScope,
    agentId: string,
    forceRefresh: boolean
  ): Promise<AgentStatusSnapshot | null> {
    // `get` is the ambiguous one: the incoming id may name either kind, so the
    // scope cannot be chosen before the row is found. `agentService.findAgent`
    // is the established resolver for exactly that (`agent_a2a.ipc.ts:175`) —
    // it picks the scope from the id's shape and hands back the row *with the
    // scope it was found in*, which is what every downstream call needs:
    // `localAgentService.locate` and `commandService.run` do their own strict
    // `getOwned`, so passing the wrong id there fails the same silent way.
    const found = agentService.findAgent(scope.defaultUserId, scope.profileUserId, agentId)
    if (!found) return null
    const agent = found.row
    // Before *both* remote gates — the `getCinnaContext` guard below and the
    // `remoteTargetId` one after it — for the same reason as in `list`.
    if (agent.source === FOLDER_AGENT_SOURCE) {
      return folderStatus(found.userId, agentId, agent.name, forceRefresh)
    }

    const ctx = await getCinnaContext(scope.profileUserId)
    if (!ctx) return null

    if (!agent.remoteTargetId) return null

    const url = `${ctx.baseUrl}/api/v1/agents/${agent.remoteTargetId}/status?force_refresh=${forceRefresh ? 'true' : 'false'}`
    logger.info('agent status get request', { url, agentId, forceRefresh })
    const t0 = Date.now()

    let response: Response
    try {
      response = await net.fetch(url, {
        headers: {
          Authorization: `Bearer ${ctx.accessToken}`,
          Accept: 'application/json'
        }
      })
    } catch (err) {
      const durationMs = Date.now() - t0
      logger.error('agent status get network error', {
        url,
        agentId,
        durationMs,
        error: String(err)
      })
      throw new AgentStatusError(
        'remote_unreachable',
        'Failed to reach Cinna backend',
        String(err)
      )
    }

    const durationMs = Date.now() - t0

    if (response.status === 429) {
      logger.info('agent status rate-limited', { agentId, durationMs })
      return null
    }
    if (!response.ok) {
      logger.warn('agent status get non-OK response', {
        url,
        agentId,
        status: response.status,
        statusText: response.statusText,
        durationMs
      })
      throw errorFromStatus(response.status, response.statusText, url)
    }

    let item: AgentStatusPublicRaw
    try {
      item = (await response.json()) as AgentStatusPublicRaw
    } catch (err) {
      // The same unguarded `response.json()` `list` carried: a 200 whose body is
      // not JSON — a captive portal or a proxy login page — reaches here past
      // the `!response.ok` check and rejects with a raw `SyntaxError`. It is
      // milder today only because the *renderer* now renders an unrecognised
      // rejection instead of swallowing it, and a distant repair is not a thing
      // this call site should depend on.
      logger.warn('agent status get unreadable response', { url, agentId, error: String(err) })
      throw new AgentStatusError(
        'remote_unreachable',
        'Cinna backend returned an unreadable response',
        String(err)
      )
    }
    logger.info('agent status get response', {
      url,
      agentId,
      status: response.status,
      durationMs,
      severity: item.severity
    })
    return toSnapshot(item, agent.id, agent.name)
  }
}

export { CinnaReauthRequired }
