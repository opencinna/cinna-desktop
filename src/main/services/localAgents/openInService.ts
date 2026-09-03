import { execFile, spawn } from 'node:child_process'
import { realpath, stat } from 'node:fs/promises'
import { homedir } from 'node:os'
import { isAbsolute, join } from 'node:path'
import { shell } from 'electron'
import { createLogger } from '../../logger/logger'
import { which } from '../../shell/env'
import { toolDetectionService } from './toolDetectionService'
import { LocalToolsError } from '../../errors'
import {
  LINUX_TERMINALS,
  buildITermAppleScript,
  buildLinuxTerminalArgv,
  buildTerminalAppleScript,
  buildWindowsLaunch,
  isLaunchablePath,
  isPathWithinRoots
} from './terminalCommand'
import type { DetectedTool, LocalToolId, OpenInRequest } from '../../../shared/localTools'

const logger = createLogger('open-in')

/** How long `osascript` gets before we call the launch failed. */
const OSASCRIPT_TIMEOUT_MS = 15_000

export interface OpenInDeps {
  /**
   * The agents roots a folder must live under. Injected so the guard can be
   * real from day one — Phase 2 replaces the empty provider with the registered
   * roots, and nothing else about this service changes.
   */
  getAllowedRoots: () => string[]
}

/** Detached child so closing the app never takes the user's terminal with it. */
function launchDetached(file: string, args: string[], cwd: string): Promise<void> {
  return new Promise((resolve, reject) => {
    try {
      const child = spawn(file, args, { cwd, detached: true, stdio: 'ignore' })
      child.once('error', (err) => reject(err))
      // `spawn` reports a failure asynchronously; once the handle is unref'd we
      // have no further interest in it, so give the error event one tick.
      setImmediate(() => {
        child.unref()
        resolve()
      })
    } catch (err) {
      reject(err)
    }
  })
}

/** Run a helper to completion (`osascript`, `open`) and surface its failure. */
function runToCompletion(file: string, args: string[]): Promise<void> {
  return new Promise((resolve, reject) => {
    execFile(file, args, { timeout: OSASCRIPT_TIMEOUT_MS }, (err, _stdout, stderr) => {
      if (err) {
        reject(new Error(stderr?.trim() || err.message))
        return
      }
      resolve()
    })
  })
}

async function isDirectory(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isDirectory()
  } catch {
    return false
  }
}

/** macOS bundle locations for iTerm2, preferred over Terminal.app when present. */
function itermBundles(): string[] {
  return ['/Applications/iTerm.app', join(homedir(), 'Applications', 'iTerm.app')]
}

/**
 * macOS refuses an Apple Event with `-1743` when the user has not granted the
 * app automation access to the target application (System Settings → Privacy &
 * Security → Automation). It is a refusal, not a prompt: on a hardened-runtime
 * build without the `com.apple.security.automation.apple-events` entitlement
 * and an `NSAppleEventsUsageDescription`, the user is never asked at all.
 *
 * Worth recognising specifically — as a generic launch failure it is a dead end,
 * whereas named it tells the user exactly which switch to flip.
 */
function asAutomationDenial(err: unknown): LocalToolsError | null {
  const message = err instanceof Error ? err.message : String(err)
  if (!/-1743|Not authorized to send Apple events/i.test(message)) return null
  return new LocalToolsError(
    'automation_denied',
    'macOS blocked Cinna from controlling your terminal. Allow it under System Settings → Privacy & Security → Automation, then try again.',
    message
  )
}

/**
 * "Open in…" launchers for a local agent folder.
 *
 * Two rules hold everywhere in here:
 *
 *  1. **Every path is validated before use.** The folder must be absolute, must
 *     resolve (through symlinks) to a real directory, and must sit inside one of
 *     the registered agents roots. A renderer compromised by XSS must not be
 *     able to hand us `~/.ssh` and get a terminal opened in it.
 *  2. **No path is ever concatenated into a command line.** Launchers get the
 *     folder as `cwd` or as its own argv element; the one exception, macOS's
 *     `do script`, escapes it for the POSIX shell and then for AppleScript. See
 *     `terminalCommand.ts`.
 */
export function createOpenInService(deps: OpenInDeps) {
  /**
   * Resolve `folder` to a real directory inside an allowed root, or throw.
   * Returns the *resolved* path so the caller launches against the same path
   * that was checked — validating one string and launching another would be a
   * TOCTOU gap through a symlink.
   */
  async function resolveAllowedFolder(folder: string): Promise<string> {
    if (typeof folder !== 'string' || !isLaunchablePath(folder)) {
      throw new LocalToolsError('invalid_folder', 'That folder path is not valid.')
    }

    const roots = deps.getAllowedRoots()
    if (roots.length === 0) {
      throw new LocalToolsError(
        'no_roots',
        'No agents folder is configured yet, so there is nothing to open.'
      )
    }

    let resolved: string
    try {
      resolved = await realpath(folder)
    } catch {
      throw new LocalToolsError('invalid_folder', 'That folder no longer exists.')
    }
    if (!(await isDirectory(resolved))) {
      throw new LocalToolsError('invalid_folder', 'That path is not a folder.')
    }

    // Resolve the roots too: a root reached through a symlink (e.g. a
    // `~/Documents` redirected to iCloud Drive) would otherwise never match.
    const resolvedRoots: string[] = []
    for (const root of roots) {
      try {
        resolvedRoots.push(await realpath(root))
      } catch {
        // A configured root that no longer exists simply allows nothing.
      }
    }

    if (!isPathWithinRoots(resolved, resolvedRoots)) {
      logger.warn('refused a folder outside the agents roots', {
        // Don't log the path itself — a hostile renderer could use the log as
        // an oracle for the filesystem layout.
        folderLength: folder.length,
        rootCount: resolvedRoots.length
      })
      throw new LocalToolsError(
        'forbidden_path',
        'That folder is outside your agents folders.'
      )
    }
    return resolved
  }

  /** The detected tool for `toolId`, asserted installed and of an expected kind. */
  async function requireTool(
    toolId: LocalToolId | undefined,
    kinds: readonly DetectedTool['kind'][]
  ): Promise<DetectedTool & { path: string }> {
    if (!toolId) {
      throw new LocalToolsError('tool_unavailable', 'No tool was selected.')
    }
    const tool = await toolDetectionService.get(toolId)
    if (!tool || !tool.available || !tool.path) {
      throw new LocalToolsError('tool_unavailable', `${toolId} is not installed on this machine.`)
    }
    if (!kinds.includes(tool.kind)) {
      throw new LocalToolsError(
        'unsupported_action',
        `${tool.label} cannot be used for that action.`
      )
    }
    return tool as DetectedTool & { path: string }
  }

  /** Open a system terminal at `folder`, optionally running `commandPath`. */
  async function launchTerminal(folder: string, commandPath: string | null): Promise<void> {
    if (process.platform === 'darwin') {
      const useITerm = (
        await Promise.all(itermBundles().map(isDirectory))
      ).some(Boolean)
      const script = useITerm
        ? buildITermAppleScript(folder, commandPath)
        : buildTerminalAppleScript(folder, commandPath)
      // `-e` takes the script as one argv element — nothing is interpreted by a
      // shell on the way, and the script itself carries the folder as an
      // escaped AppleScript literal.
      try {
        await runToCompletion('osascript', ['-e', script])
      } catch (err) {
        throw asAutomationDenial(err) ?? err
      }
      logger.info('opened macOS terminal', { terminal: useITerm ? 'iTerm' : 'Terminal', withCommand: commandPath !== null })
      return
    }

    if (process.platform === 'win32') {
      const hasWindowsTerminal = (await which('wt')) !== null
      const launch = buildWindowsLaunch(folder, commandPath, hasWindowsTerminal)
      await launchDetached(launch.file, launch.args, launch.cwd)
      logger.info('opened Windows terminal', { terminal: launch.file, withCommand: commandPath !== null })
      return
    }

    for (const terminal of LINUX_TERMINALS) {
      const binary = await which(terminal)
      if (!binary) continue
      // The folder is the child's cwd, so it never reaches a command line.
      await launchDetached(binary, buildLinuxTerminalArgv(terminal, commandPath), folder)
      logger.info('opened Linux terminal', { terminal, withCommand: commandPath !== null })
      return
    }

    throw new LocalToolsError(
      'no_terminal',
      'No supported terminal emulator was found. Install one of: ' + LINUX_TERMINALS.join(', ')
    )
  }

  /** Wrap a launcher failure as a typed, user-facing error. */
  async function guardLaunch<T>(what: string, run: () => Promise<T>): Promise<T> {
    try {
      return await run()
    } catch (err) {
      if (err instanceof LocalToolsError) throw err
      logger.error(`${what} failed`, err)
      throw new LocalToolsError(
        'launch_failed',
        `Could not ${what}.`,
        err instanceof Error ? err.message : String(err)
      )
    }
  }

  return {
    /** Run an installed CLI assistant in a system terminal, cwd = the folder. */
    async openInTerminalWithCommand(folder: string, toolId: LocalToolId | undefined): Promise<void> {
      const resolved = await resolveAllowedFolder(folder)
      const tool = await requireTool(toolId, ['cli-assistant'])
      await guardLaunch(`open ${tool.label}`, () => launchTerminal(resolved, tool.path))
    },

    /** Open the folder as a project in an installed editor. */
    async openFolderInEditor(folder: string, toolId: LocalToolId | undefined): Promise<void> {
      const resolved = await resolveAllowedFolder(folder)
      const tool = await requireTool(toolId, ['editor'])
      const target = tool.path

      await guardLaunch(`open ${tool.label}`, async () => {
        if (tool.source === 'path') {
          // `code <folder>` / `cursor <folder>` — folder is its own argv entry.
          await launchDetached(target, [resolved], resolved)
          return
        }
        // No CLI shim: hand the bundle and the folder to LaunchServices. Note
        // this is `open -a`, not `shell.openExternal` — nothing user-influenced
        // is ever parsed as a URL, and both operands stay discrete arguments.
        await runToCompletion('open', ['-a', target, resolved])
      })
      logger.info('opened folder in editor', { tool: tool.id, via: tool.source })
    },

    /** Reveal the folder in Finder / Explorer / the desktop file manager. */
    async revealInFileManager(folder: string): Promise<void> {
      const resolved = await resolveAllowedFolder(folder)
      // Same guard as every other launcher — this takes the same
      // renderer-supplied path, so it gets the same typed failure. Note the
      // honest limit: `showItemInFolder` is fire-and-forget (it returns void
      // and reports nothing back), so this catches a synchronous throw but
      // cannot detect a file manager that silently declined to open.
      await guardLaunch('reveal the folder', async () => {
        shell.showItemInFolder(resolved)
      })
      logger.info('revealed folder in file manager')
    },

    /** Open a system terminal at the folder, running nothing. */
    async openTerminalAt(folder: string): Promise<void> {
      const resolved = await resolveAllowedFolder(folder)
      await guardLaunch('open a terminal', () => launchTerminal(resolved, null))
    },

    /** Single entry point for the IPC layer. */
    async openIn(request: OpenInRequest): Promise<void> {
      if (!request || typeof request !== 'object') {
        throw new LocalToolsError('unsupported_action', 'Nothing to open.')
      }
      switch (request.action) {
        case 'terminal-command':
          return this.openInTerminalWithCommand(request.folder, request.toolId)
        case 'editor':
          return this.openFolderInEditor(request.folder, request.toolId)
        case 'reveal':
          return this.revealInFileManager(request.folder)
        case 'terminal':
          return this.openTerminalAt(request.folder)
        default:
          throw new LocalToolsError('unsupported_action', 'Unknown open-in action.')
      }
    }
  }
}

/**
 * The agents roots. Empty until the local-agents feature registers the real
 * provider, so every open-in request is refused with `no_roots` until then —
 * deliberately, so the guard is exercised from the first line of renderer code
 * rather than bolted on later.
 */
let allowedRootsProvider: () => string[] = () => []

/**
 * Register the roots a folder must live under.
 *
 * Non-absolute roots are dropped rather than trusted. `realpath` resolves a
 * relative path against `process.cwd()`, which for a packaged app is whatever
 * directory the OS happened to launch it from — so a relative root would define
 * an allowed area nobody chose, and `isPathWithinRoots` would then happily match
 * inside it. Dropping is the safe direction: the worst case is `no_roots`, which
 * refuses everything.
 */
export function setAllowedRootsProvider(provider: () => string[]): void {
  allowedRootsProvider = () => {
    const roots = provider()
    const usable = roots.filter((root) => typeof root === 'string' && isAbsolute(root))
    if (usable.length !== roots.length) {
      logger.warn('ignoring agents roots that are not absolute paths', {
        given: roots.length,
        usable: usable.length
      })
    }
    return usable
  }
}

export const openInService = createOpenInService({
  getAllowedRoots: () => allowedRootsProvider()
})
