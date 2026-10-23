import { describe, expect, it } from 'vitest'
import { parseJsonLines } from '../components/chat/JsonTree'
import { MAX_TABLE_COLUMNS, MAX_TABLE_RECORDS, jsonLinesTable } from './jsonLinesTable'

const table = (text: string): ReturnType<typeof jsonLinesTable> => jsonLinesTable(parseJsonLines(text) ?? [])

describe('jsonLinesTable', () => {
  it('makes every value path a column in first-seen order, blank where a record has none', () => {
    const t = table('{"a": 1, "b": {"c": true, "d": null}}\n{"e": [1, {"f": "x"}], "a": 2}')
    expect(t.header).toEqual(['#', 'a', 'b.c', 'b.d', 'e.0', 'e.1.f'])
    expect(t.rows).toEqual([
      ['1', '1', 'true', 'null', '', ''],
      ['2', '2', '', '', '1', 'x']
    ])
  })

  it('keeps empty containers and scalar records as one cell, and counts lines that are not JSON', () => {
    const t = table('{"a": {}, "b": []}\n42\nnot json')
    expect(t.header).toEqual(['#', 'a', 'b', 'value'])
    expect(t.rows).toEqual([
      ['1', '{}', '[]', ''],
      ['2', '', '', '42']
    ])
    expect(t.skipped).toBe(1)
  })

  it('caps the records and the columns', () => {
    const many = Array.from({ length: MAX_TABLE_RECORDS + 1 }, (_, i) => `{"i": ${i}}`).join('\n')
    expect(table(many).rows).toHaveLength(MAX_TABLE_RECORDS)
    expect(table(many).clippedRows).toBe(true)

    const wide = JSON.stringify(Object.fromEntries(Array.from({ length: MAX_TABLE_COLUMNS + 3 }, (_, i) => [`k${i}`, i])))
    const t = table(wide)
    expect(t.header).toHaveLength(MAX_TABLE_COLUMNS + 1)
    expect(t.totalColumns).toBe(MAX_TABLE_COLUMNS + 3)
  })
})

describe('a record nested deeper than JSON.stringify survives', () => {
  it('gives the too-deep part one cell instead of throwing', () => {
    const deep = '['.repeat(30000) + ']'.repeat(30000)
    const t = table(deep)
    expect(t.rows).toHaveLength(1)
    expect(t.rows[0].at(-1)).toBe('[ … ]')
  })
})
