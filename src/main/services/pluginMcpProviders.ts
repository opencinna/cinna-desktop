/**
 * A pinned plugin's MCP servers as **managed** Cinna MCP providers (unified
 * addons D5, README §6 q4): one `mcp_providers` row per server the plugin
 * snapshot's `.mcp.json` declares, `managed_by = plugin:<entry_uuid>@<sha>`,
 * attached to every agent that pins that snapshot with the server on. Never
 * native `.mcp.json` loading — one delivery path, one permission ask and one
 * credential form on every engine Cinna conducts.
 *
 * {@link createPluginMcpProviders}'s `sync` reconciles one agent:
 *
 * * Each enabled server of each cached pin gets its snapshot's row (created
 *   on first use) attached. Two agents on the same snapshot share the row;
 *   agents on different snapshots of the same plugin have a row each, so one
 *   never re-points or disconnects the other's server.
 * * A server turned off, or one a block names (the policy, a missing
 *   runtime), is **detached** from the agent and never deleted: its row and
 *   the values the user typed stay for when it comes back.
 * * A row is deleted only when no agent uses it and no pin anywhere
 *   references its snapshot (`deps.referenced`, read only then).
 * * A new snapshot's row starts with the values the user gave the same
 *   server of another snapshot of the plugin, so an Update asks nothing again.
 *
 * What a row holds: the command and args with `${CLAUDE_PLUGIN_ROOT}` already
 * the cached folder, a Python server pointed at the managed uv
 * (`stdioRuntimes.throughManagedUv`), the plugin's own env literals, and a
 * {@link ManagedSpec}: the folder, the names the user fills in (every `${VAR}`
 * placeholder — their values are encrypted, `mcp/managed.ts`) and an HTTP
 * server's declared headers. An `Authorization: Bearer ${X}` header makes the
 * connector a bearer one whose token is asked in its setup step.
 *
 * Pure over its {@link PluginMcpDeps}; `marketplacePluginService` wires the
 * real repos. Core: no Electron.
 */

import {
  encryptManagedSecrets,
  managedSecrets,
  pluginManagedBy,
  pluginOfManagedBy,
  pluginWorkDir,
  missingManagedEnv,
  snapshotKeyOfManagedBy,
  type ManagedSpec
} from '../mcp/managed'
import { runtimeOfCommand, throughManagedUv } from './stdioRuntimes'
import type { McpProviderRow, UpsertInput } from '../db/mcpProviders'
import type { ManagedUvLayout } from '../localdev/toolchain'
import type { PluginMcpServerSpec } from './pluginTree'

/** `${CLAUDE_PLUGIN_ROOT}` (and Codex's spelling) in a plugin's values. */
const ROOT_PLACEHOLDERS = /\$\{(CLAUDE_PLUGIN_ROOT|PLUGIN_ROOT)\}/g
const ANY_PLACEHOLDER = /\$\{([A-Za-z_][A-Za-z0-9_]*)\}/g
const BEARER_HEADER = /^Bearer \$\{([A-Za-z_][A-Za-z0-9_]*)\}$/

export interface PluginMcpDeps {
  rows(userId: string): McpProviderRow[]
  upsert(userId: string, input: UpsertInput): { id: string; created: boolean; row: McpProviderRow }
  /** Delete a row (disconnecting it first). */
  remove(userId: string, id: string): Promise<void>
  /** Drop a live connection so the next connect uses the new config. */
  disconnect(id: string): Promise<void>
  attached(userId: string, agentId: string): string[]
  attach(userId: string, agentId: string, id: string): void
  detach(userId: string, agentId: string, id: string): void
  /** Agents (any) a row is attached to. */
  agentsUsing(id: string): string[]
  /**
   * Every `entry/sha` some agent's pin names (lowercase), or null when the
   * pins cannot all be read — then nothing is deleted.
   */
  referenced(): ReadonlySet<string> | null
  uv(): Pick<ManagedUvLayout, 'uvBin' | 'uvxBin'>
}

/** One plugin pin of the agent, as the sync sees it. */
export interface PluginServers {
  entryUuid: string
  /** The pin's snapshot digest: which row the agent's servers are. */
  sha: string
  /** The cached plugin folder; null when the snapshot is not usable on this computer (its rows are left as they are). */
  dir: string | null
  servers: PluginMcpServerSpec[]
  /** Server names turned off on this agent's pin. */
  disabled: readonly string[]
}

/** What one server became for the agent. */
export interface ServerOutcome {
  entryUuid: string
  name: string
  mcpProviderId?: string
  /** Not delivered: the sentence why (policy, a missing runtime). */
  blocked?: string
  missingEnv: string[]
  /** The connector's bearer token is still to be given. */
  needsBearer?: boolean
}

const rootFilled = (value: string, dir: string): string => value.replace(ROOT_PLACEHOLDERS, dir)

/** The names a value needs from the user: its `${VAR}`s that are not the plugin root. */
function placeholdersIn(value: string): string[] {
  return [...value.matchAll(ANY_PLACEHOLDER)].map((match) => match[1]).filter((name) => name !== 'CLAUDE_PLUGIN_ROOT' && name !== 'PLUGIN_ROOT')
}

export type ManagedRowSpec = Pick<UpsertInput, 'transportType' | 'command' | 'args' | 'url' | 'env' | 'authType'> & { managedSpec: ManagedSpec }

/**
 * The row a server becomes for the cached folder `dir`. The plugin's env
 * values are its own (literals, and templates such as `${API_KEY}` filled at
 * launch); the user's values live apart, by the slot names this answers.
 */
export function managedRowSpec(
  spec: PluginMcpServerSpec,
  dir: string,
  uv: Pick<ManagedUvLayout, 'uvBin' | 'uvxBin'>,
  /** This snapshot's writable working copy (`pluginWorkDir`), for a uv project with no lock; null: none. */
  work: string | null = null
): ManagedRowSpec {
  const env: Record<string, string> = {}
  const slots = new Set<string>()
  for (const [name, raw] of Object.entries(spec.env)) {
    const value = rootFilled(raw, dir)
    env[name] = value
    for (const asked of placeholdersIn(value)) slots.add(asked)
  }
  for (const value of [spec.command ?? '', ...spec.args, spec.url ?? '']) for (const name of placeholdersIn(rootFilled(value, dir))) slots.add(name)
  if (spec.transport === 'stdio') {
    const command = rootFilled(spec.command ?? '', dir)
    const args = spec.args.map((arg) => rootFilled(arg, dir))
    const run = runtimeOfCommand(command) === 'python' ? throughManagedUv(command, args, uv, dir, work) : { command, args }
    const usesWork = 'usesWork' in run && run.usesWork === true && work !== null
    return {
      transportType: 'stdio',
      command: run.command,
      args: run.args,
      url: null,
      env,
      managedSpec: { root: dir, slots: [...slots].sort(), ...(usesWork ? { work } : {}) }
    }
  }
  const headers: Record<string, string> = {}
  let bearer = false
  for (const [name, raw] of Object.entries(spec.headers)) {
    const value = rootFilled(raw, dir)
    if (name.toLowerCase() === 'authorization' && BEARER_HEADER.test(value.trim())) {
      // The token is the connector's bearer token, given in its setup step.
      bearer = true
      continue
    }
    headers[name] = value
    for (const asked of placeholdersIn(value)) slots.add(asked)
  }
  const hasHeaders = Object.keys(headers).length > 0
  return {
    transportType: spec.transport === 'sse' ? 'sse' : 'streamable-http',
    command: null,
    args: null,
    url: rootFilled(spec.url ?? '', dir),
    env: Object.keys(env).length > 0 ? env : null,
    // Declared headers are the server's own auth: never an OAuth round-trip on top.
    authType: bearer || hasHeaders ? 'bearer' : 'oauth',
    managedSpec: {
      root: dir,
      slots: [...slots].sort(),
      ...(hasHeaders ? { headers } : {}),
      ...(bearer ? { bearer: true } : {})
    }
  }
}

const sameJson = (a: unknown, b: unknown): boolean => JSON.stringify(a ?? null) === JSON.stringify(b ?? null)

export function createPluginMcpProviders(deps: PluginMcpDeps) {
  /**
   * Detach `id` from the agent. A row nothing uses any more is disconnected,
   * and deleted when `deletable` (no pin references its snapshot).
   */
  async function release(userId: string, agentId: string, id: string, deletable: () => boolean): Promise<void> {
    deps.detach(userId, agentId, id)
    if (deps.agentsUsing(id).length > 0) return
    if (deletable()) await deps.remove(userId, id)
    else await deps.disconnect(id)
  }

  /** Values the user gave this server on another snapshot of the plugin, for a new row. */
  function inherited(userId: string, entryUuid: string, name: string, slots: readonly string[]): Pick<UpsertInput, 'envSecretEncrypted' | 'bearerTokenEncrypted'> {
    const uuid = entryUuid.trim().toLowerCase()
    const siblings = deps
      .rows(userId)
      .filter((row) => row.name === name && pluginOfManagedBy(row.managedBy)?.entryUuid === uuid)
      .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime())
    const values: Record<string, string> = {}
    for (const row of siblings) {
      const given = managedSecrets(row)
      for (const slot of slots) if (!(slot in values) && given[slot]) values[slot] = given[slot]
    }
    const token = siblings.find((row) => row.bearerTokenEncrypted)?.bearerTokenEncrypted ?? null
    return { envSecretEncrypted: encryptManagedSecrets(values), ...(token ? { bearerTokenEncrypted: token } : {}) }
  }

  return {
    /**
     * Reconcile the agent's managed connectors with its plugin pins. `block`
     * answers why a server may not be delivered here (policy, a missing
     * runtime), or null. Answers what each server became.
     */
    async sync(
      userId: string,
      agentId: string,
      plugins: readonly PluginServers[],
      block: (spec: PluginMcpServerSpec) => string | null
    ): Promise<ServerOutcome[]> {
      const outcomes: ServerOutcome[] = []
      const keep = new Set<string>()
      for (const plugin of plugins) {
        const managedBy = pluginManagedBy(plugin.entryUuid, plugin.sha)
        if (!plugin.dir) {
          // Not usable on this computer: what the agent has of this plugin stays until the snapshot is.
          const uuid = plugin.entryUuid.trim().toLowerCase()
          for (const id of deps.attached(userId, agentId)) {
            const row = deps.rows(userId).find((candidate) => candidate.id === id)
            if (row && pluginOfManagedBy(row.managedBy)?.entryUuid === uuid) keep.add(id)
          }
          continue
        }
        const off = new Set(plugin.disabled)
        for (const spec of plugin.servers) {
          const row = deps.rows(userId).find((candidate) => candidate.managedBy === managedBy && candidate.name === spec.name)
          if (off.has(spec.name)) continue
          const blocked = block(spec)
          if (blocked) {
            outcomes.push({ entryUuid: plugin.entryUuid, name: spec.name, blocked, missingEnv: [] })
            continue
          }
          const wanted = managedRowSpec(spec, plugin.dir, deps.uv(), pluginWorkDir(managedBy))
          let current = row
          if (!row) {
            current = deps.upsert(userId, {
              name: spec.name,
              ...wanted,
              enabled: true,
              managedBy,
              ...inherited(userId, plugin.entryUuid, spec.name, wanted.managedSpec.slots)
            }).row
          } else if (
            row.transportType !== wanted.transportType ||
            (row.command ?? null) !== (wanted.command ?? null) ||
            !sameJson(row.args, wanted.args) ||
            (row.url ?? null) !== (wanted.url ?? null) ||
            !sameJson(row.env, wanted.env) ||
            (wanted.authType !== undefined && row.authType !== wanted.authType) ||
            !sameJson(row.managedSpec, wanted.managedSpec)
          ) {
            // The same snapshot from another folder (another instance's cache): the user's values stay.
            current = deps.upsert(userId, { id: row.id, name: spec.name, ...wanted, enabled: row.enabled }).row
            await deps.disconnect(row.id)
          }
          if (!current) continue
          if (!deps.attached(userId, agentId).includes(current.id)) deps.attach(userId, agentId, current.id)
          keep.add(current.id)
          const needsBearer = current.managedSpec?.bearer === true && !current.bearerTokenEncrypted
          outcomes.push({
            entryUuid: plugin.entryUuid,
            name: spec.name,
            mcpProviderId: current.id,
            missingEnv: missingManagedEnv(current),
            ...(needsBearer ? { needsBearer } : {})
          })
        }
      }
      // Everything managed this agent holds that no pinned, enabled, deliverable server wants now.
      let referenced: ReadonlySet<string> | null | undefined
      const deletable = (row: McpProviderRow) => (): boolean => {
        if (referenced === undefined) referenced = deps.referenced()
        const key = snapshotKeyOfManagedBy(row.managedBy)
        return referenced !== null && (key === null || !referenced.has(key))
      }
      for (const id of deps.attached(userId, agentId)) {
        if (keep.has(id)) continue
        const row = deps.rows(userId).find((candidate) => candidate.id === id)
        // A connector the user attached by hand is never this sync's to drop.
        if (!row || !pluginOfManagedBy(row.managedBy)) continue
        await release(userId, agentId, id, deletable(row))
      }
      return outcomes
    },

    /**
     * Delete every managed row of `userId` that no agent uses and no pin
     * references (`referenced`, `entry/sha`). Answers how many went.
     */
    async collectUnreferenced(userId: string, referenced: ReadonlySet<string>): Promise<number> {
      let removed = 0
      for (const row of deps.rows(userId)) {
        if (!pluginOfManagedBy(row.managedBy)) continue
        const key = snapshotKeyOfManagedBy(row.managedBy)
        if (key !== null && referenced.has(key)) continue
        if (deps.agentsUsing(row.id).length > 0) continue
        await deps.remove(userId, row.id)
        removed++
      }
      return removed
    }
  }
}

export type PluginMcpProviders = ReturnType<typeof createPluginMcpProviders>
