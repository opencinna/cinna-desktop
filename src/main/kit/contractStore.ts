/**
 * Resolves the **active kit contract** — the tree under
 * `resources/cinna-kit-contract/` that says what an agent folder is: the
 * manifest schema, the folder model (`layout.json`) and the templates a
 * scaffold copies.
 *
 * Two copies can exist:
 *
 * * the one bundled with the app, always present;
 * * a `.cinna-kit/` inside a workshop, which a contract refresh may have pulled
 *   from a linked Cinna instance.
 *
 * The workshop copy wins only when its **major matches** the bundled one and its
 * version is newer — a newer major means the app itself is out of date, and
 * running a folder against a contract this build does not understand is exactly
 * what the version gate exists to prevent (see `shared/kit/contractVersion.ts`).
 *
 * Everything is cached per workshop; `clearContractCache()` drops the cache
 * after a refresh swaps the tree.
 */

import { app } from 'electron'
import { existsSync, readFileSync } from 'node:fs'
import { isAbsolute, join, normalize, resolve, sep } from 'node:path'
import { KitError } from '../errors'
import { createLogger } from '../logger/logger'
import { compareSemver, parseSemver } from '../../shared/kit/contractVersion'
import { createLayoutView, parseLayout, type KitLayout, type LayoutView } from './layout'

const logger = createLogger('kit-contract')

/** Folder name of the bundled contract inside `resources/`. */
const CONTRACT_DIR = 'cinna-kit-contract'
/** Folder a workshop keeps its own copy of the contract in. */
const WORKSHOP_KIT_DIR = '.cinna-kit'

const KIT_JSON = 'kit.json'
const VERSION_FILE = 'VERSION'
const SCHEMA_FILE = 'schema/cinna-agent.schema.json'
const LAYOUT_FILE = 'layout.json'
const TEMPLATES_DIR = 'templates'

export type ContractSource = 'bundled' | 'workshop'

export interface ResolvedContract {
  /** Absolute path of the contract tree in use. */
  root: string
  /** Its `contract_version`. */
  version: string
  source: ContractSource
}

/** `templates/agent/` scaffolds an agent; `templates/root/` a workshop root. */
export type TemplateKind = 'agent' | 'root'

interface ContractCacheEntry {
  contract: ResolvedContract
  schema?: unknown
  layout?: KitLayout
  layoutView?: LayoutView
}

const cache = new Map<string, ContractCacheEntry>()

/**
 * Where the bundled contract sits.
 *
 * The contract is read as a *tree* — the schema, `layout.json`, and the
 * templates the scaffolder copies file by file — so electron-vite's `?asset`
 * import (what `appIconService` uses for single images) does not apply. It ships
 * through `extraResources` in `electron-builder.yml` instead, which puts it at a
 * stable path beside the asar.
 *
 * Resolved lazily: this module must be importable before `app.whenReady()`.
 *
 * **Packaging note — read before changing `electron-builder.yml`.** Three
 * entries there work together, and changing one alone breaks this function:
 *
 * * `extraResources` copies the tree to `Resources/cinna-kit-contract`, which is
 *   the packaged path below. A real directory, no asar shim in the read path.
 * * `files` excludes `resources/cinna-kit-contract/**` **on purpose**, so the
 *   tree is not also packed into `app.asar` and unpacked again by `asarUnpack:
 *   resources/**` (which is there for the icon PNGs). Without the exclusion it
 *   would ship twice.
 * * In development nothing is packaged at all: the tree is read straight from
 *   the repo at `<repo>/resources/cinna-kit-contract`.
 *
 * If you ever drop `extraResources`, the packaged path would have to rely on
 * Electron redirecting asar reads to `app.asar.unpacked` — documented behaviour,
 * but nothing here verifies it, so prefer the explicit copy.
 *
 * The dev branch is covered by `contractStore.test.ts`; the packaged branch is
 * not, and cannot be until someone builds and inspects a package.
 */
function bundledContractDir(): string {
  return app.isPackaged
    ? join(process.resourcesPath, CONTRACT_DIR)
    : join(app.getAppPath(), 'resources', CONTRACT_DIR)
}

function isContractTree(root: string): boolean {
  return existsSync(join(root, KIT_JSON)) && existsSync(join(root, LAYOUT_FILE))
}

let loggedBundledRoot = false

/**
 * Absolute path of the contract bundled with this build.
 *
 * @throws KitError `contract_missing` when the tree is not where it should be —
 *   a packaging mistake, and worth failing loudly rather than scaffolding
 *   half a folder.
 */
export function getBundledContractDir(): string {
  const root = bundledContractDir()
  if (!isContractTree(root)) {
    logger.error('bundled kit contract not found', { root, packaged: app.isPackaged })
    throw new KitError(
      'contract_missing',
      'The bundled agent contract is missing from this installation.',
      root
    )
  }
  if (!loggedBundledRoot) {
    logger.debug('bundled kit contract resolved', { root, packaged: app.isPackaged })
    loggedBundledRoot = true
  }
  return root
}

function readVersionAt(root: string): string | null {
  // kit.json is the authority: a workshop's `.cinna-kit/VERSION` may hold the
  // *kit* version when the full kit is installed there, not the contract's.
  try {
    const kit = JSON.parse(readFileSync(join(root, KIT_JSON), 'utf8')) as Record<string, unknown>
    if (typeof kit.contract_version === 'string') return kit.contract_version
  } catch {
    /* fall through to VERSION */
  }
  try {
    const version = readFileSync(join(root, VERSION_FILE), 'utf8').trim()
    return version === '' ? null : version
  } catch {
    return null
  }
}

function resolveBundled(): ResolvedContract {
  const root = getBundledContractDir()
  const version = readVersionAt(root)
  if (!version) {
    throw new KitError('contract_unreadable', 'The bundled agent contract has no version.', root)
  }
  return { root, version, source: 'bundled' }
}

/**
 * The contract to use for a workshop. Without a workshop root, the bundled one.
 *
 * @param workshopRoot absolute path of a workshop that may carry `.cinna-kit/`
 */
export function resolveContract(workshopRoot?: string): ResolvedContract {
  const key = workshopRoot ?? ''
  const cached = cache.get(key)
  if (cached) return cached.contract

  const bundled = resolveBundled()
  let chosen = bundled

  if (workshopRoot) {
    const workshopContract = join(workshopRoot, WORKSHOP_KIT_DIR)
    const version = isContractTree(workshopContract) ? readVersionAt(workshopContract) : null
    const theirs = parseSemver(version)
    const ours = parseSemver(bundled.version)
    if (theirs && ours && theirs.major === ours.major && compareSemver(theirs, ours) > 0) {
      chosen = { root: workshopContract, version: theirs.raw, source: 'workshop' }
      logger.info('using the workshop contract copy', {
        workshopRoot,
        workshop: theirs.raw,
        bundled: bundled.version
      })
    } else if (theirs && ours && theirs.major > ours.major) {
      // Deliberately not adopted: the gate reports `app_too_old` per agent.
      logger.warn('workshop contract has a newer major; keeping the bundled one', {
        workshopRoot,
        workshop: theirs.raw,
        bundled: bundled.version
      })
    }
  }

  cache.set(key, { contract: chosen })
  return chosen
}

/** Drop the resolution cache — call after a refresh swaps a contract tree. */
export function clearContractCache(): void {
  cache.clear()
}

function entry(workshopRoot?: string): ContractCacheEntry {
  const key = workshopRoot ?? ''
  resolveContract(workshopRoot)
  return cache.get(key) as ContractCacheEntry
}

/**
 * Read a file from the active contract.
 *
 * @param relPath contract-relative POSIX path, e.g. `templates/agent/Makefile`
 * @throws KitError `invalid_path` for anything that escapes the tree,
 *   `contract_unreadable` when the file cannot be read.
 */
export function readContractFile(relPath: string, workshopRoot?: string): string {
  const contract = resolveContract(workshopRoot)
  const normalized = normalize(relPath).replace(/^[/\\]+/, '')
  if (isAbsolute(relPath) || normalized === '..' || normalized.startsWith(`..${sep}`)) {
    throw new KitError('invalid_path', 'That path is outside the agent contract.', relPath)
  }
  const target = resolve(contract.root, normalized)
  if (target !== contract.root && !target.startsWith(contract.root + sep)) {
    throw new KitError('invalid_path', 'That path is outside the agent contract.', relPath)
  }
  try {
    return readFileSync(target, 'utf8')
  } catch (err) {
    logger.error('failed to read a contract file', { relPath, error: err })
    throw new KitError(
      'contract_unreadable',
      `Could not read ${relPath} from the agent contract.`,
      `${target}: ${err instanceof Error ? err.message : String(err)}`
    )
  }
}

/** `contract_version` of the active contract. */
export function getContractVersion(workshopRoot?: string): string {
  return resolveContract(workshopRoot).version
}

/**
 * The parsed `schema/cinna-agent.schema.json`. Kept as data: the validator is a
 * hand-written port of the schema's rules (no JSON-schema library in this app),
 * and this is what the app ships to anything that wants the schema itself.
 */
export function getSchema(workshopRoot?: string): unknown {
  const cached = entry(workshopRoot)
  if (cached.schema === undefined) {
    try {
      cached.schema = JSON.parse(readContractFile(SCHEMA_FILE, workshopRoot))
    } catch (err) {
      if (err instanceof KitError) throw err
      throw new KitError(
        'contract_unreadable',
        'The agent contract schema is not valid JSON.',
        err instanceof Error ? err.message : String(err)
      )
    }
  }
  return cached.schema
}

/** The parsed `layout.json` — the folder model as data. */
export function getLayout(workshopRoot?: string): KitLayout {
  const cached = entry(workshopRoot)
  if (!cached.layout) {
    let raw: unknown
    try {
      raw = JSON.parse(readContractFile(LAYOUT_FILE, workshopRoot))
    } catch (err) {
      if (err instanceof KitError) throw err
      throw new KitError(
        'contract_unreadable',
        'The agent contract layout is not valid JSON.',
        err instanceof Error ? err.message : String(err)
      )
    }
    cached.layout = parseLayout(raw)
  }
  return cached.layout
}

/** The layout with its lookups bound — what the validator and export take. */
export function getLayoutView(workshopRoot?: string): LayoutView {
  const cached = entry(workshopRoot)
  if (!cached.layoutView) {
    cached.layoutView = createLayoutView(getLayout(workshopRoot))
  }
  return cached.layoutView
}

/** Absolute path of a template tree the scaffolder copies from. */
export function getTemplateRoot(kind: TemplateKind = 'agent', workshopRoot?: string): string {
  return join(resolveContract(workshopRoot).root, TEMPLATES_DIR, kind)
}
