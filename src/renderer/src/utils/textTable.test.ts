import { describe, expect, it } from 'vitest'
import { csvFilename, parseTextTable, toCsv } from './textTable'

describe('parseTextTable', () => {
  it('reads bare pipe lines (the Odoo example)', () => {
    const text = [
      'Odoo id | name | status | old key | months',
      '41 | Acme GmbH | active | AC-1 | 12',
      '42 | Beta Ltd | paused | BT-7 | 3'
    ].join('\n')
    expect(parseTextTable(text, null)).toEqual([
      ['Odoo id', 'name', 'status', 'old key', 'months'],
      ['41', 'Acme GmbH', 'active', 'AC-1', '12'],
      ['42', 'Beta Ltd', 'paused', 'BT-7', '3']
    ])
  })

  it('drops leading and trailing pipes and a |---| separator (a markdown table in a fence)', () => {
    const text = '| a | b |\n|---|:--:|\n| 1 | 2 |\n\n| 3 |  |\n'
    expect(parseTextTable(text, 'md')).toEqual([['a', 'b'], ['1', '2'], ['3', '']])
  })

  it('reads psql output with its (3 rows) footer, keeping an empty first cell', () => {
    const text = [
      ' id | name  | email',
      '----+-------+------------',
      '  1 | alice | a@example.com',
      '  2 | bob   | ',
      '    | carol | c@example.com',
      '(3 rows)'
    ].join('\n')
    expect(parseTextTable(text, 'psql')).toEqual([
      ['id', 'name', 'email'],
      ['1', 'alice', 'a@example.com'],
      ['2', 'bob', ''],
      ['', 'carol', 'c@example.com']
    ])
    expect(parseTextTable(text.replace('(3 rows)', '(1 row)'), '')).not.toBeNull()
  })

  it('reads mysql output with +----+ borders', () => {
    const text = [
      '+----+-------+',
      '| id | name  |',
      '+----+-------+',
      '|  1 | alice |',
      '|  2 | bob   |',
      '+----+-------+',
      '2 rows in set (0.00 sec)'
    ].join('\n')
    expect(parseTextTable(text, 'sql')).toEqual([['id', 'name'], ['1', 'alice'], ['2', 'bob']])
  })

  it('reads a box-drawing table', () => {
    const text = [
      '┌────┬───────┐',
      '│ id │ name  │',
      '├────┼───────┤',
      '│ 1  │ alice │',
      '└────┴───────┘'
    ].join('\n')
    expect(parseTextTable(text, 'text')).toEqual([['id', 'name'], ['1', 'alice']])
  })

  it('treats \\| as a literal pipe', () => {
    expect(parseTextTable('| cmd | note |\n| a \\| b | piped |', null)).toEqual([['cmd', 'note'], ['a | b', 'piped']])
  })

  it('refuses ragged rows', () => {
    expect(parseTextTable('a | b | c\n1 | 2 | 3\n1 | 2', null)).toBeNull()
  })

  it('refuses a single row, a single column and a line without a delimiter', () => {
    expect(parseTextTable('a | b | c', null)).toBeNull()
    expect(parseTextTable('| a |\n| 1 |', null)).toBeNull()
    expect(parseTextTable('a | b\nsome prose\n1 | 2\n3 | 4', null)).toBeNull()
    expect(parseTextTable('', null)).toBeNull()
  })

  it('refuses pipe lines in a code language (a shell pipeline is not a table)', () => {
    const text = 'cat a.log | grep error\nps aux | grep node'
    expect(parseTextTable(text, 'bash')).toBeNull()
    expect(parseTextTable(text, 'sh')).toBeNull()
    expect(parseTextTable('| a | b |\n| 1 | 2 |', 'python')).toBeNull()
    // `console` is a shell session, not output.
    expect(parseTextTable('| a | b |\n| 1 | 2 |', 'console')).toBeNull()
  })

  it('refuses two unlabelled shell pipelines', () => {
    expect(parseTextTable('cat a.log | grep error\nps aux | grep node', null)).toBeNull()
    expect(parseTextTable('cat a.log | grep error\nps aux | grep node', 'text')).toBeNull()
  })

  it('refuses a $ session of pipelines, however many lines', () => {
    expect(parseTextTable('$ cat a.log | grep error\n$ ps aux | grep node\n$ ls | wc -l', null)).toBeNull()
  })

  it('refuses a Go template and a shell ||', () => {
    expect(parseTextTable('{{ .Name }} | {{ .Age }}\n{{ .A }} | {{ .B }}\n{{ .C }} | {{ .D }}', null)).toBeNull()
    expect(parseTextTable('make || exit 1 | a\nfoo || bar | b\nc || d | e', null)).toBeNull()
  })

  it('takes two bare rows only with a rule or a frame', () => {
    expect(parseTextTable('name | age\nann | 31', null)).toBeNull()
    expect(parseTextTable('name | age\n-----+----\nann | 31', null)).toEqual([['name', 'age'], ['ann', '31']])
    expect(parseTextTable('| name | age |\n| ann | 31 |', null)).toEqual([['name', 'age'], ['ann', '31']])
  })

  it('reads a rounded (nushell) table', () => {
    const text = [
      '╭───┬──────┬──────╮',
      '│ # │ name │ size │',
      '├───┼──────┼──────┤',
      '│ 0 │ a.md │ 1 KB │',
      '│ 1 │ b.md │ 2 KB │',
      '╰───┴──────┴──────╯'
    ].join('\n')
    expect(parseTextTable(text, null)).toEqual([['#', 'name', 'size'], ['0', 'a.md', '1 KB'], ['1', 'b.md', '2 KB']])
  })

  it('reads a tabulate fancy_grid table', () => {
    const text = [
      '╒════════╤═══════╕',
      '│ item   │   qty │',
      '╞════════╪═══════╡',
      '│ spam   │    42 │',
      '├────────┼───────┤',
      '│ eggs   │   451 │',
      '╘════════╧═══════╛'
    ].join('\n')
    expect(parseTextTable(text, 'text')).toEqual([['item', 'qty'], ['spam', '42'], ['eggs', '451']])
  })

  it('reads a polars table, its shape line and dashed column rules, without its dtype row', () => {
    const text = [
      'shape: (2, 2)',
      '┌─────┬─────┐',
      '│ a   ┆ b   │',
      '│ --- ┆ --- │',
      '│ i64 ┆ str │',
      '╞═════╪═════╡',
      '│ 1   ┆ x   │',
      '│ 2   ┆ y   │',
      '└─────┴─────┘'
    ].join('\n')
    expect(parseTextTable(text, null)).toEqual([['a', 'b'], ['1', 'x'], ['2', 'y']])
  })

  it('keeps a template cell in a labeled table, refusing it only unlabeled', () => {
    const text = '| key | value |\n|---|---|\n| name | {{ .Values.name }} |'
    expect(parseTextTable(text, 'md')).toEqual([['key', 'value'], ['name', '{{ .Values.name }}']])
    expect(parseTextTable(text, null)).toBeNull()
  })

  it('reads a piped header over space-aligned rows, a one-space gutter included', () => {
    const text = [
      'Odoo id | name | status | old key -> new key | months',
      '35   Ann Example        inactive  #FTE -> (empty)          01..10',
      '107  Bo Sample          ACTIVE    (empty) -> #time         02 only',
      '1279 Carla Demo Person  ACTIVE    (empty) -> #rev_Media    01..10'
    ].join('\n')
    expect(parseTextTable(text, null)).toEqual([
      ['Odoo id', 'name', 'status', 'old key -> new key', 'months'],
      ['35', 'Ann Example', 'inactive', '#FTE -> (empty)', '01..10'],
      ['107', 'Bo Sample', 'ACTIVE', '(empty) -> #time', '02 only'],
      ['1279', 'Carla Demo Person', 'ACTIVE', '(empty) -> #rev_Media', '01..10']
    ])
  })

  it('refuses aligned rows whose columns the header cannot settle', () => {
    // Three columns named, but the rows have only one gutter.
    expect(parseTextTable('a | b | c\nx1   y1\nx2   y2', null)).toBeNull()
    // Two prose lines under a piped command: gutters of equal width, no clear pick.
    expect(parseTextTable('cat a | wc\none two three\nsix ten seven', null)).toBeNull()
    // Tabs.
    expect(parseTextTable('a | b\nx\ty\nz\tw', null)).toBeNull()
  })

  it('reads double-line ║ delimiters', () => {
    const text = ['╔═══╦═══╗', '║ a ║ b ║', '╠═══╬═══╣', '║ 1 ║ 2 ║', '╚═══╩═══╝'].join('\n')
    expect(parseTextTable(text, null)).toEqual([['a', 'b'], ['1', '2']])
  })

  it('reads a csv block with quoted commas and a tsv block', () => {
    expect(parseTextTable('name,note\n"Smith, J","said ""hi"""\nLee,ok', 'csv')).toEqual([
      ['name', 'note'],
      ['Smith, J', 'said "hi"'],
      ['Lee', 'ok']
    ])
    expect(parseTextTable('a\tb\n1\t2', 'tsv')).toEqual([['a', 'b'], ['1', '2']])
    expect(parseTextTable('just one column\nvalue', 'csv')).toBeNull()
    expect(parseTextTable('a,b', 'csv')).toBeNull()
  })
})

describe('toCsv', () => {
  it('quotes only what needs it, doubles quotes and ends lines with CRLF', () => {
    expect(
      toCsv([
        ['plain', 'with, comma', 'say "hi"'],
        ['line\nbreak', ' padded', 'trail '],
        ['ünïcode', '', 'x']
      ])
    ).toBe('plain,"with, comma","say ""hi"""\r\n"line\nbreak"," padded","trail "\r\nünïcode,,x')
  })
})

describe('toCsv formula guard', () => {
  it('defuses cells a spreadsheet would run, and leaves plain numbers alone', () => {
    expect(toCsv([['=SUM(A1)', '@cmd', '+CALL()', '-2+3', '\tx', '\rx']])).toBe(`'=SUM(A1),'@cmd,'+CALL(),'-2+3,'\tx,"'\rx"`)
    expect(toCsv([['-5', '+3.2', '-1e3', '42', 'a-b', '-']])).toBe(`-5,+3.2,-1e3,42,a-b,'-`)
  })
})

describe('csvFilename', () => {
  it('names the file by local date and time', () => {
    expect(csvFilename(new Date(2026, 0, 5, 9, 7))).toBe('table-2026-01-05-0907.csv')
  })
})
