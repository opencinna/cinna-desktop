/**
 * The driver seam: everything kind-specific about running an agent, behind one
 * interface.
 *
 * Phase 2 of the agent runtime plan. Before it, the turn path asked
 * `resolveTurnRunner(agent)` which of three runners to use, and every caller
 * around the runner — the chat IPC handler, the orchestrator's agent tool, the
 * answer path, the agent DTO — branched on `source` again for endpoints,
 * tokens, the Cinna re-auth flag, command catalogs and attachments. A driver
 * owns all of it. Outside `src/main/agents/drivers/` (and the sync code, which
 * reads `source` for ownership), nothing decides behaviour by kind; it asks
 * {@link AgentDriver.capabilities}.
 *
 * Three implementations: A2A, ACP over one child process per agent, and Claude
 * Managed sessions. The local model runs through the coordinator's tool loop.
 * Phase 2 wrapped three
 * runners here without rewriting them; phase 3 replaced the two folder runners
 * with the ACP driver and deleted them, so `AgentTurnRunner` — the seam that
 * existed to hold three transports — is gone with them.
 *
 * Type-only. `index.ts` wires production services; each driver takes its world by injection so the
 * contract suite can drive it with fakes.
 */

import type { AgentRow } from '../../db/agents'
import type { RunAgentTurnResult, TurnIO, TurnSnapshot } from '../../services/a2aStreamingService'
import type { RunEvent } from '../../../shared/runEvents'
import type {
  LocalPermissionRequest,
  RequestResolution
} from '../../../shared/localAgentRequests'
import type {
  AgentCapabilities,
  AgentDriverId,
  AgentReadiness
} from '../../../shared/agentDrivers'

export type { AgentCapabilities, AgentDriverId, AgentReadiness }

/** One turn's input. The agent row and its owner are separate arguments. */
export interface RunInput {
  /** Persist a completed text segment before a conductor tool row. */
  flush?(): void
  coordinator?: import('../../services/coordinatorToolProvider').CoordinatorToolProvider
  attachments?: import('../../../shared/attachments').MessageAttachment[]
  /** Main-owned specialist invocation. Never attach a conductor server or listen between turns. */
  nested?: { toolCallId: string }
  /** Runner-owned, durable MCP call budget. Consume synchronously before a tool side effect. */
  toolCallBudget?: { remaining: number; consume(): void }
  /** Main-owned coordinator handoff; never inferred from protocol text or metadata. */
  handbackEligible?: boolean
  /** Internal autonomous admission; interactive turns keep immediate busy refusal. */
  queueWhenBusy?: boolean
  chatId: string
  wireContent: string
  /** Cinna file ids to attach (A2A `metadata.cinna_file_ids`). */
  fileIds?: string[]
  /**
   * The id of the user row this turn answers, for a driver whose protocol
   * carries one (A2A sends it as the message's `messageId`). Absent for a
   * turn with no user row of its own, such as an orchestrated call.
   */
  messageId?: string
  /** Cancellation. A driver that can tell the agent to stop does so on abort. */
  signal: AbortSignal
  /** Live event sink; omit for a buffered turn. */
  onEvent?: (event: RunEvent) => void
  /**
   * Where a driver that can take a message mid-turn offers to. Called with a
   * function while the turn can take one, and with `null` the moment it no
   * longer can. A driver without mid-turn delivery never calls it.
   */
  registerSteer?: (steer: SteerFn | null) => void
  /**
   * Where a driver offers what it has streamed so far, as a function the
   * caller reads on demand. Called once, early in the turn. The direct-chat
   * wrapper reads it when the app quits mid-turn — Electron does not wait for
   * a turn to end — and when a driver breaks its never-throws contract, so
   * what the user watched arrive is persisted either way. Every driver calls it;
   * one that does not loses an unfinished turn's output at quit.
   */
  registerSnapshot?: (snapshot: () => TurnSnapshot) => void
  /**
   * The profile and settings scope the chat's turn runs under. A driver that
   * listens to a session between turns opens a follow-up turn in this scope
   * ({@link FollowUpRequest}), not in whichever profile is active by then.
   * Absent for a turn with no chat of its own to report into (an orchestrated
   * call): nothing is opened for it.
   */
  runScope?: FollowUpScope
}

/** Whose profile and settings a follow-up turn runs under. */
export interface FollowUpScope {
  profileUserId: string
  settingsUserId: string
}

/**
 * A turn the agent started on its own, between the user's turns, that a
 * driver asks the app to show as a run of the chat
 * (`services/followUpTurnService.ts`). Driver-agnostic: the driver decides
 * what starts one and drives it; the service decides whether and when it may
 * open, and saves and records it as any turn.
 */
export interface FollowUpRequest {
  chatId: string
  agentId: string
  /** The driver's id, for the in-flight marker. */
  driverId: string
  scope: FollowUpScope
  /**
   * Drive the turn to its end. Streams through `io` as `AgentDriver.run`
   * does and, like it, never throws: the result is saved as an assistant
   * turn with no user row.
   */
  run(io: TurnIO): Promise<RunAgentTurnResult>
  /**
   * False once the traffic that asked for the turn went elsewhere (a turn of
   * the same session took it) or was dropped: open nothing.
   */
  wanted(): boolean
  /**
   * The turn will not be opened: refuse the asks that wait, drop what is
   * held, and stop listening to the session. Idempotent. With
   * `keepListening` (the chat stayed busy too long, but still answers to the
   * agent) the session stays observed, and later traffic may ask again.
   */
  abandon(reason: string, options?: { keepListening?: boolean }): void
}

export type FollowUpOpener = (request: FollowUpRequest) => void

/**
 * Deliver a user message into the running turn. `injected` means the engine
 * took it and the turn posted a `user_message` event for it and will persist
 * it; `late` means the engine took it after the turn's result was built, so
 * the turn will **not** persist it and the caller must; `unavailable` means
 * nothing was delivered and the caller should wait for the turn to end.
 * Never rejects.
 */
export type SteerFn = (content: string) => Promise<'injected' | 'late' | 'unavailable'>

/**
 * One turn's output — `RunAgentTurnResult`, unchanged in phase 2 so the golden
 * expectations stay byte-identical. `error` carries a failed turn; `run` never
 * throws.
 */
export type RunResult = RunAgentTurnResult

/** A parked ask, as the pending-request registry recorded it. */
export interface ParkedAsk {
  requestId: string
  chatId: string
  agentId: string
  kind: 'permission' | 'question'
  /** The engine's own permission ask — what an *Always allow* is built from. */
  request?: LocalPermissionRequest
}

export interface RespondOutcome {
  /** False when nothing was waiting on that id (the turn ended, or never parked). */
  delivered: boolean
  /**
   * Present only for a permission answered *always*: whether the rule is on
   * disk. False is a real answer — the action still goes ahead once.
   */
  remembered?: boolean
}

export interface ReadinessOptions {
  /**
   * The user asked — *Check again*, a card's Test. Skip any answer a probe
   * holds behind its own cache (the Claude login probe's window, the tool
   * detection memo), so a fix the user just made is seen now. A list-time
   * check leaves it unset and stays cheap.
   */
  fresh?: boolean
}

export interface AgentDriver {
  readonly id: AgentDriverId | 'unsupported'

  /** Pure and stable for a row: no I/O, same answer every call. */
  capabilities(agent: AgentRow): AgentCapabilities

  /**
   * Never throws. May do I/O (a folder scan, a CLI probe, a card fetch) and,
   * for an agent on the Cinna account, may refresh — or, when the refresh is
   * refused, clear — the stored Cinna session, exactly as a turn would.
   *
   * **Null means "could not tell"** — a card that did not answer inside the
   * check's bound, where a turn would simply have waited longer. The composer
   * refuses only on a state a driver actually established, so an agent that is
   * merely slow is never refused.
   */
  readiness(
    userId: string,
    agent: AgentRow,
    options?: ReadinessOptions
  ): Promise<AgentReadiness | null>

  /**
   * Run one turn. `userId` is the scope that owns the row. Never throws: every
   * failure — including the pre-flight (no endpoint, an expired Cinna session,
   * a folder that cannot run) — is `result.error`.
   */
  run(userId: string, agent: AgentRow, input: RunInput): Promise<RunResult>

  /**
   * Answer a parked ask (`inputResume: 'reply'`). **Synchronous on purpose**:
   * the answer path writes an *Always allow* rule and then resolves the park,
   * and that order is only safe while nothing can interleave between the
   * registry lookup and the resolve. A driver with nothing to answer returns
   * `{ delivered: false }`.
   */
  respond(ask: ParkedAsk, resolution: RequestResolution): RespondOutcome

}
