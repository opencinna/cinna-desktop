import { expect, it, vi } from 'vitest'
vi.mock('../db/appSettings', () => ({ appSettingsRepo: { get: () => 2 } }))
vi.mock('../logger/logger', () => ({ createLogger: () => ({ debug() {}, error() {} }) }))
import { turnLock } from '../services/localAgents/turnLock'
import { withRuntimeAgent } from './runtimeAdmission'
it('does not reserve global slots for agents occupied by interactive turns', async () => {
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
