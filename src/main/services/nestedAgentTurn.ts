import type { AgentDriver, RunInput, RunResult } from '../agents/drivers/driver'
import type { AgentRow } from '../db/agents'

export const SPECIALIST_WAITING = 'This agent is waiting for a human answer in the Inbox. Do not call it again until that request is answered. End this turn; its completed result will return as a follow-up naming this tool call.'

const active = new Map<string, { chatId: string; controller: AbortController }>()
/**
 * Tails of the nested turns per chat and agent. Turns on one agent run in
 * parallel across chats, but every nested turn of an agent in one chat shares
 * that chat's session for it, so two delegations to the same agent from one
 * conversation take turns here instead of prompting one session twice.
 */
const sessionTails = new Map<string, Promise<void>>()

async function waitForSession(key: string, signal: AbortSignal): Promise<() => void> {
  const previous = sessionTails.get(key) ?? Promise.resolve()
  let release!: () => void
  const tail = previous.then(() => new Promise<void>((resolve) => { release = resolve }))
  sessionTails.set(key, tail)
  const done = (): void => {
    release()
    if (sessionTails.get(key) === tail) sessionTails.delete(key)
  }
  try {
    await new Promise<void>((resolve, reject) => {
      const aborted = (): void => reject(new Error('The agent was stopped while waiting for its earlier delegation in this chat.'))
      if (signal.aborted) { aborted(); return }
      signal.addEventListener('abort', aborted, { once: true })
      void previous.then(() => { signal.removeEventListener('abort', aborted); resolve() })
    })
  } catch (error) {
    // Leave the queue in order: this place releases once the one before it does.
    void previous.then(done)
    throw error
  }
  return done
}
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
  // Addressable before it waits its place, so a Stop on a queued delegation
  // reaches it rather than letting it run once the earlier one ends.
  const controller = new AbortController()
  const address = `nested:${JSON.stringify([input.chatId, input.nested.toolCallId])}`
  active.set(address, { chatId: input.chatId, controller })
  const abort = (): void => controller.abort()
  input.signal.addEventListener('abort', abort, { once: true })
  if (input.signal.aborted) abort()
  try {
    let leaveSession: () => void
    try {
      leaveSession = await waitForSession(JSON.stringify([input.chatId, agent.id]), controller.signal)
    } catch {
      // Stopped before it started: the same canceled result a driver gives.
      return { text: '', parts: [], notices: [], taskState: 'canceled', stopReason: 'canceled' }
    }
    try {
      return await runNested(driver, ownerId, agent, input, controller)
    } finally {
      leaveSession()
    }
  } finally {
    if (active.get(address)?.controller === controller) active.delete(address)
    input.signal.removeEventListener('abort', abort)
  }
}

async function runNested(
  driver: Pick<AgentDriver, 'run'>,
  ownerId: string,
  agent: AgentRow,
  input: RunInput & { nested: { toolCallId: string } },
  controller: AbortController
): Promise<RunResult & { needsInput?: boolean }> {
  let waiting = false
  const questions = new Set<string>()
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
}
