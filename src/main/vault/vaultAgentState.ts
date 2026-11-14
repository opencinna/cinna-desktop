/**
 * What a folder agent keeps in its `app-data/desktop.json`, for an agent in a
 * vault: its engine sessions per chat and its *Always allow* grants, kept in
 * the vault's own key-value store (`kv.get` / `kv.put`) instead of a host
 * file. Plus the instructions captured when the agent moved in, and its
 * launch settings (D34: approval mode, model, sealed or native): everything
 * that changes how the agent behaves is read from here, never from the host
 * `agents` row, which keeps display copies only.
 *
 * Grants are read on the ask path, which is synchronous, so they are cached in
 * memory while the vault is unlocked ({@link load} before a turn) and dropped
 * when it locks. Writes go through to the vault in order and never throw into
 * the turn: a grant that could not be saved is asked again next time.
 */
import {
  isPermissionGranted,
  permissionGrantKey,
  permissionGrantPatterns,
  type LocalPermissionGrant,
  type LocalPermissionRequest
} from '../../shared/localAgentRequests'
import { isClaudeApproval, type ClaudeApproval } from '../../shared/engine'
import { createLogger } from '../logger/logger'
import { vaultTranscripts } from './transcriptStore'
import { VAULT_KV_INSTRUCTIONS, VAULT_KV_LAUNCH, VAULT_LAUNCH_MODEL, VAULT_LAUNCH_PROVIDERS, type VaultLaunchProvider } from '../../shared/vault/protocol'
import type { VaultdClient } from './vaultdClient'

const logger = createLogger('vault-agent-state')

export const VAULT_KV_SESSIONS = 'cinna.sessions'
export const VAULT_KV_GRANTS = 'cinna.permissionGrants'
/**
 * `cinna.instructions`: the agent's system prompt as assembled on the host when it moved in (a kit agent's prompt files).
 * `cinna.launch`: {@link VaultLaunchSettings}, written at move-in (and by any later change), read by every launch.
 * Both live in the shared protocol, since vaultd reads them too (codex, opencode).
 */
export { VAULT_KV_INSTRUCTIONS, VAULT_KV_LAUNCH }

/** How a vault agent is launched, as the vault holds it (D34). */
export interface VaultLaunchSettings {
  /** Sealed (a kit agent: no settings sources, the captured prompt) or native (a bare one). */
  kind: 'kit' | 'bare'
  /** The model alias, or null for the CLI's default. */
  model: string | null
  approval: ClaudeApproval
  /** OpenCode only: whose API the model is (which key it signs in with); null for the other engines. */
  provider: VaultLaunchProvider | null
}

/**
 * When the vault holds none (or a malformed one): the most closed launch,
 * sealed and asking, whatever the host row says.
 */
export const VAULT_LAUNCH_FALLBACK: VaultLaunchSettings = { kind: 'kit', model: null, approval: 'ask', provider: null }

/** A stored value as launch settings; anything malformed falls back field by field. */
export function parseLaunchSettings(value: unknown): VaultLaunchSettings {
  const raw = record(value)
  const model = raw['model']
  return {
    kind: raw['kind'] === 'bare' ? 'bare' : 'kit',
    model: typeof model === 'string' && VAULT_LAUNCH_MODEL.test(model) ? model : null,
    approval: isClaudeApproval(raw['approval']) ? raw['approval'] : VAULT_LAUNCH_FALLBACK.approval,
    provider: (VAULT_LAUNCH_PROVIDERS as readonly unknown[]).includes(raw['provider']) ? raw['provider'] as VaultLaunchProvider : null
  }
}

type Client = Pick<VaultdClient, 'request'>

const grants = new Map<string, Record<string, LocalPermissionGrant>>()
const writes = new Map<string, Promise<void>>()

vaultTranscripts.onClose((vaultId) => {
  grants.delete(vaultId)
})

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {}
}

function chain(vaultId: string, write: () => Promise<unknown>): void {
  const next = (writes.get(vaultId) ?? Promise.resolve()).then(write).then(() => {}, (error: unknown) => {
    logger.warn('a vault agent state write failed', { vaultId, error: error instanceof Error ? error.message : String(error) })
  })
  writes.set(vaultId, next)
}

export const vaultAgentState = {
  /** Read the grants into memory (before a turn). */
  async load(vaultId: string, client: Client): Promise<void> {
    const { value } = await client.request('kv.get', { key: VAULT_KV_GRANTS })
    grants.set(vaultId, record(value) as Record<string, LocalPermissionGrant>)
  },

  isGranted(vaultId: string, request: LocalPermissionRequest): boolean {
    return isPermissionGranted(request, Object.values(grants.get(vaultId) ?? {}))
  },

  rememberGrant(vaultId: string, client: () => Promise<Client>, request: LocalPermissionRequest): boolean {
    const current = { ...(grants.get(vaultId) ?? {}) }
    const decidedAt = Date.now()
    for (const { pattern, scope } of permissionGrantPatterns(request)) {
      current[permissionGrantKey(request.action, pattern)] = { action: request.action, pattern, scope, decidedAt }
    }
    grants.set(vaultId, current)
    const snapshot = { ...current }
    chain(vaultId, async () => (await client()).request('kv.put', { key: VAULT_KV_GRANTS, value: snapshot }))
    return true
  },

  /** Remember a chat's engine session inside the vault (the DB keeps only the id, as for every agent). */
  saveSession(vaultId: string, client: () => Promise<Client>, chatId: string, sessionId: string): void {
    chain(vaultId, async () => {
      const c = await client()
      const { value } = await c.request('kv.get', { key: VAULT_KV_SESSIONS })
      await c.request('kv.put', { key: VAULT_KV_SESSIONS, value: { ...record(value), [chatId]: sessionId } })
    })
  },

  /** The launch settings the vault holds ({@link VAULT_LAUNCH_FALLBACK} when none). */
  async launch(client: Client): Promise<VaultLaunchSettings> {
    const { value } = await client.request('kv.get', { key: VAULT_KV_LAUNCH })
    return value === undefined || value === null ? { ...VAULT_LAUNCH_FALLBACK } : parseLaunchSettings(value)
  },

  /** Record launch settings in the vault: move-in, and any later change of mode or model. */
  async writeLaunch(client: Client, settings: VaultLaunchSettings): Promise<void> {
    const { provider, ...rest } = parseLaunchSettings(settings)
    // `provider` only where it means something (OpenCode).
    await client.request('kv.put', { key: VAULT_KV_LAUNCH, value: provider ? { ...rest, provider } : rest })
  },

  async instructions(client: Client): Promise<string | null> {
    const { value } = await client.request('kv.get', { key: VAULT_KV_INSTRUCTIONS })
    return typeof value === 'string' && value.trim() ? value : null
  },

  /** Writes still in flight for a vault (tests, and a move that must finish them). */
  settled(vaultId: string): Promise<void> {
    return writes.get(vaultId) ?? Promise.resolve()
  },

  resetForTest(): void {
    grants.clear()
    writes.clear()
  }
}
