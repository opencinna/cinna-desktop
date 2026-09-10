import type { MessagePortMain } from 'electron'
import type { RunErrorEvent } from '../../shared/runEvents'

/**
 * Typed wrapper around the raw `MessagePortMain.postMessage(any)` surface used
 * in the streaming IPC handlers (`agent_a2a.ipc.ts`, `llm.ipc.ts`) before the
 * port is handed off to its streaming service. The handlers themselves don't
 * hold a typed `StreamPort` — only the services do — so this helper forces
 * their few outbound frames through the `RunErrorEvent` shape.
 *
 * One helper for both channels because both carry the one `RunEvent`
 * vocabulary: an agent pre-flight failure may carry a `code` (e.g. the Cinna
 * re-auth discriminator) and an LLM one may carry an `errorDetail`, and either
 * is simply an optional field of the same event.
 *
 * Keep this thin: the only frames IPC handlers send directly are pre-flight
 * `{ type: 'error', error }` failures (session not activated, chat not
 * found, agent not configured, …). All other frames originate inside the
 * streaming services where the typed `StreamPort` interface already
 * enforces the contract.
 */

export function postRunError(
  port: MessagePortMain,
  error: string,
  extras?: { code?: string; errorDetail?: string }
): void {
  // Only the extras that are set: an `undefined` key survives structured clone
  // as a present-but-undefined property, which is not the shape the wire had
  // before the two helpers merged.
  const event: RunErrorEvent = { type: 'error', error }
  if (extras?.code) event.code = extras.code
  if (extras?.errorDetail) event.errorDetail = extras.errorDetail
  port.postMessage(event)
}
