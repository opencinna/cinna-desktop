/**
 * A kit agent's own skills — `skills/<name>/SKILL.md` — read and validated.
 *
 * A port of cinna-core's `backend/app/services/agents/skill_manifest.py`
 * (`parse_frontmatter`, `parse_credential_declarations`, `parse_skill_dir`,
 * `scan_skills_root`, `apply_budget`). **Core is the source of truth**: the
 * kit validator core ships next matches that module, so the codes, the
 * sentences, the limits and the frontmatter subset here are its, line for line.
 * A rule changes there first and is ported here after; nothing is added here
 * that core would not say about the same folder.
 *
 * What makes a skill *deliverable* — handed to an engine at all — is having no
 * error. Two of core's errors matter more on the desktop than they look:
 * `name_mismatch` and `missing_description`. Claude names a plugin skill by its
 * **folder** and OpenCode by its frontmatter **name**, so only a skill whose two
 * agree is the same skill on both engines.
 *
 * Never throws. An unreadable skill folder or a broken `SKILL.md` is a row with
 * an issue, because the Addons tab has to show the problem rather than lose the
 * skill; a `skills/` that is not a directory means no skills at all.
 *
 * Core: no Electron, `node:` builtins and pure helpers only.
 */

import { lstatSync, readdirSync, readFileSync, statSync, type Dirent } from 'node:fs'
import { join } from 'node:path'
import { pySplitLines, pyStrip } from '../services/localAgents/envFile'
import type {
  LocalAgentSkill,
  LocalAgentSkillCredential,
  LocalAgentSkillIssue
} from '../../shared/localAgents'

/* ------------------------------------------------------- contract constants */

/** Skill directory / frontmatter `name` shape. */
export const SKILL_NAME_RE = /^[a-z0-9]+(-[a-z0-9]+)*$/
export const MAX_NAME_LENGTH = 64
export const MAX_DESCRIPTION_LENGTH = 1024
export const MAX_VERSION_LENGTH = 64
/** A `SKILL.md` body above this still works, flagged `oversized`. */
export const MAX_BODY_BYTES = 64 * 1024
/** Per-agent caps; overflow is an `budget` error, in name order. */
export const DEFAULT_MAX_SKILLS = 50
export const DEFAULT_MAX_TOTAL_BYTES = 16 * 1024 * 1024

/** The skills folder of an agent, and the entry file of each skill. */
export const SKILLS_DIR = 'skills'
export const SKILL_FILE = 'SKILL.md'

/** Platform slash-command names (core's `RESERVED_SKILL_NAMES`). */
export const RESERVED_SKILL_NAMES: ReadonlySet<string> = new Set([
  'files', 'files-all', 'run', 'run-list', 'skills', 'session-recover', 'session-reset',
  'session-improve', 'webapp', 'rebuild-env', 'agent-status'
])

/**
 * Platform-owned skills an agent's own may not shadow — core's
 * `PLATFORM_SKILL_NAMES`. `cinna-tasks` is `tasksSkillService.TASKS_SKILL_NAME`
 * and `cinna-artifacts` is `artifactsSkill.ARTIFACTS_SKILL_NAME`; a test keeps
 * the set equal to the bundled `kit.json`'s `platform_skills`.
 */
export const PLATFORM_SKILL_NAMES: ReadonlySet<string> = new Set(['cinna-tasks', 'cinna-artifacts'])

const SKIP_DIR_NAMES: ReadonlySet<string> = new Set([
  '.git', '.venv', '__pycache__', '.mypy_cache', '.ruff_cache', 'node_modules'
])

/**
 * Folders core walks but Share never packs (`skillPack.SKIPPED_DIRS` beyond
 * {@link SKIP_DIR_NAMES}): a link inside one is not a `links` warning, since
 * Share would not refuse it.
 */
const UNPACKED_DIR_NAMES: ReadonlySet<string> = new Set(['.pytest_cache'])

const SECRET_FILENAMES: ReadonlySet<string> = new Set([
  'credentials.json', 'id_rsa', 'id_dsa', 'id_ecdsa', 'id_ed25519'
])
const SECRET_SUFFIXES = ['.pem', '.p12', '.pfx', '.key'] as const

export const SKILL_CREDENTIAL_SLOT_RE = /^[A-Za-z0-9][A-Za-z0-9._:/@+-]*$/
export const MAX_SLOT_LENGTH = 255
export const MAX_SKILL_CREDENTIALS = 20

/** Core's `SKILL_CREDENTIAL_TYPES`: `CredentialType` minus `mcp_provider`. */
export const SKILL_CREDENTIAL_TYPES: ReadonlySet<string> = new Set([
  'email_imap', 'email_smtp', 'odoo', 'gmail_oauth', 'gmail_oauth_readonly', 'gdrive_oauth',
  'gdrive_oauth_readonly', 'gcalendar_oauth', 'gcalendar_oauth_readonly', 'gmeet_oauth',
  'gmeet_oauth_readonly', 'google_service_account', 'api_token', 'ssh_key', 'agent_api'
])

/* -------------------------------------------------------- issue vocabulary */

/** Every code and its sentence — core's `ISSUE_MESSAGES`, verbatim. */
export const ISSUE_MESSAGES: Readonly<Record<string, string>> = {
  not_a_directory: 'Only folders directly under skills/ are read as skills.',
  missing_skill_md: 'This folder has no SKILL.md.',
  unreadable: 'SKILL.md could not be read.',
  invalid_frontmatter: 'SKILL.md has no valid frontmatter block.',
  missing_name: 'SKILL.md frontmatter has no name.',
  invalid_name: 'The name must be lowercase words joined by single hyphens, at most 64 characters.',
  name_mismatch: 'The name in SKILL.md does not match the folder name.',
  reserved_name: 'This name is reserved by a platform command.',
  missing_description: 'SKILL.md frontmatter has no description.',
  description_too_long: 'The description is longer than 1024 characters.',
  invalid_credentials: 'The credentials block in SKILL.md is invalid.',
  budget: 'Excluded — the agent is over its skill count or size budget.',
  projection_error: 'This skill could not be copied to the engine.',
  oversized: 'The SKILL.md body is larger than 64 KB.',
  shadowed: 'Another installed skill uses this name.',
  secrets: 'This skill holds files that look like credentials.',
  // Desktop only: core's scanner skips links silently, but Share refuses them.
  links: 'This skill holds links, which can’t be shared — replace them with the files themselves.'
}

/** Warning order, most severe first (core's `WARNING_PRECEDENCE`). */
const WARNING_PRECEDENCE = ['secrets', 'links', 'shadowed', 'oversized'] as const

function issue(code: string, severity: 'error' | 'warning', message?: string, paths?: string[]): LocalAgentSkillIssue {
  return {
    code,
    message: message || ISSUE_MESSAGES[code] || code,
    severity,
    ...(paths && paths.length > 0 ? { paths } : {})
  }
}

/* ------------------------------------------- frontmatter (restricted YAML) */

/**
 * A frontmatter value. Integers are `bigint`, as Python's `int` is unbounded
 * and `str(int)` is exact; floats are numbers.
 */
export type FrontmatterValue =
  | string
  | number
  | bigint
  | boolean
  | null
  | FrontmatterValue[]
  | { [key: string]: FrontmatterValue }

type Mapping = Record<string, FrontmatterValue>

const KEY_LINE_RE = /^([A-Za-z0-9_.-]+)\s*:\s*(.*)$/
const ITEM_KEY_RE = /^([A-Za-z0-9_.-]+):(?:\s+(.*))?$/

function coerceScalar(raw: string): FrontmatterValue {
  const value = pyStrip(raw)
  if (!value) return ''
  if (value.length >= 2 && value[0] === value[value.length - 1] && (value[0] === "'" || value[0] === '"')) {
    return value.slice(1, -1)
  }
  const lowered = value.toLowerCase()
  if (lowered === 'true' || lowered === 'yes') return true
  if (lowered === 'false' || lowered === 'no') return false
  if (lowered === 'null' || lowered === '~') return null
  if (/^-?\d+$/.test(value)) return BigInt(value)
  if (/^-?\d+\.\d+$/.test(value)) return Number(value)
  return value
}

function parseFlowSequence(raw: string): FrontmatterValue[] {
  const inner = pyStrip(pyStrip(raw).slice(1, -1))
  if (!inner) return []
  return inner.split(',').map(coerceScalar)
}

function indentOf(line: string): number {
  return line.length - line.replace(/^ +/, '').length
}

/**
 * Split a `SKILL.md` into its frontmatter mapping and markdown body — core's
 * `parse_frontmatter`, divergences from YAML and all (see that module's header).
 *
 * @throws Error when there is no frontmatter fence, or it is never closed.
 */
export function parseSkillFrontmatter(text: string): { frontmatter: Mapping; body: string } {
  if (!text.startsWith('---')) throw new Error('missing frontmatter fence')
  const lines = pySplitLines(text)
  let end: number | null = null
  for (let index = 1; index < lines.length; index++) {
    const stripped = pyStrip(lines[index])
    if (stripped === '---' || stripped === '...') {
      end = index
      break
    }
  }
  if (end === null) throw new Error('unterminated frontmatter fence')

  const body = lines.slice(end + 1).join('\n').replace(/^\n+/, '')
  const mapping: Mapping = {}

  let index = 1
  while (index < end) {
    const line = lines[index]
    const stripped = pyStrip(line)
    if (!stripped || stripped.startsWith('#') || indentOf(line) > 0) {
      index++
      continue
    }
    const match = KEY_LINE_RE.exec(stripped)
    if (!match) {
      index++
      continue
    }
    const key = match[1]
    const rawValue = pyStrip(match[2])

    if (['|', '>', '|-', '>-', '|+', '>+'].includes(rawValue)) {
      const block: string[] = []
      index++
      while (index < end && (!pyStrip(lines[index]) || indentOf(lines[index]) > 0)) {
        block.push(pyStrip(lines[index]))
        index++
      }
      mapping[key] = pyStrip(block.join(rawValue.startsWith('|') ? '\n' : ' '))
      continue
    }
    if (rawValue.startsWith('[') && rawValue.endsWith(']')) {
      mapping[key] = parseFlowSequence(rawValue)
      index++
      continue
    }
    if (rawValue) {
      mapping[key] = coerceScalar(rawValue)
      index++
      continue
    }

    // Empty value: a block sequence or a nested mapping follows.
    index++
    const items: FrontmatterValue[] = []
    const nested: Mapping = {}
    let currentItem: Mapping | null = null
    while (index < end) {
      const child = lines[index]
      const childStripped = pyStrip(child)
      if (!childStripped) {
        index++
        continue
      }
      if (indentOf(child) === 0 && !childStripped.startsWith('- ')) break
      if (childStripped.startsWith('- ')) {
        const remainder = childStripped.slice(2)
        const itemMatch = ITEM_KEY_RE.exec(pyStrip(remainder))
        if (itemMatch) {
          currentItem = { [itemMatch[1]]: coerceScalar(itemMatch[2] ?? '') }
          items.push(currentItem)
        } else {
          items.push(coerceScalar(remainder))
          currentItem = null
        }
      } else {
        const childMatch = KEY_LINE_RE.exec(childStripped)
        if (childMatch) (currentItem ?? nested)[childMatch[1]] = coerceScalar(childMatch[2])
      }
      index++
    }
    mapping[key] = items.length > 0 ? items : Object.keys(nested).length > 0 ? nested : ''
  }
  return { frontmatter: mapping, body }
}

/** Python's `str()` of a frontmatter number. */
function pyNumberString(value: number | bigint): string {
  if (typeof value === 'bigint') return value.toString()
  if (Number.isInteger(value) && Math.abs(value) < 1e16) return `${value}.0`
  return String(value)
}

/** Core's `coerce_version`: one line, at most 64 characters, or null. */
export function coerceVersion(raw: FrontmatterValue | undefined): string | null {
  if (raw === undefined || raw === null || typeof raw === 'boolean') return null
  let text: string
  if (typeof raw === 'number' || typeof raw === 'bigint') text = pyNumberString(raw)
  else if (typeof raw === 'string') text = raw
  else return null
  const value = pyStrip(text)
  // eslint-disable-next-line no-control-regex
  if (/[\x00-\x1f]/.test(value)) return null
  return value.slice(0, MAX_VERSION_LENGTH) || null
}

/**
 * `kit.py`'s `skill_version_problem` (contract 1.10.0): why the platform would
 * not keep a frontmatter `version` as written, or null. Absent is fine and a
 * number is kept as text; a list, a mapping, a boolean or a value with a line
 * break or control character is dropped, and one longer than 64 characters is
 * cut. `kit.py validate` reports it as a warning; {@link coerceVersion} is what
 * the platform keeps.
 */
export function skillVersionProblem(raw: FrontmatterValue | undefined): string | null {
  if (raw === undefined || raw === null || typeof raw === 'number' || typeof raw === 'bigint') return null
  // eslint-disable-next-line no-control-regex
  if (typeof raw !== 'string' || /[\x00-\x1f]/.test(pyStrip(raw))) {
    return '`version` must be one line of text; this one is ignored and publishing picks the next version itself.'
  }
  // Python's `len` counts code points, not UTF-16 units.
  if ([...pyStrip(raw)].length > MAX_VERSION_LENGTH) {
    return `\`version\` is longer than ${MAX_VERSION_LENGTH} characters; the platform keeps only the first ${MAX_VERSION_LENGTH}.`
  }
  return null
}

/* ------------------------------------------------- credential declarations */

function bounded(value: string, limit = 64): string {
  return value.length <= limit ? value : `${value.slice(0, limit)}…`
}

function isMapping(value: FrontmatterValue): value is Mapping {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/**
 * Core's `parse_credential_declarations`: the declarations, or the first
 * problem as a short phrase (and then no declarations).
 */
export function parseCredentialDeclarations(
  raw: FrontmatterValue | undefined
): { credentials: LocalAgentSkillCredential[]; problem: string | null } {
  const fail = (problem: string): { credentials: LocalAgentSkillCredential[]; problem: string } => ({ credentials: [], problem })
  if (raw === undefined || raw === null || raw === '') return { credentials: [], problem: null }
  if (!Array.isArray(raw)) return fail('it must be a list of entries, each with a slot and a type')
  if (raw.length > MAX_SKILL_CREDENTIALS) return fail(`it declares more than ${MAX_SKILL_CREDENTIALS} credentials`)

  const credentials: LocalAgentSkillCredential[] = []
  const seen = new Set<string>()
  for (let position = 1; position <= raw.length; position++) {
    const item = raw[position - 1]
    if (!isMapping(item)) return fail(`entry ${position} is not a mapping with a slot and a type`)

    const rawSlot = item.slot
    if ('slot' in item && typeof rawSlot !== 'string') return fail(`entry ${position}: slot must be text; quote it in SKILL.md`)
    if (typeof rawSlot !== 'string' || !pyStrip(rawSlot)) return fail(`entry ${position} has no slot`)
    const slot = pyStrip(rawSlot)
    if (slot.length > MAX_SLOT_LENGTH) {
      return fail(`the slot of entry ${position} is longer than ${MAX_SLOT_LENGTH} characters`)
    }
    if (!SKILL_CREDENTIAL_SLOT_RE.test(slot)) {
      return fail(`the slot '${bounded(slot)}' is not a valid service URI (letters, digits and . _ : / @ + -, no spaces)`)
    }
    if (seen.has(slot)) return fail(`the slot '${bounded(slot)}' is declared twice`)

    const rawType = item.type
    if ('type' in item && typeof rawType !== 'string') {
      return fail(`the type of the slot '${bounded(slot)}' must be text; quote it in SKILL.md`)
    }
    if (typeof rawType !== 'string' || !pyStrip(rawType)) return fail(`the slot '${bounded(slot)}' has no type`)
    const type = pyStrip(rawType)
    if (type === 'mcp_provider') {
      return fail(`the slot '${bounded(slot)}' has type 'mcp_provider', which a skill cannot declare`)
    }
    if (!SKILL_CREDENTIAL_TYPES.has(type)) {
      return fail(`the slot '${bounded(slot)}' has an unknown type '${bounded(type)}'`)
    }

    const rawDescription = item.description
    if (rawDescription !== undefined && rawDescription !== null && typeof rawDescription !== 'string') {
      return fail(`the description of the slot '${bounded(slot)}' must be text; quote it in SKILL.md`)
    }
    const description = typeof rawDescription === 'string' ? pyStrip(rawDescription) || null : null
    if (description !== null && description.length > MAX_DESCRIPTION_LENGTH) {
      return fail(`the description of the slot '${bounded(slot)}' is longer than ${MAX_DESCRIPTION_LENGTH} characters`)
    }

    seen.add(slot)
    credentials.push({ slot, type, description })
  }
  return { credentials, problem: null }
}

/* ------------------------------------------------------- secret predicate */

/** Core's `is_secret_filename`: a basename that can hold a credential value. */
export function isSecretFilename(name: string): boolean {
  if (SECRET_FILENAMES.has(name)) return true
  if (SECRET_SUFFIXES.some((suffix) => name.endsWith(suffix))) return true
  // The kit contract's `dotenv` rule: `.env`, `.env.*`, `*.env`, unless an example.
  const dotenv = name === '.env' || name.startsWith('.env.') || name.endsWith('.env')
  const example = ['.example', '.sample', '.template'].some((suffix) => name.endsWith(suffix))
  return dotenv && !example
}

/**
 * Total bytes, the secret-looking files and the links of a skill tree, in one
 * walk. Symlinks are skipped at both levels and the junk directories never
 * entered, as core's `_walk_files` does; an unreadable directory is skipped
 * silently. The links are collected only to warn: Share refuses them, so a
 * link in a folder Share does not pack ({@link UNPACKED_DIR_NAMES}) is not one.
 */
function measureTree(root: string): { size: number; secrets: string[]; links: string[] } {
  let size = 0
  const secrets: string[] = []
  const links: string[] = []
  const walk = (dir: string, rel: string, packed: boolean): void => {
    let entries: Dirent[]
    try {
      entries = readdirSync(dir, { withFileTypes: true })
    } catch {
      return
    }
    entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))
    for (const entry of entries) {
      const relative = rel ? `${rel}/${entry.name}` : entry.name
      if (entry.isSymbolicLink()) {
        if (packed) links.push(relative)
        continue
      }
      if (entry.isDirectory()) {
        if (!SKIP_DIR_NAMES.has(entry.name)) walk(join(dir, entry.name), relative, packed && !UNPACKED_DIR_NAMES.has(entry.name))
        continue
      }
      try {
        size += statSync(join(dir, entry.name)).size
      } catch {
        continue
      }
      if (isSecretFilename(entry.name)) secrets.push(relative)
    }
  }
  walk(root, '', true)
  return { size, secrets, links }
}

/* ------------------------------------------------------ parsing / scanning */

/** One parsed skill, plus what the budget pass needs. */
interface ParsedSkill {
  skill: LocalAgentSkill
  size: number
  /**
   * Why `kit.py validate` warns about the frontmatter `version` as written
   * ({@link skillVersionProblem}), for a skill that parsed; null otherwise.
   * Not an issue on the row: core's scanner says nothing about it.
   */
  versionProblem: string | null
}

function isDirectory(path: string): boolean {
  try {
    return statSync(path).isDirectory()
  } catch {
    return false
  }
}

function isSymlink(path: string): boolean {
  try {
    return lstatSync(path).isSymbolicLink()
  } catch {
    return false
  }
}

function isFile(path: string): boolean {
  try {
    return statSync(path).isFile()
  } catch {
    return false
  }
}

const utf8 = new TextDecoder('utf-8', { fatal: true })

/**
 * Core's `parse_skill_dir`, for one `skills/<name>/` directory. Never throws.
 * `name` is the folder's; every engine is given the skill under it.
 */
export function parseSkillDir(skillDir: string, folderName: string): ParsedSkill {
  const path = `${SKILLS_DIR}/${folderName}/${SKILL_FILE}`
  const fail = (code: string, message?: string): ParsedSkill => ({
    skill: {
      name: folderName,
      description: '',
      version: null,
      source: 'authored',
      path,
      deliverable: false,
      issues: [issue(code, 'error', message)],
      credentials: []
    },
    size: 0,
    versionProblem: null
  })

  if (!isDirectory(skillDir) || isSymlink(skillDir)) return fail('not_a_directory')
  const skillFile = join(skillDir, SKILL_FILE)
  if (!isFile(skillFile)) return fail('missing_skill_md')

  let raw: string
  try {
    raw = utf8.decode(readFileSync(skillFile))
    // utf-8-sig: an editor-written BOM would otherwise fail the fence test.
    if (raw.startsWith('﻿')) raw = raw.slice(1)
  } catch {
    return fail('unreadable')
  }

  let parsed: { frontmatter: Mapping; body: string }
  try {
    parsed = parseSkillFrontmatter(raw)
  } catch {
    return fail('invalid_frontmatter')
  }
  const { frontmatter, body } = parsed

  const rawName = frontmatter.name
  if (typeof rawName !== 'string' || !pyStrip(rawName)) return fail('missing_name')
  const name = pyStrip(rawName)
  if (name.length > MAX_NAME_LENGTH || !SKILL_NAME_RE.test(name)) return fail('invalid_name')
  if (name !== folderName) return fail('name_mismatch')
  if (RESERVED_SKILL_NAMES.has(name)) return fail('reserved_name')
  if (PLATFORM_SKILL_NAMES.has(name)) return fail('reserved_name', 'This name is reserved by a platform skill.')

  const rawDescription = frontmatter.description
  if (typeof rawDescription !== 'string' || !pyStrip(rawDescription)) return fail('missing_description')
  const description = pyStrip(rawDescription)
  if (description.length > MAX_DESCRIPTION_LENGTH) return fail('description_too_long')

  const { credentials, problem } = parseCredentialDeclarations(frontmatter.credentials)
  if (problem !== null) {
    return fail('invalid_credentials', `The credentials block in SKILL.md is invalid: ${problem}.`)
  }

  const { size, secrets, links } = measureTree(skillDir)
  const warnings: LocalAgentSkillIssue[] = []
  if (secrets.length > 0) warnings.push(issue('secrets', 'warning', undefined, secrets))
  if (links.length > 0) warnings.push(issue('links', 'warning', undefined, links))
  if (Buffer.byteLength(body, 'utf8') > MAX_BODY_BYTES) warnings.push(issue('oversized', 'warning'))
  warnings.sort((a, b) => warningRank(a.code) - warningRank(b.code))

  return {
    skill: {
      name,
      description,
      version: coerceVersion(frontmatter.version),
      source: 'authored',
      path,
      deliverable: true,
      issues: warnings,
      credentials
    },
    size,
    versionProblem: skillVersionProblem(frontmatter.version)
  }
}

function warningRank(code: string): number {
  const rank = (WARNING_PRECEDENCE as readonly string[]).indexOf(code)
  return rank === -1 ? WARNING_PRECEDENCE.length : rank
}

/**
 * Core's `apply_budget`: past the count or byte cap, a skill that would have
 * been delivered gets the `budget` error instead. A skill already in error
 * charges nothing. Walks the list in the order given (callers sort by name).
 */
function applyBudget(entries: ParsedSkill[], maxSkills: number, maxTotalBytes: number): void {
  let accepted = 0
  let total = 0
  for (const entry of entries) {
    if (!entry.skill.deliverable) continue
    if (accepted >= maxSkills || total + entry.size > maxTotalBytes) {
      entry.skill.deliverable = false
      entry.skill.issues = [issue('budget', 'error'), ...entry.skill.issues]
      continue
    }
    accepted++
    total += entry.size
  }
}

export interface ScanSkillsOptions {
  maxSkills?: number
  maxTotalBytes?: number
}

/**
 * Every skill of an agent folder, name-sorted, valid or not — core's
 * `scan_skills_root` over `<agentDir>/skills`. No `skills/` (or one that is a
 * file) is an agent with no skills. Dot-entries and plain files at the root
 * are skipped silently: the kit ships `skills/README.md` as scaffolding.
 */
export function scanAgentSkills(agentDir: string, options: ScanSkillsOptions = {}): LocalAgentSkill[] {
  return scanAgentSkillDetails(agentDir, options).map((entry) => entry.skill)
}

/**
 * {@link scanAgentSkills} with what the validator needs beside each row — the
 * `version` problem `kit.py validate` warns about — so `validateAgentFolder`
 * reads the same scan rather than a second reading of the same files.
 */
export function scanAgentSkillDetails(
  agentDir: string,
  options: ScanSkillsOptions = {}
): { skill: LocalAgentSkill; versionProblem: string | null }[] {
  const root = join(agentDir, SKILLS_DIR)
  if (!isDirectory(root)) return []
  let names: string[]
  try {
    names = readdirSync(root)
  } catch {
    return []
  }
  const entries = names
    .filter((name) => !name.startsWith('.') && isDirectory(join(root, name)))
    .sort()
    .map((name) => parseSkillDir(join(root, name), name))
  entries.sort((a, b) => (a.skill.name < b.skill.name ? -1 : a.skill.name > b.skill.name ? 1 : 0))
  applyBudget(entries, options.maxSkills ?? DEFAULT_MAX_SKILLS, options.maxTotalBytes ?? DEFAULT_MAX_TOTAL_BYTES)
  return entries.map(({ skill, versionProblem }) => ({ skill, versionProblem }))
}

/** The skills an engine is given: the deliverable ones. */
export function deliverableSkills(skills: readonly LocalAgentSkill[] | undefined): LocalAgentSkill[] {
  return (skills ?? []).filter((skill) => skill.deliverable)
}

/* ------------------------------------------- catalog skills (contract 1.10) */

/**
 * The segment a platform-derived catalog package id names the skill after:
 * `<reversed host>.skill.<name>`, with the publisher's id appended
 * (`….skill.<name>.<8 hex>`) when the plain id was taken.
 */
const CATALOG_PACKAGE_ID_SKILL_SEGMENT = 'skill'

/**
 * `kit.py`'s `catalog_skill_name`: the skill name a catalog package id seems to
 * carry — the segment right after the last `skill` segment that is not the id's
 * last — or null. Advisory only: a pin's `name` is the authority, and this
 * reading is used to warn when the two disagree.
 */
export function catalogSkillName(packageId: unknown): string | null {
  if (typeof packageId !== 'string') return null
  const segments = packageId.split('.')
  for (let position = segments.length - 2; position >= 0; position--) {
    if (segments[position] === CATALOG_PACKAGE_ID_SKILL_SEGMENT) {
      const candidate = segments[position + 1]
      return SKILL_NAME_RE.test(candidate) ? candidate : null
    }
  }
  return null
}

/** A pin `name` the contract accepts: a skill name, at most 64 characters. */
export function isCatalogPinName(name: unknown): name is string {
  return typeof name === 'string' && name.length <= MAX_NAME_LENGTH && SKILL_NAME_RE.test(name)
}

/**
 * Why a catalog pin's name collides, as `kit.py validate` reports it:
 * `authored` — a folder of that name under `skills/`; `platform` — a skill the
 * platform provides; `duplicate` — an earlier pin of the same name. `kit.py`
 * reports `authored` and `platform` as one either/or, and `duplicate` beside
 * them, so a pin can carry two.
 */
export type CatalogPinClash = 'authored' | 'platform' | 'duplicate'

/**
 * Every pin of `catalog_skills[]` (by index) whose name collides, and how. Pins
 * that are not objects or whose name is not a skill name are left to the
 * field checks. `authored` is every folder name directly under `skills/`,
 * broken ones included — what {@link scanAgentSkills} lists.
 */
export function catalogPinClashes(
  catalogSkills: unknown,
  authored: ReadonlySet<string>
): Map<number, CatalogPinClash[]> {
  const clashes = new Map<number, CatalogPinClash[]>()
  if (!Array.isArray(catalogSkills)) return clashes
  const seen = new Set<string>()
  catalogSkills.forEach((pin: unknown, index) => {
    if (pin === null || typeof pin !== 'object' || Array.isArray(pin)) return
    const name = (pin as Record<string, unknown>).name
    if (!isCatalogPinName(name)) return
    const found: CatalogPinClash[] = []
    if (seen.has(name)) found.push('duplicate')
    seen.add(name)
    if (authored.has(name)) found.push('authored')
    else if (PLATFORM_SKILL_NAMES.has(name)) found.push('platform')
    if (found.length > 0) clashes.set(index, found)
  })
  return clashes
}

/** Sentences for a catalog row's own issues. */
export const CATALOG_ISSUE_MESSAGES: Readonly<Record<string, string>> = {
  not_downloaded: 'Not on this computer yet.',
  download_failed: 'It could not be downloaded.',
  catalog_disconnected:
    'Disconnected — this skill is no longer in the catalog for you. The copy on this computer is now a local version: it keeps working but no longer syncs or gets updates.',
  duplicate_pin: 'Another catalog skill of this agent has the same name.',
  name_clash: 'This agent’s own skills/ folder has a skill of the same name. Remove the pin or rename the folder.',
  reserved_name: 'This name is reserved by a platform skill.'
}

/**
 * The `catalog_disconnected` sentence for a pin with no copy on this computer
 * whose download was refused as not available (404): the same state as the
 * cached one, but nothing keeps working, so it says what to do instead.
 */
export const CATALOG_DISCONNECTED_NOT_CACHED =
  'Disconnected — this skill is no longer in the catalog for you, so this agent can’t download it. Ask a maintainer for access, or remove it.'

const CLASH_CODES: Readonly<Record<CatalogPinClash, string>> = {
  duplicate: 'duplicate_pin',
  authored: 'name_clash',
  platform: 'reserved_name'
}

function catalogIssue(code: string, severity: 'error' | 'warning'): LocalAgentSkillIssue {
  return { code, message: CATALOG_ISSUE_MESSAGES[code], severity }
}

/** What a pin names, for the cache: the package, the revision, the folder name and the archive digest. */
export interface CatalogSkillRef {
  packageUuid: string
  revisionNumber: number | null
  name: string
  archiveSha256: string
}

/**
 * Where a pinned revision stands on this computer: unpacked (`dir` is the
 * skill folder), its last download failed (`message`, a plain sentence), or
 * not here.
 */
export type CatalogSkillCacheState =
  | { state: 'ready'; dir: string }
  | { state: 'failed'; message: string }
  | { state: 'missing' }

/** Answers {@link CatalogSkillCacheState} for a pin; `catalogSkillCache.resolve` provides it. */
export type CatalogSkillResolver = (ref: CatalogSkillRef) => CatalogSkillCacheState

/** A pin as a {@link CatalogSkillRef}. */
export function catalogSkillRefOf(pin: Record<string, unknown>): CatalogSkillRef {
  const revision = pin.revision_number
  return {
    packageUuid: typeof pin.package_uuid === 'string' ? pin.package_uuid : '',
    revisionNumber: typeof revision === 'number' && Number.isInteger(revision) && revision >= 1 ? revision : null,
    name: typeof pin.name === 'string' ? pin.name : '',
    archiveSha256: typeof pin.archive_sha256 === 'string' ? pin.archive_sha256 : ''
  }
}

/**
 * The manifest's `catalog_skills[]` pins as skill rows (`source: 'catalog'`).
 *
 * Without a `resolve`, or for a revision it does not have, a row is **not
 * deliverable** and carries `not_downloaded` — or `download_failed` with the
 * last attempt's sentence. A pin whose name collides is an error on its row
 * and is never delivered, downloaded or not. A pin whose revision is cached
 * is checked by the same per-skill rules as an own skill ({@link parseSkillDir}:
 * `SKILL.md` names its folder, which is the pin's name, and has a
 * description); one that passes is **deliverable**, with `path` the absolute
 * path of the cached `SKILL.md`, the description and credential slots from
 * that file, and its warnings. Pins that are not objects or have no usable
 * name are not rows: `validateManifest` reports them.
 */
export function catalogSkillRows(
  manifest: unknown,
  authored: ReadonlySet<string>,
  resolve?: CatalogSkillResolver
): LocalAgentSkill[] {
  if (manifest === null || typeof manifest !== 'object') return []
  const pins = (manifest as Record<string, unknown>).catalog_skills
  if (!Array.isArray(pins)) return []
  const clashes = catalogPinClashes(pins, authored)
  const rows: LocalAgentSkill[] = []
  pins.forEach((raw: unknown, index) => {
    if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return
    const pin = raw as Record<string, unknown>
    if (!isCatalogPinName(pin.name)) return
    const ref = catalogSkillRefOf(pin)
    const clashIssues = (clashes.get(index) ?? []).map((clash) => catalogIssue(CLASH_CODES[clash], 'error'))
    const pinnedVersion = typeof pin.version === 'string' && pin.version.trim() !== '' ? pin.version.trim() : null
    const row: LocalAgentSkill = {
      name: pin.name,
      description: '',
      version: pinnedVersion,
      source: 'catalog',
      path: '',
      deliverable: false,
      issues: [...clashIssues, catalogIssue('not_downloaded', 'warning')],
      credentials: [],
      packageId: typeof pin.package_id === 'string' ? pin.package_id : '',
      packageUuid: ref.packageUuid,
      revisionNumber: ref.revisionNumber
    }
    let state: CatalogSkillCacheState = { state: 'missing' }
    if (resolve) {
      try {
        state = resolve(ref)
      } catch {
        state = { state: 'missing' }
      }
    }
    if (state.state === 'failed') {
      row.issues = [
        ...clashIssues,
        { code: 'download_failed', message: state.message || CATALOG_ISSUE_MESSAGES.download_failed, severity: 'warning' }
      ]
    } else if (state.state === 'ready') {
      const cached = parseSkillDir(state.dir, pin.name).skill
      row.path = join(state.dir, SKILL_FILE)
      row.description = cached.description
      row.version = pinnedVersion ?? cached.version
      row.credentials = cached.credentials
      // The cached copy's own problems, in core's words; a clash comes first.
      row.issues = [...clashIssues, ...cached.issues]
      row.deliverable = clashIssues.length === 0 && cached.deliverable
    }
    rows.push(row)
  })
  return rows
}

/**
 * Every skill row of a kit agent, name-sorted: its own (`skills/`) and its
 * pinned catalog skills, an own skill first where a name is on both. What the
 * Addons tab lists, and — through {@link deliverableSkills}, with the catalog
 * cache as `resolve` — what every engine is given.
 */
export function agentSkillRows(
  agentDir: string,
  manifest: unknown,
  resolve?: CatalogSkillResolver
): LocalAgentSkill[] {
  const authored = scanAgentSkills(agentDir)
  const rows = [...authored, ...catalogSkillRows(manifest, new Set(authored.map((skill) => skill.name)), resolve)]
  // Stable: an own skill keeps its place before a pin of the same name.
  return rows.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))
}
