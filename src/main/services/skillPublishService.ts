/**
 * Share a kit agent's own skill — `skills/<name>/` — to the active account's
 * catalog (catalog U5, U8, U11; plan D5), and add later versions of it.
 *
 * * **Preview** (`POST /api/v1/skills/packages/publish-preview`): the name and
 *   the parsed `SKILL.md` frontmatter, plus the package recorded for this
 *   skill in `publications.json`, give the version it would become, the
 *   package id, and each declared credential slot with the person's own
 *   credentials that could fill it for everyone. When the package exists
 *   (recorded, or the person's own package of that name), its listing row
 *   preselects each slot the latest version had provided and says whether
 *   this person may provide one at all (only the one who first shared it).
 * * **Preflight, before any byte is sent**: the skill must have no error
 *   (the row's own sentence is the refusal), and the folder must hold only
 *   files and folders, nothing that looks like a secret, at most 16 MB and
 *   2000 entries (`kit/skillPack.ts`).
 * * **Upload** (`POST /api/v1/skills/packages/publish`, multipart `archive` +
 *   `meta`): the deterministic tar.gz of the folder under one top-level
 *   `<name>/`. A first share carries who may use it (`visibility` and
 *   `grants`); a later one carries the recorded `package_uuid` and leaves
 *   access alone. A 409 `package_exists` on a first share is the person's own
 *   package (shared before from another folder, or a record that was lost):
 *   it is retried once into that package, without `visibility` or `grants`
 *   (core would apply them to the existing package).
 * * **Afterwards**: the returned `version` is written into `SKILL.md` (that
 *   one line, `miniYaml.setFrontmatterLine`) and the `skills[]` entry into
 *   `publications.json`, then the listing is read again. Both are ordinary
 *   file changes: in a shared agent they are changes to share with the team.
 *
 * Every answer is data ({@link SkillPublishOutcome}); nothing a caller can
 * cause is thrown, because a thrown code does not survive IPC.
 *
 * Core service: no Electron, no window. The token only ever goes to the
 * active profile's own API, through `cinna-http`.
 */

import { randomBytes } from 'node:crypto'
import { readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { getProfileScopeUserId } from '../auth/scope'
import { publishEvent } from '../host/events'
import { CinnaApiError, LocalAgentError } from '../errors'
import { CinnaSessionChanged } from '../auth/cinna-session'
import { CinnaReauthRequired } from '../auth/cinna-oauth'
import { createLogger } from '../logger/logger'
import { cinnaSend } from './cinna-http'
import { getStoredCinnaSubject } from '../auth/cinna-tokens'
import { libraryService } from './libraryService'
import { localAgentService } from './localAgents/localAgentService'
import { scannerService } from './localAgents/scannerService'
import { findSkillPublication, upsertSkillPublication } from '../kit/publications'
import { setFrontmatterLine } from '../kit/miniYaml'
import { parseSkillFrontmatter, SKILL_FILE, SKILLS_DIR, type FrontmatterValue } from '../kit/skills'
import {
  collectSkillTree,
  MAX_SKILL_UPLOAD_BYTES,
  MAX_SKILL_UPLOAD_MEMBERS,
  packSkillTarGz,
  skillTreeHash,
  type SkillTree
} from '../kit/skillPack'
import { LOCAL_AGENT_CHANGED_CHANNEL, type LocalAgentDto, type LocalAgentSkill } from '../../shared/localAgents'
import type { CatalogItem } from '../../shared/catalogItems'
import type {
  SkillPublishCandidate,
  SkillPublishInput,
  SkillPublishOutcome,
  SkillPublishPreviewDto,
  SkillPublishPreviewOutcome,
  SkillPublishRefusal,
  SkillPublishRefused,
  SkillPublishSlot
} from '../../shared/skillPublish'

const logger = createLogger('skill-publish')

export const PUBLISH_PREVIEW_PATH = '/api/v1/skills/packages/publish-preview'
export const PUBLISH_PATH = '/api/v1/skills/packages/publish'

const MB = MAX_SKILL_UPLOAD_BYTES / (1024 * 1024)

/** Each refusal as the dialog says it. Leads with what the person can do where there is something. */
export const SKILL_PUBLISH_SENTENCES: Record<SkillPublishRefusal, string> = {
  no_account: 'Sharing a skill needs a Cinna account.',
  not_found: 'That agent or skill is no longer here.',
  not_kit_agent: 'Only an agent with a cinna-agent.json can share its skills.',
  skill_invalid: 'Fix this skill’s SKILL.md before sharing it.',
  has_link: 'Replace the links in this skill with the files themselves — only files and folders can be shared. Nothing was sent.',
  special_file: 'Remove what is not a file or a folder from this skill — only files and folders can be shared. Nothing was sent.',
  secrets: 'A file that can hold a secret is in this skill. Move it out of the skill’s folder before sharing — nothing was sent.',
  unreadable: 'A file in this skill could not be read, so nothing was sent.',
  too_large: `This skill is larger than ${MB} MB, so it can’t be shared. Nothing was sent.`,
  too_many_files: `This skill has more than ${MAX_SKILL_UPLOAD_MEMBERS.toLocaleString('en-US')} files and folders, so it can’t be shared. Nothing was sent.`,
  skill_archive_invalid: 'The catalog could not unpack this skill. Nothing was published.',
  skill_contains_secrets: 'The catalog refused files that look like credentials. Remove them from the skill and share again.',
  invalid_publisher_credential: 'That credential can’t be provided for this skill. Choose another, or let each person connect their own.',
  skill_name_mismatch: 'This skill was shared under another name, so a new version can’t be added to it here.',
  package_exists: 'You already share a skill with this name. Try again to add this as its new version.',
  grants_require_users_visibility: 'People who can only use the skill can’t be named while everyone can use it. Remove them, or untick Everyone.',
  invalid_grants: 'The catalog did not accept that list of people.',
  not_publisher: 'Ask a maintainer for edit access — you can use this skill but not share new versions of it.',
  package_not_found: 'This skill is no longer in the catalog, or you can no longer see it.',
  reauth_required: 'Sign in to Cinna again, then share once more.',
  failed: 'Try again — the skill couldn’t be shared.'
}

function refused(code: SkillPublishRefusal, message?: string): SkillPublishRefused {
  return { ok: false, code, message: message ?? SKILL_PUBLISH_SENTENCES[code] }
}

const text = (value: unknown): string => (typeof value === 'string' ? value : '')
const record = (value: unknown): Record<string, unknown> | null =>
  value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : null

/** Up to three paths, as the team-sharing refusals name files. */
function named(paths: readonly string[]): string {
  const shown = paths.slice(0, 3).join(', ')
  return paths.length > 3 ? `${shown} and ${paths.length - 3} more` : shown
}

/* --------------------------------------------------------------- the skill */

interface SkillTarget {
  rootId: string
  agentId: string
  dir: string
  skillDir: string
  row: LocalAgentSkill
}

/** The authored skill `name` of a kit agent, or a refusal. */
function locateSkill(userId: string, agentId: string, name: string): SkillTarget | SkillPublishRefused {
  let agent: LocalAgentDto
  try {
    agent = localAgentService.get(userId, agentId)
  } catch (err) {
    if (err instanceof LocalAgentError) return refused('not_found')
    throw err
  }
  // Only a kit agent's DTO carries `skills` (the scanner leaves it off a bare folder's).
  if (agent.skills === undefined) return refused('not_kit_agent')
  const row = agent.skills.find((skill) => skill.source === 'authored' && skill.name === name)
  if (!row) return refused('not_found')
  return { rootId: agent.rootId, agentId, dir: agent.path, skillDir: join(agent.path, SKILLS_DIR, name), row }
}

/** The skill's first error as the refusal, when it has one: core refuses such a skill too. */
function invalidRefusal(row: LocalAgentSkill): SkillPublishRefused | null {
  if (row.deliverable) return null
  const error = row.issues.find((issue) => issue.severity === 'error')
  return refused('skill_invalid', error ? `This skill can’t be shared yet: ${error.message}` : undefined)
}

/** A frontmatter value as JSON: integers as numbers (or text past 2^53), nested as nested. */
function jsonOf(value: FrontmatterValue): unknown {
  if (typeof value === 'bigint') {
    const number = Number(value)
    return Number.isSafeInteger(number) ? number : value.toString()
  }
  if (Array.isArray(value)) return value.map(jsonOf)
  if (value !== null && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, jsonOf(item)]))
  return value
}

/** `SKILL.md`'s frontmatter, as core's preview takes it. Empty when it cannot be read (the row says why). */
function frontmatterOf(skillDir: string): Record<string, unknown> {
  try {
    let raw = new TextDecoder('utf-8', { fatal: true }).decode(readFileSync(join(skillDir, SKILL_FILE)))
    if (raw.startsWith('\uFEFF')) raw = raw.slice(1)
    return jsonOf(parseSkillFrontmatter(raw).frontmatter) as Record<string, unknown>
  } catch {
    return {}
  }
}

/** A folder that cannot be packed, as its refusal. */
function treeRefusal(problem: ReturnType<typeof collectSkillTree> & { ok: false }): SkillPublishRefused {
  switch (problem.problem) {
    case 'link':
      return refused('has_link', `Replace ${named(problem.paths)} with the file itself — a link can’t be shared. Nothing was sent.`)
    case 'special':
      return refused('special_file', `Remove ${named(problem.paths)} from this skill — only files and folders can be shared. Nothing was sent.`)
    case 'secrets':
      return refused(
        'secrets',
        `A file that can hold a secret is in this skill (${named(problem.paths)}). Move it out of the skill’s folder before sharing — nothing was sent.`
      )
    case 'unreadable':
      return refused('unreadable', `${named(problem.paths)} could not be read, so nothing was sent.`)
    case 'too_large':
      return refused('too_large')
    case 'too_many_files':
      return refused('too_many_files')
  }
}

/* --------------------------------------------------------------- the wire */

/** core's coded refusal (`{detail: {code, message, paths?, package_uuid?}}`) as a refusal of ours. */
export function catalogRefusal(status: number, body: unknown): SkillPublishRefused & { packageUuid?: string } {
  const detail = record(record(body)?.detail)
  const code = text(detail?.code)
  const message = text(detail?.message) || text(record(body)?.detail)
  const paths = Array.isArray(detail?.paths) ? (detail.paths as unknown[]).filter((p): p is string => typeof p === 'string') : []
  if (status === 413 || code === 'skill_too_large') return refused('too_large')
  switch (code) {
    case 'skill_archive_invalid':
      return refused('skill_archive_invalid', message ? `The catalog could not unpack this skill: ${message.replace(/^This skill archive cannot be used: /, '')}` : undefined)
    case 'skill_invalid':
      return refused('skill_invalid', message || undefined)
    case 'skill_contains_secrets':
      return refused(
        'skill_contains_secrets',
        paths.length > 0
          ? `The catalog refused files that look like credentials (${named(paths)}). Remove them from the skill and share again.`
          : undefined
      )
    case 'invalid_publisher_credential':
      // Core's own sentence names the case (only the person who first shared it may provide one).
      return refused('invalid_publisher_credential', message || undefined)
    case 'package_exists': {
      const uuid = text(detail?.package_uuid)
      return { ...refused('package_exists'), ...(uuid ? { packageUuid: uuid } : {}) }
    }
    case 'skill_name_mismatch':
    case 'grants_require_users_visibility':
    case 'not_publisher':
    case 'package_not_found':
      return refused(code)
    case 'invalid_grants':
      return refused('invalid_grants', message ? `The catalog did not accept that list of people: ${message}` : undefined)
  }
  if (status === 403) return refused('not_publisher')
  if (status === 404) return refused('package_not_found')
  const said = message || (Array.isArray(record(body)?.detail) ? 'the request was not accepted' : '')
  return refused('failed', said ? `The skill couldn’t be shared: ${said}`.slice(0, 300) : undefined)
}

function str(value: unknown, fallback = ''): string {
  return typeof value === 'string' ? value : fallback
}

function candidatesOf(raw: unknown): SkillPublishCandidate[] {
  if (!Array.isArray(raw)) return []
  return raw.flatMap((item): SkillPublishCandidate[] => {
    const row = record(item)
    const id = str(row?.id)
    if (!row || id === '') return []
    const canProvideAs = (Array.isArray(row.can_provide_as) ? row.can_provide_as : []).filter(
      (as): as is 'publisher' | 'template' => as === 'publisher' || as === 'template'
    )
    // Only a credential that can actually be provided is a choice.
    if (canProvideAs.length === 0) return []
    return [{ id, name: str(row.name) || id, type: str(row.type), canProvideAs }]
  })
}

/** core's `SkillPublishPreview` as the dialog reads it; null when it is not one. */
export function toPreviewDto(name: string, body: unknown): SkillPublishPreviewDto | null {
  const row = record(body)
  if (!row || typeof row.version !== 'string' || typeof row.package_id !== 'string') return null
  const credentials: SkillPublishSlot[] = (Array.isArray(row.credentials) ? row.credentials : []).flatMap((item): SkillPublishSlot[] => {
    const slot = record(item)
    if (!slot || str(slot.slot) === '') return []
    return [
      { slot: str(slot.slot), type: str(slot.type), description: str(slot.description) || null, candidates: candidatesOf(slot.candidates), current: null }
    ]
  })
  const next = row.next_revision_number
  return {
    name,
    version: row.version,
    packageId: row.package_id,
    packageIdDisambiguated: row.package_id_disambiguated === true,
    packageUuid: str(row.package_uuid) || null,
    isRepublish: row.is_republish === true,
    nextRevisionNumber: typeof next === 'number' && Number.isInteger(next) && next >= 1 ? next : 1,
    credentials,
    canProvide: true,
    providersCarried: true
  }
}

/**
 * A later version's preview with what the latest version did with each slot,
 * from the package's listing row: `required_credential_specs` (`provided_by`,
 * `publisher_credential_id`) preselects each slot the person provided, and
 * `publisher.user_id` against the signed-in account (`self`) says whether
 * they may provide one at all. A new package comes back as it was.
 */
export function withPreviousProviders(
  preview: SkillPublishPreviewDto,
  item: Pick<CatalogItem, 'publisher' | 'required_credential_specs'> | null,
  self: string | null
): SkillPublishPreviewDto {
  if (!preview.packageUuid) return preview
  const publisher = item?.publisher?.user_id ?? null
  const canProvide = !(publisher !== null && self !== null && publisher.toLowerCase() !== self.toLowerCase())
  if (!item) return { ...preview, canProvide, providersCarried: false }
  let providersCarried = true
  const current = new Map<string, string>()
  for (const raw of Array.isArray(item.required_credential_specs) ? item.required_credential_specs : []) {
    const spec = record(raw)
    const slot = str(spec?.service_uri) || str(spec?.name)
    const providedBy = str(spec?.provided_by, 'user')
    if (!spec || slot === '' || providedBy === 'user') continue
    const id = str(spec.publisher_credential_id).toLowerCase()
    const offered = preview.credentials
      .find((entry) => entry.slot === slot)
      ?.candidates.find((candidate) => candidate.id.toLowerCase() === id && candidate.canProvideAs.includes('publisher'))
    if (canProvide && providedBy === 'publisher' && id !== '' && offered) current.set(slot, offered.id)
    else providersCarried = false
  }
  return {
    ...preview,
    canProvide,
    providersCarried,
    credentials: preview.credentials.map((entry) => ({ ...entry, current: current.get(entry.slot) ?? null }))
  }
}

/** The signed-in account's id on its instance (the stored token's `sub`), or null. */
function selfId(profile: string): string | null {
  try {
    return getStoredCinnaSubject(profile)
  } catch {
    return null
  }
}

/** The package's listing row: the cached listing's, else a fresh one. Null when neither has it. */
async function listedSkill(profile: string, packageUuid: string): Promise<CatalogItem | null> {
  const find = (items: readonly CatalogItem[] | undefined): CatalogItem | null =>
    items?.find((item) => item.kind === 'skill' && item.uuid.toLowerCase() === packageUuid.toLowerCase()) ?? null
  try {
    return find(libraryService.cached(profile)?.items) ?? find((await libraryService.refresh(profile))?.items)
  } catch (err) {
    logger.warn('catalog listing could not be read for a skill’s previous credentials', { error: String(err) })
    return null
  }
}

/** The `meta` form field of a publish. Who may use it travels on a first share only. */
export function publishMeta(input: SkillPublishInput, packageUuid: string | null): Record<string, unknown> {
  const meta: Record<string, unknown> = {}
  if (packageUuid) meta.package_uuid = packageUuid
  const notes = typeof input.releaseNotes === 'string' ? input.releaseNotes.trim() : ''
  if (notes !== '') meta.release_notes = notes.slice(0, 10_000)
  if (!packageUuid) {
    const everyone = input.everyone === true
    const seen = new Set<string>()
    const people = (Array.isArray(input.people) ? input.people : []).filter((person) => {
      const ok =
        person && typeof person.userId === 'string' && person.userId !== '' && !seen.has(person.userId) &&
        (person.access === 'use' || person.access === 'edit' || person.access === 'maintain')
      if (ok) seen.add(person.userId)
      return ok
    })
    // `public` is everyone's `use`; core refuses a `use` grant beside it, so
    // only the people who may do more than use it are named then.
    const grants = people
      .filter((person) => !(everyone && person.access === 'use'))
      .map((person) => ({ principal: { user_id: person.userId }, access: person.access }))
    if (everyone) meta.visibility = 'public'
    else if (people.length > 0) meta.visibility = 'users'
    if (grants.length > 0) meta.grants = grants
  }
  const credentials = (Array.isArray(input.publisherCredentials) ? input.publisherCredentials : []).filter(
    (choice) => choice && typeof choice.slot === 'string' && choice.slot !== '' && typeof choice.credentialId === 'string' && choice.credentialId !== ''
  )
  if (credentials.length > 0) meta.publisher_credentials = credentials.map((choice) => ({ slot: choice.slot, credential_id: choice.credentialId }))
  return meta
}

/** A `multipart/form-data` body of `meta` (JSON) and `archive` (the tar.gz). */
export function multipartBody(name: string, meta: Record<string, unknown>, archive: Buffer): { data: Buffer; contentType: string } {
  const boundary = `----cinna-skill-${randomBytes(16).toString('hex')}`
  const data = Buffer.concat([
    Buffer.from(
      `--${boundary}\r\nContent-Disposition: form-data; name="meta"\r\nContent-Type: application/json\r\n\r\n${JSON.stringify(meta)}\r\n` +
        `--${boundary}\r\nContent-Disposition: form-data; name="archive"; filename="${name}.tar.gz"\r\nContent-Type: application/gzip\r\n\r\n`,
      'utf8'
    ),
    archive,
    Buffer.from(`\r\n--${boundary}--\r\n`, 'utf8')
  ])
  return { data, contentType: `multipart/form-data; boundary=${boundary}` }
}

type Uploaded = { ok: true; body: Record<string, unknown> } | (SkillPublishRefused & { packageUuid?: string })

async function upload(profile: string, name: string, archive: Buffer, meta: Record<string, unknown>): Promise<Uploaded> {
  const answer = await cinnaSend(profile, PUBLISH_PATH, { method: 'POST', bytes: multipartBody(name, meta, archive) })
  if (!answer.ok) return catalogRefusal(answer.status, answer.body)
  const body = record(answer.body)
  if (!body || typeof body.revision_number !== 'number') return refused('failed', 'The catalog answered with something that is not a version.')
  return { ok: true, body }
}

/* ------------------------------------------------------------ afterwards */

/** Write `version` into `SKILL.md`, that line only; true when the file carries it afterwards. */
function writeVersion(skillDir: string, version: string): { ok: boolean; bytes: Buffer | null } {
  const path = join(skillDir, SKILL_FILE)
  try {
    const before = readFileSync(path)
    const after = setFrontmatterLine(before, 'version', version)
    if (after === null) return { ok: false, bytes: before }
    if (after !== before) {
      // Dot-prefixed, so a scan of the folder in between ignores it.
      const tmp = join(skillDir, `.${SKILL_FILE}.tmp`)
      try {
        writeFileSync(tmp, after)
        renameSync(tmp, path)
      } catch (err) {
        rmSync(tmp, { force: true })
        throw err
      }
    }
    return { ok: true, bytes: after }
  } catch (err) {
    logger.warn('the published version could not be written into SKILL.md', { error: err instanceof Error ? err.message : String(err) })
    return { ok: false, bytes: null }
  }
}

/** The package's text id: the listing's, else core's preview of that package. */
async function packageIdOf(profile: string, name: string, skillDir: string, packageUuid: string): Promise<string | null> {
  try {
    const listing = await libraryService.refresh(profile)
    const item = listing?.items.find((candidate) => candidate.kind === 'skill' && candidate.uuid.toLowerCase() === packageUuid.toLowerCase())
    if (item && item.id !== '') return item.id
  } catch (err) {
    logger.warn('catalog listing could not be refreshed after a skill was shared', { error: String(err) })
  }
  try {
    const answer = await cinnaSend(profile, PUBLISH_PREVIEW_PATH, {
      method: 'POST',
      json: { name, frontmatter: frontmatterOf(skillDir), package_uuid: packageUuid }
    })
    const preview = answer.ok ? toPreviewDto(name, answer.body) : null
    return preview?.packageId || null
  } catch {
    return null
  }
}

function settle(rootId: string, agentId: string): void {
  scannerService.markAllRootsDirty()
  publishEvent(LOCAL_AGENT_CHANGED_CHANNEL, { rootId, agentId, reason: 'rescan' })
}

/* ----------------------------------------------------------------- verbs */

function account(): { profile: string; host: string } | SkillPublishRefused {
  const profile = getProfileScopeUserId()
  const host = libraryService.hostOf(profile)
  return host === null ? refused('no_account') : { profile, host }
}

async function guarded<T extends { ok: boolean }>(verb: string, run: () => Promise<T | SkillPublishRefused>): Promise<T | SkillPublishRefused> {
  try {
    return await run()
  } catch (err) {
    if (err instanceof CinnaReauthRequired || (err instanceof CinnaApiError && err.code === 'reauth_required')) return refused('reauth_required')
    if (err instanceof CinnaApiError && (err.code === 'not_cinna_user' || err.code === 'missing_server_url')) return refused('no_account')
    if (err instanceof CinnaApiError) return refused('failed', 'Check your connection and try again — the catalog couldn’t be reached.')
    if (err instanceof CinnaSessionChanged) return refused('failed', 'The Cinna account changed while sharing. Try again.')
    logger.error(`skill ${verb} failed`, { error: err instanceof Error ? err.message : String(err) })
    return refused('failed', `Something went wrong: ${err instanceof Error ? err.message : String(err)}`.slice(0, 300))
  }
}

export const skillPublishService = {
  /** What sharing the skill `name` of an agent would produce, from core's preview. */
  async preview(userId: string, agentId: string, name: string): Promise<SkillPublishPreviewOutcome> {
    return guarded('preview', async () => {
      const who = account()
      if ('ok' in who) return who
      const target = locateSkill(userId, agentId, name)
      if ('ok' in target) return target
      const invalid = invalidRefusal(target.row)
      if (invalid) return invalid
      const recorded = findSkillPublication(target.dir, who.host, name)
      const answer = await cinnaSend(who.profile, PUBLISH_PREVIEW_PATH, {
        method: 'POST',
        json: { name, frontmatter: frontmatterOf(target.skillDir), ...(recorded ? { package_uuid: recorded.package_uuid } : {}) }
      })
      if (!answer.ok) {
        const refusal = catalogRefusal(answer.status, answer.body)
        return refused(refusal.code, refusal.message)
      }
      const parsed = toPreviewDto(name, answer.body)
      if (!parsed) return refused('failed', 'The catalog answered with something that is not a preview.')
      const preview = parsed.packageUuid
        ? withPreviousProviders(parsed, await listedSkill(who.profile, parsed.packageUuid), selfId(who.profile))
        : parsed
      return { ok: true as const, preview }
    })
  },

  /**
   * Share the skill: preflight, pack, upload (retried once into the person's
   * own package on `package_exists`), then record the version in `SKILL.md`
   * and the package in `publications.json`.
   */
  async publish(userId: string, input: SkillPublishInput): Promise<SkillPublishOutcome> {
    return guarded('publish', async () => {
      const who = account()
      if ('ok' in who) return who
      const name = typeof input?.name === 'string' ? input.name : ''
      const target = locateSkill(userId, typeof input?.agentId === 'string' ? input.agentId : '', name)
      if ('ok' in target) return target
      const invalid = invalidRefusal(target.row)
      if (invalid) return invalid

      // Nothing leaves this computer until the folder passes.
      const collected = collectSkillTree(target.skillDir)
      if (!collected.ok) return treeRefusal(collected)
      const archive = packSkillTarGz(name, collected.tree)
      if (archive.length > MAX_SKILL_UPLOAD_BYTES) return refused('too_large')

      const recorded = findSkillPublication(target.dir, who.host, name)
      const meta = publishMeta(input, recorded?.package_uuid ?? null)
      let answer = await upload(who.profile, name, archive, meta)
      if (!answer.ok && answer.code === 'package_exists' && !recorded && answer.packageUuid) {
        // The person's own package of this name: this share is its next version,
        // and like every later version it leaves access alone — core would
        // apply a first share's visibility and grants to the existing package
        // (and could narrow a public one).
        logger.info('skill already in the catalog; adding a version to it', { name })
        const { visibility: _visibility, grants: _grants, ...kept } = meta
        answer = await upload(who.profile, name, archive, { ...kept, package_uuid: answer.packageUuid })
      }
      if (!answer.ok) return refused(answer.code, answer.message)

      const revision = answer.body
      const revisionNumber = revision.revision_number as number
      const version = text(revision.version) || null
      const packageUuid = text(revision.package_id) || text(meta.package_uuid) || recorded?.package_uuid || ''
      let written = true
      let tree: SkillTree = collected.tree
      if (version) {
        const result = writeVersion(target.skillDir, version)
        written = result.ok
        if (result.bytes) tree = { ...tree, files: tree.files.map((file) => (file.path === SKILL_FILE ? { ...file, data: result.bytes as Buffer } : file)) }
      }
      const packageId = (await packageIdOf(who.profile, name, target.skillDir, packageUuid)) ?? recorded?.package_id ?? null
      // As the catalog computed it; the same hash over the folder as sent, version written, when it did not say.
      const contentHash = text(revision.content_hash) || skillTreeHash(name, tree.files)
      if (packageUuid !== '' && packageId) {
        try {
          upsertSkillPublication(target.dir, {
            platform_url: who.host,
            name,
            package_id: packageId,
            package_uuid: packageUuid,
            revision_number: revisionNumber,
            content_hash: contentHash
          })
        } catch (err) {
          written = false
          logger.warn('publications.json could not be written after a skill was shared', { error: err instanceof Error ? err.message : String(err) })
        }
      } else {
        written = false
      }
      settle(target.rootId, target.agentId)
      logger.info('skill shared', { agentId: target.agentId, name, revision: revisionNumber })
      return {
        ok: true as const,
        name,
        revisionNumber,
        version,
        packageUuid,
        packageId: packageId ?? '',
        recorded: written
      }
    })
  }
}
