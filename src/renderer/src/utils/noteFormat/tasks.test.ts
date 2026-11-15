import { describe, expect, it } from 'vitest'
import {
  daysUntil,
  dueDateOf,
  findDueTokens,
  formatDueLabel,
  isValidDate,
  localDateKey,
  parseTasks,
  stripTaskTokens
} from './tasks'

// Ported from cinna-mobile src/notes/tasks.test.ts (read side), one case per rule.

describe('parseTasks', () => {
  it('reads GFM task items with -, * and +, done with x or X', () => {
    const body = ['- [ ] one', '* [x] two', '+ [X] three', '  - [ ] nested', 'plain', '- not a task', '- [ ]', '1. [ ] numbered'].join('\n')
    expect(parseTasks(body).map((t) => [t.ordinal, t.line, t.text, t.done])).toEqual([
      [0, 0, 'one', false],
      [1, 1, 'two', true],
      [2, 2, 'three', true],
      [3, 3, 'nested', false]
    ])
  })

  it('keeps the raw line verbatim', () => {
    expect(parseTasks('  - [ ] buy milk due:2026-11-15')[0].rawLine).toBe('  - [ ] buy milk due:2026-11-15')
  })

  it('reads the ASCII due form and strips it', () => {
    expect(parseTasks('- [ ] buy milk due:2026-11-15')[0]).toMatchObject({ text: 'buy milk', dueDate: '2026-11-15' })
  })

  it('reads the Obsidian 📅 form (with or without the space) and strips it', () => {
    expect(parseTasks('- [ ] buy milk 📅 2026-11-15')[0]).toMatchObject({ text: 'buy milk', dueDate: '2026-11-15' })
    expect(parseTasks('- [ ] buy milk 📅2026-11-15')[0]).toMatchObject({ text: 'buy milk', dueDate: '2026-11-15' })
  })

  it('reads the 📅 form with a VS16 variation selector', () => {
    expect(parseTasks('- [ ] buy milk 📅️ 2026-11-15')[0]).toMatchObject({ text: 'buy milk', dueDate: '2026-11-15' })
  })

  it('takes the first match when both forms are present and strips both', () => {
    expect(parseTasks('- [ ] a 📅 2026-01-02 b due:2026-01-01')[0]).toMatchObject({ text: 'a b', dueDate: '2026-01-02' })
    expect(parseTasks('- [ ] a due:2026-01-01 📅 2026-01-02')[0]).toMatchObject({ text: 'a', dueDate: '2026-01-01' })
  })

  it('tolerates and strips the ✅ done date', () => {
    expect(parseTasks('- [x] call mom 📅 2026-11-14 ✅ 2026-11-14')[0]).toMatchObject({
      text: 'call mom',
      dueDate: '2026-11-14',
      done: true
    })
  })

  it('accepts a reserved time on due: but keeps only the date', () => {
    expect(parseTasks('- [ ] call due:2026-11-15T09:30')[0]).toMatchObject({ text: 'call', dueDate: '2026-11-15' })
  })

  it('ignores invalid dates and tokens glued to words', () => {
    expect(dueDateOf('x due:2026-13-01')).toBeNull()
    expect(dueDateOf('x due:2026-02-30')).toBeNull()
    expect(dueDateOf('overdue:2026-11-15')).toBeNull()
    expect(dueDateOf('x due:2026-11-15th')).toBeNull()
    expect(parseTasks('- [ ] no date')[0].dueDate).toBeNull()
  })

  it('does not read a due token wrapped in emphasis', () => {
    expect(dueDateOf('x **due:2026-11-15**')).toBeNull()
  })

  it('keeps tags and other text in the display text', () => {
    expect(parseTasks('- [ ] pay **rent** #bills due:2026-11-15')[0].text).toBe('pay **rent** #bills')
  })

  it('skips task lines inside fenced code', () => {
    const body = ['- [ ] real', '```md', '- [ ] example', '```', '- [ ] also real'].join('\n')
    expect(parseTasks(body).map((t) => [t.ordinal, t.text])).toEqual([
      [0, 'real'],
      [1, 'also real']
    ])
  })
})

describe('due tokens', () => {
  it('finds both forms with offsets of the token itself', () => {
    const text = 'buy milk due:2026-11-15 then 📅 2026-11-16'
    const tokens = findDueTokens(text)
    expect(tokens.map((t) => [text.slice(t.start, t.end), t.date])).toEqual([
      ['due:2026-11-15', '2026-11-15'],
      ['📅 2026-11-16', '2026-11-16']
    ])
  })

  it('does not return done-date tokens', () => {
    expect(findDueTokens('x ✅ 2026-11-14')).toEqual([])
  })

  it('strips tokens and tidies whitespace', () => {
    expect(stripTaskTokens('a due:2026-11-15 b ✅ 2026-11-14')).toBe('a b')
  })

  it('validates calendar dates', () => {
    expect(isValidDate('2024-02-29')).toBe(true)
    expect(isValidDate('2025-02-29')).toBe(false)
  })
})

describe('localDateKey', () => {
  it('uses the local calendar day', () => {
    expect(localDateKey(new Date(2026, 0, 5, 23, 59))).toBe('2026-01-05')
  })
})

describe('formatDueLabel', () => {
  it('names nearby days and formats the rest', () => {
    expect(formatDueLabel('2026-11-14', '2026-11-14')).toBe('Today')
    expect(formatDueLabel('2026-11-15', '2026-11-14')).toBe('Tomorrow')
    expect(formatDueLabel('2026-11-13', '2026-11-14')).toBe('Yesterday')
    expect(formatDueLabel('2026-11-20', '2026-11-14')).toBe('Nov 20')
    expect(formatDueLabel('2027-01-02', '2026-11-14')).toBe('Jan 2, 2027')
    expect(daysUntil('2026-03-30', '2026-03-28')).toBe(2) // across a DST change
  })
})

describe('editor-compatible spacing and CRLF', () => {
  it('reads every spacing the editor draws as a todo', () => {
    expect(parseTasks('-  [ ] two spaces due:2026-11-15\n- [ ]\ttab\n-\t[x] tab marker').map((t) => [t.text, t.done, t.dueDate])).toEqual([
      ['two spaces', false, '2026-11-15'],
      ['tab', false, null],
      ['tab marker', true, null]
    ])
  })

  it('reads CRLF bodies, ignoring the trailing \\r', () => {
    const [a] = parseTasks('- [ ] a due:2026-11-15\r\n- [ ] b\r\n')
    expect(a).toMatchObject({ rawLine: '- [ ] a due:2026-11-15', dueDate: '2026-11-15' })
  })
})
