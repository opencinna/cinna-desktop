/**
 * The ACP activity provider: the recorded (and one code-derived) fixtures
 * read into hub items, the per-session registry and its child aliases, and
 * the Agent tool call written back into a Claude turn's stream.
 */
import { describe, expect, it, vi } from 'vitest'
import type { SessionNotification } from '@agentclientprotocol/sdk'
import type { SessionActivityChange, SessionActivityItem } from '../../../../shared/sessionActivity'
import { createSessionActivityHub } from '../../../services/sessionActivityHub'
import {
  createAcpActivityState,
  createSessionActivityRegistry,
  SubagentFrames,
  translateActivity
} from './acpActivity'
import { AcpMessageStream } from './acpMessages'
import type { AcpConnection } from './types'
import { KIND_METADATA_KEY, StreamPartsAccumulator, TOOL_ID_METADATA_KEY } from '../../streamPartsAccumulator'
import { beforeCapability, loadActivityFixture as load, type ActivityFixture as Fixture } from './testSupport/subagentFixtures'

const CHAT = 'chat-1'
const AGENT = 'agent-1'

/** Every notification translated into a fresh hub; the snapshot after each index on request. */
function replay(fixture: Fixture, owner = fixture.notifications[0].sessionId): {
  items: SessionActivityItem[]
  changes: SessionActivityChange[]
  at(index: number): SessionActivityItem[]
} {
  let clock = 0
  const hub = createSessionActivityHub(() => new Date(++clock))
  const state = createAcpActivityState()
  const changes: SessionActivityChange[] = []
  const history: SessionActivityItem[][] = []
  for (const notification of fixture.notifications) {
    for (const change of translateActivity(notification, state, owner)) {
      changes.push(change)
      hub.report(CHAT, AGENT, change)
    }
    history.push(hub.snapshot(CHAT).items)
  }
  return { items: hub.snapshot(CHAT).items, changes, at: (index) => history[index] }
}

const pick = (item: SessionActivityItem): Partial<SessionActivityItem> => ({
  id: item.id, kind: item.kind, title: item.title, detail: item.detail, state: item.state,
  outputPath: item.outputPath, canStop: item.canStop, agentId: item.agentId
})

describe('background tasks', () => {
  it('Claude: merges the output path from progress, and takes the later completed over stopped', () => {
    const fixture = load('claude', 'async_task_background_shell')
    const owner = fixture.notifications[0].sessionId
    const run = replay(fixture)
    const id = `${owner}:b4kbpenhz`
    const output = '/private/tmp/claude-501/-private-tmp-cinna-probe-c1/d954caa0-8df8-411f-a419-11040dfac5e1/tasks/b4kbpenhz.output'

    // The spawn: no path yet, and the description only repeats the name.
    expect(run.at(5).map(pick)).toEqual([{
      id, kind: 'background', title: 'Background sleep and echo command', detail: null, state: 'running',
      outputPath: null, canStop: true, agentId: AGENT
    }])
    // C6: the second progress carries the path.
    expect(run.at(8)[0]).toMatchObject({ state: 'running', outputPath: output })
    // C5: stopped (a liveness check), then the authoritative completed.
    expect(run.at(15)[0].state).toBe('stopped')
    expect(run.items.map(pick)).toEqual([{
      id, kind: 'background', title: 'Background sleep and echo command', detail: null, state: 'completed',
      outputPath: output, canStop: false, agentId: AGENT
    }])
  })

  it('Claude: a stopped task stays stopped', () => {
    const run = replay(load('claude', 'async_task_stop'))
    expect(run.items).toHaveLength(1)
    expect(run.items[0]).toMatchObject({ title: 'Sleep for 120 seconds in background', state: 'stopped' })
  })

  it('Codex: the command is the title, and the end arrives with no description or path', () => {
    const fixture = load('codex', 'async_task_background_terminal')
    const run = replay(fixture)
    expect(run.at(3).map(pick)).toEqual([{
      id: `${fixture.notifications[0].sessionId}:exec-d55ff8ab-5aaa-4c32-8823-f7f5de0dbd68`,
      kind: 'background', title: 'sleep 25 && echo probe-done', detail: null, state: 'running',
      outputPath: null, canStop: true, agentId: AGENT
    }])
    expect(run.items[0].state).toBe('completed')
  })

  it('Codex: a stopped terminal', () => {
    const run = replay(load('codex', 'async_task_stop'))
    expect(run.items.map((item) => [item.title, item.state])).toEqual([['sleep 120', 'stopped']])
  })

  const note = (update: Record<string, unknown>): SessionNotification =>
    ({ sessionId: 'ses', update }) as unknown as SessionNotification

  it('turns a progress summary into the detail, and ignores traffic for tasks it never saw', () => {
    const state = createAcpActivityState()
    expect(translateActivity(note({ sessionUpdate: 'async_task_progress', asyncTaskId: 't1', summary: 'x' }), state, 'ses')).toEqual([])
    expect(translateActivity(note({ sessionUpdate: 'async_task_state_update', asyncTaskId: 't1', state: 'completed' }), state, 'ses')).toEqual([])
    translateActivity(note({ sessionUpdate: 'async_task_spawned', asyncTaskId: 't1', name: 'npm test', description: 'Run the suite' }), state, 'ses')
    expect(translateActivity(note({ sessionUpdate: 'async_task_progress', asyncTaskId: 't1', summary: '12 passed' }), state, 'ses'))
      .toEqual([{ type: 'upsert', id: 'ses:t1', kind: 'background', detail: '12 passed', outputPath: null }])
    expect(translateActivity(note({ sessionUpdate: 'async_task_state_update', asyncTaskId: 't1', state: 'running', summary: 'half' }), state, 'ses'))
      .toEqual([{ type: 'upsert', id: 'ses:t1', kind: 'background', detail: 'half', outputPath: null }])
    expect(translateActivity(note({ sessionUpdate: 'async_task_state_update', asyncTaskId: 't1', state: 'failed', summary: 'exit 1' }), state, 'ses'))
      .toEqual([{ type: 'end', id: 'ses:t1', state: 'failed', summary: 'exit 1' }])
  })

  it.each([
    ['killed', 'stopped'], ['cancelled', 'stopped'], ['stopped', 'stopped'], ['exploded', 'lost']
  ])('maps the task state %s to %s', (wire, expected) => {
    const state = createAcpActivityState()
    translateActivity(note({ sessionUpdate: 'async_task_spawned', asyncTaskId: 't', name: 'x' }), state, 'o')
    expect(translateActivity(note({ sessionUpdate: 'async_task_state_update', asyncTaskId: 't', state: wire }), state, 'o'))
      .toEqual([{ type: 'end', id: 'o:t', state: expected }])
  })

  it.each([
    ['completed', 'completed'], ['failed', 'failed'], ['disconnected', 'lost'], ['cancelled', 'stopped'], ['odd', 'lost']
  ])('maps the subagent state %s to %s (C6)', (wire, expected) => {
    const state = createAcpActivityState()
    translateActivity(note({ sessionUpdate: 'subagent_spawned', subagentSessionId: 'c', name: 'n', task: 't' }), state, 'o')
    expect(translateActivity(note({ sessionUpdate: 'subagent_state_update', subagentSessionId: 'c', state: wire }), state, 'o'))
      .toEqual([{ type: 'end', id: 'o:c', state: expected }])
  })
})

describe('subagents', () => {
  it.each(['subagent_sync', 'subagent_background'])('Claude %s: one item, named and tasked, completed', (name) => {
    const fixture = load('claude', name)
    const spawn = fixture.notifications[0]
    const update = spawn.update as unknown as { subagentSessionId: string; name: string; task: string }
    const run = replay(fixture)
    expect(run.at(0).map(pick)).toEqual([{
      id: `${spawn.sessionId}:${update.subagentSessionId}`, kind: 'subagent', title: update.name, detail: update.task,
      state: 'running', outputPath: null, canStop: false, agentId: AGENT
    }])
    expect(run.items.map((item) => item.state)).toEqual(['completed'])
  })

  it('Codex with native sessions (recorded, not advertised): read the same way', () => {
    const run = replay(load('codex', 'subagent'))
    expect(run.items.map((item) => [item.title, item.state])).toEqual([['Echo probe', 'completed']])
  })

  it('Codex without native sessions: derived from the root session’s subagent activity calls', () => {
    const fixture = load('codex', 'subagent_nocaps')
    const root = fixture.notifications[0].sessionId
    const run = replay(fixture)
    const started = fixture.notifications.findIndex((n) => (n.update as { toolCallId?: string }).toolCallId === 'call_PByelmehd63j0DIzDuhMqBqy')
    expect(run.at(started).map(pick)).toEqual([{
      id: `${root}:01a0ac6b-b956-75f2-a9aa-990c4307d02a`, kind: 'subagent', title: 'shell_probe', detail: null,
      state: 'running', outputPath: null, canStop: false, agentId: AGENT
    }])
    // Still running while the model waits; the "Complete subagent" call ends it.
    expect(run.at(started + 3)[0].state).toBe('running')
    expect(run.items.map((item) => [item.title, item.state])).toEqual([['shell_probe', 'completed']])
  })

  it('Codex collaboration calls (derived from adapter code): spawn names the child, agentsStates end it', () => {
    const fixture = load('codex', 'subagent_collab')
    const run = replay(fixture)
    expect(run.at(1).map((item) => [item.title, item.detail, item.state])).toEqual([['Subagent', 'Run the tests', 'running']])
    expect(run.at(2)[0].state).toBe('running')
    expect(run.items.map((item) => item.state)).toEqual(['completed'])
  })

  it('a Codex subagent of the root path, or an unknown thread, is nothing', () => {
    const state = createAcpActivityState()
    const call = (activity: string, path: string): SessionNotification => ({
      sessionId: 'r',
      update: { sessionUpdate: 'tool_call', toolCallId: `c-${activity}`, _meta: { codex: { subagent: { threadId: 't', path, activity } } } }
    }) as unknown as SessionNotification
    expect(translateActivity(call('started', '/root'), state, 'r')).toEqual([])
    expect(translateActivity(call('completed', '/root/x'), state, 'r')).toEqual([])
    expect(translateActivity(call('interrupted', '/root/x'), state, 'r')).toEqual([])
    expect(translateActivity(call('started', '/root/x'), state, 'r')).toEqual([{ type: 'upsert', id: 'r:t', kind: 'subagent', title: 'x' }])
    expect(translateActivity(call('interrupted', '/root/x'), state, 'r')).toEqual([{ type: 'end', id: 'r:t', state: 'stopped' }])
  })
})

/* ---------------------------------------------------------------- registry */

function fakeConnection(): AcpConnection & { aliases: Map<string, string>; exit(): void } {
  const aliases = new Map<string, string>()
  let exit!: () => void
  const exited = new Promise<{ code: null; signal: null; stderrTail: string }>((resolve) => {
    exit = () => resolve({ code: null, signal: null, stderrTail: '' })
  })
  return {
    aliases,
    exit,
    exited,
    aliasSession: (child: string, parent: string) => {
      aliases.set(child, parent)
      return () => { if (aliases.get(child) === parent) aliases.delete(child) }
    }
  } as unknown as AcpConnection & { aliases: Map<string, string>; exit(): void }
}

describe('the session activity registry', () => {
  const spawned = (parent: string, child: string): SessionNotification => ({
    sessionId: parent,
    update: { sessionUpdate: 'subagent_spawned', subagentSessionId: child, name: 'helper', task: 'look around' }
  }) as unknown as SessionNotification

  it('reports each notification object once, under the session’s current chat and agent', () => {
    const report = vi.fn()
    const registry = createSessionActivityRegistry({ report })
    const connection = fakeConnection()
    const feed = registry.session(connection, 'parent', { chatId: CHAT, agentId: AGENT })
    const n = spawned('parent', 'child')
    feed.observe(n)
    feed.observe(n)
    expect(report).toHaveBeenCalledTimes(1)
    expect(report).toHaveBeenCalledWith(CHAT, AGENT, expect.objectContaining({ type: 'upsert', id: 'parent:child' }))
    registry.session(connection, 'parent', { chatId: 'chat-2', agentId: AGENT }).observe({
      sessionId: 'parent', update: { sessionUpdate: 'subagent_state_update', subagentSessionId: 'child', state: 'completed' }
    } as unknown as SessionNotification)
    expect(report).toHaveBeenLastCalledWith('chat-2', AGENT, { type: 'end', id: 'parent:child', state: 'completed' })
  })

  it('routes a spawned child to its parent, and forgetting the chat drops the route', () => {
    const registry = createSessionActivityRegistry()
    const connection = fakeConnection()
    const feed = registry.session(connection, 'parent', { chatId: CHAT, agentId: AGENT })
    feed.observe(spawned('parent', 'child'))

    expect(connection.aliases).toEqual(new Map([['child', 'parent']]))
    expect(registry.lookup(connection, 'child')).toBe(feed)
    expect(registry.lookup(connection, 'parent')).toBe(feed)
    expect(feed.subagent('child')).toEqual({ name: 'helper', task: 'look around' })

    registry.forgetChat('other-chat')
    expect(connection.aliases.size).toBe(1)
    registry.forgetChat(CHAT, 'other-agent')
    expect(connection.aliases.size).toBe(1)
    registry.forgetChat(CHAT, AGENT)
    expect(connection.aliases.size).toBe(0)
    expect(registry.lookup(connection, 'child')).toBeUndefined()
    expect(registry.lookup(connection, 'parent')).toBeUndefined()
  })

  it('closes a connection’s sessions when its process exits', async () => {
    const registry = createSessionActivityRegistry()
    const connection = fakeConnection()
    registry.session(connection, 'parent', { chatId: CHAT, agentId: AGENT }).observe(spawned('parent', 'child'))
    connection.exit()
    await vi.waitFor(() => expect(connection.aliases.size).toBe(0))
    expect(registry.lookup(connection, 'child')).toBeUndefined()
  })

  it('a reporter that throws does not stop the routing', () => {
    const registry = createSessionActivityRegistry({ report: () => { throw new Error('boom') } })
    const connection = fakeConnection()
    registry.session(connection, 'parent', { chatId: CHAT, agentId: AGENT }).observe(spawned('parent', 'child'))
    expect(connection.aliases.get('child')).toBe('parent')
  })
})

/* ------------------------------------------------------- Agent tool call */

/** The frames folded into one stream, the messages it ended with. */
function fold(frames: SessionNotification[]): Map<string, unknown> {
  const stream = new AcpMessageStream({ launcher: 'claude' })
  const messages = new Map<string, unknown>()
  for (const frame of frames) {
    const { message } = stream.apply(frame)
    if (message) messages.set(message.messageId ?? '', structuredClone(message.parts))
  }
  return messages
}

describe('the Agent tool call a Claude parent no longer receives', () => {
  /** The capability run, as the driver folds it: routed child frames, expanded. */
  function after(fixture: Fixture): SessionNotification[] {
    const registry = createSessionActivityRegistry()
    const connection = fakeConnection()
    const parent = fixture.notifications[0].sessionId
    const frames = new SubagentFrames((id) => registry.lookup(connection, id))
    const out: SessionNotification[] = []
    for (const n of fixture.notifications) {
      ;(registry.lookup(connection, n.sessionId) ?? registry.session(connection, n.sessionId, { chatId: CHAT, agentId: AGENT })).observe(n)
      out.push(...frames.expand(n))
    }
    expect(parent).toBeTruthy()
    return out
  }

  it('sync: the transcript is the one the pre-capability stream produced', () => {
    const fixture = load('claude', 'subagent_sync')
    const parent = fixture.notifications[0].sessionId
    const report = 'The exact output of the command is:\n\n```\nsub-sync-ok\n```'
    expect(fold(after(fixture))).toEqual(fold(beforeCapability(fixture, parent, report)))
  })

  it('sync: the synthesized start comes before the child’s first tool call, and the call ends completed', () => {
    const frames = after(load('claude', 'subagent_sync'))
    const ids = frames
      .map((f) => f.update as { sessionUpdate: string; toolCallId?: string; status?: string })
      .filter((u) => u.sessionUpdate === 'tool_call')
      .map((u) => u.toolCallId)
    expect(ids).toEqual(['toolu_01RRGBmgwcNPmr51QLspi7QS', 'toolu_01K16sjQVEFr54u5UiQVxN2x'])
    const agentStatuses = frames
      .map((f) => f.update as { toolCallId?: string; status?: string })
      .filter((u) => u.toolCallId === 'toolu_01RRGBmgwcNPmr51QLspi7QS' && u.status)
      .map((u) => u.status)
    expect(agentStatuses.at(-1)).toBe('completed')
  })

  it('background: the same, apart from the launch notice the CLI wrote and the wire does not carry', () => {
    const fixture = load('claude', 'subagent_background')
    const parent = fixture.notifications[0].sessionId
    const withNotice = fold(beforeCapability(fixture, parent, 'Async agent launched successfully.'))
    const ours = fold(after(fixture))
    const withoutResult = (messages: Map<string, unknown>): Map<string, unknown> => new Map(
      [...messages].map(([id, parts]) => [id, (parts as { metadata?: Record<string, unknown> }[])
        .filter((part) => !(part.metadata?.[KIND_METADATA_KEY] === 'tool_result' && part.metadata?.[TOOL_ID_METADATA_KEY] === 'toolu_01KpzsEJcDiD2HbfUzc62uVd'))])
    )
    expect(withoutResult(ours)).toEqual(withoutResult(withNotice))
    expect(JSON.stringify([...ours])).not.toContain('Async agent launched')
    // The call ended when it was launched, as it did before.
    const statuses = after(fixture)
      .map((f) => f.update as { toolCallId?: string; status?: string })
      .filter((u) => u.toolCallId === 'toolu_01KpzsEJcDiD2HbfUzc62uVd' && u.status)
      .map((u) => u.status)
    expect(statuses).toEqual(['pending', 'completed'])
  })

  it('leaves a call the agent announced alone', () => {
    const frames = new SubagentFrames(() => undefined)
    const start = { sessionId: 'p', update: { sessionUpdate: 'tool_call', toolCallId: 'a', title: 'x', _meta: { claudeCode: { toolName: 'Agent' } } } } as unknown as SessionNotification
    const hook = { sessionId: 'p', update: { sessionUpdate: 'tool_call_update', toolCallId: 'a', _meta: { claudeCode: { toolName: 'Agent', toolResponse: { status: 'completed', content: [{ type: 'text', text: 'r' }] } } } } } as unknown as SessionNotification
    expect(frames.expand(start)).toEqual([start])
    expect(frames.expand(hook)).toEqual([hook])
  })

  it('closes a synthesized call when its subagent ends first', () => {
    const registry = createSessionActivityRegistry()
    const connection = fakeConnection()
    const feed = registry.session(connection, 'p', { chatId: CHAT, agentId: AGENT })
    const frames = new SubagentFrames((id) => registry.lookup(connection, id))
    const spawn = { sessionId: 'p', update: { sessionUpdate: 'subagent_spawned', subagentSessionId: 'c', name: 'n', task: 't' } } as unknown as SessionNotification
    const childFrame = { sessionId: 'c', update: { sessionUpdate: 'agent_message_chunk', messageId: 'm', content: { type: 'text', text: 'hi' }, _meta: { claudeCode: { parentToolUseId: 'call' } } } } as unknown as SessionNotification
    const failed = { sessionId: 'p', update: { sessionUpdate: 'subagent_state_update', subagentSessionId: 'c', state: 'failed' } } as unknown as SessionNotification
    feed.observe(spawn)
    frames.expand(spawn)
    expect(frames.expand(childFrame).map((f) => (f.update as { sessionUpdate: string }).sessionUpdate)).toEqual(['tool_call', 'agent_message_chunk'])
    const out = frames.expand(failed)
    expect(out.map((f) => f.update as { sessionUpdate: string; status?: string }).map((u) => [u.sessionUpdate, u.status]))
      .toEqual([['subagent_state_update', undefined], ['tool_call_update', 'failed']])
    expect(out[1].sessionId).toBe('p')
  })
})

/* ------------------------------------------------------ review fix round */

const n = (sessionId: string, update: Record<string, unknown>): SessionNotification =>
  ({ sessionId, update }) as unknown as SessionNotification

/** A `setTimer` that never fires on its own, so a test decides when time passes. */
function fakeTimers(): {
  setTimer: (fn: () => void, ms: number) => unknown
  clearTimer: (handle: unknown) => void
  pending: { fn: () => void; ms: number; cleared: boolean }[]
  fire(): void
} {
  const pending: { fn: () => void; ms: number; cleared: boolean }[] = []
  return {
    pending,
    setTimer: (fn, ms) => {
      const entry = { fn, ms, cleared: false }
      pending.push(entry)
      return entry
    },
    clearTimer: (handle) => {
      ;(handle as { cleared: boolean }).cleared = true
    },
    fire: () => {
      for (const entry of pending.filter((e) => !e.cleared)) {
        entry.cleared = true
        entry.fn()
      }
    }
  }
}

/** A parent `p` that spawned child `c`, and one turn's frames over it. */
function parentWithChild(): {
  registry: ReturnType<typeof createSessionActivityRegistry>
  connection: ReturnType<typeof fakeConnection>
  turn(): { expand(notification: SessionNotification): SessionNotification[] }
} {
  const registry = createSessionActivityRegistry()
  const connection = fakeConnection()
  const feed = registry.session(connection, 'p', { chatId: CHAT, agentId: AGENT })
  feed.observe(n('p', { sessionUpdate: 'subagent_spawned', subagentSessionId: 'c', name: 'helper', task: 'look around' }))
  const turn = (): { expand(notification: SessionNotification): SessionNotification[] } => {
    const frames = new SubagentFrames((id) => registry.lookup(connection, id))
    return {
      expand: (notification) => {
        ;(registry.lookup(connection, notification.sessionId) ?? feed).observe(notification)
        return frames.expand(notification)
      }
    }
  }
  return { registry, connection, turn }
}

const childChunk = (text: string): SessionNotification => n('c', {
  sessionUpdate: 'agent_message_chunk', messageId: `m-${text}`, content: { type: 'text', text },
  _meta: { claudeCode: { parentToolUseId: 'call' } }
})
const stateUpdate = (state: string): SessionNotification =>
  n('p', { sessionUpdate: 'subagent_state_update', subagentSessionId: 'c', state })
const shape = (frames: SessionNotification[]): unknown[] =>
  frames.map((f) => f.update as { sessionUpdate: string; toolCallId?: string; status?: string })
    .map((u) => [u.sessionUpdate, u.toolCallId, u.status])

describe('a subagent that does not complete (review fix 1)', () => {
  it.each(['failed', 'cancelled', 'disconnected'])('(a) %s closes its open Agent call as failed', (state) => {
    const { turn } = parentWithChild()
    const t = turn()
    t.expand(childChunk('hi'))
    expect(shape(t.expand(stateUpdate(state)))).toEqual([
      ['subagent_state_update', undefined, undefined],
      ['tool_call_update', 'call', 'failed']
    ])
  })

  it.each([
    ['failed', 'Subagent failed.'], ['cancelled', 'Subagent stopped.'], ['disconnected', 'Subagent disconnected.']
  ])('(b) %s leaves "%s" in the transcript', (state, note) => {
    const { turn } = parentWithChild()
    const t = turn()
    const frames = [...t.expand(childChunk('hi')), ...t.expand(stateUpdate(state))]
    const ended = frames.at(-1)!.update as { content?: { content: { text: string } }[] }
    expect(ended.content?.map((block) => block.content.text)).toEqual([note])
    expect(JSON.stringify([...fold(frames)])).toContain(note)
  })

  it('(b) a completed subagent adds no line', () => {
    const { turn } = parentWithChild()
    const t = turn()
    t.expand(childChunk('hi'))
    const ended = t.expand(stateUpdate('completed')).at(-1)!.update as { status?: string; content?: unknown }
    expect(ended).toMatchObject({ status: 'completed' })
    expect(ended.content).toBeUndefined()
  })

  it('(c) a subagent that fails before sending anything still gets its Agent block', () => {
    const { turn } = parentWithChild()
    const t = turn()
    const frames = t.expand(stateUpdate('failed'))
    expect(shape(frames)).toEqual([
      ['subagent_state_update', undefined, undefined],
      ['tool_call', 'subagent:c', 'pending'],
      ['tool_call_update', 'subagent:c', 'failed']
    ])
    expect(frames[1]).toMatchObject({ sessionId: 'p', update: { title: 'helper', rawInput: { description: 'helper', prompt: 'look around' } } })
    const parts = [...fold(frames).values()].flat() as { text?: string; metadata?: Record<string, unknown> }[]
    expect(parts.some((part) => part.metadata?.[KIND_METADATA_KEY] === 'tool' && part.metadata?.[TOOL_ID_METADATA_KEY] === 'subagent:c')).toBe(true)
    expect(JSON.stringify(parts)).toContain('Subagent failed.')
    // A repeated end adds nothing.
    expect(shape(t.expand(stateUpdate('failed')))).toEqual([['subagent_state_update', undefined, undefined]])
  })

  it('(c) not for a completed subagent, whose hook update names the real call', () => {
    const { turn } = parentWithChild()
    expect(shape(turn().expand(stateUpdate('completed')))).toEqual([['subagent_state_update', undefined, undefined]])
  })
})

describe('a Codex subagent that runs again (review fix 2)', () => {
  // The old item gets no change: only the new run's id is written to.
  const call = (id: string, activity: string): SessionNotification => n('r', {
    sessionUpdate: 'tool_call', toolCallId: id, _meta: { codex: { subagent: { threadId: 't', path: '/root/helper', activity } } }
  })

  it('a message after its end starts a new item, and leaves the ended one alone', () => {
    const hub = createSessionActivityHub()
    const state = createAcpActivityState()
    const feed = (notification: SessionNotification): SessionActivityChange[] => {
      const changes = translateActivity(notification, state, 'r')
      for (const change of changes) hub.report(CHAT, AGENT, change)
      return changes
    }
    feed(call('1', 'started'))
    // Interacting with a running subagent is the same run.
    expect(feed(call('2', 'interacted'))).toEqual([{ type: 'upsert', id: 'r:t', kind: 'subagent', title: 'helper' }])
    feed(call('3', 'completed'))
    expect(feed(call('4', 'interacted'))).toEqual([{ type: 'upsert', id: 'r:t#2', kind: 'subagent', title: 'helper' }])
    // The badge shows it running again (the hub's retention decides what stays of the ended run).
    expect(hub.snapshot(CHAT).items.find((item) => item.id === 'r:t#2')?.state).toBe('running')
    expect(feed(call('5', 'interrupted'))).toEqual([{ type: 'end', id: 'r:t#2', state: 'stopped' }])
    expect(feed(call('6', 'interacted'))[0]).toMatchObject({ id: 'r:t#3' })
    expect(hub.snapshot(CHAT).items.find((item) => item.id === 'r:t#3')?.state).toBe('running')
  })
})

describe('an ended subagent is forgotten (review fix 3)', () => {
  function setup(): {
    registry: ReturnType<typeof createSessionActivityRegistry>
    connection: ReturnType<typeof fakeConnection>
    feed: ReturnType<ReturnType<typeof createSessionActivityRegistry>['session']>
    timers: ReturnType<typeof fakeTimers>
  } {
    const timers = fakeTimers()
    const registry = createSessionActivityRegistry(undefined, { setTimer: timers.setTimer, clearTimer: timers.clearTimer })
    const connection = fakeConnection()
    const feed = registry.session(connection, 'p', { chatId: CHAT, agentId: AGENT })
    feed.observe(n('p', { sessionUpdate: 'subagent_spawned', subagentSessionId: 'c', name: 'helper', task: 'x' }))
    return { registry, connection, feed, timers }
  }

  it('drops its route, spawn info and call link 30 s after its terminal state', () => {
    const { registry, connection, feed, timers } = setup()
    feed.agentCalls.callOfChild.set('c', 'call')
    feed.observe(stateUpdate('running'))
    expect(timers.pending).toHaveLength(0)
    feed.observe(stateUpdate('completed'))
    expect(timers.pending.map((t) => t.ms)).toEqual([30_000])
    // Still there during the grace: the hook update follows the end.
    expect(registry.lookup(connection, 'c')).toBe(feed)
    expect(feed.subagent('c')).toBeDefined()

    timers.fire()
    expect(connection.aliases.size).toBe(0)
    expect(registry.lookup(connection, 'c')).toBeUndefined()
    expect(registry.lookup(connection, 'p')).toBe(feed)
    expect(feed.subagent('c')).toBeUndefined()
    expect(feed.agentCalls.callOfChild.size).toBe(0)
  })

  it('close clears the pending timers', () => {
    const { registry, feed, timers } = setup()
    feed.observe(stateUpdate('failed'))
    registry.forgetChat(CHAT)
    expect(timers.pending.every((t) => t.cleared)).toBe(true)
  })
})

describe('an Agent call is announced once per session (review fix 4)', () => {
  it('a later turn does not announce the call an earlier turn synthesized', () => {
    const { turn } = parentWithChild()
    const first = turn()
    expect(shape(first.expand(childChunk('one')))).toEqual([
      ['tool_call', 'call', 'pending'],
      ['agent_message_chunk', undefined, undefined]
    ])
    // The prompt returned on a Stop; the subagent streams on into a follow-up turn.
    const followUp = turn()
    expect(shape(followUp.expand(childChunk('two')))).toEqual([['agent_message_chunk', undefined, undefined]])
    const hook = n('p', {
      sessionUpdate: 'tool_call_update', toolCallId: 'call',
      _meta: { claudeCode: { toolName: 'Agent', toolResponse: { status: 'completed', agentId: 'c', content: [] } } }
    })
    expect(shape(followUp.expand(hook))).toEqual([['tool_call_update', 'call', undefined]])
    // Nor does a failed end open a placeholder for a child linked earlier.
    expect(shape(followUp.expand(stateUpdate('failed')))).toEqual([['subagent_state_update', undefined, undefined]])
  })
})

describe('the parent’s messages around a background subagent (lanes)', () => {
  it('keep two parent messages two parts when only subagent parts came between them', () => {
    // The real run: "launched" (msg …uFi), the subagent's Bash and report, then
    // "Command completed: sub-ok" (msg …zUd6). The lane-skip must not glue them.
    const fixture = load('claude', 'subagent_background')
    const registry = createSessionActivityRegistry()
    const connection = fakeConnection()
    const frames = new SubagentFrames((id) => registry.lookup(connection, id))
    const stream = new AcpMessageStream({ launcher: 'claude' })
    const accumulator = new StreamPartsAccumulator()
    const deltas: { kind: string; text: string; parentToolId?: string; newPart?: true }[] = []
    const port = { postMessage: (d: (typeof deltas)[number]): void => { deltas.push(d) } }
    for (const n of fixture.notifications) {
      ;(registry.lookup(connection, n.sessionId) ?? registry.session(connection, n.sessionId, { chatId: CHAT, agentId: AGENT })).observe(n)
      for (const frame of frames.expand(n)) {
        const { message } = stream.apply(frame)
        if (message) accumulator.ingestMessage(message, port)
      }
    }
    const own = accumulator.snapshotParts().filter((p) => p.kind === 'text' && !p.parentToolId).map((p) => p.text)
    expect(own.some((t) => t.includes('launched') && t.includes('Command completed'))).toBe(false)
    expect(own.filter((t) => t.includes('Command completed: sub-ok'))).toHaveLength(1)
    expect(accumulator.snapshotParts().some((p) => p.parentToolId)).toBe(true)
    // The renderer is told the same thing: the second message's first delta opens a part.
    const ownDeltas = deltas.filter((d) => d.kind === 'text' && !d.parentToolId)
    expect(ownDeltas.map((d) => [d.text, d.newPart])).toEqual([
      ['launched', undefined], ['Command', true], [' completed:', undefined], [' sub', undefined], ['-ok', undefined]
    ])
  })
})
