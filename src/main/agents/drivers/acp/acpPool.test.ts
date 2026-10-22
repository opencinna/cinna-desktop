/**
 * The production pool's link to session activity: the reaper reads the hub,
 * and a process that goes away writes its work off as lost.
 */
import { describe, expect, it } from 'vitest'
import { createSessionActivityHub } from '../../../services/sessionActivityHub'
import { activityReapDeps, wirePoolToActivity } from './acpPool'
import type { AcpProcessPool, AcpProcessState } from './types'

function fakePool(): Pick<AcpProcessPool, 'onStatus'> & { emit(agentId: string, state: AcpProcessState): void } {
  const listeners = new Set<(agentId: string, state: AcpProcessState) => void>()
  return {
    onStatus: (listener) => {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
    emit: (agentId, state) => listeners.forEach((listener) => listener(agentId, state))
  }
}

function hubWithWork(): ReturnType<typeof createSessionActivityHub> {
  const hub = createSessionActivityHub(() => new Date(1_000))
  hub.report('chat-1', 'agent-a', { type: 'upsert', id: 'bg-1', kind: 'background', title: 'npm test' })
  hub.report('chat-2', 'agent-b', { type: 'upsert', id: 'bg-2', kind: 'background', title: 'make' })
  return hub
}

/** A user's command in agent-c's folder, and nothing of the agent's own. */
function hubWithCommand(): ReturnType<typeof createSessionActivityHub> {
  const hub = createSessionActivityHub(() => new Date(1_000))
  hub.report('chat-3', 'agent-c', { type: 'upsert', id: 'cmd-1', kind: 'command', title: 'sleep 60', canStop: true })
  return hub
}

describe('activityReapDeps', () => {
  it('is busy while the agent has running work, and reports its last change as a number', () => {
    const hub = hubWithWork()
    const deps = activityReapDeps(hub)
    expect(deps.isBusy?.('agent-a')).toBe(true)
    expect(deps.isBusy?.('agent-c')).toBe(false)
    expect(deps.lastActivityAt?.('agent-a')).toBe(1_000)
    expect(deps.lastActivityAt?.('agent-c')).toBeUndefined()
  })

  it('does not count a user command as the agent\'s work', () => {
    const deps = activityReapDeps(hubWithCommand())
    expect(deps.isBusy?.('agent-c')).toBe(false)
    expect(deps.lastActivityAt?.('agent-c')).toBeUndefined()
  })
})

describe('wirePoolToActivity', () => {
  it.each(['stopped', 'exited'] as const)('ends the agent’s running work as lost when its process is %s', (state) => {
    const hub = hubWithWork()
    const pool = fakePool()
    wirePoolToActivity(pool, hub)

    pool.emit('agent-a', state === 'exited' ? { state, exit: { code: 1, signal: null, stderrTail: '' }, at: 2 } : { state })

    expect(hub.snapshot('chat-1').items.map((item) => item.state)).toEqual(['lost'])
    expect(hub.snapshot('chat-2').items.map((item) => item.state)).toEqual(['running'])
  })

  it('leaves a user command running when the agent\'s process goes away', () => {
    const hub = hubWithCommand()
    const pool = fakePool()
    wirePoolToActivity(pool, hub)
    pool.emit('agent-c', { state: 'stopped' })
    expect(hub.snapshot('chat-3').items.map((item) => item.state)).toEqual(['running'])
  })

  it('leaves the work alone while the process starts or runs', () => {
    const hub = hubWithWork()
    const pool = fakePool()
    wirePoolToActivity(pool, hub)

    pool.emit('agent-a', { state: 'starting' })
    pool.emit('agent-a', { state: 'running', pid: 1, since: 2 })

    expect(hub.hasRunning({ agentId: 'agent-a' })).toBe(true)
  })

  it('stops listening once unsubscribed', () => {
    const hub = hubWithWork()
    const pool = fakePool()
    wirePoolToActivity(pool, hub)()

    pool.emit('agent-a', { state: 'stopped' })
    expect(hub.hasRunning({ agentId: 'agent-a' })).toBe(true)
  })
})
