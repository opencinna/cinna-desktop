/**
 * Directory MCP servers on this computer and in the manifest (unified addons
 * U4 / D6), pure over their inputs except {@link writeMcpRequirements}:
 *
 * * **Local servers from core's MCP directory.** A package becomes the
 *   command that runs it: npm → `npx -y <name>@<version>` (Node must be on
 *   this computer), pypi → the managed `uvx <name>==<version>` (Python comes
 *   with it), oci → `docker run -i --rm <image>:<version>` (Docker must be on
 *   this computer; each env name is passed into the container with `-e`).
 *   The env names become the connector's empty settings, filled in the
 *   picker's env step.
 * * **`mcp_servers[]` requirements** (contract 1.17.0, `kit/validator.ts`): a
 *   kit agent's connector from a directory is written into its manifest as a
 *   requirement — its name, the directory ref, the transport, the URL or the
 *   portable command (`uvx`, never the managed binary's path), the auth kind
 *   and the env **names**. Never a value, never a token. Custom connectors
 *   (no directory ref) and a plugin's own servers (the plugin pin carries
 *   them) are not written.
 *
 * Core: no Electron.
 */

import { basename } from 'node:path'
import { KitError } from '../../errors'
import { manifestPath, readWithStamp, writeIfUnchanged } from '../../kit/manifestIo'
import type { McpServerAuth, McpServerRequirement, McpServerTransport } from '../../../shared/kit/manifest'
import type { AddonMcpLocalConnect, AddonRef } from '../../../shared/addons/directory'
import type { StdioRuntime } from '../stdioRuntimes'

/** An env name as the contract's validator takes it (`kit/validator.ts`, ENV_VAR_NAME_PATTERN). */
export const ENV_VAR_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/

/**
 * Each registry's own grammar for what it runs. Anything else — a flag, a
 * second argument, a URL, a `git+https://` / `github:` / `file:` source, a
 * path — is refused, so a directory row can only name a published package.
 */
const PACKAGE_NAME: Record<AddonMcpLocalConnect['package']['registry'], RegExp> = {
  // npm: an unscoped or `@scope/` package name (npm's own characters, at most 214).
  npm: /^(?=.{1,214}$)(?:@[A-Za-z0-9][A-Za-z0-9._~-]*\/)?[A-Za-z0-9][A-Za-z0-9._~-]*$/,
  // PyPI: a PEP 508 project name, with optional extras (`name[a,b]`).
  pypi: /^(?=.{1,200}$)[A-Za-z0-9](?:[A-Za-z0-9._-]*[A-Za-z0-9])?(?:\[[A-Za-z0-9](?:[A-Za-z0-9._-]*[A-Za-z0-9])?(?:,[A-Za-z0-9](?:[A-Za-z0-9._-]*[A-Za-z0-9])?)*\])?$/,
  // OCI: `[registry[:port]/]repo/path[:tag]`, no scheme.
  oci: /^(?=.{1,255}$)(?:[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?(?:\.[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?)*(?::[0-9]{1,5})?\/)?[a-z0-9]+(?:(?:[._]|__|-+)[a-z0-9]+)*(?:\/[a-z0-9]+(?:(?:[._]|__|-+)[a-z0-9]+)*)*(?::[A-Za-z0-9_][A-Za-z0-9_.-]{0,127})?$/
}

/** npm: a semver version, with an optional range operator (`^1.2.3`, `>=1.0.0-rc.1`). */
const NPM_SEMVER =
  /^(?:\^|~|>=|<=|>|<|=)?(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)(?:-[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/
/** npm: a dist-tag (`latest`, `next`) — never a tarball name, so no `name@x.tgz` reaches npx as a file. */
const NPM_DIST_TAG = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/
const NPM_TARBALL = /\.(?:tgz|tar|tar\.gz)$/i

/**
 * A version as each registry writes one: npm's semver (or range) or a
 * dist-tag, PEP 440, an image tag — never `:`, `/`, `@` or a scheme.
 */
const PACKAGE_VERSION: Record<AddonMcpLocalConnect['package']['registry'], (version: string) => boolean> = {
  npm: (version) => version.length <= 128 && (NPM_SEMVER.test(version) || (NPM_DIST_TAG.test(version) && !NPM_TARBALL.test(version))),
  pypi: (version) => /^[0-9A-Za-z][0-9A-Za-z.!+_-]{0,127}$/.test(version),
  oci: (version) => /^[A-Za-z0-9_][A-Za-z0-9_.-]{0,127}$/.test(version)
}

/** The sentence an entry whose package is not one of its registry's is refused with. */
export const DIRECTORY_PACKAGE_REFUSED =
  'This server’s package is not a published npm package, PyPI project or container image, so it cannot be run on this computer.'

/** Whether `name` (and `version`) are a package of `registry` as its own grammar writes them. */
export function isRunnablePackage(registry: AddonMcpLocalConnect['package']['registry'], name: string, version: string | null): boolean {
  const grammar = PACKAGE_NAME[registry]
  if (!grammar || !grammar.test(name)) return false
  if (version === null) return true
  // An image named with its tag takes no second one.
  if (registry === 'oci' && /:[^/]*$/.test(name)) return false
  return PACKAGE_VERSION[registry](version)
}

/** The command a local directory server runs, and the runtime it needs; null when its package cannot be run safely ({@link DIRECTORY_PACKAGE_REFUSED}). */
export function directoryStdioLaunch(
  connect: Pick<AddonMcpLocalConnect, 'package' | 'env'>,
  uv: { uvxBin: string }
): { command: string; args: string[]; runtime: StdioRuntime } | null {
  const { registry, name, version, args } = connect.package
  if (!isRunnablePackage(registry, name, version)) return null
  if (registry === 'npm') return { command: 'npx', args: ['-y', version ? `${name}@${version}` : name, ...args], runtime: 'node' }
  if (registry === 'pypi') return { command: uv.uvxBin, args: [version ? `${name}==${version}` : name, ...args], runtime: 'python' }
  const env = connect.env.filter((item) => ENV_VAR_NAME.test(item.name)).flatMap((item) => ['-e', item.name])
  return { command: 'docker', args: ['run', '-i', '--rm', ...env, version ? `${name}:${version}` : name, ...args], runtime: 'docker' }
}

/** The runtime a local directory server's package needs. */
export function runtimeOfPackage(registry: AddonMcpLocalConnect['package']['registry']): StdioRuntime {
  return registry === 'npm' ? 'node' : registry === 'pypi' ? 'python' : 'docker'
}

const REQUIREMENT_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]*$/

/** A connector's name as a requirement's (`mcp_servers[].name`): letters, digits, dots, `_` and `-`, at most 64. */
export function requirementName(text: string): string {
  const slug = text
    .trim()
    .replace(/[^A-Za-z0-9._-]+/g, '-')
    .replace(/^[^A-Za-z0-9]+/, '')
    .replace(/-+$/, '')
    .slice(0, 64)
  return REQUIREMENT_NAME.test(slug) ? slug : 'mcp'
}

/** The local provider fields a requirement is built from. */
export interface RequirementRow {
  name: string
  transportType: string
  command: string | null
  args: unknown
  url: string | null
  env: unknown
  authType: string | null
}

/** The managed uv binaries a stored command may name; written as the portable `uvx` / `uv`. */
export interface UvBins {
  uvBin: string
  uvxBin: string
}

function portableCommand(command: string, uv: UvBins | null): string {
  if (uv && command === uv.uvxBin) return 'uvx'
  if (uv && command === uv.uvBin) return 'uv'
  return command
}

/**
 * The `mcp_servers[]` requirement for a local provider made from the
 * directory entry `ref`: no values, only names. `authHint` is the entry's
 * auth when known (an OAuth-capable row may need no auth at all).
 */
export function requirementOf(row: RequirementRow, ref: AddonRef, uv: UvBins | null, authHint?: McpServerAuth): McpServerRequirement {
  // Only names the contract takes: a name typed by hand in Settings may be anything.
  const envNames =
    row.env && typeof row.env === 'object' && !Array.isArray(row.env)
      ? Object.keys(row.env as Record<string, unknown>).filter((name) => ENV_VAR_NAME.test(name)).sort()
      : []
  const transport: McpServerTransport = row.transportType === 'stdio' ? 'stdio' : row.transportType === 'sse' ? 'sse' : 'http'
  const base = { name: requirementName(row.name), ref: { source: ref.source, id: ref.id }, transport }
  if (transport === 'stdio') {
    const args = Array.isArray(row.args) ? row.args.filter((arg): arg is string => typeof arg === 'string') : []
    return {
      ...base,
      command: portableCommand(row.command ?? '', uv) || basename(row.command ?? '') || 'unknown',
      ...(args.length > 0 ? { args } : {}),
      auth: authHint ?? (envNames.length > 0 ? 'env' : 'none'),
      ...(envNames.length > 0 ? { env: envNames.map((name) => ({ name, secret: true })) } : {})
    }
  }
  return { ...base, url: row.url ?? '', auth: authHint ?? (row.authType === 'bearer' ? 'bearer' : 'oauth') }
}

const refOfRequirement = (requirement: unknown): AddonRef | null => {
  const ref = requirement && typeof requirement === 'object' ? (requirement as { ref?: unknown }).ref : null
  if (!ref || typeof ref !== 'object') return null
  const { source, id } = ref as { source?: unknown; id?: unknown }
  return typeof source === 'string' && typeof id === 'string' ? { source, id } : null
}

const sameRef = (a: AddonRef | null, b: AddonRef): boolean => !!a && a.source === b.source && a.id === b.id

/**
 * `list` with `requirement` in it: the entry with the same ref is replaced
 * (keeping its name), else it is appended under a name no other entry holds.
 * Null when nothing changes.
 */
export function withRequirement(list: readonly McpServerRequirement[], requirement: McpServerRequirement): McpServerRequirement[] | null {
  const ref = refOfRequirement(requirement)!
  const at = list.findIndex((item) => sameRef(refOfRequirement(item), ref))
  if (at !== -1) {
    const next = { ...requirement, name: list[at].name }
    if (JSON.stringify(next) === JSON.stringify(list[at])) return null
    return list.map((item, index) => (index === at ? next : item))
  }
  const taken = new Set(list.map((item) => item?.name))
  let name = requirement.name
  for (let n = 2; taken.has(name); n++) name = `${requirement.name.slice(0, 60)}-${n}`
  return [...list, { ...requirement, name }]
}

/** `list` without the requirement for `ref`; null when it holds none. */
export function withoutRequirement(list: readonly McpServerRequirement[], ref: AddonRef): McpServerRequirement[] | null {
  const next = list.filter((item) => !sameRef(refOfRequirement(item), ref))
  return next.length === list.length ? null : next
}

/**
 * Re-read the agent's manifest and write `change(mcp_servers)` through the
 * modified-underneath guard (one retry when it moved between read and
 * write). An empty list drops the key. Answers whether it wrote.
 */
export function writeMcpRequirements(
  dir: string,
  change: (list: readonly McpServerRequirement[]) => McpServerRequirement[] | null
): boolean {
  const path = manifestPath(dir)
  for (let attempt = 0; attempt < 2; attempt++) {
    const { manifest, stamp } = readWithStamp(path)
    const current = Array.isArray(manifest.mcp_servers) ? manifest.mcp_servers : []
    const next = change(current)
    if (next === null) return false
    const { mcp_servers: _old, ...rest } = manifest // eslint-disable-line @typescript-eslint/no-unused-vars
    try {
      writeIfUnchanged(path, next.length > 0 ? { ...rest, mcp_servers: next } : rest, stamp)
      return true
    } catch (err) {
      if (attempt === 0 && err instanceof KitError && err.code === 'manifest_modified') continue
      throw err
    }
  }
  return false
}
