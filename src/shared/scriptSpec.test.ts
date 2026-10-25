import { describe, expect, it } from 'vitest'
import { parseScriptSpec, SCRIPT_SPEC_MAX_BYTES, type ScriptParam, type ScriptSpec } from './scriptSpec'

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

/**
 * The wall-clock budget for one parse of a hostile source, as a performance
 * guard rather than a latency promise. A bounded parse of these inputs takes a
 * few ms; a superlinear one (quadratic over 100K+ characters, or unbounded
 * recursion) takes seconds. So the budget sits far above the first and far
 * below the second, and a loaded suite stalling a parse for a few hundred ms
 * does not fail it. The fastest of {@link PARSE_TRIES} parses is what is
 * compared, so one scheduling stall does not count either.
 */
const PARSE_BUDGET_MS = 500
const PARSE_TRIES = 3

/** Parse `source` {@link PARSE_TRIES} times; the spec and the fastest time. */
const timed = (source: string, script = 'x.py'): { spec: unknown; ms: number } => {
  let spec: unknown = null
  let ms = Infinity
  for (let i = 0; i < PARSE_TRIES; i++) {
    const started = performance.now()
    spec = parseScriptSpec(source, { script })
    ms = Math.min(ms, performance.now() - started)
  }
  return { spec, ms }
}

/** A hostile source no larger than main reads (512 KB) answers null within budget. */
const nullInTime = (source: string, script = 'x.py'): void => {
  expect(source.length).toBeLessThanOrEqual(SCRIPT_SPEC_MAX_BYTES)
  const { spec, ms } = timed(source, script)
  expect(spec).toBeNull()
  expect(ms).toBeLessThan(PARSE_BUDGET_MS)
}

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

  it('a 240 KB nested literal → null within the parse budget', () => {
    const depth = 120_000
    const { spec, ms } = timed(wrap(`parser.add_argument("--x", default=${'['.repeat(depth)}${']'.repeat(depth)})`))
    expect(spec).toBeNull()
    expect(ms).toBeLessThan(PARSE_BUDGET_MS)
  })

  it('nesting deeper than 8 in a short call → null; 8 deep still reads', () => {
    const nested = (n: number): string => `${'['.repeat(n)}"a"${']'.repeat(n)}`
    expect(timed(wrap(`parser.add_argument("--x", default=${nested(9)})`)).spec).toBeNull()
    expect(timed(wrap(`parser.add_argument("--x", default=${nested(8)})`)).spec).not.toBeNull()
  })

  it('a 400 KB Usage block → null within the parse budget', () => {
    const lines = Array.from({ length: 20_000 }, (_, i) => `    x.py [--flag-${i}]`).join('\n')
    const { spec, ms } = timed(`"""Tool.\n\nUsage:\n${lines}\n"""\nimport sys\n`)
    expect(spec).toBeNull()
    expect(ms).toBeLessThan(PARSE_BUDGET_MS)
  })

  it('a Usage block over 50 lines is ignored, beside argparse too', () => {
    const lines = Array.from({ length: 51 }, (_, i) => `    x.py [--flag-${i}]`).join('\n')
    const spec = parseScriptSpec(`"""Tool.\n\nUsage:\n${lines}\n"""\n${wrap('parser.add_argument("--name")')}`, { script: 'x.py' })
    expect(spec!.params.map((p) => p.id)).toEqual(['name'])
    expect(spec!.usage).toBeNull()
  })

  it('a 200 KB line of parser names → null within the parse budget', () => {
    const { spec, ms } = timed(wrap(`${'parser, '.repeat(25_000)}x = 1`))
    expect(spec).toBeNull()
    expect(ms).toBeLessThan(PARSE_BUDGET_MS)
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

describe('parseScriptSpec: click', () => {
  const CLICK_PY = `"""Sync the ledger with the bank export."""
import click
from pathlib import Path


@click.command(help="Sync it")
@click.argument("export", type=click.Path(exists=True))
@click.argument("extra", nargs=-1)
@click.option("--year", type=int, default=2026, help="Fiscal year")
@click.option("--basis", type=click.Choice(["month", "week"], case_sensitive=False), default="month")
@click.option("-t", "--tag", multiple=True, help="Repeatable")
@click.option("-v", "--verbose", count=True)
@click.option("--apply/--no-apply", default=False, help="Write the corrections")
@click.option("--cache/--no-cache", "-c/-C", default=True)
@click.option("--force", is_flag=True)
@click.option("--secret", hidden=True)
@click.version_option("1.0")
@click.pass_context
def sync(ctx, export, extra, year, basis, tag, verbose, apply, cache, force):
    """Sync."""
    click.echo(export)


if __name__ == "__main__":
    sync()
`
  const spec = parseScriptSpec(CLICK_PY, { script: 'scripts/sync.py' })

  it('reads the one command\'s stack in declaration order, positionals first', () => {
    expect(spec!.summary).toBe('Sync the ledger with the bank export.')
    expect(spec!.params.map((p) => p.id)).toEqual(['export', 'extra', 'year', 'basis', 'tag', 'verbose', 'apply', 'cache', 'force'])
  })

  it.each<[string, Partial<ScriptParam>]>([
    ['export', { kind: 'positional', required: true, valueType: 'path', multiple: false }],
    ['extra', { kind: 'positional', required: false, multiple: true }],
    ['year', { kind: 'value', flags: ['--year'], valueType: 'year', defaultText: '2026', help: 'Fiscal year' }],
    ['basis', { kind: 'value', choices: ['month', 'week'], defaultText: 'month' }],
    ['tag', { kind: 'value', flags: ['-t', '--tag'], multiple: true, repeat: true }],
    ['verbose', { kind: 'count', flags: ['-v', '--verbose'] }],
    ['apply', { kind: 'switch', flags: ['--apply'], offFlags: ['--no-apply'], defaultOn: false, writes: true }],
    ['cache', { kind: 'switch', flags: ['--cache', '-c'], offFlags: ['--no-cache', '-C'], defaultOn: true }],
    ['force', { kind: 'switch', flags: ['--force'], offFlags: [], defaultOn: false }]
  ])('%s', (id, expected) => {
    expect(param(spec, id)).toMatchObject(expected)
  })

  const wrap = (stack: string, tail = 'if __name__ == "__main__":\n    cli()\n'): string =>
    `import click\n${stack}\ndef cli(**kw):\n    pass\n${tail}`

  it.each([
    ['a group', 'import click\n@click.group()\ndef cli():\n    pass\n@cli.command()\n@click.option("--x")\ndef run(x):\n    pass\ncli()\n'],
    ['two commands', 'import click\n@click.command()\n@click.option("--x")\ndef a(x):\n    pass\n@click.command()\ndef b():\n    pass\na()\n'],
    ['a subcommand decorator on another receiver', `${wrap('@click.command()\n@click.option("--x")')}@other.command()\ndef more():\n    pass\n`],
    ['an option above the command', wrap('@click.option("--x")\n@click.command()')],
    ['an option on another function', `${wrap('@click.command()\n@click.option("--x")')}@click.option("--y")\ndef helper(y):\n    pass\n`],
    ['an unknown decorator in the stack', wrap('@click.command()\n@retry(3)\n@click.option("--x")')],
    ['the stack on a class', 'import click\n@click.command()\n@click.option("--x")\nclass Cli:\n    pass\nCli()\n'],
    ['a dynamic option name', wrap('@click.command()\n@click.option(NAME)')],
    ['an f-string option name', wrap('@click.command()\n@click.option(f"--{name}")')],
    ['**kwargs in an option', wrap('@click.command()\n@click.option("--x", **common)')],
    ['an unknown keyword', wrap('@click.command()\n@click.option("--x", callback=check)')],
    ['context_settings on the command', wrap('@click.command(context_settings={"ignore_unknown_options": True})\n@click.option("--x")')],
    ['a flag on by default with no off flag', wrap('@click.command()\n@click.option("--shout", is_flag=True, default=True)')],
    ['a secondary-only off flag', wrap('@click.command()\n@click.option("--shout", " /-S")')],
    ['a bool type', wrap('@click.command()\n@click.option("--x", type=bool)')],
    ['a tuple type', wrap('@click.command()\n@click.option("--pt", type=(int, int))')],
    ['a Choice of an Enum', wrap('@click.command()\n@click.option("--x", type=click.Choice(Color))')],
    ['a command built by hand', 'import click\ncli = click.Command("x", params=[click.Option(["--x"])])\ncli()\n'],
    ['the command never called', wrap('@click.command()\n@click.option("--x")', '')],
    ['the command name bound again', wrap('@click.command()\n@click.option("--x")', 'cli = other\ncli()\n')],
    ['commands added to it', wrap('@click.command()\n@click.option("--x")', 'cli.add_command(other)\ncli()\n')],
    ['click imported under another name', 'import click as c\n@c.command()\n@c.option("--x")\ndef cli(x):\n    pass\ncli()\n'],
    ['click\'s decorators imported by name', 'from click import command, option\n@command()\n@option("--x")\ndef cli(x):\n    pass\ncli()\n'],
    ['click beside argparse', `${wrap('@click.command()\n@click.option("--x")')}import argparse\np = argparse.ArgumentParser()\np.add_argument("--y")\np.parse_args()\n`]
  ])('%s → null', (_name, source) => {
    expect(parseScriptSpec(source, { script: 'x.py' })).toBeNull()
  })

  it('the refusals\' base shapes read: each row above is null for its own reason', () => {
    expect(parseScriptSpec(wrap('@click.command()\n@click.option("--x")'), { script: 'x.py' })!.params.map((p) => p.id)).toEqual(['x'])
    expect(parseScriptSpec(wrap('@click.command\n@click.option("--x")', 'cli.main(standalone_mode=False)\n'), { script: 'x.py' })!.params.map((p) => p.id)).toEqual(['x'])
    expect(parseScriptSpec('import click\n@click.command()\n@click.option("--x")\ndef cli(x):\n    pass\ncli()\n', { script: 'x.py' })).not.toBeNull()
  })

  it('a script that only echoes through click keeps its argparse form', () => {
    const spec = parseScriptSpec('import argparse, click\np = argparse.ArgumentParser()\np.add_argument("--y")\np.parse_args()\nclick.echo("hi")\n', { script: 'x.py' })
    expect(spec!.params.map((p) => p.id)).toEqual(['y'])
  })

  it('a hostile stack → null within the parse budget', () => {
    const many = Array.from({ length: 20_000 }, (_, i) => `@click.option("--f${i}")`).join('\n')
    nullInTime(`import click\n@click.command()\n${many}\ndef cli(**kw):\n    pass\ncli()\n`)
    const deep = `@click.option("--x", default=${'['.repeat(100_000)}${']'.repeat(100_000)})`
    nullInTime(`import click\n@click.command()\n${deep}\ndef cli(x):\n    pass\ncli()\n`)
  })
})

describe('parseScriptSpec: typer', () => {
  it('reads typer.run(main): positionals without defaults, options with them, bools as --x/--no-x', () => {
    const spec = parseScriptSpec(`"""Report a year."""
import typer
from pathlib import Path
from typing import List, Optional


def main(
    scope: str,
    out_path: Path = Path("out"),
    year: int = 2026,
    rate: float = typer.Option(0.5, "--rate", "-r", help="The rate"),
    note: Optional[str] = None,
    tag: List[str] = typer.Option([], help="Repeatable"),
    verbose: int = typer.Option(0, "-v", count=True),
    apply: bool = False,
    cache: bool = True,
    when: str = typer.Argument("today", help="When"),
) -> None:
    print(scope)


if __name__ == "__main__":
    typer.run(main)
`, { script: 'report.py' })
    expect(spec!.params.map((p) => p.id)).toEqual(['scope', 'when', 'out_path', 'year', 'rate', 'note', 'tag', 'verbose', 'apply', 'cache'])
    expect(param(spec, 'scope')).toMatchObject({ kind: 'positional', required: true })
    expect(param(spec, 'when')).toMatchObject({ kind: 'positional', required: false, defaultText: 'today', help: 'When' })
    expect(param(spec, 'out_path')).toMatchObject({ kind: 'value', flags: ['--out-path'], valueType: 'path', defaultText: 'out' })
    expect(param(spec, 'year')).toMatchObject({ flags: ['--year'], valueType: 'year', defaultText: '2026' })
    expect(param(spec, 'rate')).toMatchObject({ flags: ['--rate', '-r'], valueType: 'float', defaultText: '0.5', help: 'The rate' })
    expect(param(spec, 'note')).toMatchObject({ kind: 'value', required: false, defaultText: null })
    expect(param(spec, 'tag')).toMatchObject({ kind: 'value', multiple: true, repeat: true })
    expect(param(spec, 'verbose')).toMatchObject({ kind: 'count', flags: ['-v'] })
    expect(param(spec, 'apply')).toMatchObject({ kind: 'switch', flags: ['--apply'], offFlags: ['--no-apply'], defaultOn: false, writes: true })
    expect(param(spec, 'cache')).toMatchObject({ kind: 'switch', flags: ['--cache'], offFlags: ['--no-cache'], defaultOn: true })
  })

  it('reads one @app.command() with Annotated params, a Context, and app() called', () => {
    const spec = parseScriptSpec(`import typer
from typing import Annotated

app = typer.Typer(add_completion=False)


@app.command()
def main(
    ctx: typer.Context,
    name: Annotated[str, typer.Argument(help="Who")],
    count: Annotated[int, typer.Option("--count", "-c", help="How many")] = 1,
    dry_run: Annotated[bool, typer.Option("--dry-run/--for-real")] = True,
    force: Annotated[bool, typer.Option("--force")] = False,
    secret: Annotated[str, typer.Option(hidden=True)] = "",
):
    pass


if __name__ == "__main__":
    app()
`, { script: 'x.py' })
    expect(spec!.params.map((p) => p.id)).toEqual(['name', 'count', 'dry_run', 'force'])
    expect(param(spec, 'name')).toMatchObject({ kind: 'positional', required: true, help: 'Who' })
    expect(param(spec, 'count')).toMatchObject({ kind: 'value', flags: ['--count', '-c'], valueType: 'int', defaultText: '1' })
    expect(param(spec, 'dry_run')).toMatchObject({ kind: 'switch', flags: ['--dry-run'], offFlags: ['--for-real'], defaultOn: true })
    expect(param(spec, 'force')).toMatchObject({ kind: 'switch', flags: ['--force'], offFlags: [], defaultOn: false })
  })

  const RUN = (signature: string, tail = 'typer.run(main)\n'): string => `import typer\ndef main(${signature}):\n    pass\n${tail}`
  const APP = (body: string): string => `import typer\napp = typer.Typer()\n${body}\napp()\n`

  it.each([
    ['*args', RUN('*args')],
    ['**kwargs', RUN('name: str, **kwargs')],
    ['a bare *', RUN('*, name: str')],
    ['an Enum annotation', RUN('color: Color = Color.red')],
    ['a Literal annotation', RUN('mode: Literal["a", "b"] = "a"')],
    ['a string annotation', RUN('name: "str"')],
    ['a bool on by default with only an on flag', RUN('force: bool = typer.Option(True, "--force")')],
    ['an Optional bool', RUN('apply: Optional[bool] = None')],
    ['a bool argument', RUN('flag: bool = typer.Argument(False)')],
    ['a callback on an option', RUN('x: str = typer.Option("", callback=check)')],
    ['a dynamic option name', RUN('x: str = typer.Option("", NAME)')],
    ['a shared option object', `import typer\nOPT = typer.Option("", "--x")\ndef main(x: str = OPT):\n    pass\ntyper.run(main)\n`],
    ['a decorated function under typer.run', `import typer\n@cache\ndef main(x: str):\n    pass\ntyper.run(main)\n`],
    ['typer.run of something that is not a plain name', RUN('x: str', 'typer.run(cmds.main)\n')],
    ['the command name bound again', RUN('x: str', 'main = other\ntyper.run(main)\n')],
    ['two commands', APP('@app.command()\ndef a(x: str):\n    pass\n@app.command()\ndef b(y: str):\n    pass')],
    ['@app.callback', APP('@app.callback()\ndef cb():\n    pass\n@app.command()\ndef a(x: str):\n    pass')],
    ['app.add_typer', APP('app.add_typer(other)\n@app.command()\ndef a(x: str):\n    pass')],
    ['another decorator under the command', APP('@app.command()\n@log\ndef a(x: str):\n    pass')],
    ['another decorator above the command', APP('@log\n@app.command()\ndef a(x: str):\n    pass')],
    ['the command decorator not used as one', APP('def a(x: str):\n    pass\napp.command()(a)')],
    ['context_settings on the command', APP('@app.command(context_settings={"x": 1})\ndef a(x: str):\n    pass')],
    ['a callback on the app', 'import typer\napp = typer.Typer(callback=cb)\n@app.command()\ndef a(x: str):\n    pass\napp()\n'],
    ['the app never called', 'import typer\napp = typer.Typer()\n@app.command()\ndef a(x: str):\n    pass\n'],
    ['typer.run and an app at once', `${APP('@app.command()\ndef a(x: str):\n    pass')}typer.run(a)\n`],
    ['typer imported by name', 'from typer import Typer\napp = Typer()\n@app.command()\ndef a(x: str):\n    pass\napp()\n']
  ])('%s → null', (_name, source) => {
    expect(parseScriptSpec(source, { script: 'x.py' })).toBeNull()
  })

  it('the refusals\' base shapes read: each row above is null for its own reason', () => {
    expect(parseScriptSpec(RUN('x: str'), { script: 'x.py' })!.params.map((p) => p.id)).toEqual(['x'])
    expect(parseScriptSpec(RUN('x: str = typer.Option("", "--x")'), { script: 'x.py' })!.params.map((p) => p.id)).toEqual(['x'])
    expect(parseScriptSpec(RUN('force: bool = typer.Option(False, "--force")'), { script: 'x.py' })!.params.map((p) => p.id)).toEqual(['force'])
    expect(parseScriptSpec(APP('@app.command()\ndef a(x: str):\n    pass'), { script: 'x.py' })!.params.map((p) => p.id)).toEqual(['x'])
    expect(parseScriptSpec('import typer\napp = typer.Typer(help="x")\n@app.command(help="y")\ndef a(x: str):\n    pass\napp()\n', { script: 'x.py' })).not.toBeNull()
  })

  it('a hostile signature → null within the parse budget', () => {
    nullInTime(RUN(Array.from({ length: 20_000 }, (_, i) => `p${i}: int = ${i}`).join(', ')))
    nullInTime(RUN(`x: List[str] = ${'['.repeat(100_000)}${']'.repeat(100_000)}`))
    nullInTime(RUN(`x: ${'Optional['.repeat(20_000)}str${']'.repeat(20_000)} = None`))
  })
})

describe('parseScriptSpec: shell getopts', () => {
  const SCRIPT = (header: string, optstring: string, arms: string): string => `#!/usr/bin/env bash
${header}
set -euo pipefail
while getopts "${optstring}" opt; do
  case "$opt" in
${arms}
  esac
done
shift $((OPTIND - 1))
echo "$@"
`
  const ARMS = `    v) verbose=1 ;;
    o) out_dir="$OPTARG" ;;
    n) count="$OPTARG" ;;
    h) usage; exit 0 ;;
    \\?) echo "bad option" >&2; exit 1 ;;
    :) echo "needs a value" >&2; exit 1 ;;`

  it('merges the Usage header (names, help) with getopts (the flag set), options first', () => {
    const spec = parseScriptSpec(SCRIPT(`# Back up a folder.
#
# Usage: backup.sh [-v|--verbose] [-o DIR] [-h] <target>
#
#   -o DIR   where the copy goes`, ':vo:n:h', ARMS), { script: 'scripts/backup.sh' })
    expect(spec).toMatchObject({ language: 'shell', summary: 'Back up a folder.', optionsFirst: true })
    expect(spec!.params.map((p) => [p.id, p.kind, p.flags, p.label])).toEqual([
      ['target', 'positional', [], 'Target'],
      ['verbose', 'switch', ['-v'], 'Verbose'],
      ['out_dir', 'value', ['-o'], 'Out dir'],
      ['count', 'value', ['-n'], 'Count']
    ])
    expect(param(spec, 'out_dir')).toMatchObject({ metavar: 'DIR', valueType: 'path', help: 'DIR where the copy goes' })
  })

  it('reads getopts alone, labelling a letter by its variable or else its flag', () => {
    const spec = parseScriptSpec(SCRIPT('', 'ab:x', `    a) all=true ;;
    b) BASE="$OPTARG" ;;
    x) set -x ;;
    *) exit 2 ;;`), { script: 'run.sh' })
    expect(spec!.usage).toBeNull()
    expect(spec!.params.map((p) => [p.id, p.kind, p.flags, p.label])).toEqual([
      ['all', 'switch', ['-a'], 'All'], ['base', 'value', ['-b'], 'Base'], ['opt_x', 'switch', ['-x'], '-x']
    ])
  })

  it('ignores getopts in a comment, a string or a heredoc body', () => {
    const header = '# Tool.\n#\n# Usage: tool.sh [--force]\n'
    for (const body of ['# while getopts "ab" opt; do', 'echo "use getopts"', 'cat <<EOF\nwhile getopts "ab" opt; do\nEOF']) {
      const spec = parseScriptSpec(`#!/bin/sh\n${header}${body}\n`, { script: 'tool.sh' })
      expect(spec!.params.map((p) => p.id)).toEqual(['force'])
      expect(spec!.optionsFirst).toBeUndefined()
    }
  })

  it.each([
    ['a variable optstring', 'while getopts "$OPTS" opt; do\n  case "$opt" in\n    a) x=1 ;;\n  esac\ndone\n'],
    ['a second getopts', 'while getopts "a" opt; do\n  case "$opt" in\n    a) x=1 ;;\n  esac\ndone\ngetopts "b" o\n'],
    ['a letter with no arm', 'while getopts "ab" opt; do\n  case "$opt" in\n    a) x=1 ;;\n  esac\ndone\n'],
    ['a letter with no arm beside a catch-all', 'while getopts "ab" opt; do\n  case "$opt" in\n    a) x=1 ;;\n    *) y=1 ;;\n  esac\ndone\n'],
    ['an arm for a letter getopts does not take', 'while getopts "a" opt; do\n  case "$opt" in\n    a) x=1 ;;\n    z) y=1 ;;\n  esac\ndone\n'],
    ['a letter arm after the catch-all', 'while getopts "ab" opt; do\n  case "$opt" in\n    a) x=1 ;;\n    *) y=1 ;;\n    b) z=1 ;;\n  esac\ndone\n'],
    ['a glob arm', 'while getopts "ab" opt; do\n  case "$opt" in\n    [ab]) x=1 ;;\n  esac\ndone\n'],
    ['a fall-through', 'while getopts "ab" opt; do\n  case "$opt" in\n    a) x=1 ;&\n    b) y=1 ;;\n  esac\ndone\n'],
    ['a case on another variable', 'while getopts "a" opt; do\n  case "$other" in\n    a) x=1 ;;\n  esac\ndone\n'],
    ['a command before the case', 'while getopts "a" opt; do\n  echo "$opt"\n  case "$opt" in\n    a) x=1 ;;\n  esac\ndone\n'],
    ['getopts outside a while', 'getopts "a" opt\ncase "$opt" in\n  a) x=1 ;;\nesac\n'],
    ['a header option getopts does not read', '# Usage: t.sh [-a] [--long]\nwhile getopts "a" opt; do\n  case "$opt" in\n    a) x=1 ;;\n  esac\ndone\n'],
    ['a header value option getopts reads as a switch', '# Usage: t.sh [-a NAME]\nwhile getopts "a" opt; do\n  case "$opt" in\n    a) x=1 ;;\n  esac\ndone\n'],
    ['a header short flag getopts does not know', '# Usage: t.sh [-a] [-q]\nwhile getopts "a" opt; do\n  case "$opt" in\n    a) x=1 ;;\n  esac\ndone\n'],
    ['an unterminated quote', 'while getopts "a" opt; do\n  case "$opt" in\n    a) x="1 ;;\n  esac\ndone\n'],
    ...([
      ['an operand read and shifted', 'action=$1; shift'],
      ['a shift alone', 'shift'],
      ['${1} read', 'action="${1:-deploy}"'],
      ['$2 read', 'echo "$2"'],
      ['"$@" passed on', 'log "$@"'],
      ['$* read', 'echo $*'],
      ['${@} read', 'for a in "${@}"; do :; done'],
      ['the arguments replaced', 'set -- -a x']
    ] as const).map(([how, line]) => [`the arguments read before the loop: ${how}`,
      `${line}\nwhile getopts "a" opt; do\n  case "$opt" in\n    a) x=1 ;;\n  esac\ndone\n`]),
    ['a Usage line with an operand before an option', '# Usage: t.sh <action> [-a]\nwhile getopts "a" opt; do\n  case "$opt" in\n    a) x=1 ;;\n  esac\ndone\n']
  ])('%s → null', (_name, body) => {
    expect(parseScriptSpec(`#!/bin/bash\n${body}`, { script: 't.sh' })).toBeNull()
  })

  it('the refusals\' base shape reads: each row above is null for its own reason', () => {
    const spec = parseScriptSpec('#!/bin/bash\nwhile getopts "a" opt; do\n  case "$opt" in\n    a) x=1 ;;\n  esac\ndone\n', { script: 't.sh' })
    expect(spec!.params.map((p) => p.id)).toEqual(['x'])
    const header = parseScriptSpec('#!/bin/bash\n# Usage: t.sh [-a]\nwhile getopts "a" opt; do\n  case "$opt" in\n    a) x=1 ;;\n  esac\ndone\n', { script: 't.sh' })
    expect(header!.params.map((p) => [p.id, p.flags])).toEqual([['x', ['-a']]])
    // `case ${opt} in` and an unbraced `"$@"` after the variable read too; so does a catch-all after every letter.
    expect(parseScriptSpec('while getopts ab: opt "$@"\ndo\n  case ${opt} in\n    (a) x=1 ;;\n    b) y=$OPTARG ;;\n    *) exit 1 ;;\n  esac\ndone\n', { script: 't.sh' })).not.toBeNull()
    // Before the loop: a function's own `$1` and `shift`, `$0`, a `$#` check and `OPTIND=1` read none of the script's arguments.
    const before = 'usage() {\n  echo "usage: $0 [-a] $1" >&2\n}\nfunction die { echo "$1"; shift; exit 1; }\n[ $# -gt 5 ] && usage\nOPTIND=1\n'
    expect(parseScriptSpec(`${before}while getopts "a" opt; do\n  case "$opt" in\n    a) x=1 ;;\n  esac\ndone\n`, { script: 't.sh' })!.params.map((p) => p.id)).toEqual(['x'])
  })

  it('hostile input → null within the parse budget', () => {
    nullInTime(SCRIPT('', 'a', Array.from({ length: 20_000 }, () => '    a) x=1 ;;').join('\n')), 't.sh')
    nullInTime(`while getopts "a" opt; do\n  case "$opt" in\n    a) x=$(${'$('.repeat(50_000)}\n`, 't.sh')
    nullInTime(`${'cat <<EOF\n'.repeat(20_000)}while getopts "a" opt; do :; done\n`, 't.sh')
    nullInTime(`x="${'a'.repeat(300_000)}\ngetopts`, 't.sh')
  })
})

describe('parseScriptSpec: hostile input stays within the parse budget on main\'s thread', () => {
  const LOOP = 'while getopts "a" opt; do\n  case "$opt" in\n    a) x=1 ;;\n  esac\ndone\n'
  const CASES: [string, string, string][] = [
    // click
    ['click: 20 000 decorators of its own', 'x.py', `import click\n@click.command()\n${'@click.option("--x")\n'.repeat(20_000)}def cli(x):\n    pass\ncli()\n`],
    ['click: 30 000 foreign decorators above the stack', 'x.py', `import click\n${'@retry\n'.repeat(30_000)}@click.command()\n@click.option("--x")\ndef cli(x):\n    pass\ncli()\n`],
    ['click: an option call that never closes', 'x.py', `import click\n@click.command()\n@click.option("--x", ${'('.repeat(150_000)}\ndef cli(x):\n    pass\ncli()\n`],
    ['click: 30 000 click.command uses outside decorators', 'x.py', `import click\n${'click.command\n'.repeat(30_000)}`],
    // typer
    ['typer: 30 000 decorators on the function', 'x.py', `import typer\n${'@log\n'.repeat(30_000)}def main(x: str):\n    pass\ntyper.run(main)\n`],
    ['typer: a signature that never closes', 'x.py', `import typer\ndef main(${'x: int = 1, '.repeat(30_000)}\ntyper.run(main)\n`],
    ['typer: 6 000 commands on the app', 'x.py', `import typer\napp = typer.Typer()\n${'@app.command()\ndef a(x: str):\n    pass\n'.repeat(6_000)}app()\n`],
    ['typer: an Annotated nested 20 000 deep', 'x.py', `import typer\ndef main(x: ${'Annotated['.repeat(20_000)}str${']'.repeat(20_000)}):\n    pass\ntyper.run(main)\n`],
    // shell lexer and getopts
    ['shell: 100 000 nested $(', 't.sh', `getopts\nx=${'$('.repeat(100_000)}\n`],
    ['shell: 100 000 nested ${', 't.sh', `getopts\nx=${'${'.repeat(100_000)}\n`],
    ['shell: an unterminated backtick', 't.sh', `getopts\nx=\`${'a '.repeat(150_000)}\n`],
    ['shell: an unterminated single quote', 't.sh', `getopts\nx='${'a;'.repeat(150_000)}\n`],
    ['shell: 30 000 heredocs on one line', 't.sh', `getopts\ncat ${'<<EOF '.repeat(30_000)}\nbody\n`],
    ['shell: 200 000 semicolons in an arm', 't.sh', `while getopts "a" opt; do\n  case "$opt" in\n    a) x=1 ${'; '.repeat(200_000)}\n`],
    ['shell: a case nested 20 000 deep in an arm', 't.sh', `while getopts "a" opt; do\n  case "$opt" in\n    a) ${'case x in y) '.repeat(20_000)}\n  esac\ndone\n`],
    ['shell: 30 000 arms for one letter', 't.sh', `while getopts "a" opt; do\n  case "$opt" in\n${'    a) x=1 ;;\n'.repeat(30_000)}  esac\ndone\n`],
    ['shell: 30 000 shifts before the loop', 't.sh', `${'f() { shift; }\n'.repeat(30_000)}shift\n${LOOP}`]
  ]

  it.each(CASES)('%s → null', (_name, script, source) => {
    nullInTime(source, script)
  })

  it('shell: 200 000 semicolons before the loop still read it, in time', () => {
    const { spec, ms } = timed(`${';'.repeat(200_000)}\n${LOOP}`, 't.sh')
    expect((spec as ScriptSpec).params.map((p) => p.id)).toEqual(['x'])
    expect(ms).toBeLessThan(PARSE_BUDGET_MS)
  })
})
