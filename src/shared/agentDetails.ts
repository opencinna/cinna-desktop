/**
 * Agent Details: an agent's readable capabilities page (kit contract 1.28.0,
 * core `AgentDetailsPublic`). Core is the only producer; the desktop renders.
 *
 * The renderer never receives the publisher's HTML: main keeps it and serves
 * it in a sandboxed `cinna-preview://det-…/` frame on request
 * (`agent-details:open-frame`). Markdown is returned as text and rendered with
 * raw HTML off.
 */

/** Which agent's Details to read. */
export type AgentDetailsTarget =
  /** A catalog item before install; the latest version unless a revision is named. */
  | { kind: 'catalog'; itemUuid: string; revisionNumber?: number }
  /** An installed or own Cinna agent, by its core agent id (the remote row's `remoteTargetId`). */
  | { kind: 'agent'; remoteAgentId: string }
  /** A folder (or vault) agent on this computer: only its own `docs/AGENT_DETAILS.*` file. */
  | { kind: 'local'; agentId: string }

export type AgentDetailsSource = 'custom' | 'generated'
export type AgentDetailsFormat = 'html' | 'markdown'

/** What the renderer is given: never the raw HTML. */
export interface AgentDetailsView {
  source: AgentDetailsSource
  format: AgentDetailsFormat
  /** The document when `format` is markdown; null for HTML (shown through the frame). */
  markdown: string | null
  /** Core's generated summary (the "Platform summary"); null for a local agent. */
  generated: string | null
  /** `both_present`, `too_large`, `invalid_encoding` — informational, never the winner. */
  warnings: string[]
  /** The version read; null for live data (an own agent, a publisher install, a local agent). */
  revisionNumber: number | null
}

export type AgentDetailsErrorCode =
  /** The profile or its server cannot serve Details: no button. */
  | 'unsupported'
  /** No Details for this target (core 404, no local file): no button. */
  | 'not_found'
  /** Something failed on the way: the button stays and the modal says so. */
  | 'unavailable'

export type AgentDetailsResult =
  | { ok: true; details: AgentDetailsView }
  | { ok: false; code: AgentDetailsErrorCode; message: string }

export type AgentDetailsFrameResult =
  | { ok: true; token: string; url: string }
  | { ok: false; code: AgentDetailsErrorCode; message: string }

/**
 * The C4 content policy, served as a header beside the meta tag core inserts:
 * no scripts, no network, inline styles and `data:` images and fonts only.
 */
export const AGENT_DETAILS_CSP =
  "default-src 'none'; style-src 'unsafe-inline'; img-src data:; font-src data:; base-uri 'none'; form-action 'none'"

/**
 * The details frame's sandbox: no scripts, no same origin, no popups, no
 * forms. Only a top navigation inside a click, which main stops and sends to
 * the browser for `https:`.
 */
export const AGENT_DETAILS_FRAME_SANDBOX = 'allow-top-navigation-by-user-activation'

/**
 * A details frame's host on the `cinna-preview:` scheme. The HTML preview's
 * tokens are bare hex, artifact previews' start with `art-`, dashboards' with
 * `dash-`.
 */
export const AGENT_DETAILS_FRAME_HOST_PREFIX = 'det-'

/** The C1 size cap of one Details file, in bytes (1 MiB). */
export const MAX_AGENT_DETAILS_BYTES = 1_048_576

/** The reserved files, in precedence order (C1). */
export const AGENT_DETAILS_FILES = ['docs/AGENT_DETAILS.html', 'docs/AGENT_DETAILS.md'] as const

/** A stable string for a target: the cache and frame keys in main, the query key in the renderer. */
export function agentDetailsTargetKey(target: AgentDetailsTarget): string {
  switch (target.kind) {
    case 'catalog':
      return `catalog:${target.itemUuid.toLowerCase()}:${target.revisionNumber ?? 'latest'}`
    case 'agent':
      return `agent:${target.remoteAgentId.toLowerCase()}`
    case 'local':
      return `local:${target.agentId}`
  }
}
