import { createLogger } from '../../logger/logger'
import { markAllRootsDirty } from '../localAgents/scannerService'
import { createHash, randomUUID } from 'node:crypto'
import { runtimeHost } from '../../host/runtimeHost'
import { publishEvent } from '../../host/events'
import { getProfileScopeUserId } from '../../auth/scope'
import { getStoredCinnaSubject } from '../../auth/cinna-tokens'
import { userRepo } from '../../db/users'
import { credentialDto, serviceCredentialRepo as repo, type ServiceCredentialRow } from '../../db/serviceCredentials'
import { localAgentService } from '../localAgents/localAgentService'
import { desktopStateService } from '../localAgents/desktopStateService'
import { turnLock } from '../localAgents/turnLock'
import { createLocalScheduleScheduler } from '../localScheduleScheduler'
import { rememberCredentialSecrets } from '../../security/serviceCredentialRedaction'
import { checkCredentialPaths, collectOrphanBareCredentials, compareGeneration, writeCredentials } from './files'
import { serviceCredentialCloud } from './cloud'
import { localBundle, validateLocal } from './transforms'
import { autoMatch, isDeadKey, slotCandidates } from './slotMatch'
import { collectSkillSlots, judgeSkillSlot, skillSlotSpec, slotClaimed, type SkillSlot } from './skillSlots'
import { AGENT_API_KEY_PAUSED_STATUSES, SERVICE_CREDENTIALS_CHANGED, type AutoAttachedCredential, type CredentialSetupDto, type CredentialSetupSkillSlot, type CredentialSetupSlot, type SkillProvisionOutcome, type SkillProvisionSlot, type ServiceCredentialAttachOptions, type ServiceCredentialAttachments, type ServiceCredentialAttachmentDto, type ServiceCredentialBundle, type ServiceCredentialDto, type ServiceCredentialEntry, type ServiceCredentialInput } from '../../../shared/serviceCredentials'
import type { LocalAgentCredentialState, LocalAgentDto } from '../../../shared/localAgents'

const LOCAL = '__default__', SHARED_TTL = 7 * 86400_000
const CHANGED_ERROR = 'The account changed. Start the turn again.'
/**
 * One eligible Cinna account. Delivery does not depend on the current profile:
 * every eligible account contributes its attachments. Retiring an account bumps
 * its epoch and aborts its requests, so no awaited response can write for it.
 */
interface Account {
  key: string; userId: string; origin: string; label: string; detail: string
  /** The profile's server URL as stored, for links to the account's Core pages. */
  serverUrl: string
  /** How the account is named on screen: the Cinna full name, and the email it signs in with. */
  name: string; email: string
  epoch: number; abort: AbortController; syncError: string | null; lastSync: number | null
  /** When a sync of this account last started (poll, manual or turn start), successful or not. */
  lastAttempt: number | null
  synthetic: ServiceCredentialEntry[]
  /** Polls every minute while an attached issued key is active or paused (a rotation must land inside Core's 5-minute overlap). */
  fast: boolean
  flight: { global: number; epoch: number; promise: Promise<void>; again: boolean } | null
  scheduler: ReturnType<typeof createLocalScheduleScheduler>
}
type AccountInfo = Pick<Account, 'key' | 'userId' | 'origin' | 'label' | 'detail' | 'serverUrl' | 'name' | 'email'>
/** Global epoch/abort cover only suspend and shutdown; accounts carry their own. */
let epoch = 0, suspended = false, currentUser = LOCAL, started = false
let lifecycleAbort = new AbortController()
let cleanupError: string | null = null
const accounts = new Map<string, Account>()
/** Profiles signed out in this app session stay ineligible until activated again. */
const signedOut = new Set<string>()
let unlocked: (userId: string) => boolean = () => false
const logger = createLogger('service-credentials')
const pendingAgents = new Set<string>()
/**
 * What `provision-local` last answered this app session, per account and catalog skill revision
 * (`<account key>/<package uuid>/<revision>`). Only shown in Finish setup; never decides anything.
 */
const provisioned = new Map<string, SkillProvisionSlot[]>()
const PROVISION_OUTCOMES: readonly SkillProvisionOutcome[] = ['shared', 'already_shared', 'user_provides', 'not_shareable', 'not_allowed_locally']
const emptyAttachments = (): ServiceCredentialAttachments => ({ local: [], accounts: {} })
function secure(): void { if (!runtimeHost.keystore.isSecureStorageAvailable()) throw new Error('Secure storage is unavailable. Unlock the system keychain before using credentials.') }
function encrypt(value: unknown, previous?: Buffer | null): Buffer {
  secure(); const bytes = JSON.stringify(value)
  if (previous && runtimeHost.keystore.decryptString(previous) === bytes) return previous
  return runtimeHost.keystore.encryptString(bytes)
}
function decrypt(row: ServiceCredentialRow): ServiceCredentialBundle | null {
  if (!row.payload_enc) return null
  secure()
  let bundle: ServiceCredentialBundle
  try { bundle = JSON.parse(runtimeHost.keystore.decryptString(row.payload_enc)) as ServiceCredentialBundle }
  catch { throw new Error('Stored credential values could not be decrypted. Replace the local values or sync again.') }
  rememberCredentialSecrets(bundle)
  return bundle
}
/**
 * Cached metadata as stored. `keyStub` keeps an issued key's non-secret file fields (main only,
 * stripped from DTOs); `keyBlocked` marks a delivery Desktop refused to store (an insecure
 * `base_url`) until Core's revision changes, and reaches the renderer as the row's status.
 */
type StoredMetadata = Omit<ServiceCredentialDto, 'keyBlocked'> & { keyStub?: Record<string, string>; keyBlocked?: string | null }
function stored(row: ServiceCredentialRow): StoredMetadata { return JSON.parse(row.metadata) as StoredMetadata }
const KEY_STATUS = /^[a-z0-9_]{1,64}$/
/** Never `token`: only these fields survive into a token-less entry. */
const KEY_STUB_FIELDS = ['base_url', 'spec_url', 'label', 'producer_agent_id'] as const
const REFUSAL_STATUS: Record<string, string> = { key_revoked: 'revoked_by_issuer', key_expired: 'expired', key_paused: 'external_access_paused' }
const KEY_STATUS_WORDS: Record<string, string> = { revoked_by_issuer: 'revoked by issuer', producer_removed: 'producer removed', issuer_removed: 'issuer account removed',
  expired: 'expired', api_disabled: 'API turned off by producer', external_access_paused: 'external access paused' }
const LOOPBACK = new Set(['localhost', '127.0.0.1', '[::1]'])
const AUTO_ATTACH_RETRIES = 25, AUTO_ATTACH_RETRY_MS = 200
const FAST_POLL = 60_000, SLOW_POLL = 300_000, TURN_SYNC_AGE = 120_000, TURN_SYNC_BUDGET = 5_000
/** An issued key's list expiry in ms: epoch seconds, or an ISO-8601 string; anything else is no expiry. */
function expiresAt(value: unknown): number | null {
  if (typeof value === 'number') return Number.isFinite(value) ? value * 1000 : null
  if (typeof value !== 'string') return null
  const ms = Date.parse(value)
  return Number.isNaN(ms) ? null : ms
}
function isKey(m: Pick<ServiceCredentialDto, 'type'>): boolean { return m.type === 'agent_api' }
/** Fail closed: only an `active` issued key delivers a token; every other (or unknown) status is unavailable. */
function keyUnavailable(m: Pick<ServiceCredentialDto, 'type' | 'keyStatus'>): boolean { return isKey(m) && m.keyStatus !== 'active' }
/** Unavailable by status, or because Desktop refused its last delivery. */
function rowKeyUnavailable(row: ServiceCredentialRow): boolean { const m = stored(row); return keyUnavailable(m) || (isKey(m) && !!m.keyBlocked) }
/** Revoked, removed, expired or unknown: no use attaching it. Paused keys recover by themselves. */
function keyTerminal(m: ServiceCredentialDto): boolean { return isDeadKey(m) }
/** An issued key that is active or paused: one worth polling for and syncing at turn start. */
function liveKey(row: ServiceCredentialRow): boolean { const m = credentialDto(row); return isKey(m) && !keyTerminal(m) }
function unavailableReason(status: string | null): string { return status === 'expired' ? 'key_expired' : AGENT_API_KEY_PAUSED_STATUSES.includes(status ?? '') ? 'key_paused' : 'key_revoked' }
function keyStub(data: Record<string, unknown> | null | undefined): Record<string, string> {
  const out: Record<string, string> = {}
  for (const field of KEY_STUB_FIELDS) if (typeof data?.[field] === 'string') out[field] = data[field] as string
  return out
}
/** Rows a materialize call may fetch: allowed locally and not a non-active issued key. */
function deliverable(row: ServiceCredentialRow): boolean { return credentialDto(row).localUseAllowed && !rowKeyUnavailable(row) }
/**
 * An issued key's API address must be absolute http(s). Plain http only to this computer or to the
 * very origin this account already signs in to (a local or LAN Core the user configured over http):
 * the token goes nowhere the account's own bearer does not already go.
 */
export function keyApiUrl(entry: ServiceCredentialEntry, accountOrigin: string): URL | null {
  let url: URL
  try { url = new URL(String(entry.credential_data.base_url)) } catch { return null }
  if (url.protocol === 'https:') return url
  if (url.protocol === 'http:' && (LOOPBACK.has(url.hostname) || url.origin === accountOrigin)) return url
  return null
}
/** The token-less entry an attached non-active key writes, so the agent can say why it cannot call the producer. */
function unavailableBundle(row: ServiceCredentialRow): ServiceCredentialBundle {
  const m = stored(row)
  return { id: row.cloud_id!, revision: m.revision ?? '', service_account_file: null, ssh_key: null, entry: { id: row.cloud_id!, name: m.name, type: m.type, notes: m.notes,
    service_uri: m.serviceUri, is_placeholder: false, unavailable_reason: m.keyStatus === 'active' && m.keyBlocked ? m.keyBlocked : unavailableReason(m.keyStatus), ...(m.keyStatus && !(m.keyStatus === 'active' && m.keyBlocked) ? { key_status: m.keyStatus } : {}), credential_data: { ...m.keyStub } } }
}
interface Guard { global: number; accounts: [Account, number][] }
function guard(list: Account[]): Guard { return { global: epoch, accounts: list.map(acc => [acc, acc.epoch]) } }
function live(g: Guard): boolean { return g.global === epoch && !suspended && g.accounts.every(([acc, e]) => accounts.get(acc.key) === acc && acc.epoch === e) }
function check(g: Guard): void { if (!live(g)) throw new Error(CHANGED_ERROR) }
function checkProfile(userId: string, serverUrl?: string | null): void {
  if (!userId || userId !== currentUser || userId !== getProfileScopeUserId() ||
    (serverUrl !== undefined && (userRepo.get(userId)?.cinnaServerUrl?.replace(/\/$/, '') ?? null) !== (serverUrl?.replace(/\/$/, '') ?? null))) {
    throw new Error('The active profile changed. Open its credentials and try again.')
  }
}
function accountOf(userId: string): Account | undefined { return [...accounts.values()].find(acc => acc.userId === userId) }
/** Group order: local first, then accounts by profile name. */
function ordered(): Account[] { return [...accounts.values()].sort((x, y) => x.label.localeCompare(y.label) || x.key.localeCompare(y.key)) }
function status() {
  const acc = currentUser === LOCAL ? undefined : accountOf(currentUser)
  const u = currentUser === LOCAL ? undefined : userRepo.get(currentUser)
  // A current Cinna profile without a derivable identity has no account entry: it needs reauth.
  const own = acc ? acc.syncError : u?.type === 'cinna_user' && u.cinnaServerUrl && !signedOut.has(currentUser) ? 'reauth_required' : null
  return { lastSync: acc?.lastSync ?? null, error: own ?? cleanupError, secureStorage: runtimeHost.keystore.isSecureStorageAvailable() }
}
function changed(): void { markAllRootsDirty(); publishEvent('local-agent:changed', {}, 'all'); const s = status(); publishEvent(SERVICE_CREDENTIALS_CHANGED, { lastSync: s.lastSync, error: s.error }, 'all') }
function agent(id: string): LocalAgentDto { return localAgentService.get(LOCAL, id) }
function allAgents(): LocalAgentDto[] { return localAgentService.list(LOCAL).agents }
function state(a: Pick<LocalAgentDto, 'path' | 'kind'>): ServiceCredentialAttachments { return desktopStateService.read(a.path, a.kind).serviceCredentials ?? emptyAttachments() }
interface Resolved { ref: string; group: string; origin: 'local' | 'cloud'; account?: Account; available: boolean; row?: ServiceCredentialRow }
/** Every stored attachment. Ones whose account is not eligible are kept but never delivered. */
function resolve(a: Pick<LocalAgentDto, 'path' | 'kind'>): Resolved[] {
  const s = state(a), local = repo.list(LOCAL)
  const out: Resolved[] = s.local.map(({ ref }) => ({ ref, group: 'local', origin: 'local', available: true, row: local.find(r => r.origin === 'local' && r.id === ref) }))
  for (const account of ordered()) {
    const cached = repo.list(account.userId)
    for (const { ref } of s.accounts[account.key] ?? []) out.push({ ref, group: account.key, origin: 'cloud', account, available: true, row: cached.find(r => r.origin === 'cloud' && r.cloud_id === ref) })
  }
  for (const [key, list] of Object.entries(s.accounts)) if (!accounts.has(key)) for (const { ref } of list) out.push({ ref, group: key, origin: 'cloud', available: false })
  return out
}
function attachedAccounts(a: Pick<LocalAgentDto, 'path' | 'kind'>): Account[] { const s = state(a); return ordered().filter(acc => s.accounts[acc.key]?.length) }
function attachmentState(row?: ServiceCredentialRow): Exclude<ServiceCredentialAttachmentDto['state'], 'account_unavailable'> {
  if (!row) return 'missing'
  const m = credentialDto(row)
  if (rowKeyUnavailable(row)) return 'key_unavailable'
  if (!m.localUseAllowed) return 'local_use_not_allowed'
  if (!row.payload_enc) return m.isPlaceholder || m.status !== 'complete' ? 'incomplete' : 'not_cached'
  if ((m.relation === 'shared' && (row.payload_fetched_at ?? 0) + SHARED_TTL <= Date.now()) || (row.expires_at && row.expires_at <= Date.now())) return 'expired'
  if (m.isPlaceholder || m.status !== 'complete') return 'incomplete'
  return 'ready'
}
function queue(a: LocalAgentDto): void {
  // A running turn holds the agent shared: an issued key's rotation or loss is written now (D7), the rest waits below.
  if (turnLock.isLocked(a.id) && !turnLock.isExclusivelyLocked(a.id)) writeKeyChanges(a)
  if (pendingAgents.has(a.id)) return
  pendingAgents.add(a.id)
  // Queued, so the exclusive hold is taken atomically once the agent is free:
  // a shared turn that fires first from the same release must not turn this
  // into a refusal (and a spurious cleanup error). Never canceled, like the
  // `whenFree` waiter it replaces: a suspension is checked when it runs.
  void turnLock.withQueuedLock(a.id, 'credentials', new AbortController().signal, () => {
    pendingAgents.delete(a.id)
    if (suspended) return
    return materialize(a, false)
  }).catch(() => { cleanupError = 'cleanup_failed'; changed() })
}
function regenerate(filter?: (a: LocalAgentDto) => boolean): void { for (const a of allAgents()) if (!filter || filter(a)) queue(a) }
function signal(account: Account): AbortSignal { return AbortSignal.any([lifecycleAbort.signal, account.abort.signal]) }
async function fetchValues(account: Account, selected: ServiceCredentialRow[], g: Guard): Promise<void> {
  if (!selected.length) return
  secure()
  for (let i = 0; i < selected.length; i += 50) {
    const batch = selected.slice(i, i + 50)
    const delivery = await serviceCredentialCloud.materialize(account.userId, batch.map(r => r.cloud_id!), signal(account))
    check(g)
    if (!Array.isArray(delivery.items) || !Array.isArray(delivery.refused)) throw new Error('Invalid credential delivery response.')
    for (const row of batch) {
      const current = repo.get(row.id)
      // A list may revoke access while this delivery is in flight. Never put
      // a previously authorized payload back into a changed/deleted cache row.
      if (!current || current.metadata !== row.metadata || !deliverable(current)) continue
      const item = delivery.items.find(v => v.id === row.cloud_id)
      const refusal = delivery.refused.find(v => v.id === row.cloud_id)
      if (refusal) {
        const m = stored(row)
        // Backstop for a key the list still called active: record its status; the
        // owner's local-use setting is not what refused it. Stands until the next list pass,
        // which takes the status from Core's list again.
        if (isKey(m) && typeof refusal.reason === 'string' && refusal.reason.startsWith('key_')) {
          m.keyStatus = typeof refusal.key_status === 'string' && KEY_STATUS.test(refusal.key_status) && refusal.key_status !== 'active' ? refusal.key_status : REFUSAL_STATUS[refusal.reason] ?? 'revoked_by_issuer'
          logger.warn('Issued key refused at delivery', { userId: account.userId, cloud_id: row.cloud_id, key_status: m.keyStatus })
        } else m.localUseAllowed = false
        repo.put({ ...row, metadata: JSON.stringify(m), payload_enc: null, payload_fetched_at: null, updated_at: Date.now() })
      } else if (item && item.entry?.id === row.cloud_id && item.entry.type === credentialDto(row).type && item.ssh_key === null && typeof item.revision === 'string') {
        rememberCredentialSecrets(item)
        const m = stored(row); m.revision = item.revision
        const keyed = isKey(m)
        let blocked = false
        if (keyed) {
          const url = keyApiUrl(item.entry, account.origin)
          // A refused delivery's fields (its address included) do not become the stub.
          if (url) m.keyStub = { ...m.keyStub, ...keyStub(item.entry.credential_data) }
          // Never store a token Desktop would hand to a non-https, non-loopback API. Marked until the
          // revision changes (base_url is part of it), so this logs once per revision.
          if (!url) {
            blocked = true; m.keyBlocked = 'insecure_base_url'
            logger.warn('Issued key not stored: its API address is not https, this computer or its own server', { userId: account.userId, cloud_id: row.cloud_id })
          } else if (url.origin !== account.origin) logger.warn('Issued key calls an API on another origin than its account', { userId: account.userId, cloud_id: row.cloud_id, apiOrigin: url.origin })
        }
        const expiry = item.entry.credential_data.expires_at
        if (blocked) { repo.put({ ...row, metadata: JSON.stringify(m), payload_enc: null, payload_fetched_at: null, updated_at: Date.now() }); continue }
        repo.put({ ...row, metadata: JSON.stringify(m), payload_enc: encrypt(item, row.payload_enc), payload_fetched_at: Date.now(),
          expires_at: typeof expiry === 'number' ? expiry * 1000 : keyed ? row.expires_at : null, updated_at: Date.now() })
      } else throw new Error('Incomplete credential delivery response.')
    }
    if (delivery.current_user) account.synthetic = [...account.synthetic.filter(e => e.type !== 'current_user'), delivery.current_user]
    rememberCredentialSecrets(account.synthetic)
  }
}
/**
 * One materialization per agent folder at a time. Turns of one agent run side
 * by side and each prepares credentials, and `writeCredentials` reads the old
 * files, awaits (the cloud fetch, the path check) and only then writes or
 * unlinks: two interleaved would act on a stale read. Chained here so every
 * caller — turns, commands, attachment edits, regeneration — is covered.
 */
const materializing = new Map<string, Promise<unknown>>()
function chain<T>(path: string, fn: () => Promise<T>): Promise<T> {
  const run = (materializing.get(path) ?? Promise.resolve()).then(fn)
  const tail = run.catch(() => undefined)
  materializing.set(path, tail)
  void tail.then(() => { if (materializing.get(path) === tail) materializing.delete(path) })
  return run
}
function materialize(a: LocalAgentDto, refresh: boolean): Promise<{ path?: string; generation: string; prompt: string }> { return chain(a.path, () => materializeNow(a, refresh)) }
/**
 * Await the account's sync for at most the turn-start budget; a slow or failed one leaves the cache as it is.
 * `fresh`: the list must be read after this call (Core just shared something), so a sync already in flight
 * is asked for one more pass rather than joined.
 */
async function boundedSync(account: Account, fresh = false): Promise<void> {
  const running = !fresh && account.flight?.epoch === account.epoch && account.flight.global === epoch ? account.flight.promise : syncAccount(account)
  let timer: ReturnType<typeof setTimeout> | undefined
  try { await Promise.race([running.catch(() => undefined), new Promise<void>(resolve => { timer = setTimeout(resolve, TURN_SYNC_BUDGET) })]) }
  finally { clearTimeout(timer) }
}
/** What a generation consists of: the entries in attachment order, the identity entry and the fingerprint. */
function candidate(attached: Resolved[]): { bundles: ServiceCredentialBundle[]; identity: ServiceCredentialEntry[]; generation: string } {
  const bundles = attached.flatMap(v => {
    const status = attachmentState(v.row)
    if (v.row && status === 'key_unavailable') return [{ bundle: unavailableBundle(v.row), account: v.account }]
    if (!v.row || !['ready', 'incomplete'].includes(status)) return []
    const bundle = decrypt(v.row)
    return bundle ? [{ bundle, account: v.account }] : []
  })
  // A filled duplicate slot wins without field-level merging; a token-less key entry is never "filled".
  // Preserve attachment order otherwise. One Core record attached under two accounts is written once
  // (first group wins): duplicate entry ids would also collide on the service-account side file.
  const filled = (e: ServiceCredentialEntry) => e.is_placeholder === false && !e.unavailable_reason
  const effective = bundles.filter(({ bundle: b }) => filled(b.entry) || !bundles.some(({ bundle: other }) => filled(other.entry) && other.entry.type === b.entry.type && other.entry.service_uri === b.entry.service_uri))
    .filter((v, i, all) => all.findIndex(o => o.bundle.entry.id === v.bundle.entry.id) === i)
  // Only ready rows contribute, so an unavailable key does not make its account count.
  const contributing = ordered().filter(account => attached.some(v => v.account === account && v.row && attachmentState(v.row) === 'ready'))
  // `current_user` is the only synthetic identity entry (an issued key carries its identity in the key),
  // and Core gives it one fixed id. With several accounts contributing it would name
  // an arbitrary one of them, so it is written only when exactly one account does.
  const identity = contributing.length === 1 ? contributing[0].synthetic.filter(e => e.type === 'current_user') : []
  const keys = contributing.map(account => account.key)
  // A single account fingerprints as its bare key, so upgraded single-account runtimes stay stable.
  const generation = effective.length ? createHash('sha256').update(JSON.stringify([keys.length === 0 ? null : keys.length === 1 ? keys[0] : keys, effective.map(v => v.bundle), identity])).digest('hex') : 'empty'
  return { bundles: effective.map(v => v.bundle), identity, generation }
}
function promptState(row: ServiceCredentialRow): string {
  const state = attachmentState(row)
  if (state !== 'key_unavailable') return state
  if (credentialDto(row).keyStatus === 'active') return 'unavailable — insecure API address'
  const words = KEY_STATUS_WORDS[credentialDto(row).keyStatus ?? '']
  return words ? `unavailable — ${words}` : 'unavailable'
}
async function materializeNow(a: LocalAgentDto, refresh: boolean): Promise<{ path?: string; generation: string; prompt: string }> {
  const g = guard(attachedAccounts(a))
  check(g)
  let attached = resolve(a).filter(v => v.available)
  if (refresh) {
    // An attached issued key may have rotated or died while the poll was not running
    // (sleep, offline): sync its account first, bounded, and fall back to the cache.
    for (const account of attachedAccounts(a)) {
      // Gated on the last attempt, not the last success: a slow or offline Core costs one budget per interval, not one per turn.
      if ((account.lastAttempt ?? 0) >= Date.now() - TURN_SYNC_AGE || !attached.some(v => v.account === account && v.row && liveKey(v.row))) continue
      account.lastAttempt = Date.now()
      await boundedSync(account)
      check(g)
    }
    attached = resolve(a).filter(v => v.available)
    for (const account of attachedAccounts(a)) {
      const stale = attached.flatMap(v => v.account === account && v.row && deliverable(v.row) &&
        (!v.row.payload_enc || (v.row.expires_at !== null && v.row.expires_at < Date.now() + 600_000) || (v.row.payload_fetched_at ?? 0) < Date.now() - 300_000) ? [v.row] : [])
      try { await fetchValues(account, stale, g) } catch { check(g) /* Same-account offline use is bounded below. */ }
    }
    attached = resolve(a).filter(v => v.available)
  }
  check(g)
  if (!runtimeHost.keystore.isSecureStorageAvailable()) {
    await writeCredentials(a.path, a.kind, [], [], 'empty', () => check(g))
    if (refresh && attached.length) secure()
    return { generation: 'empty', prompt: '' }
  }
  const { bundles, identity, generation } = candidate(attached)
  const path = await writeCredentials(a.path, a.kind, bundles, identity, generation, () => check(g))
  check(g)
  return { path, generation, prompt: attached.length ? '\nAttached credentials (values are private):\n' + attached.map(v => v.row ? `${credentialDto(v.row).name} (${credentialDto(v.row).type}; slot ${credentialDto(v.row).serviceUri ?? 'none'}): ${promptState(v.row)}` : `Missing credential: ${v.ref}`).join('\n') : '' }
}
/** Same key set either way, compared field by field (Core's and Desktop's entries need not share key order). */
function sameFields(x: Record<string, unknown>, y: Record<string, unknown>, ignore: string[]): boolean {
  return [...new Set([...Object.keys(x), ...Object.keys(y)])].every(k => ignore.includes(k) || JSON.stringify(x[k]) === JSON.stringify(y[k]))
}
/**
 * Whether the next generation differs from the one on disk only by issued keys:
 * an active key's token changed (a rotation), or a key entry is now token-less.
 * Same files, same entries in the same order, every other field equal.
 */
function keyOnlyChange(current: Map<string, string>, next: Map<string, string>): boolean {
  if (current.size !== next.size || [...next.keys()].some(name => !current.has(name))) return false
  for (const [name, bytes] of next) if (name !== 'credentials.json' && current.get(name) !== bytes) return false
  const before = current.get('credentials.json'), after = next.get('credentials.json')
  if (!before || !after || before === after) return false
  let old: ServiceCredentialEntry[], now: ServiceCredentialEntry[]
  try { old = JSON.parse(before); now = JSON.parse(after) } catch { return false }
  if (!Array.isArray(old) || !Array.isArray(now) || old.length !== now.length) return false
  return now.every((n, i) => {
    const o = old[i]
    if (JSON.stringify(o) === JSON.stringify(n)) return true
    if (o?.type !== 'agent_api' || n?.type !== 'agent_api' || o.id !== n.id) return false
    if (!sameFields(o as unknown as Record<string, unknown>, n as unknown as Record<string, unknown>, ['credential_data', 'unavailable_reason', 'key_status'])) return false
    // Becoming (or staying) unavailable may only remove data: no token in the new entry.
    if (n.unavailable_reason) return !('token' in (n.credential_data ?? {}))
    // A rotation: both active, only the token differs.
    return !o.unavailable_reason && typeof n.credential_data?.token === 'string' && sameFields(o.credential_data ?? {}, n.credential_data, ['token'])
  })
}
/**
 * D7: while a turn runs, an issued key's rotation or loss cannot wait for the
 * exclusive hold (the old secret dies 5 minutes after a rotate). Written through
 * the per-path chain like a turn's own preparation; atomic per file. Any other
 * change returns here untouched and waits for the queued exclusive regeneration.
 */
function writeKeyChanges(a: LocalAgentDto): void {
  void chain(a.path, async () => {
    // Re-checked when it runs: the turn may have ended, or an exclusive holder taken over, since it was queued.
    if (suspended || !turnLock.isLocked(a.id) || turnLock.isExclusivelyLocked(a.id) || !runtimeHost.keystore.isSecureStorageAvailable()) return
    const g = guard(attachedAccounts(a))
    check(g)
    const { bundles, identity, generation } = candidate(resolve(a).filter(v => v.available))
    const files = compareGeneration(a.path, a.kind, bundles, identity)
    if (!files || !keyOnlyChange(files.current, files.next)) return
    await writeCredentials(a.path, a.kind, bundles, identity, generation, () => check(g))
    logger.info('Wrote an issued key change during a running turn', { agentId: a.id })
  }).catch(() => { logger.warn('Issued key change waits for the running turn', { agentId: a.id }) })
}
function hostOf(url: string): string { try { return new URL(url).host } catch { return url } }
/** Eligible: a Cinna profile with a server and stored tokens, not signed out this session, and either passwordless or unlocked. */
function eligible(): Map<string, AccountInfo> {
  const out = new Map<string, AccountInfo>()
  // The current profile wins a key shared with another row (a recreated profile).
  const users = userRepo.list().sort((x, y) => Number(y.id === currentUser) - Number(x.id === currentUser))
  for (const u of users) {
    if (u.type !== 'cinna_user' || !u.cinnaServerUrl || signedOut.has(u.id)) continue
    if (u.passwordHash && !unlocked(u.id) && u.id !== currentUser) continue
    let subject: string, origin: string
    try { subject = getStoredCinnaSubject(u.id); origin = new URL(u.cinnaServerUrl).origin } catch { continue }
    const key = createHash('sha256').update(origin + '\n' + subject).digest('hex').slice(0, 16)
    if (!out.has(key)) out.set(key, { key, userId: u.id, origin, label: u.displayName || u.username, detail: hostOf(u.cinnaServerUrl), serverUrl: u.cinnaServerUrl,
      name: u.cinnaFullName?.trim() || u.displayName || u.username, email: u.username })
  }
  return out
}
function retireAccount(account: Account): void {
  account.abort.abort(); account.epoch++; account.flight = null; account.synthetic = []; account.scheduler.stop()
  accounts.delete(account.key)
}
/** Whether an agent has an issued key from this account attached that can still come back or rotate. */
function watchesKeys(account: Account): boolean {
  return allAgents().some(a => resolve(a).some(v => v.account === account && v.row && liveKey(v.row)))
}
/** Recompute the poll cadence; re-arm the timer when it shortens, so the first fast tick is not 5 minutes away. */
function updatePolling(account: Account): void {
  const fast = watchesKeys(account), shrinks = fast && !account.fast
  account.fast = fast
  if (shrinks) account.scheduler.reschedule()
}
function createAccount(value: AccountInfo): Account {
  const account: Account = { ...value, epoch: 0, abort: new AbortController(), syncError: null, lastSync: null, lastAttempt: null, synthetic: [], fast: false, flight: null,
    scheduler: createLocalScheduleScheduler(async (_scope, current) => { if (current() && accounts.get(account.key) === account) await syncAccount(account) }, () => account.fast ? FAST_POLL : SLOW_POLL) }
  account.scheduler.setSuspended(suspended)
  return account
}
/** Recompute the eligible set; start/stop per-account sync and regenerate only agents attached to a changed account. */
function refreshAccounts(): void {
  if (!started) return
  const next = eligible(), touched = new Set<string>()
  for (const account of [...accounts.values()]) {
    const wanted = next.get(account.key)
    if (!wanted || wanted.userId !== account.userId || wanted.origin !== account.origin) { retireAccount(account); touched.add(account.key) }
    else { account.label = wanted.label; account.detail = wanted.detail; account.serverUrl = wanted.serverUrl; account.name = wanted.name; account.email = wanted.email }
  }
  for (const [key, value] of next) {
    if (accounts.has(key)) continue
    const account = createAccount(value)
    accounts.set(key, account); touched.add(key)
    account.scheduler.start({ profileUserId: account.userId, settingsUserId: LOCAL })
  }
  if (touched.size) regenerate(a => Object.keys(state(a).accounts).some(key => touched.has(key)))
  changed()
}
function syncAccount(account: Account): Promise<void> {
  const g = guard([account])
  if (account.flight?.epoch === account.epoch && account.flight.global === epoch) { account.flight.again = true; return account.flight.promise }
  const flight = { global: epoch, epoch: account.epoch, promise: Promise.resolve(), again: false }
  account.flight = flight
  flight.promise = (async () => {
    do { flight.again = false; await syncPass(account, g) } while (flight.again && live(g))
  })().finally(() => { if (account.flight === flight) account.flight = null })
  return flight.promise
}
async function syncPass(account: Account, g: Guard): Promise<void> {
  if (!live(g)) return
  account.lastAttempt = Date.now()
  try {
    const response = await serviceCredentialCloud.list(account.userId, signal(account))
    check(g)
    if (!Array.isArray(response.items)) throw new Error('Invalid credential list.')
    const userId = account.userId, origin = account.origin
    const seen = new Set<string>(), previous = repo.list(userId)
    for (const item of response.items) {
      if (typeof item?.id !== 'string') throw new Error('Invalid credential identity.')
      const keyed = item.type === 'agent_api'
      // Core lists only issued keys owned by the caller. Anything else of this type is
      // not cached, and a cached copy is pruned below, so a Core bug cannot reach a file.
      if (keyed && (item.relation !== 'owned' || typeof item.key_status !== 'string' || !KEY_STATUS.test(item.key_status))) {
        logger.warn('Ignored an Agent API credential Core should not list', { userId, cloud_id: item.id.slice(0, 128) })
        continue
      }
      // Core decides what is usable locally and lists nothing else, so the list
      // is taken as the full local set: a record it stops listing is pruned below.
      seen.add(item.id)
      if (!/^[a-zA-Z0-9_-]{1,128}$/.test(item.id) || typeof item.name !== 'string' || typeof item.type !== 'string' || typeof item.revision !== 'string' || !['owned', 'shared'].includes(item.relation) || typeof item.local_use_allowed !== 'boolean' || typeof item.is_placeholder !== 'boolean' || !['complete', 'incomplete'].includes(item.status) || [item.notes, item.service_uri, item.owner_email].some(v => v !== null && typeof v !== 'string')) continue
      const id = createHash('sha256').update(userId + '\n' + origin + '\n' + item.id).digest('hex')
      const old = repo.get(id), previous = old ? stored(old) : undefined
      // The list is authoritative for key status: a delivery refusal (the backstop) holds only
      // until this pass, since a pause and resume can leave Core's revision where it was.
      const keyStatus: string | null = keyed ? item.key_status! : null
      // Fail closed: a non-active key drops its cached token now and is never fetched while it stays so.
      const allowed = item.local_use_allowed, usable = allowed && (!keyed || keyStatus === 'active')
      const facts = keyed && item.agent_api && typeof item.agent_api === 'object' ? item.agent_api : null
      const text = (v: unknown) => typeof v === 'string' ? v : null
      const metadata: StoredMetadata = { id, origin: 'cloud', cloudId: item.id, name: item.name, type: item.type, serviceUri: item.service_uri, notes: item.notes, status: item.status,
        isPlaceholder: item.is_placeholder, relation: item.relation, ownerEmail: item.owner_email, localUseAllowed: allowed, revision: item.revision, hasValues: false, expiresAt: null,
        keyStatus, agentApi: facts ? { producerName: text(facts.producer_name), issuerEmail: text(facts.issuer_email) } : null }
      if (keyed) {
        // The list's non-secret facts win; the last delivery's fill the gaps (label). Never the token.
        const listed = keyStub({ ...facts })
        metadata.keyStub = Object.keys(listed).length ? keyStub({ ...previous?.keyStub, ...listed }) : previous?.keyStub
        // A refused delivery stays refused for this revision only.
        if (previous?.keyBlocked && previous.revision === item.revision) metadata.keyBlocked = previous.keyBlocked
        if (!usable && old?.payload_enc) logger.info('Issued key is not active; its cached token was dropped', { userId, cloud_id: item.id, key_status: keyStatus })
      }
      const expiry = keyed ? expiresAt(item.expires_at) ?? expiresAt(facts?.expires_at) : typeof item.expires_at === 'number' ? item.expires_at * 1000 : null
      repo.put({ id, user_id: userId, origin: 'cloud', cloud_id: item.id, server_origin: origin, metadata: JSON.stringify(metadata), payload_enc: usable ? old?.payload_enc ?? null : null,
        payload_fetched_at: usable && old && credentialDto(old).revision === item.revision ? old.payload_fetched_at : null,
        expires_at: expiry, created_at: old?.created_at ?? Date.now(), updated_at: Date.now() })
    }
    for (const row of previous) if (!seen.has(row.cloud_id!)) repo.remove(row.id)
    const attachedIds = new Set(allAgents().flatMap(a => resolve(a).flatMap(v => v.account === account && v.row ? [v.row.id] : [])))
    await fetchValues(account, repo.list(userId).filter(r => attachedIds.has(r.id) && deliverable(r) && (!r.payload_enc || r.payload_fetched_at === null || (r.expires_at !== null && r.expires_at < Date.now() + 600_000))), g)
    check(g); account.lastSync = Date.now(); account.syncError = null
  } catch (err) {
    if (!live(g)) return
    const failure = err as { code?: string; status?: number }
    account.syncError = failure.status === 403 ? 'permission_denied' : failure.code === 'reauth_required' ? 'reauth_required'
      : failure.status === 404 || failure.status === 405 ? 'not_supported'
        : failure.status && failure.status >= 500 ? 'server_error'
          : failure.code === 'invalid_response' ? 'invalid_response' : 'sync_failed'
    logger.warn('Credential sync failed for profile', { userId: account.userId, status: failure.status, code: account.syncError })
    if (account.syncError === 'reauth_required') account.scheduler.stop()
  }
  if (live(g)) { updatePolling(account); regenerate(a => !!state(a).accounts[account.key]?.length); changed() }
}
function toAttachmentDto(v: Resolved): ServiceCredentialAttachmentDto {
  const account = v.group === 'local' ? undefined : accounts.get(v.group)
  return { ref: v.ref, origin: v.origin, group: v.group, groupLabel: v.group === 'local' ? 'This computer' : account?.label ?? 'Signed-out account',
    credential: v.available && v.row ? credentialDto(v.row) : null, state: v.available ? attachmentState(v.row) : 'account_unavailable',
    serverUrl: account?.serverUrl ?? null, account: account ? { name: account.name, email: account.email } : null }
}

/** The current profile's account, when it is a signed-in Cinna account: the one the team library belongs to. */
function activeAccount(): Account | undefined {
  if (currentUser === LOCAL || currentUser !== getProfileScopeUserId()) return undefined
  return accountOf(currentUser)
}
function spec(slot: LocalAgentCredentialState) { return { name: slot.name, type: slot.type, serviceUri: slot.serviceUri ?? null } }
/**
 * `.env` fills the slot as the scanner judges it: every expected name has a value, or, for a slot
 * that declares no `fields` (no expected names), some name under its prefix does.
 */
function envFilled(slot: LocalAgentCredentialState): boolean {
  return slot.expectedKeys.length > 0 ? slot.presentKeys.length === slot.expectedKeys.length : slot.presentKeys.length > 0
}
/** The scanner's verdict on a slot, restated: what Finish setup shows and auto-attach skips. */
function slotState(slot: LocalAgentCredentialState): CredentialSetupSlot['state'] {
  if (slot.attachment) return slot.attachment.state === 'ready' ? 'connected' : 'missing'
  return envFilled(slot) ? 'env' : 'missing'
}
/**
 * Replace one group's attachments with `refsOf(current)`, computed under the agent's lock so an
 * append never drops a reference written in between. One state write and one materialization.
 * `queue: false` refuses (`turn_in_progress`) instead of waiting for a running turn.
 */
async function writeAttachments(id: string, group: string, refsOf: (before: { ref: string }[]) => string[], queue = true): Promise<ServiceCredentialAttachmentDto[]> {
  const a = agent(id)
  const valid = (refs: unknown): refs is string[] => Array.isArray(refs) && !refs.some(r => typeof r !== 'string' || !/^[a-zA-Z0-9_-]{1,128}$/.test(r))
  const current = (): { ref: string }[] => { const s = state(a); return group === 'local' ? s.local : s.accounts[group] ?? [] }
  if (typeof group !== 'string' || !valid(refsOf(current()))) throw new Error('Invalid attachment references.')
  const account = group === 'local' ? undefined : accounts.get(group)
  // A signed-out or deleted account's intent can only shrink: removals need no
  // rows, tokens or fetch, and a deleted profile's key may never be eligible again.
  const inert = group !== 'local' && !account
  if (inert && (!/^[a-f0-9]{16}$/.test(group) || refsOf(current()).some(ref => !(state(a).accounts[group] ?? []).some(v => v.ref === ref)))) throw new Error('Sign in to that account to change its credentials.')
  const g = guard(account ? [account] : [])
  const locked = <T,>(fn: () => Promise<T>): Promise<T> =>
    queue ? turnLock.withQueuedLock(id, 'credentials', new AbortController().signal, fn) : turnLock.withLock(id, 'credentials', fn)
  await locked(async () => {
    check(g)
    const s = state(a), before = group === 'local' ? s.local : s.accounts[group] ?? []
    const refs = refsOf(before)
    if (!valid(refs)) throw new Error('Invalid attachment references.')
    if (refs.length) secure()
    if (refs.length && a.kind === 'kit') await checkCredentialPaths(a.path)
    check(g)
    const available = inert ? [] : account ? repo.list(account.userId).filter(r => r.origin === 'cloud') : repo.list(LOCAL).filter(r => r.origin === 'local')
    for (const ref of refs.filter(ref => !before.some(v => v.ref === ref))) {
      const row = available.find(r => (account ? r.cloud_id : r.id) === ref)
      if (!row) throw new Error('Credential is no longer available.')
      if (!credentialDto(row).localUseAllowed) throw new Error('The owner has not allowed use on this computer.')
    }
    const next = [...new Set(refs)].map(ref => ({ ref }))
    if (group === 'local') s.local = next
    else if (next.length) s.accounts[group] = next
    else delete s.accounts[group]
    desktopStateService.patch(a.path, a.kind, { serviceCredentials: s })
    await materialize(a, true)
  })
  if (account) updatePolling(account)
  changed(); return serviceCredentialService.attachments(id)
}

/**
 * Append `added` to the account's group without waiting for a running turn: a turn (shared hold)
 * refuses at once, while an exclusive holder — another short write (a credential regeneration, a
 * sharing verb) — is retried for a few seconds, never queued. `keep` filters the additions once more
 * under the lock, on the fresh state; the answer is what was appended.
 */
async function appendWithoutWaiting(id: string, account: Account, added: string[], keep: (ref: string) => boolean = () => true): Promise<string[]> {
  let appended: string[] = []
  const append = (before: { ref: string }[]) => {
    appended = added.filter(ref => !before.some(v => v.ref === ref) && keep(ref))
    return [...before.map(v => v.ref), ...appended]
  }
  for (let attempt = 0; ; attempt++) {
    try { await writeAttachments(id, account.key, append, false); return appended }
    catch (error) {
      if ((error as { code?: string }).code !== 'turn_in_progress' || !turnLock.isExclusivelyLocked(id) || attempt >= AUTO_ATTACH_RETRIES) throw error
      await new Promise(resolve => setTimeout(resolve, AUTO_ATTACH_RETRY_MS))
    }
  }
}
/** Every available attachment as metadata with its state: what the scanner judges slots by. */
function attachedMetadata(a: Pick<LocalAgentDto, 'path' | 'kind'>): (ServiceCredentialDto & { state: ServiceCredentialAttachmentDto['state'] })[] {
  return resolve(a).flatMap(v => v.available && v.row ? [{ ...credentialDto(v.row), state: attachmentState(v.row) }] : [])
}
function withoutState(record: ServiceCredentialDto & { state: string }): ServiceCredentialDto {
  const { state: _state, ...dto } = record
  return dto
}
function provisionKey(account: Account, revision: { packageUuid: string; revisionNumber: number }): string {
  return `${account.key}/${revision.packageUuid.toLowerCase()}/${revision.revisionNumber}`
}
/**
 * `provision-local` for one pinned catalog skill revision: Core shares the publisher's credentials for
 * a local install with this account (idempotent, no values). Best effort: a failure is logged, and
 * answered as null.
 */
async function provisionRevision(account: Account, revision: { packageUuid: string; revisionNumber: number }): Promise<SkillProvisionSlot[] | null> {
  try {
    const answer = await serviceCredentialCloud.provisionLocal(account.userId, revision.packageUuid, revision.revisionNumber, signal(account))
    if (!Array.isArray(answer?.slots)) throw new Error('Invalid provision response.')
    const slots: SkillProvisionSlot[] = answer.slots.flatMap(item =>
      typeof item?.slot === 'string' && typeof item.type === 'string' && PROVISION_OUTCOMES.includes(item.outcome as SkillProvisionOutcome)
        ? [{ slot: item.slot, type: item.type, providedBy: typeof item.provided_by === 'string' ? item.provided_by : 'user',
          outcome: item.outcome as SkillProvisionOutcome, credentialId: typeof item.credential_id === 'string' ? item.credential_id : null }]
        : [])
    provisioned.set(provisionKey(account, revision), slots)
    return slots
  } catch (error) {
    const failure = error as { status?: number; code?: string }
    logger.info('Could not provision a catalog skill’s credentials for this computer', { revision: revision.revisionNumber, status: failure.status, code: failure.code })
    return null
  }
}
/** The last `provision-local` outcome for this slot under the account, from any of its declaring revisions. */
function provisionOf(account: Account | undefined, slot: SkillSlot): SkillProvisionOutcome | null {
  if (!account) return null
  for (const revision of slot.catalog) {
    const found = provisioned.get(provisionKey(account, revision))?.find(item => item.slot === slot.slot && item.type === slot.type)
    if (found) return found.outcome
  }
  return null
}

export const serviceCredentialService = {
  metadataForPath(path: string) { return resolve({ path, kind: 'kit' }).filter(v => v.available && v.row).map(v => ({ ...credentialDto(v.row!), state: attachmentState(v.row) })) },
  /** Local records plus the current profile's cloud cache (the settings pages). */
  list(): ServiceCredentialDto[] { return [...repo.list(LOCAL), ...(currentUser === LOCAL ? [] : repo.list(currentUser))].map(credentialDto) },
  snapshot(userId: string, serverUrl: string | null) {
    checkProfile(userId, serverUrl)
    return { items: this.list(), ...this.status() }
  },
  status,
  save(input: ServiceCredentialInput): ServiceCredentialDto {
    secure()
    const old = input.id ? repo.get(input.id) : undefined
    if (input.id && (!old || old.origin !== 'local')) throw new Error('Only local credential records can be edited.')
    if (old && credentialDto(old).type !== input.type) throw new Error('Credential type cannot be changed.')
    const id = old?.id ?? randomUUID()
    let bundle: ServiceCredentialBundle
    if (old && input.values === undefined) {
      bundle = decrypt(old)!
      bundle.entry = { ...bundle.entry, name: input.name.trim(), notes: input.notes ?? null, service_uri: input.serviceUri || null }
      if (input.type === 'api_token') {
        if (input.serviceUri) bundle.entry.credential_data.service_uri = input.serviceUri
        else delete bundle.entry.credential_data.service_uri
      }
      validateLocal({ ...input, values: {} })
    } else {
      const values = validateLocal(input); rememberCredentialSecrets(values)
      bundle = localBundle(id, input, values)
    }
    rememberCredentialSecrets(bundle)
    const metadata: ServiceCredentialDto = { id, origin: 'local', cloudId: null, name: bundle.entry.name, type: input.type, serviceUri: bundle.entry.service_uri, notes: bundle.entry.notes,
      status: bundle.entry.is_placeholder ? 'incomplete' : 'complete', isPlaceholder: bundle.entry.is_placeholder,
      relation: 'owned', ownerEmail: null, localUseAllowed: true, revision: null, hasValues: true, expiresAt: null, keyStatus: null, agentApi: null, keyBlocked: null }
    const now = Date.now()
    repo.put({ id, user_id: LOCAL, origin: 'local', cloud_id: null, server_origin: null, metadata: JSON.stringify(metadata), payload_enc: encrypt(bundle, old?.payload_enc), payload_fetched_at: now, expires_at: null, created_at: old?.created_at ?? now, updated_at: now })
    regenerate(); changed(); return metadata
  },
  remove(id: string): void {
    const row = repo.get(id)
    if (!row || row.origin !== 'local') throw new Error('Only local records can be deleted.')
    repo.remove(id); regenerate(); changed()
  },
  attachments(id: string): ServiceCredentialAttachmentDto[] { return resolve(agent(id)).map(toAttachmentDto) },
  /**
   * What can be attached to one agent: local records, then each eligible account's cache. Records the owner
   * keeps off this computer are omitted, and so are dead issued keys unless this agent already has them attached.
   */
  attachOptions(id: string): ServiceCredentialAttachOptions {
    const s = state(agent(id))
    return { groups: [
      { key: 'local', label: 'This computer', detail: '', error: null, items: repo.list(LOCAL).filter(r => r.origin === 'local').map(r => ({ ...credentialDto(r), attached: s.local.some(v => v.ref === r.id) })) },
      ...ordered().map(account => ({ key: account.key, label: account.label, detail: account.detail, error: account.syncError,
        items: repo.list(account.userId).flatMap(r => {
          const m = credentialDto(r), attached = (s.accounts[account.key] ?? []).some(v => v.ref === r.cloud_id)
          return r.origin === 'cloud' && m.localUseAllowed && (attached || !keyTerminal(m)) ? [{ ...m, attached }] : []
        }) }))
    ] }
  },
  async setAttachments(id: string, group: string, refs: string[]): Promise<ServiceCredentialAttachmentDto[]> {
    return writeAttachments(id, group, () => refs)
  },
  /** Add one record to an agent's group, keeping what is there (the Finish setup dialog's Use this). */
  async attach(id: string, group: string, ref: string): Promise<ServiceCredentialAttachmentDto[]> {
    if (typeof ref !== 'string') throw new Error('Invalid attachment references.')
    return writeAttachments(id, group, before => [...before.map(v => v.ref), ref])
  },
  /**
   * D1: after a Get, an Update or Use the team's version, attach the active profile's
   * cloud records that fit a still-unsatisfied slot without doubt (exactly one record
   * in the winning sub-tier, see `slotMatch`). Only that account's group, only appends,
   * one write for the agent. Never waits for a running turn: if one holds the agent the
   * write is refused and nothing is attached, so the verb returns at once and the
   * Finish setup dialog offers the same records. Answers what it attached; never throws.
   */
  async autoAttach(id: string): Promise<AutoAttachedCredential[]> {
    try {
      const account = activeAccount()
      if (!account) return []
      // Nothing left to fill: answer before the sync, which could only find records for slots that need none.
      if (!agent(id).credentials.some(slot => slotState(slot) === 'missing')) return []
      await boundedSync(account)
      if (accounts.get(account.key) !== account || activeAccount() !== account) return []
      // A bare agent declares no slots, so the loop below finds nothing to do.
      const a = agent(id)
      const picks = new Map<string, { slot: string; credentialName: string }>()
      const mine = state(a).accounts[account.key] ?? []
      const pool = repo.list(account.userId).filter(r => r.origin === 'cloud').map(credentialDto)
      for (const slot of a.credentials) {
        if (slotState(slot) !== 'missing') continue
        const pick = autoMatch(spec(slot), pool.filter(m => !mine.some(v => v.ref === m.cloudId) && !picks.has(m.cloudId!)))
        if (pick?.cloudId) picks.set(pick.cloudId, { slot: slot.name, credentialName: pick.name })
      }
      if (!picks.size) return []
      await appendWithoutWaiting(id, account, [...picks.keys()])
      logger.info('Attached matching credentials after a team library change', { agentId: id, count: picks.size })
      return [...picks.values()]
    } catch (error) {
      if ((error as { code?: string }).code === 'turn_in_progress') logger.info('Did not attach matching credentials: a turn holds the agent', { agentId: id })
      else logger.warn('Could not attach matching credentials', { agentId: id, error: error instanceof Error ? error.message : String(error) })
      return []
    }
  },
  /**
   * U11: fill the agent's skill slots without asking where the answer is unambiguous. Called after
   * Add to agent and Update of a catalog skill, after the sharing verbs have fetched the pinned
   * skills, and when Finish setup opens.
   *
   * 1. Only slots nobody chose for yet: an attachment with the slot's Service URI, of any type or
   *    state, is the user's choice and is never added to or replaced.
   * 2. `provision-local` for each pinned catalog revision declaring one of them (best effort), so a
   *    publisher-provided credential is listed for this account; then a sync of the account.
   * 3. Attach a cloud record of the active account only when exactly one strictly fits
   *    `(type, service_uri = slot)` (owned before shared, as `autoMatch`). Appends only.
   *
   * Never waits for a running turn and never throws: answers what it attached.
   */
  async autoAttachSkills(id: string): Promise<AutoAttachedCredential[]> {
    try {
      const account = activeAccount()
      if (!account) return []
      const open = (): SkillSlot[] => {
        const a = agent(id), attached = attachedMetadata(a)
        return collectSkillSlots(a.skills).filter(slot => !slotClaimed(slot, attached))
      }
      const wanted = open()
      if (!wanted.length) return []
      const revisions = wanted.flatMap(slot => slot.catalog)
        .filter((r, i, all) => all.findIndex(o => o.packageUuid === r.packageUuid && o.revisionNumber === r.revisionNumber) === i)
      let shared = false
      for (const revision of revisions) {
        const answer = await provisionRevision(account, revision)
        if (accounts.get(account.key) !== account) return []
        if (answer?.some(item => item.outcome === 'shared' || item.outcome === 'already_shared')) shared = true
      }
      await boundedSync(account, shared)
      if (accounts.get(account.key) !== account || activeAccount() !== account) return []
      // Read again after the awaits: the user may have attached something meanwhile.
      const slots = open()
      const a = agent(id)
      const mine = state(a).accounts[account.key] ?? []
      const pool = repo.list(account.userId).filter(r => r.origin === 'cloud').map(credentialDto)
      const picks = new Map<string, { slot: SkillSlot; credentialName: string }>()
      for (const slot of slots) {
        const pick = autoMatch(skillSlotSpec(slot), pool.filter(m => !mine.some(v => v.ref === m.cloudId) && !picks.has(m.cloudId!)))
        if (pick?.cloudId) picks.set(pick.cloudId, { slot, credentialName: pick.name })
      }
      if (!picks.size) return []
      // Decided once more under the lock: a slot the user filled in between keeps their choice.
      const appended = await appendWithoutWaiting(id, account, [...picks.keys()], ref => !slotClaimed(picks.get(ref)!.slot, attachedMetadata(a)))
      if (!appended.length) return []
      logger.info('Attached matching credentials for skill slots', { agentId: id, count: appended.length })
      return appended.map(ref => ({ slot: picks.get(ref)!.slot.slot, credentialName: picks.get(ref)!.credentialName, skill: true as const }))
    } catch (error) {
      if ((error as { code?: string }).code === 'turn_in_progress') logger.info('Did not attach skill credentials: a turn holds the agent', { agentId: id })
      else logger.warn('Could not attach skill credentials', { agentId: id, error: error instanceof Error ? error.message : String(error) })
      return []
    }
  },
  /**
   * What the Finish setup dialog shows: each slot as the scanner judges it, the attachment
   * it was judged by, and the active account's records that fit it.
   */
  setupState(id: string): CredentialSetupDto {
    const a = agent(id)
    const account = activeAccount()
    const rows = resolve(a).filter(v => v.available && v.row)
    const mine = account ? state(a).accounts[account.key] ?? [] : []
    const pool = account ? repo.list(account.userId).filter(r => r.origin === 'cloud').map(credentialDto).filter(m => !mine.some(v => v.ref === m.cloudId)) : []
    const slots: CredentialSetupSlot[] = a.credentials.map(slot => {
      const judged = slot.attachment ? rows.find(v => credentialDto(v.row!).id === slot.attachment!.credentialId) : undefined
      const verdict = slotState(slot)
      return {
        name: slot.name, type: slot.type, optional: slot.optional, envPrefix: slot.envPrefix,
        state: verdict,
        attached: judged ? { credential: credentialDto(judged.row!), state: attachmentState(judged.row) } : null,
        expectedKeys: slot.expectedKeys, presentKeys: slot.presentKeys,
        options: verdict === 'connected' || !account ? [] : slotCandidates(spec(slot), pool).map(m => ({ group: account.key, ref: m.cloudId!, credential: m }))
      }
    })
    const attached = attachedMetadata(a)
    const skillSlots: CredentialSetupSkillSlot[] = collectSkillSlots(a.skills).map(slot => {
      const { attachment, filled, typeMismatch } = judgeSkillSlot(slot, attached)
      return {
        slot: slot.slot, type: slot.type, skills: slot.skills, description: slot.description,
        state: filled ? 'connected' : 'missing',
        attached: attachment ? { credential: withoutState(attachment), state: attachment.state } : null,
        typeMismatch: typeMismatch ? withoutState(typeMismatch) : null,
        options: filled || !account ? [] : slotCandidates(skillSlotSpec(slot), pool).map(m => ({ group: account.key, ref: m.cloudId!, credential: m })),
        provision: provisionOf(account, slot)
      }
    })
    // Skill slots never decide setupNeeded: they warn, as in Core, and never open the dialog.
    return { slots, skillSlots, setupNeeded: a.credentials.some(c => !c.satisfied) }
  },
  /**
   * A turn's or command's credentials: the files written (or removed), and whether the folder carries
   * skills (only a kit agent's DTO has `skills`), whose scripts get the skill runtime on `PYTHONPATH`.
   */
  async prepare(id: string) { const a = agent(id); return { ...await materialize(a, true), skillRuntime: a.skills !== undefined } },
  /** Supplies the session unlock state; installed by the activation owner. */
  installUnlockCheck(fn: (userId: string) => boolean): void { unlocked = fn },
  /** Recompute eligible accounts after unlock, lock, logout, deletion or renewal. */
  refreshAccounts,
  /** Shutdown: invalidates every awaited request and stops all account timers. */
  retire(): void {
    lifecycleAbort.abort(); lifecycleAbort = new AbortController(); epoch++
    for (const account of [...accounts.values()]) retireAccount(account)
    provisioned.clear()
    started = false
  },
  /**
   * Profile activation. Switching the current profile changes only settings
   * pinning; delivered files change only when the eligible set does. The first
   * activation also scans for orphaned bare secrets and brings every agent current.
   */
  async activate(userId: string): Promise<void> {
    signedOut.delete(userId); currentUser = userId; cleanupError = null
    const first = !started
    started = true
    const captured = epoch
    refreshAccounts()
    markAllRootsDirty()
    const scanned = allAgents()
    try { collectOrphanBareCredentials(scanned.map(a => a.path)) }
    catch { cleanupError = 'cleanup_failed' /* Each affected agent retries at preparation. */ }
    if (!first) return
    // Try each folder independently; preparation refuses only the agent whose cleanup failed.
    for (const a of scanned) {
      if (captured !== epoch) return
      if (turnLock.isLocked(a.id)) { queue(a); continue }
      try { await turnLock.withLock(a.id, 'credentials', () => materialize(a, false)) }
      catch { if (captured === epoch && !suspended) cleanupError = 'cleanup_failed' }
    }
    if (captured === epoch) changed()
  },
  /** Logout: drop the profile's cache and keep it ineligible for this app session. */
  signOut(userId: string): void { signedOut.add(userId); repo.clearProfile(userId); refreshAccounts() },
  clearProfile(userId: string): void { repo.clearProfile(userId) },
  /** Fresh tokens for any profile, current or not: re-derive its account and sync it now. */
  renewed(userId: string): void {
    const existed = accountOf(userId)
    refreshAccounts()
    const account = accountOf(userId)
    // A newly eligible account was just started by refreshAccounts; starting it again would sync twice.
    if (account && account === existed) { account.syncError = null; account.scheduler.start({ profileUserId: userId, settingsUserId: LOCAL }) }
  },
  setSuspended(value: boolean): void {
    lifecycleAbort.abort(); lifecycleAbort = new AbortController(); suspended = value; epoch++
    for (const account of accounts.values()) account.scheduler.setSuspended(value)
    if (!value) regenerate()
  },
  /** Manual sync stays pinned to the displayed current profile. */
  sync(userId = currentUser, serverUrl?: string | null): Promise<void> {
    try { checkProfile(userId, serverUrl) } catch (error) { return Promise.reject(error) }
    const account = accountOf(userId)
    return account ? syncAccount(account) : Promise.resolve()
  }
}
