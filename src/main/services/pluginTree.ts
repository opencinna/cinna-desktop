/**
 * Reading a cached marketplace plugin's tree — what is in the folder
 * `marketplacePluginCache` unpacked, by the layout Claude and Codex plugins
 * share: `.claude-plugin/plugin.json` or `.codex-plugin/plugin.json`,
 * `skills/<name>/SKILL.md`, `commands/*.md`, `agents/*.md`,
 * `hooks/hooks.json`, and MCP servers in `.mcp.json` (or `mcpServers` in the
 * plugin manifest). Core's `components` only *describe* a plugin; the real
 * command, args and env of each MCP server are read here, from the bytes the
 * pin's digest names.
 *
 * Read-only and defensive: a file that is missing, unreadable or not the
 * shape expected reads as absent; nothing here throws. Never follows a link
 * (the cache holds none: the archive reader refuses them).
 *
 * Core: `node:` builtins only.
 */

import { lstatSync, readdirSync, readFileSync, type Dirent } from 'node:fs'
import { join } from 'node:path'

/** One MCP server as the plugin declares it (`.mcp.json` shape). */
export interface PluginMcpServerSpec {
  name: string
  transport: 'stdio' | 'http' | 'sse'
  command: string | null
  args: string[]
  /** Values as written: `${VAR}` and `${CLAUDE_PLUGIN_ROOT}` unresolved. */
  env: Record<string, string>
  url: string | null
  headers: Record<string, string>
}

export interface PluginCommand {
  /** The file's name without `.md`: what the command is invoked as. */
  name: string
  /** Absolute path of the `.md`. */
  path: string
}

export interface PluginTree {
  dir: string
  manifest: { name: string | null; description: string | null; version: string | null }
  /** Folder names under `skills/` that hold a `SKILL.md`, sorted. */
  skills: string[]
  commands: PluginCommand[]
  hasAgents: boolean
  hasHooks: boolean
  mcpServers: PluginMcpServerSpec[]
}

type Json = Record<string, unknown>

const rec = (value: unknown): Json | null => (value && typeof value === 'object' && !Array.isArray(value) ? (value as Json) : null)
const text = (value: unknown): string | null => (typeof value === 'string' && value.trim() !== '' ? value : null)

function realDir(path: string): boolean {
  try {
    const stat = lstatSync(path)
    return stat.isDirectory() && !stat.isSymbolicLink()
  } catch {
    return false
  }
}

function realFile(path: string): boolean {
  try {
    const stat = lstatSync(path)
    return stat.isFile() && !stat.isSymbolicLink()
  } catch {
    return false
  }
}

function readJson(path: string): Json | null {
  if (!realFile(path)) return null
  try {
    return rec(JSON.parse(readFileSync(path, 'utf8')))
  } catch {
    return null
  }
}

function entries(dir: string): Dirent[] {
  try {
    const list: Dirent[] = readdirSync(dir, { withFileTypes: true })
    return list.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))
  } catch {
    return []
  }
}

/** The plugin manifest: Claude's, else Codex's. */
function readManifest(dir: string): Json | null {
  return readJson(join(dir, '.claude-plugin', 'plugin.json')) ?? readJson(join(dir, '.codex-plugin', 'plugin.json'))
}

function stringRecord(value: unknown): Record<string, string> {
  const record = rec(value)
  if (!record) return {}
  return Object.fromEntries(Object.entries(record).filter((pair): pair is [string, string] => typeof pair[1] === 'string'))
}

/** One server entry of an `mcpServers` map, or null when it names nothing that runs. */
export function mcpServerSpecOf(name: string, raw: unknown): PluginMcpServerSpec | null {
  const server = rec(raw)
  if (!server || name.trim() === '') return null
  const command = text(server.command)
  const url = text(server.url)
  const type = text(server.type) ?? text(server.transport)
  const transport: PluginMcpServerSpec['transport'] = command
    ? 'stdio'
    : type === 'sse'
      ? 'sse'
      : url
        ? 'http'
        : 'stdio'
  if (transport === 'stdio' && !command) return null
  if (transport !== 'stdio' && !url) return null
  return {
    name,
    transport,
    command,
    args: Array.isArray(server.args) ? server.args.filter((arg): arg is string => typeof arg === 'string') : [],
    env: stringRecord(server.env),
    url,
    headers: stringRecord(server.headers)
  }
}

/** The `mcpServers` map of a `.mcp.json` (wrapped or bare) or of the plugin manifest. */
function serversOf(dir: string, manifest: Json | null): PluginMcpServerSpec[] {
  const file = readJson(join(dir, '.mcp.json'))
  const map = rec(file?.mcpServers) ?? (file && !('mcpServers' in file) ? file : null) ?? rec(manifest?.mcpServers)
  if (!map) return []
  return Object.entries(map).flatMap(([name, raw]) => mcpServerSpecOf(name, raw) ?? [])
}

/** What a cached plugin folder holds. */
export function readPluginTree(dir: string): PluginTree {
  const manifest = readManifest(dir)
  const skillsDir = join(dir, 'skills')
  const skills = entries(skillsDir)
    .filter((entry) => entry.isDirectory() && !entry.name.startsWith('.') && realFile(join(skillsDir, entry.name, 'SKILL.md')))
    .map((entry) => entry.name)
  const commandsDir = join(dir, 'commands')
  const commands = entries(commandsDir)
    .filter((entry) => entry.isFile() && entry.name.endsWith('.md') && entry.name.length > 3)
    .map((entry) => ({ name: entry.name.slice(0, -3), path: join(commandsDir, entry.name) }))
  const agentsDir = join(dir, 'agents')
  return {
    dir,
    manifest: { name: text(manifest?.name), description: text(manifest?.description), version: text(manifest?.version) },
    skills,
    commands,
    hasAgents: realDir(agentsDir) && entries(agentsDir).some((entry) => entry.isFile() && entry.name.endsWith('.md')),
    hasHooks: realFile(join(dir, 'hooks', 'hooks.json')),
    mcpServers: serversOf(dir, manifest)
  }
}

/** A command file's body and its frontmatter `description`, for an engine that takes commands as config (OpenCode). */
export function readPluginCommand(path: string): { template: string; description: string | null } | null {
  let raw: string
  try {
    if (!realFile(path)) return null
    raw = readFileSync(path, 'utf8')
  } catch {
    return null
  }
  const match = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/.exec(raw)
  if (!match) return { template: raw, description: null }
  const description = /^description:\s*(.+)$/m.exec(match[1])?.[1]?.trim().replace(/^["']|["']$/g, '') ?? null
  return { template: raw.slice(match[0].length), description: description || null }
}
