/**
 * Claude's share of a kit agent's pinned marketplace plugins: one **wrapper
 * plugin** per pinned plugin, passed in the session's `plugins` array beside
 * the agent's skills plugin (`agentSkillsPlugin.ts`) — the same `--plugin-dir`
 * delivery, the same isolated (`settingSources: []`) session.
 *
 * A wrapper is a folder of our own `.claude-plugin/plugin.json` (name,
 * description, version — nothing else from the plugin's manifest, so no
 * inline `mcpServers` or `hooks` ride along) and a symlink per top-level
 * entry of the plugin's read-only cached folder (`marketplacePluginCache`),
 * **except**:
 *
 * * `.mcp.json` — never: the plugin's MCP servers are Cinna-managed providers
 *   (`pluginMcpProviders.ts`) and must not start twice;
 * * `skills/` — the plugin's skills join the agent's skills plugin, where a
 *   clash with the agent's own skill is decided (`pluginSkills.ts`);
 * * `hooks/` — when the user turned the plugin's hooks off (`disabled.hooks`)
 *   or the admin's policy forbids plugin hooks (`policy.pluginHooks`);
 * * the plugin's own manifest folders.
 *
 * Linking every other top-level entry (scripts, `commands/`, `agents/`,
 * `hooks/`, `.lsp.json`, …) is what makes `${CLAUDE_PLUGIN_ROOT}` work
 * whichever way Claude resolves it: as the wrapper, a path under it follows a
 * link into the cache; as the real path, it is the cache.
 *
 * A wrapper is built only when it carries something for Claude (commands,
 * agents, hooks, an LSP config). Lives at
 * `<userData>/cinna-plugins/agents/<key>-plugins/<plugin name>/`, rebuilt only
 * when what it links changes; wrappers of plugins no longer pinned are
 * removed. Never throws: a wrapper that cannot be written is a session
 * without it, logged.
 *
 * Core: no Electron.
 */

import { existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, rmSync, symlinkSync, writeFileSync, type Dirent } from 'node:fs'
import { join } from 'node:path'
import { swapInto } from '../kit/treeSwap'
import { createLogger } from '../logger/logger'
import { agentSkillsPluginDir } from './agentSkillsPlugin'
import { disabledOf, type CachedPlugin } from './pluginSkills'
import { PLATFORM_SKILL_NAMES } from '../kit/skills'

const logger = createLogger('agent-plugin-wrappers')

const STATE_FILE = '.cinna-plugin-wrapper.json'

/** Top-level entries of a plugin a wrapper never links. */
const NEVER_LINKED: ReadonlySet<string> = new Set(['.mcp.json', 'skills', '.claude-plugin', '.codex-plugin'])

interface WrapperState {
  name: string
  links: Record<string, string>
}

/** `<userData>/cinna-plugins/agents/<key>-plugins`. */
export function agentPluginWrappersRoot(agentId: string): string {
  return `${agentSkillsPluginDir(agentId)}-plugins`
}

function entries(dir: string): Dirent[] {
  try {
    const list: Dirent[] = readdirSync(dir, { withFileTypes: true })
    return list
  } catch {
    return []
  }
}

/** What a plugin's wrapper links, by name; empty when it would carry nothing for Claude. */
export function wrapperLinks(plugin: CachedPlugin, hooksAllowed: boolean): Record<string, string> {
  if (!plugin.dir || !plugin.tree) return {}
  const hooks = hooksAllowed && !disabledOf(plugin.pin).hooks
  const dir = plugin.dir
  const carries =
    plugin.tree.commands.length > 0 || plugin.tree.hasAgents || (hooks && plugin.tree.hasHooks) || existsSync(join(dir, '.lsp.json'))
  if (!carries) return {}
  const links: Record<string, string> = {}
  for (const entry of entries(dir)) {
    if (NEVER_LINKED.has(entry.name) || entry.name.startsWith('.cinna-')) continue
    if (entry.name === 'hooks' && !hooks) continue
    links[entry.name] = join(dir, entry.name)
  }
  return links
}

function readState(dir: string): WrapperState | null {
  try {
    const value = JSON.parse(readFileSync(join(dir, STATE_FILE), 'utf8')) as WrapperState
    return value && typeof value.name === 'string' && value.links && typeof value.links === 'object' ? value : null
  } catch {
    return null
  }
}

function sameState(a: WrapperState | null, b: WrapperState): boolean {
  if (!a || a.name !== b.name) return false
  const keys = Object.keys(b.links)
  return Object.keys(a.links).length === keys.length && keys.every((key) => a.links[key] === b.links[key])
}

function linksPresent(dir: string, state: WrapperState): boolean {
  return Object.keys(state.links).every((name) => {
    try {
      return lstatSync(join(dir, name)).isSymbolicLink()
    } catch {
      return false
    }
  })
}

function writeWrapper(target: string, plugin: CachedPlugin, wanted: WrapperState): void {
  if (existsSync(target) && sameState(readState(target), wanted) && linksPresent(target, wanted)) return
  const staging = `${target}.tmp-${process.pid}-${Date.now()}`
  rmSync(staging, { recursive: true, force: true })
  mkdirSync(join(staging, '.claude-plugin'), { recursive: true })
  const manifest = plugin.tree?.manifest
  writeFileSync(
    join(staging, '.claude-plugin', 'plugin.json'),
    `${JSON.stringify(
      {
        name: wanted.name,
        description: manifest?.description ?? `The ${wanted.name} plugin from ${plugin.pin.marketplace_name || 'a marketplace'}. Provided by Cinna Desktop.`,
        version: manifest?.version ?? (typeof plugin.pin.version === 'string' ? plugin.pin.version : '1')
      },
      null,
      2
    )}\n`
  )
  for (const [name, link] of Object.entries(wanted.links)) {
    let isDir = false
    try {
      isDir = lstatSync(link).isDirectory()
    } catch {
      continue
    }
    symlinkSync(link, join(staging, name), isDir ? (process.platform === 'win32' ? 'junction' : 'dir') : 'file')
  }
  writeFileSync(join(staging, STATE_FILE), `${JSON.stringify(wanted)}\n`)
  // `rm` of the previous wrapper unlinks its links, never following them into the cache.
  swapInto(staging, target)
}

/**
 * Materialise the agent's wrappers and answer their folders, in pin order.
 * `reserved` are plugin names a wrapper may not take (the agent's skills
 * plugin, the platform's plugins). `hooksAllowed` is the admin's
 * `policy.pluginHooks`.
 */
export function ensureAgentPluginWrappers(
  agentId: string,
  plugins: readonly CachedPlugin[],
  options: { hooksAllowed: boolean; reserved?: readonly string[] }
): string[] {
  const root = agentPluginWrappersRoot(agentId)
  const reserved = new Set([...(options.reserved ?? []), ...PLATFORM_SKILL_NAMES])
  const built: string[] = []
  const wantedNames = new Set<string>()
  for (const plugin of plugins) {
    const name = plugin.pin.name
    if (reserved.has(name) || wantedNames.has(name)) continue
    const links = wrapperLinks(plugin, options.hooksAllowed)
    if (Object.keys(links).length === 0) continue
    wantedNames.add(name)
    const target = join(root, name)
    try {
      mkdirSync(root, { recursive: true })
      writeWrapper(target, plugin, { name, links })
      built.push(target)
    } catch (error) {
      logger.warn('a plugin wrapper could not be written', { agentId, plugin: name, error: error instanceof Error ? error.message : String(error) })
    }
  }
  // Wrappers (and leftovers) of plugins this agent no longer delivers.
  for (const entry of entries(root)) {
    if (wantedNames.has(entry.name)) continue
    try {
      rmSync(join(root, entry.name), { recursive: true, force: true })
    } catch {
      /* best effort: tried again on the next build */
    }
  }
  return built
}
