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
import { SERVICE_CREDENTIALS_CHANGED, type ServiceCredentialAttachments, type ServiceCredentialAttachmentDto, type ServiceCredentialBundle, type ServiceCredentialDto, type ServiceCredentialEntry, type ServiceCredentialInput } from '../../../shared/serviceCredentials'
import type { LocalAgentDto } from '../../../shared/localAgents'

const LOCAL = '__default__', SHARED_TTL = 7 * 86400_000
let epoch = 0, activeUser = LOCAL, accountKey: string | null = null, suspended = false
let lifecycleAbort = new AbortController()
let synthetic: ServiceCredentialEntry[] = []
let syncError: string | null = null, lastSync: number | null = null
const logger = createLogger('service-credentials')
let syncFlight: { epoch: number; userId: string; promise: Promise<void>; again: boolean } | null = null
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
function current(captured = epoch): boolean { return captured === epoch && activeUser === getProfileScopeUserId() && !suspended }
function checkCurrent(captured: number): void { if (!current(captured)) throw new Error('The active account changed. Start the turn again.') }
function checkProfile(userId: string, serverUrl?: string | null): void {
  if (!userId || userId !== activeUser || userId !== getProfileScopeUserId() ||
    (serverUrl !== undefined && (userRepo.get(userId)?.cinnaServerUrl?.replace(/\/$/, '') ?? null) !== (serverUrl?.replace(/\/$/, '') ?? null))) {
    throw new Error('The active profile changed. Open its credentials and try again.')
  }
}
function changed(): void { markAllRootsDirty(); publishEvent('local-agent:changed', {}, 'all'); publishEvent(SERVICE_CREDENTIALS_CHANGED, { lastSync, error: syncError }, 'all') }
function agent(id: string): LocalAgentDto { return localAgentService.get(LOCAL, id) }
function allAgents(): LocalAgentDto[] { return localAgentService.list(LOCAL).agents }
function state(a: Pick<LocalAgentDto, 'path' | 'kind'>): ServiceCredentialAttachments { return desktopStateService.read(a.path, a.kind).serviceCredentials ?? emptyAttachments() }
function rows(): ServiceCredentialRow[] { return [...repo.list(LOCAL), ...(activeUser === LOCAL ? [] : repo.list(activeUser))] }
function resolve(a: Pick<LocalAgentDto, 'path' | 'kind'>): { ref: string; origin: 'local' | 'cloud'; row?: ServiceCredentialRow }[] {
  const s = state(a), available = rows()
  return [...s.local.map(({ ref }) => ({ ref, origin: 'local' as const, row: available.find(r => r.origin === 'local' && r.id === ref) })),
    ...(accountKey ? s.accounts[accountKey] ?? [] : []).map(({ ref }) => ({ ref, origin: 'cloud' as const, row: available.find(r => r.origin === 'cloud' && r.cloud_id === ref) }))]
}
function attachmentState(row?: ServiceCredentialRow): ServiceCredentialAttachmentDto['state'] {
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
    void turnLock.withLock(a.id, 'credentials', () => materialize(a, false)).catch(() => { syncError = 'cleanup_failed'; changed() })
  })
}
function regenerate(): void { for (const a of allAgents()) queue(a) }
async function fetchValues(selected: ServiceCredentialRow[], captured: number): Promise<void> {
  if (!selected.length) return
  secure()
  for (let i = 0; i < selected.length; i += 50) {
    const batch = selected.slice(i, i + 50)
    const delivery = await serviceCredentialCloud.materialize(activeUser, batch.map(r => r.cloud_id!), lifecycleAbort.signal)
    checkCurrent(captured)
    if (!Array.isArray(delivery.items) || !Array.isArray(delivery.refused)) throw new Error('Invalid credential delivery response.')
    for (const row of batch) {
      const live = repo.get(row.id)
      // A list may revoke access while this delivery is in flight. Never put
      // a previously authorized payload back into a changed/deleted cache row.
      if (!live || live.metadata !== row.metadata || !credentialDto(live).localUseAllowed) continue
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
    if (delivery.current_user) synthetic = [...synthetic.filter(e => e.type !== 'current_user'), delivery.current_user]
    if (delivery.owner_identity) synthetic = [...synthetic.filter(e => e.type !== 'owner_identity_token'), delivery.owner_identity]
    rememberCredentialSecrets(synthetic)
  }
}
async function materialize(a: LocalAgentDto, refresh: boolean): Promise<{ path?: string; generation: string; prompt: string }> {
  const captured = epoch
  checkCurrent(captured)
  let attached = resolve(a)
  if (refresh) {
    const stale = attached.flatMap(v => v.row && v.row.origin === 'cloud' && credentialDto(v.row).localUseAllowed &&
      (!v.row.payload_enc || (credentialDto(v.row).type === 'agent_api' && !synthetic.some(e => e.type === 'owner_identity_token')) || (v.row.expires_at !== null && v.row.expires_at < Date.now() + 600_000) || (v.row.payload_fetched_at ?? 0) < Date.now() - 300_000) ? [v.row] : [])
    try { await fetchValues(stale, captured) } catch { checkCurrent(captured) /* Same-account offline use is bounded below. */ }
    attached = resolve(a)
  }
  checkCurrent(captured)
  if (!runtimeHost.keystore.isSecureStorageAvailable()) {
    await writeCredentials(a.path, a.kind, [], [], 'empty', () => checkCurrent(captured))
    if (refresh && attached.length) secure()
    return { generation: 'empty', prompt: '' }
  }
  const bundles = attached.flatMap(v => {
    const status = attachmentState(v.row)
    if (!v.row || !['ready', 'incomplete'].includes(status)) return []
    const bundle = decrypt(v.row)
    return bundle ? [bundle] : []
  })
  // A filled duplicate slot wins without field-level merging. Preserve attachment order otherwise.
  const effective = bundles.filter(b => b.entry.is_placeholder === false || !bundles.some(other => !other.entry.is_placeholder && other.entry.type === b.entry.type && other.entry.service_uri === b.entry.service_uri))
  const hasCloud = attached.some(v => v.origin === 'cloud' && v.row && attachmentState(v.row) === 'ready')
  const identity = hasCloud ? synthetic.filter(e => e.type === 'current_user' || effective.some(b => b.entry.type === 'agent_api' && b.entry.id === e.id) || (e.type === 'owner_identity_token' && effective.some(b => b.entry.type === 'agent_api'))) : []
  const generation = effective.length ? createHash('sha256').update(JSON.stringify([hasCloud ? accountKey : null, effective, identity])).digest('hex') : 'empty'
  const path = await writeCredentials(a.path, a.kind, effective, identity, generation, () => checkCurrent(captured))
  checkCurrent(captured)
  return { path, generation, prompt: attached.length ? '\nAttached credentials (values are private):\n' + attached.map(v => v.row ? `${credentialDto(v.row).name} (${credentialDto(v.row).type}; slot ${credentialDto(v.row).serviceUri ?? 'none'}): ${attachmentState(v.row)}` : `Missing credential: ${v.ref}`).join('\n') : '' }
}

export const serviceCredentialService = {
  metadataForPath(path: string) { return resolve({ path, kind: 'kit' }).filter(v => v.row).map(v => ({ ...credentialDto(v.row!), state: attachmentState(v.row) })) },
  list(): ServiceCredentialDto[] { return rows().map(credentialDto) },
  snapshot(userId: string, serverUrl: string | null) {
    checkProfile(userId, serverUrl)
    return { items: this.list(), ...this.status() }
  },
  status() { return { lastSync, error: syncError, secureStorage: runtimeHost.keystore.isSecureStorageAvailable() } },
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
  attachments(id: string): ServiceCredentialAttachmentDto[] {
    return resolve(agent(id)).map(v => ({ ref: v.ref, origin: v.origin, credential: v.row ? credentialDto(v.row) : null, state: attachmentState(v.row) }))
  },
  async setAttachments(id: string, origin: 'local' | 'cloud', refs: string[]): Promise<ServiceCredentialAttachmentDto[]> {
    const a = agent(id), captured = epoch
    if (!['local', 'cloud'].includes(origin) || !Array.isArray(refs) || refs.some(r => typeof r !== 'string' || !/^[a-zA-Z0-9_-]{1,128}$/.test(r))) throw new Error('Invalid attachment references.')
    if (origin === 'cloud' && !accountKey) throw new Error('Sign in to attach cloud credentials.')
    await turnLock.withQueuedLock(id, 'credentials', new AbortController().signal, async () => {
      checkCurrent(captured)
      if (refs.length) secure()
      if (refs.length && a.kind === 'kit') await checkCredentialPaths(a.path)
      checkCurrent(captured)
      const s = state(a), before = origin === 'local' ? s.local : s.accounts[accountKey!] ?? []
      for (const ref of refs.filter(ref => !before.some(v => v.ref === ref))) {
        const row = rows().find(r => r.origin === origin && (origin === 'local' ? r.id : r.cloud_id) === ref)
        if (!row) throw new Error('Credential is no longer available.')
        if (!credentialDto(row).localUseAllowed) throw new Error('The owner has not allowed use on this computer.')
      }
      const next = [...new Set(refs)].map(ref => ({ ref }))
      if (origin === 'local') s.local = next; else s.accounts[accountKey!] = next
      desktopStateService.patch(a.path, a.kind, { serviceCredentials: s })
      await materialize(a, true)
    })
    changed(); return this.attachments(id)
  },
  async prepare(userId: string, id: string) {
    if (userId !== activeUser) throw new Error('The active account changed. Start the turn again.')
    return materialize(agent(id), true)
  },
  /** Retirement invalidates awaited HTTP before any profile teardown. Busy turns clean up on release. */
  retire(): void { lifecycleAbort.abort(); lifecycleAbort = new AbortController(); epoch++; accountKey = null; synthetic = []; syncFlight = null; scheduler.stop() },
  async activate(userId: string): Promise<void> {
    this.retire(); activeUser = userId; syncError = null; lastSync = null; const captured = epoch
    const u = userRepo.get(userId)
    if (u?.type === 'cinna_user' && u.cinnaServerUrl) {
      try {
        const subject = getStoredCinnaSubject(userId)
        accountKey = createHash('sha256').update(new URL(u.cinnaServerUrl).origin + '\n' + subject).digest('hex').slice(0, 16)
      } catch { checkCurrent(captured); syncError = 'reauth_required' }
    }
    markAllRootsDirty()
    const scanned = allAgents()
    try { collectOrphanBareCredentials(scanned.map(a => a.path)) }
    catch { syncError = 'cleanup_failed' /* Each affected agent retries at preparation. */ }
    // Try each folder independently; preparation refuses only the agent whose cleanup failed.
    for (const a of scanned) {
      if (turnLock.isLocked(a.id)) queue(a)
      else {
        try { await turnLock.withLock(a.id, 'credentials', () => materialize(a, false)) }
        catch { checkCurrent(captured); syncError = 'cleanup_failed' }
      }
      checkCurrent(captured)
    }
    if (accountKey) scheduler.start({ profileUserId: userId, settingsUserId: LOCAL })
    changed()
  },
  clearProfile(userId: string): void { repo.clearProfile(userId) },
  setSuspended(value: boolean): void { lifecycleAbort.abort(); lifecycleAbort = new AbortController(); suspended = value; epoch++; scheduler.setSuspended(value); if (!value) regenerate() },
  sync(userId = activeUser, serverUrl?: string | null): Promise<void> {
    try { checkProfile(userId, serverUrl) } catch (error) { return Promise.reject(error) }
    const captured = epoch
    if (syncFlight?.epoch === captured && syncFlight.userId === userId) { syncFlight.again = true; return syncFlight.promise }
    const flight = { epoch: captured, userId, promise: Promise.resolve(), again: false }
    syncFlight = flight
    flight.promise = (async () => {
      do { flight.again = false; await this.syncPass(userId, captured) } while (flight.again && accountKey && current(captured))
    })().finally(() => { if (syncFlight === flight) syncFlight = null })
    return flight.promise
  },
  async syncPass(userId: string, captured: number): Promise<void> {
    if (!accountKey || !current(captured) || userId !== activeUser) return
    try {
      const response = await serviceCredentialCloud.list(userId, lifecycleAbort.signal)
      checkCurrent(captured)
      if (!Array.isArray(response.items)) throw new Error('Invalid credential list.')
      const seen = new Set<string>(), previous = repo.list(userId)
      const origin = new URL(userRepo.get(userId)!.cinnaServerUrl!).origin
      for (const item of response.items) {
        if (typeof item?.id !== 'string') throw new Error('Invalid credential identity.')
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
      const attachedIds = new Set(allAgents().flatMap(a => resolve(a).flatMap(v => v.row?.origin === 'cloud' ? [v.row.id] : [])))
      await fetchValues(repo.list(userId).filter(r => attachedIds.has(r.id) && credentialDto(r).localUseAllowed && (!r.payload_enc || r.payload_fetched_at === null || (r.expires_at !== null && r.expires_at < Date.now() + 600_000))), captured)
      checkCurrent(captured); lastSync = Date.now(); syncError = null
    } catch (err) {
      if (!current(captured)) return
      const failure = err as { code?: string; status?: number }
      syncError = failure.status === 403 ? 'permission_denied' : failure.code === 'reauth_required' ? 'reauth_required'
        : failure.status === 404 || failure.status === 405 ? 'not_supported'
          : failure.status && failure.status >= 500 ? 'server_error'
            : failure.code === 'invalid_response' ? 'invalid_response' : 'sync_failed'
      logger.warn('Credential sync failed for profile', { userId, status: failure.status, code: syncError })
      if (syncError === 'reauth_required') scheduler.stop()
    }
    if (current(captured)) { regenerate(); changed() }
  }
}
const scheduler = createLocalScheduleScheduler(async (scope, current) => { if (current()) await serviceCredentialService.sync(scope.profileUserId) }, 300_000)
