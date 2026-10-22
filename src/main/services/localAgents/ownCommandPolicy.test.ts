import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { looksAutoRunnable } from '../../../shared/commandRun'
import { COMMAND_CASES, COMMAND_CASE_FILES } from '../../../shared/commandRunCases'
import { OWN_COMMAND_REASONS, nodeOwnCommandFs, ownCommandAllowed, ownCommandRefusal, type OwnCommandFs, type OwnCommandPolicy } from './ownCommandPolicy'

/**
 * The fs-aware half of the rule, against a real temporary folder (containment
 * is decided by realpath and symlinks). Each case here passes the menu's
 * disk-free check, so the menu offers Run, and main must still refuse it.
 */

let base: string
let folder: string
let pinned: string
let policy: OwnCommandPolicy

function file(path: string): void {
  mkdirSync(join(path, '..'), { recursive: true })
  writeFileSync(path, 'x')
}

beforeAll(() => {
  base = realpathSync(mkdtempSync(join(tmpdir(), 'own-command-')))
  folder = join(base, 'agent')
  pinned = join(base, 'cache', 'skill')
  file(join(folder, 'scripts', 'load_time_keys.py'))
  file(join(folder, 'credentials', 'x'))
  file(join(folder, 'notes', 'a.txt'))
  file(join(pinned, 'scripts', 'run.py'))
  file(join(base, 'outside', 'evil.py'))
  symlinkSync(join(base, 'outside'), join(folder, 'linked'))
  policy = { folder, scriptRoots: [pinned] }
})
afterAll(() => rmSync(base, { recursive: true, force: true }))

const allowed = (line: string, cwd = folder, fs?: OwnCommandFs): boolean => ownCommandAllowed(policy, cwd, line, fs)

describe('ownCommandAllowed', () => {
  it('runs the agent\'s own script and the read-only basics in its folder', () => {
    expect(allowed('uv run scripts/load_time_keys.py --apply')).toBe(true)
    expect(allowed(`python3 ${join(pinned, 'scripts', 'run.py')}`)).toBe(true)
    expect(allowed('cat notes/a.txt')).toBe(true)
    expect(allowed('ls -la')).toBe(true)
  })

  // Each of these looks runnable to the menu; the disk says no.
  it.each([
    ['a missing script', 'uv run scripts/missing.py'],
    ['a symlink out of the folder', 'python linked/evil.py'],
    ['a protected file', 'cat credentials/x'],
    ['a search rooted at a symlink out of the folder', 'rg evil linked']
  ])('refuses %s', (_name, line) => {
    expect(looksAutoRunnable(line)).toBe(true)
    expect(allowed(line)).toBe(false)
  })

  it('refuses what the parser refuses', () => {
    expect(allowed('uv run scripts/load_time_keys.py && rm y')).toBe(false)
    expect(allowed('rm -rf build')).toBe(false)
  })

  it('refuses a cwd outside the folder or in a protected one, and a relative one', () => {
    expect(allowed('ls', join(base, 'outside'))).toBe(false)
    expect(allowed('ls', join(folder, 'credentials'))).toBe(false)
    expect(allowed('ls', 'agent')).toBe(false)
  })

  it('fails closed when the filesystem cannot be read', () => {
    const denied: OwnCommandFs = { ...nodeOwnCommandFs, realpath: () => { throw Object.assign(new Error('EACCES'), { code: 'EACCES' }) } }
    expect(allowed('ls', folder, denied)).toBe(false)
    expect(ownCommandAllowed({ folder: 'agent', scriptRoots: [] }, folder, 'ls')).toBe(false)
  })
})

describe('ownCommandRefusal', () => {
  const reason = (line: string): string | null => ownCommandRefusal(policy, folder, line)

  it('answers null exactly when the rule allows', () => {
    expect(reason('uv run scripts/load_time_keys.py --apply')).toBeNull()
    expect(reason('cat notes/a.txt')).toBeNull()
  })

  it.each([
    ['a missing script, named', 'uv run scripts/missing.py', OWN_COMMAND_REASONS.scriptMissing('scripts/missing.py')],
    ['a script outside the folder', 'python linked/evil.py', OWN_COMMAND_REASONS.outside('linked/evil.py')],
    ['a path outside the folder', 'cat ../outside/evil.py', OWN_COMMAND_REASONS.outside('../outside/evil.py')],
    ['a protected folder', 'cat credentials/x', OWN_COMMAND_REASONS.protected('credentials/x')],
    ['an option outside the table', 'tail -f notes/a.txt', OWN_COMMAND_REASONS.option('tail', '-f')],
    ['a find action', 'find . -delete', OWN_COMMAND_REASONS.option('find', '-delete')],
    ['a search over the whole folder', 'grep -r foo .', OWN_COMMAND_REASONS.searchRoot('grep')],
    ['a search with no root', 'rg foo', OWN_COMMAND_REASONS.searchRoot('rg')],
    ['a reader with no path', 'cat', OWN_COMMAND_REASONS.needsPath('cat')],
    ['more than one simple command', 'ls | sh', OWN_COMMAND_REASONS.notSimple],
    ['an environment assignment', 'FOO=1 ls', OWN_COMMAND_REASONS.env],
    ['a command that is neither', 'git status', OWN_COMMAND_REASONS.notOwn('git')],
    ['an empty line', '', OWN_COMMAND_REASONS.empty]
  ])('says why for %s', (_name, line, expected) => {
    expect(reason(line)).toBe(expected)
    expect(allowed(line)).toBe(false)
  })
})

describe('the menu and the rule agree', () => {
  let caseFolder: string
  beforeAll(() => {
    caseFolder = join(base, 'cases')
    for (const path of COMMAND_CASE_FILES) file(join(caseFolder, path))
  })

  // Every row the menu offers Run for passes main's rule where its files
  // exist, and every row it sends to review main refuses too.
  it.each(COMMAND_CASES.filter((row): row is [string, string, boolean] => row[1] !== null))('%s', (_text, command, auto) => {
    expect(looksAutoRunnable(command)).toBe(auto)
    expect(ownCommandAllowed({ folder: caseFolder, scriptRoots: [] }, caseFolder, command)).toBe(auto)
  })
})
