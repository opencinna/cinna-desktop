import { stat } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { clearToolCache, which } from '../../shell/env'
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

async function detect(spec: ToolSpec): Promise<DetectedTool> {
  const onPath = await which(spec.bin)
  if (onPath) {
    return { id: spec.id, kind: spec.kind, label: spec.label, path: onPath, available: true, source: 'path' }
  }

  for (const bundle of bundleCandidates(spec)) {
    if (await isDirectory(bundle)) {
      return {
        id: spec.id,
        kind: spec.kind,
        label: spec.label,
        path: bundle,
        available: true,
        source: 'app-bundle'
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
      source: 'managed'
    }
  }

  return { id: spec.id, kind: spec.kind, label: spec.label, path: null, available: false, source: null }
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
      return TOOL_SPECS.map((spec) => ({
        id: spec.id,
        kind: spec.kind,
        label: spec.label,
        path: null,
        available: false,
        source: null
      }))
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
