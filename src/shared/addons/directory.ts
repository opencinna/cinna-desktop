/**
 * The addon directory: every skill, plugin and MCP connector a local agent
 * could add, from every source this computer and the signed-in account may
 * use, normalised into one {@link DirectoryEntry} shape before it reaches the
 * renderer. The renderer never sees catalogs, marketplaces or registries as
 * separate APIs.
 *
 * The entry mirrors cinna-core's `DirectoryEntry` field for field, in
 * camelCase; core sends snake_case and the `cinnaCore` directory provider in
 * main maps it. Compatibility is not in the entry: main annotates each entry
 * with its {@link AgentAddonState} for one agent ({@link AgentDirectoryEntry}).
 *
 * Channels (`addons.ipc.ts`): `addons:directory` (`{agentId, refresh?}`;
 * `refresh` re-reads the sources' caches), `addons:search`, `addons:add`,
 * `addons:remove`. Every answer is data — a refusal is `{ok: false, code,
 * message}`, never a thrown error, because a thrown `DomainError`'s code does
 * not survive IPC.
 */

export type AddonKind = 'skill' | 'plugin' | 'mcp'

/**
 * An entry's stable reference, opaque per source. Sources this build knows:
 * `core-catalog` (id = the catalog package uuid), `core-marketplace` (the
 * marketplace entry uuid), `core-marketplace-plugin` (a marketplace plugin's
 * entry uuid), `core-mcp-directory` (a server of core's MCP directory),
 * `this-computer` (the local MCP provider id) and `mcp-registry:<registryId>`
 * (the server id in that registry).
 */
export interface AddonRef {
  source: string
  id: string
}

export interface AddonPublisher {
  name: string
  verified: boolean
}

export interface AddonOrigin {
  /** What the source is called on the card: `Catalog`, a marketplace's name, `On this computer`, a registry's label. */
  label: string
  kind: 'marketplace' | 'catalog' | 'directory' | 'local'
  repositoryUrl: string | null
  homepage: string | null
}

export interface AddonMcpServerComponent {
  name: string
  transport: 'stdio' | 'http' | 'sse'
  runtime: 'node' | 'python' | 'docker' | null
  auth: 'none' | 'oauth' | 'bearer' | 'env'
  env: Array<{ name: string; secret: boolean }>
}

/** A plugin's parts, from core's snapshot analysis (U1). */
export interface AddonComponents {
  skills: Array<{ name: string; hasScripts: boolean }>
  commands: string[]
  agents: string[]
  hooks: { events: string[] } | null
  mcpServers: AddonMcpServerComponent[]
  lspServers: string[]
}

/** A named value a directory MCP server needs on this computer (its env); never the value itself. */
export interface AddonMcpEnvName {
  name: string
  secret: boolean
  description: string | null
}

/** How a directory MCP entry connects over the network, enough to create a local provider from it. */
export interface AddonMcpRemoteConnect {
  transport: 'streamable-http' | 'sse'
  url: string
  /** `oauth` also covers a server that needs no auth at all (the OAuth-capable transport never meets a 401). */
  auth: 'oauth' | 'bearer'
  /** The registry says the server wants auth headers: a key or a sign-in follows the add. */
  requiresAuth: boolean
}

/** The package a local (stdio) directory MCP server runs (core's MCP directory). */
export interface AddonMcpPackage {
  /** npm → `npx`, pypi → the managed `uvx`, oci → `docker run`. */
  registry: 'npm' | 'pypi' | 'oci'
  name: string
  version: string | null
  args: string[]
}

/** A local-process directory MCP server: the package it runs and the values it needs. */
export interface AddonMcpLocalConnect {
  transport: 'stdio'
  package: AddonMcpPackage
  auth: 'none' | 'env'
  requiresAuth: boolean
  env: AddonMcpEnvName[]
}

/** How a directory MCP entry connects. */
export type AddonMcpConnect = AddonMcpRemoteConnect | AddonMcpLocalConnect

export type AddonInstall = { archivePath: string } | { mcp: AddonMcpConnect } | null

export interface DirectoryEntry {
  ref: AddonRef
  kind: AddonKind
  /** Slug: the skill folder, plugin name or server name. */
  name: string
  title: string
  summary: string
  /** Markdown, for the detail view only. */
  description: string
  category: string | null
  tags: string[]
  iconUrl: string | null
  publisher: AddonPublisher | null
  origin: AddonOrigin
  version: string | null
  /** `sha256:<hex>` — what a pin would name; null when the source has none. */
  digest: string | null
  /** Plugins only (U1+). */
  components?: AddonComponents
  requires: { credentials: Record<string, unknown>[] }
  /** Scripts, hooks or a stdio server; null when the source does not say. */
  runsCode: boolean | null
  status: 'ready' | 'pending' | 'unsupported'
  /** The source's code when {@link status} is `unsupported` (core's `no_skill_md`, …); the sentence is the renderer's. */
  unsupportedReason: string | null
  install: AddonInstall
}

/**
 * Who may use what, from core (README §3.2). Every flag defaults to today's
 * behaviour, everything allowed; with no account, or before core sends it,
 * {@link DEFAULT_ADDON_POLICY} applies.
 */
export interface AddonPolicy {
  /** May public directories (the MCP registries, later opencinna) be offered? */
  externalDirectories: boolean
  /** May the user type their own MCP URL / command? */
  customMcp: boolean
  /** May plugin hooks run? */
  pluginHooks: boolean
  /** May local-process MCP servers be installed? */
  stdioMcp: boolean
}

export const DEFAULT_ADDON_POLICY: AddonPolicy = Object.freeze({
  externalDirectories: true,
  customMcp: true,
  pluginHooks: true,
  stdioMcp: true
})

/**
 * Where an entry stands for one agent:
 * * `added` — already pinned / attached;
 * * `addable` — Add works and needs nothing more;
 * * `addable_with_setup` — Add works, then a sign-in, a key or env values;
 * * `partly_compatible` / `incompatible` — against the agent's engine (U3);
 * * `blocked` — Add cannot work here ({@link AgentDirectoryEntry.stateReason} says why);
 * * `preparing` — core is still snapshotting it.
 */
export type AgentAddonState =
  | 'added'
  | 'addable'
  | 'addable_with_setup'
  | 'partly_compatible'
  | 'incompatible'
  | 'blocked'
  | 'preparing'

export interface AgentDirectoryEntry extends DirectoryEntry {
  /** The directory provider that listed it (`cinna-core`, `this-computer`, `mcp-registries`): the picker's source select. */
  provider: string
  state: AgentAddonState
  /** One sentence saying why, or null for a plain `addable`. */
  stateReason: string | null
  /**
   * The local MCP provider this entry is (a `this-computer` entry, or a
   * directory entry merged with the provider created from it).
   */
  mcpProviderId?: string
  /** That local connector's next step before it connects unattended (sign in, a key, Connect); absent when none. */
  setupStep?: AddonNextStep
}

/** One provider's part in an answer; `error` is a sentence when its read failed (the others still answer). */
export interface AddonSourceStatus {
  id: string
  label: string
  error?: string
  /** `reauth`: the account's session expired, and signing in again is the fix. */
  errorCode?: 'reauth'
}

export type AddonRefused = { ok: false; code: string; message: string }

export type AddonDirectoryResult =
  | { ok: true; entries: AgentDirectoryEntry[]; sources: AddonSourceStatus[]; policy: AddonPolicy }
  | AddonRefused

export type AddonSearchResult =
  | { ok: true; entries: AgentDirectoryEntry[]; sources: AddonSourceStatus[] }
  | AddonRefused

/**
 * The in-place step the picker shows after an add: sign in, paste a key, fill
 * env values, `connect` — the connector did not connect for a reason that
 * is not auth, and Connect tries again — or `enable`: the connector is turned
 * off on this computer, and Turn on turns it on.
 */
export type AddonNextStep = 'oauth' | 'bearer' | 'env' | 'connect' | 'enable'

export type AddonActionResult =
  /**
   * `message`: why the connector is not connected yet (with `next: 'connect'`).
   * `starting`: connectors (a plugin's) whose first connect the add started
   * and that are not up yet; the picker reads "Starting…" until they are.
   */
  | { ok: true; next: AddonNextStep | null; mcpProviderId?: string; message?: string; starting?: string[] }
  | AddonRefused

/**
 * One of a kit agent's `mcp_servers[]` requirements as this computer meets it
 * (`addons:mcp-requirements`): `ready` — its local connector is attached and
 * needs nothing; `needs_setup` — a connector is still to be made, added or
 * finished (`entryRef` is what the picker opens for it); `unavailable` — no
 * source the account may use lists it any more.
 */
export interface AddonMcpRequirement {
  name: string
  /** The directory entry it was added from; null for a custom connector. */
  ref: AddonRef | null
  transport: 'stdio' | 'http' | 'sse'
  state: 'ready' | 'needs_setup' | 'unavailable'
  reason: string | null
  /** The local provider that meets it, when there is one. */
  mcpProviderId: string | null
  /** The directory entry to set it up from (a local provider's own ref when one exists); null when there is none. */
  entryRef: AddonRef | null
}

export type AddonMcpRequirementsResult = { ok: true; items: AddonMcpRequirement[] } | AddonRefused

/** Same entry, whichever source answered it. */
export function addonRefKey(ref: AddonRef): string {
  return `${ref.source}\u0000${ref.id}`
}

export function sameAddonRef(a: AddonRef | null | undefined, b: AddonRef | null | undefined): boolean {
  return !!a && !!b && a.source === b.source && a.id === b.id
}

/** The directory ref of an MCP registry's server: what a connector made from it records (`registry_ref`). */
export function mcpRegistryRef(registryId: string, id: string): AddonRef {
  return { source: `mcp-registry:${registryId}`, id }
}

export function isAddonRef(value: unknown): value is AddonRef {
  if (!value || typeof value !== 'object') return false
  const v = value as Record<string, unknown>
  return typeof v.source === 'string' && v.source !== '' && typeof v.id === 'string' && v.id !== ''
}
