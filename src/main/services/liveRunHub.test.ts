import { describe, expect, it, vi } from 'vitest'
import { createLiveRunHub } from './liveRunHub'
import { getLogEntries } from '../logger/logger'
import type { RunWatchMessage } from '../../shared/runWatch'
import type { RunDeltaEvent, RunEvent } from '../../shared/runEvents'
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
  it('keeps a subagent’s text out of the agent’s own when replaying', () => {
    // Mutation: drop the lane check in `continuesPart` → the child's words join the parent's delta.
    const hub = createLiveRunHub()
    const run = hub.begin('u', 'c', 'r', [])
    run.push(delta('Parent '))
    run.push({ ...delta('child'), parentToolId: 'agent-1' })
    run.push({ ...delta(' more'), parentToolId: 'agent-1' })
    const replay: RunWatchMessage[] = []
    hub.watch('u', 'c', (m) => replay.push(m))
    expect(replay[0]).toMatchObject({ events: [delta('Parent '), { ...delta('child more'), parentToolId: 'agent-1' }] })
  })
  it('does not fold a `newPart` delta into the one before it', () => {
    // Mutation: drop the `newPart` check in `merge` → one replayed delta, and the renderer glues the two messages.
    const hub = createLiveRunHub()
    const run = hub.begin('u', 'c', 'r', [])
    run.push(delta('launched'))
    run.push({ ...delta('Command'), newPart: true })
    run.push(delta(' completed'))
    const replay: RunWatchMessage[] = []
    hub.watch('u', 'c', (m) => replay.push(m))
    expect(replay[0]).toMatchObject({ events: [delta('launched'), { ...delta('Command completed'), newPart: true }] })
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
  it('does not spend the entry cap on status frames between mergeable deltas, and still publishes them live', () => {
    const hub = createLiveRunHub()
    const early: RunWatchMessage[] = []
    hub.watch('u', 'c', (m) => early.push(m))
    const run = hub.begin('u', 'c', 'r', [])
    run.push({ type: 'request-id', requestId: 'req' })
    for (let i = 0; i < 3_000; i++) {
      run.push(delta('a'))
      run.push({ type: 'status', state: 'working', taskId: 't' })
    }
    expect(early.filter((m) => m.type === 'event' && m.event.type === 'status')).toHaveLength(3_000)
    const late: RunWatchMessage[] = []
    hub.watch('u', 'c', (m) => late.push(m))
    expect(late[0]).toMatchObject({ replayAvailable: true,
      events: [{ type: 'request-id', requestId: 'req' }, delta('a'.repeat(3_000))] })
  })
  it('counts a tool part whose every fragment repeats its full input once', () => {
    const hub = createLiveRunHub()
    const run = hub.begin('u', 'c', 'r', [])
    run.push({ type: 'request-id', requestId: 'req' })
    const toolInput = { content: 'x'.repeat(200_000) }
    for (let i = 0; i < 60; i++) {
      run.push({ type: 'delta', kind: 'tool', text: `${i} `, toolName: 'write', toolId: 't1', toolInput })
    }
    const late: RunWatchMessage[] = []
    hub.watch('u', 'c', (m) => late.push(m))
    const snapshot = late[0] as Extract<RunWatchMessage, { type: 'snapshot' }>
    expect(snapshot.replayAvailable).toBe(true)
    const tools = snapshot.events.filter((e) => e.type === 'delta')
    expect(tools).toHaveLength(1)
    expect(tools[0]).toMatchObject({ kind: 'tool', toolId: 't1', toolInput })
  })
  it('shrinks tool output and long tool arguments before giving up replay, keeping every tool part', () => {
    const hub = createLiveRunHub()
    const run = hub.begin('u', 'c', 'r', [])
    run.push({ type: 'request-id', requestId: 'req' })
    run.push(delta('n'.repeat(10_000)))
    const tools = 200
    for (let i = 0; i < tools; i++) {
      // Odd calls run inside a nested agent's sub-thread.
      const wrap = (event: RunEvent): RunEvent => i % 2 ? { type: 'child', toolCallId: 'call-sub', agentId: 'sub', event } : event
      run.push(wrap({ type: 'delta', kind: 'tool', text: `Running ${i}`, toolName: 'bash', toolId: `t${i}`,
        toolInput: { command: `run ${i}`, files: [{ body: 'y'.repeat(3_000) }] } }))
      for (let chunk = 0; chunk < 10; chunk++) {
        const text = chunk === 9 ? 'z'.repeat(9_990) + `end-${i}`.padStart(10, '-') : 'z'.repeat(10_000)
        run.push(wrap({ type: 'delta', kind: 'tool_result', text, toolId: `t${i}`, toolStream: 'stdout' }))
      }
    }
    const late: RunWatchMessage[] = []
    hub.watch('u', 'c', (m) => late.push(m))
    const snapshot = late[0] as Extract<RunWatchMessage, { type: 'snapshot' }>
    expect(snapshot.replayAvailable).toBe(true)
    expect(Buffer.byteLength(JSON.stringify(snapshot.events))).toBeLessThanOrEqual(8 * 1024 * 1024)
    const parts = snapshot.events.map((e) => ({ nested: e.type === 'child', event: e.type === 'child' ? e.event : e }))
    const deltas = parts.filter((p): p is { nested: boolean; event: RunDeltaEvent } => p.event.type === 'delta')
    expect(deltas[0]!.event.text).toBe('n'.repeat(10_000))
    const calls = deltas.filter((p) => p.event.kind === 'tool')
    expect(calls.map((p) => p.event.toolId)).toEqual(Array.from({ length: tools }, (_, i) => `t${i}`))
    const outputs = deltas.filter((p) => p.event.kind === 'tool_result')
    expect(outputs).toHaveLength(tools)
    const marker = '…[earlier output truncated]\n'
    // An output truncated mid-stream keeps growing until the next compaction.
    outputs.forEach((p, i) => {
      expect(p.event.text.endsWith(`end-${i}`)).toBe(true)
      if (p.event.text.length !== 100_000) expect(p.event.text.startsWith(marker)).toBe(true)
    })
    const shortOutputs = outputs.filter((p) => p.event.text.length <= marker.length + 4 * 1024)
    expect(shortOutputs.every((p) => p.event.text.startsWith(marker))).toBe(true)
    expect(shortOutputs.some((p) => p.nested) && shortOutputs.some((p) => !p.nested)).toBe(true)
    const bodies = calls.map((p) => ({ nested: p.nested, body: (p.event.toolInput!.files as { body: string }[])[0]!.body }))
    for (const { body } of bodies) expect(body === 'y'.repeat(3_000) || (body.length === 2 * 1024 && body.endsWith('…'))).toBe(true)
    const shortBodies = bodies.filter((b) => b.body.length !== 3_000)
    expect(shortBodies.some((b) => b.nested) && shortBodies.some((b) => !b.nested)).toBe(true)
    expect(calls[7]!.event.toolInput!.command).toBe('run 7')
  })

  it('never shortens an answerable permission ask or question while compacting', () => {
    const hub = createLiveRunHub(400_000)
    const run = hub.begin('u', 'c', 'r', [])
    const resource = 'w'.repeat(5_000)
    const label = 'q'.repeat(5_000)
    run.push({ type: 'delta', kind: 'tool', text: 'Permission', toolName: 'cinna_permission_request', toolId: 'per_1',
      toolInput: { action: 'Write', resources: [resource] } })
    run.push({ type: 'delta', kind: 'tool', text: 'Question', toolName: 'AskUserQuestion', toolId: 'que_1',
      toolInput: { questions: [{ question: 'Which?', options: [{ label }] }] } })
    run.push({ type: 'delta', kind: 'tool', text: 'Bash', toolName: 'bash', toolId: 't1', toolInput: { command: 'x'.repeat(5_000) } })
    // Fill past the cap so compaction must run.
    for (let i = 0; i < 40; i++) run.push({ type: 'delta', kind: 'tool_result', text: 'z'.repeat(10_000), toolId: `o${i}`, toolStream: 'stdout' })
    const late: RunWatchMessage[] = []
    hub.watch('u', 'c', (m) => late.push(m))
    const snapshot = late[0] as Extract<RunWatchMessage, { type: 'snapshot' }>
    expect(snapshot.replayAvailable).toBe(true)
    const calls = snapshot.events.filter((e): e is RunDeltaEvent => e.type === 'delta' && e.kind === 'tool')
    expect((calls[0]!.toolInput!.resources as string[])[0]).toBe(resource)
    expect(((calls[1]!.toolInput!.questions as { options: { label: string }[] }[])[0]!.options[0]!.label)).toBe(label)
    expect((calls[2]!.toolInput!.command as string).length).toBe(2 * 1024)
  })

  it('copies a tool input adopted from a later fragment, so mutating the original cannot grow the cache unaccounted', () => {
    const hub = createLiveRunHub(50_000)
    const run = hub.begin('u', 'c', 'r', [])
    run.push({ type: 'delta', kind: 'tool', text: 'Running', toolName: 'bash', toolId: 't1' })
    const input: Record<string, unknown> = { command: 'ls' }
    run.push({ type: 'delta', kind: 'tool', text: '…', toolName: 'bash', toolId: 't1', toolInput: input })
    input.command = 'y'.repeat(200_000)
    const late: RunWatchMessage[] = []
    hub.watch('u', 'c', (m) => late.push(m))
    const snapshot = late[0] as Extract<RunWatchMessage, { type: 'snapshot' }>
    const call = snapshot.events.find((e): e is RunDeltaEvent => e.type === 'delta' && e.kind === 'tool')
    expect(call!.toolInput!.command).toBe('ls')
  })
  it('logs once, with what filled the cache, when a run loses replay', () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    const hub = createLiveRunHub(200)
    const run = hub.begin('u', 'c', 'run-logged', [])
    run.push(delta('first'))
    run.push({ type: 'tool_result', id: 't', result: 'x'.repeat(300) })
    run.push({ type: 'tool_result', id: 't', result: 'x'.repeat(300) })
    const entries = getLogEntries().filter((e) => (e.data as { runId?: string } | undefined)?.runId === 'run-logged')
    expect(entries).toHaveLength(1)
    expect(entries[0]).toMatchObject({ level: 'warn', data: { reason: 'bytes', events: 2, types: { 'delta:text': 1, tool_result: 1 } } })
    vi.restoreAllMocks()
  })
  it('a cache serialization failure cannot stop the producer', () => {
    const hub = createLiveRunHub()
    const run = hub.begin('u', 'c', 'r', [])
    const circular: Record<string, unknown> = {}; circular.self = circular
    expect(() => run.push({ type: 'tool_result', id: 't', result: circular })).not.toThrow()
    expect(() => run.close()).not.toThrow()
  })
})

it('tells a watcher about a failed delivery before removing it', () => {
  const hub = createLiveRunHub()
  const received: RunWatchMessage[] = []
  hub.watch('u', 'c', (message) => {
    if (message.type === 'event') throw new Error('DataCloneError')
    received.push(message)
  })
  const run = hub.begin('u', 'c', 'r', [])
  run.push(delta('first'))
  expect(received.at(-1)).toMatchObject({ type: 'watch_error', runId: 'r' })
  const count = received.length
  run.push(delta('second'))
  expect(received).toHaveLength(count)
})
