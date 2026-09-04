/**
 * The scaffolder — a TypeScript port of `kit.py new`.
 *
 * Creating an agent is a file operation, not a database one: copy
 * `templates/agent/` out of the active contract, substitute the `{{TOKEN}}`
 * placeholders, restore the dotted ignore files, and write a manifest carrying
 * a fresh UUID `id`, the contract version and the kit version. The `agents` row
 * comes later, from the scanner, like every other folder agent's (Invariant 1).
 *
 * Two properties are worth naming because they are easy to lose:
 *
 * * **Byte-compatible with `kit.py new`.** The template tree is the only source
 *   of content — nothing is generated here — and the manifest is written
 *   through `manifestIo.serializeManifest`, the same 2-space-plus-newline form
 *   every writer of these files uses. The manifest is *not* token-substituted
 *   as text: a description containing a quote would produce invalid JSON. It is
 *   parsed from the template and its fields are set, which preserves key order
 *   and gives the same bytes for ordinary input.
 * * **All-or-nothing.** The tree is built in a hidden sibling directory and
 *   renamed into place, so a failure halfway through leaves no half-agent for
 *   the scanner or the watcher to trip over.
 */

import { randomUUID } from 'node:crypto'
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { basename, dirname, join } from 'node:path'
import { app } from 'electron'
import {
  getLayoutView,
  getTemplateRoot,
  resolveContract,
  type TemplateKind
} from '../../kit/contractStore'
import { serializeManifest } from '../../kit/manifestIo'
import { LocalAgentError } from '../../errors'
import { createLogger } from '../../logger/logger'
import {
  MANIFEST_FILE,
  SLUG_PATTERN,
  type CinnaAgentManifest
} from '../../../shared/kit/manifest'
import { AGENTS_SUBDIR, slugifyAgentName } from '../../../shared/localAgents'

const logger = createLogger('local-agent-scaffold')

/**
 * TOML basic-string body: backslash and quote escaped, control characters as
 * escapes. A description containing a quote must not produce an unparsable
 * `pyproject.toml` any more than it may produce invalid JSON in the manifest.
 */
function tomlBasicString(value: string): string {
  return value.replace(/[\\"\u0000-\u001f\u007f]/g, (ch) => {
    switch (ch) {
      case '\\':
        return '\\\\'
      case '"':
        return '\\"'
      case '\n':
        return '\\n'
      case '\r':
        return '\\r'
      case '\t':
        return '\\t'
      default:
        return `\\u${ch.charCodeAt(0).toString(16).padStart(4, '0')}`
    }
  })
}

/**
 * Files whose `{{TOKEN}}` placeholders are substituted, each with the escaping
 * its syntax needs. Everything else is copied byte-for-byte — a template that is
 * not text must survive untouched, and a script must never have its contents
 * rewritten by a name the user typed.
 *
 * `pyproject.toml` is here because `uv run` parses it before Python starts: a
 * scaffold that leaves `name = "{{SLUG}}"` in place makes every `/run:` command
 * of the agent fail with a TOML error, and nothing short of running `uv` in the
 * created folder notices (`e2e/specs/scaffold.spec.ts` does exactly that).
 */
const SUBSTITUTED_FILES: ReadonlyMap<string, (value: string) => string> = new Map([
  ['AGENTS.md', (v: string) => v],
  ['CLAUDE.md', (v: string) => v],
  ['README.md', (v: string) => v],
  ['WORKFLOW_PROMPT.md', (v: string) => v],
  ['ENTRYPOINT_PROMPT.md', (v: string) => v],
  ['REFINER_PROMPT.md', (v: string) => v],
  ['pyproject.toml', tomlBasicString]
])

export interface ScaffoldAgentInput {
  /** Absolute path of the workshop root. Already validated by the caller. */
  rootPath: string
  /** Folder name; must match {@link SLUG_PATTERN}. */
  slug: string
  name: string
  description: string
}

export interface ScaffoldAgentResult {
  /** Absolute path of the created agent folder. */
  agentDir: string
  manifest: CinnaAgentManifest
}

/**
 * Derive a folder name from a human name: lower case, hyphen-separated, no
 * leading or trailing hyphen, at most 63 characters. Returns `''` when nothing
 * usable survives — the caller reports that rather than inventing a name.
 */
export function slugify(name: string): string {
  // The rule itself lives in `src/shared/localAgents.ts` so the new-agent form
  // can show the exact folder name this will produce. One rule, one place:
  // a preview that disagreed with the scaffolder would be worse than none.
  return slugifyAgentName(name)
}

function substituteTokens(
  text: string,
  values: Record<string, string>,
  escape: (value: string) => string
): string {
  return text.replace(/\{\{([A-Z_]+)\}\}/g, (match, token: string) =>
    Object.hasOwn(values, token) ? escape(values[token]) : match
  )
}

/**
 * The template-relative renames a scaffold applies — the dotless `gitignore`
 * files the contract ships, mapped to their dotted names.
 *
 * Read from `layout.json` rather than hard-coded: the set has grown once
 * already (`app-data/cache/gitignore`), and a scaffolder that missed an entry
 * leaves a folder the contract wanted ignored tracked by git instead.
 */
function renameMap(kind: TemplateKind, workshopRoot: string): Map<string, string> {
  const pairs = getLayoutView(workshopRoot).scaffoldIgnoreFiles(kind)
  return new Map(pairs.map(([from, to]) => [from, to]))
}

/**
 * Copy the template tree.
 *
 * `destRoot` stays the destination root through the whole walk and `relPath` is
 * always template-root-relative, because the contract's renames are expressed
 * as *paths* (`app-data/cache/gitignore` → `app-data/cache/.gitignore`) and a
 * future one may move a file to a different directory. Resolving against the
 * current directory instead would silently nest the copy.
 */
function copyTree(
  from: string,
  destRoot: string,
  relPrefix: string,
  renames: Map<string, string>,
  values: Record<string, string>
): void {
  mkdirSync(relPrefix === '' ? destRoot : join(destRoot, ...relPrefix.split('/')), {
    recursive: true
  })
  for (const entry of readdirSync(from, { withFileTypes: true })) {
    const source = join(from, entry.name)
    const relPath = relPrefix === '' ? entry.name : `${relPrefix}/${entry.name}`
    if (entry.isDirectory()) {
      copyTree(source, destRoot, relPath, renames, values)
      continue
    }
    if (!entry.isFile()) continue
    // The manifest is written separately, from the parsed template.
    if (entry.name === MANIFEST_FILE) continue
    const destination = join(destRoot, ...(renames.get(relPath) ?? relPath).split('/'))
    mkdirSync(dirname(destination), { recursive: true })
    const raw = readFileSync(source)
    const escape = SUBSTITUTED_FILES.get(entry.name)
    if (escape) {
      writeFileSync(destination, substituteTokens(raw.toString('utf8'), values, escape))
    } else {
      writeFileSync(destination, raw)
    }
  }
}

/**
 * Build the manifest from the template document, so unknown template keys and
 * key order survive exactly as `kit.py new` leaves them.
 */
function buildManifest(
  templateRoot: string,
  values: Record<string, string>
): CinnaAgentManifest {
  const templatePath = join(templateRoot, MANIFEST_FILE)
  let parsed: unknown
  try {
    parsed = JSON.parse(readFileSync(templatePath, 'utf8'))
  } catch (err) {
    logger.error('the contract manifest template is unreadable', { templatePath, error: err })
    throw new LocalAgentError(
      'write_failed',
      'The bundled agent template is damaged, so no agent was created.',
      err instanceof Error ? err.message : String(err)
    )
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new LocalAgentError(
      'write_failed',
      'The bundled agent template is damaged, so no agent was created.',
      templatePath
    )
  }
  const manifest = parsed as CinnaAgentManifest
  manifest.contract_version = values.CONTRACT_VERSION
  manifest.id = values.ID
  manifest.kit_version = values.KIT_VERSION
  manifest.created_at = values.CREATED_AT
  manifest.name = values.NAME
  manifest.slug = values.SLUG
  manifest.description = values.DESCRIPTION
  return manifest
}

/** The app version, recorded informationally as the manifest's `kit_version`. */
function kitVersion(): string {
  try {
    return `cinna-desktop/${app.getVersion()}`
  } catch {
    // `app` is unavailable outside Electron (unit tests); the field is
    // informational, so a placeholder is better than failing a scaffold.
    return 'cinna-desktop'
  }
}

export const scaffoldService = {
  slugify,

  /**
   * Create an agent folder under `<rootPath>/Local/<slug>/`.
   *
   * @throws LocalAgentError `invalid_input` for an unusable slug or an empty
   *   name/description, `already_exists` when the folder is taken, and
   *   `write_failed` when the copy itself fails.
   */
  scaffoldAgent(input: ScaffoldAgentInput): ScaffoldAgentResult {
    const name = input.name.trim()
    const description = input.description.trim()
    const slug = input.slug.trim()

    if (name === '') {
      throw new LocalAgentError('invalid_input', 'Give the agent a name.')
    }
    if (description === '') {
      throw new LocalAgentError('invalid_input', 'Describe what the agent should do.')
    }
    if (!SLUG_PATTERN.test(slug)) {
      throw new LocalAgentError(
        'invalid_input',
        'The folder name must be lower case and hyphenated, 2–63 characters.'
      )
    }

    const agentsDir = join(input.rootPath, AGENTS_SUBDIR)
    const agentDir = join(agentsDir, slug)
    if (existsSync(agentDir)) {
      throw new LocalAgentError(
        'already_exists',
        `There is already a folder called "${slug}" in this agents folder.`
      )
    }

    const contract = resolveContract(input.rootPath)
    const templateRoot = getTemplateRoot('agent', input.rootPath)
    const values: Record<string, string> = {
      SLUG: slug,
      NAME: name,
      DESCRIPTION: description,
      ID: randomUUID(),
      CONTRACT_VERSION: contract.version,
      KIT_VERSION: kitVersion(),
      CREATED_AT: new Date().toISOString()
    }

    // Built aside, then renamed in: the scanner and the watcher must never see
    // a partially-copied agent, and a failure must leave nothing behind.
    const staging = join(agentsDir, `.${slug}.scaffold-${process.pid}-${Date.now()}`)
    const started = Date.now()
    let manifest: CinnaAgentManifest
    try {
      mkdirSync(agentsDir, { recursive: true })
      copyTree(templateRoot, staging, '', renameMap('agent', input.rootPath), values)
      manifest = buildManifest(templateRoot, values)
      writeFileSync(join(staging, MANIFEST_FILE), serializeManifest(manifest))
      renameSync(staging, agentDir)
    } catch (err) {
      try {
        rmSync(staging, { recursive: true, force: true })
      } catch {
        /* nothing was created, or it is already gone */
      }
      if (err instanceof LocalAgentError) throw err
      logger.error('scaffold failed', { slug, error: err })
      throw new LocalAgentError(
        'write_failed',
        'Could not create the agent folder.',
        err instanceof Error ? err.message : String(err)
      )
    }

    logger.info('agent scaffolded', {
      slug,
      contractVersion: contract.version,
      contractSource: contract.source,
      durationMs: Date.now() - started
    })
    return { agentDir, manifest }
  },

  /**
   * Copy `templates/root/` into a workshop root, creating `Local/` and
   * `Cloud/`. Existing files are left alone: every root file is
   * `survives_update: true` in the contract's layout, so an install over a
   * workshop the user has edited must not overwrite their work.
   *
   * @returns the paths it created, for the log line
   */
  installRootTemplates(rootPath: string): string[] {
    const templateRoot = getTemplateRoot('root', rootPath)
    const renames = renameMap('root', rootPath)
    const created: string[] = []

    for (const dir of [rootPath, join(rootPath, AGENTS_SUBDIR), join(rootPath, 'Cloud')]) {
      if (!existsSync(dir)) {
        mkdirSync(dir, { recursive: true })
        created.push(basename(dir))
      }
    }

    for (const entry of readdirSync(templateRoot, { withFileTypes: true })) {
      if (!entry.isFile()) continue
      const relPath = renames.get(entry.name) ?? entry.name
      const destination = join(rootPath, ...relPath.split('/'))
      if (existsSync(destination)) continue
      mkdirSync(dirname(destination), { recursive: true })
      writeFileSync(destination, readFileSync(join(templateRoot, entry.name)))
      created.push(relPath)
    }

    if (created.length > 0) {
      logger.info('root templates installed', { created })
    }
    return created
  },

  /** True when `dir` looks like an agent folder (it has a manifest). */
  isAgentFolder(dir: string): boolean {
    try {
      return statSync(join(dir, MANIFEST_FILE)).isFile()
    } catch {
      return false
    }
  }
}
