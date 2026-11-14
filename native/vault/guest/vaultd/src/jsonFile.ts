import { randomBytes } from 'node:crypto'
import { open, rename, rm } from 'node:fs/promises'
import { dirname, join } from 'node:path'

/** Write JSON to a sibling temp file, fsync it, rename over `file`, fsync the directory. */
export async function writeJsonAtomic(file: string, value: unknown, mode = 0o600): Promise<void> {
  const tmp = join(dirname(file), `.${randomBytes(6).toString('hex')}.tmp`)
  const handle = await open(tmp, 'w', mode)
  try {
    await handle.writeFile(JSON.stringify(value))
    await handle.sync()
  } catch (err) {
    await handle.close()
    await rm(tmp, { force: true })
    throw err
  }
  await handle.close()
  await rename(tmp, file)
  try {
    const dir = await open(dirname(file), 'r')
    try { await dir.sync() } finally { await dir.close() }
  } catch {
    // Directory fsync is not supported everywhere (fake mode on some hosts).
  }
}
