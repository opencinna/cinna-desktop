/**
 * The seams inside the ACP driver: how one agent's process is started, how a
 * turn talks to it, and what the translator hands back.
 *
 * Phase 3 of the agent runtime plan replaces the OpenCode runner (a shared
 * `opencode serve` over HTTP + SSE) and the Claude runner (the Claude Agent SDK
 * in this process) with one driver speaking the Agent Client Protocol to a
 * child process per agent, over stdio. What differs between engines is only how
 * that process is started — a launcher — so everything below is engine-neutral.
 *
 * Type-only, plus constants. The process, the pool and the translator each
 * implement one half of this file and are tested against it on their own.
 */

import type {
  CreateElicitationRequest,
  CreateElicitationResponse,
  InitializeRequest,
  InitializeResponse,
  LoadSessionRequest,
  LoadSessionResponse,
  NewSessionRequest,
  NewSessionResponse,
  PromptRequest,
  PromptResponse,
  RequestPermissionRequest,
  RequestPermissionResponse,
  SessionNotification,
  SetSessionConfigOptionRequest,
  SetSessionConfigOptionResponse,
  SetSessionModeRequest,
  SetSessionModeResponse
} from '@agentclientprotocol/sdk'
import type { MessageLike } from '../../streamPartsAccumulator'

/**
 * Which engine an ACP agent runs. Re-exported from `shared/agentDrivers`, where
 * it lives because it is a **stored row value** (`driver_config.launcher`) and
 * the row model may not depend on this folder — which imports the ACP SDK.
 */
export type { AcpLauncherId } from '../../../../shared/agentDrivers'
export { ACP_LAUNCHER_IDS } from '../../../../shared/agentDrivers'

/** ACP protocol version this build speaks. Declares no `fs` and no `terminal` (v2-forward). */
export const ACP_PROTOCOL_VERSION = 1

/** How long a started process may take to answer `initialize` before the start is a failure. */
export const ACP_START_TIMEOUT_MS = 30_000

/**
 * How long a process with no turn in progress is kept before it is stopped.
 *
 * Two minutes, and the number is the OpenCode measurement rather than a guess.
 * An idle `opencode acp` holding one session is **311 MB of physical
 * footprint** (499 MB RSS, of which the 144 MB binary is mapped) — three idle
 * folder agents are a gigabyte of a user's machine spent on nothing. The Claude
 * adapter is lighter: ~100 MB idle, ~400 MB once its `claude` child is up.
 *
 * What reaping costs is a cold start on the next turn, and that is about a
 * second either way: spawn → `initialize` is 631–695 ms for OpenCode and
 * 181–284 ms for the Claude adapter, plus ~300 ms to `session/new`. A second
 * of latency is a fair price for not holding a gigabyte idle, which is why this
 * is two minutes and not the five the plan first assumed.
 */
export const ACP_IDLE_REAP_MS = 2 * 60 * 1000

/** How many stderr lines a connection keeps for an error message. */
export const ACP_STDERR_TAIL_LINES = 40

/** How to start one agent's ACP process. Built by a launcher; opaque to the pool beyond `key`. */
export interface AcpLaunchSpec {
  /** When set, connect remotely; command/env/cwd are unused. Credentials never enter key. */
  remote?: import('../../../../shared/customAgents').RemoteAcpConfig & { accessToken?: string }
  command: string
  args: string[]
  /** The whole child environment — nothing is inherited that is not named here. */
  env: Record<string, string>
  cwd: string
  /**
   * Changes whenever anything the running process was started with changed —
   * the binary, the arguments, the environment, a config file it reads at
   * start. The pool replaces a process whose key moved before the next turn.
   * Never contains a secret: a digest, not the values.
   */
  key: string
}

/** What one process exit looked like. */
export interface AcpExit {
  code: number | null
  signal: string | null
  /** The last {@link ACP_STDERR_TAIL_LINES} lines of stderr. */
  stderrTail: string
}

/**
 * One turn's view of the process: the traffic for one session id.
 *
 * A process can hold several sessions (one per chat), so the connection routes
 * every notification and request by `sessionId` to whoever bound it.
 */
export interface AcpSessionHandlers {
  /** A `session/update` for this session, in arrival order. */
  onUpdate(notification: SessionNotification): void
  /** `session/request_permission` for this session. Must settle; the agent is blocked on it. */
  onPermission(params: RequestPermissionRequest): Promise<RequestPermissionResponse>
  /** `elicitation/create` for this session, when the client declared elicitation. */
  onElicitation?(params: CreateElicitationRequest): Promise<CreateElicitationResponse>
  /** An extension notification naming this session (`_auth/status_update`, …). */
  onExtNotification?(method: string, params: Record<string, unknown>): void
}

export interface AcpConnection {
  readonly pid: number | undefined
  /** The agent's `initialize` answer. */
  readonly initialized: InitializeResponse
  /** True until the process exits or the stream closes. */
  readonly alive: boolean
  /** Settles once, when the process has exited or the stream closed. Never rejects. */
  readonly exited: Promise<AcpExit>

  newSession(params: NewSessionRequest): Promise<NewSessionResponse>
  loadSession(params: LoadSessionRequest): Promise<LoadSessionResponse>
  setSessionMode(params: SetSessionModeRequest): Promise<SetSessionModeResponse>
  setSessionConfigOption(params: SetSessionConfigOptionRequest): Promise<SetSessionConfigOptionResponse>
  prompt(params: PromptRequest): Promise<PromptResponse>
  /** `session/cancel` — a notification; the pending `prompt` then answers `cancelled`. */
  cancel(sessionId: string): Promise<void>

  /**
   * Route one session's traffic to `handlers` until the returned function runs.
   *
   * **Traffic that arrives before the bind is kept, not dropped**: a response
   * and the notifications right behind it can be delivered in one read, so a
   * turn that binds on `newSession`'s answer would otherwise miss them. Up to
   * 500 notifications per unbound session id, for 10 s, delivered in order on
   * bind. A permission or elicitation request for a session nobody has bound
   * (and that is not bound within that window) is answered `cancelled`.
   */
  bindSession(sessionId: string, handlers: AcpSessionHandlers): () => void

  /** The last stderr lines, for an error message. */
  stderrTail(): string
  /** Kill the process tree. Idempotent; resolves once it has exited. */
  dispose(): Promise<void>
}

/** Start a process and complete `initialize`. Rejects with a readable message on failure. */
export type StartAcpConnection = (spec: AcpLaunchSpec, init: InitializeRequest, options?: { signal?: AbortSignal }) => Promise<AcpConnection>

/** Where one agent's process is, for the agent page. */
export type AcpProcessState =
  | { state: 'stopped' }
  | { state: 'starting' }
  | { state: 'running'; pid: number | undefined; since: number }
  | { state: 'exited'; exit: AcpExit; at: number }

/** One process per agent id, started lazily, reaped when idle, replaced when its spec moved. */
export interface AcpProcessPool {
  /**
   * The live connection for an agent: the running one when its spec key still
   * matches, else a fresh start. Concurrent calls for one agent share one start.
   * A process that exited is restarted here, on the next turn — never on its own.
   */
  acquire(agentId: string, spec: AcpLaunchSpec, init: InitializeRequest, signal?: AbortSignal): Promise<AcpConnection>
  /** A turn is in progress on this agent: no reaping until the returned release runs. */
  hold(agentId: string): () => void
  /** Stop an agent's process — now if nothing holds it, else when the last hold releases. */
  retire(agentId: string): void
  status(agentId: string): AcpProcessState
  /** Called with the agent id whenever its state changes. Returns unsubscribe. */
  onStatus(listener: (agentId: string, state: AcpProcessState) => void): () => void
  /** Kill every process (app quit). */
  shutdown(): Promise<void>
}

/** What folding one update (or writing one desktop-authored block) produced. */
export interface AcpStreamUpdate {
  /** The cumulative message to re-ingest into `StreamPartsAccumulator`, when this changed one. */
  message?: MessageLike
  /** `current_mode_update`, or a `config_option_update` for the `mode` option. */
  modeId?: string
}
