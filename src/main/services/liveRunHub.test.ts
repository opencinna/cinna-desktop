import { describe, expect, it } from 'vitest'
import { createLiveRunHub } from './liveRunHub'
import type { RunWatchMessage } from '../../shared/runWatch'
const delta = (text: string) => ({ type: 'delta' as const, kind: 'text' as const, text })
describe('live run hub', () => {
  it('replays accumulated output and sequences only subsequent live events', () => {
    const hub = createLiveRunHub()
    const run = hub.begin('u', 'c', 'r', ['old'])
    run.setAgentId('a')
    run.push({ type: 'request-id', requestId: 'req' })
    run.push(delta('Hel'))
    run.push(delta('lo'))
    const messages: RunWatchMessage[] = []
    const detach = hub.watch('u', 'c', (m) => messages.push(m))
    expect(messages).toEqual([{ type: 'snapshot', runId: 'r', sequence: 3, active: true,
      agentId: 'a', replayAvailable: true, baselineMessageIds: ['old'],
      events: [{ type: 'request-id', requestId: 'req' }, delta('Hello')] }])
    run.push(delta('!'))
    expect(messages[1]).toMatchObject({ type: 'event', sequence: 4, event: delta('!') })
    detach()
    run.push(delta(' Still running'))
    const replay: RunWatchMessage[] = []
    hub.watch('u', 'c', (m) => replay.push(m))
    expect(replay[0]).toMatchObject({ events: [{ type: 'request-id', requestId: 'req' }, delta('Hello! Still running')] })
  })
  it('isolates profiles and chats, survives bad subscribers, and keeps idle watches across runs', () => {
    const hub = createLiveRunHub()
    const messages: RunWatchMessage[] = []
    const other: RunWatchMessage[] = []
    hub.watch('u', 'c', () => { throw new Error('closed view') })
    hub.watch('u', 'c', (m) => messages.push(m))
    hub.watch('v', 'c', (m) => other.push(m))
    hub.watch('u', 'd', (m) => other.push(m))
    const run = hub.begin('u', 'c', 'one', [])
    run.push(delta('one')); run.close(); run.push(delta('late'))
    const next = hub.begin('u', 'c', 'two', [])
    next.accepted(); next.close()
    expect(messages.map((m) => m.type)).toEqual(['snapshot', 'snapshot', 'event', 'closed', 'snapshot', 'accepted', 'closed'])
    expect(other).toHaveLength(2)
    expect(other.every((m) => m.type === 'snapshot' && !m.active)).toBe(true)
  })
  it('bounds nested payload bytes and falls back for new watchers without disrupting existing ones', () => {
    const hub = createLiveRunHub(200)
    const messages: RunWatchMessage[] = []
    hub.watch('u', 'c', (m) => messages.push(m))
    const run = hub.begin('u', 'c', 'r', ['old'])
    run.push(delta('first'))
    run.push({ type: 'tool_result', id: 't', result: { nested: 'x'.repeat(300) } })
    run.push(delta('last'))
    expect(messages.filter((m) => m.type === 'event')).toHaveLength(3)
    const late: RunWatchMessage[] = []
    hub.watch('u', 'c', (m) => late.push(m))
    expect(late[0]).toMatchObject({ active: true, replayAvailable: false, events: [], baselineMessageIds: [] })
  })
  it('a cache serialization failure cannot stop the producer', () => {
    const hub = createLiveRunHub()
    const run = hub.begin('u', 'c', 'r', [])
    const circular: Record<string, unknown> = {}; circular.self = circular
    expect(() => run.push({ type: 'tool_result', id: 't', result: circular })).not.toThrow()
    expect(() => run.close()).not.toThrow()
  })
})
