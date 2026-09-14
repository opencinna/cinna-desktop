import { statSync } from 'node:fs'
import { realpath, stat } from 'node:fs/promises'

/**
 * Where macOS mounts the writable data volume. `/Users`, `/private` and the
 * rest are firmlinks into it, so `/System/Volumes/Data/Users/x` is the same
 * folder as `/Users/x` — and `realpath` keeps whichever spelling it was given.
 */
export const DARWIN_DATA_VOLUME = '/System/Volumes/Data'

interface FileIdentity {
  dev: number
  ino: number
}

export interface PathCanonicalizerOptions {
  platform?: NodeJS.Platform
  /** The data-volume mount. Injected by tests: a real firmlink cannot be made in a tmp dir. */
  dataVolume?: string
  stat?: (path: string) => Promise<FileIdentity>
  statSync?: (path: string) => FileIdentity
}

/**
 * One spelling per file or folder, so containment and equality checks cannot
 * be sidestepped by naming a path through the data volume. Every realpath the
 * agent-files domain takes or compares goes through here.
 *
 * On darwin a leading data-volume prefix is dropped **when the shorter path is
 * the same file** (same dev and inode); anywhere else, and whenever that check
 * cannot be made, the path is returned as it came.
 */
export function createPathCanonicalizer(options: PathCanonicalizerOptions = {}) {
  const platform = options.platform ?? process.platform
  const volume = (options.dataVolume ?? DARWIN_DATA_VOLUME).replace(/\/+$/, '')
  const enabled = platform === 'darwin' && volume !== ''
  const statAsync = options.stat ?? ((path: string) => stat(path))
  const statNow = options.statSync ?? ((path: string) => statSync(path))

  function stripped(path: string): string | null {
    if (!enabled) return null
    let out = path
    while (out === volume || out.startsWith(`${volume}/`)) out = out.slice(volume.length) || '/'
    return out === path ? null : out
  }

  const same = (a: FileIdentity, b: FileIdentity): boolean => a.dev === b.dev && a.ino === b.ino

  async function canonical(path: string): Promise<string> {
    const candidate = stripped(path)
    if (candidate === null) return path
    try {
      const [original, shorter] = await Promise.all([statAsync(path), statAsync(candidate)])
      return same(original, shorter) ? candidate : path
    } catch {
      return path
    }
  }

  return {
    /**
     * The path without the data-volume prefix, checked against nothing on disk.
     * Only for checks that err towards refusing — a privacy-guarded location, a
     * credential name, a folder too broad to approve — where touching the disk
     * is the thing being avoided or a false match costs nothing.
     */
    lexical(path: string): string {
      return stripped(path) ?? path
    },

    canonical,

    canonicalSync(path: string): string {
      const candidate = stripped(path)
      if (candidate === null) return path
      try {
        return same(statNow(path), statNow(candidate)) ? candidate : path
      } catch {
        return path
      }
    },

    /** `realpath`, then {@link canonical}. Rejects like `realpath` when the path is missing. */
    async realpath(path: string): Promise<string> {
      return canonical(await realpath(path))
    }
  }
}

export type PathCanonicalizer = ReturnType<typeof createPathCanonicalizer>
