import { describe, expect, it } from 'vitest'
import type { ChatListSummary } from '../../../../shared/chatListSummary'
import { canStartChat, chatGroupCollapsedByDefault, dateBucket, dayRank, dropRank, groupChats, groupKeysOf, isActiveChat, listRank, pinnedChats, pinnedRank, rankBetween, settleActiveIds, tieBreak, type ChatGroupFallback, type GroupableChat } from './chatGroups'

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
  it('is one flat list when neither is on, most recent first', () => {
    const chats = [chat('b', on(20)), chat('a', on(26))]
    expect(groupChats(chats, {}, fallback, { byAgent: false, byDate: false }, now)).toEqual({ kind: 'flat', chats: [chats[1], chats[0]] })
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
      chat('writer', on(26, 12), { agentId: 'a-writer' }),
      chat('conducted', on(26, 11), { agentId: 'a-conductor', modeId: 'm-plain' }),
      chat('bare', on(26, 10), { agentId: 'a-conductor' }),
      chat('gone', on(26, 9), { agentId: 'a-deleted', modeId: 'm-deleted' }),
      chat('named-none', on(26, 8))
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

describe('drag order and Pinned', () => {
  const flat = (chats: GroupableChat[]): string[] => {
    const grouping = groupChats(chats, {}, fallback, { byAgent: false, byDate: false }, now)
    if (grouping.kind !== 'flat') throw new Error(grouping.kind)
    return ids(grouping.chats)
  }

  it('sorts by the dragged place where there is one, else by recency', () => {
    // Dragged between 25 and 22 at some point; then 24 and 26 saw activity.
    const dragged = chat('dragged', on(10), { sortKey: (on(25).getTime() + on(22).getTime()) / 2 })
    expect(flat([chat('c26', on(26)), chat('c24', on(24)), dragged, chat('c22', on(22)), chat('c20', on(20))]))
      .toEqual(['c26', 'c24', 'dragged', 'c22', 'c20'])
  })

  it('holds a dragged chat\'s place against newer activity, while the rest follow recency', () => {
    const top = chat('top', on(20), { sortKey: on(24).getTime() + 1 })
    // Activity after the drop: a newer chat passes it, and the dragged chat's
    // own activity does not move it.
    expect(flat([chat('newer', on(26)), { ...top, updatedAt: on(26, 13) }, chat('old', on(24))])).toEqual(['newer', 'top', 'old'])
  })

  it('never lets a sort key move a chat into another day', () => {
    const chats = [chat('old', on(10), { sortKey: on(26, 23).getTime() }), chat('today', on(26, 0))]
    const grouping = groupChats(chats, {}, fallback, { byAgent: false, byDate: true }, now)
    if (grouping.kind !== 'date') throw new Error(grouping.kind)
    expect(grouping.groups.map((g) => [g.key, ids(g.chats)])).toEqual([['all|today', ['today']], ['all|previous', ['old']]])
  })

  it('sorts inside a day by the dragged place, else the last message', () => {
    const chats = [chat('a', on(26, 0)), chat('b', on(26, 0)), chat('c', on(26, 0))]
    const summaries = { a: summary(agent('x', 'X'), on(21, 20)), b: summary(agent('x', 'X'), on(21, 10)), c: summary(agent('x', 'X'), on(21, 8)) }
    const moved = { ...chats[2], sortKey: on(21, 20).getTime() + 1 }
    const grouping = groupChats([chats[0], chats[1], moved], summaries, fallback, { byAgent: false, byDate: true }, now)
    if (grouping.kind !== 'date') throw new Error(grouping.kind)
    expect(grouping.groups.map((g) => [g.key, ids(g.chats)])).toEqual([['all|last-week', ['c', 'a', 'b']]])
    expect(Math.floor(dayRank(chats[1], summaries.b))).toBe(on(21, 10).getTime())
  })

  it('orders "who" groups by activity, so a drag inside a group never moves the group', () => {
    // A: a1 10:00, a2 08:00; B: b1 09:00. a1 dragged below a2.
    const a2 = chat('a2', on(25, 8), { agentId: 'a-writer' })
    const a1 = chat('a1', on(25, 10), { agentId: 'a-writer', sortKey: listRank(a2) - 1 })
    const b1 = chat('b1', on(25, 9), { modeId: 'm-plain' })
    for (const byDate of [false, true]) {
      const grouping = groupChats([a1, b1, a2], {}, fallback, { byAgent: true, byDate }, now)
      if (grouping.kind !== 'who') throw new Error(grouping.kind)
      expect(grouping.groups.map((g) => [g.key, ids(g.chats)])).toEqual([
        ['agent:a-writer', ['a2', 'a1']],
        ['mode:m-plain', ['b1']]
      ])
    }
  })

  it('takes pinned chats out of the grouping and lists them flat, highest rank first', () => {
    const chats = [chat('p-low', on(26), { pinnedRank: 1, agentId: 'a-writer' }), chat('free', on(25)), chat('p-high', on(10), { pinnedRank: 2.5 })]
    for (const options of [{ byAgent: false, byDate: false }, { byAgent: true, byDate: true }, { byAgent: false, byDate: true }]) {
      const grouping = groupChats(chats, {}, fallback, options, now)
      const listed = grouping.kind === 'flat' ? grouping.chats
        : grouping.kind === 'date' ? grouping.groups.flatMap((g) => g.chats)
          : grouping.groups.flatMap((g) => g.chats)
      expect(ids(listed)).toEqual(['free'])
    }
    expect(ids(pinnedChats(chats))).toEqual(['p-high', 'p-low'])
    expect(pinnedRank(chats[2])).toBe(2.5)
    expect(Math.floor(listRank(chats[1]))).toBe(on(25).getTime())
  })
})

describe('tieBreak', () => {
  it('orders chats of the same second, the same way every time, and stays under a millisecond', () => {
    const same = ['x1', 'x2', 'x3', 'x4'].map((id) => chat(id, on(26)))
    const ranks = same.map(listRank)
    expect(new Set(ranks).size).toBe(4)
    for (const rank of ranks) expect(Math.floor(rank)).toBe(on(26).getTime())
    expect(same.map(listRank)).toEqual(ranks)
    expect(tieBreak('x1')).toBeLessThan(0.5)
    // So a drop between two of them lands strictly between them.
    const [above, below] = [...ranks].sort((a, b) => b - a)
    const mid = rankBetween(above, below)!
    expect(mid).toBeLessThan(above)
    expect(mid).toBeGreaterThan(below)
  })

  it('never reorders two different seconds', () => {
    expect(listRank(chat('late', new Date(on(26).getTime() + 1000)))).toBeGreaterThan(listRank(chat('early', on(26))))
  })
})

describe('dropRank', () => {
  const rows = [{ id: 'a', r: 40 }, { id: 'b', r: 30 }, { id: 'c', r: 20 }, { id: 'd', r: 10 }]
  const rank = (row: { r: number }): number => row.r

  it('takes the midpoint between the two new neighbours', () => {
    expect(dropRank(rows, rank, 'd', 'b', 'after')).toBe(25)
    expect(dropRank(rows, rank, 'd', 'b', 'before')).toBe(35)
    expect(dropRank(rows, rank, 'a', 'c', 'after')).toBe(15)
  })

  it('goes one above the top neighbour and one below the bottom one', () => {
    expect(dropRank(rows, rank, 'c', 'a', 'before')).toBe(41)
    expect(dropRank(rows, rank, 'a', 'd', 'after')).toBe(9)
  })

  it('is unchanged where the drop leaves the chat where it was', () => {
    expect(dropRank(rows, rank, 'b', 'a', 'after')).toBe('unchanged')
    expect(dropRank(rows, rank, 'b', 'c', 'before')).toBe('unchanged')
    expect(dropRank(rows, rank, 'b', 'b', 'before')).toBe('unchanged')
    expect(dropRank(rows, rank, 'z', 'a', 'before')).toBe('unchanged')
  })

  it('has no room between neighbours with no number strictly between them, and says so', () => {
    // Adjacent doubles: the midpoint rounds onto one of them.
    expect(rankBetween(2 ** 53, 2 ** 53 - 1)).toBeNull()
    expect(rankBetween(5, 5)).toBeNull()
    const touching = [{ id: 'a', r: 2 ** 53 }, { id: 'b', r: 2 ** 53 - 1 }, { id: 'c', r: 0 }]
    expect(dropRank(touching, rank, 'c', 'a', 'after')).toBe('no-room')
    // Still room at the ends.
    expect(dropRank(touching, rank, 'c', 'a', 'before')).toBe(2 ** 53 + 1)
  })

  it('has nothing to place against in a group of one', () => {
    expect(rankBetween(undefined, undefined)).toBeNull()
    expect(rankBetween(3, 1)).toBe(2)
    expect(rankBetween(undefined, 0)).toBe(1)
    expect(rankBetween(0, undefined)).toBe(-1)
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

describe('the Active block', () => {
  const chat = (id: string, extra: object = {}) => ({ id, updatedAt: on(20), ...extra })
  const result = (status: 'completed' | 'needs_input' | 'failed' | 'canceled', unread: boolean) =>
    ({ lastRunResult: { runId: 'run-1', status, unread } })

  it('takes a running chat, the streaming open chat and an unread result — never a read one or a cancel', () => {
    expect(isActiveChat(chat('a', { activeRunId: 'run-1' }), null)).toBe(true)
    expect(isActiveChat(chat('a'), 'a')).toBe(true)
    expect(isActiveChat(chat('a', result('needs_input', true)), null)).toBe(true)
    expect(isActiveChat(chat('a', result('failed', true)), null)).toBe(true)
    expect(isActiveChat(chat('a', result('completed', false)), null)).toBe(false)
    expect(isActiveChat(chat('a', result('canceled', true)), null)).toBe(false)
    expect(isActiveChat(chat('a'), 'b')).toBe(false)
  })

  it('keeps the rows it has in place and puts newcomers on top, newest first', () => {
    const older = chat('old', { updatedAt: on(19) })
    const newer = chat('new', { updatedAt: on(21) })
    expect(settleActiveIds([], [older, newer])).toEqual(['new', 'old'])
    // `x` became active after them but its row is older: still on top, and the two keep their order.
    expect(settleActiveIds(['new', 'old'], [chat('x', { updatedAt: on(1) }), older, newer])).toEqual(['x', 'new', 'old'])
    expect(settleActiveIds(['x', 'new', 'old'], [older])).toEqual(['old'])
  })
})
