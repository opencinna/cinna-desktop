import { execFile } from 'node:child_process'
import { stat } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { clearToolCache, getShellEnv, shellEnvForChild, which } from '../../shell/env'
import { createLogger } from '../../logger/logger'
import { toolchain } from '../../localdev/toolchain'
import type { DetectedTool, LocalToolId, LocalToolKind } from '../../../shared/localTools'

const logger = createLogger('local-tools')

interface ToolSpec {
  id: LocalToolId
  kind: LocalToolKind
  label: string
  /** Executable name looked up on the resolved login-shell PATH. */
  bin: string
  /**
   * macOS application bundles to fall back on when the CLI shim is absent.
   * Many people install VS Code or Cursor by dragging the app across and never
   * run "Install 'code' command in PATH", so PATH detection alone would report
   * an editor they can plainly see in their Dock as missing.
   */
  macBundles?: string[]
  /**
   * A copy this app installed into its own data directory, tried after PATH and
   * the bundles. Last on purpose: a tool the user installed themselves is the
   * one their shell runs, and this list is about what *they* can open a folder
   * with. Desktop-spawned processes go straight to the managed copy through
   * `toolchainEnv()` and never consult this.
   *
   * A thunk, not a path: resolving it reads `app.getPath`, which is not safe to
   * call at module load.
   */
  managed?: () => string | null
}

/** Every tool the desktop knows how to detect, in display order. */
const TOOL_SPECS: readonly ToolSpec[] = [
  { id: 'claude', kind: 'cli-assistant', label: 'Claude Code', bin: 'claude' },
  { id: 'codex', kind: 'cli-assistant', label: 'Codex', bin: 'codex' },
  { id: 'opencode', kind: 'cli-assistant', label: 'OpenCode', bin: 'opencode' },
  {
    id: 'code',
    kind: 'editor',
    label: 'VS Code',
    bin: 'code',
    macBundles: ['/Applications/Visual Studio Code.app']
  },
  {
    id: 'cursor',
    kind: 'editor',
    label: 'Cursor',
    bin: 'cursor',
    macBundles: ['/Applications/Cursor.app']
  },
  {
    id: 'cinna',
    // A `runtime`, not a `cli-assistant`: its presence gates local development,
    // but "open this agent folder in cinna" is not a thing anyone wants, and
    // `cli-assistant` is what puts a tool in the Open-in row.
    kind: 'runtime',
    label: 'Cinna CLI',
    bin: 'cinna',
    managed: () => join(toolchain.root(), 'bin', 'cinna')
  },
  { id: 'uv', kind: 'runtime', label: 'uv', bin: 'uv' },
  { id: 'git', kind: 'runtime', label: 'Git', bin: 'git' },
  { id: 'make', kind: 'runtime', label: 'Make', bin: 'make' },
  { id: 'python3', kind: 'runtime', label: 'Python 3', bin: 'python3' }
]

const SPEC_BY_ID = new Map<LocalToolId, ToolSpec>(TOOL_SPECS.map((spec) => [spec.id, spec]))

/** Candidate bundle locations: the system folder plus the per-user one. */
function bundleCandidates(spec: ToolSpec): string[] {
  if (process.platform !== 'darwin' || !spec.macBundles) return []
  const userApps = join(homedir(), 'Applications')
  return spec.macBundles.flatMap((bundle) => [bundle, join(userApps, bundle.slice('/Applications/'.length))])
}

async function isDirectory(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isDirectory()
  } catch {
    return false
  }
}

async function isFile(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isFile()
  } catch {
    return false
  }
}

/**
 * The managed copy's path, or null when there is none or the app data dir is
 * not available. The `try` is not defensive noise: detection runs from tests
 * and from early startup paths where Electron's `app` may not be ready, and a
 * missing optional tool must never take the whole detection pass down with it.
 */
function managedCandidate(spec: ToolSpec): string | null {
  try {
    return spec.managed?.() ?? null
  } catch {
    return null
  }
}

/**
 * How long one `--version` probe may take before it is abandoned.
 *
 * Every probe runs concurrently and detection is cached for the app lifetime,
 * so the whole pass costs one of these — but a tool that hangs (a `cinna` that
 * blocks on a network call, an assistant waiting on a login prompt) must never
 * hold up the Settings screen, so the wait is bounded and a timeout reports
 * "installed, version unknown" rather than "not installed".
 */
const VERSION_TIMEOUT_MS = 3000

/** The version argument each tool answers to. Everything here takes `--version`. */
const VERSION_ARG = '--version'

/**
 * Ask an executable its version.
 *
 * Runs the binary at the **resolved path**, never a bare name, and with
 * `execFile` rather than a shell, so nothing here is interpolated into a
 * command line. Failure of any kind is `null`: this is a nice-to-have column
 * in a settings table, and no probe result is worth failing detection over.
 */
async function probeVersion(binPath: string): Promise<string | null> {
  // **Through `shellEnvForChild`.** `getShellEnv()` sources the user's
  // `.zshrc`/`.bashrc`, which is where `ANTHROPIC_API_KEY`, `GITHUB_TOKEN` and
  // `AWS_SECRET_ACCESS_KEY` live. Handing that set to nine third-party binaries
  // to read a version string for a settings table is not a trade worth making —
  // `gitService.run` narrows for the same reason.
  const env = shellEnvForChild(await getShellEnv().catch(() => process.env))
  const probe = new Promise<string | null>((resolve) => {
    execFile(
      binPath,
      [VERSION_ARG],
      {
        timeout: VERSION_TIMEOUT_MS,
        env,
        windowsHide: true,
        // SIGTERM leaves a shim that traps it alive; this column is not worth
        // waiting on a process that has already ignored one signal.
        killSignal: 'SIGKILL'
      },
      (err, stdout, stderr) => {
        if (err) return resolve(null)
        resolve(cleanVersion(`${stdout}`.trim() || `${stderr}`.trim()))
      }
    )
  })
  /*
    Raced against our own timer, because `execFile`'s `timeout` is not one.
    Its callback fires on **close**, which waits for the stdio pipes to reach
    EOF — so a wrapper script whose grandchild inherits stdout (a `claude` shim
    that execs node, a `cinna` that leaves a daemon) keeps the promise pending
    after the direct child is dead. `detectAll` is one `Promise.all` behind a
    `detection ??=` cache that only clears on *rejection*, so a single such tool
    would hang Developer Tools — and `Open in…`, which reads the same cache —
    for the life of the app. This decouples "we stopped waiting" from "the child
    exited".
  */
  return Promise.race([
    probe,
    new Promise<string | null>((resolve) =>
      setTimeout(() => resolve(null), VERSION_TIMEOUT_MS + 500).unref?.()
    )
  ])
}

/**
 * The version out of a `--version` line.
 *
 * Tools disagree wildly — `git version 2.39.5`, `Python 3.11.6`, `uv 0.4.20
 * (a1b2c3d 2024-09-30)`, and Claude Code's `1.0.7 (Claude Code)`. Take the
 * first line, then the first dotted-numeric token in it; failing that, keep the
 * line itself, capped, so an unrecognised format still tells the user
 * something rather than reading as "not detected".
 */
function cleanVersion(raw: string): string | null {
  const line = raw.split('\n')[0]?.trim()
  if (!line) return null
  const match = line.match(/\d+\.\d+(\.\d+)?([-+.\w]*)?/)
  // Both branches capped: `[-+.\w]*` is unbounded, so a tool printing a dotted
  // number followed by a very long word run would put all of it into the DTO.
  return (match ? match[0] : line).slice(0, 40)
}

async function detect(spec: ToolSpec): Promise<DetectedTool> {
  const onPath = await which(spec.bin)
  if (onPath) {
    return {
      id: spec.id,
      kind: spec.kind,
      label: spec.label,
      path: onPath,
      available: true,
      source: 'path',
      version: await probeVersion(onPath)
    }
  }

  for (const bundle of bundleCandidates(spec)) {
    if (await isDirectory(bundle)) {
      return {
        id: spec.id,
        kind: spec.kind,
        label: spec.label,
        path: bundle,
        available: true,
        source: 'app-bundle',
        // An `.app` with no CLI shim — there is nothing to ask. Null here means
        // "no way to know", which the table renders differently from "not
        // installed".
        version: null
      }
    }
  }

  const managed = managedCandidate(spec)
  if (managed && (await isFile(managed))) {
    return {
      id: spec.id,
      kind: spec.kind,
      label: spec.label,
      path: managed,
      available: true,
      source: 'managed',
      version: await probeVersion(managed)
    }
  }

  return {
    id: spec.id,
    kind: spec.kind,
    label: spec.label,
    path: null,
    available: false,
    source: null,
    version: null
  }
}

/** In-flight or completed detection pass; cleared by `refresh()`. */
let detection: Promise<DetectedTool[]> | null = null

async function detectAll(): Promise<DetectedTool[]> {
  const tools = await Promise.all(TOOL_SPECS.map(detect))
  logger.info('detected local tools', {
    available: tools.filter((t) => t.available).map((t) => t.id)
  })
  return tools
}

/**
 * Detects the developer tools the desktop can hand an agent folder to.
 *
 * Detection is one pass over the login-shell PATH (see `src/main/shell/env.ts`)
 * plus, on macOS, the conventional application-bundle locations. Results are
 * cached for the app lifetime because probing the filesystem on every render of
 * the agent page would be wasteful; the explicit {@link refresh} backs the
 * Settings affordance for a user who has just installed something.
 */
export const toolDetectionService = {
  list(): Promise<DetectedTool[]> {
    detection ??= detectAll().catch((err) => {
      // Never let a detection failure poison the cache — the next call retries.
      detection = null
      logger.warn('tool detection failed', err)
      return TOOL_SPECS.map(
        (spec): DetectedTool => ({
          id: spec.id,
          kind: spec.kind,
          label: spec.label,
          path: null,
          available: false,
          source: null,
          version: null
        })
      )
    })
    return detection
  },

  /** Drop the PATH lookup cache and detect again. */
  refresh(): Promise<DetectedTool[]> {
    clearToolCache()
    detection = null
    return this.list()
  },

  /** A single detected tool, or `undefined` when the id is unknown. */
  async get(id: LocalToolId): Promise<DetectedTool | undefined> {
    if (!SPEC_BY_ID.has(id)) return undefined
    return (await this.list()).find((tool) => tool.id === id)
  }
}
