/**
 * Reading a cached marketplace plugin's tree — what is in the folder
 * `marketplacePluginCache` unpacked, by the layout Claude and Codex plugins
 * share: `.claude-plugin/plugin.json` or `.codex-plugin/plugin.json`,
 * `skills/<name>/SKILL.md`, `commands/*.md`, `agents/*.md`,
 * `hooks/hooks.json`, and MCP servers in `.mcp.json` (or `mcpServers` in the
 * plugin manifest) — plus the component paths the manifest declares
 * (`"skills": "./carbone"`, `"commands": ["./a.md", "./more"]`, …), read by
 * core's rules (`plugin_components.py`) so the desktop sees the components
 * core reports: a declared path (a string or an array of them) is relative to
 * the plugin root and must stay inside it (no leading `/`, no `..`, no link on
 * the way), and it **supplements** the default folder, never replaces it.
 * Core's `components` only *describe* a plugin; the real
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
import { isAbsolute, join, relative, resolve, sep } from 'node:path'

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
  /**
   * The plugin's skill names: each folder under `skills/` and under a
   * declared `skills` path that holds a `SKILL.md` (a declared path that is
   * itself such a folder counts as one skill), else a `SKILL.md` at the root.
   */
  skills: string[]
  /** Each skill's folder (absolute), by name. */
  skillDirs: Record<string, string>
  /** Commands of `commands/` (recursive; nested ones named `sub:stem`) and of the declared `commands` paths. */
  commands: PluginCommand[]
  hasAgents: boolean
  /** Its agents by name (`agents/*.md`: the frontmatter `name`, else the file's name), sorted. */
  agents: string[]
  hasHooks: boolean
  /** The events `hooks/hooks.json` registers a hook for, sorted. */
  hookEvents: string[]
  mcpServers: PluginMcpServerSpec[]
  /** LSP server names of `.lsp.json` and the declared `lspServers`, sorted. */
  lspServers: string[]
  /**
   * The manifest's declared component paths that resolved inside the plugin,
   * as written relative to its root (`./x`): what a wrapper plugin re-declares
   * for Claude (`agentPluginWrappers.ts`).
   */
  declared: { commands: string[]; agents: string[]; hooks: string[]; lspServers: string[] }
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

/** The paths a declared component value names: a string, or the strings of an array. */
function declaredPaths(value: unknown): string[] {
  if (typeof value === 'string') return [value]
  if (Array.isArray(value)) return value.filter((item): item is string => typeof item === 'string')
  return []
}

/**
 * `root/raw` for a declared path, or null when it could lead out of the
 * plugin (core's `_safe_entry_path` + `contained_path`): a leading `/` or a
 * `..` segment, a link on any segment, or a target resolving outside `root`.
 * Only a leading `./` is dropped; an empty path is the root itself.
 */
export function declaredPathIn(root: string, raw: string): string | null {
  const candidate = raw.trim()
  if (candidate.startsWith('/') || candidate.startsWith('\\')) return null
  const parts = candidate.split(/[\\/]/)
  if (parts.includes('..')) return null
  let current = root
  for (const part of parts) {
    if (part === '' || part === '.') continue
    current = join(current, part)
    try {
      if (lstatSync(current).isSymbolicLink()) return null
    } catch {
      /* absent: the reader finds nothing there */
    }
  }
  const rel = relative(resolve(root), resolve(current))
  if (rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel)) return null
  return current
}

/** The `mcpServers` / `lspServers` map of a parsed file or inline value: wrapped or bare. */
function serverMap(value: unknown): Json {
  const record = rec(value)
  if (!record) return {}
  const wrapped = rec(record.mcpServers) ?? rec(record.lspServers)
  if (wrapped) return wrapped
  return Object.fromEntries(Object.entries(record).filter(([, server]) => rec(server) !== null))
}

/**
 * Every server of `defaultFile` and of the manifest's declared value (an
 * inline map, a path to a JSON file, or an array of either), later ones
 * replacing earlier ones by name — core's `_collect_servers`.
 */
function collectServers(dir: string, defaultFile: string, declared: unknown): Json {
  const servers: Json = { ...serverMap(readJson(join(dir, defaultFile))) }
  if (declared === undefined) return servers
  if (rec(declared)) return { ...servers, ...serverMap(declared) }
  for (const item of Array.isArray(declared) ? declared : [declared]) {
    if (rec(item)) Object.assign(servers, serverMap(item))
    else if (typeof item === 'string') {
      const path = declaredPathIn(dir, item)
      if (path) Object.assign(servers, serverMap(readJson(path)))
    }
  }
  return servers
}

/** A plugin's MCP servers: `.mcp.json` (wrapped or bare) and the manifest's `mcpServers`. */
function serversOf(dir: string, manifest: Json | null): PluginMcpServerSpec[] {
  const map = collectServers(dir, '.mcp.json', manifest?.mcpServers)
  return Object.entries(map)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .flatMap(([name, raw]) => mcpServerSpecOf(name, raw) ?? [])
}

/** `*.md` under `base` (or `base` itself, a `.md` file) as `[name, path]`; nested names are `sub:stem`. */
function mdFiles(base: string, recursive: boolean, prefix: string[] = []): Array<[string, string]> {
  if (prefix.length === 0 && realFile(base)) {
    const file = base.split(sep).pop() ?? ''
    return file.endsWith('.md') && file.length > 3 ? [[file.slice(0, -3), base]] : []
  }
  if (!realDir(base)) return []
  const found: Array<[string, string]> = []
  for (const entry of entries(base)) {
    const path = join(base, entry.name)
    if (entry.isFile() && entry.name.endsWith('.md') && entry.name.length > 3) found.push([[...prefix, entry.name.slice(0, -3)].join(':'), path])
    else if (recursive && entry.isDirectory() && !entry.name.startsWith('.')) found.push(...mdFiles(path, true, [...prefix, entry.name]))
  }
  return found
}

/** The default folder's `.md` files, then each declared path's — core's `_md_component`. */
function mdComponent(dir: string, defaultDir: string, declared: unknown, recursive: boolean): Array<[string, string]> {
  const found = mdFiles(join(dir, defaultDir), recursive)
  for (const raw of declaredPaths(declared)) {
    const base = declaredPathIn(dir, raw)
    if (base) found.push(...mdFiles(base, recursive))
  }
  return found
}

/** The skill folders of `skills/`, of the declared `skills` paths, else the root — core's `_skills`. */
function skillsOf(dir: string, declared: unknown, pluginName: string): Array<{ name: string; dir: string }> {
  const dirs: string[] = []
  const children = (base: string): string[] =>
    entries(base)
      .filter((entry) => entry.isDirectory() && !entry.name.startsWith('.') && realFile(join(base, entry.name, 'SKILL.md')))
      .map((entry) => join(base, entry.name))
  dirs.push(...children(join(dir, 'skills')))
  for (const raw of declaredPaths(declared)) {
    const base = declaredPathIn(dir, raw)
    if (!base || !realDir(base)) continue
    if (realFile(join(base, 'SKILL.md'))) dirs.push(base)
    else dirs.push(...children(base))
  }
  const root = resolve(dir)
  if (dirs.length === 0 && realFile(join(dir, 'SKILL.md'))) dirs.push(dir)
  const found: Array<{ name: string; dir: string }> = []
  const seenDirs = new Set<string>()
  for (const skillDir of dirs) {
    const real = resolve(skillDir)
    if (seenDirs.has(real)) continue
    seenDirs.add(real)
    const name = skillNameOf(skillDir, real === root ? pluginName : (real.split(sep).pop() ?? ''))
    if (name && !found.some((skill) => skill.name === name)) found.push({ name, dir: skillDir })
  }
  return found
}

/**
 * A skill's name as core lists it: the folder's name when its `SKILL.md`
 * names itself so, else the frontmatter `name`, else the fallback (the
 * folder's name; the plugin's for a root skill).
 */
function skillNameOf(skillDir: string, fallback: string): string {
  try {
    const raw = readFileSync(join(skillDir, 'SKILL.md'), 'utf8').replace(/^\uFEFF/, '').slice(0, 8192)
    const front = /^---\r?\n([\s\S]*?)\r?\n---/.exec(raw)
    const named = front ? /^name:\s*(.+)$/m.exec(front[1])?.[1]?.trim().replace(/^["']|["']$/g, '') : null
    if (named) return named
  } catch {
    /* the fallback */
  }
  return fallback
}

/** The name an agent file gives itself in its frontmatter (`name:`), else its file name without `.md`. */
function agentNameOf(path: string, file: string): string {
  try {
    const raw = readFileSync(path, 'utf8').slice(0, 4096)
    const front = /^---\r?\n([\s\S]*?)\r?\n---/.exec(raw)
    const named = front ? /^name:\s*(.+)$/m.exec(front[1])?.[1]?.trim().replace(/^["']|["']$/g, '') : null
    if (named) return named.slice(0, 200)
  } catch {
    /* the file's name */
  }
  return file.slice(0, -3)
}

/** The events of a hooks map (`{ "hooks": { "<Event>": [...] } }`, or the bare map) with at least one entry. */
function hookEventsIn(value: unknown): string[] {
  const file = rec(value)
  const map = rec(file?.hooks) ?? (file && !('hooks' in file) ? file : null)
  if (!map) return []
  return Object.entries(map)
    .filter(([name, entry]) => name.trim() !== '' && Array.isArray(entry) && entry.length > 0)
    .map(([name]) => name)
}

/**
 * What a plugin calls itself, read from its cached folder: the manifest's
 * `displayName`, else its `name`; null when it gives neither.
 */
export function pluginTitleOf(dir: string): string | null {
  const manifest = readManifest(dir)
  return text(manifest?.displayName) ?? text(manifest?.name)
}

/**
 * The declared paths that resolve inside the plugin to something that exists,
 * as written — minus one naming the default location itself (Claude refuses a
 * manifest that declares `./hooks/hooks.json` again, and a default folder is
 * read anyway).
 */
function declaredInside(dir: string, value: unknown, defaultPath: string): string[] {
  return declaredPaths(value).filter((raw) => {
    const path = declaredPathIn(dir, raw)
    return path !== null && (realDir(path) || realFile(path)) && resolve(path) !== resolve(dir, defaultPath)
  })
}

/** What a cached plugin folder holds. */
export function readPluginTree(dir: string): PluginTree {
  const manifest = readManifest(dir)
  const skills = skillsOf(dir, manifest?.skills, text(manifest?.name) ?? (dir.split(sep).pop() ?? ''))
  const seenCommands = new Set<string>()
  const commands = mdComponent(dir, 'commands', manifest?.commands, true)
    .filter(([name]) => (seenCommands.has(name) ? false : (seenCommands.add(name), true)))
    .map(([name, path]) => ({ name, path }))
  const agents = [...new Set(mdComponent(dir, 'agents', manifest?.agents, false).map(([file, path]) => agentNameOf(path, `${file}.md`)))].sort()
  const hooksFile = join(dir, 'hooks', 'hooks.json')
  const events = new Set(hookEventsIn(readJson(hooksFile)))
  let declaredHooksFile = false
  if (rec(manifest?.hooks)) hookEventsIn(manifest?.hooks).forEach((event) => events.add(event))
  for (const raw of declaredPaths(manifest?.hooks)) {
    const path = declaredPathIn(dir, raw)
    if (!path || !realFile(path)) continue
    declaredHooksFile = true
    hookEventsIn(readJson(path)).forEach((event) => events.add(event))
  }
  const lspServers = Object.keys(collectServers(dir, '.lsp.json', manifest?.lspServers)).sort()
  return {
    dir,
    manifest: { name: text(manifest?.name), description: text(manifest?.description), version: text(manifest?.version) },
    skills: skills.map((skill) => skill.name),
    skillDirs: Object.fromEntries(skills.map((skill) => [skill.name, skill.dir])),
    commands,
    hasAgents: agents.length > 0,
    agents,
    hasHooks: realFile(hooksFile) || declaredHooksFile || events.size > 0,
    hookEvents: [...events].sort(),
    mcpServers: serversOf(dir, manifest),
    lspServers,
    declared: {
      commands: declaredInside(dir, manifest?.commands, 'commands'),
      agents: declaredInside(dir, manifest?.agents, 'agents'),
      hooks: declaredInside(dir, manifest?.hooks, join('hooks', 'hooks.json')),
      lspServers: declaredInside(dir, manifest?.lspServers, '.lsp.json')
    }
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
