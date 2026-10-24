/**
 * Managed MCP providers — the `mcp_providers` rows a pinned marketplace
 * plugin's snapshot owns (`managed_by = plugin:<entry_uuid>@<archive_sha256>`,
 * unified addons D5). The parts of their lifecycle every caller shares, kept
 * beside the row→config mapping so a launch always resolves them the same way:
 *
 * * **One row per snapshot.** Two agents pinning the same snapshot share a
 *   row; agents on different snapshots have one each, so neither re-points
 *   the other's server. A row is deleted only once no pin references its
 *   snapshot (`pluginMcpProviders.ts`).
 * * **The user's values are secret.** The names the plugin's `.mcp.json`
 *   leaves to the user — its `${VAR}` placeholders, `ManagedSpec.slots` — are
 *   stored encrypted (`env_secret_enc`, safeStorage, like a bearer token) and
 *   only ever read here, in main, at launch. The plain `env` holds the
 *   plugin's own literals (a `"API_KEY": "${API_KEY}"` entry stays that
 *   template); what the user types never overwrites them.
 * * **Placeholders at launch.** Every `${VAR}` in the command, args, URL,
 *   env values and declared headers is filled from the user's values, then
 *   the plugin's literals. `${CLAUDE_PLUGIN_ROOT}` is already the cached
 *   folder: the plugin service writes it on create.
 * * **The managed uv.** A server written to run through the app's pinned uv
 *   is handed the toolchain's `UV_*` environment, plus its own writable
 *   project environment (`UV_PROJECT_ENVIRONMENT`) under
 *   `<userData>/plugin-envs/<entry>/<sha>/<server>`, so `uv run --directory`
 *   never writes into the read-only cache.
 * * **Not launched** when the cached tree no longer matches its install
 *   digests, or the policy forbids local servers: the config carries
 *   `blockedReason`, and the manager answers that as the connection's error.
 * * **Needs setup.** A slot with no value: such a provider is not connected
 *   unattended, and the directory reads it "Needs settings filled in".
 *
 * Core: no Electron.
 */

import { join } from 'node:path'
import { managedUvLayout } from '../localdev/toolchain'
import { runtimeHost } from '../host/runtimeHost'
import { decryptApiKey, encryptApiKey } from '../security/keystore'
import { verifyPluginTree, PLUGIN_TREE_MODIFIED_SENTENCE } from '../services/marketplacePluginCache'
import { addonPolicies } from '../services/addonDirectory/policy'
import { STDIO_RUNTIME_TEXT } from '../services/stdioRuntimes'
import type { McpProviderConfig } from './types'

export const PLUGIN_MANAGER_PREFIX = 'plugin:'

/** What a managed row carries beside its command (the `managed_spec` column). */
export interface ManagedSpec {
  /** The cached plugin folder the server runs from (`${CLAUDE_PLUGIN_ROOT}`). */
  root: string
  /** The names the user gives a value for — the plugin's `${VAR}` placeholders — stored encrypted. */
  slots: string[]
  /** An HTTP server's declared headers, `${VAR}` unresolved; an `Authorization: Bearer ${X}` is the bearer token instead. */
  headers?: Record<string, string>
  /** The plugin sends `Authorization: Bearer ${X}`: the token is the connector's bearer token, asked in its setup step. */
  bearer?: boolean
}

/** The row fields the managed helpers read. */
export interface ManagedRowFields {
  managedBy?: string | null
  managedSpec?: ManagedSpec | null
  envSecretEncrypted?: Buffer | null
  bearerTokenEncrypted?: Buffer | null
}

/** The `managed_by` value of the providers of a plugin's snapshot. */
export function pluginManagedBy(entryUuid: string, archiveSha256: string): string {
  return `${PLUGIN_MANAGER_PREFIX}${entryUuid.trim().toLowerCase()}@${archiveSha256.trim().toLowerCase()}`
}

/** The plugin snapshot a `managed_by` value names, or null for a provider no plugin owns. */
export function pluginOfManagedBy(managedBy: string | null | undefined): { entryUuid: string; sha: string | null } | null {
  if (typeof managedBy !== 'string' || !managedBy.startsWith(PLUGIN_MANAGER_PREFIX)) return null
  const rest = managedBy.slice(PLUGIN_MANAGER_PREFIX.length)
  const at = rest.indexOf('@')
  return at === -1 ? { entryUuid: rest, sha: null } : { entryUuid: rest.slice(0, at), sha: rest.slice(at + 1) || null }
}

/** The `entry/sha` key a managed row keeps its snapshot by (garbage collection's), or null. */
export function snapshotKeyOfManagedBy(managedBy: string | null | undefined): string | null {
  const owner = pluginOfManagedBy(managedBy)
  return owner && owner.sha ? `${owner.entryUuid}/${owner.sha}` : null
}

/** The user's values of a managed row, decrypted (empty when none, or unreadable). Main only. */
export function managedSecrets(row: Pick<ManagedRowFields, 'envSecretEncrypted'>): Record<string, string> {
  if (!row.envSecretEncrypted) return {}
  try {
    const parsed = JSON.parse(decryptApiKey(row.envSecretEncrypted)) as unknown
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {}
    return Object.fromEntries(Object.entries(parsed).filter((pair): pair is [string, string] => typeof pair[1] === 'string'))
  } catch {
    return {}
  }
}

/** `values` (empty ones dropped) as the encrypted column, or null when nothing is left. */
export function encryptManagedSecrets(values: Readonly<Record<string, string>>): Buffer | null {
  const kept = Object.fromEntries(Object.entries(values).filter(([, value]) => typeof value === 'string' && value !== ''))
  return Object.keys(kept).length > 0 ? encryptApiKey(JSON.stringify(kept)) : null
}

/** Each name the user fills in, and whether it has a value — all the renderer ever learns of them. */
export function managedSlotStates(row: ManagedRowFields): Array<{ name: string; hasValue: boolean }> {
  if (!row.managedBy) return []
  const values = managedSecrets(row)
  return (row.managedSpec?.slots ?? []).map((name) => ({ name, hasValue: typeof values[name] === 'string' && values[name] !== '' }))
}

/** The names a managed provider still needs a value for. Only `${VAR}` placeholders count; the plugin's literals never do. */
export function missingManagedEnv(row: ManagedRowFields): string[] {
  return managedSlotStates(row)
    .filter((slot) => !slot.hasValue)
    .map((slot) => slot.name)
}

/** A managed HTTP server that sends the user's token as `Authorization: Bearer …`, and has none yet. */
export function managedNeedsBearer(row: ManagedRowFields): boolean {
  return !!row.managedBy && row.managedSpec?.bearer === true && !row.bearerTokenEncrypted
}

/** A managed HTTP server whose declared headers are its whole auth: it connects with no token of the user's. */
export function managedHeadersOnly(row: ManagedRowFields): boolean {
  return !!row.managedBy && row.managedSpec?.bearer !== true && Object.keys(row.managedSpec?.headers ?? {}).length > 0
}

const PLACEHOLDER = /\$\{([A-Za-z_][A-Za-z0-9_]*)\}/g

/** `${VAR}` filled from `values`; an unknown name is left as written. */
export function fillPlaceholders(text: string, values: Readonly<Record<string, string>>): string {
  return text.replace(PLACEHOLDER, (whole, name: string) => (Object.prototype.hasOwnProperty.call(values, name) ? values[name] : whole))
}

/** A path component made of a server name. */
const safeComponent = (name: string): string => name.replace(/[^A-Za-z0-9._-]/g, '_').replace(/^\.+/, '_').slice(0, 64) || '_'

/** `<userData>/plugin-envs/<entry>/<sha>/<server>`: where uv puts a managed server's project environment. */
export function pluginProjectEnvDir(managedBy: string | null | undefined, serverName: string): string | null {
  const owner = pluginOfManagedBy(managedBy)
  if (!owner) return null
  try {
    return join(runtimeHost.getPath('userData'), 'plugin-envs', safeComponent(owner.entryUuid), safeComponent(owner.sha ?? 'unpinned'), safeComponent(serverName))
  } catch {
    return null
  }
}

/** Why a managed row must not be launched now (its tree changed on disk, the policy), or null. */
export function managedLaunchBlock(row: ManagedRowFields & { userId?: string; transportType?: string }): string | null {
  if (!row.managedBy || row.transportType !== 'stdio') return null
  if (row.userId && !addonPolicies.get(row.userId).stdioMcp) return STDIO_RUNTIME_TEXT.policy
  const root = row.managedSpec?.root
  if (root && !verifyPluginTree(root)) return PLUGIN_TREE_MODIFIED_SENTENCE
  return null
}

/**
 * A managed row's config as it is launched: placeholders filled from the
 * user's values and the plugin's literals, declared headers resolved, the
 * managed uv's environment under a command that is the managed uv, and
 * `blockedReason` when it must not run. Anything not managed is returned
 * unchanged.
 */
export function resolveManagedLaunch(config: McpProviderConfig, row: ManagedRowFields): McpProviderConfig {
  if (!row.managedBy) return config
  const literals = config.env ?? {}
  const values = { ...literals, ...managedSecrets(row) }
  const fill = (text: string): string => fillPlaceholders(text, values)
  const env = Object.fromEntries(Object.entries(literals).map(([name, value]) => [name, fill(value)]))
  let uvEnv: Record<string, string> = {}
  if (config.transportType === 'stdio' && config.command) {
    try {
      const uv = managedUvLayout()
      if (config.command === uv.uvxBin || config.command === uv.uvBin) {
        uvEnv = { ...uv.env }
        const project = pluginProjectEnvDir(row.managedBy, config.name)
        if (project) uvEnv.UV_PROJECT_ENVIRONMENT = project
      }
    } catch {
      // No userData on this host: the command is not the managed uv either.
    }
  }
  const declared = row.managedSpec?.headers ?? {}
  const headers = Object.fromEntries(Object.entries(declared).map(([name, value]) => [name, fill(value)]))
  const blockedReason = managedLaunchBlock({ ...row, userId: config.userId, transportType: config.transportType })
  return {
    ...config,
    ...(config.command ? { command: fill(config.command) } : {}),
    ...(config.args ? { args: config.args.map(fill) } : {}),
    ...(config.url ? { url: fill(config.url) } : {}),
    env: { ...uvEnv, ...env },
    ...(Object.keys(headers).length > 0 ? { headers } : {}),
    ...(blockedReason ? { blockedReason } : {})
  }
}
