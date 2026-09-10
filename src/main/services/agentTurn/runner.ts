/**
 * The runner seam: one turn, whatever transport carries it.
 *
 * ## Why this is a lift and not a new interface
 *
 * `a2aStreamingService.runAgentTurn` was already the port-free, caller-agnostic
 * single-turn primitive, and it already served **both** the direct agent chat
 * and orchestrated-tool mode. Its output — compact `text` for the orchestrator
 * LLM, full-fidelity `parts[]` for the UI, `notices`, and the session
 * bookkeeping — is exactly what a folder agent has to produce too. So
 * {@link AgentTurnRunner} is that same call signature over a **widened** input,
 * and every consumer downstream of it (`StreamPartsAccumulator`, the delta
 * port, `messageRepo`, `a2aSessionRepo`) is reused verbatim.
 *
 * The widening is the only change to the A2A side: `endpointUrl` and `cardUrl`
 * become optional, because a folder agent has neither. `runAgentTurn` itself
 * keeps requiring both — see {@link A2ARunAgentTurnInput} in
 * `a2aStreamingService` — so the compiler still refuses an A2A turn without a
 * card. Nothing inside `runAgentTurn` was touched.
 *
 * **Which runner an agent uses is no longer decided here.** Phase 2 of the
 * agent runtime plan wrapped each runner in an `AgentDriver`
 * (`src/main/agents/drivers/`), which owns the dispatch and everything
 * kind-specific around the turn; `resolveTurnRunner` and `isFolderAgent` are
 * gone. The runner classes still implement this interface.
 */

import type { RunAgentTurnInput, RunAgentTurnResult } from '../a2aStreamingService'

/**
 * One agent turn over one transport.
 *
 * `runTurn` never throws: a failed turn is a `RunAgentTurnResult` carrying
 * `error`, because both call sites have to render a failure either way and an
 * exception crossing the IPC boundary loses its code (see `src/main/ipc/_wrap.ts`).
 */
export interface AgentTurnRunner {
  runTurn(input: RunAgentTurnInput): Promise<RunAgentTurnResult>
}
