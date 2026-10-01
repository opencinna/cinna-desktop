import { createHash } from 'node:crypto'
import { agentRepo } from '../db/agents'
import { agentMcpRepo } from '../db/agentMcp'
import { mcpProviderRepo, type McpProviderRow } from '../db/mcpProviders'
import { mcpManager } from '../mcp/manager'
import { mcpRowToConfig } from '../mcp/config'
import { LocalAgentError, McpError } from '../errors'
import { createLogger } from '../logger/logger'

const logger = createLogger('agent-mcp')

/** How long a turn waits for its agent's addons to connect before it starts anyway. */
export const ADDON_CONNECT_WAIT_MS = 5_000
/** After a failed connect a turn starts the next one no sooner than this, doubling per failure... */
export const ADDON_RETRY_BASE_MS = 60_000
/** ...up to this. */
export const ADDON_RETRY_MAX_MS = 15 * 60_000

/** One connect per connector at a time, however many turns start together; `first` when it is the first try. */
const connecting = new Map<string, { attempt: Promise<unknown>; first: boolean }>()

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
function connectsUnattended(row: McpProviderRow): boolean {
  if (!row.enabled) return false
  const status = mcpManager.getConnection(row.id)?.status
  if (status === 'connected' || status === 'awaiting-auth') return false
  if (row.transportType === 'stdio') return true
  if (row.authType === 'bearer') return !!row.bearerTokenEncrypted
  return !!row.authTokensEncrypted
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

  detach(ownerId: string, agentId: string, mcpProviderId: string): void {
    folderAgent(ownerId, agentId)
    if (agentMcpRepo.detach(agentId, mcpProviderId)) {
      logger.info('mcp detached from agent', { agentId, mcpProviderId })
      refreshAgent(agentId)
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
   * the session through `onMcpToolsChanged`.
   */
  async ensureConnected(ownerId: string, agentId: string, options: { signal?: AbortSignal; waitMs?: number } = {}): Promise<void> {
    const waitFor: Promise<unknown>[] = []
    for (const id of agentMcpRepo.listProviderIds(ownerId, agentId)) {
      if (mcpManager.getConnection(id)?.status === 'connected') { tried.delete(id); continue }
      const ours = connecting.get(id)
      if (ours) { if (ours.first) waitFor.push(ours.attempt); continue }
      const row = mcpProviderRepo.getOwned(ownerId, id)
      if (!row) continue
      const version = versionOf(row)
      const before = tried.get(id)?.version === version ? tried.get(id) : undefined
      // Someone else's connect (Settings) is running: calling `connect` would cancel it.
      const theirs = mcpManager.connecting(id)
      if (theirs) { if (!before) waitFor.push(theirs); continue }
      if (!connectsUnattended(row) || before?.needsUser || (before && Date.now() < before.retryAt)) continue
      const attempt = mcpManager.connect(mcpRowToConfig(row), { interactive: false })
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
      connecting.set(id, { attempt, first: !before })
      if (!before) waitFor.push(attempt)
    }
    const signal = options.signal
    if (waitFor.length === 0 || signal?.aborted) return
    let timer: ReturnType<typeof setTimeout> | undefined
    let stopped: (() => void) | undefined
    await Promise.race([
      Promise.allSettled(waitFor),
      new Promise<void>((resolve) => { timer = setTimeout(resolve, options.waitMs ?? ADDON_CONNECT_WAIT_MS) }),
      new Promise<void>((resolve) => { stopped = (): void => resolve(); signal?.addEventListener('abort', stopped, { once: true }) })
    ])
    clearTimeout(timer)
    if (stopped) signal?.removeEventListener('abort', stopped)
  },

  /** Forget what turns tried: tests only. */
  resetForTests(): void {
    connecting.clear()
    tried.clear()
  }
}
