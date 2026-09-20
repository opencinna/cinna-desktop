import { realpathSync } from 'node:fs'
import { homedir } from 'node:os'
import { basename, parse, relative, resolve, sep } from 'node:path'
import { isWithin } from '../localAgents/pathRules'
import type { AgentFileRefKind } from '../../../shared/agentFiles'
import { createPathCanonicalizer, type PathCanonicalizer } from './canonicalPath'

/** What the user is asked before Cinna reads, opens or reveals a path outside an agent folder. */
export interface ConsentRequest {
  agentName: string
  kind: AgentFileRefKind
  /** The canonical realpath that will be acted on. */
  path: string
  /** The folder a "don't ask again" would cover. */
  dir: string
  /** {@link path} as the user reads it: `~/…` under the home, else absolute. */
  displayPath: string
  /** {@link dir} shown the same way. */
  displayDir: string
  /** Whether that folder may be approved at all (see {@link canApproveDirectory}). */
  offerDir: boolean
  /** A file Cinna would read to preview: a previewable type that is not a credential file. */
  previewable: boolean
}

export interface ConsentAnswer {
  approved: boolean
  rememberDir: boolean
}

/** Injected so the service is testable; the IPC layer backs it with a native dialog. */
export type ConsentPrompt = (request: ConsentRequest) => Promise<ConsentAnswer>

/** Mount parents and how many levels below them a volume's root sits. */
const VOLUME_ROOT_DEPTH: ReadonlyArray<[string, number]> = [
  ['/Volumes', 1],
  ['/mnt', 1],
  ['/media', 2],
  ['/run/media', 2]
]

const defaultPaths = createPathCanonicalizer()

function homes(paths: PathCanonicalizer = defaultPaths): string[] {
  const home = resolve(homedir())
  const out = new Set([home, paths.canonicalSync(home)])
  try {
    const real = realpathSync(home)
    out.add(real)
    out.add(paths.canonicalSync(real))
  } catch {
    // A missing home still refuses its own spelling.
  }
  return [...out]
}

/**
 * Whether a whole folder may be approved. Refused: the home, any folder that
 * contains it (`/Users`), the filesystem root and a volume root — approving
 * one would approve nearly everything.
 *
 * Checked on the canonical spelling and, erring towards refusing, on the
 * spelling without a data-volume prefix, so `/System/Volumes/Data/Users/me`
 * is refused like `/Users/me`.
 */
export function canApproveDirectory(
  dir: string,
  homeDirs: readonly string[] = homes(),
  paths: PathCanonicalizer = defaultPaths
): boolean {
  const resolved = resolve(dir)
  const spellings = new Set([paths.canonicalSync(resolved), paths.lexical(resolved)])
  const homeSpellings = homeDirs.flatMap((home) => {
    const spelled = resolve(home)
    return [spelled, paths.canonicalSync(spelled), paths.lexical(spelled)]
  })
  for (const target of spellings) {
    if (homeSpellings.some((home) => isWithin(target, home))) return false
    if (parse(target).root === target) return false
    for (const [parent, depth] of VOLUME_ROOT_DEPTH) {
      if (!isWithin(parent, target)) continue
      const below = relative(parent, target).split(sep).filter(Boolean).length
      if (below <= depth) return false
    }
  }
  return true
}

/**
 * Approvals for paths outside an agent folder, **in memory only** — they end
 * when Cinna quits and are never persisted. Keyed by the profile-scope user,
 * so switching profile does not carry another person's approvals across.
 * Paths are canonical realpaths; a folder approval covers everything under it.
 */
export function createConsentRegistry(
  options: { homeDirs?: () => readonly string[]; paths?: PathCanonicalizer } = {}
) {
  const paths = options.paths ?? defaultPaths
  const homeDirs = options.homeDirs ?? (() => homes(paths))
  const canonical = (path: string): string => paths.canonicalSync(resolve(path))
  const byUser = new Map<string, { files: Set<string>; dirs: Set<string> }>()
  const entry = (userId: string): { files: Set<string>; dirs: Set<string> } => {
    let found = byUser.get(userId)
    if (!found) {
      found = { files: new Set(), dirs: new Set() }
      byUser.set(userId, found)
    }
    return found
  }

  return {
    isApproved(userId: string, realPath: string): boolean {
      const found = byUser.get(userId)
      if (!found) return false
      const path = canonical(realPath)
      if (found.files.has(path)) return true
      for (const dir of found.dirs) if (isWithin(dir, path)) return true
      return false
    },

    approvePath(userId: string, realPath: string): void {
      entry(userId).files.add(canonical(realPath))
    },

    /** Returns false, approving nothing, for a folder {@link canApproveDirectory} refuses. */
    approveDirectory(userId: string, dir: string): boolean {
      if (!canApproveDirectory(dir, homeDirs(), paths)) return false
      entry(userId).dirs.add(canonical(dir))
      return true
    },

    canApproveDirectory(dir: string): boolean {
      return canApproveDirectory(dir, homeDirs(), paths)
    }
  }
}

export type ConsentRegistry = ReturnType<typeof createConsentRegistry>

/**
 * The native dialog for a {@link ConsentRequest}: button 0 shows, 1 cancels.
 * Worded for what a click does — a folder is only shown in the file manager,
 * a file is shown, and read only when it can be previewed.
 */
export function consentDialogOptions(
  request: ConsentRequest,
  platform: NodeJS.Platform = process.platform
): ConsentDialogOptions {
  const folder = request.kind === 'dir'
  const showButton = folder ? (platform === 'darwin' ? 'Show in Finder' : 'Show in folder') : 'Show file'
  const detail = [request.displayPath]
  if (!folder && request.previewable) detail.push('', 'Cinna reads it to preview it here.')
  // For a folder the covered folder is the path already shown: say it once.
  if (request.offerDir && request.displayDir !== request.displayPath) {
    detail.push('', `Folder: ${request.displayDir}`)
  }
  return {
    type: 'question',
    buttons: [showButton, 'Cancel'],
    defaultId: 0,
    cancelId: 1,
    message: `Show a ${folder ? 'folder' : 'file'} outside ${request.agentName}'s folder?`,
    detail: detail.join('\n'),
    ...(request.offerDir
      ? {
          checkboxLabel: `Don't ask again for anything inside “${basename(request.dir)}” until Cinna restarts`,
          checkboxChecked: false
        }
      : {})
  }
}

/** Native-dialog data, independent of any window toolkit. */
export interface ConsentDialogOptions {
  type: 'question'
  buttons: string[]
  defaultId: number
  cancelId: number
  message: string
  detail: string
  checkboxLabel?: string
  checkboxChecked?: boolean
}
