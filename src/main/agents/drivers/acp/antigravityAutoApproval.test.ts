import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  antigravityAutoApproves,
  nodeAutoApprovalFs,
  splitCommandLine,
  type AntigravityAutoApprovalPolicy,
  type AutoApprovalFs
} from './antigravityAutoApproval'

/**
 * The rule that settles an Antigravity folder agent's asks without the user.
 * Run against a real temporary folder, because the containment it guards is
 * decided by realpath and symlinks: a fake that resolved paths lexically would
 * pass the escapes this rule exists to catch.
 */

let base: string
let folder: string
let pinned: string
let outside: string
let policy: AntigravityAutoApprovalPolicy

function file(path: string, body = 'x'): void {
  mkdirSync(join(path, '..'), { recursive: true })
  writeFileSync(path, body)
}

beforeAll(() => {
  base = realpathSync(mkdtempSync(join(tmpdir(), 'agy-auto-')))
  folder = join(base, 'agent')
  pinned = join(base, 'cache', 'word-count')
  outside = join(base, 'other')
  file(join(folder, 'skills', 'word-count', 'scripts', 'count.py'))
  file(join(folder, 'scripts', 'x.sh'))
  file(join(folder, 'notes', 'a.txt'))
  file(join(folder, 'credentials', '.env'))
  file(join(folder, 'credentials', 'README.md'))
  file(join(folder, '.cinna', 'antigravity', 'config', 'hooks.json'))
  file(join(folder, 'app-data', 'desktop.json'))
  file(join(folder, 'sub', 'ok.txt'))
  file(join(folder, 'sub', '.env'))
  file(join(folder, 'pems', 'a.pem'))
  file(join(folder, 'hid', 'ok.txt'))
  file(join(folder, 'hid', '.note'))
  file(join(pinned, 'SKILL.md'))
  file(join(pinned, 'scripts', 'run.py'))
  file(join(outside, 'file'))
  symlinkSync(outside, join(folder, 'escape'))
  symlinkSync(join(outside, 'nowhere'), join(folder, 'notes', 'dangling'))
  policy = { folder, scriptRoots: [pinned] }
})
afterAll(() => rmSync(base, { recursive: true, force: true }))

const run = (CommandLine: string, cwd?: string): boolean =>
  antigravityAutoApproves(policy, { kind: 'execute', rawInput: { CommandLine, Cwd: cwd ?? folder, WaitMsBeforeAsync: 500 } })
const edit = (...paths: string[]): boolean =>
  antigravityAutoApproves(policy, { kind: 'edit', locations: paths.map((path) => ({ path })) })

describe('commands Cinna runs without asking', () => {
  it.each([
    // The recorded real ask (Antigravity 1.3.0).
    ['uv run python skills/word-count/scripts/count.py "the quick brown fox"'],
    ['uv run --quiet --no-project python3 skills/word-count/scripts/count.py a'],
    ['uv run skills/word-count/scripts/count.py a'],
    ['./scripts/x.sh a b'],
    ['bash scripts/x.sh'],
    ['ls -la'],
    ['ls notes'],
    ['pwd'],
    ['grep -rn foo skills/'],
    ['grep -n foo notes/a.txt'],
    ['grep -e KEY notes/a.txt'],
    ['rg TODO skills'],
    ['cat notes/a.txt'],
    ['cat credentials/README.md'],
    ['head -n 5 notes/a.txt'],
    ['tail -n 5 notes/a.txt'],
    ['wc -l notes/a.txt'],
    ['find . -name "*.py"'],
    ["cat 'notes/a.txt'"],
    // rg skips hidden entries unless told otherwise; a hidden file outside the protected set is readable.
    ['rg K hid'],
    ['cat hid/.note'],
    ['head -5 notes/a.txt'],
    ['file -b notes/a.txt'],
    ['stat -x notes/a.txt']
  ])('%s', (line) => {
    expect(run(line)).toBe(true)
  })

  it('a pinned skill’s script by its absolute path', () => {
    expect(run(`python3 ${join(pinned, 'scripts', 'run.py')} --words 3`)).toBe(true)
  })

  it('relative to a cwd under the folder', () => {
    expect(run('cat a.txt', join(folder, 'notes'))).toBe(true)
  })
})

describe('commands that still ask', () => {
  it.each([
    ['ls; rm -rf ~'],
    ['ls && rm x'],
    ['ls | sh'],
    ['cat notes/a.txt > notes/b.txt'],
    ['cat credentials/.env'],
    ['cat x.env'],
    ['cat .env.local'],
    ['cat server.pem'],
    ['cat .cinna/antigravity/config/hooks.json'],
    ['cat app-data/desktop.json'],
    ['ls credentials'],
    ['find -L . -name x'],
    ['find . -follow -name x'],
    ['grep -r KEY .'],
    ['grep -r KEY'],
    ['grep -R foo skills'],
    ['grep -f patterns notes/a.txt'],
    ['grep --regexp=foo /etc/passwd'],
    ['rg KEY'],
    ['rg --files /etc', ],
    ['rg --pre cat foo skills'],
    ['rg -z foo skills'],
    ['python -c \'print(1)\''],
    ['python -m http.server'],
    ['node -e 1'],
    ['uv run --with requests x.py'],
    ['uv run skills/word-count/scripts/count.sh'],
    ['find . -delete'],
    ['find . -exec rm {} ;'],
    ['find . -name x -fprint out'],
    ['find -L /etc'],
    ['echo $(id)'],
    ['echo hi'],
    ['cat "$HOME/x"'],
    ['cat `id`'],
    ['cat notes/*.txt'],
    ['cat ~/x'],
    ['cat ../other/file'],
    ['cat escape/file'],
    ['python3 escape/file'],
    ['./scripts/missing.sh'],
    ['python3 notes'],
    ['rm notes/a.txt'],
    ['date'],
    ['FOO=1 ./scripts/x.sh'],
    ['tail -f notes/a.txt'],
    ['ls\nrm x'],
    ['ls # hidden'],
    ['=rm x'],
    [''],
    ['   '],
    ['/bin/rm -rf notes'],
    ['cat "unterminated'],
    // A recursive search reads every file under its root: nothing protected, and no hidden file where it reads them.
    ['grep -r x app-data'],
    ['grep -r K sub'],
    ['rg K pems'],
    ['rg --hidden -uu K pems'],
    ['grep -r K hid'],
    ['rg --hidden K hid'],
    ['rg -uu K hid'],
    // GNU long-option abbreviations and options that read or write another file.
    ['file --files=/etc/hosts'],
    ['file --mag=/tmp/m notes/a.txt'],
    ['wc --files0=/etc/hosts'],
    ['tail --fo notes/a.txt'],
    ['file -C'],
    ['file -C notes/a.txt'],
    ['ls --color=always'],
    // No path: the reader would wait on standard input.
    ['cat'],
    ['head -n 5'],
    ['tail'],
    ['wc -l'],
    ['grep foo'],
    ['file'],
    ['stat']
  ])('%j', (line) => {
    expect(run(line)).toBe(false)
  })

  it('when the cwd is outside the folder', () => {
    expect(run('ls', outside)).toBe(false)
    expect(run('ls', join(folder, 'escape'))).toBe(false)
  })

  it('when the cwd is a protected folder inside it', () => {
    expect(run('ls -la', join(folder, 'credentials'))).toBe(false)
    expect(run('ls -R', join(folder, '.cinna', 'antigravity'))).toBe(false)
  })

  it('when the ask is not shaped as recorded', () => {
    expect(antigravityAutoApproves(policy, { kind: 'execute', rawInput: { CommandLine: 'ls' } })).toBe(false)
    expect(antigravityAutoApproves(policy, { kind: 'execute', rawInput: { CommandLine: 'ls', Cwd: 'notes' } })).toBe(false)
    expect(antigravityAutoApproves(policy, { kind: 'execute', rawInput: null })).toBe(false)
    expect(antigravityAutoApproves(policy, { kind: 'fetch', rawInput: { CommandLine: 'ls', Cwd: folder } })).toBe(false)
  })

  it('a pinned root’s script when the root is not on the policy', () => {
    expect(antigravityAutoApproves({ folder, scriptRoots: [] }, { kind: 'execute',
      rawInput: { CommandLine: `python3 ${join(pinned, 'scripts', 'run.py')}`, Cwd: folder } })).toBe(false)
  })
})

describe('edits', () => {
  it('inside the folder, existing or new', () => {
    expect(edit(join(folder, 'notes', 'a.txt'))).toBe(true)
    expect(edit(join(folder, 'notes', 'new', 'probe.txt'))).toBe(true)
    expect(edit(join(folder, 'notes', 'a.txt'), join(folder, 'notes', 'b.txt'))).toBe(true)
  })

  it.each([
    ['.cinna/antigravity/config/hooks.json'],
    ['.agents/hooks.json'],
    ['.git/hooks/pre-commit'],
    ['app-data/desktop.json'],
    ['app-data/desktop.json.tmp'],
    ['credentials/.env'],
    ['credentials/README.md'],
    ['notes/x.env'],
    ['notes/id.key'],
    ['escape/file'],
    ['notes/dangling'],
    ['../other/file'],
    // Hidden configuration that runs or steers code.
    ['.claude/settings.json'],
    ['.envrc'],
    ['.agent/rules/x.md'],
    ['notes/.hidden'],
    // Instructions the engines read every session.
    ['AGENTS.md'],
    ['GEMINI.md'],
    ['skills/word-count/CLAUDE.md']
  ])('asks for %s', (rel) => {
    expect(edit(join(folder, rel))).toBe(false)
  })

  it('asks for an outside path, a relative one, none, or one of two outside', () => {
    expect(edit(join(outside, 'file'))).toBe(false)
    expect(edit('notes/a.txt')).toBe(false)
    expect(edit()).toBe(false)
    expect(edit(join(folder, 'notes', 'a.txt'), join(outside, 'file'))).toBe(false)
  })
})

describe('failing closed', () => {
  it('answers no when the filesystem cannot be read', () => {
    const denied: AutoApprovalFs = { ...nodeAutoApprovalFs, realpath: () => { throw Object.assign(new Error('EACCES'), { code: 'EACCES' }) } }
    expect(antigravityAutoApproves(policy, { kind: 'edit', locations: [{ path: join(folder, 'notes', 'a.txt') }] }, denied)).toBe(false)
    expect(antigravityAutoApproves(policy, { kind: 'execute', rawInput: { CommandLine: 'ls', Cwd: folder } }, denied)).toBe(false)
  })

  it('asks when a search tree is too large or cannot be listed', () => {
    const many = Array.from({ length: 5001 }, (_, i) => ({ name: `f${i}.txt`, isDirectory: () => false, isSymbolicLink: () => false }))
    const huge: AutoApprovalFs = { ...nodeAutoApprovalFs, readdir: (path) => path.endsWith('/sub') ? many : nodeAutoApprovalFs.readdir(path) }
    const search = { kind: 'execute', rawInput: { CommandLine: 'grep -r K sub', Cwd: folder } }
    expect(antigravityAutoApproves(policy, { kind: 'execute', rawInput: { CommandLine: 'grep -r K skills', Cwd: folder } }, huge)).toBe(true)
    expect(antigravityAutoApproves(policy, { ...search, rawInput: { CommandLine: 'grep -r K notes', Cwd: folder } },
      { ...nodeAutoApprovalFs, readdir: (path) => path.endsWith('/notes') ? many : nodeAutoApprovalFs.readdir(path) })).toBe(false)
    const unreadable: AutoApprovalFs = { ...nodeAutoApprovalFs, readdir: () => { throw Object.assign(new Error('EACCES'), { code: 'EACCES' }) } }
    expect(antigravityAutoApproves(policy, { kind: 'execute', rawInput: { CommandLine: 'grep -r K skills', Cwd: folder } }, unreadable)).toBe(false)
  })

  it('answers no for a folder it was not given absolutely', () => {
    expect(antigravityAutoApproves({ folder: 'agent', scriptRoots: [] }, { kind: 'execute', rawInput: { CommandLine: 'ls', Cwd: folder } })).toBe(false)
  })
})

describe('the word splitter', () => {
  it('splits words, quotes and escapes as a shell does', () => {
    expect(splitCommandLine(`a "b c" 'd e' f\\ g "h\\"i" ''`)).toEqual(['a', 'b c', 'd e', 'f g', 'h"i', ''])
  })

  it('keeps `$` and globs inside single quotes literal', () => {
    expect(splitCommandLine(`grep '$HOME*' x`)).toEqual(['grep', '$HOME*', 'x'])
  })
})
