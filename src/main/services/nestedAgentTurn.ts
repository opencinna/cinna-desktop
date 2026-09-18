import type { AgentDriver, RunInput, RunResult } from '../agents/drivers/driver'
import type { AgentRow } from '../db/agents'

export const SPECIALIST_WAITING = 'This agent is waiting for a human answer in the Inbox. Do not call it again until that request is answered. End this turn; its completed result will return as a follow-up naming this tool call.'

const active = new Map<string, { chatId: string; controller: AbortController }>()
export const nestedAgentTurns = {
  chatFor(address: string): string | undefined { return active.get(address)?.chatId },
  cancel(address: string): void { active.get(address)?.controller.abort() }
}

/** Permission decisions stay live; questions release the conductor and survive restart. */
export async function runNestedAgentTurn(
  driver: Pick<AgentDriver, 'run'>,
  ownerId: string,
  agent: AgentRow,
  input: RunInput & { nested: { toolCallId: string } }
): Promise<RunResult & { needsInput?: boolean }> {
  const controller = new AbortController()
  const address = `nested:${JSON.stringify([input.chatId, input.nested.toolCallId])}`
  active.set(address, { chatId: input.chatId, controller })
  const abort = (): void => controller.abort()
  input.signal.addEventListener('abort', abort, { once: true })
  if (input.signal.aborted) abort()
  let waiting = false
  const questions = new Set<string>()
  try {
    const result = await driver.run(ownerId, agent, {
      ...input,
      signal: controller.signal,
      onEvent(event) {
        if (event.type === 'needs_input' && event.request.kind === 'question') {
          waiting = true
          questions.add(event.requestId)
          input.onEvent?.({ ...event, resume: 'next_message' })
          if (event.resume === 'reply') input.onEvent?.({ type: 'delta', kind: 'tool_result', toolId: event.requestId, text: 'Waiting for your answer in the Inbox.' })
          // Publish the durable address before releasing the driver's live park.
          if (event.resume === 'reply') controller.abort()
          return
        }
        // Canceling the parked child must not expire its durable Inbox row.
        if (waiting && (event.type === 'input_resolved' || event.type === 'done' || event.type === 'error')) return
        if (event.type === 'delta' && event.kind === 'tool_result' && event.toolId && questions.has(event.toolId)) return
        input.onEvent?.(event)
      }
    })
    if (waiting && !input.signal.aborted) {
      const parts = result.parts.map((part) => part.kind === 'tool_result' && part.toolId && questions.has(part.toolId)
        ? { ...part, text: 'Waiting for your answer in the Inbox.' } : part)
      for (const requestId of questions) {
        if (parts.some((part) => part.kind === 'tool' && part.toolId === requestId) && !parts.some((part) => part.kind === 'tool_result' && part.toolId === requestId)) {
          parts.push({ kind: 'tool_result', toolId: requestId, text: 'Waiting for your answer in the Inbox.' })
        }
      }
      return { ...result, parts, error: undefined, stopReason: 'end_turn', taskState: 'input-required', text: SPECIALIST_WAITING, needsInput: true }
    }
    return result
  } finally {
    if (active.get(address)?.controller === controller) active.delete(address)
    input.signal.removeEventListener('abort', abort)
  }
}
