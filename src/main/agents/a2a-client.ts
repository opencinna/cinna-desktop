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
  type A2AClientOptions,
  type A2AStreamEventData,
  type SendMessageResult
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

export type {
  AgentCard,
  AgentSkill,
  Message,
  Task,
  TaskStatusUpdateEvent,
  TaskArtifactUpdateEvent,
  A2AStreamEventData,
  SendMessageResult
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
 * Fetch the raw agent card JSON from a URL.
 */
async function fetchRawCard(
  cardUrl: string,
  accessToken?: string
): Promise<Record<string, unknown>> {
  const resolvedUrl = resolveCardUrl(cardUrl)
  const fetchImpl = accessToken ? buildAuthFetch(accessToken) : fetch
  const response = await fetchImpl(resolvedUrl, {
    headers: { Accept: 'application/json' }
  })
  if (!response.ok) {
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
  const opts: A2AClientOptions = {}
  if (accessToken) {
    opts.fetchImpl = buildAuthFetch(accessToken)
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

/**
 * Extract text content from a task or message result.
 */
export function extractTextFromResult(result: SendMessageResult | A2AStreamEventData): string {
  if ('kind' in result) {
    if (result.kind === 'message') {
      return extractTextFromParts((result as Message).parts)
    }
    if (result.kind === 'task') {
      const task = result as Task
      // Try artifacts first, then status message
      if (task.artifacts?.length) {
        return task.artifacts.map((a) => extractTextFromParts(a.parts)).join('\n')
      }
      if (task.status?.message) {
        return extractTextFromParts(task.status.message.parts)
      }
      return ''
    }
    if (result.kind === 'status-update') {
      const su = result as TaskStatusUpdateEvent
      if (su.status?.message) {
        return extractTextFromParts(su.status.message.parts)
      }
      return ''
    }
    if (result.kind === 'artifact-update') {
      const au = result as TaskArtifactUpdateEvent
      return extractTextFromParts(au.artifact.parts)
    }
  }
  return ''
}

function extractTextFromParts(parts: Array<{ kind: string; text?: string }>): string {
  return parts
    .filter((p) => p.kind === 'text' && p.text)
    .map((p) => p.text!)
    .join('')
}
