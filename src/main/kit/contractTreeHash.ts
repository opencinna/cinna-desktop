/**
 * The tree hash that pins `resources/cinna-agent-kit/` to the render
 * `make kit-sync` produced from cinna-core (`scripts/kit-sync/kit.lock.json`).
 *
 * Shared by the sync script (run under `node --experimental-strip-types`, so this
 * module imports nothing but `node:` builtins and uses no TS-only syntax that
 * needs emitting) and by `contractBundle.test.ts`, which fails on a hand edit.
 *
 * Definition: every regular file under the root, keyed by its POSIX path
 * relative to the root; entries sorted by the UTF-8 bytes of that path; the hash
 * is sha256 over the concatenation of `<path>\0<sha256 hex of the bytes>\n` per
 * entry, lower-case hex. A symlink or any other non-regular entry is an error —
 * the bundle is a plain copy of rendered files.
 */

import { createHash } from 'node:crypto'
import { readdirSync, readFileSync, type Dirent } from 'node:fs'
import { join } from 'node:path'

/** `{ relative POSIX path: sha256 hex }` for every file under `root`. */
export function listContractFiles(root: string): Map<string, string> {
  const files = new Map<string, string>()
  const walk = (dir: string, prefix: string): void => {
    const entries: Dirent[] = readdirSync(dir, { withFileTypes: true })
    for (const entry of entries) {
      const rel = prefix === '' ? entry.name : `${prefix}/${entry.name}`
      const abs = join(dir, entry.name)
      if (entry.isDirectory()) walk(abs, rel)
      else if (entry.isFile()) files.set(rel, createHash('sha256').update(readFileSync(abs)).digest('hex'))
      else throw new Error(`contract bundle holds a non-regular entry: ${rel}`)
    }
  }
  walk(root, '')
  return files
}

/** Compare two paths by their UTF-8 bytes — Python's `sorted()` on str agrees. */
export function compareUtf8(a: string, b: string): number {
  return Buffer.compare(Buffer.from(a, 'utf8'), Buffer.from(b, 'utf8'))
}

/** The tree hash described above. */
export function contractTreeHash(root: string): { hash: string; fileCount: number } {
  const files = listContractFiles(root)
  const digest = createHash('sha256')
  for (const rel of [...files.keys()].sort(compareUtf8)) {
    digest.update(`${rel}\0${files.get(rel)}\n`, 'utf8')
  }
  return { hash: digest.digest('hex'), fileCount: files.size }
}
