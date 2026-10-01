import { appSettingsRepo } from '../db/appSettings'
import { turnLock } from '../services/localAgents/turnLock'
import { ExecutionQueue } from './executionQueue'

function concurrency(): number {
  const value = appSettingsRepo.get('taskRunnerConcurrency')
  return Number.isSafeInteger(value) && value >= 1 && value <= 8 ? value : 2
}
export const taskSlots = new ExecutionQueue(concurrency)
/**
 * Runner calls across all agents. There is no per-agent queue: turns on one
 * agent run concurrently (each in its own session), so two tasks on the same
 * agent are admitted side by side as long as global slots allow.
 */
const agentSlots = new ExecutionQueue(concurrency)

async function waitForLocalAgent(agentId: string, signal: AbortSignal): Promise<void> {
  while (turnLock.isExclusivelyLocked(agentId)) {
    await new Promise<void>((resolve, reject) => {
      const end = (): void => { clearTimeout(timer); signal.removeEventListener('abort', aborted) }
      const aborted = (): void => { end(); reject(new Error('The task was stopped while waiting for its agent.')) }
      const timer = setTimeout(() => { end(); resolve() }, 100)
      if (signal.aborted) aborted()
      else signal.addEventListener('abort', aborted, { once: true })
    })
  }
}
export async function withRuntimeAgent<T>(agentId: string, signal: AbortSignal, run: () => Promise<T>): Promise<T> {
  let releaseGlobal: (() => void) | undefined
  try {
    // Turns hold turnLock shared and run beside this one; only the desktop's
    // own exclusive folder writes are waited out. Waiting for them must not
    // reserve one of the scarce global slots used by unrelated agents.
    do {
      await waitForLocalAgent(agentId, signal)
      releaseGlobal = await agentSlots.acquire(signal)
      if (!turnLock.isExclusivelyLocked(agentId)) break
      releaseGlobal()
      releaseGlobal = undefined
    } while (true)
    if (signal.aborted) throw new Error('The task was stopped.')
    return await run()
  } finally { releaseGlobal?.() }
}
