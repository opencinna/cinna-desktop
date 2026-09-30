import { execFile, spawn } from 'node:child_process'

/** One way of handing a file to a browser; a launcher tries them in order. */
export type BrowserLaunchStep =
  /** Run to completion (`open -a <browser> <file>`, `xdg-open <file>`) and surface its failure. */
  | { kind: 'exec'; file: string; args: string[] }
  /** Start detached (a Windows browser executable, which keeps running). */
  | { kind: 'spawn'; file: string; args: string[] }
  /** `shell.openPath`: whatever the OS opens this file type with. */
  | { kind: 'open-path' }

/**
 * How **Open in browser** hands an HTML file over — to the default *web
 * browser* (the `https:` handler), not to whatever app `.html` files open
 * with, which is often an editor. Pure.
 *
 * - macOS: `open -a <browser.app> <file>`.
 * - Windows: the browser's executable with the file as its argument.
 * - Linux (no browser lookup there): `xdg-open <file>`.
 *
 * Each ends with the OS default app for the file as the fallback. The file is
 * always its own argv element; nothing is parsed as a URL.
 */
export function browserLaunchPlan(
  platform: NodeJS.Platform,
  browserPath: string | null,
  file: string
): BrowserLaunchStep[] {
  const fallback: BrowserLaunchStep = { kind: 'open-path' }
  if (platform === 'darwin' && browserPath) {
    return [{ kind: 'exec', file: 'open', args: ['-a', browserPath, file] }, fallback]
  }
  if (platform === 'win32' && browserPath) {
    return [{ kind: 'spawn', file: browserPath, args: [file] }, fallback]
  }
  if (platform === 'linux') {
    return [{ kind: 'exec', file: 'xdg-open', args: [file] }, fallback]
  }
  return [fallback]
}

export interface BrowserLauncherDeps {
  platform: NodeJS.Platform
  /** The default browser's app bundle (macOS) or executable (Windows); null when unknown. */
  findBrowser: () => Promise<string | null>
  /** `shell.openPath`: resolves to an error string, empty on success. */
  openPath: (path: string) => Promise<string>
  exec?: (file: string, args: string[]) => Promise<void>
  spawnDetached?: (file: string, args: string[]) => Promise<void>
}

const EXEC_TIMEOUT_MS = 15_000

function execToCompletion(file: string, args: string[]): Promise<void> {
  return new Promise((resolve, reject) => {
    execFile(file, args, { timeout: EXEC_TIMEOUT_MS }, (err) => (err ? reject(err) : resolve()))
  })
}

function spawnDetachedProcess(file: string, args: string[]): Promise<void> {
  return new Promise((resolve, reject) => {
    try {
      const child = spawn(file, args, { detached: true, stdio: 'ignore' })
      child.once('error', reject)
      // `spawn` reports a missing executable asynchronously: give it a tick.
      setImmediate(() => {
        child.unref()
        resolve()
      })
    } catch (err) {
      reject(err)
    }
  })
}

/**
 * `(file) => Promise<void>` that opens `file` in the default browser, trying
 * {@link browserLaunchPlan}'s steps in order and throwing the last failure
 * when none worked. Validating `file` is the caller's job.
 */
export function createBrowserLauncher(deps: BrowserLauncherDeps): (file: string) => Promise<void> {
  const exec = deps.exec ?? execToCompletion
  const spawnDetached = deps.spawnDetached ?? spawnDetachedProcess
  return async (file) => {
    const browser = await deps.findBrowser().catch(() => null)
    let lastError: unknown = null
    for (const step of browserLaunchPlan(deps.platform, browser, file)) {
      try {
        if (step.kind === 'exec') await exec(step.file, step.args)
        else if (step.kind === 'spawn') await spawnDetached(step.file, step.args)
        else {
          const refusal = await deps.openPath(file)
          if (refusal) throw new Error('the default app refused the file')
        }
        return
      } catch (err) {
        lastError = err
      }
    }
    throw lastError instanceof Error ? lastError : new Error('no browser could open the file')
  }
}
