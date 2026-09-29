/**
 * Replace a directory tree wholesale without ever leaving it missing.
 *
 * Shared by `make kit-sync` (scripts/kit-sync/sync.mjs, which swaps the
 * rendered kit into `resources/cinna-agent-kit/`) and by the workshop sync in
 * `agentsHomeService`, which swaps the bundled kit into `<root>/.cinna-kit/`.
 * The sync script runs under `node --experimental-strip-types`, so this module
 * imports nothing but `node:` builtins and uses no TS-only syntax that needs
 * emitting. It logs nothing: a caller that cannot put the previous tree back
 * gets an error naming where it is.
 */

import { existsSync, renameSync, rmSync } from 'node:fs'

/**
 * Replace `target` with `staging`. Both must be on one filesystem, so each step
 * is a rename. The previous tree is parked at `<staging>.previous` and renamed
 * back if the second rename fails, so `target` is never missing; the staging
 * tree is removed on every failure path.
 *
 * Removing the staging or parked tree is best effort: a leftover never turns a
 * swap that succeeded into a failure, nor hides the rename error that
 * mattered. Callers clear leftovers on their next run (`freshWorkDir`, the
 * workshop sync's stale-staging sweep).
 *
 * @throws the rename error. When the previous tree cannot be put back either,
 *   an error whose message names the path it was parked at.
 */
export function swapInto(
  staging: string,
  target: string,
  rename: (from: string, to: string) => void = renameSync,
  remove: (path: string) => void = (path) => rmSync(path, { recursive: true, force: true })
): void {
  const discard = (path: string): void => {
    try {
      remove(path)
    } catch {
      /* best effort: see above */
    }
  }
  const previous = existsSync(target) ? `${staging}.previous` : null
  try {
    if (previous) rename(target, previous)
  } catch (err) {
    discard(staging)
    throw err
  }
  try {
    rename(staging, target)
  } catch (err) {
    if (previous) {
      try {
        rename(previous, target)
      } catch (restoreErr) {
        const reason = restoreErr instanceof Error ? restoreErr.message : String(restoreErr)
        throw new Error(`could not restore the previous tree; it is at ${previous} (${reason})`, {
          cause: restoreErr
        })
      }
    }
    discard(staging)
    throw err
  }
  if (previous) discard(previous)
}
