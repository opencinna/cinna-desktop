/**
 * What publishing a file or folder would send (artifacts A10, A11): a walk
 * that never follows a symlink, drops what must never leave the machine, and
 * stops counting once a limit is passed.
 *
 * Pure apart from reading the file system: no profile, no network, no
 * Electron. Called again at publish, so what is zipped is what is on disk
 * then, not what the dialog showed.
 */

import { lstatSync, readdirSync, type Dirent } from 'node:fs'
import { basename, join } from 'node:path'
import type {
  ArtifactKind,
  ArtifactLimits,
  ArtifactOverLimits,
  ExcludedEntry,
  ExclusionReason,
  InspectedFile
} from '../../../shared/artifacts'

/** A kept file, with where to read it. */
export interface InspectedSource extends InspectedFile {
  abs: string
}

export interface InspectResult {
  name: string
  isFolder: boolean
  files: InspectedSource[]
  excluded: ExcludedEntry[]
  size: number
  overLimits: ArtifactOverLimits | null
  kind: ArtifactKind
  entry: string | null
  entryCandidates: string[]
}

/** Files over the per-file limit named in the result; the rest are only counted. */
const MAX_NAMED_OVERSIZED = 5

const DIRECTORY_RULES: Record<string, ExclusionReason> = {
  '.git': 'git data',
  credentials: 'credentials',
  'app-data': 'app data',
  '.claude': 'agent settings',
  node_modules: 'dependencies'
}

/** Why `name` is never published, or null. A10, as core applies it. */
export function exclusionFor(name: string, isDirectory: boolean): ExclusionReason | null {
  if (name === '.git') return 'git data'
  if (name.startsWith('.env')) return 'secret file'
  // Dot-named entries are left out as core's skill tells agents they are, and
  // a dot-named path is refused as core's agent route refuses it.
  if (isDirectory) return DIRECTORY_RULES[name] ?? (name.startsWith('.') ? 'hidden file' : null)
  const lower = name.toLowerCase()
  if (lower.endsWith('.pem') || lower.endsWith('.key')) return 'secret file'
  if (name === '.DS_Store') return 'system file'
  if (name.startsWith('.')) return 'hidden file'
  return null
}

export function isHtmlPath(path: string): boolean {
  return /\.html?$/i.test(path)
}

/**
 * The kind core will decide for these files: a chosen entry makes a site;
 * else a root `index.html`; else a lone `.html` file. Otherwise files.
 */
export function decideKind(
  paths: readonly string[],
  chosenEntry: string | null
): { kind: ArtifactKind; entry: string | null; entryCandidates: string[] } {
  const html = paths.filter(isHtmlPath)
  if (paths.includes('index.html')) return { kind: 'site', entry: 'index.html', entryCandidates: [] }
  if (paths.length === 1 && html.length === 1) return { kind: 'site', entry: html[0], entryCandidates: [] }
  const entryCandidates = [...html].sort((a, b) => a.localeCompare(b))
  if (chosenEntry && entryCandidates.includes(chosenEntry)) return { kind: 'site', entry: chosenEntry, entryCandidates }
  return { kind: 'files', entry: null, entryCandidates }
}

/**
 * Walk `root` (a realpath). A folder at any depth matching an A10 rule is one
 * excluded row ending in `/`, never walked; a symlink is listed and never
 * followed; once the file count or the total passes its limit the walk stops.
 *
 * @throws when `root` or a folder inside it cannot be read.
 */
export function inspectArtifactPath(root: string, limits: ArtifactLimits, chosenEntry: string | null = null): InspectResult {
  const name = basename(root)
  const rootInfo = lstatSync(root)
  const files: InspectedSource[] = []
  const excluded: ExcludedEntry[] = []
  const oversized: string[] = []
  let oversizedCount = 0
  let size = 0
  let tooMany = false
  let tooBig = false

  const keep = (rel: string, abs: string, bytes: number): void => {
    files.push({ path: rel, abs, size: bytes })
    size += bytes
    if (bytes > limits.maxFileBytes) {
      oversizedCount += 1
      if (oversized.length < MAX_NAMED_OVERSIZED) oversized.push(rel)
    }
    if (files.length > limits.maxRevisionFiles) tooMany = true
    if (size > limits.maxRevisionBytes) tooBig = true
  }

  if (rootInfo.isSymbolicLink()) {
    excluded.push({ path: name, reason: 'symlink' })
  } else if (rootInfo.isFile()) {
    const reason = exclusionFor(name, false)
    if (reason) excluded.push({ path: name, reason })
    else keep(name, root, rootInfo.size)
  } else if (rootInfo.isDirectory()) {
    const reason = exclusionFor(name, true)
    if (reason) {
      excluded.push({ path: `${name}/`, reason })
    } else {
      const walk = (dir: string, prefix: string): void => {
        const entries: Dirent[] = readdirSync(dir, { withFileTypes: true })
        entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))
        for (const entry of entries) {
          if (tooMany || tooBig) return
          const abs = join(dir, entry.name)
          const rel = prefix ? `${prefix}/${entry.name}` : entry.name
          // lstat, never stat: a symlink is reported, not followed.
          const info = lstatSync(abs)
          if (info.isSymbolicLink()) {
            excluded.push({ path: rel, reason: 'symlink' })
          } else if (info.isDirectory()) {
            const why = exclusionFor(entry.name, true)
            if (why) excluded.push({ path: `${rel}/`, reason: why })
            else walk(abs, rel)
          } else if (info.isFile()) {
            const why = exclusionFor(entry.name, false)
            if (why) excluded.push({ path: rel, reason: why })
            else keep(rel, abs, info.size)
          } else {
            excluded.push({ path: rel, reason: 'not a file' })
          }
        }
      }
      walk(root, '')
    }
  } else {
    excluded.push({ path: name, reason: 'not a file' })
  }

  const overLimits: ArtifactOverLimits | null =
    tooMany || tooBig || oversizedCount > 0 ? { files: tooMany, size: tooBig, perFile: oversized } : null
  const decided = rootInfo.isDirectory()
    ? decideKind(files.map((file) => file.path), chosenEntry)
    : files.length === 1 && isHtmlPath(name)
      ? { kind: 'site' as const, entry: name, entryCandidates: [] }
      : { kind: 'files' as const, entry: null, entryCandidates: [] }
  return { name, isFolder: rootInfo.isDirectory(), files, excluded, size, overLimits, ...decided }
}
