/**
 * Publish a file or folder from an agent's folder to the active profile's
 * cinna-core as an artifact, and the Share actions on it (artifacts D1).
 *
 * * **Support**: a signed-in `cinna_user` profile whose instance advertises
 *   `artifacts >= 1` in `/.well-known/cinna-desktop`. Limits come from core's
 *   `/artifacts/capabilities`, else core's defaults.
 * * **Paths**: the caller names `{agentId, path}` — an absolute path (the
 *   renderer's resolved file references) or one relative to the agent's
 *   folder (an agent's own tool call); the folder comes from the agent's
 *   index row, never from the caller, and the realpath must be inside it
 *   (`path_refused`).
 * * **Publish**: a fresh {@link inspectArtifactPath} (the folder may have
 *   changed since the dialog showed it), a zip of exactly those files, the
 *   upload, then the follow-up the user chose — `instance` visibility, or a
 *   public link whose URL is returned once and never stored.
 * * **Memory** (A12): `published_artifacts` keeps `(profile, server, path) →
 *   artifact` for *Update*, kept in sync after every publish and Share
 *   action; `chat_artifact_cards` anchors the chat's card.
 *
 * Every answer is data (`{ok: false, code, message}`); nothing a caller can
 * cause is thrown, because a thrown code does not survive IPC.
 *
 * Core service: no Electron, no window. The token only goes to the profile's
 * own API, through `cinna-http`.
 */

import { randomBytes } from 'node:crypto'
import { closeSync, constants, fstatSync, lstatSync, openSync, readSync } from 'node:fs'
import { isAbsolute, join, relative, sep } from 'node:path'
import { CinnaApiError } from '../../errors'
import { CinnaSessionChanged } from '../../auth/cinna-session'
import { CinnaReauthRequired } from '../../auth/cinna-oauth'
import { isWithin } from '../localAgents/pathRules'
import type { CinnaSendResult } from '../cinna-http'
import type { PublishedArtifactRow, PublishedArtifactState } from '../../db/publishedArtifacts'
import { exclusionFor, inspectArtifactPath, type InspectResult } from './inspect'
import { buildZip, type ZipEntry } from './zip'
import {
  ARTIFACTS_CHANGED_CHANNEL,
  ARTIFACTS_PROGRESS_CHANNEL,
  FALLBACK_ARTIFACT_LIMITS,
  formatArtifactBytes,
  type ArtifactCardDto,
  type ArtifactDetail,
  type ArtifactErrorCode,
  type ArtifactFailure,
  type ArtifactKind,
  type ArtifactLimits,
  type ArtifactLinkInfo,
  type ArtifactOverLimits,
  type ArtifactsDetailOutcome,
  type ArtifactsInspectOutcome,
  type ArtifactsLinkOutcome,
  type ArtifactsProgressPhase,
  type ArtifactsPublishOutcome,
  type ArtifactsSupport,
  type ArtifactVisibility,
  type CreatedArtifactLink,
  type PublishedArtifact,
  type PublishVisibility
} from '../../../shared/artifacts'

export const ARTIFACTS_PATH = '/api/v1/artifacts'
export const CAPABILITIES_PATH = `${ARTIFACTS_PATH}/capabilities`

/** What the service needs from the profile, the network, the folder index and the DB. */
export interface ArtifactServiceDeps {
  /** The active profile's user id. */
  profileId: () => string
  /** The profile's server (trailing slash stripped) and whether it holds tokens; null when not a Cinna profile. */
  account: (profileId: string) => { serverUrl: string; signedIn: boolean } | null
  /** The discovery document (cached by the caller). */
  discover: (serverUrl: string) => Promise<{ artifacts?: number; instance_name?: string }>
  /** `cinnaFetch`: a JSON GET that throws `CinnaApiError` on any refusal. */
  fetchJson: (profileId: string, path: string) => Promise<unknown>
  /** `cinnaSend`: a write whose refusals come back as data. */
  send: (
    profileId: string,
    path: string,
    opts: { method: 'POST' | 'PATCH' | 'DELETE'; json?: unknown; bytes?: { data: Uint8Array; contentType: string } }
  ) => Promise<CinnaSendResult>
  /** The folder behind a folder agent id. Throws when there is none. */
  locateAgent: (agentId: string) => string
  agentName: (agentId: string) => string
  /** A canonical realpath; rejects when the path is missing. */
  realpath: (path: string) => Promise<string>
  repo: {
    findBySource(profileUserId: string, serverUrl: string, sourcePath: string): PublishedArtifactRow | null
    get(profileUserId: string, serverUrl: string, artifactId: string): PublishedArtifactRow | null
    recordPublish(profileUserId: string, serverUrl: string, source: { sourcePath: string; agentId: string }, state: PublishedArtifactState): void
    sync(profileUserId: string, serverUrl: string, state: PublishedArtifactState): void
    forget(profileUserId: string, serverUrl: string, artifactId: string): void
    addCard(profileUserId: string, chatId: string, messageId: string, artifactId: string): void
    cards(profileUserId: string, serverUrl: string, chatId: string): Array<{ card: { id: string; chatId: string; messageId: string }; artifact: PublishedArtifactRow }>
    /** The page URLs core gave for this profile's artifacts on this server (where its frontend lives). */
    urls(profileUserId: string, serverUrl: string): string[]
  }
  publishEvent: (channel: string, payload: unknown) => void
  /** The newest message of a chat: where a card goes when no message was named. */
  latestMessageId: (chatId: string) => string | null
}

const MESSAGES: Record<ArtifactErrorCode, string> = {
  not_supported: 'Publishing needs a Cinna account on an instance that keeps artifacts.',
  invalid_input: 'Nothing to publish.',
  path_refused: 'Only files and folders inside the agent’s folder can be published.',
  not_found: 'That file or folder is no longer there.',
  empty: 'Nothing to publish — every file here is left out.',
  over_limits: 'This is over the instance’s limits, so nothing was sent.',
  read_failed: 'A file could not be read, so nothing was sent.',
  too_large: 'This is larger than the instance accepts, so nothing was published.',
  rejected: 'The instance did not accept this upload.',
  gone: 'This artifact is no longer on the instance. Publish it as new instead.',
  forbidden: 'You can’t change this artifact.',
  reauth_required: 'Sign in to Cinna again, then try once more.',
  request_failed: 'Check your connection and try again — Cinna couldn’t be reached.'
}

/** `path_refused` for a path outside the agent's folder; an excluded path says its own reason. */
export const PATH_OUTSIDE_MESSAGE = MESSAGES.path_refused

function fail(code: ArtifactErrorCode, message?: string): ArtifactFailure {
  return { ok: false, code, message: message || MESSAGES[code] }
}

function isFailure(value: object): value is ArtifactFailure {
  return 'ok' in value && (value as { ok: unknown }).ok === false
}

const record = (value: unknown): Record<string, unknown> | null =>
  value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : null
const text = (value: unknown): string => (typeof value === 'string' ? value : '')
const count = (value: unknown): number => (typeof value === 'number' && Number.isFinite(value) ? value : 0)

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const isArtifactId = (value: unknown): value is string => typeof value === 'string' && UUID.test(value)

/** Core's `{detail}` sentence, when it sent one. */
function detailOf(body: unknown): string {
  const detail = record(body)?.detail
  if (typeof detail === 'string') return detail
  const nested = record(detail)
  if (nested && typeof nested.message === 'string') return nested.message
  if (Array.isArray(detail)) {
    const first = record(detail[0])
    if (first && typeof first.msg === 'string') return first.msg
  }
  return ''
}

/** A refused write, by status. `update` marks a 404 as the artifact having gone. */
function refusal(answer: CinnaSendResult, update: boolean): ArtifactFailure {
  const detail = detailOf(answer.body)
  if (answer.status === 404) return update ? fail('gone') : fail('request_failed', detail || undefined)
  if (answer.status === 413) return fail('too_large', detail ? `${detail}. Nothing was published.` : undefined)
  if (answer.status === 400 || answer.status === 422) return fail('rejected', detail || undefined)
  if (answer.status === 403) return fail('forbidden', detail || undefined)
  return fail('request_failed', detail ? `Cinna answered ${answer.status}: ${detail}` : undefined)
}

function toArtifact(value: unknown): PublishedArtifact | null {
  const body = record(value)
  if (!body || !isArtifactId(body.id)) return null
  const kind: ArtifactKind = body.kind === 'site' ? 'site' : 'files'
  const visibility: ArtifactVisibility = body.visibility === 'instance' ? 'instance' : 'private'
  const revision = count(body.revision_number) || count(body.current_revision_number)
  return {
    id: (body.id as string).toLowerCase(),
    title: text(body.title),
    kind,
    revision,
    visibility,
    liveLinkCount: count(body.live_link_count),
    url: text(body.url)
  }
}

/** The `scheme://host[:port]` of an `http(s)` URL, or null. */
export function originOf(url: string): string | null {
  if (!/^https?:\/\//i.test(url)) return null
  try {
    return new URL(url).origin
  } catch {
    return null
  }
}

function toLink(value: unknown): ArtifactLinkInfo | null {
  const link = record(value)
  if (!link || typeof link.id !== 'string') return null
  const revoked = link.revoked_at !== null && link.revoked_at !== undefined
  return {
    id: link.id,
    tokenPrefix: text(link.token_prefix),
    label: typeof link.label === 'string' ? link.label : null,
    createdAt: text(link.created_at),
    expiresAt: typeof link.expires_at === 'string' ? link.expires_at : null,
    live: !revoked && link.expired !== true && link.blocked !== true,
    needsCode: link.needs_code === true
  }
}

function toDetail(value: unknown): ArtifactDetail | null {
  const artifact = toArtifact(value)
  const body = record(value)
  if (!artifact || !body) return null
  const links = (Array.isArray(body.links) ? body.links : [])
    .map(toLink)
    .filter((link): link is ArtifactLinkInfo => link !== null)
    .sort((a, b) => Number(b.live) - Number(a.live))
  return {
    ...artifact,
    isOwner: body.is_owner === true,
    ownerName: typeof body.owner_name === 'string' ? body.owner_name : null,
    grantCount: count(body.grant_count),
    links
  }
}

function stateOf(artifact: PublishedArtifact): PublishedArtifactState {
  return {
    artifactId: artifact.id,
    title: artifact.title,
    kind: artifact.kind,
    revision: artifact.revision,
    visibility: artifact.visibility,
    url: artifact.url,
    liveLinkCount: artifact.liveLinkCount
  }
}

function toPublished(row: PublishedArtifactRow): PublishedArtifact {
  return {
    id: row.artifactId,
    title: row.title,
    kind: row.kind,
    revision: row.revision,
    visibility: row.visibility,
    liveLinkCount: row.liveLinkCount,
    url: row.url
  }
}

function toLimits(value: unknown): ArtifactLimits | null {
  const limits = record(record(value)?.limits)
  if (!limits) return null
  const maxRevisionBytes = count(limits.max_revision_bytes)
  const maxRevisionFiles = count(limits.max_revision_files)
  const maxFileBytes = count(limits.max_file_bytes)
  if (!maxRevisionBytes || !maxRevisionFiles || !maxFileBytes) return null
  return { maxRevisionBytes, maxRevisionFiles, maxFileBytes }
}

/** The over-limit sentence, as the dialog's total line and a refusal say it. */
export function overLimitsMessage(over: ArtifactOverLimits, limits: ArtifactLimits): string {
  if (over.files) return `Over the limit: more than ${limits.maxRevisionFiles.toLocaleString('en-US')} files.`
  if (over.size) return `Over the limit: more than ${formatArtifactBytes(limits.maxRevisionBytes)} in total.`
  const first = over.perFile[0] ?? 'A file'
  return `Over the limit: ${first} is larger than ${formatArtifactBytes(limits.maxFileBytes)}.`
}

/** A `multipart/form-data` body of text fields and one zip `archive`. */
export function artifactMultipart(fields: Record<string, string>, archiveName: string, archive: Buffer): { data: Buffer; contentType: string } {
  const boundary = `----cinna-artifact-${randomBytes(16).toString('hex')}`
  const parts: Buffer[] = []
  for (const [name, value] of Object.entries(fields)) {
    parts.push(Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="${name}"\r\n\r\n${value}\r\n`, 'utf8'))
  }
  // The file name is informational; quotes and line breaks would end the header.
  const safeName = archiveName.replace(/["\r\n\\]/g, '_')
  parts.push(
    Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="archive"; filename="${safeName}"\r\nContent-Type: application/zip\r\n\r\n`, 'utf8'),
    archive,
    Buffer.from(`\r\n--${boundary}--\r\n`, 'utf8')
  )
  return { data: Buffer.concat(parts), contentType: `multipart/form-data; boundary=${boundary}` }
}

/** Read a file the walk kept, refusing one that became a symlink or grew past the cap since. */
function readKept(abs: string, maxBytes: number): Buffer | null {
  let fd: number
  try {
    fd = openSync(abs, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0))
  } catch {
    return null
  }
  try {
    const info = fstatSync(fd)
    if (!info.isFile() || info.size > maxBytes) return null
    const buffer = Buffer.alloc(info.size)
    let offset = 0
    while (offset < buffer.length) {
      const read = readSync(fd, buffer, offset, buffer.length - offset, offset)
      if (read === 0) break
      offset += read
    }
    return buffer.subarray(0, offset)
  } catch {
    return null
  } finally {
    closeSync(fd)
  }
}

/** How a main-side caller (the agent tool) names the folder it already validated. */
export interface ArtifactCallOptions {
  /** The agent's folder, from a validated session; otherwise it is located from the agent id. */
  agentDir?: string
  /** The profile the agent's session was opened under; otherwise the active one. */
  profileUserId?: string
}

interface Account {
  profile: string
  serverUrl: string
  instanceName?: string
  limits: ArtifactLimits
}

interface Confined {
  agentId: string
  real: string
  /** Relative to the agent folder, `/`-separated; `.` for the folder itself. */
  rel: string
}

export function createArtifactService(deps: ArtifactServiceDeps) {
  /** Limits per server, read once a session when core answers. */
  const limitsByServer = new Map<string, ArtifactLimits>()
  /** The last support answer per profile, for synchronous readers (the agent tool's offer). */
  const lastSupport = new Map<string, ArtifactsSupport>()

  async function supportFor(profile: string): Promise<{ support: ArtifactsSupport; serverUrl: string | null }> {
    const answer = await computeSupport(profile)
    lastSupport.set(profile, answer.support)
    return answer
  }

  async function computeSupport(profile: string): Promise<{ support: ArtifactsSupport; serverUrl: string | null }> {
    const unsupported = { support: { supported: false, limits: FALLBACK_ARTIFACT_LIMITS }, serverUrl: null }
    const account = deps.account(profile)
    if (!account || !account.signedIn) return unsupported
    let discovery: { artifacts?: number; instance_name?: string }
    try {
      discovery = await deps.discover(account.serverUrl)
    } catch {
      return unsupported
    }
    if (typeof discovery.artifacts !== 'number' || discovery.artifacts < 1) return unsupported
    let limits = limitsByServer.get(account.serverUrl)
    if (!limits) {
      try {
        const read = toLimits(await deps.fetchJson(profile, CAPABILITIES_PATH))
        if (read) limitsByServer.set(account.serverUrl, read)
        limits = read ?? FALLBACK_ARTIFACT_LIMITS
      } catch {
        limits = FALLBACK_ARTIFACT_LIMITS
      }
    }
    const instanceName = text(discovery.instance_name) || undefined
    return {
      support: { supported: true, ...(instanceName ? { instanceName } : {}), limits, linkOrigins: linkOrigins(profile, account.serverUrl) },
      serverUrl: account.serverUrl
    }
  }

  /** Frontend origins learned from artifact URLs core returned, per `profile\nserver`. */
  const learnedOrigins = new Map<string, Set<string>>()

  function learnOrigin(who: Pick<Account, 'profile' | 'serverUrl'>, url: string): void {
    const origin = originOf(url)
    if (!origin) return
    const key = `${who.profile}\n${who.serverUrl}`
    const known = learnedOrigins.get(key) ?? new Set<string>()
    known.add(origin)
    learnedOrigins.set(key, known)
  }

  /**
   * Where an `/artifact/<uuid>` link may point for this profile to be read as
   * one of its artifacts: the server itself, and every frontend origin core
   * named in an artifact URL (remembered rows, then this session's reads).
   */
  function linkOrigins(profile: string, serverUrl: string): string[] {
    const origins = new Set<string>()
    const server = originOf(serverUrl)
    if (server) origins.add(server)
    try {
      for (const url of deps.repo.urls(profile, serverUrl)) {
        const origin = originOf(url)
        if (origin) origins.add(origin)
      }
    } catch {
      // The memory is a hint; the server origin stands alone.
    }
    for (const origin of learnedOrigins.get(`${profile}\n${serverUrl}`) ?? []) origins.add(origin)
    return [...origins]
  }

  async function account(options: ArtifactCallOptions = {}): Promise<Account | ArtifactFailure> {
    const profile = options.profileUserId ?? deps.profileId()
    const { support, serverUrl } = await supportFor(profile)
    if (!support.supported || !serverUrl) return fail('not_supported')
    return { profile, serverUrl, instanceName: support.instanceName, limits: support.limits }
  }

  async function confine(input: unknown, options: ArtifactCallOptions = {}): Promise<Confined | ArtifactFailure> {
    const { agentId, path } = (record(input) ?? {}) as { agentId?: unknown; path?: unknown }
    if (typeof agentId !== 'string' || agentId === '' || typeof path !== 'string' || path === '' || path.includes('\0')) {
      return fail('invalid_input')
    }
    let agentDir: string
    try {
      agentDir = options.agentDir ?? deps.locateAgent(agentId)
    } catch {
      return fail('not_found', 'That agent is no longer in your agents folder.')
    }
    let realAgentDir: string
    let real: string
    try {
      realAgentDir = await deps.realpath(agentDir)
    } catch {
      return fail('not_found', 'That agent is no longer in your agents folder.')
    }
    try {
      // A relative path is the agent's own way of naming a file (D2's tool).
      real = await deps.realpath(isAbsolute(path) ? path : join(agentDir, path))
    } catch {
      return fail('not_found')
    }
    if (!isWithin(realAgentDir, real)) return fail('path_refused')
    const rel = relative(realAgentDir, real).split(sep).join('/') || '.'
    const refused = excludedSegment(rel, real)
    if (refused) return fail('path_refused', refused)
    return { agentId, real, rel }
  }

  /**
   * A10 applied to the path itself, not only to what is under it: a file
   * inside `credentials/`, `.git/`, `.claude/`, `app-data/` or
   * `node_modules/`, or a secret file named directly, is never published.
   * The sentence names why.
   */
  function excludedSegment(rel: string, real: string): string | null {
    if (rel === '.') return null
    const segments = rel.split('/')
    for (let i = 0; i < segments.length; i++) {
      const name = segments[i]
      const last = i === segments.length - 1
      let isDirectory = true
      if (last) {
        try {
          isDirectory = lstatSync(real).isDirectory()
        } catch {
          isDirectory = false
        }
      }
      const reason = exclusionFor(name, isDirectory)
      if (reason) return `${isDirectory ? `${name}/` : name} is never published (${reason}).`
    }
    return null
  }

  function walk(real: string, limits: ArtifactLimits, entry: string | null): InspectResult | ArtifactFailure {
    try {
      return inspectArtifactPath(real, limits, entry)
    } catch {
      return fail('read_failed', 'This file or folder could not be read.')
    }
  }

  function known(row: PublishedArtifactRow | null) {
    return row ? { artifactId: row.artifactId, title: row.title, revision: row.revision, visibility: row.visibility } : null
  }

  async function guarded<T extends { ok: boolean }>(run: () => Promise<T | ArtifactFailure>): Promise<T | ArtifactFailure> {
    try {
      return await run()
    } catch (err) {
      if (err instanceof CinnaReauthRequired) return fail('reauth_required')
      if (err instanceof CinnaApiError) {
        if (err.code === 'reauth_required') return err.status === 403 ? fail('forbidden') : fail('reauth_required')
        if (err.code === 'not_cinna_user' || err.code === 'missing_server_url') return fail('not_supported')
        if (err.status === 404) return fail('gone')
        return fail('request_failed', err.detail && err.status ? `Cinna answered ${err.status}: ${err.detail}` : undefined)
      }
      if (err instanceof CinnaSessionChanged) return fail('request_failed', 'The Cinna account changed meanwhile. Try again.')
      return fail('request_failed', `Something went wrong: ${err instanceof Error ? err.message : String(err)}`.slice(0, 300))
    }
  }

  const changed = (artifactId: string): void => deps.publishEvent(ARTIFACTS_CHANGED_CHANNEL, { artifactId })

  /** Core's current state of an artifact; the local row follows it. A 404 forgets the row. */
  async function readDetail(who: Account, artifactId: string): Promise<ArtifactDetail | ArtifactFailure> {
    let body: unknown
    try {
      body = await deps.fetchJson(who.profile, `${ARTIFACTS_PATH}/${artifactId}`)
    } catch (err) {
      if (err instanceof CinnaApiError && err.status === 404) {
        deps.repo.forget(who.profile, who.serverUrl, artifactId)
        return fail('gone')
      }
      throw err
    }
    const detail = toDetail(body)
    if (!detail) return fail('request_failed', 'Cinna answered with something that is not an artifact.')
    learnOrigin(who, detail.url)
    if (detail.isOwner) deps.repo.sync(who.profile, who.serverUrl, stateOf(detail))
    return detail
  }

  return {
    /** Whether the active profile can publish, and the instance's limits. Never throws. */
    async support(): Promise<ArtifactsSupport> {
      try {
        return (await supportFor(deps.profileId())).support
      } catch {
        return { supported: false, limits: FALLBACK_ARTIFACT_LIMITS }
      }
    },

    /** What publishing `{agentId, path}` would send, and what it was published as before. */
    async inspect(input: unknown, options: ArtifactCallOptions = {}): Promise<ArtifactsInspectOutcome> {
      return guarded(async () => {
        const who = await account(options)
        if (isFailure(who)) return who
        const target = await confine(input, options)
        if (isFailure(target)) return target
        const entry = text(record(input)?.entry) || null
        const walked = walk(target.real, who.limits, entry)
        if (isFailure(walked)) return walked
        return {
          ok: true as const,
          inspection: {
            name: walked.name,
            relativePath: target.rel,
            path: target.real,
            isFolder: walked.isFolder,
            kind: walked.kind,
            entry: walked.entry,
            entryCandidates: walked.entryCandidates,
            files: walked.files.map(({ path, size }) => ({ path, size })),
            excluded: walked.excluded,
            size: walked.size,
            overLimits: walked.overLimits,
            limits: who.limits,
            ...(who.instanceName ? { instanceName: who.instanceName } : {}),
            previous: known(deps.repo.findBySource(who.profile, who.serverUrl, target.real))
          }
        }
      })
    },

    /**
     * Publish (or, with `artifactId`, add a revision to) the path; then the
     * chosen visibility follow-up, the local memory and the chat card.
     */
    async publish(input: unknown, options: ArtifactCallOptions = {}): Promise<ArtifactsPublishOutcome> {
      return guarded(async () => {
        const raw = record(input) ?? {}
        const title = text(raw.title).trim()
        const description = text(raw.description).trim()
        const visibility = raw.visibility as PublishVisibility | 'keep'
        const artifactId = raw.artifactId === null || raw.artifactId === undefined || raw.artifactId === '' ? null : raw.artifactId
        const entry = text(raw.entry) || null
        const operationId = text(raw.operationId)
        const anchor = record(raw.anchor)
        if (!title || title.length > 200 || description.length > 2000) return fail('invalid_input', 'A title of up to 200 characters is needed.')
        // `keep`: leave who can see it as it is (an agent's republish of an artifact a person shared).
        if (visibility !== 'private' && visibility !== 'instance' && visibility !== 'link' && visibility !== 'keep') return fail('invalid_input')
        if (artifactId !== null && !isArtifactId(artifactId)) return fail('invalid_input')

        const who = await account(options)
        if (isFailure(who)) return who
        const target = await confine(raw, options)
        if (isFailure(target)) return target
        const progress = (phase: ArtifactsProgressPhase): void => {
          if (operationId) deps.publishEvent(ARTIFACTS_PROGRESS_CHANNEL, { operationId, phase })
        }

        progress('packing')
        // Again, now: what is sent is what is on disk, not what the dialog showed.
        const walked = walk(target.real, who.limits, entry)
        if (isFailure(walked)) return walked
        if (entry && walked.entry !== entry) return fail('rejected', 'That start page is no longer in the folder. Pick another.')
        if (walked.files.length === 0) return fail('empty')
        if (walked.overLimits) return fail('over_limits', `${overLimitsMessage(walked.overLimits, who.limits)} Nothing was sent.`)
        const entries: ZipEntry[] = []
        let total = 0
        for (const file of walked.files) {
          const data = readKept(file.abs, who.limits.maxFileBytes)
          if (!data) return fail('read_failed', `${file.path} could not be read, so nothing was sent.`)
          total += data.length
          if (total > who.limits.maxRevisionBytes) return fail('over_limits', `${overLimitsMessage({ files: false, size: true, perFile: [] }, who.limits)} Nothing was sent.`)
          entries.push({ name: file.path, data })
        }
        const archive = buildZip(entries)

        const fields: Record<string, string> = { title }
        if (description) fields.description = description
        if (walked.kind === 'site' && walked.entry) fields.entry_path = walked.entry
        if (artifactId === null) {
          fields.source_kind = 'desktop'
          let agent = ''
          try {
            agent = deps.agentName(target.agentId)
          } catch {
            agent = ''
          }
          fields.source_label = `${agent || 'Agent'} · ${target.rel}`.slice(0, 200)
        }

        progress('uploading')
        const path = artifactId === null ? ARTIFACTS_PATH : `${ARTIFACTS_PATH}/${artifactId}/revisions`
        const answer = await deps.send(who.profile, path, {
          method: 'POST',
          bytes: artifactMultipart(fields, `${walked.name}.zip`, archive)
        })
        if (!answer.ok) {
          if (answer.status === 404 && artifactId !== null) deps.repo.forget(who.profile, who.serverUrl, artifactId)
          return refusal(answer, artifactId !== null)
        }
        let artifact = toArtifact(answer.body)
        if (!artifact) return fail('request_failed', 'Cinna answered with something that is not an artifact.')
        learnOrigin(who, artifact.url)
        const excluded = (Array.isArray(record(answer.body)?.excluded) ? (record(answer.body)?.excluded as unknown[]) : []).filter(
          (path): path is string => typeof path === 'string'
        )
        deps.repo.recordPublish(who.profile, who.serverUrl, { sourcePath: target.real, agentId: target.agentId }, stateOf(artifact))

        let link: CreatedArtifactLink | undefined
        let warning: string | undefined
        const wanted: ArtifactVisibility | null = visibility === 'link' || visibility === 'keep' ? null : visibility
        if (wanted && wanted !== artifact.visibility) {
          progress('sharing')
          const patched = await deps.send(who.profile, `${ARTIFACTS_PATH}/${artifact.id}`, { method: 'PATCH', json: { visibility: wanted } })
          const after = patched.ok ? toArtifact(patched.body) : null
          if (after) artifact = { ...artifact, visibility: after.visibility, liveLinkCount: after.liveLinkCount }
          else warning = `Published, but it is still visible only to you: ${refusal(patched, false).message}`
        } else if (visibility === 'link') {
          progress('sharing')
          const created = await deps.send(who.profile, `${ARTIFACTS_PATH}/${artifact.id}/links`, { method: 'POST', json: {} })
          const body = record(created.body)
          if (created.ok && body && typeof body.url === 'string') {
            link = { url: body.url, ...(typeof body.code === 'string' ? { code: body.code } : {}) }
            artifact = { ...artifact, liveLinkCount: artifact.liveLinkCount + 1 }
          } else {
            warning = `Published, but the link could not be created — try Share… on the card: ${refusal(created, false).message}`
          }
        }
        deps.repo.sync(who.profile, who.serverUrl, stateOf(artifact))
        if (anchor && typeof anchor.chatId === 'string' && anchor.chatId) {
          // After the message the publish came from; else the chat's newest.
          const messageId = typeof anchor.messageId === 'string' && anchor.messageId ? anchor.messageId : deps.latestMessageId(anchor.chatId)
          try {
            if (messageId) deps.repo.addCard(who.profile, anchor.chatId, messageId, artifact.id)
          } catch {
            // A chat deleted meanwhile has no card to show; the publish stands.
          }
        }
        changed(artifact.id)
        return {
          ok: true as const,
          artifact,
          excluded,
          sent: { fileCount: walked.files.length, sizeBytes: total, excluded: walked.excluded.map((item) => item.path) },
          sourcePath: target.real,
          ...(link ? { link } : {}),
          ...(warning ? { warning } : {})
        }
      })
    },

    /** Core's current state of an artifact (for the Share popover, and a link in agent text). */
    async detail(artifactId: unknown, options: ArtifactCallOptions = {}): Promise<ArtifactsDetailOutcome> {
      return guarded(async () => {
        if (!isArtifactId(artifactId)) return fail('invalid_input')
        const who = await account(options)
        if (isFailure(who)) return who
        const detail = await readDetail(who, artifactId.toLowerCase())
        if (isFailure(detail)) return detail
        return { ok: true as const, detail }
      })
    },

    async setVisibility(artifactId: unknown, visibility: unknown): Promise<ArtifactsDetailOutcome> {
      return guarded(async () => {
        if (!isArtifactId(artifactId) || (visibility !== 'private' && visibility !== 'instance')) return fail('invalid_input')
        const who = await account()
        if (isFailure(who)) return who
        const id = artifactId.toLowerCase()
        const answer = await deps.send(who.profile, `${ARTIFACTS_PATH}/${id}`, { method: 'PATCH', json: { visibility } })
        if (!answer.ok) return refusal(answer, true)
        const detail = await readDetail(who, id)
        if (isFailure(detail)) return detail
        changed(id)
        return { ok: true as const, detail }
      })
    },

    /** A public link; its URL (and code) are returned this once and never stored. */
    async createLink(artifactId: unknown, options?: unknown): Promise<ArtifactsLinkOutcome> {
      return guarded(async () => {
        if (!isArtifactId(artifactId)) return fail('invalid_input')
        const who = await account()
        if (isFailure(who)) return who
        const id = artifactId.toLowerCase()
        const withCode = record(options)?.withCode === true
        const answer = await deps.send(who.profile, `${ARTIFACTS_PATH}/${id}/links`, { method: 'POST', json: { with_code: withCode } })
        if (!answer.ok) return refusal(answer, true)
        const body = record(answer.body)
        if (!body || typeof body.url !== 'string') return fail('request_failed', 'Cinna answered with something that is not a link.')
        const link: CreatedArtifactLink = { url: body.url, ...(typeof body.code === 'string' ? { code: body.code } : {}) }
        const detail = await readDetail(who, id).catch(() => null)
        changed(id)
        return { ok: true as const, link, detail: detail && !isFailure(detail) ? detail : null }
      })
    },

    async revokeLink(artifactId: unknown, linkId: unknown): Promise<ArtifactsDetailOutcome> {
      return guarded(async () => {
        if (!isArtifactId(artifactId) || !isArtifactId(linkId)) return fail('invalid_input')
        const who = await account()
        if (isFailure(who)) return who
        const id = artifactId.toLowerCase()
        const answer = await deps.send(who.profile, `${ARTIFACTS_PATH}/${id}/links/${linkId}`, { method: 'DELETE' })
        if (!answer.ok && answer.status !== 404) return refusal(answer, true)
        const detail = await readDetail(who, id)
        if (isFailure(detail)) return detail
        changed(id)
        return { ok: true as const, detail }
      })
    },

    /** The last support answer for `profile` (or the active one), without asking again. False until one was read. */
    supportedNow(profile: string = deps.profileId()): ArtifactsSupport {
      return lastSupport.get(profile) ?? { supported: false, limits: FALLBACK_ARTIFACT_LIMITS }
    },

    /** The active profile's server, from its row (no network); null when it is not a Cinna profile. */
    serverOf(profile: string = deps.profileId()): string | null {
      return deps.account(profile)?.serverUrl ?? null
    },

    /** A published artifact from the local memory of the active profile and server. No network. */
    local(artifactId: unknown): PublishedArtifact | null {
      if (!isArtifactId(artifactId)) return null
      const profile = deps.profileId()
      const account = deps.account(profile)
      if (!account) return null
      const row = deps.repo.get(profile, account.serverUrl, artifactId.toLowerCase())
      return row ? toPublished(row) : null
    },

    /** A chat's artifact cards for the active profile, from the local memory. No network. */
    cards(chatId: unknown): ArtifactCardDto[] {
      if (typeof chatId !== 'string' || chatId === '') return []
      const profile = deps.profileId()
      const account = deps.account(profile)
      if (!account) return []
      return deps.repo.cards(profile, account.serverUrl, chatId).map(({ card, artifact }) => ({
        id: card.id,
        chatId: card.chatId,
        messageId: card.messageId,
        artifact: toPublished(artifact)
      }))
    }
  }
}

export type ArtifactService = ReturnType<typeof createArtifactService>
