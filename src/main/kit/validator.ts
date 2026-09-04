/**
 * A TypeScript port of `kit.py validate`: is this folder a coherent, cloud-ready
 * agent?
 *
 * The rules come from `schema/cinna-agent.schema.json` plus the file-level
 * checks the kit's guides describe (prompt files exist, commands have Makefile
 * targets, every script is catalogued, no secret is exposed). They are
 * hand-written rather than driven by a JSON-schema library: this app has no such
 * dependency and adding one to check eleven fields is not worth the weight.
 * When the schema changes, change the checks here in the same commit.
 *
 * Severity means something specific:
 *
 * * **error** — the folder is broken or would import wrong: a missing required
 *   field, a prompt file that is not there, an exposed secret, a `/run:` that
 *   resolves to nothing. The agent is not run.
 * * **warning** — it runs, but something is stale or not cloud-ready: no example
 *   prompts, a script missing from `scripts/README.md`, a command with no
 *   Makefile target, a credential `type` this build does not recognise (the
 *   platform's list grows independently, so an unknown one is reported, never
 *   rejected).
 * * **info** — worth knowing: the folder predates the active contract, or still
 *   carries the deprecated `cloud` stamp.
 *
 * **Never throws.** A half-written manifest, a truncated JSON file, an
 * unreadable folder — all come back as findings. Callers are a scanner and a
 * page, and neither may crash on a file someone is editing.
 *
 * **Deliberately not ported** from `kit.py validate`: `_validate_requirements`,
 * which reconciles an agent's `pyproject.toml` dependencies with the cloud
 * workspace's `requirements.txt` and can rewrite the latter with `--fix`. The
 * desktop has no Python at runtime, does not resolve dependency specs, and must
 * not rewrite a file an assistant owns; the kit tool stays the place that check
 * lives. This is a decision, not an omission.
 */

import { existsSync, readdirSync, readFileSync, statSync, type Dirent } from 'node:fs'
import { basename, join } from 'node:path'
import {
  MAX_EXAMPLE_PROMPTS,
  MAX_EXAMPLE_PROMPT_CHARS,
  ENV_PREFIX_PATTERN,
  MANIFEST_FILE,
  RUN_REFERENCE_PATTERN,
  SLUG_PATTERN,
  type CinnaAgentManifest
} from '../../shared/kit/manifest'
import { checkContractCompatibility, compareVersionStrings } from '../../shared/kit/contractVersion'
import { KitError } from '../errors'
import { createLogger } from '../logger/logger'
import { matchesPattern, type LayoutView } from './layout'
import { parseFrontmatter, parseWithIssues, type MiniYamlValue } from './miniYaml'
import { readWithStamp } from './manifestIo'

const logger = createLogger('kit-validator')

export type FindingSeverity = 'error' | 'warning' | 'info'

export interface Finding {
  /** Stable, dotted identifier — the UI keys messages off this, not the text. */
  code: string
  message: string
  /** Agent-relative path the finding is about, when there is one. */
  path?: string
}

export interface ValidationReport {
  errors: Finding[]
  warnings: Finding[]
  infos: Finding[]
}

export interface ValidateOptions {
  /** The contract's folder model. Needed for the export-exclusion checks. */
  layout?: LayoutView
  /**
   * The active contract version. Optional here because an in-memory manifest
   * can be checked before one is resolved; when it is absent the compatibility
   * gate cannot run and says so as `contract.unchecked`.
   */
  contractVersion?: string
  /** The folder name the slug must equal. Defaults to `basename(agentDir)`. */
  folderName?: string
}

/**
 * Options for validating a folder. `contractVersion` is **required** here: the
 * gate is the only thing standing between this build and a folder written
 * against a contract it does not understand, and a caller that forgot to pass
 * one used to disable it silently.
 */
export interface ValidateFolderOptions extends ValidateOptions {
  contractVersion: string
}

/** Credential types this build knows. An unknown one warns, never fails. */
const KNOWN_CREDENTIAL_TYPES = new Set([
  'email_imap',
  'email_smtp',
  'odoo',
  'gmail_oauth',
  'gmail_oauth_readonly',
  'gdrive_oauth',
  'gdrive_oauth_readonly',
  'gcalendar_oauth',
  'gcalendar_oauth_readonly',
  'google_service_account',
  'api_token',
  'ssh_key'
])

const SCHEDULE_TYPES = new Set(['static_prompt', 'script_trigger'])
const CRON_PATTERN = /^\S+\s+\S+\s+\S+\s+\S+\s+\S+$/
const UUID_PATTERN = /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/
const COMMAND_NAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]*$/
/**
 * Shapes an API key takes. `runtime.credential` is a reference, never one of
 * these.
 *
 * Exported because `runtimeService` applies the identical test on the way *in*
 * — the Runtime card writes a credential reference into this same field, and a
 * writer using a different rule from the validator would let the desktop create
 * a manifest its own validator then rejects.
 */
export const SECRET_LOOKALIKE = /^(sk-|sk_|ghp_|gho_|xox[baprs]-|AIza|AKIA)/

class Report {
  readonly errors: Finding[] = []
  readonly warnings: Finding[] = []
  readonly infos: Finding[] = []

  error(code: string, message: string, path?: string): void {
    this.errors.push({ code, message, path })
  }

  warn(code: string, message: string, path?: string): void {
    this.warnings.push({ code, message, path })
  }

  info(code: string, message: string, path?: string): void {
    this.infos.push({ code, message, path })
  }

  toReport(): ValidationReport {
    return { errors: this.errors, warnings: this.warnings, infos: this.infos }
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

/** Required, non-empty, within `maxLength`. Returns the value when it passes. */
function checkString(
  report: Report,
  value: unknown,
  field: string,
  maxLength: number,
  { required }: { required: boolean }
): string | null {
  if (value === undefined || value === null) {
    if (required) report.error(`manifest.${field}.missing`, `\`${field}\` is required.`, MANIFEST_FILE)
    return null
  }
  if (typeof value !== 'string') {
    report.error(`manifest.${field}.type`, `\`${field}\` must be a string.`, MANIFEST_FILE)
    return null
  }
  if (required && value.trim() === '') {
    report.error(`manifest.${field}.empty`, `\`${field}\` must not be empty.`, MANIFEST_FILE)
    return null
  }
  if (value.length > maxLength) {
    report.error(
      `manifest.${field}.too_long`,
      `\`${field}\` is longer than ${maxLength} characters.`,
      MANIFEST_FILE
    )
    return null
  }
  return value
}

function checkIdentity(report: Report, manifest: CinnaAgentManifest, contractVersion?: string): void {
  const isLegacy =
    manifest.contract_version === undefined &&
    manifest.id === undefined &&
    manifest.schema_version !== undefined

  if (isLegacy) {
    report.warn(
      'manifest.legacy',
      `This agent predates contract 1.0.0: it has \`schema_version\` but no \`contract_version\` or \`id\`. Re-stamp it so moves, renames and publications stay attached.`,
      MANIFEST_FILE
    )
    return
  }

  const version = checkString(report, manifest.contract_version, 'contract_version', 64, {
    required: true
  })
  if (version !== null && contractVersion === undefined) {
    report.info(
      'contract.unchecked',
      `This manifest records contract ${version}, and no active contract version was supplied to compare it against.`,
      MANIFEST_FILE
    )
  } else if (version !== null) {
    const gate = checkContractCompatibility(version, contractVersion)
    if (gate.status === 'app_too_old') {
      report.error('contract.app_too_old', gate.reason, MANIFEST_FILE)
    } else if (gate.status === 'migratable') {
      report.warn('contract.migratable', gate.reason, MANIFEST_FILE)
    } else if (gate.status === 'unknown') {
      report.error('manifest.contract_version.invalid', gate.reason, MANIFEST_FILE)
    }
  }

  const id = checkString(report, manifest.id, 'id', 64, { required: true })
  if (id !== null && !UUID_PATTERN.test(id)) {
    report.error('manifest.id.invalid', '`id` must be a UUID.', MANIFEST_FILE)
  }

  if (manifest.schema_version !== undefined && manifest.contract_version !== undefined) {
    report.info(
      'manifest.schema_version.legacy',
      '`schema_version` is legacy and is ignored; `contract_version` is the gate.',
      MANIFEST_FILE
    )
  }
}

function checkPrompts(report: Report, manifest: CinnaAgentManifest): void {
  if (manifest.prompts === undefined) return
  if (!isRecord(manifest.prompts)) {
    report.error('manifest.prompts.type', '`prompts` must be an object.', MANIFEST_FILE)
    return
  }
  for (const [key, value] of Object.entries(manifest.prompts)) {
    if (!['workflow', 'entrypoint', 'refiner'].includes(key)) {
      report.error(
        'manifest.prompts.unknown_key',
        `\`prompts.${key}\` is not one of workflow, entrypoint, refiner.`,
        MANIFEST_FILE
      )
      continue
    }
    if (typeof value !== 'string' || value.trim() === '') {
      report.error(
        'manifest.prompts.type',
        `\`prompts.${key}\` must be a path relative to the agent folder.`,
        MANIFEST_FILE
      )
    }
  }
}

function checkExamplePrompts(report: Report, manifest: CinnaAgentManifest): void {
  const prompts = manifest.example_prompts
  if (prompts === undefined || (Array.isArray(prompts) && prompts.length === 0)) {
    report.warn(
      'cloud.example_prompts.missing',
      'No `example_prompts`. A cloud-ready agent needs at least one, and the router reads them.',
      MANIFEST_FILE
    )
  } else if (!Array.isArray(prompts)) {
    report.error('manifest.example_prompts.type', '`example_prompts` must be an array.', MANIFEST_FILE)
    return
  } else {
    if (prompts.length > MAX_EXAMPLE_PROMPTS) {
      report.error(
        'manifest.example_prompts.too_many',
        `\`example_prompts\` holds at most ${MAX_EXAMPLE_PROMPTS} entries.`,
        MANIFEST_FILE
      )
    }
    prompts.forEach((prompt, index) => {
      if (typeof prompt !== 'string' || prompt.trim() === '') {
        report.error(
          'manifest.example_prompts.item',
          `\`example_prompts[${index}]\` must be a non-empty string.`,
          MANIFEST_FILE
        )
      } else if (prompt.length > MAX_EXAMPLE_PROMPT_CHARS) {
        report.error(
          'manifest.example_prompts.item_too_long',
          `\`example_prompts[${index}]\` is longer than ${MAX_EXAMPLE_PROMPT_CHARS} characters.`,
          MANIFEST_FILE
        )
      }
    })
  }

  const hasTrigger =
    typeof manifest.router_trigger_prompt === 'string' && manifest.router_trigger_prompt.trim() !== ''
  const hasExamples = Array.isArray(manifest.example_prompts) && manifest.example_prompts.length > 0
  if (!hasTrigger && !hasExamples) {
    report.warn(
      'cloud.unroutable',
      'With neither `router_trigger_prompt` nor `example_prompts`, nothing can route a request to this agent once it reaches the cloud.',
      MANIFEST_FILE
    )
  }
}

function checkRuntime(report: Report, manifest: CinnaAgentManifest): void {
  const runtime = manifest.runtime
  if (runtime === undefined || runtime === null) return
  if (!isRecord(runtime)) {
    report.error('manifest.runtime.type', '`runtime` must be an object or null.', MANIFEST_FILE)
    return
  }
  for (const key of ['model', 'credential'] as const) {
    const value = runtime[key]
    if (value !== undefined && value !== null && typeof value !== 'string') {
      report.error('manifest.runtime.type', `\`runtime.${key}\` must be a string or null.`, MANIFEST_FILE)
    }
  }
  const credential = runtime.credential
  if (typeof credential === 'string' && (SECRET_LOOKALIKE.test(credential) || credential.length > 200)) {
    report.error(
      'manifest.runtime.credential_looks_like_secret',
      '`runtime.credential` must be a reference — a credential type or the name of a configured credential — never a key. Remove this value and rotate it.',
      MANIFEST_FILE
    )
  }
  if (runtime.permissions !== undefined && !isRecord(runtime.permissions)) {
    report.error(
      'manifest.runtime.type',
      '`runtime.permissions` must be an object.',
      MANIFEST_FILE
    )
  }
}

function checkCredentials(report: Report, manifest: CinnaAgentManifest): void {
  const slots = manifest.credentials
  if (slots === undefined) return
  if (!Array.isArray(slots)) {
    report.error('manifest.credentials.type', '`credentials` must be an array.', MANIFEST_FILE)
    return
  }
  const seen = new Set<string>()
  slots.forEach((raw, index) => {
    const label = `credentials[${index}]`
    if (!isRecord(raw)) {
      report.error('manifest.credentials.item', `\`${label}\` must be an object.`, MANIFEST_FILE)
      return
    }
    const name = raw.name
    if (typeof name !== 'string' || name.trim() === '' || name.length > 255) {
      report.error('manifest.credentials.name', `\`${label}.name\` must be a non-empty string.`, MANIFEST_FILE)
    } else if (seen.has(name)) {
      report.warn(
        'manifest.credentials.duplicate',
        `Two credential slots are both named "${name}".`,
        MANIFEST_FILE
      )
    } else {
      seen.add(name)
    }

    const type = raw.type
    if (typeof type !== 'string' || type.trim() === '') {
      report.error('manifest.credentials.type_missing', `\`${label}.type\` is required.`, MANIFEST_FILE)
    } else if (!KNOWN_CREDENTIAL_TYPES.has(type)) {
      report.warn(
        'manifest.credentials.type_unknown',
        `\`${label}.type\` is "${type}", which this build does not recognise. It will be sent to the platform as-is.`,
        MANIFEST_FILE
      )
    }

    if (raw.env_prefix !== undefined) {
      if (typeof raw.env_prefix !== 'string' || !ENV_PREFIX_PATTERN.test(raw.env_prefix)) {
        report.error(
          'manifest.credentials.env_prefix',
          `\`${label}.env_prefix\` must look like MY_SLOT_ — upper case, ending in an underscore.`,
          MANIFEST_FILE
        )
      }
    }

    if (raw.fields !== undefined) {
      if (!Array.isArray(raw.fields) || raw.fields.some((f) => typeof f !== 'string' || f === '')) {
        report.error(
          'manifest.credentials.fields',
          `\`${label}.fields\` must be an array of non-empty strings.`,
          MANIFEST_FILE
        )
      }
    }

    if (raw.optional !== undefined && typeof raw.optional !== 'boolean') {
      report.error('manifest.credentials.optional', `\`${label}.optional\` must be a boolean.`, MANIFEST_FILE)
    }

    if (raw.description !== undefined && typeof raw.description !== 'string') {
      report.error(
        'manifest.credentials.description',
        `\`${label}.description\` must be a string.`,
        MANIFEST_FILE
      )
    }
  })
}

function checkSchedules(report: Report, manifest: CinnaAgentManifest): void {
  const schedules = manifest.schedules
  if (schedules === undefined) return
  if (!Array.isArray(schedules)) {
    report.error('manifest.schedules.type', '`schedules` must be an array.', MANIFEST_FILE)
    return
  }
  schedules.forEach((raw, index) => {
    const label = `schedules[${index}]`
    if (!isRecord(raw)) {
      report.error('manifest.schedules.item', `\`${label}\` must be an object.`, MANIFEST_FILE)
      return
    }
    if (typeof raw.name !== 'string' || raw.name.trim() === '' || raw.name.length > 255) {
      report.error('manifest.schedules.name', `\`${label}.name\` must be a non-empty string.`, MANIFEST_FILE)
    }
    if (typeof raw.cron_string !== 'string' || !CRON_PATTERN.test(raw.cron_string)) {
      report.error(
        'manifest.schedules.cron',
        `\`${label}.cron_string\` must be a five-field cron expression.`,
        MANIFEST_FILE
      )
    }
    const type = raw.schedule_type
    if (typeof type !== 'string' || !SCHEDULE_TYPES.has(type)) {
      report.error(
        'manifest.schedules.type_value',
        `\`${label}.schedule_type\` must be static_prompt or script_trigger.`,
        MANIFEST_FILE
      )
    } else if (type === 'static_prompt') {
      if (typeof raw.prompt !== 'string' || raw.prompt.trim() === '') {
        report.error(
          'manifest.schedules.prompt_required',
          `\`${label}\` is a static_prompt schedule, so it needs a \`prompt\`.`,
          MANIFEST_FILE
        )
      }
    } else if (typeof raw.command !== 'string' || raw.command.trim() === '') {
      report.error(
        'manifest.schedules.command_required',
        `\`${label}\` is a script_trigger schedule, so it needs a \`command\`.`,
        MANIFEST_FILE
      )
    }
    if (raw.timezone !== undefined && raw.timezone !== null && typeof raw.timezone !== 'string') {
      report.error('manifest.schedules.timezone', `\`${label}.timezone\` must be a string or null.`, MANIFEST_FILE)
    }
    if (raw.enabled !== undefined && typeof raw.enabled !== 'boolean') {
      report.error('manifest.schedules.enabled', `\`${label}.enabled\` must be a boolean.`, MANIFEST_FILE)
    }
  })
}

function checkHandovers(report: Report, manifest: CinnaAgentManifest, agentDir?: string): void {
  const handovers = manifest.handovers
  if (handovers === undefined) return
  if (!Array.isArray(handovers)) {
    report.error('manifest.handovers.type', '`handovers` must be an array.', MANIFEST_FILE)
    return
  }
  handovers.forEach((raw, index) => {
    const label = `handovers[${index}]`
    if (!isRecord(raw)) {
      report.error('manifest.handovers.item', `\`${label}\` must be an object.`, MANIFEST_FILE)
      return
    }
    const target = raw.target_slug
    if (typeof target !== 'string' || !SLUG_PATTERN.test(target)) {
      report.error(
        'manifest.handovers.target_slug',
        `\`${label}.target_slug\` must be the slug of a sibling agent.`,
        MANIFEST_FILE
      )
      return
    }
    if (target === manifest.slug) {
      report.warn(
        'manifest.handovers.self',
        `\`${label}\` hands over to this same agent.`,
        MANIFEST_FILE
      )
    }
    if (raw.description !== undefined && typeof raw.description !== 'string') {
      report.error(
        'manifest.handovers.description',
        `\`${label}.description\` must be a string.`,
        MANIFEST_FILE
      )
    }
    if (agentDir) {
      // Siblings live next to this folder. Only checkable when the parent reads.
      const sibling = join(agentDir, '..', target)
      try {
        if (!statSync(sibling).isDirectory()) throw new Error('not a directory')
      } catch {
        report.warn(
          'manifest.handovers.target_missing',
          `\`${label}.target_slug\` names "${target}", which is not a folder next to this agent.`,
          MANIFEST_FILE
        )
      }
    }
  })
}

function checkPublications(report: Report, manifest: CinnaAgentManifest): void {
  if (manifest.cloud !== undefined) {
    report.info(
      'manifest.cloud.deprecated',
      'The `cloud` stamp is deprecated. It still reads, and moves into `publications[]` on the next publish.',
      MANIFEST_FILE
    )
  }
  const publications = manifest.publications
  if (publications === undefined) return
  if (!Array.isArray(publications)) {
    report.error('manifest.publications.type', '`publications` must be an array.', MANIFEST_FILE)
    return
  }
  publications.forEach((raw, index) => {
    const label = `publications[${index}]`
    if (!isRecord(raw)) {
      report.error('manifest.publications.item', `\`${label}\` must be an object.`, MANIFEST_FILE)
      return
    }
    for (const key of ['platform_url', 'agent_id'] as const) {
      if (typeof raw[key] !== 'string' || (raw[key] as string).trim() === '') {
        report.error(
          'manifest.publications.required',
          `\`${label}.${key}\` is required.`,
          MANIFEST_FILE
        )
      }
    }
    for (const key of ['workspace', 'imported_at', 'updated_at', 'contract_version', 'content_hash'] as const) {
      const value = raw[key]
      if (value !== undefined && value !== null && typeof value !== 'string') {
        report.error(
          'manifest.publications.field_type',
          `\`${label}.${key}\` must be a string or null.`,
          MANIFEST_FILE
        )
      }
    }
  })
}

/**
 * Validate the manifest object alone — every check that needs no filesystem.
 * Exported so a caller holding a manifest in memory (an editor, a scaffolder)
 * can check it before writing.
 */
export function validateManifest(
  manifest: unknown,
  options: ValidateOptions & { agentDir?: string } = {}
): ValidationReport {
  const report = new Report()
  if (!isRecord(manifest)) {
    report.error('manifest.not_object', `${MANIFEST_FILE} must contain a JSON object.`, MANIFEST_FILE)
    return report.toReport()
  }
  const doc = manifest as CinnaAgentManifest

  checkIdentity(report, doc, options.contractVersion)
  checkString(report, doc.name, 'name', 255, { required: true })
  checkString(report, doc.description, 'description', 2000, { required: true })

  const slug = checkString(report, doc.slug, 'slug', 63, { required: true })
  if (slug !== null) {
    if (!SLUG_PATTERN.test(slug)) {
      report.error(
        'manifest.slug.pattern',
        '`slug` must be lower case, hyphenated, 2–63 characters, starting with a letter or digit.',
        MANIFEST_FILE
      )
    } else if (options.folderName !== undefined && slug !== options.folderName) {
      report.error(
        'manifest.slug.folder_mismatch',
        `\`slug\` is "${slug}" but the folder is named "${options.folderName}". They must match.`,
        MANIFEST_FILE
      )
    }
  }

  if (doc.router_trigger_prompt !== undefined && doc.router_trigger_prompt !== null) {
    checkString(report, doc.router_trigger_prompt, 'router_trigger_prompt', 2000, { required: false })
  }
  if (doc.status_refresh_command !== undefined && doc.status_refresh_command !== null) {
    checkString(report, doc.status_refresh_command, 'status_refresh_command', 1024, { required: false })
  }
  if (doc.kit_version !== undefined && doc.kit_version !== null && typeof doc.kit_version !== 'string') {
    report.error('manifest.kit_version.type', '`kit_version` must be a string or null.', MANIFEST_FILE)
  }
  if (doc.features !== undefined) {
    if (!isRecord(doc.features)) {
      report.error('manifest.features.type', '`features` must be an object.', MANIFEST_FILE)
    } else {
      for (const [key, value] of Object.entries(doc.features)) {
        if (value !== undefined && typeof value !== 'boolean') {
          report.warn(
            'manifest.features.type',
            `\`features.${key}\` should be a boolean.`,
            MANIFEST_FILE
          )
        }
      }
    }
  }

  checkPrompts(report, doc)
  checkExamplePrompts(report, doc)
  checkRuntime(report, doc)
  checkCredentials(report, doc)
  checkSchedules(report, doc)
  checkHandovers(report, doc, options.agentDir)
  checkPublications(report, doc)

  return report.toReport()
}

/** One command from `docs/CLI_COMMANDS.yaml`. */
export interface CatalogCommand {
  name: string
  description: string
  /** As written in the catalog: cloud-first, e.g. `python scripts/x.py`. */
  command: string
}

export interface CommandCatalog {
  /** Commands read exactly as written. Safe to localize and execute. */
  commands: CatalogCommand[]
  /**
   * Entries dropped because the reader is known to mis-read a line inside them.
   * A command that parses to something *shorter* runs a different program, so
   * these are refused rather than corrected.
   */
  unreadable: { name: string | null; line: number; message: string }[]
}

/**
 * Line span of each `- ` entry in a top-level sequence, so a parser issue can be
 * blamed on the entry it falls inside. The catalog is a flat list of maps, which
 * makes this exact rather than a guess.
 */
function sequenceEntrySpans(text: string, key: string): { start: number; end: number }[] {
  const lines = text.split(/\r?\n/)
  const spans: { start: number; end: number }[] = []
  let inKey = false
  let itemIndent = -1
  lines.forEach((raw, index) => {
    const line = index + 1
    const trimmed = raw.trim()
    if (trimmed === '' || trimmed.startsWith('#')) return
    const indent = raw.length - raw.trimStart().length
    if (!inKey) {
      if (indent === 0 && trimmed.startsWith(`${key}:`)) inKey = true
      return
    }
    if (trimmed.startsWith('- ') && (itemIndent === -1 || indent === itemIndent)) {
      itemIndent = indent
      spans.push({ start: line, end: line })
      return
    }
    if (indent <= itemIndent && !trimmed.startsWith('-')) {
      inKey = false
      return
    }
    if (spans.length > 0) spans[spans.length - 1].end = line
  })
  return spans
}

/**
 * Read `docs/CLI_COMMANDS.yaml`. Returns an empty catalog when the file is
 * absent or holds nothing usable — the command rung is optional.
 *
 * Anything the YAML reader flags as outside its subset takes its whole entry
 * with it: these strings are executed later, and a silently truncated command
 * is a *different* command, not a cosmetic defect.
 */
export function readCommandCatalog(agentDir: string, relPath = 'docs/CLI_COMMANDS.yaml'): CommandCatalog {
  let text: string
  try {
    text = readFileSync(join(agentDir, relPath), 'utf8')
  } catch {
    return { commands: [], unreadable: [] }
  }
  const { data, issues } = parseWithIssues(text)
  const raw = data.commands
  if (!Array.isArray(raw)) {
    return {
      commands: [],
      unreadable: issues.map((i) => ({ name: null, line: i.line, message: i.message }))
    }
  }

  const spans = sequenceEntrySpans(text, 'commands')
  const commands: CatalogCommand[] = []
  const unreadable: CommandCatalog['unreadable'] = []

  ;(raw as MiniYamlValue[]).forEach((item, index) => {
    if (item === null || typeof item !== 'object' || Array.isArray(item)) return
    const entry = item as Record<string, MiniYamlValue>
    if (typeof entry.name !== 'string' || typeof entry.command !== 'string') return
    const span = spans[index]
    const touching = span
      ? issues.filter((i) => i.line >= span.start && i.line <= span.end)
      : []
    if (touching.length > 0) {
      for (const issue of touching) {
        unreadable.push({ name: entry.name, line: issue.line, message: issue.message })
      }
      return
    }
    commands.push({
      name: entry.name,
      description: typeof entry.description === 'string' ? entry.description : '',
      command: entry.command
    })
  })

  // An issue outside every entry still means the file is not read as written.
  const claimed = new Set(unreadable.map((u) => u.line))
  for (const issue of issues) {
    if (!claimed.has(issue.line) && !spans.some((s) => issue.line >= s.start && issue.line <= s.end)) {
      unreadable.push({ name: null, line: issue.line, message: issue.message })
    }
  }
  return { commands, unreadable }
}

/** Target names declared in a Makefile, `.PHONY` and pattern rules excluded. */
export function readMakefileTargets(agentDir: string): Set<string> {
  const targets = new Set<string>()
  let text: string
  try {
    text = readFileSync(join(agentDir, 'Makefile'), 'utf8')
  } catch {
    return targets
  }
  for (const line of text.split(/\r?\n/)) {
    if (line.startsWith('\t') || line.trim() === '' || line.trimStart().startsWith('#')) continue
    const match = /^([A-Za-z0-9][A-Za-z0-9_.-]*)\s*:(?!=)/.exec(line)
    if (match) targets.add(match[1])
  }
  return targets
}

/** Directories a validator never needs to walk into, whatever they contain. */
const UNWALKED_DIRS = new Set(['app-data', 'node_modules', '__pycache__', 'venv', 'dist', 'build'])

function listFilesRecursively(dir: string, relBase = ''): string[] {
  let entries: Dirent[]
  try {
    entries = readdirSync(dir, { withFileTypes: true })
  } catch {
    return []
  }
  const out: string[] = []
  for (const entry of entries) {
    // Dotfiles are skipped here on purpose: the one that matters (`credentials/.env`)
    // is checked by path in `checkSecrets`.
    if (UNWALKED_DIRS.has(entry.name) || entry.name.startsWith('.')) continue
    const rel = relBase === '' ? entry.name : `${relBase}/${entry.name}`
    if (entry.isDirectory()) out.push(...listFilesRecursively(join(dir, entry.name), rel))
    else if (entry.isFile()) out.push(rel)
  }
  return out
}

/**
 * The `.gitignore` files that can cover a file inside an agent folder, and how
 * an agent-relative path looks from each one. Ordered outermost first, so the
 * deepest file wins the way git resolves it.
 *
 * **Scope matters and is easy to get wrong.** `credentials/.gitignore` governs
 * `credentials/` and nothing else: a `credentials.json` at the *agent root* is
 * not covered by the `credentials.json` line inside it. Reading every ignore
 * file into one flat set — which this did before — reports such a file as safe
 * when it is committable. That is a false negative in a secret check, so paths
 * are re-based per source and a source that cannot see the file is skipped.
 */
const IGNORE_SOURCES: { file: string; pathFrom: (rel: string, agentDir: string) => string | null }[] = [
  {
    file: '../../.gitignore',
    pathFrom: (rel, agentDir) => `${basename(join(agentDir, '..'))}/${basename(agentDir)}/${rel}`
  },
  { file: '../.gitignore', pathFrom: (rel, agentDir) => `${basename(agentDir)}/${rel}` },
  { file: '.gitignore', pathFrom: (rel) => rel },
  {
    file: 'credentials/.gitignore',
    pathFrom: (rel) => (rel.startsWith('credentials/') ? rel.slice('credentials/'.length) : null)
  }
]

/**
 * Match one `.gitignore` pattern against a path relative to the directory that
 * ignore file sits in. Covers the subset git users actually write here: a
 * pattern containing a slash is anchored to that directory; one without matches
 * any path segment at any depth; a trailing slash restricts it to directories.
 * Character classes and `**` inside a segment are left to `matchesPattern`.
 */
function ignorePatternMatches(pattern: string, path: string): boolean {
  const isDirOnly = pattern.endsWith('/')
  const trimmed = pattern.replace(/\/+$/, '')
  // Anchoring is decided from the pattern *as written*: git anchors on a leading
  // slash as well as an interior one. Deciding it after stripping the leading
  // slash makes `/credentials.json` unanchored, so it would report a nested
  // `scripts/credentials.json` as ignored when git would happily commit it — a
  // false negative in a secret check, which is the direction that leaks.
  const anchored = trimmed.includes('/')
  const body = trimmed.replace(/^\//, '')
  if (body === '') return false
  if (anchored) {
    return matchesPattern(isDirOnly ? `${body}/` : body, path)
  }
  const segments = path.split('/')
  // An unanchored pattern matches a file name, or a directory anywhere above it.
  const candidates = isDirOnly ? segments.slice(0, -1) : segments
  return candidates.some((segment) => matchesPattern(body, segment))
}

/**
 * Whether git would ignore an agent-relative path, decided from the ignore
 * files rather than by shelling out to git (the folder may not be a repository
 * at all, and a validator must not depend on one). Last match wins, deepest
 * ignore file last, negations honoured.
 */
function isIgnoredPath(agentDir: string, rel: string): boolean {
  let ignored = false
  for (const source of IGNORE_SOURCES) {
    const path = source.pathFrom(rel, agentDir)
    if (path === null) continue
    let text: string
    try {
      text = readFileSync(join(agentDir, source.file), 'utf8')
    } catch {
      continue
    }
    for (const line of text.split(/\r?\n/)) {
      const rule = line.trim()
      if (rule === '' || rule.startsWith('#')) continue
      const negated = rule.startsWith('!')
      const pattern = negated ? rule.slice(1) : rule
      if (ignorePatternMatches(pattern, path)) ignored = !negated
    }
  }
  return ignored
}

/**
 * Files that can hold a credential *value*. This list is one of four copies of
 * the same rule and they must not drift. The other three are
 * `cloud_import_excludes` in `layout.json` (what never travels),
 * `templates/agent/gitignore` (what an agent never commits) and
 * `templates/root/gitignore` (the workshop-wide net, which catches a secret
 * dropped before any agent is scaffolded). Change one, change all four —
 * `credentials.json` in particular is what the platform injects at the agent
 * root and what `scripts/cinna_credentials.py` reads in the cloud, so a folder
 * that has ever run there can carry live values home.
 */
function isSecretFile(rel: string): boolean {
  const name = basename(rel)
  if (name.endsWith('.env.example')) return false
  return (
    name === 'credentials.json' ||
    name === '.env' ||
    name.endsWith('.env') ||
    name.endsWith('.pem') ||
    name.endsWith('.key') ||
    name.endsWith('.p12')
  )
}

function checkSecrets(report: Report, agentDir: string, layout?: LayoutView): void {
  const secretFiles = listFilesRecursively(agentDir).filter(isSecretFile)
  // The walk skips dotfiles, so check the dotted paths the contract names.
  for (const dotted of ['credentials/.env', '.env']) {
    if (existsSync(join(agentDir, dotted))) secretFiles.push(dotted)
  }
  if (secretFiles.length === 0) return

  for (const rel of secretFiles) {
    if (!isIgnoredPath(agentDir, rel)) {
      report.error(
        'secrets.not_ignored',
        `${rel} can hold credential values and no .gitignore rule covers it. Add it to the agent's .gitignore before committing anything.`,
        rel
      )
    }
    if (layout && !layout.isExcludedFromExport(rel)) {
      report.error(
        'secrets.exported',
        `${rel} can hold credential values and would travel to the cloud. The contract's exclude list must drop it.`,
        rel
      )
    }
  }
}

function checkFiles(
  report: Report,
  agentDir: string,
  manifest: CinnaAgentManifest,
  options: ValidateOptions
): void {
  // 1. Prompt files the manifest points at must exist and say something.
  const prompts = isRecord(manifest.prompts) ? manifest.prompts : {}
  for (const [key, value] of Object.entries(prompts)) {
    if (typeof value !== 'string' || value.trim() === '') continue
    const abs = join(agentDir, value)
    if (!existsSync(abs)) {
      report.error(
        'files.prompt_missing',
        `\`prompts.${key}\` points at ${value}, which does not exist.`,
        value
      )
      continue
    }
    try {
      if (readFileSync(abs, 'utf8').trim() === '') {
        report.warn('files.prompt_empty', `${value} is empty.`, value)
      }
    } catch (err) {
      report.error('files.prompt_unreadable', `${value} could not be read.`, value)
      logger.warn('prompt file unreadable', { agentDir, value, error: err })
    }
  }

  // 2. Every catalogued command needs a Makefile target to run it locally.
  const catalogPath = options.layout?.layout.agent.command_catalog ?? 'docs/CLI_COMMANDS.yaml'
  const { commands, unreadable } = readCommandCatalog(agentDir, catalogPath)
  for (const entry of unreadable) {
    // An ERROR, not a warning: a host would otherwise offer a /run: button that
    // executes a command this app read differently from what is written.
    report.error(
      'commands.unparseable',
      entry.name === null
        ? `${catalogPath} line ${entry.line}: ${entry.message}`
        : `Command "${entry.name}" cannot be read as written and will not be offered. ${catalogPath} line ${entry.line}: ${entry.message}`,
      catalogPath
    )
  }
  const names = new Set<string>()
  if (commands.length > 0) {
    const targets = readMakefileTargets(agentDir)
    for (const command of commands) {
      if (!COMMAND_NAME_PATTERN.test(command.name)) {
        report.error(
          'commands.name_invalid',
          `Command "${command.name}" is not a usable /run: name.`,
          catalogPath
        )
      }
      if (names.has(command.name)) {
        report.error('commands.duplicate', `Two commands are both named "${command.name}".`, catalogPath)
      }
      names.add(command.name)
      if (!targets.has(command.name)) {
        report.warn(
          'commands.makefile_target_missing',
          `Command "${command.name}" has no \`${command.name}:\` target in the Makefile, so it cannot be run locally by hand.`,
          'Makefile'
        )
      }
    }
  }

  // 3. `/run:<name>` in status_refresh_command must resolve to one of them.
  const refresh = manifest.status_refresh_command
  if (typeof refresh === 'string' && refresh.trim() !== '') {
    const reference = RUN_REFERENCE_PATTERN.exec(refresh.trim())
    if (reference && !names.has(reference[1])) {
      report.error(
        'commands.run_reference_unresolved',
        `\`status_refresh_command\` refers to /run:${reference[1]}, which is not in ${catalogPath}.`,
        MANIFEST_FILE
      )
    }
  }

  // 4. Every script is catalogued, or the agent tells users to run what is gone.
  const scripts = listFilesRecursively(join(agentDir, 'scripts')).filter((rel) =>
    rel.endsWith('.py') && basename(rel) !== '__init__.py'
  )
  if (scripts.length > 0) {
    let catalog: string | null = null
    try {
      catalog = readFileSync(join(agentDir, 'scripts/README.md'), 'utf8')
    } catch {
      catalog = null
    }
    if (catalog === null) {
      report.warn(
        'scripts.catalog_missing',
        'scripts/ has scripts but no scripts/README.md cataloguing them.',
        'scripts/README.md'
      )
    } else {
      for (const rel of scripts) {
        if (!catalog.includes(basename(rel))) {
          report.warn(
            'scripts.uncatalogued',
            `scripts/${rel} is not mentioned in scripts/README.md.`,
            `scripts/${rel}`
          )
        }
      }
    }
  }

  // 5. STATUS.md, when the agent writes one, must be readable as frontmatter.
  const statusPath = options.layout?.layout.agent.status_file ?? 'app-data/storage/STATUS.md'
  const statusAbs = join(agentDir, statusPath)
  if (existsSync(statusAbs)) {
    let frontmatter: ReturnType<typeof parseFrontmatter> = null
    try {
      frontmatter = parseFrontmatter(readFileSync(statusAbs, 'utf8'))
    } catch {
      frontmatter = null
    }
    if (!frontmatter) {
      report.warn(
        'status.frontmatter_missing',
        `${statusPath} has no YAML frontmatter, so no host can read a status from it.`,
        statusPath
      )
    } else if (typeof frontmatter.data.status !== 'string') {
      report.warn('status.field_missing', `${statusPath} has no \`status\` field.`, statusPath)
    }
  }

  // 6. Nothing secret is exposed.
  checkSecrets(report, agentDir, options.layout)

  // 7. Informational: this folder predates the contract in use.
  if (
    typeof manifest.contract_version === 'string' &&
    options.contractVersion !== undefined &&
    compareVersionStrings(manifest.contract_version, options.contractVersion) < 0
  ) {
    report.info(
      'contract.older',
      `This agent was scaffolded against contract ${manifest.contract_version}; the app is on ${options.contractVersion}. That is information, not a defect.`,
      MANIFEST_FILE
    )
  }
}

function merge(into: Report, from: ValidationReport): void {
  into.errors.push(...from.errors)
  into.warnings.push(...from.warnings)
  into.infos.push(...from.infos)
}

/**
 * Validate an agent folder: the manifest, then everything about it that only
 * the folder can answer.
 *
 * @param agentDir absolute path of the agent folder
 */
export function validateAgentFolder(
  agentDir: string,
  options: ValidateFolderOptions
): ValidationReport {
  const report = new Report()
  try {
    const folderName = options.folderName ?? basename(agentDir)

    let manifest: CinnaAgentManifest
    try {
      manifest = readWithStamp(join(agentDir, MANIFEST_FILE)).manifest
    } catch (err) {
      if (err instanceof KitError) {
        report.error(`manifest.${err.code}`, err.message, MANIFEST_FILE)
      } else {
        logger.error('unexpected failure reading a manifest', { agentDir, error: err })
        report.error(
          'manifest.unreadable',
          `${MANIFEST_FILE} could not be read.`,
          MANIFEST_FILE
        )
      }
      return report.toReport()
    }

    merge(report, validateManifest(manifest, { ...options, folderName, agentDir }))
    checkFiles(report, agentDir, manifest, options)
  } catch (err) {
    // A validator that throws takes the scanner with it. Report and move on.
    logger.error('validation failed unexpectedly', { agentDir, error: err })
    report.error(
      'validator.failed',
      'This folder could not be validated.',
      undefined
    )
  }
  return report.toReport()
}

/** True when nothing blocks running or publishing this agent. */
export function isValid(report: ValidationReport): boolean {
  return report.errors.length === 0
}
