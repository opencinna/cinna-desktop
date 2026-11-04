/**
 * The components a kit agent has: its own `dashboards/<name>/component.json`
 * and those its skills ship in `<skill>/dashboards/<name>/` (README D15,
 * `x-skill-components`), read and validated by the rules cinna-core's
 * `check_component.py` applies. Reading runs nothing.
 *
 * **Findings are core's.** Every rule reports the `(path, code, field)` triple
 * the reference checker reports (`x-check-codes`, `x-script-only-checks` in
 * `protocols/dashboards.schema.json`), errors and warnings, with agent-relative
 * paths, so a card and the agent's own check never disagree.
 * `conformance.test.ts` runs this validator over the kit's conformance cases.
 * Only the `--run` checks are not here: the desktop runs a source when the
 * user asks, never to validate.
 *
 * Read on demand rather than cached: a component is a handful of small files,
 * and a fresh read is what makes "a tile references, never copies" hold — the
 * agent edits its component and the next render shows it. The folder watcher
 * already announces the change (`local-agent:changed`), and the renderer reads
 * the components again on it.
 *
 * A skill's folder (authored, catalog or marketplace cache) is only ever read.
 *
 * Core module: no Electron.
 */

import { lstatSync, readdirSync, readFileSync, realpathSync, statSync, type Dirent } from 'node:fs'
import { basename, dirname, join, sep } from 'node:path'
import { getLayout } from '../../kit/contractStore'
import {
  COMPONENT_NAME_PATTERN,
  DASHBOARDS_SCHEMA_VERSION,
  ENDPOINT_NAME_PATTERN,
  ENDPOINT_RUNTIMES,
  ENDPOINT_TIMEOUT_DEFAULT_S,
  ENDPOINT_TIMEOUT_MAX_S,
  FILE_SOURCE_EXTENSIONS,
  FILE_SOURCE_ROOTS,
  MAX_PROMPTS,
  MAX_PROMPT_LABEL,
  MAX_PROMPT_TEXT,
  MIN_WHILE_OPEN_EVERY_MS,
  PARAM_NAME_PATTERN,
  PARAM_TYPES,
  type EndpointRuntime
} from '../../kit/dashboardsProtocol'
import { RUN_REFERENCE_PATTERN } from '../../../shared/kit/manifest'
import {
  DASHBOARD_VIEW_KINDS,
  DEFAULT_MAX_AGE,
  MAX_TILE_TITLE_LENGTH,
  TILE_SIZES,
  isTileSize,
  parseDuration,
  type ComponentFinding,
  type ComponentInfo,
  type ComponentParamSpec,
  type ComponentPrompt,
  type ComponentRefreshRule,
  type ComponentSource,
  type DashboardViewKind,
  type TileSize
} from '../../../shared/dashboards'

/** The component file inside its folder. */
export const COMPONENT_FILE = 'component.json'

/** A skill ships its components here, inside its own folder (`x-skill-components`). */
export const SKILL_DASHBOARDS_DIR = 'dashboards'

/** The agent-relative folder authored skills live in. */
const SKILLS_DIR = 'skills'

/** The agent's manifest, read for `credentials[]` and `schedules[]`. */
const MANIFEST_FILE = 'cinna-agent.json'

/** The command catalog `refresh.command` is checked against (the checker reads this path). */
const COMMAND_CATALOG = 'docs/CLI_COMMANDS.yaml'

/** At most this many components are read per agent (own and skills' together). */
export const MAX_COMPONENTS_PER_AGENT = 100

/** A `component.json` larger than this is refused unread. */
const MAX_COMPONENT_FILE_BYTES = 256 * 1024

/** Content scans: page files larger than this, or past this many, are not read (a guard; the checker has none). */
const MAX_SCANNED_PAGE_BYTES = 2 * 1024 * 1024
const MAX_SCANNED_PAGE_FILES = 300

/** Folders neither the checker nor this scanner treats as a component or page folder. */
const SKIP_DIRS = new Set(['.git', '.venv', '__pycache__', 'node_modules', '.mypy_cache', '.ruff_cache'])

const DESCRIPTION_MAX = 1000
const CONTEXT_MAX = 4000
const PARAM_LABEL_MAX = 120
const ENUM_VALUE_MAX = 200
const SCHEDULE_NAME_MAX = 255
const DEFAULT_ENTRY = 'index.html'
const MONTH_RE = /^[0-9]{4}-(0[1-9]|1[0-2])$/
const DATE_RE = /^[0-9]{4}-(0[1-9]|1[0-2])-(0[1-9]|[12][0-9]|3[01])$/
/** The checker's duration: any number of digits (the shared `parseDuration` caps them for scheduling). */
const DURATION_RE = /^([1-9][0-9]*)(s|m|h|d)$/
const DURATION_UNIT_S: Record<string, number> = { s: 1, m: 60, h: 3600, d: 86400 }

/**
 * The agent-relative folder components live in: the layout's `dashboards`
 * role (contract 1.19.0+), the way `artifactsFolderRole()` reads `artifacts`.
 * Falls back to `dashboards`, the path 1.19 gives it, when a workshop's own
 * older kit (before 1.19.0) has no such role.
 */
export function dashboardsFolderRole(workshopRoot?: string): string {
  try {
    const role = getLayout(workshopRoot).agent.roles.find((entry) => entry.role === 'dashboards' && entry.kind === 'directory')
    if (role) return role.path.replace(/\/+$/, '')
  } catch {
    // An unreadable contract: the fallback below.
  }
  // A contract before 1.19.0 has no `dashboards` role: the path 1.19 gives it.
  return 'dashboards'
}

/** A skill the agent resolves, and where its folder is. */
export interface ComponentSkillFolder {
  /** The skill's name: the folder name every engine is given it under. */
  name: string
  /** Absolute skill folder: the agent's `skills/<name>/`, or a read-only cache copy. */
  dir: string
}

/** A kit agent as the scanner needs it. */
export interface ComponentAgent {
  id: string
  manifestId: string
  name: string
  /** Absolute agent folder. */
  path: string
  /** The root it sits in, for the layout. */
  rootPath?: string
  /** The kit manifest's slug (references by slug). */
  slug?: string
  /**
   * The parsed `cinna-agent.json` (`credentials[]`, `schedules[]`). Undefined
   * reads it from the folder; null is "no readable manifest" (`manifest_missing`).
   */
  manifest?: unknown
  /**
   * Each credential slot and whether it is ready for this agent (README D16).
   * Undefined when not known: then nothing is reported missing.
   */
  credentialSlots?: ReadonlyArray<{ name: string; ready: boolean }>
  /** The skills the agent resolves (authored, catalog cache, marketplace cache), found when needed. */
  skills?: () => ComponentSkillFolder[]
  /** The agent's bundle id (manifest `bundle.bundle_id`, else `desktop.json` `shared_remote.bundle_id`), found when needed. */
  bundleId?: () => string | null
}

export interface ComponentEndpoint {
  name: string
  /** Relative to the component folder (`api/<file>`), normalized. */
  script: string
  runtime: EndpointRuntime
  timeoutS: number
}

/** A valid `component.json`, normalized. */
export interface ComponentSpec {
  title: string
  description: string
  view: DashboardViewKind
  /** html only: the page, relative to the component folder. */
  entry: string
  source: ComponentSource
  endpoints: Record<string, ComponentEndpoint>
  params: Record<string, ComponentParamSpec>
  maxAge: string
  maxAgeMs: number
  refreshCommand: string | null
  /** `refresh.after_turn`: re-read the tile when a turn of its agent ends (README D3). */
  afterTurn: boolean
  /** `refresh.while_open_every` (≥ 1m), or null. */
  whileOpenEvery: string | null
  /** `refresh.on_app_start`: warm up once after the profile is ready (README D4). */
  onAppStart: boolean
  /** `refresh.schedule`: the manifest schedule whose runs write what the source reads, or null. */
  schedule: string | null
  /** `prompts[]`, trimmed: the suggested questions (README D13). */
  prompts: ComponentPrompt[]
  size: TileSize
  /** `requires_credentials`, as written. */
  requiresCredentials: string[]
}

export interface ScannedComponent {
  info: ComponentInfo
  /** Null when the component has an error finding. */
  spec: ComponentSpec | null
  /** Absolute, realpath'd component folder (a refused symlink: the link itself, never followed). */
  dir: string
  /** Its agent-relative path (`dashboards/deals`, `skills/crm/dashboards/deals`), as findings name it. */
  shownDir: string
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value)
}

const has = (obj: Record<string, unknown>, key: string): boolean => Object.prototype.hasOwnProperty.call(obj, key)

/** The checker's `_is_str`: a string whose trimmed length is at least `min` and whole length at most `max`. */
function isStr(value: unknown, max: number, min = 1): value is string {
  return typeof value === 'string' && value.trim().length >= min && value.length <= max
}

/** The checker's `_safe_relative`: normalized POSIX segments, or null (absolute, backslash, drive, `..`). */
function safeRelative(value: string): string[] | null {
  if (!value || value.includes('\\') || value.startsWith('/') || /^[A-Za-z]:/.test(value)) return null
  const parts = value.split('/').filter((part) => part !== '' && part !== '.')
  if (parts.length === 0 || parts.some((part) => part === '..')) return null
  return parts
}

/** `PurePosixPath.suffix`: the last segment's extension, `''` for none or a dotfile. */
function suffixOf(parts: string[]): string {
  const name = parts[parts.length - 1] ?? ''
  const at = name.lastIndexOf('.')
  return at > 0 && at < name.length - 1 ? name.slice(at) : ''
}

/** Seconds for `30s`, `15m`, `6h`, `1d`; null when it does not parse. */
function durationSeconds(value: unknown): number | null {
  if (typeof value !== 'string') return null
  const match = DURATION_RE.exec(value)
  return match ? Number(match[1]) * DURATION_UNIT_S[match[2]] : null
}

function isWithin(root: string, candidate: string): boolean {
  return candidate === root || candidate.startsWith(root + sep)
}

/** `Path.resolve()` (non-strict): every symlink that exists resolved, the rest appended. */
function resolveLoose(path: string): string {
  try {
    return realpathSync(path)
  } catch {
    const parent = dirname(path)
    return parent === path ? path : join(resolveLoose(parent), basename(path))
  }
}

/** With symlinks resolved, `path` stays within `root` (already realpath'd). */
function inside(path: string, root: string): boolean {
  return isWithin(root, resolveLoose(path))
}

function isFile(path: string): boolean {
  try {
    return statSync(path).isFile()
  } catch {
    return false
  }
}

function isDir(path: string): boolean {
  try {
    return statSync(path).isDirectory()
  } catch {
    return false
  }
}

function realOrNull(path: string): string | null {
  try {
    return realpathSync(path)
  } catch {
    return null
  }
}

function readText(path: string): string {
  return readFileSync(path, 'utf8').replace(/^﻿/, '')
}

/** The agent's `cinna-agent.json` as an object, or null when there is none or it does not parse. */
export function readAgentManifest(agentDir: string): Record<string, unknown> | null {
  try {
    const doc: unknown = JSON.parse(readText(join(agentDir, MANIFEST_FILE)))
    return isRecord(doc) ? doc : null
  } catch {
    return null
  }
}

/** The checker's `_names`: the `name`s of a manifest list; null with no manifest. */
function manifestNames(manifest: Record<string, unknown> | null, key: string): Set<string> | null {
  if (!manifest) return null
  const entries = manifest[key]
  if (!Array.isArray(entries)) return new Set()
  return new Set(entries.filter((e) => isRecord(e) && typeof e.name === 'string').map((e) => (e as { name: string }).name))
}

/** `- name:` entries of `docs/CLI_COMMANDS.yaml`, by the checker's line scan; null when unreadable. */
export function readCommandNames(agentDir: string): Set<string> | null {
  let text: string
  try {
    text = readText(join(agentDir, COMMAND_CATALOG))
  } catch {
    return null
  }
  const names = new Set<string>()
  for (const line of text.split(/\r\n|\r|\n/)) {
    const match = /^\s*-\s+name:\s*['"]?([A-Za-z0-9][A-Za-z0-9_-]*)['"]?\s*$/.exec(line)
    if (match) names.add(match[1])
  }
  return names
}

class Findings {
  readonly list: ComponentFinding[] = []
  error(path: string, code: string, message: string, field: string | null = null): void {
    this.list.push({ path, code, field, severity: 'error', message })
  }
  warn(path: string, code: string, message: string, field: string | null = null): void {
    this.list.push({ path, code, field, severity: 'warning', message })
  }
  get hasErrors(): boolean {
    return this.list.some((f) => f.severity === 'error')
  }
  /** Errors first, each group in the order found. */
  sorted(): ComponentFinding[] {
    return [...this.list.filter((f) => f.severity === 'error'), ...this.list.filter((f) => f.severity === 'warning')]
  }
}

/* ------------------------------------------------------------ content scans */

/** A web view gets no network (README D9): these references would be blocked. */
const HTML_NETWORK_RE = /\b(?:src|href)\s*=\s*["'](?:https?:)?\/\//i
const CSS_NETWORK_RE = /(?:@import\s+|url\(\s*)["']?(?:https?:)?\/\//i
const JS_NETWORK_RE = /(?:\bfrom\s+|\bimport\s*\(\s*|\bfetch\s*\(\s*|\bnew\s+WebSocket\s*\(\s*)["'`](?:https?:|wss?:)?\/\//

const PAGE_SCAN_EXTENSIONS = new Set(['.html', '.htm', '.css', '.js', '.mjs'])
const HTML_EXTENSIONS = new Set(['.html', '.htm'])

/** A single leading `/`; `//host` is network_reference's. */
const ROOT = String.raw`\/(?![/*])`
const QUOTED_ROOT = String.raw`["'\x60]\/(?![/*])`
type Rule = readonly [field: string, pattern: RegExp]
const HTML_ATTR_ROOT: Rule[] = [
  ['src', new RegExp(String.raw`(?<![\w$])src\s*=\s*["']?` + ROOT, 'i')],
  ['href', new RegExp(String.raw`(?<![\w$])href\s*=\s*["']?` + ROOT, 'i')]
]
const SCRIPT_ATTR_ROOT: Rule[] = [
  ['src', new RegExp(String.raw`(?<![\w$])src\s*=\s*` + QUOTED_ROOT)],
  ['href', new RegExp(String.raw`(?<![\w$])href\s*=\s*` + QUOTED_ROOT)]
]
const SHARED_ROOT: Rule[] = [
  ['url', new RegExp(String.raw`(?<![\w$.-])url\(\s*["']?` + ROOT)],
  ['import', new RegExp(String.raw`(?:\bfrom\s+|\bimport\s*\(\s*|\bimport\s+|@import\s+)` + QUOTED_ROOT)]
]
const REQUEST_ROOT: Rule[] = [
  ['fetch', new RegExp(String.raw`\bfetch\s*\(\s*` + QUOTED_ROOT + String.raw`(?!api\/)`)],
  ['XMLHttpRequest', new RegExp(String.raw`\.open\s*\(\s*["'\x60][A-Za-z]+["'\x60]\s*,\s*` + QUOTED_ROOT + String.raw`(?!api\/)`)]
]
const ROOT_RELATIVE: Record<string, Rule[]> = {
  '.html': [...HTML_ATTR_ROOT, ...SHARED_ROOT, ...REQUEST_ROOT],
  '.htm': [...HTML_ATTR_ROOT, ...SHARED_ROOT, ...REQUEST_ROOT],
  '.js': [...SCRIPT_ATTR_ROOT, ...SHARED_ROOT, ...REQUEST_ROOT],
  '.mjs': [...SCRIPT_ATTR_ROOT, ...SHARED_ROOT, ...REQUEST_ROOT],
  '.css': SHARED_ROOT
}
const BASE_TAG_RE = /<base\b/i
const FETCH_ENDPOINT: Rule[] = [
  ['fetch', /\bfetch\s*\(\s*["'`](?:\.?\/)?api\//],
  ['XMLHttpRequest', /\.open\s*\(\s*["'`][A-Za-z]+["'`]\s*,\s*["'`](?:\.?\/)?api\//]
]
const SANDBOX_UNSUPPORTED: Rule[] = [
  ['Worker', /\bnew\s+Worker\s*\(/],
  ['iframe', /<iframe\b/i],
  ['eval', /(?<![\w$])eval\s*\(/],
  ['Function', /\bnew\s+Function\s*\(/],
  ['WebAssembly', /(?<![\w$])WebAssembly\./],
  ['localStorage', /(?<![\w$])localStorage(?![\w$])/],
  ['sessionStorage', /(?<![\w$])sessionStorage(?![\w$])/],
  ['indexedDB', /(?<![\w$])indexedDB(?![\w$])/],
  ['document.cookie', /(?<![\w$])document\.cookie(?![\w$])/],
  ['window.open', /(?<![\w$])window\.open\s*\(/]
]
const SANDBOX_REASONS: Record<string, string> = {
  Worker: 'Web Workers are blocked (worker-src \'none\')',
  iframe: 'frames are blocked (frame-src \'none\')',
  eval: 'there is no \'unsafe-eval\', so eval throws',
  Function: 'there is no \'unsafe-eval\', so new Function throws',
  WebAssembly: 'there is no \'wasm-unsafe-eval\', so WebAssembly does not compile',
  localStorage: 'the origin is opaque, so localStorage throws SecurityError',
  sessionStorage: 'the origin is opaque, so sessionStorage throws SecurityError',
  indexedDB: 'the origin is opaque, so IndexedDB throws SecurityError',
  'document.cookie': 'the origin is opaque, so cookies throw SecurityError',
  'window.open': 'popups and top navigation are blocked; use cinna.openLink(url)'
}

const hits = (text: string, rules: readonly Rule[]): string[] => rules.filter(([, pattern]) => pattern.test(text)).map(([field]) => field)

function extLower(name: string): string {
  return suffixOf([name]).toLowerCase()
}

/**
 * The page files a web view's content scans read: every .html, .htm, .css,
 * .js and .mjs in the component outside its top-level `api/` (never served),
 * skipping dot and tool folders, plus the entry. Component-relative POSIX.
 * A file that resolves outside the component is not read.
 */
function pageFiles(componentDir: string, entryParts: string[] | null): string[] {
  const found: string[] = []
  const walk = (dir: string, rel: string[]): void => {
    if (found.length >= MAX_SCANNED_PAGE_FILES) return
    let entries: Dirent[]
    try {
      entries = readdirSync(dir, { withFileTypes: true })
    } catch {
      return
    }
    const files = entries.filter((e) => !e.isDirectory()).map((e) => e.name).sort()
    for (const name of files) {
      if (PAGE_SCAN_EXTENSIONS.has(extLower(name))) found.push([...rel, name].join('/'))
    }
    // os.walk without followlinks: a symlinked folder is listed, never entered.
    const dirs = entries
      .filter((e) => e.isDirectory() && !SKIP_DIRS.has(e.name) && !e.name.startsWith('.'))
      .map((e) => e.name)
      .filter((name) => !(rel.length === 0 && name === 'api'))
      .sort()
    for (const name of dirs) walk(join(dir, name), [...rel, name])
  }
  walk(componentDir, [])
  if (entryParts) {
    const entry = entryParts.join('/')
    const path = join(componentDir, ...entryParts)
    if (isFile(path) && inside(path, componentDir) && !found.includes(entry)) found.push(entry)
  }
  return found.slice(0, MAX_SCANNED_PAGE_FILES)
}

function scanPage(componentDir: string, rel: string, shown: string, out: Findings): void {
  const path = join(componentDir, ...rel.split('/'))
  let text: string
  try {
    if (!inside(path, componentDir)) return
    const info = statSync(path)
    if (!info.isFile() || info.size > MAX_SCANNED_PAGE_BYTES) return
    text = readFileSync(path, 'utf8')
  } catch {
    return
  }
  const suffix = extLower(rel.split('/').pop() ?? '')
  const network = HTML_EXTENSIONS.has(suffix) ? HTML_NETWORK_RE : suffix === '.css' ? CSS_NETWORK_RE : JS_NETWORK_RE
  if (network.test(text)) {
    out.warn(shown, 'network_reference', 'loads something from the network; a web view gets none. Bundle it into the folder and use a relative path.')
  }
  for (const field of hits(text, ROOT_RELATIVE[suffix] ?? [])) {
    out.error(shown, 'root_relative_path', `a \`${field}\` path starts with \`/\`, which resolves outside the component's own folder and is blocked. Write \`./app.js\` or \`app.js\`.`, field)
  }
  if (HTML_EXTENSIONS.has(suffix) && BASE_TAG_RE.test(text)) {
    out.error(shown, 'base_tag', 'has a `<base>` tag; the sandbox refuses it (base-uri \'none\'). Remove it and use relative paths.')
  }
  for (const field of hits(text, FETCH_ENDPOINT)) {
    out.error(shown, 'fetch_endpoint', `\`${field}\` asks for api/, which is never served to a page. Get the source through cinna.onData and other endpoints through cinna.call.`, field)
  }
  for (const field of hits(text, SANDBOX_UNSUPPORTED)) {
    out.warn(shown, 'sandbox_unsupported', `uses \`${field}\`: ${SANDBOX_REASONS[field]} in a web view.`, field)
  }
}

/* ------------------------------------------------------------ static checks */

export interface ValidationContext {
  /** Absolute, realpath'd component folder. */
  componentDir: string
  /** Absolute, realpath'd agent folder, or null when there is none (no symlink check on `source.file`). */
  agentDir: string | null
  /** Agent-relative path of the component folder (`dashboards/deals`, `skills/crm/dashboards/deals`). */
  shownDir: string
  /** The agent's manifest, or null when there is none (`manifest_missing`). */
  manifest: Record<string, unknown> | null
  /** `docs/CLI_COMMANDS.yaml` names, or null when unreadable (no `refresh_command_unknown`). */
  commandNames: Set<string> | null
  /**
   * False for a component whose folder is not on this machine (a cloud
   * agent's, D6): no file is looked at — no script, entry or page check.
   * Its findings are the server's; only the normalized spec is used.
   */
  files?: boolean
}

/**
 * `component.json` (already parsed to an object) by the checker's rules. Every
 * finding carries core's code; the spec is returned only when no finding is
 * an error.
 */
export function validateComponentSpec(doc: Record<string, unknown>, ctx: ValidationContext): { spec: ComponentSpec | null; findings: ComponentFinding[] } {
  const out = new Findings()
  const at = `${ctx.shownDir}/${COMPONENT_FILE}`

  // schema_version
  if (!has(doc, 'schema_version')) out.error(at, 'required', '`schema_version` is required (1).', 'schema_version')
  else if (doc.schema_version !== DASHBOARDS_SCHEMA_VERSION) {
    out.error(at, 'invalid_value', `\`schema_version\` ${JSON.stringify(doc.schema_version)} is not ${DASHBOARDS_SCHEMA_VERSION} (dashboards/1).`, 'schema_version')
  }

  // Text fields, size, prompts
  if (!has(doc, 'title')) out.error(at, 'required', '`title` is required.', 'title')
  else if (!isStr(doc.title, MAX_TILE_TITLE_LENGTH)) out.error(at, 'invalid_value', `\`title\` must be text of 1 to ${MAX_TILE_TITLE_LENGTH} characters.`, 'title')
  if (has(doc, 'description') && !isStr(doc.description, DESCRIPTION_MAX, 0)) {
    out.error(at, 'invalid_value', `\`description\` must be text of at most ${DESCRIPTION_MAX} characters.`, 'description')
  }
  if (has(doc, 'context') && !isStr(doc.context, CONTEXT_MAX, 0)) {
    out.error(at, 'invalid_value', `\`context\` must be text of at most ${CONTEXT_MAX} characters.`, 'context')
  }
  if (has(doc, 'size') && !isTileSize(doc.size)) out.error(at, 'invalid_value', `\`size\` must be one of ${TILE_SIZES.join(', ')}.`, 'size')
  if (doc.prompts !== undefined && doc.prompts !== null) {
    if (!Array.isArray(doc.prompts) || doc.prompts.length > MAX_PROMPTS) {
      out.error(at, 'invalid_value', `\`prompts\` must be a list of at most ${MAX_PROMPTS}.`, 'prompts')
    } else {
      const bad = doc.prompts.findIndex((p) => !(isRecord(p) && isStr(p.label, MAX_PROMPT_LABEL) && isStr(p.prompt, MAX_PROMPT_TEXT)))
      if (bad >= 0) out.error(at, 'invalid_value', `\`prompts[${bad}]\` needs a \`label\` (≤ ${MAX_PROMPT_LABEL}) and a \`prompt\` (≤ ${MAX_PROMPT_TEXT}).`, 'prompts')
    }
  }

  // view
  const rawView = doc.view
  if (rawView === undefined || rawView === null) out.error(at, 'required', `\`view\` is required: one of ${DASHBOARD_VIEW_KINDS.join(', ')}.`, 'view')
  else if (!(DASHBOARD_VIEW_KINDS as readonly unknown[]).includes(rawView)) {
    out.error(at, 'invalid_value', `\`view\` ${JSON.stringify(rawView)} must be one of ${DASHBOARD_VIEW_KINDS.join(', ')}.`, 'view')
  }
  const view = (DASHBOARD_VIEW_KINDS as readonly unknown[]).includes(rawView) ? (rawView as DashboardViewKind) : null

  // endpoints
  const endpoints: Record<string, ComponentEndpoint> = {}
  const rawEndpoints = doc.endpoints
  if (rawEndpoints !== undefined && rawEndpoints !== null) {
    if (!isRecord(rawEndpoints)) out.error(at, 'invalid_type', '`endpoints` must be an object of name → {script}.', 'endpoints')
    else {
      for (const [name, spec] of Object.entries(rawEndpoints)) {
        const field = `endpoints.${name}`
        if (!ENDPOINT_NAME_PATTERN.test(name)) {
          out.error(at, 'endpoint_name_invalid', `endpoint \`${field}\`: names use letters, digits and \`_\` only.`, field)
          continue
        }
        if (!isRecord(spec)) {
          out.error(at, 'invalid_type', `\`${field}\` must be an object with a \`script\`.`, field)
          continue
        }
        const script = spec.script
        if (typeof script !== 'string' || !script) {
          out.error(at, 'required', `\`${field}.script\` is required.`, `${field}.script`)
          continue
        }
        const parts = safeRelative(script)
        if (!parts) {
          out.error(at, 'script_outside_component', `\`${field}.script\` must be a path inside the component folder, like api/${name}.py.`, `${field}.script`)
          continue
        }
        const runtime = (ENDPOINT_RUNTIMES as Record<string, EndpointRuntime>)[suffixOf(parts)]
        if (!runtime) {
          out.error(at, 'script_extension', `\`${field}.script\` ${script}: an endpoint is .py, .js, .mjs or .cjs (lowercase).`, `${field}.script`)
          continue
        }
        const target = join(ctx.componentDir, ...parts)
        if (ctx.files === false) {
          // Not on this machine: the server checked the file.
        } else if (!inside(target, ctx.componentDir)) {
          out.error(at, 'symlink_escape', `\`${field}.script\` ${script} leads outside the component folder through a symlink.`, `${field}.script`)
          continue
        }
        if (ctx.files !== false && !isFile(target)) {
          out.error(at, 'script_missing', `\`${field}.script\` names ${script}, which does not exist.`, `${field}.script`)
          continue
        }
        if (parts[0] !== 'api') out.warn(at, 'script_location', `\`${field}.script\`: keep endpoints in api/ (${script}).`, `${field}.script`)
        if (has(spec, 'description') && !isStr(spec.description, DESCRIPTION_MAX, 0)) {
          out.error(at, 'invalid_value', `\`${field}.description\` must be a short text.`, `${field}.description`)
        }
        let timeoutS = ENDPOINT_TIMEOUT_DEFAULT_S
        if (has(spec, 'timeout_s')) {
          const t = spec.timeout_s
          if (typeof t !== 'number' || !Number.isInteger(t) || t < 1 || t > ENDPOINT_TIMEOUT_MAX_S) {
            out.error(at, 'invalid_value', `\`${field}.timeout_s\` must be a whole number of seconds from 1 to ${ENDPOINT_TIMEOUT_MAX_S}.`, `${field}.timeout_s`)
            continue
          }
          timeoutS = t
        }
        endpoints[name] = { name, script: parts.join('/'), runtime, timeoutS }
      }
    }
  }

  // source
  let source: ComponentSource | null = null
  const rawSource = doc.source
  if (rawSource === undefined || rawSource === null) out.error(at, 'required', '`source` is required: {"endpoint": name} or {"file": path}.', 'source')
  else if (!isRecord(rawSource) || Object.keys(rawSource).length !== 1 || !(has(rawSource, 'endpoint') || has(rawSource, 'file'))) {
    out.error(at, 'source_invalid', '`source` names exactly one of `endpoint` or `file`, and nothing else.', 'source')
  } else if (has(rawSource, 'endpoint')) {
    const name = rawSource.endpoint
    const declared = isRecord(rawEndpoints) ? rawEndpoints : {}
    if (typeof name !== 'string' || !has(declared, name)) {
      out.error(at, 'unknown_endpoint', `\`source.endpoint\` ${JSON.stringify(name)} is not one of \`endpoints\`.`, 'source.endpoint')
    } else source = { endpoint: name }
  } else {
    const value = rawSource.file
    const parts = typeof value === 'string' ? safeRelative(value) : null
    if (!parts) out.error(at, 'source_file_location', '`source.file` must be an agent-relative path under app-data/ or files/.', 'source.file')
    else {
      const posix = parts.join('/')
      let ok = true
      if (!(FILE_SOURCE_ROOTS as readonly string[]).some((root) => posix.startsWith(root))) {
        ok = false
        out.error(at, 'source_file_location', `\`source.file\` ${posix} must be under app-data/ or files/ (write data to app-data/dashboards/<name>/, never into dashboards/).`, 'source.file')
      }
      const suffix = suffixOf(parts)
      if (!(FILE_SOURCE_EXTENSIONS as readonly string[]).includes(suffix)) {
        ok = false
        out.error(at, 'source_file_extension', `\`source.file\` ${posix} must be .md, .json or .csv (lowercase).`, 'source.file')
      } else if ((suffix === '.csv' && rawView !== 'table') || (suffix === '.md' && rawView !== 'markdown')) {
        ok = false
        out.error(at, 'source_file_view', `\`source.file\` ${posix}: a .csv feeds a table view and a .md a markdown view.`, 'source.file')
      }
      if (ctx.agentDir !== null && !inside(join(ctx.agentDir, ...parts), ctx.agentDir)) {
        ok = false
        out.error(at, 'symlink_escape', `\`source.file\` ${posix} leads outside the agent folder through a symlink.`, 'source.file')
      }
      if (ok) source = { file: posix }
    }
  }

  // entry
  let entry = DEFAULT_ENTRY
  let entryParts: string[] | null = [DEFAULT_ENTRY]
  if (rawView !== 'html') {
    if (has(doc, 'entry')) out.warn(at, 'entry_ignored', '`entry` is read only for an html view.', 'entry')
  } else {
    const rawEntry = has(doc, 'entry') ? doc.entry : DEFAULT_ENTRY
    entryParts = typeof rawEntry === 'string' ? safeRelative(rawEntry) : null
    if (!entryParts || suffixOf(entryParts) !== '.html') {
      out.error(at, 'entry_invalid', '`entry` must be an .html file inside the component folder.', 'entry')
    } else {
      entry = entryParts.join('/')
      const path = join(ctx.componentDir, ...entryParts)
      if (ctx.files === false) {
        // Not on this machine: the server checked the page.
      } else if (!inside(path, ctx.componentDir)) out.error(at, 'symlink_escape', `\`entry\` ${entry} leads outside the component folder through a symlink.`, 'entry')
      else if (!isFile(path)) out.error(at, 'entry_missing', `\`entry\` ${entry} does not exist.`, 'entry')
    }
  }

  // params
  const params: Record<string, ComponentParamSpec> = {}
  const rawParams = doc.params
  if (rawParams !== undefined && rawParams !== null) {
    if (!isRecord(rawParams)) out.error(at, 'invalid_type', '`params` must be an object of name → {type, …}.', 'params')
    else {
      for (const [name, spec] of Object.entries(rawParams)) {
        const field = `params.${name}`
        if (!PARAM_NAME_PATTERN.test(name)) {
          out.error(at, 'param_name_invalid', `param \`${field}\`: names use letters, digits and \`_\` only.`, field)
          continue
        }
        if (!isRecord(spec) || !(PARAM_TYPES as readonly unknown[]).includes(spec.type)) {
          out.error(at, 'invalid_value', `\`${field}.type\` must be one of ${PARAM_TYPES.join(', ')}.`, `${field}.type`)
          continue
        }
        const kind = spec.type as string
        let ok = true
        if (has(spec, 'label') && !isStr(spec.label, PARAM_LABEL_MAX)) {
          ok = false
          out.error(at, 'invalid_value', `\`${field}.label\` must be a short text.`, `${field}.label`)
        }
        const values = spec.values
        if (kind === 'enum' && (!Array.isArray(values) || values.length === 0 || !values.every((v) => isStr(v, ENUM_VALUE_MAX)))) {
          out.error(at, 'invalid_value', `\`${field}.values\` must list the choices as strings.`, `${field}.values`)
          continue
        }
        if (has(spec, 'default') && !defaultFits(kind, spec.default, values)) {
          ok = false
          out.error(at, 'invalid_value', `\`${field}.default\` does not fit type ${kind}.`, `${field}.default`)
        }
        if (ok) {
          const entry: ComponentParamSpec = { type: kind }
          if (typeof spec.label === 'string') entry.label = spec.label.trim()
          if (kind === 'enum') entry.values = [...(values as string[])]
          if (spec.default !== undefined && spec.default !== null) entry.default = spec.default
          params[name] = entry
        }
      }
    }
  }

  // refresh
  let maxAge = DEFAULT_MAX_AGE
  let refreshCommand: string | null = null
  let afterTurn = false
  let whileOpenEvery: string | null = null
  let onAppStart = false
  let schedule: string | null = null
  const refresh = doc.refresh
  if (refresh !== undefined && refresh !== null) {
    if (!isRecord(refresh)) out.error(at, 'invalid_type', '`refresh` must be an object.', 'refresh')
    else {
      if (has(refresh, 'max_age')) {
        if (durationSeconds(refresh.max_age) === null) {
          out.error(at, 'duration_invalid', `\`refresh.max_age\` ${JSON.stringify(refresh.max_age)} is not a duration like 30s, 15m, 6h or 1d (leave it out for the 15m default).`, 'refresh.max_age')
        } else maxAge = refresh.max_age as string
      }
      const every = refresh.while_open_every
      if (every !== undefined && every !== null) {
        const seconds = durationSeconds(every)
        if (seconds === null) out.error(at, 'duration_invalid', `\`refresh.while_open_every\` ${JSON.stringify(every)} is not a duration like 5m.`, 'refresh.while_open_every')
        else if (seconds * 1000 < MIN_WHILE_OPEN_EVERY_MS) out.error(at, 'while_open_every_too_short', `\`refresh.while_open_every\` ${String(every)} is shorter than 1m.`, 'refresh.while_open_every')
        else whileOpenEvery = every as string
      }
      for (const flag of ['after_turn', 'on_app_start'] as const) {
        if (has(refresh, flag) && typeof refresh[flag] !== 'boolean') out.error(at, 'invalid_type', `\`refresh.${flag}\` must be true or false.`, `refresh.${flag}`)
      }
      afterTurn = refresh.after_turn === true
      onAppStart = refresh.on_app_start === true
      const command = refresh.command
      if (command !== undefined && command !== null) {
        const match = typeof command === 'string' ? RUN_REFERENCE_PATTERN.exec(command) : null
        if (!match) out.error(at, 'refresh_command_invalid', '`refresh.command` must be `/run:<command name>` or null.', 'refresh.command')
        else {
          refreshCommand = command as string
          if (ctx.commandNames !== null && !ctx.commandNames.has(match[1])) {
            out.warn(at, 'refresh_command_unknown', `\`refresh.command\` ${command as string}: no such command in ${COMMAND_CATALOG}.`, 'refresh.command')
          }
        }
      }
      const rawSchedule = refresh.schedule
      if (rawSchedule !== undefined && rawSchedule !== null) {
        if (!isStr(rawSchedule, SCHEDULE_NAME_MAX)) out.error(at, 'invalid_type', '`refresh.schedule` must be a schedule name or null.', 'refresh.schedule')
        else {
          schedule = rawSchedule as string
          const known = manifestNames(ctx.manifest, 'schedules')
          if (known !== null && !known.has(schedule)) {
            out.warn(at, 'refresh_schedule_unknown', `\`refresh.schedule\` ${JSON.stringify(schedule)} is not in ${MANIFEST_FILE} \`schedules\`.`, 'refresh.schedule')
          }
        }
      }
    }
  }

  // requires_credentials
  let requiresCredentials: string[] = []
  const creds = doc.requires_credentials
  if (creds !== undefined && creds !== null) {
    if (!Array.isArray(creds) || !creds.every((n) => typeof n === 'string' && n.length > 0)) {
      out.error(at, 'invalid_type', '`requires_credentials` must be a list of credential names.', 'requires_credentials')
    } else {
      requiresCredentials = creds as string[]
      const known = manifestNames(ctx.manifest, 'credentials')
      if (known === null) {
        out.warn(at, 'manifest_missing', `no ${MANIFEST_FILE} above this component, so \`requires_credentials\` was not checked.`, 'requires_credentials')
      } else {
        for (const name of requiresCredentials) {
          if (!known.has(name)) out.error(at, 'credential_unknown', `\`requires_credentials\` names ${JSON.stringify(name)}, which is not in ${MANIFEST_FILE} \`credentials\`.`, 'requires_credentials')
        }
      }
    }
  }

  // A web view's page files: what its sandbox blocks.
  if (rawView === 'html' && ctx.files !== false) {
    for (const rel of pageFiles(ctx.componentDir, entryParts)) scanPage(ctx.componentDir, rel, `${ctx.shownDir}/${rel}`, out)
  }

  const findings = out.sorted()
  if (out.hasErrors || !view || !source) return { spec: null, findings }
  return {
    spec: {
      title: (doc.title as string).trim(),
      description: typeof doc.description === 'string' ? doc.description.trim() : '',
      view,
      entry,
      source,
      endpoints,
      params,
      maxAge,
      maxAgeMs: parseDuration(maxAge) ?? 15 * 60_000,
      refreshCommand,
      afterTurn,
      whileOpenEvery,
      onAppStart,
      schedule,
      // Checked above: a spec exists only when every entry has a label and a prompt.
      prompts: Array.isArray(doc.prompts)
        ? (doc.prompts as Array<{ label: string; prompt: string }>).map((p) => ({ label: p.label.trim(), prompt: p.prompt.trim() }))
        : [],
      size: isTileSize(doc.size) ? doc.size : 'm',
      requiresCredentials
    },
    findings
  }
}

/** The checker's `_default_ok`: a param default fits its type; null is "no default". */
function defaultFits(kind: string, value: unknown, values: unknown): boolean {
  if (value === null) return true
  switch (kind) {
    case 'enum':
      return Array.isArray(values) && values.includes(value)
    case 'month':
      return value === 'current' || (typeof value === 'string' && MONTH_RE.test(value))
    case 'date':
      return value === 'today' || (typeof value === 'string' && DATE_RE.test(value))
    case 'number':
      return typeof value === 'number'
    case 'boolean':
      return typeof value === 'boolean'
    case 'text':
      return typeof value === 'string'
    default:
      return true // date_range: host-defined presets
  }
}

/* --------------------------------------------------------- component folders */

export interface CheckFolderOptions {
  /** Absolute, realpath'd agent folder, or null. */
  agentDir: string | null
  /** Agent-relative path of the component folder. */
  shownDir: string
  manifest: Record<string, unknown> | null
  commandNames: Set<string> | null
}

export interface CheckedFolder {
  spec: ComponentSpec | null
  findings: ComponentFinding[]
  /** The parsed `component.json` object, when there is one (for the title of an invalid card). */
  raw: Record<string, unknown> | null
}

/**
 * One component folder by the checker's `check_component` (without `--run`):
 * its name, its `component.json`, the files that names, the page scans.
 * `componentDir` must be an existing, realpath'd folder that is not a symlink.
 */
export function checkComponentFolder(componentDir: string, options: CheckFolderOptions): CheckedFolder {
  const out = new Findings()
  if (!COMPONENT_NAME_PATTERN.test(basename(options.shownDir))) {
    out.error(options.shownDir, 'component_name_invalid', 'the folder name is the component name: lowercase letters, digits and \'-\', starting with a letter or digit, at most 64 characters.')
  }
  const at = `${options.shownDir}/${COMPONENT_FILE}`
  const file = join(componentDir, COMPONENT_FILE)
  if (!isFile(file)) {
    out.error(at, 'component_json_missing', `every component folder starts with ${COMPONENT_FILE}.`)
    return { spec: null, findings: out.sorted(), raw: null }
  }
  let doc: unknown
  try {
    if (statSync(file).size > MAX_COMPONENT_FILE_BYTES) {
      out.error(at, 'component_json_invalid', 'is larger than 256 KB.')
      return { spec: null, findings: out.sorted(), raw: null }
    }
    doc = JSON.parse(readText(file))
  } catch (err) {
    out.error(at, 'component_json_invalid', `is not valid JSON (${err instanceof Error ? err.message : 'parse error'}).`)
    return { spec: null, findings: out.sorted(), raw: null }
  }
  if (!isRecord(doc)) {
    out.error(at, 'component_json_invalid', 'must hold one JSON object.')
    return { spec: null, findings: out.sorted(), raw: null }
  }
  const { spec, findings } = validateComponentSpec(doc, { componentDir, ...options })
  const all = [...out.list, ...findings]
  const sorted = [...all.filter((f) => f.severity === 'error'), ...all.filter((f) => f.severity === 'warning')]
  return { spec: out.hasErrors ? null : spec, findings: sorted, raw: doc }
}

/* ------------------------------------------------------------- agent scanning */

/** Where one owner's components are: the agent's `dashboards/`, or a skill's. */
interface ComponentRoot {
  /** Absolute, realpath'd folder holding the component folders. */
  base: string
  /** Its agent-relative path (`dashboards`, `skills/crm/dashboards`). */
  shownBase: string
  skill: string | null
}

interface AgentContext {
  agent: ComponentAgent
  agentReal: string
  manifest: Record<string, unknown> | null
  commandNames: Set<string> | null
}

function agentContext(agent: ComponentAgent): AgentContext | null {
  const agentReal = realOrNull(agent.path)
  if (!agentReal) return null
  const manifest = agent.manifest === undefined ? readAgentManifest(agentReal) : isRecord(agent.manifest) ? agent.manifest : null
  return { agent, agentReal, manifest, commandNames: readCommandNames(agentReal) }
}

function ownRoot(ctx: AgentContext): ComponentRoot | null {
  const role = dashboardsFolderRole(ctx.agent.rootPath)
  const base = realOrNull(join(ctx.agentReal, role))
  if (!base || !isWithin(ctx.agentReal, base) || base === ctx.agentReal || !isDir(base)) return null
  return { base, shownBase: role, skill: null }
}

function skillFolders(agent: ComponentAgent): ComponentSkillFolder[] {
  try {
    return agent.skills?.() ?? []
  } catch {
    return []
  }
}

function skillRoot(skill: ComponentSkillFolder): ComponentRoot | null {
  const skillReal = realOrNull(skill.dir)
  if (!skillReal) return null
  const base = realOrNull(join(skillReal, SKILL_DASHBOARDS_DIR))
  if (!base || !isWithin(skillReal, base) || base === skillReal || !isDir(base)) return null
  // Always the agent-relative form: where an authored skill is, and how the agent names a cached one.
  return { base, shownBase: `${SKILLS_DIR}/${skill.name}/${SKILL_DASHBOARDS_DIR}`, skill: skill.name }
}

function rootFor(ctx: AgentContext, skill: string | null): ComponentRoot | null {
  if (skill === null) return ownRoot(ctx)
  const folder = skillFolders(ctx.agent).find((entry) => entry.name === skill)
  return folder ? skillRoot(folder) : null
}

/** The component folder `name` under `root`, as a scanned component, or null when there is no such folder. */
function inspect(ctx: AgentContext, root: ComponentRoot, name: string): ScannedComponent | null {
  const link = join(root.base, name)
  const shownDir = `${root.shownBase}/${name}`
  const base = {
    agentId: ctx.agent.id,
    manifestId: ctx.agent.manifestId,
    agentName: ctx.agent.name,
    name,
    skill: root.skill
  }
  const invalid = (findings: ComponentFinding[], dir: string, raw: Record<string, unknown> | null): ScannedComponent => ({
    dir,
    shownDir,
    spec: null,
    info: {
      ...base,
      title: raw && typeof raw.title === 'string' && raw.title.trim() ? raw.title.trim() : name,
      description: raw && typeof raw.description === 'string' ? raw.description.trim() : '',
      view: raw && (DASHBOARD_VIEW_KINDS as readonly unknown[]).includes(raw.view) ? (raw.view as DashboardViewKind) : null,
      size: raw && isTileSize(raw.size) ? raw.size : 'm',
      source: null,
      maxAge: DEFAULT_MAX_AGE,
      refreshCommand: null,
      params: {},
      refresh: defaultRefreshRule(),
      prompts: [],
      valid: false,
      findings,
      missingCredentials: []
    }
  })
  try {
    if (lstatSync(link).isSymbolicLink()) {
      // Never followed; reported only when it points at a folder, as the checker does.
      if (!isDir(link)) return null
      return invalid([{ path: shownDir, code: 'component_symlink', field: null, severity: 'error', message: 'a component folder may not be a symlink; copy the folder in instead.' }], link, null)
    }
  } catch {
    return null
  }
  const dir = realOrNull(link)
  if (!dir || !isWithin(root.base, dir) || dir === root.base || !isDir(dir)) return null
  const checked = checkComponentFolder(dir, { agentDir: ctx.agentReal, shownDir, manifest: ctx.manifest, commandNames: ctx.commandNames })
  if (!checked.spec) return invalid(checked.findings, dir, checked.raw)
  const spec = checked.spec
  return {
    dir,
    shownDir,
    spec,
    info: {
      ...base,
      title: spec.title,
      description: spec.description,
      view: spec.view,
      size: spec.size,
      source: spec.source,
      maxAge: spec.maxAge,
      refreshCommand: spec.refreshCommand,
      params: spec.params,
      refresh: refreshRuleOf(spec),
      prompts: spec.prompts,
      valid: true,
      findings: checked.findings,
      missingCredentials: missingCredentials(ctx.agent, spec.requiresCredentials)
    }
  }
}

/** The refresh rule of a component that states none (or is invalid): the schema's defaults. */
export function defaultRefreshRule(): ComponentRefreshRule {
  return { maxAge: DEFAULT_MAX_AGE, whileOpenEvery: null, afterTurn: false, onAppStart: false, command: null, schedule: null }
}

/** A valid component's `refresh`, as the renderer is shown it. */
export function refreshRuleOf(spec: ComponentSpec): ComponentRefreshRule {
  return { maxAge: spec.maxAge, whileOpenEvery: spec.whileOpenEvery, afterTurn: spec.afterTurn, onAppStart: spec.onAppStart, command: spec.refreshCommand, schedule: spec.schedule }
}

/** The `requires_credentials` names whose slot is not ready for the agent (README D16). */
export function missingCredentials(agent: Pick<ComponentAgent, 'credentialSlots'>, required: readonly string[]): string[] {
  if (!agent.credentialSlots) return []
  return [...new Set(required)].filter((name) => !agent.credentialSlots!.find((slot) => slot.name === name)?.ready)
}

/**
 * One component of `agent` by name — its own (`skill` null) or one a skill
 * ships — or null when there is no folder of that name (or no such skill).
 */
export function readComponent(agent: ComponentAgent, name: string, skill: string | null = null): ScannedComponent | null {
  if (!COMPONENT_NAME_PATTERN.test(name)) return null
  const ctx = agentContext(agent)
  if (!ctx) return null
  const root = rootFor(ctx, skill)
  return root ? inspect(ctx, root, name) : null
}

/** The candidate component folder names under `base`: folders and symlinks, no dot or tool folders. */
function folderNames(base: string): string[] {
  let entries: Dirent[]
  try {
    entries = readdirSync(base, { withFileTypes: true })
  } catch {
    return []
  }
  return entries
    .filter((entry) => (entry.isDirectory() || entry.isSymbolicLink()) && !entry.name.startsWith('.') && !SKIP_DIRS.has(entry.name))
    .map((entry) => entry.name)
    .sort()
}

/**
 * Every component of `agent`, valid or not: its own, name-sorted, then each
 * skill's (skills name-sorted). A folder whose name breaks the pattern is
 * listed with `component_name_invalid`; a symlinked one with `component_symlink`.
 */
export function scanComponents(agent: ComponentAgent): ComponentInfo[] {
  const ctx = agentContext(agent)
  if (!ctx) return []
  const roots = [ownRoot(ctx), ...[...skillFolders(agent)].sort((a, b) => a.name.localeCompare(b.name)).map(skillRoot)].filter(
    (root): root is ComponentRoot => root !== null
  )
  const out: ComponentInfo[] = []
  for (const root of roots) {
    for (const name of folderNames(root.base)) {
      if (out.length >= MAX_COMPONENTS_PER_AGENT) return out
      const scanned = inspect(ctx, root, name)
      if (scanned) out.push(scanned.info)
    }
  }
  return out
}

/**
 * What the checker reports about the agent's `dashboards/` itself rather than
 * one component: a plain file in it (`stray_file`, a warning). Reading runs nothing.
 */
export function agentDashboardFindings(agent: ComponentAgent): ComponentFinding[] {
  const ctx = agentContext(agent)
  const root = ctx ? ownRoot(ctx) : null
  if (!root) return []
  let names: string[]
  try {
    names = readdirSync(root.base).sort()
  } catch {
    return []
  }
  return names
    .filter((name) => !name.startsWith('.') && isFile(join(root.base, name)))
    .map((name) => ({
      path: `${root.shownBase}/${name}`,
      code: 'stray_file',
      field: null,
      severity: 'warning' as const,
      message: 'only component folders belong in dashboards/; data goes to app-data/dashboards/<name>/.'
    }))
}
