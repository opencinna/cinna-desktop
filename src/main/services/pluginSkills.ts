/**
 * A kit agent's pinned marketplace plugins (`marketplace_plugins[]`) as what
 * every engine is handed: the plugins' skills as skill rows that join the
 * agent's own skill delivery (the Claude skills plugin, OpenCode's
 * `skills.paths`, the Codex / Antigravity prompt pointers), and the cached
 * plugin folders the other parts are delivered from.
 *
 * * Only a pin whose snapshot is in the cache is delivered; one that is not
 *   is fetched in the background (`marketplacePluginService`), and the next
 *   session gets it.
 * * A skill the user turned off (`disabled.skills`) is not delivered.
 * * **The agent's own skill wins a name clash**: a plugin skill whose name is
 *   an own, catalog or marketplace skill's, a platform skill's, or an earlier
 *   plugin skill's is skipped, and the plugin's status says so.
 *
 * Core: no Electron.
 */

import { join } from 'node:path'
import { agentSkillRows, parseSkillDir, PLATFORM_SKILL_NAMES, SKILL_FILE, SKILLS_DIR } from '../kit/skills'
import { catalogSkillCache } from './catalogSkillCache'
import { marketplaceSkillCache } from './marketplaceSkillCache'
import {
  marketplacePluginCache,
  marketplacePluginCacheRefOf,
  marketplacePluginRefOf,
  PLUGIN_TREE_MODIFIED_SENTENCE,
  verifyPluginTree
} from './marketplacePluginCache'
import { readPluginTree, type PluginTree } from './pluginTree'
import type { LocalAgentSkill } from '../../shared/localAgents'
import type { MarketplacePluginDisabled, MarketplacePluginPin } from '../../shared/kit/manifest'

/** Why a plugin skill was not delivered. */
export const PLUGIN_SKILL_TEXT = {
  clash: 'This agent already has a skill with this name, which wins.',
  duplicate: 'Another plugin of this agent has a skill with this name.',
  reserved: 'This name is reserved for a skill Cinna provides.'
} as const

/** A pin as written, when it names a usable plugin. */
export function pluginPinsOf(manifest: unknown): MarketplacePluginPin[] {
  const record = manifest && typeof manifest === 'object' ? (manifest as Record<string, unknown>) : null
  const pins = record?.marketplace_plugins
  if (!Array.isArray(pins)) return []
  return pins.filter(
    (pin): pin is MarketplacePluginPin =>
      !!pin && typeof pin === 'object' && !Array.isArray(pin) && marketplacePluginCacheRefOf(marketplacePluginRefOf(pin)) !== null
  )
}

/** The pin's `disabled`, read defensively. */
export function disabledOf(pin: MarketplacePluginPin): { hooks: boolean; mcpServers: string[]; skills: string[] } {
  const raw: MarketplacePluginDisabled | null = pin.disabled && typeof pin.disabled === 'object' ? pin.disabled : null
  const names = (value: unknown): string[] => (Array.isArray(value) ? value.filter((v): v is string => typeof v === 'string') : [])
  return { hooks: raw?.hooks === true, mcpServers: names(raw?.mcp_servers), skills: names(raw?.skills) }
}

/** One pinned plugin on this computer: its pin, its cached folder (null when not cached) and what the folder holds. */
export interface CachedPlugin {
  pin: MarketplacePluginPin
  dir: string | null
  tree: PluginTree | null
  /** The last download's sentence, when it failed. */
  failure?: string
  /** The cached copy no longer matches what was unpacked: nothing of it is delivered. */
  modified?: boolean
}

/**
 * Every pin with its cached folder. A folder whose files no longer match the
 * digests recorded at install (`verifyPluginTree`) counts as not on this
 * computer — no skill, command, hook or server is delivered from it — and
 * carries `modified`.
 */
export function cachedPlugins(manifest: unknown): CachedPlugin[] {
  return pluginPinsOf(manifest).map((pin) => {
    const state = marketplacePluginCache.resolve(marketplacePluginRefOf(pin))
    if (state.state !== 'ready') return { pin, dir: null, tree: null, ...(state.state === 'failed' ? { failure: state.message } : {}) }
    if (!verifyPluginTree(state.dir)) return { pin, dir: null, tree: null, failure: PLUGIN_TREE_MODIFIED_SENTENCE, modified: true }
    return { pin, dir: state.dir, tree: readPluginTree(state.dir) }
  })
}

/** A skill a plugin has that was not delivered, and why. */
export interface SkippedPluginSkill {
  plugin: string
  skill: string
  reason: string
}

/**
 * The plugins' deliverable skill rows (`source: 'plugin'`), after every name
 * in `taken` (the agent's own and pinned skills), and what was skipped.
 */
export function pluginSkillRows(plugins: readonly CachedPlugin[], taken: ReadonlySet<string>): { rows: LocalAgentSkill[]; skipped: SkippedPluginSkill[] } {
  const rows: LocalAgentSkill[] = []
  const skipped: SkippedPluginSkill[] = []
  const used = new Set<string>()
  for (const plugin of plugins) {
    if (!plugin.dir || !plugin.tree) continue
    const off = new Set(disabledOf(plugin.pin).skills)
    for (const name of plugin.tree.skills) {
      if (off.has(name)) continue
      const reason = PLATFORM_SKILL_NAMES.has(name)
        ? PLUGIN_SKILL_TEXT.reserved
        : taken.has(name)
          ? PLUGIN_SKILL_TEXT.clash
          : used.has(name)
            ? PLUGIN_SKILL_TEXT.duplicate
            : null
      if (reason) {
        skipped.push({ plugin: plugin.pin.name, skill: name, reason })
        continue
      }
      // A declared `skills` path (`"skills": "./carbone"`) puts the folder outside `skills/`.
      const dir = plugin.tree.skillDirs[name] ?? join(plugin.dir, SKILLS_DIR, name)
      const parsed = parseSkillDir(dir, name).skill
      used.add(name)
      rows.push({
        ...parsed,
        source: 'plugin',
        path: join(dir, SKILL_FILE),
        pluginName: plugin.pin.name,
        entryUuid: plugin.pin.entry_uuid
      })
    }
  }
  return { rows, skipped }
}

/**
 * Every skill row an engine is handed for a kit agent, before the
 * deliverable filter: its own and pinned skills (`agentSkillRows`) and its
 * plugins' skills after them.
 */
export function deliveredSkillRows(agentDir: string, manifest: unknown): LocalAgentSkill[] {
  const rows = agentSkillRows(agentDir, manifest, catalogSkillCache.resolve, marketplaceSkillCache.resolve)
  const plugins = pluginPinsOf(manifest).length > 0 ? cachedPlugins(manifest) : []
  if (plugins.length === 0) return rows
  const { rows: fromPlugins } = pluginSkillRows(plugins, new Set(rows.map((row) => row.name)))
  return [...rows, ...fromPlugins]
}
