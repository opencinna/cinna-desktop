/**
 * Service credentials of a vault agent (phase 2). A folder agent's attached
 * credentials become a `credentials.json` its skills read through
 * `CINNA_CREDENTIALS_PATH`; for an agent in a vault that file is rendered in
 * memory here (`serviceCredentialService.vaultFiles`) and handed to vaultd
 * with `secrets.putFile`, which keeps it root-only and gives the agent a 0400
 * copy in `<vault>/run-secrets/` (vaultd `secretFiles.ts`). Nothing is
 * written on this computer.
 *
 * Which credentials: the attachments the agent had when it moved in, captured
 * into the vault's own store (`cinna.serviceCredentials`); a vault agent has
 * no folder here to keep them in. Delivered at move-in (the credentials
 * step) and before each turn, but only when the rendered files changed since
 * the last delivery in this process (a rotated key, a renewed Google access
 * token, a record that became unavailable). A Google token is never refreshed from
 * inside: the token server on this computer is out of a vault's reach.
 */
import { createHash } from 'node:crypto'
import { posix } from 'node:path'
import type { ServiceCredentialAttachments } from '../../shared/serviceCredentials'
import { createLogger } from '../logger/logger'
import type { VaultdClient } from './vaultdClient'

const logger = createLogger('vault-credentials')

/** The attachments captured at move-in, in the vault's key-value store. */
export const VAULT_KV_SERVICE_CREDENTIALS = 'cinna.serviceCredentials'

type Client = Pick<VaultdClient, 'request'>

/** What renders the files (the service credential service); injected so the vault core does not import it eagerly. */
export interface VaultCredentialSource {
  attachmentsOf(agentId: string): ServiceCredentialAttachments
  vaultFiles(attachments: ServiceCredentialAttachments, directory: string): Promise<{ files: Map<string, string>; generation: string }>
}

async function defaultSource(): Promise<VaultCredentialSource> {
  const { serviceCredentialService } = await import('../services/serviceCredentials/service')
  return serviceCredentialService
}

let sourceOverride: VaultCredentialSource | null = null

/** Test seam. */
export function setVaultCredentialSourceForTest(source: VaultCredentialSource | null): void {
  sourceOverride = source
}

function source(): Promise<VaultCredentialSource> {
  return sourceOverride ? Promise.resolve(sourceOverride) : defaultSource()
}

/** Per vault: a digest of the files last delivered and their names. */
const delivered = new Map<string, { generation: string; names: string[] }>()

function parseAttachments(value: unknown): ServiceCredentialAttachments | null {
  if (!value || typeof value !== 'object') return null
  const raw = value as Record<string, unknown>
  const refs = (list: unknown): { ref: string }[] => Array.isArray(list)
    ? list.flatMap((item) => item && typeof (item as { ref?: unknown }).ref === 'string' ? [{ ...(item as object), ref: (item as { ref: string }).ref }] : [])
    : []
  const accounts: Record<string, { ref: string }[]> = {}
  if (raw['accounts'] && typeof raw['accounts'] === 'object') {
    for (const [key, list] of Object.entries(raw['accounts'] as Record<string, unknown>)) accounts[key] = refs(list)
  }
  return { local: refs(raw['local']), accounts } as ServiceCredentialAttachments
}

function hasAny(attachments: ServiceCredentialAttachments | null): attachments is ServiceCredentialAttachments {
  return !!attachments && (attachments.local.length > 0 || Object.values(attachments.accounts).some((list) => list.length > 0))
}

/** Where the agent's copies are, as processes in the vault see them: beside the agent folder. */
export function runSecretsDir(agentCwd: string): string {
  return posix.join(posix.dirname(agentCwd), 'run-secrets')
}

/**
 * Render and deliver the credentials for `attachments` when the files differ
 * from the last delivery. Returns the number of files written (0 when
 * nothing changed). Throws when the vault refuses a write.
 */
async function deliverAttachments(vaultId: string, client: Client, attachments: ServiceCredentialAttachments, agentCwd: string): Promise<number> {
  const { files } = await (await source()).vaultFiles(attachments, runSecretsDir(agentCwd))
  // The bytes, not the credential generation: a renewed Google access token keeps the
  // generation (the host rewrites its file in place) and must still reach the vault.
  const generation = createHash('sha256').update(JSON.stringify([...files].sort(([a], [b]) => a.localeCompare(b)))).digest('hex')
  const last = delivered.get(vaultId)
  if (last && last.generation === generation) return 0
  for (const [name, content] of files) await client.request('secrets.putFile', { name, content })
  // What the last delivery left that this one does not have; credentials.json always goes when empty.
  const stale = new Set([...(last?.names ?? []), ...(files.has('credentials.json') ? [] : ['credentials.json'])])
  for (const name of stale) if (!files.has(name)) await client.request('secrets.putFile', { name, content: null })
  delivered.set(vaultId, { generation, names: [...files.keys()] })
  return files.size
}

export const vaultCredentials = {
  /**
   * Move-in: capture the host agent's attachments into the vault and deliver
   * them. Returns how many files went in (0: none attached).
   */
  async moveIn(vaultId: string, client: Client, agentId: string, agentCwd: string): Promise<number> {
    const attachments = (await source()).attachmentsOf(agentId)
    if (!hasAny(attachments)) return 0
    await client.request('kv.put', { key: VAULT_KV_SERVICE_CREDENTIALS, value: attachments })
    return deliverAttachments(vaultId, client, attachments, agentCwd)
  },

  /**
   * Before a turn: deliver again when the files changed. A vault with
   * no captured attachments costs one `kv.get`. Never throws: a delivery that
   * fails leaves the last one in place and is tried again next turn.
   */
  async beforeTurn(vaultId: string, client: Client, agentCwd: string): Promise<void> {
    try {
      const attachments = parseAttachments((await client.request('kv.get', { key: VAULT_KV_SERVICE_CREDENTIALS })).value)
      if (!hasAny(attachments)) return
      await deliverAttachments(vaultId, client, attachments, agentCwd)
    } catch (error) {
      logger.warn('could not deliver service credentials into a vault', { vaultId, error: error instanceof Error ? error.message : String(error) })
    }
  },

  /** A vault left this process's hands (destroyed, moved out): forget what was delivered. */
  forget(vaultId: string): void {
    delivered.delete(vaultId)
  },

  /** Test seam. */
  resetForTest(): void {
    delivered.clear()
  }
}
