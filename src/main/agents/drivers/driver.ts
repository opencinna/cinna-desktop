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
 * Two implementations: `a2a` over `runAgentTurn`, and `acp` over one child
 * process per agent speaking the Agent Client Protocol. Phase 2 wrapped three
 * runners here without rewriting them; phase 3 replaced the two folder runners
 * with the ACP driver and deleted them, so `AgentTurnRunner` — the seam that
 * existed to hold three transports — is gone with them.
 *
 * Type-only. `index.ts` is the one file in this folder that names Electron and
 * the production services; each driver takes its world by injection so the
 * contract suite can drive it with fakes.
 */

import type { AgentRow } from '../../db/agents'
import type { RunAgentTurnResult } from '../../services/a2aStreamingService'
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
  /** Main-owned coordinator handoff; never inferred from protocol text or metadata. */
  handbackEligible?: boolean
  /** Internal autonomous admission; interactive turns keep immediate busy refusal. */
  queueWhenBusy?: boolean
  chatId: string
  wireContent: string
  /** Cinna file ids to attach (A2A `metadata.cinna_file_ids`). */
  fileIds?: string[]
  /** Cancellation. A driver that can tell the agent to stop does so on abort. */
  signal: AbortSignal
  /** Live event sink; omit for a buffered turn. */
  onEvent?: (event: RunEvent) => void
}

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
