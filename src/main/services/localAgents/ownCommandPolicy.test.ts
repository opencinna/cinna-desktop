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
  file(join(folder, '.cinna', 'antigravity', 'antigravity-acp', 'brain', 'ses1', 'mcp', 'cinna', 'build_brief_propose.json'))
  file(join(folder, '.cinna', 'antigravity', 'antigravity-acp', 'brain', 'ses1', 'task.md'))
  file(join(folder, '.cinna', 'config', 'hooks.json'))
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

describe('the Antigravity home’s MCP tool schemas', () => {
  // The agent lists them to learn a Cinna tool's shape; an ask there was a
  // new user's first sight of a guided build. Mutation: drop the exception and
  // the first two ask; widen it to `.cinna/` and the last two run unasked.
  const MCP = '.cinna/antigravity/antigravity-acp/brain/ses1/mcp/cinna'
  it('may be listed and read', () => {
    expect(allowed(`ls -la ${MCP}/`)).toBe(true)
    expect(allowed(`cat ${MCP}/build_brief_propose.json`)).toBe(true)
  })
  it('opens nothing else in the home, and no write', () => {
    expect(allowed('cat .cinna/antigravity/antigravity-acp/brain/ses1/task.md')).toBe(false)
    expect(allowed('cat .cinna/config/hooks.json')).toBe(false)
    expect(allowed(`rm ${MCP}/build_brief_propose.json`)).toBe(false)
  })
})

describe('the workshop kit', () => {
  // A building agent reads the kit's guides (`../../.cinna-kit` from its
  // folder) and runs its validator. Mutation: drop the kit from the policy and
  // every line in the first test asks; widen it and the second test runs.
  let root: string
  let agent: string
  let kitPolicy: OwnCommandPolicy
  beforeAll(() => {
    root = join(base, 'workshop')
    agent = join(root, 'Local', 'news')
    file(join(agent, 'scripts', 'run.py'))
    file(join(root, '.cinna-kit', 'guides', '05-schedules.md'))
    file(join(root, '.cinna-kit', 'tools', 'kit.py'))
    file(join(root, '.cinna-kit', 'tools', 'other.py'))
    kitPolicy = { folder: agent, scriptRoots: [], workshopKit: join(root, '.cinna-kit') }
  })
  const kitAllowed = (line: string): boolean => ownCommandAllowed(kitPolicy, agent, line)

  it('reads its guides and runs its validator', () => {
    expect(kitAllowed('cat ../../.cinna-kit/guides/05-schedules.md')).toBe(true)
    expect(kitAllowed('ls -la ../../.cinna-kit/guides/')).toBe(true)
    expect(kitAllowed('uv run ../../.cinna-kit/tools/kit.py validate .')).toBe(true)
  })

  it('runs nothing else there, and reads it only when the policy names it', () => {
    expect(kitAllowed('uv run ../../.cinna-kit/tools/kit.py refresh')).toBe(false)
    expect(kitAllowed('uv run ../../.cinna-kit/tools/other.py validate')).toBe(false)
    expect(kitAllowed('rm ../../.cinna-kit/guides/05-schedules.md')).toBe(false)
    expect(kitAllowed('grep -r schedules ../../.cinna-kit')).toBe(false)
    expect(ownCommandAllowed({ folder: agent, scriptRoots: [] }, agent, 'cat ../../.cinna-kit/guides/05-schedules.md')).toBe(false)
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
