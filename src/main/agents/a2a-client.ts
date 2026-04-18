/**
 * A2A Protocol client wrapper using @a2a-js/sdk (v0.3.x).
 *
 * The SDK speaks protocol v0.3. When a remote agent card advertises only v1.0,
 * we look for a 0.3.x-compatible entry in `supportedInterfaces` and use its URL
 * to talk to the agent. If the card already has a top-level `url` (v0.3 style),
 * we use it directly.
 */
import {
  A2AClient,
  type A2AClientOptions
} from '@a2a-js/sdk/client'
import type {
  AgentCard,
  AgentSkill,
  Message,
  MessageSendParams,
  Task,
  TaskStatusUpdateEvent,
  TaskArtifactUpdateEvent
} from '@a2a-js/sdk'
import { AGENT_CARD_PATH } from '@a2a-js/sdk'
import { nanoid } from 'nanoid'
import { createLogger } from '../logger/logger'

const logger = createLogger('a2a-client')

export type {
  AgentCard,
  AgentSkill,
  Message,
  Task,
  TaskStatusUpdateEvent,
  TaskArtifactUpdateEvent
}

/** The protocol version family our SDK supports. */
const SUPPORTED_PROTOCOL_PREFIX = '0.3'

/** Shape of a supportedInterfaces entry in a v1.0 agent card. */
interface SupportedInterface {
  url: string
  protocolBinding?: string
  protocolVersion?: string
  transport?: string
}

/** Result of resolving protocol compatibility from an agent card. */
export interface ProtocolResolution {
  /** The URL to use for communication. */
  url: string
  /** The matched protocol version string (e.g. "0.3.0"). */
  version: string
}

/**
 * Resolve the agent card URL from a user-provided URL.
 */
function resolveCardUrl(cardUrl: string): string {
  const url = cardUrl.trim().replace(/\/$/, '')
  return url.endsWith('.json') ? url : `${url}/${AGENT_CARD_PATH}`
}

/**
 * Build a fetch function that injects a Bearer token.
 */
function buildAuthFetch(accessToken: string): typeof fetch {
  return (input, init) => {
    const headers = new Headers(init?.headers)
    headers.set('Authorization', `Bearer ${accessToken}`)
    return fetch(input, { ...init, headers })
  }
}

/**
 * Convert a low-level fetch/SDK error into a user-facing message.
 *
 * The Node undici client throws `TypeError: terminated` when a keep-alive
 * socket closes mid-request (remote crash, idle/LB timeout, network drop).
 * That message tells the user nothing — so we translate the common network
 * patterns into something actionable and fall back to the raw message.
 */
export function humanizeA2AError(err: unknown): string {
  if (err == null) return 'Unknown error'
  const message = err instanceof Error ? err.message : String(err)
  const cause = err instanceof Error && err.cause && typeof err.cause === 'object'
    ? (err.cause as { code?: string; message?: string })
    : undefined
  const code = cause?.code
  const haystack = `${message} ${cause?.message ?? ''}`.toLowerCase()

  if (haystack.includes('terminated') || haystack.includes('socket hang up')) {
    return 'Agent connection closed unexpectedly (server disconnected mid-response).'
  }
  if (code === 'ECONNREFUSED' || haystack.includes('econnrefused')) {
    return 'Could not reach agent (connection refused).'
  }
  if (code === 'ENOTFOUND' || haystack.includes('enotfound')) {
    return 'Could not reach agent (host not found).'
  }
  if (code === 'ETIMEDOUT' || haystack.includes('etimedout')) {
    return 'Agent connection timed out.'
  }
  if (code === 'ECONNRESET' || haystack.includes('econnreset')) {
    return 'Agent connection was reset.'
  }
  if (code === 'UND_ERR_SOCKET' || haystack.includes('other side closed')) {
    return 'Agent connection closed by server.'
  }

  return message
}

/**
 * Wrap a fetch implementation to log every A2A HTTP request and response
 * at DEBUG level. For SSE responses (content-type: text/event-stream), the
 * body is tee'd so that each chunk is logged as it arrives without
 * disturbing the consumer's stream.
 *
 * This is the source of truth for "what did the server send" — it sits
 * below the SDK's parsing layer, so missing data here = server-side issue.
 */
function buildLoggingFetch(base: typeof fetch): typeof fetch {
  return async (input, init) => {
    const url =
      typeof input === 'string'
        ? input
        : input instanceof URL
          ? input.toString()
          : input.url
    const method = (init?.method ?? 'GET').toUpperCase()

    let reqBody: unknown = undefined
    if (typeof init?.body === 'string') {
      try {
        reqBody = JSON.parse(init.body)
      } catch {
        reqBody = init.body
      }
    }
    logger.debug(`HTTP → ${method} ${url}`, { body: reqBody })

    let response: Response
    try {
      response = await base(input, init)
    } catch (err) {
      logger.error(`HTTP ✗ ${method} ${url}`, { error: String(err) })
      throw err
    }

    const contentType = response.headers.get('content-type') ?? ''

    if (contentType.includes('text/event-stream') && response.body) {
      logger.debug(`HTTP ← ${response.status} ${url} (SSE stream opened)`, {
        contentType
      })
      const [forLog, forConsumer] = response.body.tee()
      void (async () => {
        const reader = forLog.getReader()
        const decoder = new TextDecoder()
        let chunkIndex = 0
        try {
          while (true) {
            const { value, done } = await reader.read()
            if (done) {
              logger.debug(`SSE stream closed after ${chunkIndex} chunk(s) | ${url}`)
              return
            }
            const chunk = decoder.decode(value, { stream: true })
            logger.debug(`SSE chunk #${chunkIndex++} | ${url}`, { chunk })
          }
        } catch (err) {
          logger.warn(`SSE stream ended with error after ${chunkIndex} chunk(s) | ${url}`, {
            error: String(err),
            reason: humanizeA2AError(err)
          })
        }
      })()
      return new Response(forConsumer, {
        status: response.status,
        statusText: response.statusText,
        headers: response.headers
      })
    }

    const clone = response.clone()
    let resBody: unknown = undefined
    try {
      const text = await clone.text()
      try {
        resBody = JSON.parse(text)
      } catch {
        resBody = text
      }
    } catch (err) {
      resBody = { readError: String(err) }
    }
    logger.debug(`HTTP ← ${response.status} ${url}`, { body: resBody })
    return response
  }
}

/**
 * Fetch the raw agent card JSON from a URL.
 */
async function fetchRawCard(
  cardUrl: string,
  accessToken?: string
): Promise<Record<string, unknown>> {
  const resolvedUrl = resolveCardUrl(cardUrl)
  logger.debug(`GET ${resolvedUrl}`, { authenticated: !!accessToken })
  const fetchImpl = buildLoggingFetch(accessToken ? buildAuthFetch(accessToken) : fetch)
  let response: Response
  try {
    response = await fetchImpl(resolvedUrl, {
      headers: { Accept: 'application/json' }
    })
  } catch (err) {
    logger.error(`Network error fetching ${resolvedUrl}`, { error: String(err) })
    throw err
  }
  if (!response.ok) {
    const body = await response.text().catch(() => '')
    logger.error(`HTTP ${response.status} ${response.statusText} from ${resolvedUrl}`, {
      body: body.slice(0, 2000)
    })
    throw new Error(
      `Failed to fetch Agent Card from ${resolvedUrl}: ${response.status} ${response.statusText}`
    )
  }
  return (await response.json()) as Record<string, unknown>
}

/**
 * Check if the card already has a top-level `url` (v0.3 compatible).
 */
function hasTopLevelUrl(card: Record<string, unknown>): card is Record<string, unknown> & { url: string } {
  return typeof card.url === 'string' && card.url.length > 0
}

/**
 * Find a 0.3.x-compatible interface from `supportedInterfaces`.
 * Returns the URL and matched version, or null if none found.
 */
function findCompatibleInterface(card: Record<string, unknown>): ProtocolResolution | null {
  const interfaces = card.supportedInterfaces as SupportedInterface[] | undefined
  if (!Array.isArray(interfaces)) return null

  for (const iface of interfaces) {
    if (
      iface.url &&
      typeof iface.protocolVersion === 'string' &&
      iface.protocolVersion.startsWith(SUPPORTED_PROTOCOL_PREFIX)
    ) {
      return { url: iface.url, version: iface.protocolVersion }
    }
  }
  return null
}

/**
 * Resolve protocol compatibility from a raw agent card.
 *
 * - If the card has a top-level `url`, it's v0.3 compatible — use as-is.
 * - Otherwise, scan `supportedInterfaces` for a 0.3.x entry.
 * - If neither works, throw with a clear error.
 */
export function resolveProtocol(card: Record<string, unknown>): ProtocolResolution {
  // Card already has top-level url — v0.3 compatible
  if (hasTopLevelUrl(card)) {
    // Try to figure out the version from protocolVersion or protocolVersions
    const version =
      typeof card.protocolVersion === 'string'
        ? card.protocolVersion
        : Array.isArray(card.protocolVersions)
          ? (card.protocolVersions as string[]).find((v) => v.startsWith(SUPPORTED_PROTOCOL_PREFIX)) ??
            (card.protocolVersions as string[])[0] ?? SUPPORTED_PROTOCOL_PREFIX
          : SUPPORTED_PROTOCOL_PREFIX
    return { url: card.url, version }
  }

  // Look for a compatible interface
  const compatible = findCompatibleInterface(card)
  if (compatible) {
    return compatible
  }

  // List what versions the agent does support for a helpful error
  const versions = Array.isArray(card.protocolVersions)
    ? (card.protocolVersions as string[]).join(', ')
    : 'unknown'
  logger.error(`No compatible protocol in agent card`, {
    supportedVersions: versions,
    supportedInterfaces: card.supportedInterfaces,
    topLevelUrl: card.url ?? null
  })
  throw new Error(
    `Agent does not support A2A protocol v0.3.x (our SDK version). ` +
    `Agent supports: ${versions}. ` +
    `No compatible interface found in supportedInterfaces.`
  )
}

/**
 * Fetch and validate an agent card from a URL.
 * Resolves protocol compatibility and patches the card for our SDK.
 *
 * Returns the card (with `url` set for SDK compatibility) and the protocol resolution info.
 */
export async function fetchAgentCard(
  cardUrl: string,
  accessToken?: string
): Promise<{ card: AgentCard; protocol: ProtocolResolution }> {
  const rawCard = await fetchRawCard(cardUrl, accessToken)
  const protocol = resolveProtocol(rawCard)

  // Patch the card with the resolved URL so the SDK can use it
  rawCard.url = protocol.url

  // The SDK also requires `protocolVersion` (singular) for v0.3
  if (!rawCard.protocolVersion && typeof protocol.version === 'string') {
    rawCard.protocolVersion = protocol.version
  }

  // SDK requires skills to be an array
  if (!Array.isArray(rawCard.skills)) {
    rawCard.skills = []
  }

  return { card: rawCard as unknown as AgentCard, protocol }
}

/**
 * Create an A2A client from a resolved endpoint URL + optional token.
 * Uses the endpoint URL directly (already resolved from protocol negotiation).
 */
export async function createA2AClient(
  endpointUrl: string,
  cardUrl: string,
  accessToken?: string
): Promise<A2AClient> {
  const opts: A2AClientOptions = {
    fetchImpl: buildLoggingFetch(accessToken ? buildAuthFetch(accessToken) : fetch)
  }

  // Fetch the raw card and patch it with the resolved endpoint URL
  const rawCard = await fetchRawCard(cardUrl, accessToken)
  rawCard.url = endpointUrl
  if (!rawCard.protocolVersion) {
    rawCard.protocolVersion = SUPPORTED_PROTOCOL_PREFIX
  }
  if (!Array.isArray(rawCard.skills)) {
    rawCard.skills = []
  }

  return new A2AClient(rawCard as unknown as AgentCard, opts)
}

/**
 * Build a MessageSendParams object for sending text to an A2A agent.
 */
export function buildSendParams(
  content: string,
  contextId?: string,
  taskId?: string
): MessageSendParams {
  return {
    message: {
      kind: 'message',
      messageId: nanoid(),
      role: 'user',
      parts: [{ kind: 'text', text: content }],
      ...(contextId && { contextId }),
      ...(taskId && { taskId })
    },
    configuration: {
      acceptedOutputModes: ['text/plain', 'application/json']
    }
  }
}

