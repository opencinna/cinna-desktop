import { describe, expect, it } from 'vitest'
import { buildCommand, commandScript, editCommand, parseArgs, readCommand, type ScriptValues } from './scriptArgs'
import { shellQuote, splitCommandLine } from './commandRun'
import type { ScriptParam, ScriptSpec } from './scriptSpec'

/** The form ↔ command line sync, against a hand-built spec shaped like an agent's checker. */

const p = (over: Partial<ScriptParam> & Pick<ScriptParam, 'id' | 'kind'>): ScriptParam => ({
  flags: [], label: over.id, required: false, multiple: false, repeat: false, valueType: 'text',
  choices: null, defaultText: null, defaultComputed: false, metavar: null, help: null, writes: false, ...over
})

const SPEC: ScriptSpec = {
  script: 'scripts/check.py',
  language: 'python',
  summary: null,
  description: null,
  usage: null,
  params: [
    p({ id: 'scope', kind: 'positional', required: true }),
    p({ id: 'month', kind: 'positional' }),
    p({ id: 'year', kind: 'value', flags: ['--year'], valueType: 'year' }),
    p({ id: 'as_of', kind: 'value', flags: ['--as-of'] }),
    p({ id: 'tag', kind: 'value', flags: ['-t', '--tag'], multiple: true, repeat: true }),
    p({ id: 'files', kind: 'value', flags: ['--files'], multiple: true }),
    p({ id: 'verbose', kind: 'count', flags: ['-v', '--verbose'] }),
    p({ id: 'apply', kind: 'switch', flags: ['--apply'], writes: true })
  ]
}

describe('readCommand: line → form', () => {
  it('reads values with --x v and --x=v, keeping the prefix verbatim (env assignments too)', () => {
    const form = readCommand(SPEC, 'DEBUG=1  uv run --quiet scripts/check.py italy --year 2026 --as-of=2026-03-31 --apply')
    expect(form).toEqual({
      prefix: 'DEBUG=1  uv run --quiet scripts/check.py',
      values: { scope: 'italy', year: '2026', as_of: '2026-03-31', apply: true },
      other: ''
    })
  })

  it('reads repeated, multiple and counted values', () => {
    const form = readCommand(SPEC, 'python3 scripts/check.py it -t a --tag "b c" --files x.csv y.csv -vv --verbose')
    expect(form!.values).toEqual({ scope: 'it', tag: "a 'b c'", files: 'x.csv y.csv', verbose: '3' })
  })

  it('fills an optional positional only when there is a word for it', () => {
    expect(readCommand(SPEC, 'python3 scripts/check.py it 2026-03')!.values).toEqual({ scope: 'it', month: '2026-03' })
  })

  it('keeps unknown arguments in order, an unknown option with the word after it, and everything after --', () => {
    const form = readCommand(SPEC, 'python3 scripts/check.py it --mystery deep --year 2026 extra1 extra2 -- --apply')
    expect(form!.values).toEqual({ scope: 'it', month: 'extra1', year: '2026' })
    expect(form!.other).toBe('extra2 --mystery deep -- --apply')
  })

  it.each([
    ['a different script', 'python3 scripts/other.py it'],
    ['a pipe', 'python3 scripts/check.py it | head'],
    ['a $ expansion', 'python3 scripts/check.py "$HOME"'],
    ['an open quote', "python3 scripts/check.py 'it"],
    ['two lines', 'python3 scripts/check.py it\nls'],
    ['no script at all', 'ls -la']
  ])('is null (edited by hand) for %s', (_name, line) => {
    expect(readCommand(SPEC, line)).toBeNull()
  })
})

describe('buildCommand: form → line', () => {
  it('keeps the prefix verbatim and writes positionals, then options in spec order, then the other arguments', () => {
    const line = buildCommand('FOO="a b"  uv run scripts/check.py', SPEC,
      { apply: true, year: '2026', scope: 'new york', tag: "x 'y z'", verbose: '2' }, '--mystery deep')
    expect(line).toBe("FOO=\"a b\"  uv run scripts/check.py 'new york' --year 2026 --tag x --tag 'y z' --verbose --verbose --apply --mystery deep")
  })

  it('omits empty values and unticked switches', () => {
    expect(buildCommand('python3 scripts/check.py', SPEC, { scope: 'it', year: '', apply: false }, '  ')).toBe('python3 scripts/check.py it')
  })

  it('round-trips through readCommand, unknown arguments included', () => {
    const start = "python3 scripts/check.py 'it' --apply --files a.csv 'b c.csv' --year 2026 --odd 'x y'"
    const form = readCommand(SPEC, start)!
    const line = buildCommand(form.prefix, SPEC, form.values, form.other)
    expect(line).toBe("python3 scripts/check.py it --year 2026 --files a.csv 'b c.csv' --apply --odd 'x y'")
    expect(readCommand(SPEC, line)).toEqual(form)
  })

  it('quotes what a shell would read otherwise, so the line splits back to the same words', () => {
    for (const word of ['', 'a b', "it's", '#hash', '=eq', '~home', 'a*b', 'semi;colon', '-dash', 'naïve']) {
      expect(splitCommandLine(`x ${shellQuote(word)}`)).toEqual(['x', word])
    }
  })
})

describe('commandScript', () => {
  it('names the script past env assignments, and nothing for a block or a non-script', () => {
    expect(commandScript('A=1 uv run scripts/check.py it')).toBe('scripts/check.py')
    expect(commandScript('bash scripts/wait.sh')).toBe('scripts/wait.sh')
    expect(commandScript('ls -la')).toBeNull()
    expect(commandScript('python3 a.py\nls')).toBeNull()
  })
})

describe('parseArgs', () => {
  it('gives an optional positional way to a required one after it', () => {
    const spec: ScriptSpec = { ...SPEC, params: [p({ id: 'a', kind: 'positional' }), p({ id: 'b', kind: 'positional', required: true })] }
    expect(parseArgs(spec, ['only'])).toEqual({ values: { b: 'only' }, unknown: [] })
    expect(parseArgs(spec, ['one', 'two', 'three'])).toEqual({ values: { a: 'one', b: 'two' }, unknown: ['three'] })
  })
})

describe('editCommand: a form edit changes only its own words, in place', () => {
  const EDIT: ScriptSpec = {
    ...SPEC,
    params: [...SPEC.params, p({ id: 'dry_run', kind: 'switch', flags: ['--dry-run'] })]
  }
  /** The form as the line gives it, with `change` applied: what the window passes. */
  const edit = (line: string, change: ScriptValues, other?: string): string | null => {
    const form = readCommand(EDIT, line)!
    return editCommand(EDIT, line, { ...form.values, ...change }, other ?? form.other)
  }
  const LINE = 'uv run scripts/check.py --apply --year 2030 spain'

  it('appends a newly set option, keeping the user\'s order', () => {
    expect(edit(LINE, { dry_run: true })).toBe(`${LINE} --dry-run`)
  })

  it('rewrites a changed value where it stands', () => {
    expect(edit(LINE, { year: '2031' })).toBe('uv run scripts/check.py --apply --year 2031 spain')
    expect(edit('python3 scripts/check.py it --year=2030 --apply', { year: '2031' })).toBe('python3 scripts/check.py it --year 2031 --apply')
    expect(edit(LINE, { scope: 'new york' })).toBe("uv run scripts/check.py --apply --year 2030 'new york'")
  })

  it('removes only a cleared parameter\'s words', () => {
    expect(edit(LINE, { year: '' })).toBe('uv run scripts/check.py --apply spain')
    expect(edit(LINE, { apply: false })).toBe('uv run scripts/check.py --year 2030 spain')
  })

  it('keeps untouched words as typed: quoting, spacing, unknown arguments', () => {
    const line = `A=1 python3 scripts/check.py  "spain"   --odd 'x y'  --apply`
    expect(edit(line, { year: '2026' })).toBe(`${line} --year 2026`)
    expect(edit(line, { apply: false })).toBe(`A=1 python3 scripts/check.py  "spain"   --odd 'x y'`)
  })

  it('puts a newly set positional at its place: after the one before it, else first', () => {
    expect(edit('python3 scripts/check.py it --year 2030', { month: '2026-03' })).toBe('python3 scripts/check.py it 2026-03 --year 2030')
    expect(edit('python3 scripts/check.py --year 2030', { scope: 'it' })).toBe('python3 scripts/check.py it --year 2030')
    expect(edit('python3 scripts/check.py', { scope: 'it' })).toBe('python3 scripts/check.py it')
  })

  it('adds an option before a --, and rewrites a repeated or counted one at its first place', () => {
    expect(edit('python3 scripts/check.py it -- extra', { apply: true })).toBe('python3 scripts/check.py it --apply -- extra')
    expect(edit('python3 scripts/check.py -t a it --tag b --apply', { tag: 'a c' })).toBe('python3 scripts/check.py --tag a --tag c it --apply')
    expect(edit('python3 scripts/check.py it -vv --apply', { verbose: '1' })).toBe('python3 scripts/check.py it --verbose --apply')
  })

  it('replaces the other arguments with what was typed, at the end', () => {
    expect(edit('python3 scripts/check.py it --odd 1 --apply', {}, '--odd 2')).toBe('python3 scripts/check.py it --apply --odd 2')
  })

  it('is null when the line no longer names the script, or the edit would not read back', () => {
    expect(editCommand(EDIT, 'python3 scripts/other.py it', { scope: 'x' }, '')).toBeNull()
    expect(editCommand(EDIT, 'python3 scripts/check.py it', { scope: 'it', apply: true }, "'open")).toBeNull()
  })
})
