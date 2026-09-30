import { createHash } from 'node:crypto'
import { chmod, mkdir, rm } from 'node:fs/promises'
import { join } from 'node:path'

/**
 * Where Open in browser puts an HTML attachment's bytes — a browser needs a
 * file. Under the profile's own `userData` rather than the system temp folder
 * (on Linux a `/tmp` every user shares), in folders only this user may enter,
 * and cleared at each start so copies do not pile up.
 */

/** The folder, under `userData`, that holds every copy. */
export const OPEN_IN_BROWSER_DIR = 'html-open-in-browser'

export function openInBrowserRoot(userData: string): string {
  return join(userData, OPEN_IN_BROWSER_DIR)
}

/**
 * An empty `0700` folder for one attachment's copy:
 * `<userData>/html-open-in-browser/<hash>/`. The name hashes the profile and
 * the attachment id (both from the renderer), so a copy lands in the same
 * folder each time and replaces the last.
 */
export async function prepareOpenInBrowserDir(userData: string, userId: string, attachmentId: string): Promise<string> {
  const root = openInBrowserRoot(userData)
  const id = createHash('sha256').update(`${userId}\0${attachmentId}`).digest('hex').slice(0, 32)
  const dir = join(root, id)
  await rm(dir, { recursive: true, force: true })
  await mkdir(dir, { recursive: true, mode: 0o700 })
  // `mode` applies only to folders mkdir creates, and goes through the umask: set both explicitly.
  await chmod(root, 0o700)
  await chmod(dir, 0o700)
  return dir
}

/** Remove every copy. Called at start, not awaited; a failure costs only disk space. */
export async function clearOpenInBrowserCopies(userData: string): Promise<void> {
  await rm(openInBrowserRoot(userData), { recursive: true, force: true })
}
