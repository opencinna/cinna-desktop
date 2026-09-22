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
import { checkCredentialPaths, collectOrphanBareCredentials, writeCredentials } from './files'
import { serviceCredentialCloud } from './cloud'
import { localBundle, validateLocal } from './transforms'
import { SERVICE_CREDENTIALS_CHANGED, type ServiceCredentialAttachOptions, type ServiceCredentialAttachments, type ServiceCredentialAttachmentDto, type ServiceCredentialBundle, type ServiceCredentialDto, type ServiceCredentialEntry, type ServiceCredentialInput } from '../../../shared/serviceCredentials'
import type { LocalAgentDto } from '../../../shared/localAgents'

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
  synthetic: ServiceCredentialEntry[]
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
  if (!m.localUseAllowed) return 'local_use_not_allowed'
  if (!row.payload_enc) return m.isPlaceholder || m.status !== 'complete' ? 'incomplete' : 'not_cached'
  if ((m.relation === 'shared' && (row.payload_fetched_at ?? 0) + SHARED_TTL <= Date.now()) || (row.expires_at && row.expires_at <= Date.now())) return 'expired'
  if (m.isPlaceholder || m.status !== 'complete') return 'incomplete'
  return 'ready'
}
function queue(a: LocalAgentDto): void {
  if (pendingAgents.has(a.id)) return
  pendingAgents.add(a.id)
  turnLock.whenFree(a.id, () => {
    pendingAgents.delete(a.id)
    if (suspended) return
    void turnLock.withLock(a.id, 'credentials', () => materialize(a, false)).catch(() => { cleanupError = 'cleanup_failed'; changed() })
  })
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
      if (!current || current.metadata !== row.metadata || !credentialDto(current).localUseAllowed) continue
      const item = delivery.items.find(v => v.id === row.cloud_id)
      const refusal = delivery.refused.find(v => v.id === row.cloud_id)
      if (refusal) {
        const m = credentialDto(row); m.localUseAllowed = false
        repo.put({ ...row, metadata: JSON.stringify(m), payload_enc: null, payload_fetched_at: null, updated_at: Date.now() })
      } else if (item && item.entry?.id === row.cloud_id && item.entry.type === credentialDto(row).type && item.ssh_key === null && typeof item.revision === 'string') {
        rememberCredentialSecrets(item)
        const m = credentialDto(row); m.revision = item.revision
        const expiry = item.entry.credential_data.expires_at
        repo.put({ ...row, metadata: JSON.stringify(m), payload_enc: encrypt(item, row.payload_enc), payload_fetched_at: Date.now(), expires_at: typeof expiry === 'number' ? expiry * 1000 : null, updated_at: Date.now() })
      } else throw new Error('Incomplete credential delivery response.')
    }
    if (delivery.current_user) account.synthetic = [...account.synthetic.filter(e => e.type !== 'current_user'), delivery.current_user]
    rememberCredentialSecrets(account.synthetic)
  }
}
async function materialize(a: LocalAgentDto, refresh: boolean): Promise<{ path?: string; generation: string; prompt: string }> {
  const g = guard(attachedAccounts(a))
  check(g)
  let attached = resolve(a).filter(v => v.available)
  if (refresh) {
    for (const account of attachedAccounts(a)) {
      const stale = attached.flatMap(v => v.account === account && v.row && credentialDto(v.row).localUseAllowed &&
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
  const bundles = attached.flatMap(v => {
    const status = attachmentState(v.row)
    if (!v.row || !['ready', 'incomplete'].includes(status)) return []
    const bundle = decrypt(v.row)
    return bundle ? [{ bundle, account: v.account }] : []
  })
  // A filled duplicate slot wins without field-level merging. Preserve attachment order otherwise.
  // One Core record attached under two accounts is written once (first group wins):
  // duplicate entry ids would also collide on the service-account side file.
  const effective = bundles.filter(({ bundle: b }) => b.entry.is_placeholder === false || !bundles.some(({ bundle: other }) => !other.entry.is_placeholder && other.entry.type === b.entry.type && other.entry.service_uri === b.entry.service_uri))
    .filter((v, i, all) => all.findIndex(o => o.bundle.entry.id === v.bundle.entry.id) === i)
  const contributing = ordered().filter(account => attached.some(v => v.account === account && v.row && attachmentState(v.row) === 'ready'))
  // `current_user` is the only identity entry (Core delivers no Agent API credentials),
  // and Core gives it one fixed id. With several accounts contributing it would name
  // an arbitrary one of them, so it is written only when exactly one account does.
  const identity = contributing.length === 1 ? contributing[0].synthetic.filter(e => e.type === 'current_user') : []
  const keys = contributing.map(account => account.key)
  // A single account fingerprints as its bare key, so upgraded single-account runtimes stay stable.
  const generation = effective.length ? createHash('sha256').update(JSON.stringify([keys.length === 0 ? null : keys.length === 1 ? keys[0] : keys, effective.map(v => v.bundle), identity])).digest('hex') : 'empty'
  const path = await writeCredentials(a.path, a.kind, effective.map(v => v.bundle), identity, generation, () => check(g))
  check(g)
  return { path, generation, prompt: attached.length ? '\nAttached credentials (values are private):\n' + attached.map(v => v.row ? `${credentialDto(v.row).name} (${credentialDto(v.row).type}; slot ${credentialDto(v.row).serviceUri ?? 'none'}): ${attachmentState(v.row)}` : `Missing credential: ${v.ref}`).join('\n') : '' }
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
function createAccount(value: AccountInfo): Account {
  const account: Account = { ...value, epoch: 0, abort: new AbortController(), syncError: null, lastSync: null, synthetic: [], flight: null,
    scheduler: createLocalScheduleScheduler(async (_scope, current) => { if (current() && accounts.get(account.key) === account) await syncAccount(account) }, 300_000) }
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
  try {
    const response = await serviceCredentialCloud.list(account.userId, signal(account))
    check(g)
    if (!Array.isArray(response.items)) throw new Error('Invalid credential list.')
    const userId = account.userId, origin = account.origin
    const seen = new Set<string>(), previous = repo.list(userId)
    for (const item of response.items) {
      if (typeof item?.id !== 'string') throw new Error('Invalid credential identity.')
      // Core decides what is usable locally and lists nothing else, so the list
      // is taken as the full local set: a record it stops listing is pruned below.
      seen.add(item.id)
      if (!/^[a-zA-Z0-9_-]{1,128}$/.test(item.id) || typeof item.name !== 'string' || typeof item.type !== 'string' || typeof item.revision !== 'string' || !['owned', 'shared'].includes(item.relation) || typeof item.local_use_allowed !== 'boolean' || typeof item.is_placeholder !== 'boolean' || !['complete', 'incomplete'].includes(item.status) || [item.notes, item.service_uri, item.owner_email].some(v => v !== null && typeof v !== 'string')) continue
      const id = createHash('sha256').update(userId + '\n' + origin + '\n' + item.id).digest('hex')
      const old = repo.get(id), allowed = item.local_use_allowed
      const metadata: ServiceCredentialDto = { id, origin: 'cloud', cloudId: item.id, name: item.name, type: item.type, serviceUri: item.service_uri, notes: item.notes, status: item.status,
        isPlaceholder: item.is_placeholder, relation: item.relation, ownerEmail: item.owner_email, localUseAllowed: allowed, revision: item.revision, hasValues: false, expiresAt: null }
      repo.put({ id, user_id: userId, origin: 'cloud', cloud_id: item.id, server_origin: origin, metadata: JSON.stringify(metadata), payload_enc: allowed ? old?.payload_enc ?? null : null,
        payload_fetched_at: old && credentialDto(old).revision === item.revision ? old.payload_fetched_at : null,
        expires_at: typeof item.expires_at === 'number' ? item.expires_at * 1000 : null, created_at: old?.created_at ?? Date.now(), updated_at: Date.now() })
    }
    for (const row of previous) if (!seen.has(row.cloud_id!)) repo.remove(row.id)
    const attachedIds = new Set(allAgents().flatMap(a => resolve(a).flatMap(v => v.account === account && v.row ? [v.row.id] : [])))
    await fetchValues(account, repo.list(userId).filter(r => attachedIds.has(r.id) && credentialDto(r).localUseAllowed && (!r.payload_enc || r.payload_fetched_at === null || (r.expires_at !== null && r.expires_at < Date.now() + 600_000))), g)
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
  if (live(g)) { regenerate(a => !!state(a).accounts[account.key]?.length); changed() }
}
function toAttachmentDto(v: Resolved): ServiceCredentialAttachmentDto {
  const account = v.group === 'local' ? undefined : accounts.get(v.group)
  return { ref: v.ref, origin: v.origin, group: v.group, groupLabel: v.group === 'local' ? 'This computer' : account?.label ?? 'Signed-out account',
    credential: v.available && v.row ? credentialDto(v.row) : null, state: v.available ? attachmentState(v.row) : 'account_unavailable',
    serverUrl: account?.serverUrl ?? null, account: account ? { name: account.name, email: account.email } : null }
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
      relation: 'owned', ownerEmail: null, localUseAllowed: true, revision: null, hasValues: true, expiresAt: null }
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
  /** What can be attached to one agent: local records, then each eligible account's cache. Records the owner keeps off this computer are omitted. */
  attachOptions(id: string): ServiceCredentialAttachOptions {
    const s = state(agent(id))
    return { groups: [
      { key: 'local', label: 'This computer', detail: '', error: null, items: repo.list(LOCAL).filter(r => r.origin === 'local').map(r => ({ ...credentialDto(r), attached: s.local.some(v => v.ref === r.id) })) },
      ...ordered().map(account => ({ key: account.key, label: account.label, detail: account.detail, error: account.syncError,
        items: repo.list(account.userId).filter(r => r.origin === 'cloud' && credentialDto(r).localUseAllowed).map(r => ({ ...credentialDto(r), attached: (s.accounts[account.key] ?? []).some(v => v.ref === r.cloud_id) })) }))
    ] }
  },
  async setAttachments(id: string, group: string, refs: string[]): Promise<ServiceCredentialAttachmentDto[]> {
    const a = agent(id)
    if (typeof group !== 'string' || !Array.isArray(refs) || refs.some(r => typeof r !== 'string' || !/^[a-zA-Z0-9_-]{1,128}$/.test(r))) throw new Error('Invalid attachment references.')
    const account = group === 'local' ? undefined : accounts.get(group)
    // A signed-out or deleted account's intent can only shrink: removals need no
    // rows, tokens or fetch, and a deleted profile's key may never be eligible again.
    const inert = group !== 'local' && !account
    if (inert && (!/^[a-f0-9]{16}$/.test(group) || refs.some(ref => !(state(a).accounts[group] ?? []).some(v => v.ref === ref)))) throw new Error('Sign in to that account to change its credentials.')
    const g = guard(account ? [account] : [])
    await turnLock.withQueuedLock(id, 'credentials', new AbortController().signal, async () => {
      check(g)
      if (refs.length) secure()
      if (refs.length && a.kind === 'kit') await checkCredentialPaths(a.path)
      check(g)
      const s = state(a), before = group === 'local' ? s.local : s.accounts[group] ?? []
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
    changed(); return this.attachments(id)
  },
  async prepare(id: string) { return materialize(agent(id), true) },
  /** Supplies the session unlock state; installed by the activation owner. */
  installUnlockCheck(fn: (userId: string) => boolean): void { unlocked = fn },
  /** Recompute eligible accounts after unlock, lock, logout, deletion or renewal. */
  refreshAccounts,
  /** Shutdown: invalidates every awaited request and stops all account timers. */
  retire(): void {
    lifecycleAbort.abort(); lifecycleAbort = new AbortController(); epoch++
    for (const account of [...accounts.values()]) retireAccount(account)
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
