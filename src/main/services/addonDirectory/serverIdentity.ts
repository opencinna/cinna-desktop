/**
 * The same MCP server, whichever way it was set up: a remote one by its URL
 * (normalised), a local one by the package it runs (registry + name, no
 * version). Lets core's MCP directory show a server this computer already has
 * — typed in by hand, or made from the opencinna list before core's directory
 * was seeded from it (`mcp-registry:cinna-official`) — as that connector, so
 * Add attaches it instead of creating a second one. Pure. Core: no Electron.
 */

import { basename } from 'node:path'
import type { AddonInstall } from '../../../shared/addons/directory'

/** `https://Host:443/path/` → `https://host/path`: scheme and host lower-cased, the default port, a trailing slash and the fragment dropped. */
export function normalisedServerUrl(raw: string): string | null {
  const text = raw.trim()
  if (!text) return null
  try {
    const url = new URL(text)
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return null
    const path = url.pathname.replace(/\/+$/, '')
    return `${url.protocol}//${url.host.toLowerCase()}${path}${url.search}`
  } catch {
    return null
  }
}

/** npm's name without its version (`@scope/name@1.2` → `@scope/name`). */
function npmName(spec: string): string {
  const at = spec.indexOf('@', spec.startsWith('@') ? 1 : 0)
  return (at > 0 ? spec.slice(0, at) : spec).toLowerCase()
}

/** A PyPI project without version, specifier or extras, normalised as PEP 503 does. */
function pypiName(spec: string): string {
  const name = spec.split(/[<>=!~;[\s@]/, 1)[0] ?? ''
  return name.toLowerCase().replace(/[-_.]+/g, '-')
}

/** An image without its tag or digest (`ghcr.io/x/y:1` → `ghcr.io/x/y`). */
function ociName(spec: string): string {
  const noDigest = spec.split('@', 1)[0] ?? ''
  const slash = noDigest.lastIndexOf('/')
  const colon = noDigest.lastIndexOf(':')
  return (colon > slash ? noDigest.slice(0, colon) : noDigest).toLowerCase()
}

const DOCKER_VALUE_FLAGS = new Set(['-e', '--env', '--env-file', '-v', '--volume', '--name', '-p', '--publish', '--network', '--net', '-w', '--workdir', '-u', '--user', '--mount', '--entrypoint', '--platform', '-l', '--label'])

/** The first operand of `args` from `from` (skipping flags, and the values of the flags in `valueFlags`). */
function firstOperand(args: readonly string[], from: number, valueFlags: ReadonlySet<string> = new Set()): string | null {
  for (let at = from; at < args.length; at++) {
    const arg = args[at]
    if (arg === '--') return args[at + 1] ?? null
    if (arg.startsWith('-')) {
      if (valueFlags.has(arg)) at++
      continue
    }
    return arg
  }
  return null
}

function packageKey(registry: 'npm' | 'pypi' | 'oci', name: string): string | null {
  const id = registry === 'npm' ? npmName(name) : registry === 'pypi' ? pypiName(name) : ociName(name)
  return id ? `${registry}:${id}` : null
}

/** What a directory entry's server is, or null for one that is not an MCP server. */
export function serverKeyOfInstall(install: AddonInstall): string | null {
  if (!install || !('mcp' in install)) return null
  const connect = install.mcp
  if (connect.transport === 'stdio') return packageKey(connect.package.registry, connect.package.name)
  const url = normalisedServerUrl(connect.url)
  return url ? `url:${url}` : null
}

/** What a local connector's server is: its URL, or the package its `npx` / `uvx` / `docker run` command runs; null for anything else. */
export function serverKeyOfConnector(row: { transportType: string; url?: string | null; command?: string | null; args?: unknown }): string | null {
  if (row.transportType !== 'stdio') {
    const url = row.url ? normalisedServerUrl(row.url) : null
    return url ? `url:${url}` : null
  }
  if (!row.command) return null
  const args = Array.isArray(row.args) ? row.args.filter((arg): arg is string => typeof arg === 'string') : []
  const bin = basename(row.command).replace(/\.(exe|cmd)$/i, '').toLowerCase()
  if (bin === 'npx' || bin === 'pnpx') {
    const spec = firstOperand(args, 0, new Set(['-p', '--package']))
    return spec ? packageKey('npm', spec) : null
  }
  if (bin === 'uvx') {
    const spec = firstOperand(args, 0, new Set(['--from', '--with', '--python', '-p', '--index', '--index-url']))
    return spec ? packageKey('pypi', spec) : null
  }
  if (bin === 'docker' && args[0] === 'run') {
    const spec = firstOperand(args, 1, DOCKER_VALUE_FLAGS)
    return spec ? packageKey('oci', spec) : null
  }
  return null
}
