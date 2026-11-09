import { describe, expect, it } from 'vitest'
import { enabledTilePrompts, isTileSize, nearestPresetSize, tilePromptRows, tileSpan } from './dashboards'

describe('a tile’s size', () => {
  it('custom is never a component’s size: the kit’s enum stays the presets', () => {
    expect(isTileSize('custom')).toBe(false)
  })

  it('a span is the preset’s, or the custom cells, or Medium for a custom row without any', () => {
    expect(tileSpan({ size: 'wide' })).toEqual({ cols: 12, rows: 2 })
    expect(tileSpan({ size: 'wide', customSpan: { cols: 4, rows: 4 } })).toEqual({ cols: 12, rows: 2 })
    expect(tileSpan({ size: 'custom', customSpan: { cols: 4, rows: 3 } })).toEqual({ cols: 4, rows: 3 })
    expect(tileSpan({ size: 'custom' })).toEqual({ cols: 6, rows: 2 })
  })

  it('a page is told the nearest preset', () => {
    expect(nearestPresetSize({ cols: 12, rows: 2 })).toBe('wide')
    expect(nearestPresetSize({ cols: 3, rows: 2 })).toBe('s')
    expect(nearestPresetSize({ cols: 2, rows: 5 })).toBe('tall')
    expect(nearestPresetSize({ cols: 7, rows: 3 })).toBe('l')
  })
})

describe('a tile’s suggested questions', () => {
  const agents = [{ label: 'A', prompt: 'a?' }, { label: 'B', prompt: 'b?' }]

  it('without a change are the component’s', () => {
    expect(enabledTilePrompts(agents, null)).toEqual(agents)
  })

  it('apply the off switches and rewordings, then the user’s own', () => {
    const override = { hidden: ['A'], edited: { B: { label: 'B2', prompt: 'b2?' } }, added: [{ label: 'Mine', prompt: 'm?' }, { label: 'Off', prompt: 'o?', hidden: true }] }
    expect(enabledTilePrompts(agents, override)).toEqual([{ label: 'B2', prompt: 'b2?' }, { label: 'Mine', prompt: 'm?' }])
  })

  it('follow the component: its new question appears, a removed one takes its change with it', () => {
    const override = { hidden: ['Gone'], edited: { Gone2: { label: 'x', prompt: 'y' } } }
    expect(enabledTilePrompts([...agents, { label: 'New', prompt: 'n?' }], override).map((p) => p.label)).toEqual(['A', 'B', 'New'])
  })

  it('rows name where each came from', () => {
    const rows = tilePromptRows(agents, { edited: { B: { label: 'B2', prompt: 'b2?' } }, added: [{ label: 'Mine', prompt: 'm?' }] })
    expect(rows.map((r) => [r.label, r.agentLabel, r.addedIndex, r.edited])).toEqual([['A', 'A', null, false], ['B2', 'B', null, true], ['Mine', null, 0, false]])
  })
})
