import { describe, expect, it } from 'vitest'
import type { ChatListSummary } from '../../../../shared/chatListSummary'
import { canStartChat, chatGroupCollapsedByDefault, dateBucket, groupChats, groupKeysOf, type ChatGroupFallback, type GroupableChat } from './chatGroups'

/** Local time, like the list: 26 Sep 2026, 00:10. */
const now = new Date(2026, 8, 26, 0, 10)
const on = (day: number, hour = 12): Date => new Date(2026, 8, day, hour)

const fallback: ChatGroupFallback = {
  agents: [
    { id: 'a-writer', name: 'Writer', source: 'local', driver: null, protocol: 'a2a' },
    { id: 'a-conductor', name: 'Claude', source: 'local', driver: 'acp', protocol: 'acp', conductor: true }
  ],
  modes: [{ id: 'm-plain', name: 'Plain', colorPreset: 'slate' }]
}

function summary(who: ChatListSummary['with'], last: Date | null): ChatListSummary {
  return { with: who, others: [], firstMessageAt: last, lastMessageAt: last, messageCount: last ? 2 : 0 }
}
const agent = (id: string, name: string): ChatListSummary['with'] => ({ kind: 'agent', name, color: null, agentId: id, source: 'local' })
const chat = (id: string, updatedAt: Date, extra: Partial<GroupableChat> = {}): GroupableChat => ({ id, updatedAt, ...extra })
const ids = (chats: GroupableChat[]): string[] => chats.map((c) => c.id)

describe('dateBucket', () => {
  it('counts local calendar days, not 24-hour spans', () => {
    expect(dateBucket(new Date(2026, 8, 26, 0, 0), now)).toBe('today')
    // Twenty minutes ago, but before midnight.
    expect(dateBucket(new Date(2026, 8, 25, 23, 50), now)).toBe('yesterday')
    expect(dateBucket(new Date(2026, 8, 25, 0, 0), now)).toBe('yesterday')
    expect(dateBucket(new Date(2026, 8, 24, 23, 59), now)).toBe('last-week')
  })

  it('keeps day 7 in Last Week and moves day 8 to Previous', () => {
    expect(dateBucket(on(19, 0), now)).toBe('last-week')
    expect(dateBucket(on(18, 23), now)).toBe('previous')
  })

  it('calls a date after now today', () => {
    expect(dateBucket(on(27), now)).toBe('today')
  })
})

describe('groupChats', () => {
  it('leaves the list as it is when neither is on', () => {
    const chats = [chat('b', on(20)), chat('a', on(26))]
    expect(groupChats(chats, {}, fallback, { byAgent: false, byDate: false }, now)).toEqual({ kind: 'flat', chats })
  })

  it('dates by the last message, not by the row, and omits empty days', () => {
    // Updated today (a rename, say), last spoken to eight days ago.
    const chats = [chat('renamed', on(26)), chat('fresh', on(26, 0))]
    const grouping = groupChats(chats, { renamed: summary(agent('a-1', 'A'), on(18)) }, fallback, { byAgent: false, byDate: true }, now)
    if (grouping.kind !== 'date') throw new Error(grouping.kind)
    expect(grouping.groups.map((g) => [g.key, ids(g.chats)])).toEqual([
      ['all|today', ['fresh']],
      ['all|previous', ['renamed']]
    ])
  })

  it('sorts inside a day by the date that placed it there', () => {
    const chats = [chat('early-message', on(26, 1)), chat('late-message', on(26, 0))]
    const grouping = groupChats(chats, {
      'early-message': summary(agent('a-1', 'A'), on(21, 8)),
      'late-message': summary(agent('a-1', 'A'), on(21, 20))
    }, fallback, { byAgent: false, byDate: true }, now)
    if (grouping.kind !== 'date') throw new Error(grouping.kind)
    expect(ids(grouping.groups[0].chats)).toEqual(['late-message', 'early-message'])
  })

  it('orders "who" groups by their most recent chat and nests days inside each', () => {
    const chats = [chat('b1', on(26, 0)), chat('a1', on(25)), chat('b2', on(10)), chat('m1', on(9), { modeId: 'm-plain' })]
    const summaries = {
      b1: summary(agent('b', 'Bee'), on(26, 0)),
      a1: summary(agent('a', 'Ay'), on(25)),
      b2: summary(agent('b', 'Bee'), on(10)),
      m1: summary({ kind: 'mode', name: 'Plain', color: 'slate', modeId: 'm-plain' }, on(9))
    }
    const grouping = groupChats(chats, summaries, fallback, { byAgent: true, byDate: true }, now)
    if (grouping.kind !== 'who') throw new Error(grouping.kind)
    expect(grouping.groups.map((g) => [g.key, g.who.name, g.dates?.map((d) => [d.key, ids(d.chats)])])).toEqual([
      ['agent:b', 'Bee', [['agent:b|today', ['b1']], ['agent:b|previous', ['b2']]]],
      ['agent:a', 'Ay', [['agent:a|yesterday', ['a1']]]],
      ['mode:m-plain', 'Plain', [['mode:m-plain|previous', ['m1']]]]
    ])
    expect(groupKeysOf(grouping, 'b2')).toEqual(['agent:b', 'agent:b|previous'])
  })

  it('groups a row with no summary by the renderer\'s lists, never by a conductor', () => {
    const chats = [
      chat('writer', on(26), { agentId: 'a-writer' }),
      chat('conducted', on(26), { agentId: 'a-conductor', modeId: 'm-plain' }),
      chat('bare', on(26), { agentId: 'a-conductor' }),
      chat('gone', on(26), { agentId: 'a-deleted', modeId: 'm-deleted' }),
      chat('named-none', on(26))
    ]
    const grouping = groupChats(chats, { 'named-none': summary({ kind: 'none', name: 'claude-sonnet', color: null }, null) }, fallback, { byAgent: true, byDate: false }, now)
    if (grouping.kind !== 'who') throw new Error(grouping.kind)
    expect(grouping.groups.map((g) => [g.key, g.who.kind, g.who.name, ids(g.chats)])).toEqual([
      ['agent:a-writer', 'agent', 'Writer', ['writer']],
      ['mode:m-plain', 'mode', 'Plain', ['conducted']],
      // A summary's "none" names the model; the group is just "Chat".
      ['none', 'none', 'Chat', ['bare', 'gone', 'named-none']]
    ])
    expect(grouping.groups[0].dates).toBeNull()
  })
})

describe('canStartChat', () => {
  const agents = [
    { id: 'folder:ok', source: 'folder', enabled: true },
    { id: 'folder:broken', source: 'folder', enabled: true },
    { id: 'folder:unscanned', source: 'folder', enabled: true },
    { id: 'a-off', source: 'local', enabled: false },
    { id: 'a-on', source: 'remote', enabled: true },
    { id: 'a-conductor', source: 'local', enabled: true, conductor: true }
  ]
  const folders = [{ id: 'folder:ok', readiness: 'credentials_needed' }, { id: 'folder:broken', readiness: 'invalid' }]
  const can = (id: string): boolean => canStartChat(agent(id, id), agents, folders)

  it('follows the Agents list: folder agents unless invalid, others when enabled, never one not listed', () => {
    expect(can('folder:ok')).toBe(true)
    expect(can('folder:broken')).toBe(false)
    // Until the local list has it, a folder agent is judged by its row.
    expect(can('folder:unscanned')).toBe(true)
    expect(can('a-off')).toBe(false)
    expect(can('a-on')).toBe(true)
    expect(can('a-conductor')).toBe(false)
    expect(can('a-deleted')).toBe(false)
  })

  it('always lets a mode or a plain chat start', () => {
    expect(canStartChat({ kind: 'mode', name: 'M', color: null, modeId: 'm' }, [], [])).toBe(true)
    expect(canStartChat({ kind: 'none', name: 'Chat', color: null }, undefined, undefined)).toBe(true)
  })
})

describe('chatGroupCollapsedByDefault', () => {
  it('closes Previous chats beside another day, and nothing else', () => {
    expect(chatGroupCollapsedByDefault({ key: 'all|previous', bucket: 'previous' }, 2)).toBe(true)
    expect(chatGroupCollapsedByDefault({ key: 'all|previous', bucket: 'previous' }, 1)).toBe(false)
    expect(chatGroupCollapsedByDefault({ key: 'all|today', bucket: 'today' }, 4)).toBe(false)
    expect(chatGroupCollapsedByDefault({ key: 'agent:a' }, 3)).toBe(false)
  })
})
