import { expect, it, vi } from 'vitest'
vi.mock('../db/appSettings', () => ({ appSettingsRepo: { get: () => 2 } }))
vi.mock('../logger/logger', () => ({ createLogger: () => ({ debug() {}, error() {} }) }))
import { turnLock } from '../services/localAgents/turnLock'
import { withRuntimeAgent } from './runtimeAdmission'
it('does not reserve global slots for agents held by an exclusive folder write', async () => {
  const one = turnLock.acquire('busy-one', 'test'), two = turnLock.acquire('busy-two', 'test')
  const controller = new AbortController()
  const busy = Promise.allSettled([
    withRuntimeAgent('busy-one', controller.signal, async () => 'unexpected'),
    withRuntimeAgent('busy-two', controller.signal, async () => 'unexpected')
  ])
  let completed = false
  const free = withRuntimeAgent('free', controller.signal, async () => { completed = true })
  try { await vi.waitFor(() => expect(completed).toBe(true)) }
  finally { controller.abort(); one.release(); two.release(); await busy; await free }
})

it('does not wait for turns that hold the agent shared', async () => {
  const turn = turnLock.acquireShared('chatting', 'turn')
  try {
    await expect(withRuntimeAgent('chatting', new AbortController().signal, async () => 'ran')).resolves.toBe('ran')
  } finally { turn.release() }
})

it('admits two tasks on one agent side by side when global slots allow', async () => {
  const signal = new AbortController().signal
  let running = 0, peak = 0
  let release!: () => void
  const gate = new Promise<void>((resolve) => { release = resolve })
  const task = (): Promise<void> => withRuntimeAgent('same-agent', signal, async () => {
    running += 1; peak = Math.max(peak, running)
    await gate
    running -= 1
  })
  const both = Promise.all([task(), task()])
  try { await vi.waitFor(() => expect(running).toBe(2)) }
  finally { release(); await both }
  expect(peak).toBe(2)
})
