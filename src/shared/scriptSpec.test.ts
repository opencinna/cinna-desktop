import { describe, expect, it } from 'vitest'
import { parseScriptSpec, type ScriptParam, type ScriptSpec } from './scriptSpec'

/**
 * Synthetic scripts, shaped like the ones agents write: an argparse block
 * under a docstring with a Usage line, a shell script with a `# Usage:`
 * header, and the shapes the reader must refuse.
 */

const CHECK_PY = `#!/usr/bin/env python3
"""Check the quarterly figures for a scope.

Reads the ledger and compares it with the plan.

Usage:
    uv run scripts/check.py <scope> [--year YYYY] [--as-of YYYY-MM-DD] [--basis month|week] [--db PATH] [--apply]

Options:
  --basis month   (default) totals per month
  --basis week    totals per ISO week
  --db PATH       the ledger database
                  (a copy is fine)
"""
import argparse
from datetime import date
from pathlib import Path


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("scope", help="Which scope to check, e.g. italy")
    parser.add_argument("--year", type=int, default=date.today().year, help="Fiscal year (default: %(default)s)")
    parser.add_argument("--as-of", dest="as_of", default=None)
    parser.add_argument("--basis", choices=["month", "week"], default="month")
    parser.add_argument("--db", type=Path, default=Path("data") / "ledger.db")
    parser.add_argument("--limit", type=int, default=50, help='Rows to show '
                        'at most')
    parser.add_argument("-v", "--verbose", action="count", default=0)
    parser.add_argument("--tag", action="append", help="Repeatable tag")
    parser.add_argument("--apply", action="store_true", help="Apply the corrections")
    args = parser.parse_args()
    print(args)


if __name__ == "__main__":
    main()
`

const param = (spec: ScriptSpec | null, id: string): ScriptParam => {
  const found = spec?.params.find((candidate) => candidate.id === id)
  if (!found) throw new Error(`no param ${id}`)
  return found
}

describe('parseScriptSpec: argparse with a Usage docstring', () => {
  const spec = parseScriptSpec(CHECK_PY, { script: 'scripts/check.py' })

  it('reads the docstring as summary, description and usage', () => {
    expect(spec).not.toBeNull()
    expect(spec!.language).toBe('python')
    expect(spec!.script).toBe('scripts/check.py')
    expect(spec!.summary).toBe('Check the quarterly figures for a scope.')
    expect(spec!.description).toMatch(/^Reads the ledger and compares it with the plan\.\n\nUsage:/)
    expect(spec!.usage).toBe('uv run scripts/check.py <scope> [--year YYYY] [--as-of YYYY-MM-DD] [--basis month|week] [--db PATH] [--apply]')
  })

  it('puts positionals first, then options in declaration order', () => {
    expect(spec!.params.map((p) => p.id)).toEqual(['scope', 'year', 'as_of', 'basis', 'db', 'limit', 'verbose', 'tag', 'apply'])
  })

  it.each<[string, Partial<ScriptParam>]>([
    ['scope', { kind: 'positional', flags: [], required: true, label: 'Scope', help: 'Which scope to check, e.g. italy', valueType: 'text' }],
    // A computed default, a refined type from the metavar and the name, help with %(default)s filled in.
    ['year', { kind: 'value', flags: ['--year'], valueType: 'year', defaultText: null, defaultComputed: true, metavar: 'YYYY', help: 'Fiscal year (default: set by the script)' }],
    // dest wins over the flag; the Usage metavar fills the type gap.
    ['as_of', { kind: 'value', flags: ['--as-of'], label: 'As of', valueType: 'date', defaultText: null, metavar: 'YYYY-MM-DD' }],
    ['basis', { choices: ['month', 'week'], defaultText: 'month', help: 'month (default) totals per month\nweek totals per ISO week' }],
    ['db', { valueType: 'path', defaultText: null, defaultComputed: true, help: 'PATH the ledger database (a copy is fine)' }],
    // Implicit string concatenation.
    ['limit', { valueType: 'int', defaultText: '50', help: 'Rows to show at most' }],
    ['verbose', { kind: 'count', flags: ['-v', '--verbose'] }],
    ['tag', { kind: 'value', multiple: true, repeat: true }],
    ['apply', { kind: 'switch', writes: true, help: 'Apply the corrections' }]
  ])('%s', (id, expected) => {
    expect(param(spec, id)).toMatchObject(expected)
  })

  it('marks a writing switch by its name or its help', () => {
    const source = `"""Tool."""
import argparse
p = argparse.ArgumentParser()
p.add_argument("--apply", action="store_true")
p.add_argument("--save", action="store_true", help="Writes the report to disk")
p.add_argument("--quiet", action="store_true", help="Less output")
p.add_argument("--out", help="writes here")
p.parse_args()
`
    const spec = parseScriptSpec(source, { script: 'tool.py' })
    expect(spec!.params.map((p) => [p.id, p.writes])).toEqual([['apply', true], ['save', true], ['quiet', false], ['out', false]])
  })
})

describe('parseScriptSpec: argparse shapes', () => {
  const wrap = (body: string): string => `import argparse\nparser = argparse.ArgumentParser()\n${body}\nparser.parse_args()\n`

  it('reads nargs="?" as an optional positional, and "+" as a required multiple one', () => {
    const spec = parseScriptSpec(wrap(`parser.add_argument("month", nargs="?", help="YYYY-MM")\nparser.add_argument("files", nargs="+", type=Path)`), { script: 'x.py' })
    expect(param(spec, 'month')).toMatchObject({ kind: 'positional', required: false, multiple: false, valueType: 'month' })
    expect(param(spec, 'files')).toMatchObject({ kind: 'positional', required: true, multiple: true, valueType: 'path' })
  })

  it('reads choices of numbers, required options, store_false and BooleanOptionalAction', () => {
    const spec = parseScriptSpec(wrap([
      'parser.add_argument("--level", type=int, choices=[1, 2, 3], required=True)',
      'parser.add_argument("--no-cache", dest="cache", action="store_false")',
      'parser.add_argument("--color", action=argparse.BooleanOptionalAction)'
    ].join('\n')), { script: 'x.py' })
    expect(param(spec, 'level')).toMatchObject({ choices: ['1', '2', '3'], required: true, valueType: 'int' })
    expect(param(spec, 'cache')).toMatchObject({ kind: 'switch', flags: ['--no-cache'] })
    expect(param(spec, 'color')).toMatchObject({ kind: 'switch' })
  })

  it('skips help, version and hidden options', () => {
    const spec = parseScriptSpec(wrap([
      'parser.add_argument("--version", action="version", version="1.0")',
      'parser.add_argument("--debug", action="store_true", help=argparse.SUPPRESS)',
      'parser.add_argument("--name")'
    ].join('\n')), { script: 'x.py' })
    expect(spec!.params.map((p) => p.id)).toEqual(['name'])
  })

  it('reads params from a mutually exclusive group as usual', () => {
    const spec = parseScriptSpec(wrap([
      'group = parser.add_mutually_exclusive_group()',
      'group.add_argument("--json", action="store_true")',
      'group.add_argument("--csv", action="store_true")'
    ].join('\n')), { script: 'x.py' })
    expect(spec!.params.map((p) => p.id)).toEqual(['json', 'csv'])
  })

  it('reads raw, escaped and triple-quoted strings without mistaking their contents for calls', () => {
    const spec = parseScriptSpec(wrap([
      'NOTE = """parser.add_argument("--ghost")"""',
      '# parser.add_argument("--comment")',
      `parser.add_argument(r"--pattern", help='a \\'quoted\\' regex')`
    ].join('\n')), { script: 'x.py' })
    expect(spec!.params.map((p) => p.id)).toEqual(['pattern'])
    expect(param(spec, 'pattern').help).toBe("a 'quoted' regex")
  })
})

describe('parseScriptSpec: fails closed', () => {
  const wrap = (body: string): string => `import argparse\nparser = argparse.ArgumentParser()\n${body}\nparser.parse_args()\n`

  it.each([
    ['subparsers', wrap('sub = parser.add_subparsers(dest="cmd")\nsub.add_parser("run").add_argument("--x")')],
    ['a second parser', wrap('other = argparse.ArgumentParser()\nparser.add_argument("--x")')],
    ['**kwargs in a call', wrap('parser.add_argument("--x", **common)')],
    ['a flag that is not a literal', wrap('for name in NAMES:\n    parser.add_argument(name)')],
    ['an f-string flag', wrap('parser.add_argument(f"--{name}")')],
    ['a custom action', wrap('parser.add_argument("--x", action=MyAction)')],
    ['an unknown keyword', wrap('parser.add_argument("--x", widget="slider")')],
    ['a duplicate dest', wrap('parser.add_argument("--x")\nparser.add_argument("--y", dest="x")')],
    ['an unterminated string', wrap('parser.add_argument("--x", help="oops)')],
    ['an unclosed call', wrap('parser.add_argument("--x", help="ok"')],
    ['no parameters at all', '"""Just a module."""\nprint("hi")\n'],
    ['no argparse and a Usage line naming a subcommand', '"""Sync.\n\nUsage: python sync.py pull <remote>\n"""\n'],
    ['nested brackets in the only Usage line', '"""Tool.\n\nUsage: tool.py [--x [Y]]\n"""\n']
  ])('%s → null', (_name, source) => {
    expect(parseScriptSpec(source, { script: _name.includes('Usage') ? (source.includes('sync.py') ? 'sync.py' : 'tool.py') : 'x.py' })).toBeNull()
  })

  it('a language it does not read → null', () => {
    expect(parseScriptSpec('console.log(process.argv)\n', { script: 'scripts/x.js' })).toBeNull()
  })

  it('ignores a surprising Usage line when argparse spoke', () => {
    const spec = parseScriptSpec(`"""Tool.\n\nUsage: x.py pull [--x [Y]]\n"""\n${wrap('parser.add_argument("--name")')}`, { script: 'x.py' })
    expect(spec!.params.map((p) => p.id)).toEqual(['name'])
  })
})

describe('parseScriptSpec: the Usage line alone', () => {
  it('reads a Python script that parses sys.argv by hand from its docstring', () => {
    const source = `"""Export a month of invoices.

Usage: python3 scripts/export.py YYYY-MM [<out>] [--format csv|json] [--dry-run] [--limit N]
"""
import sys
print(sys.argv)
`
    const spec = parseScriptSpec(source, { script: 'scripts/export.py' })
    expect(spec!.params.map((p) => [p.id, p.kind, p.required])).toEqual([
      ['yyyy_mm', 'positional', true], ['out', 'positional', false],
      ['format', 'value', false], ['dry_run', 'switch', false], ['limit', 'value', false]
    ])
    expect(param(spec, 'yyyy_mm').valueType).toBe('month')
    expect(param(spec, 'format').choices).toEqual(['csv', 'json'])
    expect(param(spec, 'limit').valueType).toBe('int')
  })

  it('reads a shell script\'s # Usage: header and its option lines', () => {
    const source = `#!/usr/bin/env bash
# Back up the reports folder to a target.
#
# Usage: scripts/backup.sh <target> [--since YYYY-MM-DD] [--force]
#
#   --force   overwrite an existing backup
set -euo pipefail
echo "$@"
`
    const spec = parseScriptSpec(source, { script: 'scripts/backup.sh' })
    expect(spec).toMatchObject({ language: 'shell', summary: 'Back up the reports folder to a target.' })
    expect(spec!.usage).toBe('scripts/backup.sh <target> [--since YYYY-MM-DD] [--force]')
    expect(param(spec, 'target')).toMatchObject({ kind: 'positional', required: true })
    expect(param(spec, 'since')).toMatchObject({ kind: 'value', valueType: 'date' })
    expect(param(spec, 'force')).toMatchObject({ kind: 'switch', writes: true, help: 'overwrite an existing backup' })
  })

  it('a shell script without a Usage header → null', () => {
    expect(parseScriptSpec('#!/bin/sh\n# Waits.\nsleep 60\n', { script: 'scripts/wait.sh' })).toBeNull()
    expect(parseScriptSpec('sleep 60\n', { script: 'scripts/wait.sh' })).toBeNull()
  })
})

describe('parseScriptSpec: defaults', () => {
  const wrap = (body: string): string => `import argparse\nparser = argparse.ArgumentParser()\n${body}\nparser.parse_args()\n`

  it.each<[string, string | null, boolean]>([
    ['Path("data/out")', 'data/out', false],
    ['pathlib.Path(\'x.db\')', 'x.db', false],
    ['str(5)', '5', false],
    ['int(10)', '10', false],
    ['Path("data") / "ledger.db"', null, true],
    ['date.today().year', null, true],
    ['Path(os.environ["HOME"])', null, true],
    ['[a, b]', null, true]
  ])('default=%s shows %s', (expr, text, computed) => {
    const spec = parseScriptSpec(wrap(`parser.add_argument("--out", default=${expr})`), { script: 'x.py' })
    expect(param(spec, 'out')).toMatchObject({ defaultText: text, defaultComputed: computed })
  })
})

describe('parseScriptSpec: the parser, and only the parser', () => {
  it.each([
    ['add_argument on a fake class beside the parser', `import argparse
class Fake:
    def add_argument(self, *names): pass
fake = Fake()
fake.add_argument("--ghost")
parser = argparse.ArgumentParser()
parser.add_argument("--real")
parser.parse_args()
`],
    ['a helper that adds to a parser it is given, and no parser', `def add(p):
    p.add_argument("--x")
    p.add_argument("--y", action="store_true")
`],
    ['a helper that adds to a parameter beside a real parser', `import argparse
def add(p):
    p.add_argument("--x")
parser = argparse.ArgumentParser()
add(parser)
parser.parse_args()
`],
    ['parents=', `import argparse
base = make_base()
parser = argparse.ArgumentParser(parents=[base])
parser.add_argument("--x")
parser.parse_args()
`],
    ['a parser not assigned to a name', `import argparse
def build():
    return argparse.ArgumentParser()
p = build()
p.add_argument("--x")
p.parse_args()
`],
    ['no parse_args on the parser', `import argparse
parser = argparse.ArgumentParser()
parser.add_argument("--x")
other.parse_args()
`],
    ['an attribute call chain on a group', `import argparse
parser = argparse.ArgumentParser()
parser.add_argument_group("g").add_argument("--x")
parser.parse_args()
`],
    ['a group of another receiver', `import argparse
parser = argparse.ArgumentParser()
g = other.add_argument_group("g")
g.add_argument("--x")
parser.parse_args()
`],
    ...([
      ['re-bound later', 'parser = Fake()'],
      ['re-bound, annotated', 'parser: Fake = Fake()'],
      ['re-bound, augmented', 'parser += Fake()'],
      ['re-bound, walrus', 'use(parser := Fake())'],
      ['re-bound in a tuple', 'other, parser = make()'],
      ['re-bound by a chained assignment', 'x = parser = Fake()'],
      ['re-bound by for', 'for parser in fakes: pass'],
      ['re-bound by with … as', 'with Fake() as parser: pass'],
      ['re-bound by def', 'def parser(): pass']
    ] as const).map(([how, line]) => [`the parser name ${how}`, `import argparse
parser = argparse.ArgumentParser()
${line}
parser.add_argument("--x")
parser.parse_args()
`]),
    ['the parser name bound before the parser', `import argparse
parser = Fake()
parser.add_argument("--ghost")
parser = argparse.ArgumentParser()
parser.add_argument("--x")
parser.parse_args()
`],
    ['a group name re-bound later', `import argparse
parser = argparse.ArgumentParser()
g = parser.add_argument_group("g")
g = Fake()
g.add_argument("--x")
parser.parse_args()
`],
    ['a group name re-bound, annotated', `import argparse
parser = argparse.ArgumentParser()
g = parser.add_argument_group("g")
g: Fake = Fake()
g.add_argument("--x")
parser.parse_args()
`],
    ['a group named like the parser', `import argparse
parser = argparse.ArgumentParser()
parser = parser.add_argument_group("g")
parser.add_argument("--x")
parser.parse_args()
`],
    ['a parser on a call\'s continuation line', `import argparse
foo(a,
    p = argparse.ArgumentParser())
p.add_argument("--x")
p.parse_args()
`],
    ['a group on a call\'s continuation line', `import argparse
parser = argparse.ArgumentParser()
foo(a,
    g = parser.add_argument_group("g"))
g.add_argument("--x")
parser.parse_args()
`]
  ])('%s → null', (_name, source) => {
    expect(parseScriptSpec(source, { script: 'x.py' })).toBeNull()
  })

  const FACTORY = `import argparse
def build_parser():
    parser = argparse.ArgumentParser()
    parser.add_argument("--x")
    return parser
`
  it.each([
    ['the factory result under the same name', `${FACTORY}def main():
    parser = build_parser()
    args = parser.parse_args()
`],
    ['the factory result under another name', `${FACTORY}def main():
    p = build_parser()
    p.parse_known_args()
`],
    ['the factory result parsed directly', `${FACTORY}def main():
    args = build_parser().parse_args()
`]
  ])('reads a parser factory: %s', (_name, source) => {
    expect(parseScriptSpec(source, { script: 'x.py' })!.params.map((p) => p.id)).toEqual(['x'])
  })

  it.each([
    ['a factory that does not return the parser', `import argparse
def build_parser():
    parser = argparse.ArgumentParser()
    parser.add_argument("--x")
def main():
    parser = build_parser()
    args = parser.parse_args()
`],
    ['a factory that returns something else', `import argparse
def build_parser():
    parser = argparse.ArgumentParser()
    parser.add_argument("--x")
    return other
def main():
    args = build_parser().parse_args()
`],
    ['the parser name bound to another call beside a factory', `${FACTORY}def main():
    parser = other()
    args = parser.parse_args()
`],
    ['the factory result on a call\'s continuation line', `${FACTORY}def main():
    use(a,
        p = build_parser())
    p.parse_args()
`]
  ])('%s → null', (_name, source) => {
    expect(parseScriptSpec(source, { script: 'x.py' })).toBeNull()
  })

  it('uses of the parser name that bind nothing still read', () => {
    const spec = parseScriptSpec(`import argparse
parser = argparse.ArgumentParser()
parser.prog = "x"
parser.add_argument("--x", default=1)
configure(parser=parser, other=parser == None)
if parser is not None and parser != 1 and parser <= 2: pass
items = {parser: 1}
args = parser.parse_args()
`, { script: 'x.py' })
    expect(spec!.params.map((p) => p.id)).toEqual(['x'])
  })

  it('reads a parser in a function, annotated, with groups of groups, and parse_known_args', () => {
    const spec = parseScriptSpec(`import argparse
def main() -> None:
    parser: argparse.ArgumentParser = argparse.ArgumentParser(description=__doc__)
    io = parser.add_argument_group("io")
    io.add_argument("--src")
    fmt = io.add_mutually_exclusive_group()
    fmt.add_argument("--json", action="store_true")
    args, rest = parser.parse_known_args()
`, { script: 'x.py' })
    expect(spec!.params.map((p) => p.id)).toEqual(['src', 'json'])
  })

  it('merges Usage positionals by name only: choices of a differently named one never reach a free-text positional', () => {
    const spec = parseScriptSpec(`"""Tool.

Usage: x.py {north,south}
"""
import argparse
parser = argparse.ArgumentParser()
parser.add_argument("region")
parser.parse_args()
`, { script: 'x.py' })
    expect(param(spec, 'region')).toMatchObject({ kind: 'positional', choices: null })
    expect(spec!.params.map((p) => p.id)).toEqual(['region'])
  })
})

describe('parseScriptSpec: bounded on main\'s thread', () => {
  const wrap = (body: string): string => `import argparse\nparser = argparse.ArgumentParser()\n${body}\nparser.parse_args()\n`
  const timed = (source: string, script = 'x.py'): { spec: unknown; ms: number } => {
    const started = performance.now()
    const spec = parseScriptSpec(source, { script })
    return { spec, ms: performance.now() - started }
  }

  it('a 240 KB nested literal → null in under 200 ms', () => {
    const depth = 120_000
    const { spec, ms } = timed(wrap(`parser.add_argument("--x", default=${'['.repeat(depth)}${']'.repeat(depth)})`))
    expect(spec).toBeNull()
    expect(ms).toBeLessThan(200)
  })

  it('nesting deeper than 8 in a short call → null; 8 deep still reads', () => {
    const nested = (n: number): string => `${'['.repeat(n)}"a"${']'.repeat(n)}`
    expect(timed(wrap(`parser.add_argument("--x", default=${nested(9)})`)).spec).toBeNull()
    expect(timed(wrap(`parser.add_argument("--x", default=${nested(8)})`)).spec).not.toBeNull()
  })

  it('a 400 KB Usage block → null in under 200 ms', () => {
    const lines = Array.from({ length: 20_000 }, (_, i) => `    x.py [--flag-${i}]`).join('\n')
    const { spec, ms } = timed(`"""Tool.\n\nUsage:\n${lines}\n"""\nimport sys\n`)
    expect(spec).toBeNull()
    expect(ms).toBeLessThan(200)
  })

  it('a Usage block over 50 lines is ignored, beside argparse too', () => {
    const lines = Array.from({ length: 51 }, (_, i) => `    x.py [--flag-${i}]`).join('\n')
    const spec = parseScriptSpec(`"""Tool.\n\nUsage:\n${lines}\n"""\n${wrap('parser.add_argument("--name")')}`, { script: 'x.py' })
    expect(spec!.params.map((p) => p.id)).toEqual(['name'])
    expect(spec!.usage).toBeNull()
  })

  it('a 200 KB line of parser names → null in under 200 ms', () => {
    const { spec, ms } = timed(wrap(`${'parser, '.repeat(25_000)}x = 1`))
    expect(spec).toBeNull()
    expect(ms).toBeLessThan(200)
  })

  it('a call of more than 400 tokens, or more than 200 calls → null', () => {
    const long = Array.from({ length: 200 }, () => '"a"').join(', ')
    expect(timed(wrap(`parser.add_argument("--x", choices=[${long}])`)).spec).toBeNull()
    const many = Array.from({ length: 201 }, (_, i) => `parser.add_argument("--f${i}")`).join('\n')
    expect(timed(wrap(many)).spec).toBeNull()
    const enough = Array.from({ length: 200 }, (_, i) => `parser.add_argument("--f${i}")`).join('\n')
    expect((timed(wrap(enough)).spec as { params: unknown[] }).params).toHaveLength(200)
  })
})
