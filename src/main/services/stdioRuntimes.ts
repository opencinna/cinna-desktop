/**
 * What a plugin's local-process (stdio) MCP server needs on this computer
 * before it can run, and how it is made to run (unified addons README §6 q3):
 *
 * * **Python** (`uvx`, `uv`, `python`) runs through the app's pinned uv in
 *   `<userData>/localdev/` (`localdev/toolchain.ts`), installed on Add — so it
 *   works on a bare Mac and is never a reason to block. The command is
 *   rewritten to the managed `uvx` / `uv`; `mcp/managed.ts` hands it uv's
 *   `UV_*` environment at launch.
 * * **Node** (`node`, `npx`, …) and **Docker** must already be installed: they
 *   are looked up once per app session on the login-shell PATH — the same
 *   resolution `mcp/manager.ts` launches with — and a missing one blocks the
 *   Add with the sentence why. {@link stdioRuntimes.recheck} looks again
 *   without a restart (the picker's Check again).
 * * **Policy**: with core's `stdio_mcp` off, no stdio server is installed.
 *
 * Core: no Electron.
 */

import { existsSync } from 'node:fs'
import { basename, isAbsolute, join } from 'node:path'
import { clearToolCache, which } from '../shell/env'
import { toolchain, type ManagedUvLayout } from '../localdev/toolchain'
import type { AddonMcpServerComponent, AddonPolicy } from '../../shared/addons/directory'

export type StdioRuntime = 'python' | 'node' | 'docker'

export const STDIO_RUNTIME_TEXT = {
  node: 'Needs Node.js — install it from nodejs.org',
  docker: 'Needs Docker — install it from docker.com',
  policy: 'Blocked by your admin',
  uvFailed: 'Python could not be set up on this computer.'
} as const

const PYTHON_COMMANDS = new Set(['uvx', 'uv', 'python', 'python3'])
const NODE_COMMANDS = new Set(['node', 'npx', 'npm', 'pnpm', 'pnpx', 'yarn'])

/** The runtime a server command names, or null for anything else (a binary of the plugin's own, a path). */
export function runtimeOfCommand(command: string | null | undefined): StdioRuntime | null {
  if (!command) return null
  const bin = basename(command).replace(/\.(exe|cmd)$/i, '')
  if (PYTHON_COMMANDS.has(bin)) return 'python'
  if (NODE_COMMANDS.has(bin)) return 'node'
  if (bin === 'docker') return 'docker'
  return null
}

/** The project folder a `uv run …` names (`--directory` / `--project`, else `root`). */
function uvProjectDir(args: readonly string[], root: string | null): string | null {
  for (let at = 1; at < args.length; at++) {
    const arg = args[at]
    if (arg === '--') break
    for (const flag of ['--directory', '--project']) {
      if (arg === flag && typeof args[at + 1] === 'string') return isAbsolute(args[at + 1]) || !root ? args[at + 1] : join(root, args[at + 1])
      if (arg.startsWith(`${flag}=`)) {
        const value = arg.slice(flag.length + 1)
        return isAbsolute(value) || !root ? value : join(root, value)
      }
    }
  }
  return root
}

/**
 * A Python server's command and args, run through the managed uv: `uvx …` →
 * the pinned `uvx …`, `uv …` → the pinned `uv …`, `python …` →
 * `uv run --no-project python …` (uv supplies the interpreter). Anything else
 * is returned as it is.
 *
 * A `uv run` of a project in the read-only plugin cache (`root`) is made
 * `--frozen` when the project has a `uv.lock`: uv then reads the lock and
 * never rewrites it, and its environment goes to `UV_PROJECT_ENVIRONMENT`
 * (set at launch, `mcp/managed.ts`) rather than a `.venv` inside the cache.
 */
export function throughManagedUv(
  command: string,
  args: readonly string[],
  uv: Pick<ManagedUvLayout, 'uvBin' | 'uvxBin'>,
  root: string | null = null
): { command: string; args: string[] } {
  const bin = basename(command).replace(/\.exe$/i, '')
  if (bin === 'uvx') return { command: uv.uvxBin, args: [...args] }
  if (bin === 'uv') {
    const project = args[0] === 'run' ? uvProjectDir(args, root) : null
    const pinned = args.some((arg) => arg === '--frozen' || arg === '--locked' || arg === '--no-project')
    if (project && !pinned && existsSync(join(project, 'uv.lock'))) return { command: uv.uvBin, args: ['run', '--frozen', ...args.slice(1)] }
    return { command: uv.uvBin, args: [...args] }
  }
  if (bin === 'python' || bin === 'python3') return { command: uv.uvBin, args: ['run', '--no-project', 'python', ...args] }
  return { command, args: [...args] }
}

/** Looks up a tool on the login-shell PATH; null when absent. */
export type ToolLookup = (bin: string) => Promise<string | null>

export function createStdioRuntimes(deps: { which: ToolLookup; clear: () => void; ensureUv: () => Promise<ManagedUvLayout> }) {
  /** Per session: a probe, once, until {@link recheck}. */
  const probes = new Map<'node' | 'docker', Promise<boolean>>()

  const probe = (runtime: 'node' | 'docker'): Promise<boolean> => {
    let known = probes.get(runtime)
    if (!known) {
      const bins = runtime === 'node' ? ['node', 'npx'] : ['docker']
      known = Promise.all(bins.map((bin) => deps.which(bin).catch(() => null))).then((found) => found.some((path) => !!path))
      probes.set(runtime, known)
    }
    return known
  }

  /** Whether `runtime` is on this computer (Python always is: the managed uv brings it). */
  const available = async (runtime: StdioRuntime): Promise<boolean> => (runtime === 'python' ? true : probe(runtime))

  return {
    available,

    /**
     * Why these servers cannot be installed here, or null: the policy first
     * (no stdio servers at all), then a missing Node or Docker. MCP over
     * HTTP needs nothing local.
     */
    async blockOf(servers: readonly Pick<AddonMcpServerComponent, 'transport' | 'runtime'>[], policy: Pick<AddonPolicy, 'stdioMcp'>): Promise<string | null> {
      const local = servers.filter((server) => server.transport === 'stdio')
      if (local.length === 0) return null
      if (!policy.stdioMcp) return STDIO_RUNTIME_TEXT.policy
      for (const runtime of ['node', 'docker'] as const) {
        if (local.some((server) => server.runtime === runtime) && !(await available(runtime))) return STDIO_RUNTIME_TEXT[runtime]
      }
      return null
    },

    /** Look again: forget this session's answers (and the PATH lookup's misses). */
    async recheck(): Promise<{ node: boolean; docker: boolean }> {
      probes.clear()
      deps.clear()
      const [node, docker] = await Promise.all([available('node'), available('docker')])
      return { node, docker }
    },

    /** The pinned uv, installed if it is not yet. */
    ensureUv: (): Promise<ManagedUvLayout> => deps.ensureUv(),

    /** Tests: forget everything. */
    _reset(): void {
      probes.clear()
    }
  }
}

export const stdioRuntimes = createStdioRuntimes({
  which: (bin) => which(bin),
  clear: () => clearToolCache(),
  ensureUv: () => toolchain.ensureUv()
})
