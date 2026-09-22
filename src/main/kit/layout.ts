/**
 * Typed access to the contract's `layout.json` — the folder model as data.
 *
 * Nothing here reads the filesystem or Electron: a caller hands in the parsed
 * document (`contractStore.getLayout()`) and gets a view over it. That keeps the
 * rules in one place — the contract — and keeps this module testable.
 */

import { createLogger } from '../logger/logger'

const logger = createLogger('kit-layout')

export interface LayoutRole {
  /** Path relative to the workshop root (workshop roles) or the agent root. */
  path: string
  kind: 'file' | 'directory'
  role: string
  description: string
  /** False when a contract refresh may replace this path wholesale. */
  survives_update: boolean
}

export interface LayoutCommandRule {
  id: string
  match: { type: 'prefix'; value: string }
  replace_with: string
  when?: { file_exists?: string }
}

/**
 * One rule of `layout.json`'s `secret_files`, **kept exactly as declared**: a
 * path is secret when a clause of `match` hits its basename and no clause of
 * `unless` does. Not narrowed at parse time on purpose — an entry this build
 * cannot read has to reach {@link isSecretByRules}, which treats it as secret;
 * filtering it out here would switch that fail-safe off one function early
 * (cinna-cli's `secret_file_rules` makes the same choice).
 */
export type SecretFileRule = unknown

/**
 * The dotenv rule built in, used when a layout declares no usable
 * `secret_files.rules` — the same fallback cinna-cli's `kit_contract.py` has.
 */
export const DEFAULT_SECRET_FILE_RULES: readonly SecretFileRule[] = [
  {
    id: 'dotenv',
    match: { basename_equals: ['.env'], basename_prefix: ['.env.'], basename_suffix: ['.env'] },
    unless: { basename_suffix: ['.example', '.sample', '.template'] }
  }
]

/** `[path in the template tree, path in the created folder]`. */
export type ScaffoldIgnorePair = readonly [string, string]

export interface KitLayout {
  contract_version?: string
  workshop: {
    kit_dir: string
    agents_dir: string
    cloud_dir: string
    root_files: string[]
    roles: LayoutRole[]
  }
  agent: {
    manifest: string
    prompt_files: { workflow?: string; entrypoint?: string; refiner?: string }
    command_catalog: string
    status_file: string
    roles: LayoutRole[]
  }
  scaffold_ignore_files: { agent: ScaffoldIgnorePair[]; root: ScaffoldIgnorePair[] }
  desktop_owned: string[]
  cloud_import_excludes: string[]
  /** `secret_files.rules` — the authority for what holds a credential value. */
  secret_files: SecretFileRule[]
  local_command_runner: { description?: string; rules: LayoutCommandRule[] }
}

/** Conditions `localizeCommand` can evaluate without touching the filesystem. */
export interface LocalCommandContext {
  /** Whether the agent folder has a `pyproject.toml`. */
  hasPyproject: boolean
}

export interface LayoutView {
  readonly layout: KitLayout
  /** Roles of the agent folder, most specific path first. */
  agentRoles(): LayoutRole[]
  /** Roles of the workshop root, most specific path first. */
  workshopRoles(): LayoutRole[]
  /** The agent-folder role covering a path, or `null` when none does. */
  roleFor(relPath: string): LayoutRole | null
  /**
   * True when this agent-relative path never travels: the cloud-import exclude
   * list drops it, or `secret_files` says it can hold a credential value.
   */
  isExcludedFromExport(relPath: string): boolean
  /** True when the contract's `secret_files` rules call this path secret. */
  isSecretFile(relPath: string): boolean
  /**
   * True when a contract refresh must leave this path alone. Unknown paths
   * survive: a refresh never removes something the contract does not claim.
   */
  survivesUpdate(relPath: string): boolean
  /** Rewrite a cloud-first command for local execution. */
  localizeCommand(command: string, context: LocalCommandContext): string
  /**
   * Dotless ignore files a scaffold must restore the dot on, for one template
   * tree. Read this instead of hard-coding the pairs — the set has grown once
   * already (`app-data/cache/gitignore`) and a scaffolder that missed it left a
   * cache folder tracked by git.
   */
  scaffoldIgnoreFiles(kind: 'agent' | 'root'): ScaffoldIgnorePair[]
  /** Paths in an agent folder Cinna Desktop owns. */
  desktopOwned(): string[]
}

const EMPTY_LAYOUT: KitLayout = {
  workshop: {
    kit_dir: '.cinna-kit',
    agents_dir: 'Local',
    cloud_dir: 'Cloud',
    root_files: [],
    roles: []
  },
  agent: {
    manifest: 'cinna-agent.json',
    prompt_files: {},
    command_catalog: 'docs/CLI_COMMANDS.yaml',
    status_file: 'app-data/storage/STATUS.md',
    roles: []
  },
  scaffold_ignore_files: { agent: [], root: [] },
  desktop_owned: [],
  cloud_import_excludes: [],
  secret_files: [...DEFAULT_SECRET_FILE_RULES],
  local_command_runner: { rules: [] }
}

function asRecord(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {}
}

function asStringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((v): v is string => typeof v === 'string') : []
}

/** Normalize to a POSIX, root-relative path with no `./` or trailing slash. */
export function normalizeRelPath(relPath: string): string {
  return relPath
    .replace(/\\/g, '/')
    .replace(/^\.\//, '')
    .replace(/^\/+/, '')
    .replace(/\/+$/, '')
}

function parseRoles(value: unknown): LayoutRole[] {
  if (!Array.isArray(value)) return []
  const roles: LayoutRole[] = []
  for (const raw of value) {
    const entry = asRecord(raw)
    if (typeof entry.path !== 'string' || entry.path === '') continue
    roles.push({
      path: normalizeRelPath(entry.path),
      kind: entry.kind === 'file' ? 'file' : 'directory',
      role: typeof entry.role === 'string' ? entry.role : 'unknown',
      description: typeof entry.description === 'string' ? entry.description : '',
      survives_update: entry.survives_update !== false
    })
  }
  // Longest path first, so a lookup can take the first hit as the most specific.
  return roles.sort((a, b) => b.path.length - a.path.length)
}

function parseIgnorePairs(value: unknown): ScaffoldIgnorePair[] {
  if (!Array.isArray(value)) return []
  const pairs: ScaffoldIgnorePair[] = []
  for (const raw of value) {
    if (!Array.isArray(raw) || raw.length !== 2) continue
    const [from, to] = raw
    if (typeof from === 'string' && typeof to === 'string' && from !== '' && to !== '') {
      pairs.push([normalizeRelPath(from), normalizeRelPath(to)] as const)
    }
  }
  return pairs
}

function parseCommandRules(value: unknown): LayoutCommandRule[] {
  if (!Array.isArray(value)) return []
  const rules: LayoutCommandRule[] = []
  for (const raw of value) {
    const entry = asRecord(raw)
    const match = asRecord(entry.match)
    if (match.type !== 'prefix' || typeof match.value !== 'string') continue
    if (typeof entry.replace_with !== 'string') continue
    const when = asRecord(entry.when)
    rules.push({
      id: typeof entry.id === 'string' ? entry.id : match.value,
      match: { type: 'prefix', value: match.value },
      replace_with: entry.replace_with,
      when: typeof when.file_exists === 'string' ? { file_exists: when.file_exists } : undefined
    })
  }
  return rules
}

/**
 * Read a parsed `layout.json` into the typed shape, filling in defaults for
 * anything missing. Never throws: a malformed contract degrades to a layout
 * with no rules rather than taking the app down, and says so in the log.
 */
export function parseLayout(raw: unknown): KitLayout {
  const doc = asRecord(raw)
  if (Object.keys(doc).length === 0) {
    logger.warn('layout.json is empty or not an object; falling back to an empty layout')
    return EMPTY_LAYOUT
  }
  const workshop = asRecord(doc.workshop)
  const agent = asRecord(doc.agent)
  const prompts = asRecord(agent.prompt_files)
  const runner = asRecord(doc.local_command_runner)

  return {
    contract_version: typeof doc.contract_version === 'string' ? doc.contract_version : undefined,
    workshop: {
      kit_dir:
        typeof workshop.kit_dir === 'string' ? workshop.kit_dir : EMPTY_LAYOUT.workshop.kit_dir,
      agents_dir:
        typeof workshop.agents_dir === 'string'
          ? workshop.agents_dir
          : EMPTY_LAYOUT.workshop.agents_dir,
      cloud_dir:
        typeof workshop.cloud_dir === 'string' ? workshop.cloud_dir : EMPTY_LAYOUT.workshop.cloud_dir,
      root_files: asStringArray(workshop.root_files),
      roles: parseRoles(workshop.roles)
    },
    agent: {
      manifest: typeof agent.manifest === 'string' ? agent.manifest : EMPTY_LAYOUT.agent.manifest,
      prompt_files: {
        workflow: typeof prompts.workflow === 'string' ? prompts.workflow : undefined,
        entrypoint: typeof prompts.entrypoint === 'string' ? prompts.entrypoint : undefined,
        refiner: typeof prompts.refiner === 'string' ? prompts.refiner : undefined
      },
      command_catalog:
        typeof agent.command_catalog === 'string'
          ? agent.command_catalog
          : EMPTY_LAYOUT.agent.command_catalog,
      status_file:
        typeof agent.status_file === 'string' ? agent.status_file : EMPTY_LAYOUT.agent.status_file,
      roles: parseRoles(agent.roles)
    },
    scaffold_ignore_files: {
      agent: parseIgnorePairs(asRecord(doc.scaffold_ignore_files).agent),
      root: parseIgnorePairs(asRecord(doc.scaffold_ignore_files).root)
    },
    desktop_owned: asStringArray(doc.desktop_owned).map(normalizeRelPath),
    cloud_import_excludes: asStringArray(doc.cloud_import_excludes),
    secret_files: parseSecretRules(asRecord(doc.secret_files).rules),
    local_command_runner: {
      description: typeof runner.description === 'string' ? runner.description : undefined,
      rules: parseCommandRules(runner.rules)
    }
  }
}

/**
 * `secret_files.rules` as declared, or the built-in dotenv rule when the block,
 * or its `rules`, is missing, not an array, or empty.
 */
function parseSecretRules(value: unknown): SecretFileRule[] {
  return Array.isArray(value) && value.length > 0 ? [...value] : [...DEFAULT_SECRET_FILE_RULES]
}

const SECRET_CLAUSE_TESTS: Record<string, (name: string, value: string) => boolean> = {
  basename_equals: (name, value) => name === value,
  basename_prefix: (name, value) => name.startsWith(value),
  basename_suffix: (name, value) => name.endsWith(value)
}

/**
 * Does any test in one `match` / `unless` clause fire for this basename?
 *
 * `onUnknown` is the fail-safe direction, which differs by position: an
 * unevaluable `match` counts as a hit, an unevaluable `unless` as a miss, so
 * both resolve toward "secret". "Unevaluable" is broad, as in cinna-cli's
 * `_secret_clause_hits`, which this mirrors key for key: an absent clause, one
 * that is not an object, an empty one, an unknown key, or a known key with no
 * usable (non-empty string) value.
 */
function secretClauseHits(name: string, clause: unknown, onUnknown: boolean): boolean {
  if (clause === null || typeof clause !== 'object' || Array.isArray(clause)) return onUnknown
  const entries = Object.entries(clause as Record<string, unknown>)
  if (entries.length === 0) return onUnknown
  for (const [key, raw] of entries) {
    const test = Object.hasOwn(SECRET_CLAUSE_TESTS, key) ? SECRET_CLAUSE_TESTS[key] : undefined
    if (test === undefined) return onUnknown
    const values = typeof raw === 'string' ? [raw] : raw
    const usable = Array.isArray(values)
      ? values.filter((value): value is string => typeof value === 'string' && value !== '')
      : []
    if (usable.length === 0) return onUnknown
    if (usable.some((value) => test(name, value))) return true
  }
  return false
}

/**
 * `secret_files`, as the contract states it: clauses test the basename at any
 * depth, rules OR together, and anything this build cannot evaluate fails safe
 * — a rule that is not an object is secret outright, and see
 * {@link secretClauseHits} for clauses. Same answers as cinna-cli's
 * `is_secret_filename`.
 */
export function isSecretByRules(rules: readonly SecretFileRule[], relPath: string): boolean {
  const path = normalizeRelPath(relPath)
  if (path === '') return false
  const name = path.slice(path.lastIndexOf('/') + 1)
  return rules.some((rule) => {
    if (rule === null || typeof rule !== 'object' || Array.isArray(rule)) return true
    const { match, unless } = rule as { match?: unknown; unless?: unknown }
    if (!secretClauseHits(name, match, true)) return false
    return !secretClauseHits(name, unless, false)
  })
}

/** Match one segment of a pattern against one path segment (`*` and `?`). */
function matchSegment(pattern: string, segment: string): boolean {
  if (pattern === '*') return true
  const source = pattern
    .replace(/[.+^${}()|[\]\\]/g, '\\$&')
    .replace(/\*/g, '[^/]*')
    .replace(/\?/g, '[^/]')
  return new RegExp(`^${source}$`).test(segment)
}

function matchSegments(pattern: string[], path: string[]): boolean {
  if (pattern.length === 0) return path.length === 0
  if (pattern[0] === '**') {
    const rest = pattern.slice(1)
    for (let skip = 0; skip <= path.length; skip++) {
      if (matchSegments(rest, path.slice(skip))) return true
    }
    return false
  }
  if (path.length === 0) return false
  return matchSegment(pattern[0], path[0]) && matchSegments(pattern.slice(1), path.slice(1))
}

/**
 * Match one exclude pattern against a root-relative POSIX path, with the
 * semantics `layout.json`'s `cloud_import_excludes_notes` documents: a trailing
 * slash excludes a directory and everything under it; a star matches within one
 * segment and a double star across segments; a pattern is anchored at the root
 * unless it opens with a double star.
 */
export function matchesPattern(pattern: string, relPath: string): boolean {
  const path = normalizeRelPath(relPath)
  const body = normalizeRelPath(pattern)
  if (body === '' || path === '') return false

  const patternSegments = body.split('/')
  const pathSegments = path.split('/')

  if (pattern.trimEnd().endsWith('/')) {
    // Directory pattern: the path is the directory itself, or lives under it.
    for (let end = patternSegments.length; end <= pathSegments.length; end++) {
      if (matchSegments(patternSegments, pathSegments.slice(0, end))) return true
    }
    return false
  }
  return matchSegments(patternSegments, pathSegments)
}

/** Conditions already reported, so a hot path logs each one once. */
const warnedConditions = new Set<string>()

function warnUnknownCondition(ruleId: string, condition: string): void {
  const key = `${ruleId}:${condition}`
  if (warnedConditions.has(key)) return
  warnedConditions.add(key)
  logger.warn('local command rule has a condition this build cannot evaluate; running the command unchanged', {
    rule: ruleId,
    condition
  })
}

/** Build the view over a parsed layout. */
export function createLayoutView(layout: KitLayout): LayoutView {
  const covers = (role: LayoutRole, path: string): boolean =>
    path === role.path || path.startsWith(`${role.path}/`)

  return {
    layout,

    agentRoles: () => layout.agent.roles,

    workshopRoles: () => layout.workshop.roles,

    roleFor(relPath: string): LayoutRole | null {
      const path = normalizeRelPath(relPath)
      return layout.agent.roles.find((role) => covers(role, path)) ?? null
    },

    isExcludedFromExport(relPath: string): boolean {
      const path = normalizeRelPath(relPath)
      if (path === '') return false
      // `secret_files` is the authority; the dotenv globs in the exclude list
      // are its belt-and-braces subset. Applied here, it covers both the files
      // an export copies and the ones it hashes for `content_hash`.
      return (
        layout.cloud_import_excludes.some((pattern) => matchesPattern(pattern, path)) ||
        isSecretByRules(layout.secret_files, path)
      )
    },

    isSecretFile: (relPath: string) => isSecretByRules(layout.secret_files, relPath),

    survivesUpdate(relPath: string): boolean {
      const path = normalizeRelPath(relPath)
      const role =
        layout.workshop.roles.find((r) => covers(r, path)) ??
        layout.agent.roles.find((r) => covers(r, path))
      return role ? role.survives_update : true
    },

    localizeCommand(command: string, context: LocalCommandContext): string {
      const trimmed = command.trim()
      for (const rule of layout.local_command_runner.rules) {
        if (!trimmed.startsWith(rule.match.value)) continue
        const needs = rule.when?.file_exists
        if (needs !== undefined && needs !== 'pyproject.toml') {
          // A newer contract declared a condition this build cannot evaluate.
          // The command runs unchanged, which is the safe direction, but a
          // silent no-op is how a rule stops working without anyone noticing.
          warnUnknownCondition(rule.id, needs)
          continue
        }
        if (needs !== undefined && !context.hasPyproject) continue
        return rule.replace_with + trimmed.slice(rule.match.value.length)
      }
      return trimmed
    },

    scaffoldIgnoreFiles: (kind) => layout.scaffold_ignore_files[kind],

    desktopOwned: () => layout.desktop_owned
  }
}
