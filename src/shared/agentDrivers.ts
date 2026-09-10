/**
 * What the rest of the app may know about *how* an agent runs, without knowing
 * what kind of agent it is.
 *
 * Phase 2 of the agent runtime plan moved every kind-specific decision on the
 * turn, readiness, auth and attachment paths behind an `AgentDriver`
 * (`src/main/agents/drivers/`). A caller outside that folder asks the driver's
 * {@link AgentCapabilities} — "can this agent take a file?", "who answers its
 * asks?" — instead of comparing `source`, `engine` or `kind` to a literal.
 *
 * Type-only plus one guard, so the renderer can import it: capabilities and
 * readiness cross the IPC boundary on the agent DTO.
 */
import type { InputResumeMode } from './runEvents'

/**
 * Which driver runs an agent. Stored on `agents.driver`.
 *
 * `source` still says who *owns* a row (`local` / `remote` / `folder`: whether
 * sync may touch it); `driver` says how it runs. They were one column and are
 * two concerns. Phase 3 collapses `opencode` and `claude` into `acp`.
 */
export type AgentDriverId = 'a2a' | 'opencode' | 'claude'

export const AGENT_DRIVER_IDS: readonly AgentDriverId[] = ['a2a', 'opencode', 'claude']

/** Whether a stored value names a driver this build has. */
export function isAgentDriverId(value: unknown): value is AgentDriverId {
  return value === 'a2a' || value === 'opencode' || value === 'claude'
}

export interface AgentCapabilities {
  /** Whether a turn's output arrives incrementally. */
  streaming: boolean
  /** Whether a running turn can be told to stop (beyond dropping the stream). */
  cancel: boolean
  /**
   * What continuity a chat keeps with the agent: `context` is an id the agent
   * threads (A2A `contextId`); `resumable` is a session the desktop reopens.
   */
  sessions: 'none' | 'context' | 'resumable'
  /** Which kinds of `needs_input` this driver can raise. */
  input: { permission: boolean; question: boolean; auth: boolean; elicitation: boolean }
  /** How an ask is answered — see `InputResumeMode`. */
  inputResume: InputResumeMode
  /**
   * Where a file attached to a message to this agent goes: `cinna` uploads it
   * to the Cinna backend and sends its id; `none` offers no attach at all.
   */
  attachments: 'cinna' | 'local' | 'none'
  /**
   * Who authenticates the turn: a user-supplied static `token`, the signed-in
   * `cinna` account (a 401 there is a re-auth, not a wrong token), the agent's
   * own `cli` login, or nothing.
   */
  auth: 'none' | 'token' | 'cinna' | 'cli'
  /**
   * Where the composer's `/` commands come from: a folder's command `catalog`
   * (`/run:<name>` runs it on this machine), the agent `card`'s skills, or none.
   */
  commands: 'catalog' | 'card' | 'none'
  /** Whether the driver can take MCP servers per session. */
  mcpInjection: boolean
  /** Whether the agent runs in a folder on this machine. */
  cwd: boolean
}

/**
 * Whether an agent can take a turn right now, and if not, why.
 *
 * The folder states (`credentials_needed`, `invalid`, `contract_too_new`) are
 * `LocalAgentReadiness`'s; the others are what a driver learns by asking:
 * `not_installed` / `not_logged_in` for an agent on a CLI, `unreachable` for
 * one behind a URL.
 */
export type AgentReadinessState =
  | 'ok'
  | 'credentials_needed'
  | 'invalid'
  | 'contract_too_new'
  | 'not_installed'
  | 'not_logged_in'
  | 'unreachable'

export interface AgentReadiness {
  state: AgentReadinessState
  /**
   * One short sentence explaining a non-`ok` state, in the user's words — it is
   * shown beside a disabled Send, truncated to what fits. Null when `ok`.
   */
  reason: string | null
  /**
   * The underlying error (a URL, a status, the network code), for a tooltip —
   * never the only thing a surface shows. Absent when the reason says it all.
   */
  detail?: string | null
}

/**
 * Main → renderer: an agent's readiness changed. The renderer re-reads the
 * agent list, which carries the new answer.
 */
export const AGENT_READINESS_CHANGED_CHANNEL = 'agent:readiness-changed'

/** Payload of {@link AGENT_READINESS_CHANGED_CHANNEL}. */
export interface AgentReadinessChangedPayload {
  agentId: string
  /** Null when the driver could not tell (a check that timed out) — never a refusal. */
  readiness: AgentReadiness | null
}
