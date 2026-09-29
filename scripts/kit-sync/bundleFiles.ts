/**
 * How `make kit-sync` (sync.mjs) lays the rendered kit onto disk: the modes
 * core's kit tarball uses, and a clean work dir per run. The swap that never
 * leaves the bundle missing is `swapInto` in `src/main/kit/treeSwap.ts`, shared
 * with the workshop sync. Separate from sync.mjs, which runs on import, so
 * tests can reach it.
 */
import { chmodSync, mkdirSync, readdirSync, rmSync, type Dirent } from 'node:fs'
import { join } from 'node:path'

/**
 * Core's kit tarball modes: directories 0755, files 0644, `.py` files
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
