import { SPEECH_STATUS_CHANGED_CHANNEL, type SpeechRelayStatus, type SpeechRelayUsageResult } from '../../shared/speech'
import { createLogger } from '../logger/logger'

const logger = createLogger('speech-core')

/** A discovery answer older than this is read again, in the background, on the next status read. */
export const RELAY_ACCESS_TTL_MS = 5 * 60_000

/** The active profile's Cinna account, as far as the relay needs it. */
export interface RelayAccount {
  /** Trailing slash stripped. */
  serverUrl: string
  /** Holds tokens (it may still need a refresh). */
  signedIn: boolean
}

export interface CoreRelayAccessDeps {
  /** The active profile, or null before one is activated. */
  profileId(): string | null
  /** A `cinna_user` profile with a server URL; null for any other. */
  account(profileId: string): RelayAccount | null
  /** The server's discovery document, read fresh: not the OAuth path's session-long cache. */
  discover(serverUrl: string): Promise<unknown>
  /** `GET /api/v1/speech/usage` as the profile. */
  fetchUsage(profileId: string): Promise<unknown>
  publishEvent(channel: string, payload: unknown): void
  now(): number
  ttlMs: number
}

/** Where a session goes, for the engine. */
export interface RelayEndpoint {
  profileId: string
  serverUrl: string
  url: string
  serverName: string
}

/** What one discovery read said about the relay. */
export type RelayDiscovery =
  | { available: true; url: string; serverName: string }
  | { available: false; serverName: string }

function isLoopback(hostname: string): boolean {
  return hostname === 'localhost' || hostname === '127.0.0.1' || hostname === '[::1]' || hostname === '::1'
}

/**
 * The `voice_transcription` block of a discovery document (protocol v1):
 * available only with `version === 1` and a `ws(s)://` URL. A plain `ws://`
 * URL is accepted only where the server itself is plain http or loopback, so
 * the access token never goes unencrypted to a server reached over TLS.
 */
export function parseRelayDiscovery(document: unknown, serverUrl: string): RelayDiscovery {
  const doc = document && typeof document === 'object' ? document as Record<string, unknown> : {}
  const instanceName = typeof doc.instance_name === 'string' ? doc.instance_name.trim() : ''
  let serverName = instanceName
  if (!serverName) {
    try {
      serverName = new URL(serverUrl).host
    } catch {
      serverName = serverUrl
    }
  }
  const block = doc.voice_transcription
  if (!block || typeof block !== 'object') return { available: false, serverName }
  const relay = block as Record<string, unknown>
  if (relay.version !== 1 || typeof relay.url !== 'string') return { available: false, serverName }
  let url: URL
  try {
    url = new URL(relay.url)
  } catch {
    return { available: false, serverName }
  }
  if (url.protocol === 'ws:') {
    let server: URL | null = null
    try {
      server = new URL(serverUrl)
    } catch {
      server = null
    }
    if (!isLoopback(url.hostname) && server?.protocol !== 'http:') return { available: false, serverName }
  } else if (url.protocol !== 'wss:') {
    return { available: false, serverName }
  }
  return { available: true, url: url.toString(), serverName }
}

interface Answer {
  available: boolean
  serverName: string
  url?: string
  checkedAt: number
}

function usageMessage(serverName: string): string {
  return `Could not read this month's dictation from ${serverName}.`
}

/**
 * Whether the active profile's Cinna server offers voice transcription. Kept
 * per (profile, server) and never awaited by a status read: `status()` answers
 * the last known reading and, when it is older than the TTL (or missing), asks
 * again in the background. `refresh()` reads now (profile ready or switched, a
 * `disabled` answer). A change of what `status()` says is published, so every
 * window refetches `speech:status`.
 */
export function createCoreRelayAccess(deps: CoreRelayAccessDeps): {
  status(): SpeechRelayStatus
  endpoint(): RelayEndpoint | null
  refresh(): Promise<SpeechRelayStatus>
  usage(): Promise<SpeechRelayUsageResult>
} {
  const answers = new Map<string, Answer>()
  const inflight = new Map<string, Promise<void>>()
  let published = JSON.stringify({ available: false })

  function context(): { profile: string; account: RelayAccount; key: string } | null {
    let profile: string | null
    try {
      profile = deps.profileId()
    } catch {
      return null
    }
    if (!profile) return null
    let account: RelayAccount | null
    try {
      account = deps.account(profile)
    } catch {
      return null
    }
    if (!account || !account.signedIn || !account.serverUrl) return null
    return { profile, account, key: `${profile}\n${account.serverUrl}` }
  }

  function current(): SpeechRelayStatus {
    const ctx = context()
    const answer = ctx ? answers.get(ctx.key) : undefined
    return answer?.available ? { available: true, serverName: answer.serverName } : { available: false }
  }

  function publishIfChanged(): void {
    const next = JSON.stringify(current())
    if (next === published) return
    published = next
    deps.publishEvent(SPEECH_STATUS_CHANGED_CHANNEL, {})
  }

  function read(key: string, serverUrl: string): Promise<void> {
    const running = inflight.get(key)
    if (running) return running
    const reading = deps.discover(serverUrl).then(
      (document) => {
        const found = parseRelayDiscovery(document, serverUrl)
        const before = answers.get(key)
        answers.set(key, { ...found, checkedAt: deps.now() })
        if (before?.available !== found.available) {
          logger.info('voice transcription relay availability', { available: found.available, host: hostOf(serverUrl) })
        }
      },
      (err: unknown) => {
        // A transient failure keeps what was known, and waits a TTL before asking again.
        const before = answers.get(key)
        answers.set(key, before ? { ...before, checkedAt: deps.now() } : { available: false, serverName: hostOf(serverUrl), checkedAt: deps.now() })
        logger.warn('could not read the server discovery for voice transcription', { host: hostOf(serverUrl), error: err instanceof Error ? err.message : String(err) })
      }
    ).finally(() => {
      inflight.delete(key)
      publishIfChanged()
    })
    inflight.set(key, reading)
    return reading
  }

  return {
    status() {
      const ctx = context()
      if (ctx) {
        const answer = answers.get(ctx.key)
        if (!answer || deps.now() - answer.checkedAt >= deps.ttlMs) void read(ctx.key, ctx.account.serverUrl)
      }
      // A sign-out or a profile switch can change the answer without a read.
      publishIfChanged()
      return current()
    },
    endpoint() {
      const ctx = context()
      const answer = ctx ? answers.get(ctx.key) : undefined
      if (!ctx || !answer?.available || !answer.url) return null
      return { profileId: ctx.profile, serverUrl: ctx.account.serverUrl, url: answer.url, serverName: answer.serverName }
    },
    async refresh() {
      const ctx = context()
      if (ctx) await read(ctx.key, ctx.account.serverUrl)
      else publishIfChanged()
      return current()
    },
    async usage() {
      const ctx = context()
      if (!ctx) return { ok: false, message: 'Sign in to a Cinna server to see its dictation minutes.' }
      const serverName = answers.get(ctx.key)?.serverName ?? hostOf(ctx.account.serverUrl)
      let body: unknown
      try {
        body = await deps.fetchUsage(ctx.profile)
      } catch (err) {
        logger.warn('could not read the voice transcription usage', { host: hostOf(ctx.account.serverUrl), error: err instanceof Error ? err.message : String(err) })
        return { ok: false, message: usageMessage(serverName) }
      }
      const usage = body && typeof body === 'object' ? body as Record<string, unknown> : null
      if (!usage || typeof usage.enabled !== 'boolean' || typeof usage.used_seconds !== 'number' || !(usage.cap_seconds === null || typeof usage.cap_seconds === 'number')) {
        return { ok: false, message: usageMessage(serverName) }
      }
      return {
        ok: true,
        enabled: usage.enabled,
        usedSeconds: usage.used_seconds,
        capSeconds: usage.cap_seconds as number | null,
        periodEnd: typeof usage.period_end === 'string' ? usage.period_end : ''
      }
    }
  }
}

function hostOf(url: string): string {
  try {
    return new URL(url).host
  } catch {
    return 'invalid-url'
  }
}
