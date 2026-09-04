import type { JobDepDescriptor, McpTransport } from '../../shared/sync'
import type { McpProviderRow } from '../db/mcpProviders'
import type { AgentRow } from '../db/agents'
import {
  FOLDER_AGENT_ID_PREFIX,
  FOLDER_AGENT_SOURCE,
  isFolderAgentId
} from '../../shared/localAgents'

/**
 * Portable-identity normalizers (plan: data-sync-portable-deps §3).
 *
 * Pinned here so the *encode* side (building descriptors from local rows) and
 * the *resolve* side (matching descriptors against local rows / auto-creating)
 * agree byte-for-byte. The identity key answers "what this dependency *is*",
 * never "what row id it happens to have here" — two devices independently
 * derive the same key for the same logical dependency, which is what makes the
 * synced manifest stable across a round trip.
 *
 * Keys are computed locally and never transmitted; descriptors carry only the
 * raw fields a peer needs to re-derive the key and, on a miss, auto-create.
 */

/**
 * Conservative URL normalization: lowercase scheme + host, drop the default
 * port, strip a trailing slash and fragment — but KEEP path + query (MCP
 * endpoints are path-significant, so stripping them would fuse distinct
 * servers). Falls back to a trimmed/lowercased string for un-parseable input.
 */
export function normalizeUrl(raw: string | null | undefined): string {
  if (!raw) return ''
  let u: URL
  try {
    u = new URL(raw)
  } catch {
    return raw.trim().toLowerCase().replace(/\/+$/, '')
  }
  const scheme = u.protocol.toLowerCase() // includes trailing ':'
  const isDefaultPort =
    (scheme === 'http:' && u.port === '80') || (scheme === 'https:' && u.port === '443')
  const port = !u.port || isDefaultPort ? '' : `:${u.port}`
  const host = u.hostname.toLowerCase()
  const path = u.pathname.replace(/\/+$/, '') // strip trailing slash, keep path
  return `${scheme}//${host}${port}${path}${u.search}`
}

/** Identity key for an MCP descriptor. */
export function mcpIdentityKey(d: Extract<JobDepDescriptor, { kind: 'mcp' }>): string {
  if (d.transport === 'stdio') {
    return `stdio|${d.command ?? ''}|${JSON.stringify(d.args ?? [])}`
  }
  return `${d.transport}|${normalizeUrl(d.url)}`
}

/**
 * Identity key for an agent descriptor.
 *
 * Written as an exhaustive switch on `source` rather than
 * `if (remote) … else <local>`: the `else` form typechecks against a *new*
 * union member and quietly keys it as a local agent, which is how a folder
 * descriptor would have been asked for under a `local|` key that can never
 * exist. A missing case here is a compile error instead.
 */
export function agentIdentityKey(d: Extract<JobDepDescriptor, { kind: 'agent' }>): string {
  switch (d.source) {
    case 'remote':
      return `remote|${d.remoteTargetType}|${d.remoteTargetId}`
    case 'local':
      return `local|${normalizeUrl(d.cardUrl)}`
    case 'folder':
      // Exact, not normalized: this is an opaque id from `cinna-agent.json`,
      // not a URL, and two folders that differ only in case are two folders.
      return `folder|${d.manifestId}`
  }
}

/** Normalized chat-mode name used for cross-device matching. */
export function modeKey(name: string): string {
  return name.trim().toLowerCase()
}

// ---- row → descriptor -----------------------------------------------------

/** Build a portable MCP descriptor from a local `mcp_providers` row. */
export function mcpRowToDescriptor(
  row: McpProviderRow
): Extract<JobDepDescriptor, { kind: 'mcp' }> {
  return {
    kind: 'mcp',
    transport: row.transportType as McpTransport,
    url: row.url ?? null,
    command: row.command ?? null,
    args: row.args ?? null,
    name: row.name,
    // env *keys* only — never values (secrets stay machine-local).
    envKeys: row.env ? Object.keys(row.env) : undefined
  }
}

/**
 * Build a portable agent descriptor from a local `agents` row. Returns null
 * when the row lacks the field that gives it portable identity (a remote agent
 * without a backend UUID, or a local agent with no card/endpoint URL).
 *
 * The folder branch has to sit **above** the `cardUrl ?? endpointUrl` fallback,
 * not below it: a folder agent has both columns null by construction, so a
 * branch placed after that check is dead code and the row returns null — which
 * dropped the dependency from the manifest entirely and let the peer run the
 * job as a plain-LLM chat, reporting success with the agent missing.
 */
export function agentRowToDescriptor(
  row: AgentRow,
  serverUrl?: string | null
): Extract<JobDepDescriptor, { kind: 'agent' }> | null {
  if (row.source === 'remote') {
    if (!row.remoteTargetType || !row.remoteTargetId) return null
    return {
      kind: 'agent',
      source: 'remote',
      remoteTargetType: row.remoteTargetType,
      remoteTargetId: row.remoteTargetId,
      serverUrl: serverUrl ?? null,
      name: row.name
    }
  }
  if (row.source === FOLDER_AGENT_SOURCE) {
    // The row id is `folder:<manifest id>`; the manifest id is what crosses
    // devices, so the prefix — which is this desktop's own row-keying scheme —
    // is stripped rather than transmitted.
    const manifestId = isFolderAgentId(row.id)
      ? row.id.slice(FOLDER_AGENT_ID_PREFIX.length)
      : ''
    if (!manifestId) return null
    return { kind: 'agent', source: 'folder', manifestId, name: row.name }
  }
  const cardUrl = row.cardUrl ?? row.endpointUrl
  if (!cardUrl) return null
  return { kind: 'agent', source: 'local', cardUrl, name: row.name }
}
