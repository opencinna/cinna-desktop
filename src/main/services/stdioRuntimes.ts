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
 *   without a restart (the picker's Check again), re-reading the login
 *   shell's PATH first.
 * * **Policy**: with core's `stdio_mcp` off, no stdio server is installed.
 *
 * Core: no Electron.
 */

import { existsSync } from 'node:fs'
import { basename, isAbsolute, join, sep } from 'node:path'
import { resetShellEnv, which } from '../shell/env'
import { toolchain, type ManagedUvLayout } from '../localdev/toolchain'
import type { AddonMcpServerComponent, AddonPolicy } from '../../shared/addons/directory'
import { STDIO_RUNTIME_TEXT } from '../../shared/stdioRuntimeText'

export type StdioRuntime = 'python' | 'node' | 'docker'

export { STDIO_RUNTIME_TEXT } from '../../shared/stdioRuntimeText'

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

/** Where a path flag's value sits in `args`: the index of the value (or of the `--flag=value` arg) and the value. */
interface FlagValue {
  at: number
  inline: string | null
  value: string
}

/** The first of `flags` in `args` before `--`, from index `from`. */
function flagValue(args: readonly string[], flags: readonly string[], from: number): FlagValue | null {
  for (let at = from; at < args.length; at++) {
    const arg = args[at]
    if (arg === '--') break
    for (const flag of flags) {
      if (arg === flag && typeof args[at + 1] === 'string') return { at: at + 1, inline: null, value: args[at + 1] }
      if (arg.startsWith(`${flag}=`)) return { at, inline: flag, value: arg.slice(flag.length + 1) }
    }
  }
  return null
}

const resolved = (value: string, root: string | null): string => (isAbsolute(value) || !root ? value : join(root, value))

/** The project folder a `uv run …` names (`--directory` / `--project`, else `root`). */
function uvProjectDir(args: readonly string[], root: string | null): string | null {
  const found = flagValue(args, ['--directory', '--project'], 1)
  return found ? resolved(found.value, root) : root
}

const inside = (path: string, root: string): boolean => path === root || path.startsWith(root.endsWith(sep) ? root : `${root}${sep}`)

/** `args` with the flag value `found` pointing at the same place in the working copy `work` of `root`. */
function intoWork(args: readonly string[], found: FlagValue, path: string, root: string, work: string): string[] {
  const moved = join(work, path.slice(root.length))
  return args.map((arg, at) => (at !== found.at ? arg : found.inline ? `${found.inline}=${moved}` : moved))
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
 *
 * A project there with **no** `uv.lock` would make uv write one into the
 * read-only cache, and a `uvx --from <folder>` there builds the package in
 * the folder (setuptools writes `build/` and `*.egg-info`). Both are pointed
 * at the same place in `work` instead — a writable working copy of the
 * cached tree for this snapshot, made at launch (`mcp/managed.ts`
 * `ensurePluginWorkCopy`) — and answer `usesWork`. With no `work`, they are
 * left as written.
 */
export function throughManagedUv(
  command: string,
  args: readonly string[],
  uv: Pick<ManagedUvLayout, 'uvBin' | 'uvxBin'>,
  root: string | null = null,
  work: string | null = null
): { command: string; args: string[]; usesWork?: true } {
  const bin = basename(command).replace(/\.exe$/i, '')
  if (bin === 'uvx') {
    const from = root && work ? flagValue(args, ['--from'], 0) : null
    const source = from && isAbsolute(from.value) ? from.value : null
    if (from && source && root && work && inside(source, root)) return { command: uv.uvxBin, args: intoWork(args, from, source, root, work), usesWork: true }
    return { command: uv.uvxBin, args: [...args] }
  }
  if (bin === 'uv') {
    const project = args[0] === 'run' ? uvProjectDir(args, root) : null
    const pinned = args.some((arg) => arg === '--frozen' || arg === '--locked' || arg === '--no-project')
    if (project && !pinned && existsSync(join(project, 'uv.lock'))) return { command: uv.uvBin, args: ['run', '--frozen', ...args.slice(1)] }
    const flag = args[0] === 'run' ? flagValue(args, ['--directory', '--project'], 1) : null
    if (flag && project && !pinned && root && work && inside(project, root)) {
      return { command: uv.uvBin, args: intoWork(args, flag, project, root, work), usesWork: true }
    }
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
  // Check again comes after the user installed Node or Docker, whose installer may have added a PATH entry:
  // the login shell's PATH is read again, not only the lookups under the old one.
  clear: () => resetShellEnv(),
  ensureUv: () => toolchain.ensureUv()
})
