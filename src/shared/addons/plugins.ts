/**
 * Marketplace plugins on local agents (unified addons U3): what the renderer
 * may ask main about a kit agent's `marketplace_plugins[]` pins (contract
 * 1.17.0), and the typed answers. Adding and removing a plugin go through the
 * addon directory (`addons:add` / `addons:remove` with the entry's ref);
 * these channels carry what the plugin's own row needs.
 *
 * Every answer is data — a refusal is `{ok: false, code, message}`, never a
 * thrown error, because a thrown `DomainError`'s code does not survive IPC.
 *
 * Channels (`addons.ipc.ts`):
 * * `addons:plugin-status` {@link PluginAgentInput} → {@link PluginStatusResult}
 * * `addons:set-plugin-disabled` {@link SetPluginDisabledInput} → {@link PluginActionResult}
 * * `addons:update-plugin` {@link PluginNameInput} → {@link PluginActionResult}
 * * `addons:recheck-runtimes` (no input) → {@link RecheckRuntimesResult}
 */

import type { AgentEngine } from '../engine'
import type { AddonNextStep } from './directory'
import type { AddonCompatibility } from './engineSupport'

export interface PluginAgentInput {
  agentId: string
}

/** One pin, by its `name` (one pin per name). */
export interface PluginNameInput {
  agentId: string
  name: string
}

/** What to turn off on a pinned plugin; each key given replaces the pin's own. */
export interface PluginDisabledInput {
  hooks?: boolean
  mcpServers?: string[]
  skills?: string[]
}

export interface SetPluginDisabledInput extends PluginNameInput {
  disabled: PluginDisabledInput
}

/**
 * Why a plugin action did not happen.
 *
 * The marketplace skills' codes (`marketplaceSkills.ts`), plus:
 * * `blocked` — a server needs a runtime this computer lacks, or the admin turned local servers off;
 * * `runtime_failed` — the managed uv could not be installed for a Python server.
 */
export type PluginRefusal =
  | 'no_account'
  | 'not_found'
  | 'not_kit_agent'
  | 'read_only'
  | 'access_unknown'
  | 'already_added'
  | 'unsupported'
  | 'preparing'
  | 'snapshot_missing'
  | 'download_failed'
  | 'hash_mismatch'
  | 'invalid_archive'
  | 'too_large'
  | 'manifest_modified'
  | 'write_failed'
  | 'reauth_required'
  | 'network'
  | 'blocked'
  | 'runtime_failed'

export type PluginRefused = { ok: false; code: PluginRefusal; message: string }

export type PluginActionResult =
  /** `next`: the step a managed connector still needs (`env`: settings values to fill in). */
  | { ok: true; name: string; archiveSha256: string; next: AddonNextStep | null }
  | PluginRefused

/** One of a pinned plugin's skills, as delivered. */
export interface PluginSkillStatus {
  name: string
  /** Turned off by the user (`disabled.skills`). */
  disabled: boolean
  /** Given to the engine. */
  delivered: boolean
  /** Why not, when on and not delivered: a name clash with the agent's own skill, … */
  reason?: string
}

/** One of a pinned plugin's MCP servers, as a managed connector. */
export interface PluginServerStatus {
  name: string
  transport: 'stdio' | 'http' | 'sse'
  disabled: boolean
  /** The managed `mcp_providers` row, once created. */
  mcpProviderId?: string
  /** Why it is not installed (no Node.js, admin policy), or absent. */
  blocked?: string
  /** The step the connector needs, or absent when none. */
  setup?: AddonNextStep
  /** Env names it still needs a value for. */
  missingEnv?: string[]
}

export interface PluginPinStatus {
  name: string
  /** What the row calls it: the marketplace's display title, else the pin's name. */
  title: string
  entryUuid: string
  marketplaceName: string
  version: string | null
  archiveSha256: string
  /**
   * Against its marketplace: `current`, `update_available`, `unavailable`
   * ("No longer available to you" — the cached copy keeps being delivered),
   * or `unknown` when the marketplace could not be asked.
   */
  availability: 'current' | 'update_available' | 'unavailable' | 'unknown'
  latestSha256?: string
  latestVersion?: string | null
  /** The one sentence for the row ("No longer available to you", "Update available", …), or null. */
  availabilityText: string | null
  /** On this computer: `ready`, `missing` (not downloaded yet) or `failed` (with {@link cacheMessage}). */
  cache: 'ready' | 'missing' | 'failed'
  cacheMessage?: string
  engine: AgentEngine
  compatibility: AddonCompatibility
  skills: PluginSkillStatus[]
  commands: string[]
  hasAgents: boolean
  /** The plugin's agents by name (`agents/*.md` frontmatter `name`, else the file name), sorted; `[]` when none. */
  agents: string[]
  /** The plugin ships hooks; {@link hooksDelivered} says whether the engine runs them. */
  hasHooks: boolean
  hooksDisabled: boolean
  hooksDelivered: boolean
  /** Why hooks do not run when they are on (not Claude, admin policy), or absent. */
  hooksReason?: string
  /** The plugin's hooks are on but the admin's policy (`plugin_hooks`) keeps them from running. */
  hooksBlockedByPolicy: boolean
  /** The hook events it registers (`hooks/hooks.json` keys with a non-empty list), sorted; `[]` when none. */
  hookEvents: string[]
  mcpServers: PluginServerStatus[]
}

export type PluginStatusResult = { ok: true; plugins: PluginPinStatus[] } | PluginRefused

/** `addons:reveal-plugin`: the pinned plugin's cached folder was shown in the file manager, or why not. */
export type PluginRevealResult = { ok: true } | PluginRefused

export type RecheckRuntimesResult = { ok: true; node: boolean; docker: boolean }
