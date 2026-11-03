import { describe, expect, it, vi } from 'vitest'
import { DASHBOARD_CONTEXT_MAX_CHARS, type ComponentInfo, type TileResultDto, type TileView } from '../../../../shared/dashboards'
import { buildDashboardContext, coalescePerKey, contextChipLabel, contextIdentity, dataAgeText, selectionKeyOf, summarizeTile } from './dashboardContext'

function component(over: Partial<ComponentInfo> = {}): ComponentInfo {
  return {
    agentId: 'folder:sales', manifestId: 'sales', agentName: 'Sales Agent', name: 'deals', skill: null, title: 'Deals',
    description: '', view: 'table', size: 'm', source: { endpoint: 'e' }, maxAge: '15m', refreshCommand: null,
    params: { month: { type: 'month', default: 'current' } }, prompts: [], valid: true, findings: [], missingCredentials: [],
    ...over
  }
}

function tile(id: string, title: string, over: Partial<ComponentInfo> | null = {}, params: Record<string, unknown> = {}): TileView {
  return {
    tile: { id, dashboardId: 'd1', agentManifestId: 'sales', component: over?.name ?? 'deals', skill: null, title: null, size: 'm', position: 0, params, refreshOverride: null },
    displayTitle: title,
    state: over === null ? 'agent_missing' : 'ok',
    component: over === null ? null : component(over)
  }
}

function result(data: unknown, fetchedAt: number | null = 1_000): TileResultDto {
  return { tileId: 't', data, fetchedAt, error: null, refreshing: false, stale: false, tooLarge: false, notice: null }
}

const TABLE = {
  columns: [{ key: 'name', label: 'Deal' }, { key: 'amount', label: 'Amount', type: 'money' }],
  rows: [{ id: 'd-1', name: 'Acme', amount: 100 }, { id: 'd-2', name: 'Globex\nCorp', amount: 250 }, { name: 'No id', amount: 5 }]
}

describe('summarizeTile', () => {
  it('a table: the header and its first rows, selected rows first, a cell never splitting a line', () => {
    expect(summarizeTile('table', TABLE, [], null)).toBe('Deal | Amount\nAcme | 100\nGlobex Corp | 250\nNo id | 5')
    expect(summarizeTile('table', TABLE, ['d-2', '2'], null)).toBe('Selected:\nGlobex Corp | 250\nNo id | 5\n\nDeal | Amount\nAcme | 100\nGlobex Corp | 250\nNo id | 5')
  })

  it('a csv table by row index, and a long table says how many rows it left out', () => {
    expect(summarizeTile('table', { csv: 'a,b\n1,2\n3,4\n' }, ['1'], null)).toBe('Selected:\n3,4\n\na,b\n1,2\n3,4')
    const rows = Array.from({ length: 50 }, (_, i) => ({ name: `r${i}`, amount: i }))
    const summary = summarizeTile('table', { columns: TABLE.columns, rows }, [], null)
    expect(summary.split('\n')).toHaveLength(42)
    expect(summary.endsWith('(40 of 50 shown)')).toBe(true)
  })

  it('a list: one line per item with its parts', () => {
    const data = { items: [{ id: 'm1', title: 'Reply to Bob', subtitle: 'bob@x', priority: 'high', time: '9:00' }, { title: 'Pay rent' }] }
    expect(summarizeTile('list', data, [], null)).toBe('- Reply to Bob · bob@x · 9:00 · high priority\n- Pay rent')
    expect(summarizeTile('list', data, ['1'], null)).toBe('Selected:\n- Pay rent\n\n- Reply to Bob · bob@x · 9:00 · high priority\n- Pay rent')
  })

  it('metrics: label, value, unit, delta and a status that is not ok', () => {
    const data = { items: [{ label: 'Revenue', value: 1200, unit: 'EUR', delta: 5 }, { label: 'Churn', value: 3, delta: -1, status: 'warning' }] }
    expect(summarizeTile('metrics', data, [], null)).toBe('Revenue: 1200 EUR (+5)\nChurn: 3 (-1) [warning]')
  })

  it('markdown: a short document whole, a long one up to a paragraph break', () => {
    expect(summarizeTile('markdown', '# Notes\n\nShort.', [], null)).toBe('# Notes\n\nShort.')
    const long = `# Head\n\n${'a'.repeat(1500)}\n\n${'b'.repeat(1500)}`
    const summary = summarizeTile('markdown', { markdown: long }, [], null)
    expect(summary).toBe(`# Head\n\n${'a'.repeat(1500)}\n…`)
  })

  it('html: the page’s own setContext summary, or nothing', () => {
    expect(summarizeTile('html', { any: 1 }, [], { summary: 'Chart of Q3', selection: [] })).toBe('Chart of Q3')
    expect(summarizeTile('html', { any: 1 }, [], null)).toBe('')
  })

  it('caps every summary at 8,000 chars', () => {
    const summary = summarizeTile('html', null, [], { summary: 'x'.repeat(20_000), selection: [] })
    expect(summary).toHaveLength(DASHBOARD_CONTEXT_MAX_CHARS)
    expect(summary.endsWith('…')).toBe(true)
    const wide = { columns: [{ key: 'v' }], rows: Array.from({ length: 40 }, () => ({ v: 'y'.repeat(500) })) }
    expect(summarizeTile('table', wide, [], null).length).toBe(DASHBOARD_CONTEXT_MAX_CHARS)
  })

  it('no data, or data of the wrong shape: an empty summary', () => {
    expect(summarizeTile('table', null, [], null)).toBe('')
    expect(summarizeTile('list', { rows: [] }, [], null)).toBe('')
  })
})

describe('selection keys', () => {
  it('the item’s id, a number as text, else the index', () => {
    expect(selectionKeyOf({ id: 'd-1' }, 4)).toBe('d-1')
    expect(selectionKeyOf({ id: 17 }, 4)).toBe('17')
    expect(selectionKeyOf({ id: '' }, 4)).toBe('4')
    expect(selectionKeyOf({ name: 'x' }, 2)).toBe('2')
  })
})

describe('buildDashboardContext', () => {
  const now = 1_000 + 12 * 60_000
  const focused = tile('t1', 'Deals pipeline', {}, { month: '2026-09' })
  const tiles = [
    focused,
    tile('t2', 'Upcoming meetings', { name: 'meetings' }),
    tile('t3', 'Client emails', { agentId: 'folder:mail', agentName: 'Mail agent', name: 'emails' }),
    tile('t4', 'Gone', null)
  ]

  it('the focused tile with its params, selection, age and summary; its agent’s other tiles; the rest by title and agent', () => {
    const context = buildDashboardContext({ dashboardId: 'd1', dashboardName: 'Sales overview', focused, tiles, result: result(TABLE), selection: ['d-1'], web: null, now })
    expect(context).toEqual({
      dashboardId: 'd1',
      dashboard: 'Sales overview',
      focused: {
        tileId: 't1',
        component: 'deals',
        skill: null,
        title: 'Deals pipeline',
        params: { month: '2026-09' },
        selection: ['d-1'],
        dataAge: '12 min',
        summary: expect.stringContaining('Selected:\nAcme | 100')
      },
      alsoYours: ['Upcoming meetings'],
      otherTiles: ['Client emails (Mail agent)', 'Gone (unknown agent)']
    })
  })

  it('a web tile’s selection is the page’s, and no data has no age', () => {
    const web = tile('t5', 'Chart', { view: 'html', name: 'chart' })
    const context = buildDashboardContext({ dashboardId: 'd1', dashboardName: 'S', focused: web, tiles: [web], result: result(null, null), selection: ['ignored'], web: { summary: 'Q3', selection: ['w1'] }, now })
    expect(context.focused.selection).toEqual(['w1'])
    expect(context.focused.summary).toBe('Q3')
    expect(context.focused.dataAge).toBeNull()
  })

  it('a web tile that never called setContext sends an empty summary and selection', () => {
    const web = tile('t5', 'Chart', { view: 'html', name: 'chart' })
    const context = buildDashboardContext({ dashboardId: 'd1', dashboardName: 'S', focused: web, tiles: [web], result: result({ a: 1 }), selection: [], web: null, now })
    expect(context.focused).toMatchObject({ summary: '', selection: [] })
  })
})

describe('the chip', () => {
  const base = buildDashboardContext({ dashboardId: 'd1', dashboardName: 'S', focused: tile('t1', 'Deals pipeline', {}, { month: '2026-09' }), tiles: [], result: null, selection: [], web: null })

  it('reads "Deals pipeline · Sep 2026 · 3 selected"', () => {
    expect(contextChipLabel({ ...base, focused: { ...base.focused, selection: ['a', 'b', 'c'] } })).toBe('Deals pipeline · Sep 2026 · 3 selected')
    expect(contextChipLabel(base)).toBe('Deals pipeline · Sep 2026')
  })

  it('a removed chip is remembered by tile and selection', () => {
    expect(contextIdentity('t1', ['a'])).not.toBe(contextIdentity('t1', ['a', 'b']))
    expect(contextIdentity('t1', [])).not.toBe(contextIdentity('t2', []))
    expect(contextIdentity('t1', ['a', 'b'])).toBe(contextIdentity('t1', ['a', 'b']))
  })
})

describe('dataAgeText', () => {
  it('reads like the tile’s age, without "ago"', () => {
    expect(dataAgeText(null)).toBeNull()
    expect(dataAgeText(0, 30_000)).toBe('just now')
    expect(dataAgeText(0, 12 * 60_000)).toBe('12 min')
    expect(dataAgeText(0, 3 * 3_600_000)).toBe('3 h')
  })
})

describe('coalescePerKey (setContext flooding)', () => {
  it('passes the first value at once, then at most one latest value per window, per key', () => {
    vi.useFakeTimers()
    try {
      const flushed: [string, number][] = []
      const queue = coalescePerKey<number>((key, value) => flushed.push([key, value]), 250)
      for (let i = 1; i <= 100; i++) queue.push('t1', i)
      queue.push('t2', 7)
      expect(flushed).toEqual([['t1', 1], ['t2', 7]])
      vi.advanceTimersByTime(250)
      expect(flushed).toEqual([['t1', 1], ['t2', 7], ['t1', 100]])
      vi.advanceTimersByTime(1000)
      expect(flushed).toHaveLength(3)
      queue.push('t1', 101)
      queue.push('t1', 102)
      queue.cancel()
      vi.advanceTimersByTime(1000)
      expect(flushed).toEqual([['t1', 1], ['t2', 7], ['t1', 100], ['t1', 101]])
      // Usable again after cancel.
      queue.push('t1', 103)
      expect(flushed.at(-1)).toEqual(['t1', 103])
    } finally {
      vi.useRealTimers()
    }
  })
})
