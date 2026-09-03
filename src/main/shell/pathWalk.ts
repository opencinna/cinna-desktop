import { posix, win32 } from 'node:path'

/**
 * Pure PATH-walking helpers behind {@link import('./env').which}. Kept free of
 * `node:fs` and of the Electron-bound logger so the resolution rules are unit
 * testable, and so Windows semantics can be exercised from a posix host.
 */

export type WalkPlatform = 'win32' | 'posix'

export function currentWalkPlatform(): WalkPlatform {
  return process.platform === 'win32' ? 'win32' : 'posix'
}

function pathModule(platform: WalkPlatform): typeof posix {
  return platform === 'win32' ? (win32 as unknown as typeof posix) : posix
}

/** Default extension list used when Windows gives us no `PATHEXT`. */
const DEFAULT_PATHEXT = '.COM;.EXE;.BAT;.CMD'

/**
 * Split a `PATH` value into directory entries, dropping empties. An empty
 * entry means "the current directory" in POSIX tradition — deliberately not
 * honoured here, since resolving a tool relative to the app's cwd is a
 * hijacking vector.
 */
export function splitPathEntries(
  pathValue: string | undefined,
  platform: WalkPlatform = currentWalkPlatform()
): string[] {
  if (!pathValue) return []
  const delimiter = platform === 'win32' ? ';' : ':'
  const seen = new Set<string>()
  const out: string[] = []
  for (const raw of pathValue.split(delimiter)) {
    const entry = platform === 'win32' ? raw.trim().replace(/^"|"$/g, '') : raw.trim()
    if (!entry || seen.has(entry)) continue
    seen.add(entry)
    out.push(entry)
  }
  return out
}

/**
 * Whether `bin` is a bare executable name. Anything carrying a separator or a
 * `..` segment is refused rather than resolved — callers only ever look up
 * names from a fixed allowlist, so a path here means something went wrong.
 */
export function isBareBinaryName(bin: string): boolean {
  if (!bin || bin.length > 64) return false
  return /^[A-Za-z0-9._+-]+$/.test(bin) && bin !== '.' && bin !== '..'
}

/**
 * Every absolute candidate path for `bin`, in the order PATH prescribes. On
 * Windows each directory yields the bare name plus one candidate per `PATHEXT`
 * extension, unless the name already carries one of them.
 */
export function executableCandidates(
  bin: string,
  entries: readonly string[],
  options: { platform?: WalkPlatform; pathExt?: string } = {}
): string[] {
  const platform = options.platform ?? currentWalkPlatform()
  if (!isBareBinaryName(bin)) return []
  const p = pathModule(platform)

  const extensions =
    platform === 'win32'
      ? (options.pathExt ?? DEFAULT_PATHEXT)
          .split(';')
          .map((e) => e.trim())
          .filter(Boolean)
      : []
  const alreadyExtended =
    extensions.length > 0 &&
    extensions.some((ext) => bin.toLowerCase().endsWith(ext.toLowerCase()))

  const out: string[] = []
  for (const dir of entries) {
    if (!p.isAbsolute(dir)) continue
    const base = p.join(dir, bin)
    if (platform !== 'win32' || alreadyExtended) {
      out.push(base)
      continue
    }
    out.push(base)
    for (const ext of extensions) out.push(base + ext)
  }
  return out
}

/**
 * Walk the candidates and return the first one `isExecutable` accepts. The
 * probe is injected so the walk stays testable without touching the disk.
 */
export async function findExecutable(
  bin: string,
  entries: readonly string[],
  isExecutable: (candidate: string) => Promise<boolean>,
  options: { platform?: WalkPlatform; pathExt?: string } = {}
): Promise<string | null> {
  for (const candidate of executableCandidates(bin, entries, options)) {
    if (await isExecutable(candidate)) return candidate
  }
  return null
}
