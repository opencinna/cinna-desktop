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
 *   never writes into the read-only cache. A uv project with no `uv.lock`,
 *   and a `uvx --from <folder>`, run from a writable working copy of the
 *   server's tree (`ManagedSpec.work`, `<userData>/plugin-work/<entry>/<sha>/<server>`),
 *   copied from the verified cache in the connect, once the old process has
 *   stopped, and checked against what was recorded at copy before every
 *   launch; never deleted or recopied under a running server (`workCopy.ts`).
 * * **Not launched** when the cached tree no longer matches its install
 *   digests, or the policy forbids local servers: the config carries
 *   `blockedReason`, and the manager answers that as the connection's error.
 * * **Needs setup.** A slot with no value: such a provider is not connected
 *   unattended, and the directory reads it "Needs settings filled in".
 *
 * A connector made from a directory entry (`registry_ref`, not a plugin's)
 * shares two of these rules: under the managed uv it gets uv's environment,
 * and a local one is not launched while the policy forbids local servers
 * ({@link resolveManagedLaunch}). A local one's settings are secret too: the
 * plain `env` lists their names, the values are encrypted beside them
 * ({@link isDirectorySecretRow}); a name with no value is one still to fill
 * in ({@link missingEnvOf}).
 *
 * A hand-made local connector (no plugin, no directory entry) is never
 * blocked here: `policy.stdio_mcp` forbids *adding* one
 * (`mcpService.upsert`), not running one the user already made, and a policy
 * change stops only a plugin's and a directory's local servers
 * (`services/addonDirectory/policyFollow.ts`).
 *
 * Core: no Electron.
 */

import { readdirSync, rmSync, type Dirent } from 'node:fs'
import { join } from 'node:path'
import { managedUvLayout } from '../localdev/toolchain'
import { runtimeHost } from '../host/runtimeHost'
import { decryptApiKey, encryptApiKey } from '../security/keystore'
import { verifyPluginTree, PLUGIN_TREE_MODIFIED_SENTENCE } from '../services/marketplacePluginCache'
import { addonPolicies } from '../services/addonDirectory/policy'
import { STDIO_RUNTIME_TEXT } from '../services/stdioRuntimes'
import type { McpProviderConfig } from './types'
import { isWorkInUse, type WorkCopySpec } from './workCopy'

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
  /** The writable working copy of {@link root} the command runs from (a uv project with no lock); made at launch. */
  work?: string
}

/** The row fields the managed helpers read. */
export interface ManagedRowFields {
  managedBy?: string | null
  /** The directory entry a connector was made from (`registry_ref`). */
  registryRef?: { source: string; id: string } | null
  /** The row's plain env (a directory connector's setting names live here). */
  env?: unknown
  transportType?: string
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

/**
 * A connector made from a directory entry that runs on this computer
 * (`registry_ref`, stdio, no plugin): its settings are secret, as a
 * plugin's are. The plain `env` lists their names, each `''`; the values
 * are stored encrypted (`env_secret_enc`). A value still in the plain `env`
 * (stored before they were encrypted) counts until the next read or write
 * moves it ({@link directoryEnvToSeal}).
 */
export function isDirectorySecretRow(row: ManagedRowFields): boolean {
  return !row.managedBy && !!row.registryRef && row.transportType === 'stdio'
}

const plainEnvOf = (row: ManagedRowFields): Record<string, unknown> =>
  row.env && typeof row.env === 'object' && !Array.isArray(row.env) ? (row.env as Record<string, unknown>) : {}

/** A directory connector's values: the encrypted ones over any still in the plain `env`. Main only. */
export function directorySecrets(row: ManagedRowFields): Record<string, string> {
  const plain = Object.fromEntries(Object.entries(plainEnvOf(row)).filter((pair): pair is [string, string] => typeof pair[1] === 'string' && pair[1] !== ''))
  return { ...plain, ...managedSecrets(row) }
}

/** A directory connector's setting names, sorted: the plain `env`'s and any with an encrypted value. */
export function directoryEnvNames(row: ManagedRowFields): string[] {
  return [...new Set([...Object.keys(plainEnvOf(row)), ...Object.keys(managedSecrets(row))])].sort()
}

/** Each of a directory connector's settings and whether it has a value — all the renderer learns of them. */
export function directorySlotStates(row: ManagedRowFields): Array<{ name: string; hasValue: boolean }> {
  const values = directorySecrets(row)
  return directoryEnvNames(row).map((name) => ({ name, hasValue: typeof values[name] === 'string' && values[name] !== '' }))
}

/**
 * The columns that move a directory connector's plain values into the
 * encrypted one — names only left in `env` — or null when none is plain.
 */
export function directoryEnvToSeal(row: ManagedRowFields): { env: Record<string, string> | null; envSecretEncrypted: Buffer | null } | null {
  if (!isDirectorySecretRow(row)) return null
  const plain = plainEnvOf(row)
  if (!Object.values(plain).some((value) => typeof value === 'string' && value !== '')) return null
  const names = directoryEnvNames(row)
  return {
    env: names.length > 0 ? Object.fromEntries(names.map((name) => [name, ''])) : null,
    envSecretEncrypted: encryptManagedSecrets(directorySecrets(row))
  }
}

/**
 * The names a connector still needs a value for before it can run: a
 * plugin's empty slots, or — for one made from a directory entry — its
 * settings with no value yet. A hand-made connector's env is the user's as typed.
 */
export function missingEnvOf(row: ManagedRowFields): string[] {
  if (row.managedBy) return missingManagedEnv(row)
  if (!row.registryRef) return []
  if (isDirectorySecretRow(row)) return directorySlotStates(row).filter((slot) => !slot.hasValue).map((slot) => slot.name)
  return Object.entries(plainEnvOf(row))
    .filter(([, value]) => value === '' || value === null || value === undefined)
    .map(([name]) => name)
    .sort()
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

/**
 * `<userData>/plugin-work/<entry>/<sha>/<server>`: a plugin server's writable
 * working copy (`workCopy.ts`), for servers that write into their project;
 * without `serverName`, the snapshot's folder of them.
 */
export function pluginWorkDir(managedBy: string | null | undefined, serverName?: string): string | null {
  const owner = pluginOfManagedBy(managedBy)
  if (!owner || !owner.sha) return null
  try {
    const snapshot = join(runtimeHost.getPath('userData'), 'plugin-work', safeComponent(owner.entryUuid), safeComponent(owner.sha))
    return serverName === undefined ? snapshot : join(snapshot, safeComponent(serverName))
  } catch {
    return null
  }
}

/**
 * Remove a snapshot's folder of working copies, its marker and staging
 * leftovers — except a server's copy a connection runs from now
 * (`isWorkInUse`), with its marker. Answers whether all of it went.
 */
function removeSnapshotWork(dir: string): boolean {
  if (!isWorkInUse(dir)) {
    rmSync(`${dir}.source`, { force: true })
    rmSync(dir, { recursive: true, force: true })
    return true
  }
  let copies: Dirent[]
  try {
    copies = readdirSync(dir, { withFileTypes: true })
  } catch {
    return false
  }
  for (const copy of copies) {
    const server = copy.name.replace(/\.(source|staging-.*)$/, '')
    if (isWorkInUse(join(dir, server))) continue
    rmSync(join(dir, copy.name), { recursive: true, force: true })
  }
  return false
}

/** Remove a snapshot's working copies (Update of a changed cache, a pin gone); the next launch copies them again. A copy in use stays. Never throws. */
export function discardPluginWork(managedBy: string | null | undefined): void {
  const dir = pluginWorkDir(managedBy)
  if (!dir) return
  try {
    removeSnapshotWork(dir)
  } catch {
    /* the next launch's check copies it again */
  }
}

/**
 * Remove every `plugin-work/<entry>/<sha>` folder of copies whose `entry/sha`
 * snapshot key is not in `keep` (the pins' and the remaining managed rows'),
 * with its marker and any staging leftover — never a copy a connection runs
 * from now. Never throws; answers how many snapshot folders went.
 */
export function collectPluginWork(keep: ReadonlySet<string>): number {
  let base: string
  try {
    base = join(runtimeHost.getPath('userData'), 'plugin-work')
  } catch {
    return 0
  }
  const kept = new Set([...keep].map((key) => {
    const [entry, sha] = key.split('/')
    return `${safeComponent(entry ?? '')}/${safeComponent(sha ?? '')}`
  }))
  let removed = 0
  let entries: Dirent[]
  try {
    entries = readdirSync(base, { withFileTypes: true })
  } catch {
    return 0
  }
  for (const entry of entries) {
    if (!entry.isDirectory()) continue
    const entryDir = join(base, entry.name)
    let snapshots: Dirent[]
    try {
      snapshots = readdirSync(entryDir, { withFileTypes: true })
    } catch {
      continue
    }
    for (const snapshot of snapshots) {
      const sha = snapshot.name.replace(/\.(source|staging-.*)$/, '')
      if (kept.has(`${entry.name}/${sha}`)) continue
      try {
        // A snapshot folder: its copies, unless a connection runs from one; a marker or staging leftover beside it goes.
        if (snapshot.isDirectory() && sha === snapshot.name) {
          if (removeSnapshotWork(join(entryDir, snapshot.name))) removed++
        } else if (!isWorkInUse(join(entryDir, sha))) {
          rmSync(join(entryDir, snapshot.name), { recursive: true, force: true })
        }
      } catch {
        /* tried again next start */
      }
    }
    try {
      if (readdirSync(entryDir).length === 0) rmSync(entryDir, { recursive: true, force: true })
    } catch {
      /* kept */
    }
  }
  return removed
}

export { ensurePluginWorkCopy } from './workCopy'

/** The sentence a server whose working copy could not be made is refused with. */
export const PLUGIN_WORK_COPY_FAILED = 'The plugin’s files could not be prepared to run on this computer.'

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
/** uv's environment when `config` runs the managed uv, else nothing. */
function managedUvEnv(config: McpProviderConfig): Record<string, string> | null {
  if (config.transportType !== 'stdio' || !config.command) return null
  try {
    const uv = managedUvLayout()
    return config.command === uv.uvxBin || config.command === uv.uvBin ? { ...uv.env } : null
  } catch {
    // No userData on this host: the command is not the managed uv either.
    return null
  }
}

/**
 * A connector made from a directory entry: uv's environment under the
 * managed uv, and refused while the policy forbids local servers. Never
 * deleted for it — it runs again once the policy allows.
 */
function directoryLaunch(config: McpProviderConfig, row: ManagedRowFields): McpProviderConfig {
  if (!row.registryRef || config.transportType !== 'stdio') return config
  const uvEnv = managedUvEnv(config)
  const blocked = config.userId && !addonPolicies.get(config.userId).stdioMcp ? STDIO_RUNTIME_TEXT.policy : null
  // The user's values, decrypted here only, over the names still to fill (left `''`, as they were stored).
  const values = isDirectorySecretRow({ ...row, transportType: config.transportType }) ? directorySecrets(row) : {}
  const env = { ...(config.env ?? {}), ...values }
  if (!uvEnv && !blocked && Object.keys(values).length === 0) return config
  return {
    ...config,
    ...(uvEnv || Object.keys(env).length > 0 ? { env: { ...(uvEnv ?? {}), ...env } } : {}),
    ...(blocked ? { blockedReason: blocked } : {})
  }
}

export function resolveManagedLaunch(config: McpProviderConfig, row: ManagedRowFields): McpProviderConfig {
  if (!row.managedBy) return directoryLaunch(config, row)
  const literals = config.env ?? {}
  const values = { ...literals, ...managedSecrets(row) }
  const fill = (text: string): string => fillPlaceholders(text, values)
  const env = Object.fromEntries(Object.entries(literals).map(([name, value]) => [name, fill(value)]))
  let uvEnv: Record<string, string> = managedUvEnv(config) ?? {}
  if (Object.keys(uvEnv).length > 0) {
    const project = pluginProjectEnvDir(row.managedBy, config.name)
    if (project) uvEnv = { ...uvEnv, UV_PROJECT_ENVIRONMENT: project }
  }
  const declared = row.managedSpec?.headers ?? {}
  const headers = Object.fromEntries(Object.entries(declared).map(([name, value]) => [name, fill(value)]))
  const blockedReason = managedLaunchBlock({ ...row, userId: config.userId, transportType: config.transportType })
  const work = row.managedSpec?.work
  const root = row.managedSpec?.root
  // Checked and made in the connect, once the old process has stopped (`workCopy.ts`), never here.
  const workCopy: WorkCopySpec | null =
    !blockedReason && work && root && config.transportType === 'stdio'
      ? { root, work, changedReason: PLUGIN_TREE_MODIFIED_SENTENCE, failedReason: PLUGIN_WORK_COPY_FAILED }
      : null
  return {
    ...config,
    ...(config.command ? { command: fill(config.command) } : {}),
    ...(config.args ? { args: config.args.map(fill) } : {}),
    ...(config.url ? { url: fill(config.url) } : {}),
    env: { ...uvEnv, ...env },
    ...(Object.keys(headers).length > 0 ? { headers } : {}),
    ...(blockedReason ? { blockedReason } : {}),
    ...(workCopy ? { workCopy } : {})
  }
}
