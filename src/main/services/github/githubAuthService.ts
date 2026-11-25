/**
 * The OpenCinna GitHub sign-in, per Cinna profile (guest included): device flow, the secret-less
 * refresh, the installations cache and the needs the composer shows. Tokens stay here; the
 * renderer only ever gets {@link GithubStatusDto}, and the agent's `gh` wrapper gets a token through
 * the loopback route (`githubLoopback.ts`), which calls {@link GithubAuthService.token}.
 *
 * Refresh tokens rotate (a refresh kills the previous access token and refresh token at once), so a
 * refresh runs single-flight per profile and the new pair is persisted before anyone is answered.
 * No token is handed out with less than ten minutes left.
 *
 * Core module: no Electron. HTTP through `runtimeHost.http.fetch`, secrets through `runtimeHost.keystore`.
 * Opening the browser for the device flow is the desktop's job, not this module's.
 */
import { createLogger, type ScopedLogger } from '../../logger/logger'
import { runtimeHost } from '../../host/runtimeHost'
import { publishEvent } from '../../host/events'
import { githubAccountRepo } from '../../db/githubAccounts'
import { rememberCredentialSecrets } from '../../security/serviceCredentialRedaction'
import { GITHUB_CHANGED, type GithubAccountState, type GithubCoverage, type GithubDeviceFlowDto, type GithubNeedChatless, type GithubNeedDto, type GithubStatusDto } from '../../../shared/github'
import { getRepoVisibility, getUser, listCoverage, parseTokenPair, pollDeviceToken, refreshAccessToken, requestDeviceCode, safeCode, type GithubFetch, type RepoVisibility, type TokenPair } from './githubApi'
import { coverageOf, installUrlFor, parseRepo, type CoverageAnswer } from './githubCoverage'
import { createNeedsRegistry } from './githubNeeds'

/** Never hand out an access token with less than this left: refresh first. */
export const MIN_TOKEN_TTL_MS = 600_000
/** A lookup naming a repository the cache does not cover refreshes it at most this often. */
export const COVERAGE_MISS_REFRESH_MS = 60_000
/** A repository's known visibility is kept this long. */
export const VISIBILITY_REFRESH_MS = COVERAGE_MISS_REFRESH_MS
/** At most this many repositories' visibility are kept per profile (the oldest go first). */
export const VISIBILITY_CACHE_MAX = 500
/** A device-flow poll that fails (unreachable, 5xx) is logged at most this often, with a count. */
export const DEVICE_POLL_FAILURE_LOG_MS = 30_000
/** Both mean the refresh token is dead (rotated out, revoked or expired): Reconnect GitHub. */
const DEAD_REFRESH = new Set(['bad_refresh_token', 'incorrect_client_credentials'])

interface StoredAccount extends TokenPair {
  accessToken: string
  login: string
  id: number
  name: string
  /** `<id>+<login>@users.noreply.github.com`; never logged, never sent to the renderer. */
  email: string
  state: GithubAccountState
}
/** An expired record keeps who it was (for display) but no tokens. */
type Account = Omit<StoredAccount, 'accessToken'> & { accessToken: string | null }

/** The commit identity of a signed-in account: its GitHub name and `<id>+<login>@users.noreply.github.com`. */
export interface GithubIdentity { name: string; email: string }
export interface GithubTokenGrant { token: string; /** Epoch ms, or null for a token without expiry. */ expiresAt: number | null; login: string; name: string; email: string }
export type GithubTokenResult =
  | { kind: 'token'; grant: GithubTokenGrant }
  | { kind: 'needed'; need: 'sign_in' | 'reconnect' }
  | { kind: 'unavailable' }

export interface GithubServiceDeps {
  fetch: GithubFetch
  /** The sealed blob per profile (base64 of the keystore's bytes). */
  store: { read(userId: string): string | null; write(userId: string, value: string): void; remove(userId: string): void }
  keystore: { secure(): boolean; encrypt(text: string): Promise<string>; decrypt(sealed: string): Promise<string> }
  publish(userId: string): void
  now?: () => number
  /** Resolves after `ms`, or at once when `signal` aborts. */
  wait?: (ms: number, signal: AbortSignal) => Promise<void>
  logger?: ScopedLogger
}

/** What holds an agent now: the profile its loopback request is served for, and whether no chat shows the run. */
export interface GithubAgentHolder { userId: string; chatless: GithubNeedChatless }
/** Holders of one agent working for different profiles at once: nothing is served or recorded. */
export interface GithubHolderConflict { conflict: true }
/** The holder's profile cannot serve now (locked, not activated, gone): nothing is served or recorded. */
export interface GithubHolderLocked { locked: true }

/** Which profile an agent works for, and whether a profile can serve a token now. Installed by the hub. */
export interface GithubProfileAccess {
  agentHolder(agentId: string): GithubAgentHolder | GithubHolderConflict | null
  available(userId: string): boolean
  /** Whether the profile exists at all: one that does but cannot serve is locked. Absent: exists. */
  exists?(userId: string): boolean
}

interface DeviceFlow { dto: GithubDeviceFlowDto; abort: AbortController; gen: number }
interface Profile {
  /** Bumped by sign-out and profile removal: nothing awaited before it may write after it. */
  gen: number
  /** undefined: not read from the store yet. */
  account: Account | null | undefined
  loading?: Promise<Account | null>
  refreshing?: Promise<GithubTokenResult>
  coverage: { installs: GithubCoverage[]; fetchedAt: number } | null
  coverageFlight?: Promise<boolean>
  /** Bumped whenever the cached coverage is thrown away: a read started before it never lands, and is never joined, after it. */
  coverageEpoch?: number
  lastMissRefresh: number
  /**
   * Per repository (lowercased), whether it is public: a definite answer is kept for
   * {@link VISIBILITY_REFRESH_MS}; a read in flight is shared by concurrent callers; an unknown
   * answer is not kept. At most {@link VISIBILITY_CACHE_MAX} entries. Cleared with the coverage cache.
   */
  visibility: Map<string, { readAt: number; answer: Promise<RepoVisibility | null> }>
  device: DeviceFlow | null
  starting?: Promise<GithubDeviceFlowDto>
}

function defaultWait(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise(resolve => {
    if (signal.aborted) { resolve(); return }
    const timer = setTimeout(done, ms)
    timer.unref?.()
    function done(): void { clearTimeout(timer); signal.removeEventListener('abort', done); resolve() }
    signal.addEventListener('abort', done, { once: true })
  })
}

function remember(account: { accessToken: string | null; refreshToken: string | null }): void {
  rememberCredentialSecrets({ access_token: account.accessToken, refresh_token: account.refreshToken })
}

function parseAccount(value: unknown): Account | null {
  const v = value as Partial<Account> | null
  if (!v || typeof v.login !== 'string' || typeof v.id !== 'number' || (v.state !== 'connected' && v.state !== 'expired')) return null
  const str = (x: unknown): string | null => (typeof x === 'string' && x ? x : null)
  const num = (x: unknown): number | null => (typeof x === 'number' && Number.isFinite(x) ? x : null)
  return {
    accessToken: str(v.accessToken), expiresAt: num(v.expiresAt), refreshToken: str(v.refreshToken), refreshExpiresAt: num(v.refreshExpiresAt),
    login: v.login, id: v.id, name: typeof v.name === 'string' && v.name ? v.name : v.login, email: str(v.email) ?? `${v.id}+${v.login}@users.noreply.github.com`, state: v.state
  }
}

export function createGithubAuthService(deps: GithubServiceDeps) {
  const now = deps.now ?? Date.now
  const wait = deps.wait ?? defaultWait
  const logger = deps.logger ?? createLogger('github')
  const needs = createNeedsRegistry()
  const profiles = new Map<string, Profile>()
  let access: GithubProfileAccess = { agentHolder: () => null, available: () => true }
  let onSignedIn: (userId: string) => void = () => {}
  let onGhMissing: (agentId: string) => Promise<boolean> = async () => false
  let onIdentity: (userId: string, identity: GithubIdentity | null) => void = () => {}

  function profile(userId: string): Profile {
    let p = profiles.get(userId)
    if (!p) { p = { gen: 0, account: undefined, coverage: null, lastMissRefresh: -Infinity, visibility: new Map(), device: null }; profiles.set(userId, p) }
    return p
  }
  function publish(userId: string): void { deps.publish(userId) }
  /** The commit identity of what the profile holds now (expired included: still the user's account), to the hook. */
  function identityChanged(userId: string, account: Account | null): void {
    try { onIdentity(userId, account ? { name: account.name, email: account.email } : null) }
    catch (error) { logger.warn('A GitHub identity hook failed', { error: error instanceof Error ? error.message : String(error) }) }
  }

  async function load(userId: string): Promise<Account | null> {
    const p = profile(userId)
    if (p.account !== undefined) return p.account
    if (p.loading) return p.loading
    const gen = p.gen
    const loading = (async (): Promise<Account | null> => {
      const sealed = deps.store.read(userId)
      if (!sealed) return null
      try { return parseAccount(JSON.parse(await deps.keystore.decrypt(sealed))) }
      catch {
        logger.warn('The GitHub sign-in could not be read', { userId })
        throw new Error('unreadable')
      }
    })()
    p.loading = loading
    try {
      const account = await loading
      if (account) remember(account)
      if (p.gen === gen) { p.account = account; identityChanged(userId, account) }
      return p.gen === gen ? account : null
    } catch {
      // Not cached: a keystore that comes back later reads it then.
      return null
    } finally {
      if (p.loading === loading) p.loading = undefined
    }
  }

  /**
   * Seal and write `account` for the profile as of `gen`. Throws when storage is not secure or the
   * profile moved on. The profile object is taken before the await and compared after it: a profile
   * removed meanwhile (its entry deleted, its gen bumped) is never re-created or written back.
   */
  async function persist(userId: string, account: Account, gen: number): Promise<void> {
    if (!deps.keystore.secure()) throw new Error('Secure storage is unavailable. Unlock the system keychain and sign in to GitHub again.')
    const p = profiles.get(userId)
    const moved = (): boolean => !p || profiles.get(userId) !== p || p.gen !== gen
    if (moved()) throw new Error('The profile changed while GitHub was signing in.')
    const sealed = await deps.keystore.encrypt(JSON.stringify(account))
    if (moved()) throw new Error('The profile changed while GitHub was signing in.')
    deps.store.write(userId, sealed)
    p!.account = account
    identityChanged(userId, account)
  }

  function clearCoverage(p: Profile): void {
    p.coverage = null
    p.visibility = new Map()
    p.coverageEpoch = (p.coverageEpoch ?? 0) + 1
    p.coverageFlight = undefined
  }

  /**
   * The installations cache, after the read in flight when the cache is empty (just after a
   * sign-in, while its first read runs): an empty cache must not answer "not installed".
   */
  async function settledCoverage(p: Profile): Promise<Profile['coverage']> {
    if (!p.coverage && p.coverageFlight) await p.coverageFlight
    return p.coverage
  }

  function grantOf(a: Account & { accessToken: string }): GithubTokenGrant {
    return { token: a.accessToken, expiresAt: a.expiresAt, login: a.login, name: a.name, email: a.email }
  }

  /**
   * The refresh token is dead: the account turns `expired` (Settings shows Reconnect GitHub). No
   * need is recorded here: the wrapper may still fall back to the user's own gh login, and a
   * composer row appears only when it reports `/github/needed`.
   */
  async function expire(userId: string, gen: number): Promise<void> {
    const p = profile(userId), current = p.account
    if (!current || p.gen !== gen) return
    const expired: Account = { ...current, accessToken: null, expiresAt: null, refreshToken: null, refreshExpiresAt: null, state: 'expired' }
    p.account = expired
    try { await persist(userId, expired, gen) }
    catch (error) { logger.warn('The expired GitHub sign-in was not stored', { userId, error: error instanceof Error ? error.message : String(error) }) }
    if (p.gen !== gen) return
    clearCoverage(p)
    logger.info('GitHub sign-in expired; Reconnect GitHub', { userId })
    publish(userId)
  }

  async function refresh(userId: string, gen: number): Promise<GithubTokenResult> {
    const p = profile(userId), current = p.account
    if (!current?.accessToken || current.state !== 'connected') return { kind: 'needed', need: current ? 'reconnect' : 'sign_in' }
    if (!current.refreshToken || (current.refreshExpiresAt !== null && current.refreshExpiresAt <= now())) {
      await expire(userId, gen)
      return { kind: 'needed', need: 'reconnect' }
    }
    let body: Record<string, unknown>
    try { body = await refreshAccessToken(deps.fetch, current.refreshToken) }
    catch (error) {
      logger.warn('GitHub could not be reached to refresh the sign-in', { userId, status: (error as { status?: unknown }).status ?? null })
      return { kind: 'unavailable' }
    }
    if (p.gen !== gen) return { kind: 'needed', need: 'sign_in' }
    if (typeof body.error === 'string') {
      const code = safeCode(body.error)
      if (DEAD_REFRESH.has(code)) {
        logger.warn('GitHub refused the refresh token', { userId, code })
        await expire(userId, gen)
        return { kind: 'needed', need: 'reconnect' }
      }
      logger.warn('GitHub refused a refresh', { userId, code })
      return { kind: 'unavailable' }
    }
    const pair = parseTokenPair(body, now())
    if (!pair) { logger.warn('GitHub sent an unreadable refresh answer', { userId }); return { kind: 'unavailable' } }
    // A refresh that sends no new refresh token keeps the old one (GitHub always rotates; a fake may not).
    const next: Account & { accessToken: string } = { ...current, ...pair, refreshToken: pair.refreshToken ?? current.refreshToken, refreshExpiresAt: pair.refreshToken ? pair.refreshExpiresAt : current.refreshExpiresAt, state: 'connected' }
    remember(next)
    // Persisted before anyone is answered: the old pair is dead now, and a restart must not read it.
    try { await persist(userId, next, gen) }
    catch (error) {
      if (p.gen !== gen) return { kind: 'needed', need: 'sign_in' }
      // Held in memory for this session; a restart will need Reconnect.
      p.account = next
      logger.warn('The refreshed GitHub sign-in was not stored', { userId, error: error instanceof Error ? error.message : String(error) })
    }
    logger.info('GitHub sign-in refreshed', { userId })
    return { kind: 'token', grant: grantOf(next) }
  }

  async function token(userId: string): Promise<GithubTokenResult> {
    if (!access.available(userId)) return { kind: 'needed', need: 'sign_in' }
    const account = await load(userId)
    if (!account) return { kind: 'needed', need: 'sign_in' }
    if (account.state === 'expired' || !account.accessToken) return { kind: 'needed', need: 'reconnect' }
    if (account.expiresAt === null || account.expiresAt - now() >= MIN_TOKEN_TTL_MS) return { kind: 'token', grant: grantOf(account as Account & { accessToken: string }) }
    const p = profile(userId)
    if (p.refreshing) return p.refreshing
    const flight = refresh(userId, p.gen).catch((error): GithubTokenResult => {
      logger.warn('GitHub refresh failed', { userId, error: error instanceof Error ? error.message : String(error) })
      return { kind: 'unavailable' }
    })
    p.refreshing = flight
    void flight.finally(() => { if (p.refreshing === flight) p.refreshing = undefined })
    return flight
  }

  async function refreshCoverage(userId: string): Promise<boolean> {
    const p = profile(userId)
    if (p.coverageFlight) return p.coverageFlight
    const gen = p.gen
    const epoch = p.coverageEpoch ?? 0
    const flight = (async (): Promise<boolean> => {
      const t = await token(userId)
      if (t.kind !== 'token') return false
      let installs: GithubCoverage[]
      try { installs = await listCoverage(deps.fetch, t.grant.token) }
      catch (error) {
        logger.warn('GitHub installations could not be read', { userId, status: (error as { status?: unknown }).status ?? null })
        return false
      }
      // Another account signed in (or this one out) while the read ran: its answer is not this account's.
      if (p.gen !== gen || (p.coverageEpoch ?? 0) !== epoch) return false
      p.coverage = { installs, fetchedAt: now() }
      // Just read: a miss within the window answers from it instead of reading again.
      p.lastMissRefresh = now()
      needs.clearCovered(userId, repo => coverageOf(installs, repo).answer === 'covered')
      publish(userId)
      return true
    })()
    p.coverageFlight = flight
    try { return await flight } finally { if (p.coverageFlight === flight) p.coverageFlight = undefined }
  }

  function endDevice(userId: string, flow: DeviceFlow, state: GithubDeviceFlowDto['state'], error?: string): void {
    const p = profile(userId)
    if (p.device !== flow) return
    flow.dto = { ...flow.dto, state, ...(error ? { error } : {}) }
    flow.abort.abort()
    logger.info('GitHub sign-in ended', { userId, state })
    publish(userId)
  }

  async function completeDevice(userId: string, flow: DeviceFlow, body: Record<string, unknown>): Promise<void> {
    const p = profile(userId)
    const current = (): boolean => p.device === flow && p.gen === flow.gen && !flow.abort.signal.aborted
    const pair = parseTokenPair(body, now())
    if (!pair) { endDevice(userId, flow, 'error', 'GitHub sent an unreadable sign-in. Try again.'); return }
    remember(pair)
    let user
    try { user = await getUser(deps.fetch, pair.accessToken) }
    catch { if (current()) endDevice(userId, flow, 'error', 'GitHub could not be reached to read the account. Try again.'); return }
    if (!current()) return
    const account: Account = { ...pair, login: user.login, id: user.id, name: user.name, email: `${user.id}+${user.login}@users.noreply.github.com`, state: 'connected' }
    try { await persist(userId, account, flow.gen) }
    catch (error) {
      if (current()) endDevice(userId, flow, 'error', error instanceof Error ? error.message : 'The GitHub sign-in could not be stored.')
      return
    }
    if (!current()) return
    flow.abort.abort()
    p.device = null
    clearCoverage(p)
    // A new sign-in: its installations were never read, so the first lookup may read them.
    p.lastMissRefresh = -Infinity
    needs.clearAccount(userId)
    logger.info('Signed in to GitHub', { userId })
    publish(userId)
    await refreshCoverage(userId)
    try { onSignedIn(userId) } catch (error) { logger.warn('A GitHub sign-in hook failed', { error: error instanceof Error ? error.message : String(error) }) }
  }

  async function pollDevice(userId: string, flow: DeviceFlow, deviceCode: string, interval: number): Promise<void> {
    const p = profile(userId)
    const current = (): boolean => p.device === flow && p.gen === flow.gen && !flow.abort.signal.aborted
    let delay = interval * 1000
    let failures = 0, lastFailureLog = -Infinity
    while (true) {
      await wait(delay, flow.abort.signal)
      if (!current()) return
      if (now() >= flow.dto.expiresAt) { endDevice(userId, flow, 'expired'); return }
      let body: Record<string, unknown>
      try { body = await pollDeviceToken(deps.fetch, deviceCode) }
      catch (error) {
        // Not reachable now: the code is still valid until it expires. Logged with the HTTP status
        // and the error's class only (never a code or token), the first time and then at most every 30 s.
        failures++
        if (now() - lastFailureLog >= DEVICE_POLL_FAILURE_LOG_MS) {
          lastFailureLog = now()
          logger.warn('A GitHub sign-in poll failed; still polling', { userId, status: (error as { status?: unknown }).status ?? null, error: error instanceof Error ? error.constructor.name : typeof error, failures })
        }
        continue
      }
      if (!current()) return
      if (typeof body.access_token === 'string') { await completeDevice(userId, flow, body); return }
      const code = safeCode(body.error)
      if (code === 'authorization_pending') continue
      if (code === 'slow_down') { delay = typeof body.interval === 'number' && body.interval > 0 ? body.interval * 1000 : delay + 5000; continue }
      if (code === 'expired_token') { endDevice(userId, flow, 'expired'); return }
      if (code === 'access_denied') { endDevice(userId, flow, 'denied'); return }
      endDevice(userId, flow, 'error', `GitHub refused the sign-in (${code}). Try again.`)
      return
    }
  }

  async function startDevice(userId: string): Promise<GithubDeviceFlowDto> {
    const p = profile(userId)
    if (p.device?.dto.state === 'pending') return { ...p.device.dto }
    if (p.starting) return p.starting
    if (!access.available(userId)) throw new Error('This profile is locked. Unlock it to sign in to GitHub.')
    const gen = p.gen
    const starting = (async (): Promise<GithubDeviceFlowDto> => {
      const code = await requestDeviceCode(deps.fetch)
      if (p.gen !== gen) throw new Error('The profile changed while GitHub was signing in.')
      rememberCredentialSecrets(code.deviceCode, 'device_secret')
      p.device?.abort.abort()
      const flow: DeviceFlow = { dto: { userCode: code.userCode, verificationUri: code.verificationUri, expiresAt: now() + code.expiresIn * 1000, state: 'pending' }, abort: new AbortController(), gen }
      p.device = flow
      logger.info('GitHub sign-in started', { userId })
      publish(userId)
      void pollDevice(userId, flow, code.deviceCode, code.interval).catch(error => {
        endDevice(userId, flow, 'error', 'The GitHub sign-in failed. Try again.')
        logger.warn('GitHub sign-in polling failed', { userId, error: error instanceof Error ? error.message : String(error) })
      })
      return { ...flow.dto }
    })()
    p.starting = starting
    try { return await starting } finally { if (p.starting === starting) p.starting = undefined }
  }

  function forgetLocally(userId: string): void {
    const p = profile(userId)
    p.gen++
    p.device?.abort.abort()
    p.device = null
    p.account = null
    clearCoverage(p)
    p.refreshing = undefined
    p.lastMissRefresh = -Infinity
    needs.clear(userId)
    identityChanged(userId, null)
  }

  async function status(userId: string): Promise<GithubStatusDto> {
    if (!access.available(userId)) return { account: null, device: null, needs: [], dismissed: [] }
    const account = await load(userId), p = profile(userId)
    return {
      account: account ? { login: account.login, state: account.state, coverage: structuredClone(p.coverage?.installs ?? []), coverageFetchedAt: p.coverage?.fetchedAt ?? null } : null,
      device: p.device ? { ...p.device.dto } : null,
      needs: needs.list(userId),
      dismissed: needs.dismissedKeys(userId)
    }
  }

  return {
    /** Installed by the hub: which profile an agent works for, and whether a profile can serve now. */
    installProfileAccess(next: GithubProfileAccess): void { access = next },
    /** Called after a sign-in completed (the managed gh install hooks here). */
    setOnSignedIn(fn: (userId: string) => void): void { onSignedIn = fn },
    /**
     * Called when the wrapper found no `gh` at all (the managed gh install hooks here). Answers
     * whether a managed gh install is running now, so the wrapper can tell "still installing" from
     * "could not install".
     */
    setOnGhMissing(fn: (agentId: string) => Promise<boolean>): void { onGhMissing = fn },
    /**
     * Called with the profile's commit identity whenever what it holds is read, stored or forgotten
     * (sign-in, account change, expiry, sign-out, profile removal): null when signed out. The
     * GitHub git identity file (`githubGitConfig.ts`) hooks here.
     */
    setOnIdentity(fn: (userId: string, identity: GithubIdentity | null) => void): void { onIdentity = fn },
    /**
     * Read the profile's account (once; cached after) and hand its identity to the hook again: what
     * a kit agent's prepare calls, so the file is right before the turn's git runs. Nothing for a
     * profile that cannot serve, or an account that could not be read (the file is left as it is).
     */
    async syncIdentity(userId: string): Promise<void> {
      if (!access.available(userId)) return
      const account = await load(userId), p = profiles.get(userId)
      if (p && p.account !== undefined) identityChanged(userId, account)
    },
    /** Startup: each listed profile with no stored sign-in hands the hook null (a leftover identity file goes). */
    clearStaleIdentities(userIds: string[]): void {
      for (const userId of userIds) if (!deps.store.read(userId)) identityChanged(userId, null)
    },
    async ghMissing(agentId: string): Promise<boolean> {
      try { return (await onGhMissing(agentId)) === true } catch (error) {
        logger.warn('A gh-missing hook failed', { error: error instanceof Error ? error.message : String(error) })
        return false
      }
    },
    /**
     * What an agent's loopback request works for: the profile of what holds the agent now (not
     * the active one, unless the hold recorded none), and whether no chat shows that run. Null
     * when that profile cannot serve; a conflict when the agent's holders work for different profiles.
     */
    holderOf(agentId: string): GithubAgentHolder | GithubHolderConflict | GithubHolderLocked | null {
      const holder = access.agentHolder(agentId)
      if (!holder || 'conflict' in holder) return holder
      if (access.available(holder.userId)) return holder
      // A profile that is gone answers as no profile at all (sign in, nothing recorded).
      return access.exists?.(holder.userId) === false ? null : { locked: true }
    },

    /**
     * The needs a run no chat shows hit (`chatlessAgentIds` non-empty), for the Inbox. Empty for a
     * profile that cannot serve. A dismissed or cleared need is not in the registry any more.
     */
    chatlessNeeds(userId: string): GithubNeedDto[] {
      if (!access.available(userId)) return []
      return needs.list(userId).filter(n => (n.kind === 'sign_in' || n.kind === 'reconnect' || n.kind === 'install') && (n.chatlessAgentIds?.length ?? 0) > 0)
    },

    /** What the renderer sees: never a token, refresh token or email. A profile that cannot serve reads as not signed in. */
    status,

    /** Start the device flow, or answer the one already pending. The caller opens `verificationUri`. */
    startDeviceFlow: startDevice,
    cancelDeviceFlow(userId: string): void {
      const p = profiles.get(userId)
      if (!p?.device) return
      p.device.abort.abort(); p.device = null
      publish(userId)
    },

    token,
    /**
     * Whether the profile's installations cover `owner/repo`: from the cache, refreshed when it has
     * never been read or, at most once a minute, when it does not cover the repo. An empty cache
     * with a read in flight (just after a sign-in) waits for that read. Null when it could not be
     * read at all.
     */
    async coverageFor(userId: string, repo: string): Promise<{ answer: CoverageAnswer; installUrl: string } | null> {
      const p = profile(userId)
      const settled = await settledCoverage(p)
      let cached = settled ? coverageOf(settled.installs, repo) : null
      if (cached?.answer !== 'covered' && now() - p.lastMissRefresh >= COVERAGE_MISS_REFRESH_MS) {
        p.lastMissRefresh = now()
        await refreshCoverage(userId)
        cached = p.coverage ? coverageOf(p.coverage.installs, repo) : null
      }
      return cached ? { answer: cached.answer, installUrl: installUrlFor(cached.answer, cached.install) } : null
    },
    /**
     * Whether `owner/repo` is public, read with the profile's token (`GET /repos/{owner}/{repo}`):
     * 200 with `private: false` is public; 404 or `private: true` is private; anything else
     * (403 rate limit, 401, 5xx, unreachable, timeout, no token) is unknown (null). Asked only for
     * a repository the installations do not cover. A definite answer is kept for
     * {@link VISIBILITY_REFRESH_MS}; an unknown one is not kept, so the next request asks again.
     */
    visibilityFor(userId: string, repo: string): Promise<RepoVisibility | null> {
      const p = profile(userId), key = repo.toLowerCase(), cache = p.visibility
      const cached = cache.get(key)
      if (cached && now() - cached.readAt < VISIBILITY_REFRESH_MS) return cached.answer
      const answer = (async (): Promise<RepoVisibility | null> => {
        const t = await token(userId)
        if (t.kind !== 'token') return null
        try { return await getRepoVisibility(deps.fetch, t.grant.token, repo) }
        catch (error) {
          logger.warn('A repository visibility could not be read', { userId, status: (error as { status?: unknown }).status ?? null })
          return null
        }
      })()
      const entry = { readAt: now(), answer }
      cache.delete(key)
      cache.set(key, entry)
      while (cache.size > VISIBILITY_CACHE_MAX) cache.delete(cache.keys().next().value!)
      // Unknown is not kept: drop the entry once its read settles without an answer.
      void answer.then(v => { if (v === null && cache.get(key) === entry) cache.delete(key) })
      return answer
    },
    /** Check again: read the installations now. */
    async checkAgain(userId: string): Promise<GithubStatusDto> {
      await refreshCoverage(userId)
      return status(userId)
    },

    /**
     * The wrapper found nothing that could authenticate: record what the composer should offer.
     * The profile's own state decides between Sign in and Reconnect; an install need for a
     * repository the cache already covers, or a sign-in need while signed in, is stale and dropped.
     * `chatless`: a run no chat shows hit it (also an Inbox item and an agent-page row).
     */
    async recordNeed(userId: string, kind: 'sign_in' | 'reconnect' | 'install', repoValue: unknown, agentId?: string, chatless: GithubNeedChatless = null): Promise<void> {
      if (!access.available(userId)) return
      const account = await load(userId), p = profile(userId)
      const connected = account?.state === 'connected' && !!account.accessToken
      let changed = false
      if (!connected) {
        changed = needs.recordAccount(userId, account ? 'reconnect' : 'sign_in', agentId, chatless !== null)
      } else if (kind === 'install') {
        const repo = parseRepo(repoValue)
        if (!repo) return
        const coverage = await settledCoverage(p)
        const c = coverage ? coverageOf(coverage.installs, repo) : { answer: 'not_installed' as const }
        if (c.answer === 'covered') return
        changed = needs.recordInstall(userId, repo, installUrlFor(c.answer, c.install), agentId, chatless !== null)
      }
      if (changed) publish(userId)
    },
    /** Hide a need's row; its key is listed in `dismissed` until the need is recorded again or sign-out. */
    dismiss(userId: string, key: string): void { if (needs.dismiss(userId, key)) publish(userId) },

    /** Forget the sign-in on this computer (no revoke: that needs the app's secret). */
    signOut(userId: string): void {
      forgetLocally(userId)
      deps.store.remove(userId)
      logger.info('Signed out of GitHub', { userId })
      publish(userId)
    },
    /** The profile was deleted (its stored record went with it): drop what memory holds. */
    profileRemoved(userId: string): void {
      if (!profiles.has(userId)) return
      forgetLocally(userId)
      profiles.delete(userId)
    }
  }
}
export type GithubAuthService = ReturnType<typeof createGithubAuthService>

export const githubAuthService = createGithubAuthService({
  fetch: (url, init) => runtimeHost.http.fetch(url, init),
  store: githubAccountRepo,
  keystore: {
    secure: () => runtimeHost.keystore.isSecureStorageAvailable(),
    encrypt: async text => (await runtimeHost.keystore.encryptString(text)).toString('base64'),
    decrypt: sealed => runtimeHost.keystore.decryptString(Buffer.from(sealed, 'base64'))
  },
  publish: userId => publishEvent(GITHUB_CHANGED, { userId }, 'all')
})

/** Hook for the managed gh: a sign-in completed. */
export function setGithubSignedInHook(fn: (userId: string) => void): void { githubAuthService.setOnSignedIn(fn) }
/** Hook for the managed gh: the wrapper found no gh. Answers whether a managed gh install is running. */
export function setGithubGhMissingHook(fn: (agentId: string) => Promise<boolean>): void { githubAuthService.setOnGhMissing(fn) }
