/**
 * How `make kit-sync` (sync.mjs) lays the rendered contract onto disk: the
 * modes core's contract tarball uses, and a swap that never leaves the bundle
 * missing. Separate from sync.mjs, which runs on import, so tests can reach it.
 */
import { chmodSync, existsSync, mkdirSync, readdirSync, renameSync, rmSync, type Dirent } from 'node:fs'
import { join } from 'node:path'

/**
 * Core's contract tarball modes: directories 0755, files 0644, `.py` files
 * 0755. Set explicitly, because `mkdtempSync` creates its directory 0700 and
 * the umask decides the rest — a bundle that lands 0700 is unreadable to any
 * other user of a packaged app.
 */
export function applyTarballModes(dir: string): void {
  chmodSync(dir, 0o755)
  const entries: Dirent[] = readdirSync(dir, { withFileTypes: true })
  for (const entry of entries) {
    const path = join(dir, entry.name)
    if (entry.isDirectory()) applyTarballModes(path)
    else chmodSync(path, entry.name.endsWith('.py') ? 0o755 : 0o644)
  }
}

/**
 * Empty the work dir and create it again. A run interrupted mid-swap leaves a
 * `staging-*` or `*.previous` tree there, and nothing should carry it into the
 * next run.
 */
export function freshWorkDir(dir: string): void {
  rmSync(dir, { recursive: true, force: true })
  mkdirSync(dir, { recursive: true })
}

/**
 * Replace `target` with `staging`. The previous tree is parked beside the
 * staging tree (never under `resources/`) and renamed back if the second rename
 * fails, so the bundle is never missing.
 */
export function swapInto(
  staging: string,
  target: string,
  rename: (from: string, to: string) => void = renameSync
): void {
  const previous = existsSync(target) ? `${staging}.previous` : null
  try {
    if (previous) rename(target, previous)
  } catch (err) {
    rmSync(staging, { recursive: true, force: true })
    throw err
  }
  try {
    rename(staging, target)
  } catch (err) {
    if (previous) {
      try {
        rename(previous, target)
      } catch (restoreErr) {
        console.error(`kit-sync: could not restore the previous bundle; it is at ${previous}`)
        throw restoreErr
      }
    }
    rmSync(staging, { recursive: true, force: true })
    throw err
  }
  if (previous) rmSync(previous, { recursive: true, force: true })
}
