import { createLogger } from '../../logger/logger'
import {
  AGENT_DETAILS_FILES,
  MAX_AGENT_DETAILS_BYTES,
  agentDetailsTargetKey,
  type AgentDetailsErrorCode,
  type AgentDetailsResult,
  type AgentDetailsTarget,
  type AgentDetailsView
} from '../../../shared/agentDetails'
import type { AgentFileFailure } from '../../../shared/agentFiles'

const logger = createLogger('agent-details')

/** Cached core answers at once; the oldest is dropped past it. */
export const MAX_AGENT_DETAILS_CACHE = 64

/** HTML documents kept for {@link AgentDetailsService.htmlFor}; the oldest is dropped past it. */
export const MAX_AGENT_DETAILS_HTML = 16

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

export const AGENT_DETAILS_MESSAGES = {
  unsupported: 'Details are not available for this account.',
  notFound: 'This agent has no Details page.',
  unavailable: 'Details could not be loaded. Try again.',
  forbidden: 'Cinna did not let this account read these Details.',
  invalid: 'Nothing to show.',
  locked: 'Unlock the vault to read this agent’s Details.',
  tooLarge: (rel: string) => `${rel} is over 1 MiB.`,
  notUtf8: (rel: string) => `${rel} is not UTF-8 text.`
} as const

export interface AgentDetailsServiceDeps {
  /** The active profile, read when a call names none. */
  profileId: () => string
  /** The profile's Cinna account; null when it is not a Cinna profile with a server. */
  account: (profileId: string) => { serverUrl: string; signedIn: boolean } | null
  /** The discovery document (cached by the caller on success); throws when it cannot be read. */
  discover: (serverUrl: string) => Promise<{ agent_details?: number }>
  /** A GET under the profile's own API whose refusals are data (`cinnaSend`). Throws when no answer came. */
  send: (
    profileId: string,
    path: string,
    opts: { method: 'GET'; headers?: Record<string, string> }
  ) => Promise<{ status: number; body: unknown }>
  /**
   * A reserved file of a folder or vault agent, whole, through the agent-file
   * gate (`agentFileService.readReservedFile`): over `maxBytes` it is `too_large`.
   */
  readLocalFile: (
    agentId: string,
    rel: string,
    maxBytes: number
  ) => Promise<{ success: true; bytes: Buffer } | AgentFileFailure>
  maxCacheEntries?: number
}

/** A core answer, parsed: what the renderer sees, and the HTML that stays here. */
interface Parsed {
  view: AgentDetailsView
  html: string | null
  etag: string
}

type Failure = { ok: false; code: AgentDetailsErrorCode; message: string }

const failure = (code: AgentDetailsErrorCode, message: string): Failure => ({ ok: false, code, message })

/** A target from the renderer, checked; null when it is not one. */
export function parseAgentDetailsTarget(input: unknown): AgentDetailsTarget | null {
  if (!input || typeof input !== 'object') return null
  const raw = input as Record<string, unknown>
  if (raw.kind === 'catalog') {
    if (typeof raw.itemUuid !== 'string' || !UUID.test(raw.itemUuid)) return null
    const revision = raw.revisionNumber
    if (revision === undefined || revision === null) return { kind: 'catalog', itemUuid: raw.itemUuid }
    // `revision_number=0` (or a fraction) is a 422 on core: never sent.
    if (typeof revision !== 'number' || !Number.isInteger(revision) || revision < 1) return null
    return { kind: 'catalog', itemUuid: raw.itemUuid, revisionNumber: revision }
  }
  if (raw.kind === 'agent') {
    if (typeof raw.remoteAgentId !== 'string' || !UUID.test(raw.remoteAgentId)) return null
    return { kind: 'agent', remoteAgentId: raw.remoteAgentId }
  }
  if (raw.kind === 'local') {
    if (typeof raw.agentId !== 'string' || raw.agentId === '' || raw.agentId.length > 512) return null
    return { kind: 'local', agentId: raw.agentId }
  }
  return null
}

/** The core path a remote target reads, query included (the cache key's second half). */
export function agentDetailsPath(target: Exclude<AgentDetailsTarget, { kind: 'local' }>): string {
  if (target.kind === 'agent') return `/api/v1/agents/${encodeURIComponent(target.remoteAgentId)}/details`
  const base = `/api/v1/catalog/items/${encodeURIComponent(target.itemUuid)}/details`
  const revision = target.revisionNumber
  return typeof revision === 'number' && Number.isInteger(revision) && revision >= 1
    ? `${base}?revision_number=${revision}`
    : base
}

/**
 * `AgentDetailsPublic`, checked strictly: the enums, the strings, warnings
 * kept only where they are strings. Anything else is not an answer. The
 * winner is read from `source`/`format` only — `both_present` can come with
 * a markdown or a generated answer.
 */
export function parseAgentDetailsBody(body: unknown): Parsed | null {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return null
  const raw = body as Record<string, unknown>
  const { source, format, content, generated, warnings, etag } = raw
  if (source !== 'custom' && source !== 'generated') return null
  if (format !== 'html' && format !== 'markdown') return null
  // The generated summary is always markdown.
  if (source === 'generated' && format !== 'markdown') return null
  if (typeof content !== 'string') return null
  if (!generated || typeof generated !== 'object' || Array.isArray(generated)) return null
  const summary = generated as Record<string, unknown>
  if (summary.format !== 'markdown' || typeof summary.content !== 'string') return null
  if (!Array.isArray(warnings)) return null
  if (typeof etag !== 'string' || etag === '') return null
  const revision = raw.revision_number
  if (revision !== null && (typeof revision !== 'number' || !Number.isFinite(revision))) return null
  return {
    view: {
      source,
      format,
      markdown: format === 'markdown' ? content : null,
      generated: summary.content,
      warnings: warnings.filter((warning): warning is string => typeof warning === 'string'),
      revisionNumber: revision as number | null
    },
    html: format === 'html' ? content : null,
    etag
  }
}

/** A file's text when it is usable as a Details file; the C1 reason when it is not. */
function decodeDetailsFile(bytes: Buffer): { text: string } | { warning: 'invalid_encoding' } | null {
  let text: string
  try {
    text = new TextDecoder('utf-8', { fatal: true }).decode(bytes)
  } catch {
    return { warning: 'invalid_encoding' }
  }
  // Whitespace only counts as absent, as on core.
  if (text.trim() === '') return null
  return { text }
}

/** Keeps at most `max` entries, dropping the oldest inserted first. */
function remember<V>(map: Map<string, V>, key: string, value: V, max: number): void {
  map.delete(key)
  map.set(key, value)
  while (map.size > max) {
    const oldest = map.keys().next().value
    if (oldest === undefined) break
    map.delete(oldest)
  }
}

/**
 * Agent Details (hub core): an agent's readable capabilities page, read from
 * core for a catalog item or a Cinna agent, or from a folder agent's own
 * `docs/AGENT_DETAILS.html` / `.md` (D6: no generator here).
 *
 * Core answers are cached per profile and URL with their ETag and revalidated
 * with `If-None-Match` (a 304 has no body). The publisher's HTML stays in main:
 * the renderer gets the markdown, the generated summary and the facts, and
 * asks {@link htmlFor} — through the frame server — to show the HTML. Every
 * failure is data: `unsupported` and `not_found` hide the Details button,
 * `unavailable` keeps it and says so.
 */
export function createAgentDetailsService(deps: AgentDetailsServiceDeps) {
  const maxCache = deps.maxCacheEntries ?? MAX_AGENT_DETAILS_CACHE
  const cache = new Map<string, Parsed>()
  /** The last HTML read per `${profileId}|${target key}`, for the frame. */
  const lastHtml = new Map<string, string>()

  async function supported(profileId: string): Promise<boolean> {
    const account = deps.account(profileId)
    if (!account || !account.signedIn || !account.serverUrl) return false
    try {
      const endpoints = await deps.discover(account.serverUrl)
      return typeof endpoints.agent_details === 'number' && endpoints.agent_details >= 1
    } catch {
      // Not remembered: the next call asks again (the discovery cache keeps successes only).
      return false
    }
  }

  async function getRemote(
    profileId: string,
    target: Exclude<AgentDetailsTarget, { kind: 'local' }>
  ): Promise<{ ok: true; parsed: Parsed } | Failure> {
    if (!(await supported(profileId))) return failure('unsupported', AGENT_DETAILS_MESSAGES.unsupported)
    const path = agentDetailsPath(target)
    const key = `${profileId}|${path}`
    const cached = cache.get(key)
    let answer: { status: number; body: unknown }
    try {
      answer = await deps.send(profileId, path, {
        method: 'GET',
        ...(cached ? { headers: { 'If-None-Match': cached.etag } } : {})
      })
    } catch (err) {
      logger.warn('reading agent details failed', { kind: target.kind, error: err instanceof Error ? err.name : 'unknown' })
      return failure('unavailable', AGENT_DETAILS_MESSAGES.unavailable)
    }
    if (answer.status === 304) {
      if (cached) {
        remember(cache, key, cached, maxCache)
        return { ok: true, parsed: cached }
      }
      return failure('unavailable', AGENT_DETAILS_MESSAGES.unavailable)
    }
    if (answer.status === 404) {
      cache.delete(key)
      return failure('not_found', AGENT_DETAILS_MESSAGES.notFound)
    }
    if (answer.status !== 200) {
      logger.info('core refused agent details', { kind: target.kind, status: answer.status })
      return failure('unavailable', answer.status === 403 ? AGENT_DETAILS_MESSAGES.forbidden : AGENT_DETAILS_MESSAGES.unavailable)
    }
    const parsed = parseAgentDetailsBody(answer.body)
    if (!parsed) {
      logger.warn('core answered agent details in an unknown shape', { kind: target.kind })
      return failure('unavailable', AGENT_DETAILS_MESSAGES.unavailable)
    }
    remember(cache, key, parsed, maxCache)
    return { ok: true, parsed }
  }

  /** C1 over the folder's two reserved files; read again on every call. */
  async function getLocal(agentId: string): Promise<{ ok: true; parsed: Omit<Parsed, 'etag'> } | Failure> {
    const warnings: string[] = []
    const usable: Array<{ rel: string; text: string } | null> = []
    let failed = false
    /** The first file that exists but cannot be shown, and why: the hint when nothing else is usable. */
    let unusable: string | null = null
    for (const rel of AGENT_DETAILS_FILES) {
      const read = await deps.readLocalFile(agentId, rel, MAX_AGENT_DETAILS_BYTES)
      if (!read.success) {
        if (read.code === 'agent_not_found' || read.code === 'unsupported' || read.code === 'invalid_input') {
          return failure('not_found', AGENT_DETAILS_MESSAGES.notFound)
        }
        if (read.code === 'locked') return failure('unavailable', AGENT_DETAILS_MESSAGES.locked)
        if (read.code === 'too_large') {
          warnings.push('too_large')
          unusable ??= AGENT_DETAILS_MESSAGES.tooLarge(rel)
        } else if (read.code !== 'not_found' && read.code !== 'not_a_file' && read.code !== 'credential_file') failed = true
        usable.push(null)
        continue
      }
      const decoded = decodeDetailsFile(read.bytes)
      if (decoded && 'warning' in decoded) {
        warnings.push(decoded.warning)
        unusable ??= AGENT_DETAILS_MESSAGES.notUtf8(rel)
      }
      usable.push(decoded && 'text' in decoded ? { rel, text: decoded.text } : null)
    }
    const [html, markdown] = usable
    if (html && markdown) warnings.unshift('both_present')
    const winner = html ?? markdown
    if (!winner) {
      // A file that is there but cannot be shown keeps the button, so its builder learns why.
      if (unusable !== null) return failure('unavailable', unusable)
      return failed ? failure('unavailable', AGENT_DETAILS_MESSAGES.unavailable) : failure('not_found', AGENT_DETAILS_MESSAGES.notFound)
    }
    const isHtml = winner === html
    return {
      ok: true,
      parsed: {
        view: {
          source: 'custom',
          format: isHtml ? 'html' : 'markdown',
          markdown: isHtml ? null : winner.text,
          generated: null,
          warnings,
          revisionNumber: null
        },
        html: isHtml ? winner.text : null
      }
    }
  }

  async function read(
    targetInput: unknown,
    profileId: string
  ): Promise<{ ok: true; target: AgentDetailsTarget; parsed: Omit<Parsed, 'etag'> } | Failure> {
    const target = parseAgentDetailsTarget(targetInput)
    // Not a target at all: nothing to show, so no button.
    if (!target) return failure('not_found', AGENT_DETAILS_MESSAGES.invalid)
    const result = target.kind === 'local' ? await getLocal(target.agentId) : await getRemote(profileId, target)
    const htmlKey = `${profileId}|${agentDetailsTargetKey(target)}`
    // Any failure forgets the page, so a frame never serves one core has revoked.
    if (!result.ok) {
      lastHtml.delete(htmlKey)
      return result
    }
    if (result.parsed.html !== null) remember(lastHtml, htmlKey, result.parsed.html, MAX_AGENT_DETAILS_HTML)
    else lastHtml.delete(htmlKey)
    return { ok: true, target, parsed: result.parsed }
  }

  return {
    /** The Details of a target, for the renderer: never the HTML itself. */
    async get(targetInput: unknown, opts: { profileId?: string } = {}): Promise<AgentDetailsResult> {
      const profileId = opts.profileId ?? deps.profileId()
      const result = await read(targetInput, profileId)
      if (!result.ok) return result
      return { ok: true, details: result.parsed.view }
    },

    /**
     * The publisher's HTML for a target, to register with the frame server:
     * the copy the last {@link get} read, or read again when there is none.
     * Not an HTML answer is `not_found`.
     */
    async htmlFor(
      targetInput: unknown,
      profileId: string = deps.profileId()
    ): Promise<{ ok: true; html: string } | Failure> {
      const target = parseAgentDetailsTarget(targetInput)
      if (!target) return failure('not_found', AGENT_DETAILS_MESSAGES.invalid)
      const kept = lastHtml.get(`${profileId}|${agentDetailsTargetKey(target)}`)
      if (kept !== undefined) return { ok: true, html: kept }
      const result = await read(target, profileId)
      if (!result.ok) return result
      if (result.parsed.html === null) return failure('not_found', AGENT_DETAILS_MESSAGES.notFound)
      return { ok: true, html: result.parsed.html }
    },

    /** Cached core answers (tests). */
    cacheSize(): number {
      return cache.size
    }
  }
}

export type AgentDetailsService = ReturnType<typeof createAgentDetailsService>
