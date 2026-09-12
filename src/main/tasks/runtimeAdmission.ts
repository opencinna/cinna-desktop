import { appSettingsRepo } from '../db/appSettings'
import { turnLock } from '../services/localAgents/turnLock'
import { ExecutionQueue } from './executionQueue'

function concurrency(): number {
  const value = appSettingsRepo.get('taskRunnerConcurrency')
  return Number.isSafeInteger(value) && value >= 1 && value <= 8 ? value : 2
}
export const taskSlots = new ExecutionQueue(concurrency)
const agentSlots = new ExecutionQueue(concurrency)
const agentQueues = new Map<string, ExecutionQueue>()

async function waitForLocalAgent(agentId: string, signal: AbortSignal): Promise<void> {
  while (turnLock.isLocked(agentId)) {
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
  let queue = agentQueues.get(agentId)
  if (!queue) { queue = new ExecutionQueue(() => 1); agentQueues.set(agentId, queue) }
  const releaseAgent = await queue.acquire(signal)
  let releaseGlobal: (() => void) | undefined
  try {
    releaseGlobal = await agentSlots.acquire(signal)
    await waitForLocalAgent(agentId, signal)
    if (signal.aborted) throw new Error('The task was stopped.')
    return await run()
  } finally { releaseGlobal?.(); releaseAgent() }
}
