import { describe, expect, it } from 'vitest'
import { createSessionActivityHub, ENDED_PER_KIND } from './sessionActivityHub'
import type { SessionActivityChange, SessionActivitySnapshot } from '../../shared/sessionActivity'

/** A hub on a clock that advances one second per reading, so every change has its own time. */
function setup() {
  let t = Date.UTC(2026, 8, 16, 12, 0, 0)
  const hub = createSessionActivityHub(() => new Date((t += 1000)))
  const events: Array<[string, SessionActivitySnapshot]> = []
  hub.onChange((chatId, snapshot) => events.push([chatId, snapshot]))
  return { hub, events }
}

const start = (id: string, kind: 'subagent' | 'background' = 'background', extra: Partial<SessionActivityChange> = {}): SessionActivityChange =>
  ({ type: 'upsert', id, kind, title: `title ${id}`, ...extra }) as SessionActivityChange
const end = (id: string, state: 'completed' | 'failed' | 'stopped' | 'lost' = 'completed', summary?: string | null): SessionActivityChange =>
  ({ type: 'end', id, state, summary })

const ids = (snapshot: SessionActivitySnapshot): string[] => snapshot.items.map((item) => item.id)

describe('session activity hub', () => {
  it('orders running items by start, then ended items most recently ended first', () => {
    const { hub } = setup()
    for (const id of ['a', 'b', 'c', 'd']) hub.report('chat', 'agent', start(id))
    hub.report('chat', 'agent', end('c'))
    hub.report('chat', 'agent', end('a'))
    expect(ids(hub.snapshot('chat'))).toEqual(['b', 'd', 'a', 'c'])
    const [b] = hub.snapshot('chat').items
    expect(b).toEqual({ id: 'b', kind: 'background', agentId: 'agent', title: 'title b', detail: null,
      state: 'running', startedAt: expect.any(Date), endedAt: null, outputPath: null, canStop: false })
  })

  it('answers an empty snapshot for a chat it knows nothing of', () => {
    expect(setup().hub.snapshot('nope')).toEqual({ chatId: 'nope', items: [] })
  })

  it('keeps at most the five most recently ended items of a kind', () => {
    const { hub } = setup()
    hub.report('chat', 'agent', start('keep-running'))
    for (let i = 0; i < ENDED_PER_KIND + 2; i++) {
      hub.report('chat', 'agent', start(`e${i}`))
      hub.report('chat', 'agent', end(`e${i}`))
    }
    expect(ids(hub.snapshot('chat'))).toEqual(['keep-running', 'e6', 'e5', 'e4', 'e3', 'e2'])
  })

  it('keeps a quiet kind\'s ended items until that kind starts again, and only that kind\'s', () => {
    const { hub } = setup()
    hub.report('chat', 'agent', start('bg1'))
    hub.report('chat', 'agent', start('bg2'))
    hub.report('chat', 'agent', start('sub1', 'subagent'))
    hub.report('chat', 'agent', end('bg1'))
    // Another background item still runs: the ended one stays.
    expect(ids(hub.snapshot('chat'))).toEqual(['bg2', 'sub1', 'bg1'])
    hub.report('chat', 'agent', end('bg2'))
    hub.report('chat', 'agent', end('sub1'))
    // Nothing runs; the ended items remain until their kind's next start.
    expect(ids(hub.snapshot('chat'))).toEqual(['sub1', 'bg2', 'bg1'])
    hub.report('chat', 'agent', start('bg3'))
    expect(ids(hub.snapshot('chat'))).toEqual(['bg3', 'sub1'])
    // A start while its kind already runs drops nothing.
    hub.report('chat', 'agent', end('bg3'))
    hub.report('chat', 'agent', start('bg4'))
    hub.report('chat', 'agent', start('bg5'))
    expect(ids(hub.snapshot('chat'))).toEqual(['bg4', 'bg5', 'sub1'])
  })

  it('lets a later terminal state correct an earlier one', () => {
    const { hub, events } = setup()
    hub.report('chat', 'agent', start('t', 'background', { detail: 'watch CI' }))
    hub.report('chat', 'agent', end('t', 'stopped'))
    const stoppedAt = hub.snapshot('chat').items[0]!.endedAt!
    hub.report('chat', 'agent', end('t', 'completed', 'exit 0'))
    const [item] = hub.snapshot('chat').items
    expect(item).toMatchObject({ state: 'completed', detail: 'exit 0' })
    expect(item!.endedAt!.getTime()).toBeGreaterThan(stoppedAt.getTime())
    expect(events).toHaveLength(3)
  })

  it('never moves an ended item back to running, and an end for an unknown id creates nothing', () => {
    const { hub, events } = setup()
    hub.report('chat', 'agent', end('ghost', 'failed'))
    expect(hub.snapshot('chat').items).toEqual([])
    expect(events).toEqual([])

    hub.report('chat', 'agent', start('t', 'background', { canStop: true }))
    hub.report('chat', 'agent', end('t', 'failed'))
    hub.report('chat', 'agent', start('t', 'background', { detail: 'late progress', canStop: true, outputPath: '/tmp/out' }))
    expect(hub.snapshot('chat').items[0]).toMatchObject({ state: 'failed', canStop: false, detail: 'late progress', outputPath: '/tmp/out' })
    expect(hub.hasRunning({ chatId: 'chat' })).toBe(false)
  })

  it('merges partial progress without overwriting a known field with nothing', () => {
    const { hub, events } = setup()
    hub.report('chat', 'agent', start('t', 'background', { detail: 'npm test', canStop: true }))
    hub.report('chat', 'agent', { type: 'upsert', id: 't', kind: 'background', outputPath: '/tmp/t.out' })
    hub.report('chat', 'agent', { type: 'upsert', id: 't', kind: 'background', title: '', detail: null, outputPath: undefined })
    expect(hub.snapshot('chat').items[0]).toMatchObject({ title: 'title t', detail: 'npm test', outputPath: '/tmp/t.out', canStop: true })
    // The last upsert changed nothing, so it announced nothing.
    expect(events).toHaveLength(2)
    hub.report('chat', 'agent', end('t', 'completed', null))
    expect(hub.snapshot('chat').items[0]).toMatchObject({ detail: 'npm test', state: 'completed' })
  })

  it('titles an item started without a name by its id', () => {
    const { hub } = setup()
    hub.report('chat', 'agent', { type: 'upsert', id: 'raw-id', kind: 'subagent' })
    expect(hub.snapshot('chat').items[0]!.title).toBe('raw-id')
  })

  it('ends running items by chat or by agent, lost by default, leaving ended ones alone', () => {
    const { hub, events } = setup()
    hub.report('c1', 'a1', start('x'))
    hub.report('c1', 'a1', start('done'))
    hub.report('c1', 'a1', end('done', 'completed'))
    hub.report('c1', 'a2', start('y', 'subagent'))
    hub.report('c2', 'a1', start('z'))
    events.length = 0

    hub.endAll({ agentId: 'a1' })
    expect(hub.snapshot('c1').items.map((i) => [i.id, i.state])).toEqual(
      [['y', 'running'], ['x', 'lost'], ['done', 'completed']])
    expect(hub.snapshot('c2').items[0]!.state).toBe('lost')
    expect(events.map(([chatId]) => chatId)).toEqual(['c1', 'c2'])

    events.length = 0
    hub.endAll({ chatId: 'c1' }, 'stopped')
    expect(hub.snapshot('c1').items.find((i) => i.id === 'y')!.state).toBe('stopped')
    expect(events.map(([chatId]) => chatId)).toEqual(['c1'])

    events.length = 0
    hub.endAll({})
    expect(events).toEqual([])
  })

  it('answers hasRunning by agent, by chat, and overall', () => {
    const { hub } = setup()
    expect(hub.hasRunning()).toBe(false)
    hub.report('c1', 'a1', start('x'))
    expect(hub.hasRunning()).toBe(true)
    expect(hub.hasRunning({ agentId: 'a1' })).toBe(true)
    expect(hub.hasRunning({ agentId: 'a2' })).toBe(false)
    expect(hub.hasRunning({ chatId: 'c2' })).toBe(false)
    expect(hub.hasRunning({ chatId: 'c1', agentId: 'a1' })).toBe(true)
    hub.report('c1', 'a1', end('x'))
    expect(hub.hasRunning({ agentId: 'a1' })).toBe(false)
  })

  it('tracks the last effective change per agent', () => {
    const { hub } = setup()
    expect(hub.lastChangeAt('a1')).toBeNull()
    hub.report('c1', 'a1', start('x', 'background', { detail: 'd' }))
    const first = hub.lastChangeAt('a1')!
    // A no-op report does not count as activity.
    hub.report('c1', 'a1', { type: 'upsert', id: 'x', kind: 'background', detail: 'd' })
    expect(hub.lastChangeAt('a1')).toEqual(first)
    hub.report('c1', 'a1', { type: 'upsert', id: 'x', kind: 'background', detail: 'e' })
    expect(hub.lastChangeAt('a1')!.getTime()).toBeGreaterThan(first.getTime())
    expect(hub.lastChangeAt('a2')).toBeNull()
  })

  it('announces each effective change exactly once, and a repeated end not at all', () => {
    const { hub, events } = setup()
    hub.report('c1', 'a1', start('x'))
    hub.report('c1', 'a1', start('x'))
    hub.report('c1', 'a1', end('x'))
    hub.report('c1', 'a1', end('x'))
    expect(events.map(([, s]) => s.items[0]!.state)).toEqual(['running', 'completed'])
    expect(events[0]![1].chatId).toBe('c1')
  })

  it('hands out copies, never its own items', () => {
    const { hub, events } = setup()
    hub.report('c1', 'a1', start('x'))
    const snapshot = hub.snapshot('c1')
    snapshot.items[0]!.state = 'failed'
    snapshot.items[0]!.startedAt.setTime(0)
    snapshot.items.pop()
    events[0]![1].items[0]!.title = 'mutated'
    const again = hub.snapshot('c1').items[0]!
    expect(again.state).toBe('running')
    expect(again.title).toBe('title x')
    expect(again.startedAt.getTime()).not.toBe(0)
  })

  it('stops calling an unsubscribed listener and survives a throwing one', () => {
    const { hub, events } = setup()
    const seen: string[] = []
    const off = hub.onChange((chatId) => seen.push(chatId))
    hub.onChange(() => { throw new Error('boom') })
    hub.report('c1', 'a1', start('x'))
    off()
    hub.report('c1', 'a1', end('x'))
    expect(seen).toEqual(['c1'])
    expect(events).toHaveLength(2)
  })

  it('clears a chat and announces the empty snapshot once', () => {
    const { hub, events } = setup()
    hub.report('c1', 'a1', start('x'))
    events.length = 0
    hub.clear('c1')
    hub.clear('c1')
    expect(events).toEqual([['c1', { chatId: 'c1', items: [] }]])
    expect(hub.hasRunning({ chatId: 'c1' })).toBe(false)
  })
})
