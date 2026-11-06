import { createHash } from 'node:crypto'
import { agentRepo } from '../db/agents'
import { agentMcpRepo } from '../db/agentMcp'
import { mcpProviderRepo, type McpProviderRow } from '../db/mcpProviders'
import { mcpManager } from '../mcp/manager'
import { mcpRowToConfig } from '../mcp/config'
import type { McpProviderConfig } from '../mcp/types'
import { LocalAgentError, McpError } from '../errors'
import { managedHeadersOnly, missingEnvOf } from '../mcp/managed'
import { createLogger } from '../logger/logger'

const logger = createLogger('agent-mcp')

/** How long a turn waits for its agent's addons to connect before it starts anyway. */
export const ADDON_CONNECT_WAIT_MS = 5_000
/**
 * How long the first turn after an Add waits for the connect that Add started
 * (`connectAfterAdd`): a cold `npx -y` / `uvx` download takes longer than
 * {@link ADDON_CONNECT_WAIT_MS}, and a turn that starts without the tools
 * never sees them.
 */
export const ADDON_ADD_CONNECT_WAIT_MS = 60_000
/** After a failed connect a turn starts the next one no sooner than this, doubling per failure... */
export const ADDON_RETRY_BASE_MS = 60_000
/** ...up to this. */
export const ADDON_RETRY_MAX_MS = 15 * 60_000

/**
 * One connect per connector at a time, however many turns start together;
 * `first` when it is the first try, `afterAdd` while the Add that started it
 * has not had a turn wait for it yet.
 */
const connecting = new Map<string, { attempt: Promise<unknown>; first: boolean; afterAdd: boolean }>()

/**
 * What turns have tried for a connector in this app run, for one version of
 * it: its config revision and stored credentials. A new version starts over;
 * a successful connect, from a turn or from Settings, forgets it.
 */
interface AddonAttempts { version: string; failures: number; retryAt: number; needsUser: boolean }
const tried = new Map<string, AddonAttempts>()

function versionOf(row: McpProviderRow): string {
  const credentials = row.authTokensEncrypted ?? row.bearerTokenEncrypted
  return `${row.configRevision}:${credentials ? createHash('sha256').update(credentials).digest('hex') : ''}`
}

/** Only folder agents take addons: their rows are the ones `listFolder` returns. */
function takesAddons(ownerId: string, agentId: string): boolean {
  return agentRepo.listFolder(ownerId).some((row) => row.id === agentId)
}

function folderAgent(ownerId: string, agentId: string): void {
  if (!takesAddons(ownerId, agentId)) throw new LocalAgentError('not_found', 'Agent not found')
}

function ownedProvider(ownerId: string, mcpProviderId: string): McpProviderRow {
  const row = mcpProviderRepo.getOwned(ownerId, mcpProviderId)
  if (!row) throw new McpError('not_found', 'MCP provider not found')
  return row
}

/**
 * Whether this connector can come up with nobody at the keyboard: a local
 * process, a static token, or OAuth tokens already on file. A connection the
 * user is in the middle of authorizing (`awaiting-auth`) or that is already up
 * is left alone — `mcpManager.connect` replaces whatever is there.
 */
function connectsUnattended(row: McpProviderRow, missingEnv: readonly string[]): boolean {
  if (!row.enabled) return false
  // A plugin's or a directory server whose settings are not filled in yet would only fail.
  if (missingEnv.length > 0) return false
  const status = mcpManager.getConnection(row.id)?.status
  if (status === 'connected' || status === 'awaiting-auth') return false
  if (row.transportType === 'stdio') return true
  // A plugin's server whose declared headers are its whole auth needs no token of the user's.
  if (row.authType === 'bearer') return !!row.bearerTokenEncrypted || managedHeadersOnly(row)
  return !!row.authTokensEncrypted
}

function sameBytes(a: Buffer | null | undefined, b: Buffer | null | undefined): boolean {
  return (a ?? null) === (b ?? null) || (!!a && !!b && a.equals(b))
}

/**
 * The row as read now, when its settings are still the ones decrypted before an await; else nothing
 * (left for the next try). OAuth saves change neither the revision nor the env secret, so the
 * credentials are compared too: a connection that saved a token and ended meanwhile must not be
 * followed by a connect on the token it replaced.
 */
function sameRead(before: McpProviderRow | undefined, now: McpProviderRow | undefined): McpProviderRow | undefined {
  if (!before || !now || before.configRevision !== now.configRevision) return undefined
  return sameBytes(before.envSecretEncrypted, now.envSecretEncrypted) &&
    sameBytes(before.authTokensEncrypted, now.authTokensEncrypted) &&
    sameBytes(before.bearerTokenEncrypted, now.bearerTokenEncrypted) &&
    JSON.stringify(before.clientInfo ?? null) === JSON.stringify(now.clientInfo ?? null) ? now : undefined
}

/**
 * Start a non-interactive connect of `row` and file it under `connecting`
 * and `tried`, so turns and the Add share one attempt and its outcome.
 */
function startConnect(ownerId: string, agentId: string, row: McpProviderRow, config: McpProviderConfig, before: AddonAttempts | undefined, afterAdd: boolean): Promise<unknown> {
  const id = row.id
  const version = versionOf(row)
  const attempt = mcpManager.connect(config, { interactive: false })
    .then((result) => result.status, (error) => {
      logger.warn('Could not connect an agent addon', { agentId, mcpProviderId: id, error: String(error) })
      return 'error'
    })
    .then((status) => {
      if (status === 'connected') { tried.delete(id); return }
      // Replaced by the user's own connect (Settings), not failed: its
      // outcome is theirs, and the next turn treats this as a first try.
      if (status === 'disconnected' && mcpManager.connecting(id)) { tried.delete(id); return }
      // Filed under the version as it is now: a refresh that saved new
      // tokens and then failed must not read as a fresh first try.
      const now = mcpProviderRepo.getOwned(ownerId, id)
      const failures = (before?.failures ?? 0) + 1
      tried.set(id, { version: now ? versionOf(now) : version, failures, needsUser: mcpManager.needsUser(id),
        retryAt: Date.now() + Math.min(ADDON_RETRY_BASE_MS * 2 ** (failures - 1), ADDON_RETRY_MAX_MS) })
    })
    .finally(() => { if (connecting.get(id)?.attempt === attempt) connecting.delete(id) })
  // Marked tried now: a turn starting while this runs does not wait on a retry.
  if (!before) tried.set(id, { version, failures: 0, retryAt: 0, needsUser: false })
  connecting.set(id, { attempt, first: !before, afterAdd })
  return attempt
}

/** Live conductor sessions of this agent re-list their tools. */
function refreshAgent(agentId: string): void {
  void import('./conductorBridge')
    .then(({ conductorBridge }) => conductorBridge.refreshAgent(agentId))
    .catch((error) => logger.warn('Could not refresh agent tools', { agentId, error: String(error) }))
}

/**
 * MCP connectors attached to a folder agent as addons. Every session of the
 * agent — its chats, jobs, tasks, delegations and nested runs — is offered
 * their tools through the conductor bridge. Owner is the settings scope, where
 * folder agents and the MCP list both live.
 */
export const agentMcpService = {
  /** Empty for an id that is not a folder agent here: an agent-bound chat asks about any agent. */
  list(ownerId: string, agentId: string): string[] {
    return takesAddons(ownerId, agentId) ? agentMcpRepo.listProviderIds(ownerId, agentId) : []
  },

  attach(ownerId: string, agentId: string, mcpProviderId: string): void {
    folderAgent(ownerId, agentId)
    ownedProvider(ownerId, mcpProviderId)
    if (agentMcpRepo.attach(agentId, mcpProviderId)) {
      logger.info('mcp attached to agent', { agentId, mcpProviderId })
      refreshAgent(agentId)
    }
  },

  /**
   * Detach, then — on a kit agent — drop the `mcp_servers[]` requirement the
   * connector was written as (by its directory ref), through the manifest
   * guard, so no detach path leaves a requirement behind. The detach itself
   * is done before the first await; the manifest write never fails it.
   */
  async detach(ownerId: string, agentId: string, mcpProviderId: string): Promise<void> {
    folderAgent(ownerId, agentId)
    if (agentMcpRepo.detach(agentId, mcpProviderId)) {
      logger.info('mcp detached from agent', { agentId, mcpProviderId })
      refreshAgent(agentId)
    }
    try {
      const { dropRequirementOfProvider } = await import('./addonDirectory/requirements')
      await dropRequirementOfProvider(ownerId, agentId, mcpProviderId)
    } catch (error) {
      logger.warn('Could not drop the connector from the agent’s requirements', { agentId, mcpProviderId, error: String(error) })
    }
  },

  agentsUsing(ownerId: string, mcpProviderId: string): { id: string; name: string }[] {
    ownedProvider(ownerId, mcpProviderId)
    return agentMcpRepo.agentsUsing(ownerId, mcpProviderId)
  },

  /** Attached connector ids for a running session; no ownership check of the agent. */
  providerIds(ownerId: string, agentId: string): string[] {
    return agentMcpRepo.listProviderIds(ownerId, agentId)
  },

  /**
   * Best-effort: bring up the agent's attached connectors that can connect
   * without the user. Never opens a browser, never throws. A turn waits, at
   * most `waitMs` and never past `signal`, only for a connector's first try in
   * this app run (for its current version). One that failed before is retried
   * in the background with a backoff, and one that needs the user is not
   * retried until its version changes. A connection that lands later reaches
   * the session through `onMcpToolsChanged`. The first turn after an Add
   * whose connect is still running (`connectAfterAdd`) waits for it up to
   * {@link ADDON_ADD_CONNECT_WAIT_MS} instead.
   */
  async ensureConnected(ownerId: string, agentId: string, options: { signal?: AbortSignal; waitMs?: number } = {}): Promise<void> {
    const waitFor: Promise<unknown>[] = []
    let afterAdd = false
    for (const id of agentMcpRepo.listProviderIds(ownerId, agentId)) {
      if (mcpManager.getConnection(id)?.status === 'connected') { tried.delete(id); continue }
      const unread = mcpProviderRepo.getOwned(ownerId, id)
      // Cheap checks first, so a connector that will not start this turn (connecting, waiting for the
      // user, in backoff) costs no keystore read. Each is repeated after the await below.
      if (!unread) continue
      const ours0 = connecting.get(id)
      if (ours0) {
        if (ours0.first) waitFor.push(ours0.attempt)
        if (ours0.afterAdd) { ours0.afterAdd = false; afterAdd = true }
        continue
      }
      const before0 = tried.get(id)?.version === versionOf(unread) ? tried.get(id) : undefined
      const theirs0 = mcpManager.connecting(id)
      if (theirs0) { if (!before0) waitFor.push(theirs0); continue }
      if (before0?.needsUser || (before0 && Date.now() < before0.retryAt)) continue
      // The settings still to fill in, and the launch config, need the keystore: read first, so
      // the checks below and the start of a connect run together, after it, with no await between.
      const [missingEnv, config] = unread ? await Promise.all([missingEnvOf(unread), mcpRowToConfig(unread)]) : [[], undefined]
      if (mcpManager.getConnection(id)?.status === 'connected') { tried.delete(id); continue }
      const ours = connecting.get(id)
      if (ours) {
        if (ours.first) waitFor.push(ours.attempt)
        // The first turn after an Add waits for the connect that Add started, longer.
        if (ours.afterAdd) { ours.afterAdd = false; afterAdd = true }
        continue
      }
      const row = sameRead(unread, mcpProviderRepo.getOwned(ownerId, id))
      if (!row) continue
      const version = versionOf(row)
      const before = tried.get(id)?.version === version ? tried.get(id) : undefined
      // Someone else's connect (Settings) is running: calling `connect` would cancel it.
      const theirs = mcpManager.connecting(id)
      if (theirs) { if (!before) waitFor.push(theirs); continue }
      if (!connectsUnattended(row, missingEnv) || before?.needsUser || (before && Date.now() < before.retryAt)) continue
      const attempt = startConnect(ownerId, agentId, row, config!, before, false)
      if (!before) waitFor.push(attempt)
    }
    const signal = options.signal
    if (waitFor.length === 0 || signal?.aborted) return
    let timer: ReturnType<typeof setTimeout> | undefined
    let stopped: (() => void) | undefined
    await Promise.race([
      Promise.allSettled(waitFor),
      new Promise<void>((resolve) => {
        const wait = options.waitMs ?? ADDON_CONNECT_WAIT_MS
        timer = setTimeout(resolve, afterAdd ? Math.max(wait, ADDON_ADD_CONNECT_WAIT_MS) : wait)
      }),
      new Promise<void>((resolve) => { stopped = (): void => resolve(); signal?.addEventListener('abort', stopped, { once: true }) })
    ])
    clearTimeout(timer)
    if (stopped) signal?.removeEventListener('abort', stopped)
  },

  /**
   * Right after an Add: start a non-interactive connect of each of `ids`
   * (attached to the agent) that can come up with nobody at the keyboard and
   * is not up or connecting already. The first turn after it waits for that
   * connect up to {@link ADDON_ADD_CONNECT_WAIT_MS}. Answers the ids now
   * starting (one already in flight included). Never throws; waits only for
   * the keystore (the settings each connector still needs), never for a connect.
   */
  async connectAfterAdd(ownerId: string, agentId: string, ids: readonly string[]): Promise<string[]> {
    const starting: string[] = []
    for (const id of ids) {
      try {
        const unread = mcpProviderRepo.getOwned(ownerId, id)
        // Decrypted first: the checks below and the start run together, after it.
        const [missingEnv, config] = unread ? await Promise.all([missingEnvOf(unread), mcpRowToConfig(unread)]) : [[], undefined]
        if (mcpManager.getConnection(id)?.status === 'connected') continue
        const ours = connecting.get(id)
        if (ours) { ours.afterAdd = true; starting.push(id); continue }
        if (mcpManager.connecting(id)) { starting.push(id); continue }
        const row = sameRead(unread, mcpProviderRepo.getOwned(ownerId, id))
        if (!row || !connectsUnattended(row, missingEnv)) continue
        // A new add is a first try, whatever earlier turns tried of this version.
        tried.delete(id)
        void startConnect(ownerId, agentId, row, config!, undefined, true)
        starting.push(id)
      } catch (error) {
        logger.warn('Could not start an added connector', { agentId, mcpProviderId: id, error: String(error) })
      }
    }
    return starting
  },

  /** Forget what turns tried: tests only. */
  resetForTests(): void {
    connecting.clear()
    tried.clear()
  }
}
