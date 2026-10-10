/**
 * Team sharing of folder agents: Get, Update, Share changes, Share with the
 * team, and the two-button answer to a collision.
 *
 * A shared agent is a `Local/<slug>/` folder that is its own git working tree
 * with an `origin`. **Nothing about the sharing is stored**: the remote, its
 * kind, and a Cinna remote's repository id and host are read back from
 * `origin`'s URL every time, and what only the catalog knows — the caller's
 * access, the team's latest head and version — comes from `libraryService`'s
 * cached listing of `/api/v1/catalog/items`. An agent a developer cloned by
 * hand is recognised exactly like one the app fetched. The one thing written
 * down is the contract's `shared_remote` link in `app-data/desktop.json`,
 * which carries the catalog id (`bundle_id`) the Sharing tab shows.
 *
 * Every entry point takes an agent id (or a library repository id) and
 * resolves the folder itself through `localAgentService.locate`; no path ever
 * arrives from the renderer. A Cinna token is minted by `getCinnaAccessToken`
 * immediately before each git child that needs it, and only for the profile
 * whose server is the remote's host — never sent to another origin.
 *
 * Core service: no Electron, no window. The IPC adapter wraps every answer in
 * a `SharingOutcome`.
 */
import { cpSync, existsSync, readFileSync, renameSync, rmSync, statSync } from 'node:fs'
import { randomUUID } from 'node:crypto'
import { basename, dirname, join } from 'node:path'
import { realpathSync } from 'node:fs'
import { publishEvent } from '../../host/events'
import { userRepo } from '../../db/users'
import { getCinnaAccessToken, getStoredCinnaSubject } from '../../auth/cinna-tokens'
import { getProfileScopeUserId } from '../../auth/scope'
import { cinnaFetch } from '../cinna-http'
import { CinnaApiError, LocalAgentError } from '../../errors'
import { CinnaReauthRequired } from '../../auth/cinna-oauth'
import { manifestPath, readManifest, writeManifest } from '../../kit/manifestIo'
import { aiFunctions } from '../aiFunctionsService'
import { SHARE_SUMMARY_SYSTEM_PROMPT } from '../aiFunctionPrompts'
import { libraryTrust } from '../libraryTrust'
import { desktopStateService, type DesktopSharedRemote } from './desktopStateService'
import {
  catalogItemPath,
  libraryService,
  toLibraryEntry,
  type CachedListing,
  type LibraryEntry
} from '../libraryService'
import { catalogLocalInstalls } from '../catalogLocalInstalls'
import { createLogger } from '../../logger/logger'
import { AGENTS_SUBDIR, folderAgentId } from '../../../shared/localAgents'
import { MANIFEST_FILE, SLUG_PATTERN } from '../../../shared/kit/manifest'
import {
  SHARING_CHANGED_CHANNEL,
  type AgentPeopleDto,
  type AgentRemote,
  type AgentShareResult,
  type AgentShareState,
  type AgentShareStatus,
  type AgentVersionDto,
  type LibraryAccess,
  type LibraryAgentDto,
  type LibraryGrantInput,
  type LibraryListingDto,
  type LibraryPerson,
  type LibraryPrincipal,
  type PersonSearchResult,
  type ShareRefusal,
  type ShareWithTeamDraft,
  type SetPeopleResult,
  type ShareWithTeamPerson
} from '../../../shared/agentSharing'
import type { UpdateAvailableInboxItem } from '../../../shared/inbox'
import type { CatalogVisibility } from '../../../shared/catalogItems'
import type { AgentRootRow } from '../../db/agentRoots'
import type { LocalAgentDto } from '../../../shared/localAgents'
import {
  ANONYMOUS_IDENTITY,
  gitService,
  redactRemoteUrl,
  scrubCredentials,
  shareStateOf,
  type CommitIdentity,
  type RemoteAuth,
  type ShareActionResult,
  type ShareCounts
} from './gitService'
import { localAgentService } from './localAgentService'
import { serviceCredentialService } from '../serviceCredentials/service'
import { agentsHomeService } from './agentsHomeService'
import { turnLock } from './turnLock'

const logger = createLogger('agent-sharing')

/** Most of the AI summary kept for the Share changes field. */
const MAX_SUMMARY_CHARS = 600

/** A folder agent that can be shared: a kit agent directly under its root's `Local/`. */
interface KitAgent {
  root: AgentRootRow
  dir: string
}

/** A shared one: its own repository, with an `origin`. */
interface SharedAgent extends KitAgent {
  originUrl: string
  remote: AgentRemote
}

function realOrSelf(path: string): string {
  try {
    return realpathSync(path)
  } catch {
    return path
  }
}

/** Which instances may claim a git origin — `libraryTrust` in the app, a stub in tests. */
export interface GitOriginTrust {
  trusts: (serverOrigin: string, gitOrigin: string) => boolean
  serversFor: (gitOrigin: string) => string[]
}

const NO_TRUST: GitOriginTrust = { trusts: (server, origin) => server === origin, serversFor: () => [] }

/**
 * Read `origin` as a remote. `cinna` when the URL is `…/git/<repo_id>.git` on
 * a git origin a Cinna instance this machine has a profile for **has itself
 * named** — its own origin, or one its listing or create answer gave
 * (`libraryTrust`). Anything else is `external`. `host` is the instance's API
 * origin, which is what picks the profile.
 *
 * The folder's recorded `cinna.server` only chooses *between* instances that
 * trust the origin; it can never make an origin trusted. `.git/config` is
 * writable by anything running in the folder, and a remote URL taken on its
 * word would send the profile's token wherever it pointed.
 */
export function parseRemote(
  originUrl: string,
  cinnaHosts: Set<string>,
  recordedServer: string | null = null,
  trust: GitOriginTrust = NO_TRUST,
  preferredServer: string | null = null
): AgentRemote {
  const external: AgentRemote = {
    kind: 'external',
    url: redactRemoteUrl(originUrl),
    repoId: null,
    host: null,
    access: null
  }
  let parsed: URL
  try {
    parsed = new URL(originUrl)
  } catch {
    return external
  }
  if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') return external
  const match = parsed.pathname.match(/\/git\/([^/]+)\.git\/?$/)
  if (!match) return external
  const candidates = [parsed.origin, ...trust.serversFor(parsed.origin)].filter(
    (server, index, all) => all.indexOf(server) === index && cinnaHosts.has(server) && trust.trusts(server, parsed.origin)
  )
  if (candidates.length === 0) return external
  const server =
    (recordedServer !== null && candidates.includes(recordedServer) ? recordedServer : null) ??
    (preferredServer !== null && candidates.includes(preferredServer) ? preferredServer : null) ??
    candidates[0]
  return { ...external, kind: 'cinna', repoId: decodeURIComponent(match[1]), host: server }
}

/** {@link parseRemote} with this machine's profiles and what their instances have said. */
function remoteOf(originUrl: string, recordedServer: string | null): AgentRemote {
  return parseRemote(
    originUrl,
    libraryService.knownHosts(),
    recordedServer,
    libraryTrust,
    libraryService.hostOf(getProfileScopeUserId())
  )
}

function result(
  action: ShareActionResult | { done: boolean; refusal: ShareRefusal | null; detail?: string | null },
  status: AgentShareStatus | null,
  agentId: string | null = null
): AgentShareResult {
  return {
    done: action.done,
    refusal: action.refusal,
    detail: action.detail ?? null,
    status,
    agentId,
    autoAttached: [],
    setupNeeded: false
  }
}

const refused = (refusal: ShareRefusal, detail: string | null = null): AgentShareResult => ({
  done: false,
  refusal,
  detail,
  status: null,
  agentId: null,
  autoAttached: [],
  setupNeeded: false
})

/**
 * The required credential slots the agent is missing, by name; null when it
 * cannot be read. An optional slot always reads as satisfied.
 */
function missingSlots(userId: string, agentId: string): Set<string> | null {
  try {
    return new Set(
      localAgentService.get(userId, agentId).credentials.filter((slot) => !slot.satisfied).map((slot) => slot.name)
    )
  } catch (err) {
    logger.warn('could not read credential readiness around a team library action', {
      error: err instanceof Error ? err.message : String(err)
    })
    return null
  }
}

/**
 * After the folder took in the team's files (Get, Update, Use the team's
 * version): attach the active account's credentials that fit a slot without
 * doubt, then say whether Finish setup should open. Never fails the action —
 * `autoAttach` swallows its own errors, and an unreadable agent reads as
 * nothing needed.
 *
 * `before` is what was missing before an Update or Use the team's version:
 * the dialog opens then only when the team's files **added** a missing slot,
 * so a user who chose Finish later is not asked again on every Update while
 * the same slot stays empty — the readiness strip's Finish setup still is.
 * Without `before` (a Get, or a read that failed), anything missing opens it.
 */
async function credentialSetup(
  userId: string,
  agentId: string,
  before: Set<string> | null = null
): Promise<Pick<AgentShareResult, 'autoAttached' | 'setupNeeded'>> {
  const autoAttached = await serviceCredentialService.autoAttach(agentId)
  const after = missingSlots(userId, agentId)
  const setupNeeded = after !== null && [...after].some((slot) => before === null || !before.has(slot))
  return { autoAttached, setupNeeded }
}

/** The kit agent behind an id, or null when it is not one that can be shared (bare, or outside `Local/`). */
function locateKit(userId: string, agentId: string): KitAgent | null {
  const { root, agentDir } = localAgentService.locate(userId, agentId)
  if (root.kind === 'external') return null
  if (realOrSelf(dirname(agentDir)) !== realOrSelf(join(root.path, AGENTS_SUBDIR))) return null
  return { root, dir: agentDir }
}

async function locateShared(userId: string, agentId: string): Promise<SharedAgent | null> {
  const kit = locateKit(userId, agentId)
  if (!kit) return null
  const remote = await gitService.readShareRemote(kit.dir)
  if (!remote.ownRepo || remote.originUrl === null) return null
  return {
    ...kit,
    originUrl: remote.originUrl,
    remote: remoteOf(remote.originUrl, remote.cinnaServer)
  }
}

/**
 * The auth a shared agent's remote needs from the active profile, or
 * `other_account` when that profile is not signed in to the remote's
 * instance — in which case nothing reaches the network.
 */
function authFor(shared: Pick<SharedAgent, 'remote' | 'originUrl'>): RemoteAuth | 'other_account' {
  const { remote } = shared
  if (remote.kind !== 'cinna' || remote.host === null) return { kind: 'external' }
  const profile = getProfileScopeUserId()
  if (libraryService.hostOf(profile) !== remote.host) return 'other_account'
  // The header is scoped to where git actually goes, which may not be the
  // instance's API origin; `parseRemote` only calls it `cinna` when this
  // instance recorded or listed that origin.
  const gitOrigin = originOf(shared.originUrl)
  // `parseRemote` already required this; checked again where the token is
  // handed out, so no later caller can build a `cinna` remote around it.
  if (gitOrigin === null || !libraryTrust.trusts(remote.host, gitOrigin)) return { kind: 'external' }
  return { kind: 'cinna', origin: gitOrigin, token: () => getCinnaAccessToken(profile) }
}

/** The active profile's listing when it is for `host`. */
function listingFor(host: string | null): CachedListing | null {
  if (host === null) return null
  const listing = libraryService.cached(getProfileScopeUserId())
  return listing && listing.host === host ? listing : null
}

/**
 * Who commits are from when the repository does not say. The active Cinna
 * profile's name and email when it has them; a profile without an email gets
 * a no-reply address on the remote's own host, built from the profile's id
 * (the only stable id this machine keeps for it — the account's id on the
 * instance is never stored), and anything else {@link ANONYMOUS_IDENTITY}'s.
 * Never this machine's login or host name: every version carries it to the
 * whole team.
 */
export function commitIdentity(remote: Pick<AgentRemote, 'kind' | 'host'> | null): CommitIdentity {
  const user = userRepo.get(getProfileScopeUserId())
  if (!user || user.type !== 'cinna_user') return ANONYMOUS_IDENTITY
  const name = user.cinnaFullName?.trim() || user.displayName?.trim() || ANONYMOUS_IDENTITY.name
  if (user.username.includes('@')) return { name, email: user.username }
  let host: string | null = null
  if (remote?.kind === 'cinna' && remote.host) {
    try {
      host = new URL(remote.host).hostname || null
    } catch {
      host = null
    }
  }
  return { name, email: host ? `${user.id}@users.noreply.${host}` : ANONYMOUS_IDENTITY.email }
}

/** The catalog id this machine recorded for the folder (`shared_remote.bundle_id`), or null. */
function recordedBundleId(dir: string): string | null {
  try {
    return desktopStateService.read(dir, 'kit').shared_remote?.bundle_id ?? null
  } catch {
    return null
  }
}

function buildStatus(
  agentId: string,
  shared: SharedAgent,
  counts: ShareCounts,
  override: AgentShareState | null,
  access: AgentRemote['access']
): AgentShareStatus {
  const unshared = counts.ahead > 0 || counts.changedFiles > 0
  return {
    agentId,
    remote: { ...shared.remote, access },
    bundleId: shared.remote.kind === 'cinna' ? recordedBundleId(shared.dir) : null,
    state: override ?? shareStateOf(counts),
    headSha: counts.headSha,
    remoteHeadSha: counts.remoteHeadSha,
    ahead: counts.ahead,
    behind: counts.behind,
    changedFiles: counts.changedFiles,
    unshared,
    fetched: counts.fetched,
    refusal: counts.refusal === 'not_shared' ? null : counts.refusal
  }
}

/**
 * Put back the local-only files an interrupted update left backed up under
 * `.git/`, when nothing else holds the agent's lock — never in the middle of
 * an action that is using the backup. Never throws.
 */
function recoverLocalOnlyFiles(agentId: string, dir: string): void {
  if (!gitService.hasLeftoverLocalOnlyFiles(dir)) return
  let lock: { release: () => void } | null = null
  try {
    lock = lockOrRefuse(agentId)
    if (lock) gitService.restoreLeftoverLocalOnlyFiles(dir)
  } catch (err) {
    logger.warn('could not check for a local-only backup', { error: String(err) })
  } finally {
    lock?.release()
  }
}

/** The status of an already-located shared agent. */
async function statusOf(agentId: string, shared: SharedAgent, fetch: boolean): Promise<AgentShareStatus> {
  recoverLocalOnlyFiles(agentId, shared.dir)
  const auth = authFor(shared)
  if (auth === 'other_account') {
    // Counts from what is on disk; no listing, no network, no token.
    const counts = await gitService.readShareStatus(shared.dir, null, false, null, shared.remote.kind === 'cinna')
    return buildStatus(agentId, shared, counts, 'other_account', null)
  }
  const listing = listingFor(shared.remote.host)
  const entry = listing?.agents.find((agent) => agent.repoId === shared.remote.repoId) ?? null
  // A 404/403 listing stands in as empty and says nothing about this entry.
  const removed = shared.remote.kind === 'cinna' && listing !== null && listing.available && entry === null
  const counts = await gitService.readShareStatus(
    shared.dir,
    auth,
    fetch && !removed,
    entry?.headSha || null
  )
  return buildStatus(agentId, shared, counts, removed ? 'removed' : null, entry?.access ?? null)
}

/** Re-list after a change, so the next status reads the team's new head. Best effort. */
async function refreshListing(): Promise<void> {
  try {
    await libraryService.refresh(getProfileScopeUserId())
  } catch (err) {
    logger.warn('team library refresh after a sharing action failed', {
      error: err instanceof Error ? err.message : String(err)
    })
  }
}

function settle(userId: string, rootId: string): void {
  localAgentService.rescan(userId, rootId)
  publishEvent(SHARING_CHANGED_CHANNEL)
}

/** Take the agent's turn lock, or answer `turn_in_progress`. */
function lockOrRefuse(agentId: string): { release: () => void } | null {
  try {
    return turnLock.acquire(agentId, 'sharing')
  } catch (err) {
    if (err instanceof LocalAgentError && err.code === 'turn_in_progress') return null
    throw err
  }
}

/** Every local kit agent under `Local/` whose folder has a `.git` of its own — the candidates for sharing. */
function repoCandidates(userId: string): LocalAgentDto[] {
  return localAgentService
    .list(userId)
    .agents.filter(
      (agent) =>
        agent.kind === 'kit' &&
        existsSync(join(agent.path, '.git')) &&
        realOrSelf(dirname(agent.path)) === realOrSelf(join(agent.rootPath, AGENTS_SUBDIR))
    )
}

/** Ignored entries never worth carrying: rebuilt on demand, or Finder litter. */
const NOT_CARRIED = new Set(['.venv', '__pycache__', 'node_modules', '.DS_Store'])

/**
 * Give the team version this machine's per-machine files from the folder it
 * replaced: everything git ignores there — `credentials/.env`,
 * `credentials.json`, `app-data/` with the desktop state — which a clone never
 * brings. **Copied, not moved**, so the kept copy still runs; and only where
 * the team version has nothing at that path, file by file, so nothing that
 * arrived with the clone is overwritten. Answers what could not be copied, so
 * the user hears that the team version is missing, say, a credential.
 */
async function carryMachineFiles(fromDir: string, toDir: string): Promise<string[]> {
  const missed: string[] = []
  for (const entry of await gitService.ignoredPaths(fromDir)) {
    const rel = entry.replace(/\/$/, '')
    if (rel === '' || rel.split('/').some((segment) => NOT_CARRIED.has(segment))) continue
    try {
      cpSync(join(fromDir, rel), join(toDir, rel), {
        recursive: true,
        force: false,
        errorOnExist: false,
        filter: (source) => !NOT_CARRIED.has(basename(source))
      })
    } catch (err) {
      missed.push(rel)
      logger.warn('a per-machine file could not be carried to the team version', {
        path: rel,
        error: err instanceof Error ? err.message : String(err)
      })
    }
  }
  return missed
}

/**
 * Undo Use the team's version: drop the team clone when it landed (it is
 * ours — the original folder was renamed away before it was made), then move
 * the kept folder back. A rename-back that fails leaves it at `<slug>-mine`
 * with its id intact and nothing at the original path, which a rescan
 * indexes as the same agent — never two folders with one id.
 */
function putBack(mineDir: string, dir: string, landed: boolean): void {
  try {
    if (landed) {
      // Renamed out of the way before it is deleted: a delete that fails part
      // way (a file held open) would otherwise leave a partial clone with the
      // original id at the path, and stop the rename-back. A dot-folder is
      // skipped by the scanner, so a leftover is never indexed.
      const discard = join(dirname(dir), `.${basename(dir)}.discard-${randomUUID().slice(0, 8)}`)
      renameSync(dir, discard)
      try {
        rmSync(discard, { recursive: true, force: true })
      } catch (err) {
        logger.warn('a discarded team clone could not be deleted', {
          error: err instanceof Error ? err.message : String(err)
        })
      }
    }
    if (!existsSync(dir)) renameSync(mineDir, dir)
  } catch (err) {
    logger.warn('the folder could not be moved back after use the team version failed', {
      error: err instanceof Error ? err.message : String(err)
    })
  }
}

/** Up to three of the per-machine files that did not reach the team version, or null. */
function missedDetail(missed: string[]): string | null {
  if (missed.length === 0) return null
  const named = missed.slice(0, 3).join(', ')
  return missed.length > 3 ? `${named}, and ${missed.length - 3} more` : named
}

function scrubDetail(err: unknown): string {
  return scrubCredentials(err instanceof Error ? err.message : String(err)).slice(0, 300)
}

/**
 * A free `<slug>-mine`, `<slug>-mine-2`, … beside `dir`. The folder name is
 * the copy's slug too, so it stays within the slug's 63 characters: a long
 * name is shortened before the suffix rather than the suffix dropped.
 */
function freeMineDir(dir: string): string {
  const parent = dirname(dir)
  const slug = basename(dir)
  const named = (suffix: string): string => join(parent, `${slug.slice(0, SLUG_MAX - suffix.length)}${suffix}`)
  for (let n = 1; n < 1000; n += 1) {
    const candidate = named(n === 1 ? '-mine' : `-mine-${n}`)
    if (!existsSync(candidate)) return candidate
  }
  return named(`-mine-${randomUUID().slice(0, 8)}`)
}

/**
 * Whether two manifest ids name one agent. Case-insensitive: core stores the
 * id lowercased, while the validator accepts an uppercase UUID in a folder.
 */
export function sameManifestId(a: string | null | undefined, b: string | null | undefined): boolean {
  return typeof a === 'string' && typeof b === 'string' && a !== '' && a.toLowerCase() === b.toLowerCase()
}

/** `SLUG_PATTERN`'s longest slug. */
const SLUG_MAX = 63

/**
 * The catalog entry an earlier Share with the team created for **this
 * folder** and never sent anything to, so a retry finishes it instead of
 * failing on core's 409. Matched on the folder's manifest id (core binds it at
 * create, so a teammate's entry never carries it), still without a version,
 * and maintained by this account. Anything else stays a refusal.
 */
async function unfinishedEntry(profile: string, manifestId: string): Promise<LibraryEntry | null> {
  let listing: CachedListing | null
  try {
    listing = await libraryService.refresh(profile)
  } catch {
    return null
  }
  const entry =
    listing?.agents.find(
      (agent) =>
        sameManifestId(agent.manifestId, manifestId) && agent.latest === null && agent.headSha === '' && agent.access === 'maintain'
    ) ?? null
  if (entry) logger.info('finishing a catalog entry an earlier share created and never sent to')
  return entry
}

/**
 * Whether a folder's `origin` is a team version of the active profile's
 * instance that the library — read fresh, not from the cache — no longer
 * lists: removed on the server, so Share with the team may start it over.
 */
async function removedFromLibrary(
  profile: string,
  host: string,
  originUrl: string,
  recordedServer: string | null
): Promise<boolean> {
  const remote = remoteOf(originUrl, recordedServer)
  if (remote.kind !== 'cinna' || remote.host !== host || remote.repoId === null) return false
  let listing: CachedListing | null
  try {
    listing = await libraryService.refresh(profile)
  } catch {
    return false
  }
  // A 404/403 listing stands in as empty; it is no answer about this entry.
  return listing !== null && listing.available && !listing.agents.some((agent) => agent.repoId === remote.repoId)
}

const ACCESS_VALUES: readonly LibraryAccess[] = ['use', 'edit', 'maintain']
const isAccess = (value: unknown): value is LibraryAccess =>
  typeof value === 'string' && (ACCESS_VALUES as readonly string[]).includes(value)
const text = (value: unknown): string => (typeof value === 'string' ? value : '')

/** A catalog item's grants, under the profile's API. */
function grantsPath(uuid: string): string {
  return `${catalogItemPath(uuid)}/grants`
}

/** Where Share with the team creates the catalog entry. */
const DESKTOP_AGENTS_PATH = '/api/v1/catalog/desktop-agents'

/** Core's principal: one account or everyone with a role. */
type CorePrincipal = { user_id: string } | { role: string }
export interface CoreGrant {
  principal: CorePrincipal
  access: LibraryAccess
}

/**
 * The renderer's grants → the body core's `PUT …/grants` takes. `everyone` is
 * no grant on core — it is the item's visibility, written apart — so it is
 * left out here.
 */
export function toCoreGrants(people: LibraryGrantInput[]): CoreGrant[] {
  return people.flatMap(({ principal, access }): CoreGrant[] =>
    principal.kind === 'user'
      ? [{ principal: { user_id: principal.userId }, access }]
      : principal.kind === 'role'
        ? [{ principal: { role: principal.role }, access }]
        : []
  )
}

/**
 * Core's grants (`GET …/grants`, a bare array of `{principal, access,
 * display_name}`) → what the People list shows. Read loosely — the rows also
 * under `grants`/`data`, the name on the row or on the principal — and a row
 * this cannot place is dropped rather than shown as someone else.
 */
export function fromCoreGrants(body: unknown): LibraryPerson[] {
  const container = body && typeof body === 'object' ? (body as Record<string, unknown>) : {}
  const rows = Array.isArray(body)
    ? body
    : Array.isArray(container.grants)
      ? container.grants
      : Array.isArray(container.data)
        ? container.data
        : []
  return rows.flatMap((raw): LibraryPerson[] => {
    if (!raw || typeof raw !== 'object') return []
    const row = raw as Record<string, unknown>
    const p = row.principal
    const obj = p && typeof p === 'object' ? (p as Record<string, unknown>) : {}
    let principal: LibraryPrincipal | null = null
    if (text(obj.user_id) !== '') principal = { kind: 'user', userId: text(obj.user_id) }
    else if (text(obj.role) !== '') principal = { kind: 'role', role: text(obj.role) }
    if (!principal) return []
    const displayName =
      text(row.display_name) || text(obj.display_name) || text(row.full_name) || text(obj.full_name) ||
      text(row.email) || text(obj.email)
    return [{ principal, access: isAccess(row.access) ? row.access : 'use', displayName }]
  })
}

/**
 * The People list with "Everyone on this server" when the item is public and
 * listed: core's `visibility: 'public'` is everyone's `use`, shown as one more
 * row — but only while the catalog lists it, so an unlisted one shows none.
 */
export function withEveryone(
  people: LibraryPerson[],
  visibility: CatalogVisibility,
  isListed: boolean
): LibraryPerson[] {
  return visibility === 'public' && isListed
    ? [...people, { principal: { kind: 'everyone' }, access: 'use', displayName: '' }]
    : people
}

/**
 * The visibility a People list asks for: `public` with Everyone in it, else
 * `users` — the only visibility under which a person's `use` grant counts.
 */
export function visibilityFor(people: LibraryGrantInput[]): CatalogVisibility {
  return people.some((person) => person.principal.kind === 'everyone') ? 'public' : 'users'
}

/** The renderer's desired list, checked field by field; null when any row is not a grant. */
function parseGrantInputs(raw: unknown): LibraryGrantInput[] | null {
  if (!Array.isArray(raw)) return null
  const out: LibraryGrantInput[] = []
  for (const item of raw) {
    if (!item || typeof item !== 'object') return null
    const row = item as Record<string, unknown>
    const p = row.principal && typeof row.principal === 'object' ? (row.principal as Record<string, unknown>) : null
    if (!p || !isAccess(row.access)) return null
    if (p.kind === 'user' && text(p.userId) !== '') out.push({ principal: { kind: 'user', userId: text(p.userId) }, access: row.access })
    else if (p.kind === 'role' && text(p.role) !== '') out.push({ principal: { kind: 'role', role: text(p.role) }, access: row.access })
    else if (p.kind === 'everyone') out.push({ principal: { kind: 'everyone' }, access: row.access })
    else return null
  }
  return out
}

/** The people Share with the team was given, keeping only well-formed ones. */
function parseSharePeople(raw: unknown): ShareWithTeamPerson[] {
  if (!Array.isArray(raw)) return []
  const seen = new Set<string>()
  return raw.flatMap((item): ShareWithTeamPerson[] => {
    if (!item || typeof item !== 'object') return []
    const row = item as Record<string, unknown>
    const userId = text(row.userId)
    if (userId === '' || seen.has(userId)) return []
    seen.add(userId)
    return [{ userId, access: isAccess(row.access) ? row.access : 'use' }]
  })
}

/**
 * A new entry's grants: whoever maintains it (the creator, on a fresh entry)
 * as `maintain`, then each chosen person who is not already one of them.
 */
function initialGrants(entry: LibraryEntry, people: ShareWithTeamPerson[]): CoreGrant[] {
  const maintainers = new Set(entry.maintainers.map((m) => m.userId))
  return toCoreGrants([
    ...entry.maintainers.map((m) => ({ principal: { kind: 'user' as const, userId: m.userId }, access: 'maintain' as const })),
    ...people
      .filter((person) => !maintainers.has(person.userId))
      .map((person) => ({ principal: { kind: 'user' as const, userId: person.userId }, access: person.access }))
  ])
}

/**
 * A write to the catalog API, answered as a refusal or the body it returned.
 *
 * A 2xx with no JSON body (`invalid_response`) is a write that happened. A
 * `403` is `no_access` — `cinnaFetch` calls it `reauth_required`, but on a
 * grant or a delete it is a role, not a dead session. `goneIsDone` makes a
 * `404` a success (deleting what is already gone). Any other refusal carries
 * the server's own sentence. A real re-auth still throws, for the prompt.
 */
async function libraryWrite(
  profile: string,
  path: string,
  method: 'PUT' | 'PATCH' | 'DELETE',
  body?: unknown,
  goneIsDone = false
): Promise<{ refusal: ShareRefusal; detail: string | null } | { body: unknown }> {
  try {
    return { body: await cinnaFetch<unknown>(profile, path, body === undefined ? { method } : { method, body }) }
  } catch (err) {
    if (!(err instanceof CinnaApiError)) throw err
    if (err.code === 'invalid_response') return { body: null }
    if (err.status === 404 && goneIsDone) return { body: null }
    if (err.status === 403) return { refusal: 'no_access', detail: null }
    if (err.code === 'reauth_required') throw err
    return { refusal: 'failed', detail: err.detail || err.message }
  }
}

/**
 * The active profile's own account id on its instance, when it is one of
 * `people` — the stored token's `sub`, read without the network. Null when it
 * cannot be read or is not in the list, so a wrong guess never marks anyone
 * as "You".
 */
function selfIn(profile: string, people: LibraryPerson[]): string | null {
  let sub: string
  try {
    sub = getStoredCinnaSubject(profile)
  } catch {
    return null
  }
  return people.some((p) => p.principal.kind === 'user' && p.principal.userId === sub) ? sub : null
}

/**
 * The catalog entry behind a shared agent, when the active profile can speak
 * for it: a Cinna remote on the active profile's own instance. `entry` is the
 * listed team agent with that repository — from the cached listing, or a
 * fresh one when `fresh` or when the cache does not have it — and null when
 * the listing (`listing`) does not carry it.
 */
async function libraryTarget(
  userId: string,
  agentId: string,
  fresh = false
): Promise<{
  shared: SharedAgent
  profile: string
  repoId: string
  entry: LibraryEntry | null
  listing: CachedListing | null
} | null> {
  const shared = await locateShared(userId, agentId)
  if (!shared || shared.remote.kind !== 'cinna' || shared.remote.repoId === null) return null
  const auth = authFor(shared)
  if (auth === 'other_account' || auth.kind !== 'cinna') return null
  const profile = getProfileScopeUserId()
  const repoId = shared.remote.repoId
  let listing = fresh ? null : listingFor(shared.remote.host)
  let entry = listing?.agents.find((agent) => agent.repoId === repoId) ?? null
  if (!entry) {
    listing = await libraryService.refresh(profile)
    entry = listing?.agents.find((agent) => agent.repoId === repoId) ?? null
  }
  return { shared, profile, repoId, entry, listing }
}

/**
 * Tell core this computer now holds the shared agent at `headSha`, in the
 * background: never awaited, never failing the verb it follows.
 */
function reportInstall(shared: SharedAgent, headSha: string | null): void {
  const entry = listedEntry(shared)
  if (!entry) return
  void catalogLocalInstalls.reportInstalled(getProfileScopeUserId(), entry, headSha)
}

/** The cached listing's entry for a Cinna team version on the active profile's instance. */
function listedEntry(shared: SharedAgent): LibraryEntry | null {
  if (shared.remote.kind !== 'cinna') return null
  return listingFor(shared.remote.host)?.agents.find((agent) => agent.repoId === shared.remote.repoId) ?? null
}

/**
 * Share with the team, once the folder has cleared its preflight: create the
 * catalog entry (`POST /api/v1/catalog/desktop-agents`), then record the
 * folder in place and send it there.
 */
async function createAndSend(
  userId: string,
  agentId: string,
  kit: NonNullable<ReturnType<typeof locateKit>>,
  profile: string,
  host: string,
  input: { slug: string; name: string; description: string; manifestId: string; people: ShareWithTeamPerson[] },
  /** The folder's old `origin` is a team version the library no longer lists: dropped once the new entry exists. */
  replaceOrigin: boolean
): Promise<AgentShareResult> {
  let entry: LibraryEntry | null
  let adopted = false
  try {
    const created = await cinnaFetch<Record<string, unknown>>(profile, DESKTOP_AGENTS_PATH, {
      method: 'POST',
      body: {
        slug: input.slug,
        display_name: input.name,
        description: input.description,
        manifest_id: input.manifestId,
        // `users`: a person's `use` grant counts only there. With nobody
        // chosen it reaches the maintainers alone, as `private` would, and a
        // person added later in People counts at once.
        visibility: 'users',
        // Applied with the create, all or nothing; core adds the creator as maintainer.
        grants: input.people.map((person) => ({ principal: { user_id: person.userId }, access: person.access }))
      }
    })
    entry = toLibraryEntry(created ?? {})
  } catch (err) {
    if (err instanceof CinnaApiError && err.code !== 'reauth_required') {
      // Core's 409s ("An agent called … is already in the catalog.", "This
      // agent is already in the catalog. …") come back as its own sentence,
      // unless the entry is this folder's own unfinished one.
      entry = err.status === 409 ? await unfinishedEntry(profile, input.manifestId) : null
      if (!entry) return refused('failed', err.detail ?? err.message)
      adopted = true
    } else {
      throw err
    }
  }
  if (!entry) return refused('failed', 'The team library did not answer with a place to send the agent.')
  const gitOrigin = libraryTrust.learn(host, entry.cloneUrl)
  if (gitOrigin === null) return refused('failed', UNSAFE_ADDRESS)
  /*
   * Who may get it is settled before anything is sent. A fresh entry got
   * this share's people with the create. An adopted one still has whatever
   * the earlier attempt chose, so its grants are replaced with the
   * maintainers plus this attempt's people first; if that fails, nothing is
   * sent and a retry adopts it again.
   */
  if (adopted) {
    if (entry.maintainers.length === 0) {
      return refused('failed', 'The agent wasn’t sent: the team library did not say who maintains it.')
    }
    const grantsWrite = await libraryWrite(profile, grantsPath(entry.uuid), 'PUT', initialGrants(entry, input.people))
    if ('refusal' in grantsWrite) {
      const why = grantsWrite.detail ? ` (${grantsWrite.detail})` : ''
      return refused('failed', `The agent wasn’t sent: who can get it couldn’t be limited yet${why}.`)
    }
  }
  if (replaceOrigin) {
    // Only now that the new entry exists: a refused or failed create leaves
    // the folder linked to its old team version, as it was. The history here
    // stays; only the link to the deleted entry goes.
    if (!(await gitService.removeOrigin(kit.dir))) return refused('failed', 'The old team link could not be removed.')
    writeLocalLink(kit.dir, null)
  }

  const auth: RemoteAuth = { kind: 'cinna', origin: gitOrigin, token: () => getCinnaAccessToken(profile) }
  const action = await gitService.initWithRemote(kit.dir, entry.cloneUrl, auth, {
    workshopRoot: kit.root.path,
    identity: commitIdentity({ kind: 'cinna', host })
  })
  // Recorded whether or not the first send went through: once `origin` is
  // set the folder is this instance's, and a retry is a Share changes.
  if (existsSync(join(kit.dir, '.git'))) {
    await recordServer(kit.dir, host)
    writeLocalLink(kit.dir, linkFor(entry))
  }
  await refreshListing()
  settle(userId, kit.root.id)
  return result(action, await sharingService.status(userId, agentId, false))
}

export const sharingService = {
  /** Every shared agent on this machine, without reaching the network. */
  async statuses(userId: string): Promise<AgentShareStatus[]> {
    const out: AgentShareStatus[] = []
    for (const agent of repoCandidates(userId)) {
      const shared = await locateShared(userId, agent.id).catch(() => null)
      if (shared) out.push(await statusOf(agent.id, shared, false))
    }
    return out
  },

  /** One agent's status; null when it is not shared. */
  async status(userId: string, agentId: string, fetch: boolean): Promise<AgentShareStatus | null> {
    const shared = await locateShared(userId, agentId)
    return shared ? statusOf(agentId, shared, fetch) : null
  },

  /** An AI summary of what would be shared. '' whenever one cannot be written. */
  async draftMessage(userId: string, agentId: string): Promise<string> {
    try {
      const shared = await locateShared(userId, agentId)
      if (!shared) return ''
      const diff = await gitService.diffForSummary(shared.dir)
      if (diff.trim() === '') return ''
      const output = await aiFunctions.runSingleShot({
        backend: aiFunctions.resolveBackend(userId),
        warmOnly: false,
        label: 'share-summary',
        systemPrompt: SHARE_SUMMARY_SYSTEM_PROMPT,
        userText: diff,
        maxOutputChars: MAX_SUMMARY_CHARS
      })
      return output.replace(/^["'`]+|["'`]+$/g, '').trim()
    } catch (err) {
      logger.warn('share summary could not be written', {
        error: err instanceof Error ? err.message : String(err)
      })
      return ''
    }
  },

  /**
   * Record everything unshared and send it, under the turn lock like Update:
   * it writes the folder's history (`add -A`, a commit, and on a teammate's
   * push first a rebase that may be aborted), which must not run under a turn
   * editing the same files.
   */
  async shareChanges(userId: string, agentId: string, message: string): Promise<AgentShareResult> {
    const shared = await locateShared(userId, agentId)
    if (!shared) return refused('not_shared')
    const auth = authFor(shared)
    if (auth === 'other_account') return result({ done: false, refusal: 'other_account' }, await statusOf(agentId, shared, false))
    const lock = lockOrRefuse(agentId)
    if (!lock) return result({ done: false, refusal: 'turn_in_progress' }, await statusOf(agentId, shared, false))
    // An interrupted update's backup first: this machine's local-only files.
    gitService.restoreLeftoverLocalOnlyFiles(shared.dir)
    let action: ShareActionResult
    try {
      action = await gitService.shareChanges(
        shared.dir,
        typeof message === 'string' ? message : '',
        auth,
        commitIdentity(shared.remote),
        shared.root.path
      )
    } finally {
      lock.release()
    }
    if (action.done) {
      await refreshListing()
      publishEvent(SHARING_CHANGED_CHANNEL)
      const status = await statusOf(agentId, shared, false)
      // This computer now holds the version it just sent.
      reportInstall(shared, status.headSha)
      return result(action, status)
    }
    return result(action, await statusOf(agentId, shared, false))
  },

  /** Bring in the team's changes when they apply cleanly, under the turn lock; rescan. */
  async update(userId: string, agentId: string): Promise<AgentShareResult> {
    const shared = await locateShared(userId, agentId)
    if (!shared) return refused('not_shared')
    const auth = authFor(shared)
    if (auth === 'other_account') return result({ done: false, refusal: 'other_account' }, await statusOf(agentId, shared, false))
    const lock = lockOrRefuse(agentId)
    if (!lock) return result({ done: false, refusal: 'turn_in_progress' }, await statusOf(agentId, shared, false))
    const missingBefore = missingSlots(userId, agentId)
    let action: ShareActionResult
    try {
      action = await gitService.pullRebaseClean(shared.dir, auth, commitIdentity(shared.remote), shared.root.path)
    } finally {
      lock.release()
    }
    if (action.done) {
      await refreshListing()
      settle(userId, shared.root.id)
      const setup = await credentialSetup(userId, agentId, missingBefore)
      const status = await statusOf(agentId, shared, false)
      reportInstall(shared, status.headSha)
      return { ...result(action, status), ...setup }
    }
    return result(action, await statusOf(agentId, shared, false))
  },

  /**
   * After `diverged_conflict`: this folder becomes the team's version and
   * what was here is kept as `<slug>-mine` — no `origin`, a fresh manifest id
   * (the scanner refuses two folders with one id). The original id stays
   * with the team version, so chats bound to it follow the team. Answers the
   * copy's id.
   */
  async useTeamVersion(userId: string, agentId: string): Promise<AgentShareResult> {
    const shared = await locateShared(userId, agentId)
    if (!shared) return refused('not_shared')
    const auth = authFor(shared)
    if (auth === 'other_account') return result({ done: false, refusal: 'other_account' }, await statusOf(agentId, shared, false))
    const lock = lockOrRefuse(agentId)
    if (!lock) return result({ done: false, refusal: 'turn_in_progress' }, await statusOf(agentId, shared, false))
    // An interrupted update's backup first: this machine's local-only files.
    gitService.restoreLeftoverLocalOnlyFiles(shared.dir)
    // Under the lock, before anything moves: the folder this id names now.
    const missingBefore = missingSlots(userId, agentId)
    let copyId: string
    let missed: string[] = []
    try {
      // Mint before anything moves: an expired session is the likeliest
      // failure, and it surfaces as the re-auth prompt with the folder where
      // it was. The clone mints again for its own child.
      if (auth.kind === 'cinna') await auth.token()
      const mineDir = freeMineDir(shared.dir)
      try {
        renameSync(shared.dir, mineDir)
      } catch (err) {
        return result(
          { done: false, refusal: 'failed', detail: `The folder could not be renamed: ${String(err)}`.slice(0, 300) },
          await statusOf(agentId, shared, false)
        )
      }
      let landed = false
      try {
        const cloned = await gitService.clone(shared.originUrl, shared.dir, auth, shared.root.path)
        if (!cloned.done) {
          // `clone` leaves nothing at the target when it does not finish.
          putBack(mineDir, shared.dir, false)
          settle(userId, shared.root.id)
          return result(cloned, await statusOf(agentId, shared, false))
        }
        landed = true
        missed = await carryMachineFiles(mineDir, shared.dir)
        // A never-travelling file the kept folder still tracked (shared before
        // it joined the list) is not ignored there, so the carry skipped it:
        // this machine's copy, else the template's. Never throws.
        // A version an older client or plain git shared may carry one: this
        // machine's still wins.
        if (auth.kind === 'cinna') {
          await gitService.settleLocalOnlyFiles(
            shared.dir,
            gitService.keepLocalOnlyFiles(mineDir, shared.root.path),
            shared.root.path
          )
        }
        // The copy's fresh id is written while it still has `origin`, so a
        // failure up to here is undone whole by `putBack`; `origin` goes only
        // once the two folders no longer share an id.
        const path = manifestPath(mineDir)
        copyId = randomUUID()
        const manifest = readManifest(path)
        // `slug` follows the folder: the validator requires the two to match,
        // and keeping the team's would leave two agents under one slug.
        writeManifest(path, { ...manifest, id: copyId, slug: basename(mineDir), name: `${manifest.name} (my copy)` })
      } catch (err) {
        /*
         * Something threw between the rename and the copy's new id: a reauth
         * from the clone's own mint, a failed carry, an unreadable or
         * unwritable manifest. The safe end state is the one before the
         * click — the team clone (if it landed) removed, this folder back at
         * its path with its id and `origin`. Never both folders with one id:
         * the scanner would refuse one of them, and which is a coin toss.
         */
        putBack(mineDir, shared.dir, landed)
        settle(userId, shared.root.id)
        if (err instanceof CinnaReauthRequired) throw err
        logger.warn('use the team version failed; the folder was put back', {
          error: err instanceof Error ? err.message : String(err)
        })
        return result(
          { done: false, refusal: 'failed', detail: scrubDetail(err) },
          await statusOf(agentId, shared, false).catch(() => null)
        )
      }
      // The copy is nobody's team agent: no link in its own state either.
      writeLocalLink(mineDir, null)
      if (!(await gitService.removeOrigin(mineDir))) {
        logger.warn('the kept copy still has the team version as origin')
      }
      await gitService.excludeFromEnclosingRepo(mineDir)
    } finally {
      lock.release()
    }
    await refreshListing()
    settle(userId, shared.root.id)
    const setup = await credentialSetup(userId, agentId, missingBefore)
    const status = await statusOf(agentId, shared, false)
    reportInstall(shared, status.headSha)
    return {
      ...result({ done: true, refusal: null, detail: missedDetail(missed) }, status, folderAgentId(copyId)),
      ...setup
    }
  },

  /** Name and description from the manifest, for the Share with the team dialog. */
  shareWithTeamDraft(userId: string, agentId: string): ShareWithTeamDraft {
    const agent = localAgentService.get(userId, agentId)
    return {
      name: agent.manifest?.name || agent.name,
      description: agent.manifest?.description || agent.description
    }
  },

  /**
   * Create the agent in the active profile's catalog and send this folder
   * there, in place: `POST /api/v1/catalog/desktop-agents`, then `initWithRemote`.
   */
  async shareWithTeam(
    userId: string,
    agentId: string,
    input: { name?: unknown; people?: unknown }
  ): Promise<AgentShareResult> {
    const profile = getProfileScopeUserId()
    const host = libraryService.hostOf(profile)
    if (host === null) return refused('failed', 'Sharing with a team needs a Cinna account.')
    const kit = locateKit(userId, agentId)
    if (!kit) return refused('failed', 'Only an agent in your Local agents folder can be shared.')
    const existing = await gitService.readShareRemote(kit.dir)
    if (existing.refusal === 'git_missing') return refused('git_missing')
    if (existing.ownRepo && existing.originUrl !== null) {
      if (!(await removedFromLibrary(profile, host, existing.originUrl, existing.cinnaServer))) {
        return refused('remote_exists')
      }
    }

    const draft = sharingService.shareWithTeamDraft(userId, agentId)
    const name = typeof input?.name === 'string' && input.name.trim() !== '' ? input.name.trim() : draft.name
    // Not asked for in the dialog: the manifest's, sent as it is.
    const description = draft.description
    const people = parseSharePeople(input?.people)
    const slug = basename(kit.dir)
    // Core binds the catalog entry to the manifest id for good.
    let manifestId: string | undefined
    try {
      manifestId = readManifest(manifestPath(kit.dir)).id
    } catch {
      manifestId = undefined
    }
    if (!manifestId) return refused('failed', 'This agent’s cinna-agent.json has no id, so it can’t be shared.')

    // Under the turn lock, like every other action that records the folder:
    // the first share is an `add -A` of whatever is there.
    const lock = lockOrRefuse(agentId)
    if (!lock) return refused('turn_in_progress')
    try {
      // Refused before the library entry exists, so a folder that cannot be
      // sent does not leave an empty entry behind on the server. Read-only:
      // the target is a Cinna library, so tracked files under the folders
      // that never travel are not a refusal — the send leaves them out.
      const preflight = await gitService.preflightShare(kit.dir, kit.root.path, true)
      if (preflight) return result(preflight, null)
      // A folder whose team version is gone from the library starts over; its
      // old link is dropped only once the new entry exists.
      const replaceOrigin = existing.ownRepo && existing.originUrl !== null
      return await createAndSend(
        userId,
        agentId,
        kit,
        profile,
        host,
        { slug, name, description, manifestId, people },
        replaceOrigin
      )
    } finally {
      lock.release()
    }
  },

  /**
   * Who has access to a shared agent: `GET …/grants`, plus "Everyone on this
   * server" when the entry is public. Null when there is no catalog entry the
   * active profile can speak for (not shared, an external team version,
   * another account's, or an entry the server no longer has). A `403` — the
   * caller is not a maintainer — is `visible: false`, never the re-auth
   * prompt: the session is fine, the list is just not theirs to see.
   */
  async people(userId: string, agentId: string): Promise<AgentPeopleDto | null> {
    const target = await libraryTarget(userId, agentId)
    if (!target?.entry) return null
    try {
      const body = await cinnaFetch<unknown>(target.profile, grantsPath(target.entry.uuid))
      const list = withEveryone(fromCoreGrants(body), target.entry.visibility, target.entry.isListed)
      return { visible: true, people: list, selfUserId: selfIn(target.profile, list) }
    } catch (err) {
      if (err instanceof CinnaApiError && err.status === 403) return { visible: false, people: [], selfUserId: null }
      if (err instanceof CinnaApiError && err.status === 404) return null
      throw err
    }
  },

  /**
   * Replace who has access with `people`, the whole desired list: the grants
   * with `PUT …/grants`, then — only when Everyone was added or removed — the
   * visibility with `PATCH /catalog/items/{uuid}` (`public` with Everyone,
   * else `users`, the only visibility under which a person's `use` counts).
   *
   * Grants go first: they are what the server checks (a maintainer left, a
   * known role, an active person), so a refusal there changes nothing at all;
   * and when Everyone goes, the people named keep their access throughout.
   * Core sets no order between the two. The server's refusal of either comes
   * back as its own sentence in `detail`, with the list as it now stands.
   */
  async setPeople(userId: string, agentId: string, people: unknown): Promise<SetPeopleResult> {
    const target = await libraryTarget(userId, agentId, true)
    if (!target) return { ...refused('not_shared'), people: null }
    const { entry, profile } = target
    if (!entry) return { ...refused('not_in_library'), people: null }
    const grants = parseGrantInputs(people)
    if (grants === null) return { ...refused('failed', 'That list of people could not be read.'), people: null }
    const write = await libraryWrite(profile, grantsPath(entry.uuid), 'PUT', toCoreGrants(grants))
    if ('refusal' in write) return { ...refused(write.refusal, write.detail), people: null }
    const wanted = visibilityFor(grants)
    let visibility = entry.visibility
    let visibilityRefusal: { refusal: ShareRefusal; detail: string | null } | null = null
    // An unlisted public item shows no Everyone row (it reaches no one), so a
    // list without one is not a request to make it non-public: left as is.
    const keepsHiddenPublic = !entry.isListed && entry.visibility === 'public' && wanted === 'users'
    if (wanted !== entry.visibility && !keepsHiddenPublic) {
      const patch = await libraryWrite(profile, catalogItemPath(entry.uuid), 'PATCH', { visibility: wanted })
      if ('refusal' in patch) visibilityRefusal = patch
      else visibility = wanted
    }
    // The listing's maintainers, visibility and the caller's own access may have moved.
    await refreshListing()
    // The list as the server now has it: what the PUT answered, or a fresh
    // read when it answered nothing usable — never the list sent, which
    // lacks the names.
    const answered = fromCoreGrants(write.body)
    const shown = withEveryone(answered, visibility, entry.isListed)
    const now: AgentPeopleDto | null =
      answered.length > 0
        ? { visible: true, people: shown, selfUserId: selfIn(profile, shown) }
        : await sharingService.people(userId, agentId).catch(() => null)
    publishEvent(SHARING_CHANGED_CHANNEL)
    if (visibilityRefusal) return { ...refused(visibilityRefusal.refusal, visibilityRefusal.detail), people: now }
    return { ...result({ done: true, refusal: null }, null, agentId), people: now }
  },

  /**
   * People on the active profile's instance, by name or email, for the people
   * picker. Fewer than two characters finds no one; an instance without the
   * route (or one that keeps it from this role) finds no one too.
   */
  async searchPeople(query: unknown): Promise<PersonSearchResult[]> {
    const q = text(query).trim()
    if (q.length < 2) return []
    const profile = getProfileScopeUserId()
    if (libraryService.hostOf(profile) === null) return []
    let body: unknown
    try {
      body = await cinnaFetch<unknown>(profile, `/api/v1/users/search?q=${encodeURIComponent(q)}&limit=10`)
    } catch (err) {
      if (err instanceof CinnaApiError && (err.status === 403 || err.status === 404)) return []
      throw err
    }
    const rows = body && typeof body === 'object' ? (body as Record<string, unknown>).data : null
    if (!Array.isArray(rows)) return []
    return rows.flatMap((raw): PersonSearchResult[] => {
      if (!raw || typeof raw !== 'object') return []
      const row = raw as Record<string, unknown>
      const id = text(row.id)
      if (id === '') return []
      const email = text(row.email)
      return [{ userId: id, email, name: text(row.full_name) || email }]
    })
  },

  /** This folder's versions, newest first — the Sharing tab's History. Empty when it is not shared. */
  async history(userId: string, agentId: string): Promise<AgentVersionDto[]> {
    const shared = await locateShared(userId, agentId)
    if (!shared) return []
    return gitService.readHistory(shared.dir)
  },

  /**
   * Remove sharing: this folder stops being a team agent and becomes an
   * ordinary local one, shareable again later. `origin`, the `shared_remote`
   * link and `cinna.server` go; the folder, its files and its own history
   * stay. Unshared changes do not block it — nothing here is lost.
   *
   * `deleteFromLibrary` first deletes the catalog entry (`DELETE
   * /catalog/items/{uuid}`, a maintainer of a Cinna team version on the
   * active profile's instance). If the server refuses — "1 person uses this.
   * It can be removed once nobody does." — nothing local changes and its
   * sentence comes back in `detail`. An entry already gone counts as deleted.
   * When the entry stays, core is told in the background that this computer
   * no longer holds it (best effort, never blocking). Under the turn lock, like every verb that writes the folder's `.git`.
   */
  async unshare(userId: string, agentId: string, deleteFromLibrary: boolean): Promise<AgentShareResult> {
    const shared = await locateShared(userId, agentId)
    if (!shared) return refused('not_shared')
    const lock = lockOrRefuse(agentId)
    if (!lock) return result({ done: false, refusal: 'turn_in_progress' }, await statusOf(agentId, shared, false))
    // An interrupted update's backup first: this machine's local-only files.
    gitService.restoreLeftoverLocalOnlyFiles(shared.dir)
    // The entry this folder's install row is under, read before anything moves.
    const kept = listedEntry(shared)
    let deleted = false
    try {
      if (deleteFromLibrary) {
        const target = await libraryTarget(userId, agentId, true)
        if (!target) return refused('other_account')
        if (target.entry) {
          const refusal = await libraryWrite(target.profile, catalogItemPath(target.entry.uuid), 'DELETE', undefined, true)
          if ('refusal' in refusal) return refused(refusal.refusal, refusal.detail)
        } else if (!target.listing?.available) {
          // A listing the instance refused says nothing about the entry: not
          // read as already deleted.
          return refused('fetch_failed')
        }
        deleted = true
      }
      if (!(await gitService.removeOrigin(shared.dir))) {
        return refused('failed', 'The link to the team could not be removed.')
      }
      writeLocalLink(shared.dir, null)
      if (!(await gitService.unsetCinnaServer(shared.dir))) {
        logger.warn('the folder still names the Cinna instance it was shared through')
      }
    } finally {
      lock.release()
    }
    // The entry stays in the catalog, and this computer no longer holds it:
    // said in the background, or its install row would keep blocking a
    // maintainer's delete.
    if (!deleted && kept) void catalogLocalInstalls.reportRemoved(getProfileScopeUserId(), kept)
    await refreshListing()
    settle(userId, shared.root.id)
    return result({ done: true, refusal: null }, null, agentId)
  },

  /**
   * The active Cinna profile's team library, with this machine's copies
   * matched in. Null for a profile that is not a Cinna one.
   */
  async library(userId: string, refresh: boolean): Promise<LibraryListingDto | null> {
    const profile = getProfileScopeUserId()
    if (libraryService.hostOf(profile) === null) return null
    const listing = (!refresh && libraryService.cached(profile)) || (await libraryService.refresh(profile))
    if (!listing) return null
    const local = await localCopies(userId, listing)
    const agents: LibraryAgentDto[] = []
    for (const entry of listing.agents) {
      const copy = local.byRepo.get(entry.repoId) ?? (entry.manifestId ? local.byManifest.get(entry.manifestId.toLowerCase()) : undefined) ?? null
      let updateAvailable = false
      if (copy?.dir && entry.headSha !== '') {
        updateAvailable = await gitService.isBehindLibrary(copy.dir, entry.headSha)
      }
      agents.push({
        uuid: entry.uuid,
        bundleId: entry.bundleId,
        repoId: entry.repoId,
        slug: entry.slug,
        name: entry.name,
        description: entry.description,
        cloneUrl: entry.cloneUrl,
        headSha: entry.headSha,
        access: entry.access,
        visibility: entry.visibility,
        isListed: entry.isListed,
        maintainers: entry.maintainers,
        engine: entry.engine,
        manifestId: entry.manifestId,
        latest: entry.latest,
        localAgentId: copy?.agentId ?? null,
        updateAvailable
      })
    }
    return { host: listing.host, agents, fetchedAt: listing.fetchedAt.toISOString() }
  },

  /** Get a library agent into the home's `Local/<slug>/`. Answers the new row's id. */
  async get(userId: string, repoId: string): Promise<AgentShareResult> {
    const profile = getProfileScopeUserId()
    const host = libraryService.hostOf(profile)
    if (host === null) return refused('failed', 'The team library needs a Cinna account.')
    let listing = libraryService.cached(profile)
    let entry = listing?.agents.find((agent) => agent.repoId === repoId) ?? null
    if (!entry) {
      listing = await libraryService.refresh(profile)
      entry = listing?.agents.find((agent) => agent.repoId === repoId) ?? null
    }
    if (!entry) return refused('not_in_library')
    if (!SLUG_PATTERN.test(entry.slug)) return refused('failed', 'The library names this agent with an unusable folder name.')
    const gitOrigin = libraryTrust.learn(host, entry.cloneUrl)
    if (gitOrigin === null) return refused('failed', UNSAFE_ADDRESS)

    const root = agentsHomeService.requireRoot(userId)
    const target = join(root.path, AGENTS_SUBDIR, entry.slug)
    const agents = localAgentService.list(userId).agents
    if (existsSync(target)) {
      const there = agents.find((agent) => realOrSelf(agent.path) === realOrSelf(target))
      return refused('exists', there?.name ?? entry.slug)
    }
    if (entry.manifestId) {
      const same = agents.find((agent) => sameManifestId(agent.manifestId, entry.manifestId))
      if (same) return refused('exists', same.name)
    }

    const auth: RemoteAuth = { kind: 'cinna', origin: gitOrigin, token: () => getCinnaAccessToken(profile) }
    const cloned = await gitService.clone(entry.cloneUrl, target, auth, root.path)
    if (!cloned.done) return result(cloned, null)
    await recordServer(target, host)
    try {
      gitService.restoreLocalOnlyFolders(target, root.path)
      // A team version an older client or plain git shared may carry a
      // never-travelling file: the template's, never the team's.
      await gitService.settleLocalOnlyFiles(target, new Map(), root.path)
      writeLocalLink(target, linkFor(entry))
    } catch (err) {
      logger.warn('could not give a fetched agent its local credentials folder', { error: String(err) })
    }

    let manifestId: string | undefined
    try {
      manifestId = readManifest(join(target, MANIFEST_FILE)).id
    } catch {
      manifestId = undefined
    }
    if (!manifestId) {
      rmSync(target, { recursive: true, force: true })
      return refused('not_an_agent')
    }
    // The listing's manifest id can be missing or stale; what arrived decides.
    const clash = agents.find((agent) => sameManifestId(agent.manifestId, manifestId))
    if (clash) {
      rmSync(target, { recursive: true, force: true })
      return refused('exists', clash.name)
    }
    settle(userId, root.id)
    const agentId = folderAgentId(manifestId)
    const setup = await credentialSetup(userId, agentId)
    const status = await sharingService.status(userId, agentId, false).catch(() => null)
    void catalogLocalInstalls.reportInstalled(profile, entry, status?.headSha ?? null)
    return { ...result({ done: true, refusal: null }, status, agentId), ...setup }
  },

  /**
   * "Update available" for desktop agents: every shared Cinna agent this
   * machine has whose team version, per the cached listing, is past its
   * folder. No network.
   *
   * The Inbox reads this every few seconds while focused, and a fresh answer
   * costs four git children per shared agent; so each agent's answer is kept
   * until the listing is fetched again or the folder's `.git` state moves
   * ({@link gitStateKey}, read from files), and a steady state spawns none.
   */
  async teamChanges(userId: string): Promise<UpdateAvailableInboxItem[]> {
    const listing = libraryService.cached(getProfileScopeUserId())
    if (!listing || listing.agents.length === 0) return []
    const byRepo = new Map(listing.agents.map((agent) => [agent.repoId, agent]))
    const items: UpdateAvailableInboxItem[] = []
    const seen = new Set<string>()
    // The listing's own content as well as its time: two fetches can share a millisecond.
    const listed = listing.agents
      .map((a) => `${a.repoId}:${a.headSha}:${a.latest?.number ?? 0}:${a.latest?.publishedAt ?? ''}:${a.latest?.publishedBy ?? ''}`)
      .join(',')
    for (const agent of repoCandidates(userId)) {
      seen.add(agent.id)
      const state = gitStateKey(agent.path)
      const key =
        state === null
          ? null
          : [listing.host, listing.fetchedAt.getTime(), listed, agent.path, agent.name, state].join('\n')
      const memo = teamChangeMemo.get(agent.id)
      let item: UpdateAvailableInboxItem | null
      if (key !== null && memo?.key === key) item = memo.item
      else {
        item = await teamChangeOf(agent, listing.host, byRepo)
        if (key !== null) teamChangeMemo.set(agent.id, { key, item })
        else teamChangeMemo.delete(agent.id)
      }
      if (item) items.push(item)
    }
    for (const id of teamChangeMemo.keys()) if (!seen.has(id)) teamChangeMemo.delete(id)
    return items
  }
}

/** `teamChanges`' per-agent answers, each with the key it was derived under. */
const teamChangeMemo = new Map<string, { key: string; item: UpdateAvailableInboxItem | null }>()

/** One agent's "Update available" item, from git. */
async function teamChangeOf(
  agent: LocalAgentDto,
  host: string,
  byRepo: Map<string, LibraryEntry>
): Promise<UpdateAvailableInboxItem | null> {
  const remote = await gitService.readShareRemote(agent.path)
  if (!remote.ownRepo || remote.originUrl === null) return null
  const parsed = remoteOf(remote.originUrl, remote.cinnaServer)
  if (parsed.kind !== 'cinna' || parsed.repoId === null || parsed.host !== host) return null
  const entry = byRepo.get(parsed.repoId)
  if (!entry || entry.headSha === '') return null
  if (!(await gitService.isBehindLibrary(agent.path, entry.headSha))) return null
  const changedAt = entry.latest?.publishedAt ? new Date(entry.latest.publishedAt) : null
  return {
    kind: 'update_available',
    target: 'desktop_agent',
    agentId: agent.id,
    agentName: agent.name,
    repoId: entry.repoId,
    version: entry.latest?.number ?? null,
    versionLabel: entry.latest?.label ?? null,
    changedBy: entry.latest?.publishedBy ?? null,
    changedAt: changedAt && !Number.isNaN(changedAt.getTime()) ? changedAt : null
  }
}

/** `mtime:size` of a file, or `-` when it is not there. */
function fileStamp(path: string): string {
  try {
    const st = statSync(path)
    return `${st.mtimeMs}:${st.size}`
  } catch {
    return '-'
  }
}

/**
 * What a folder's share answer depends on, read from `.git` without running
 * git: `HEAD`, the sha of the branch it names (or `packed-refs`' stamp when
 * the ref is packed), and `config`'s stamp, which moves with `origin`. Null
 * when `.git` is not a plain directory (a worktree's `gitdir:` file) — that
 * folder is simply asked every time.
 */
function gitStateKey(dir: string): string | null {
  const gitDir = join(dir, '.git')
  try {
    if (!statSync(gitDir).isDirectory()) return null
    const head = readFileSync(join(gitDir, 'HEAD'), 'utf8').trim()
    const parts = [head, fileStamp(join(gitDir, 'config'))]
    if (head.startsWith('ref: ')) {
      const refFile = join(gitDir, ...head.slice(5).trim().split('/'))
      parts.push(existsSync(refFile) ? readFileSync(refFile, 'utf8').trim() : '-', fileStamp(join(gitDir, 'packed-refs')))
    }
    return parts.join('|')
  } catch {
    return null
  }
}

function originOf(url: string): string | null {
  try {
    return new URL(url).origin
  } catch {
    return null
  }
}

const UNSAFE_ADDRESS =
  'The team library answered with an address this app will not send your sign-in to (not https).'

/** Remember which instance a folder is shared through; a failure only costs recognition until the listing loads. */
async function recordServer(dir: string, serverOrigin: string): Promise<void> {
  if (!(await gitService.setCinnaServer(dir, serverOrigin))) {
    logger.warn('could not record the Cinna instance of a shared folder')
  }
}

/** The `shared_remote` link for a catalog entry: where it lives, and its catalog id. */
function linkFor(entry: LibraryEntry): DesktopSharedRemote {
  return {
    kind: 'cinna',
    repo_id: entry.repoId,
    clone_url: entry.cloneUrl,
    ...(entry.bundleId ? { bundle_id: entry.bundleId } : {})
  }
}

/** The contract's `shared_remote` in the agent's own `app-data/desktop.json`; null clears it. */
function writeLocalLink(dir: string, link: DesktopSharedRemote | null): void {
  try {
    desktopStateService.patch(dir, 'kit', { shared_remote: link })
  } catch (err) {
    logger.warn('could not write the shared_remote link into desktop.json', { error: String(err) })
  }
}

/** This machine's copies of library agents: by repository (from `origin`) and by manifest id. */
async function localCopies(
  userId: string,
  listing: CachedListing
): Promise<{
  byRepo: Map<string, { agentId: string; dir: string | null }>
  /** Keyed by the lowercased manifest id, as {@link sameManifestId} compares them. */
  byManifest: Map<string, { agentId: string; dir: string | null }>
}> {
  const byRepo = new Map<string, { agentId: string; dir: string | null }>()
  const byManifest = new Map<string, { agentId: string; dir: string | null }>()
  const agents = localAgentService.list(userId).agents
  for (const agent of agents) {
    if (agent.manifestId) byManifest.set(agent.manifestId.toLowerCase(), { agentId: agent.id, dir: null })
  }
  for (const agent of repoCandidates(userId)) {
    const remote = await gitService.readShareRemote(agent.path)
    if (!remote.ownRepo || remote.originUrl === null) continue
    const parsed = remoteOf(remote.originUrl, remote.cinnaServer)
    if (parsed.kind === 'cinna' && parsed.repoId !== null && parsed.host === listing.host) {
      byRepo.set(parsed.repoId, { agentId: agent.id, dir: agent.path })
      if (agent.manifestId) byManifest.set(agent.manifestId.toLowerCase(), { agentId: agent.id, dir: agent.path })
    }
  }
  return { byRepo, byManifest }
}
