import type { MessagePortMain } from 'electron'
import type { AgentErrorEvent } from '../../shared/agentStreamEvents'
import type { LlmErrorEvent } from '../../shared/llmStreamEvents'

/**
 * Typed wrappers around the raw `MessagePortMain.postMessage(any)` surface
 * used in the streaming IPC handlers (`agent_a2a.ipc.ts`, `llm.ipc.ts`)
 * before the port is handed off to its streaming service. The handlers
 * themselves don't hold a typed `StreamPort` — only the services do — so
 * these helpers force their few outbound frames through a typed shape,
 * matching the `AgentErrorEvent` / `LlmErrorEvent` contract.
 *
 * Keep this thin: the only frames IPC handlers send directly are pre-flight
 * `{ type: 'error', error }` failures (session not activated, chat not
 * found, agent not configured, …). All other frames originate inside the
 * streaming services where the typed `StreamPort` interface already
 * enforces the contract.
 */

export function postAgentError(port: MessagePortMain, error: string): void {
  const event: AgentErrorEvent = { type: 'error', error }
  port.postMessage(event)
}

export function postLlmError(port: MessagePortMain, error: string): void {
  const event: LlmErrorEvent = { type: 'error', error }
  port.postMessage(event)
}
