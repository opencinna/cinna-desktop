/**
 * The update check, against real repositories.
 *
 * There is no useful way to fake this. Every interesting behaviour is a fact
 * about `git`'s own output — how far behind a branch is, what `merge --ff-only`
 * refuses, what a commit line looks like — and a stubbed subprocess would only
 * prove that the strings this file already contains were parsed by the parser
 * that was written for them. So it builds a bare origin, two clones, and drives
 * the real binary.
 *
 * `git` is assumed present: it is on every machine this project is developed or
 * built on, and the one behaviour that depends on its absence (`git_missing`)
 * is a branch that cannot be exercised on a machine that has it.
 */
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest'
import { execFileSync } from 'node:child_process'
import { spawn } from 'node:child_process'
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import {
  chmodSync,
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  symlinkSync,
  writeFileSync
} from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

vi.mock('../../logger/logger', () => ({
  createLogger: () => ({ debug: () => {}, info: () => {}, warn: () => {}, error: () => {} })
}))

/*
 * The git children gitService spawns get this machine's environment with the
 * user's own git config switched off — a developer's `commit.gpgsign`, hooks
 * path or identity must not decide whether these tests pass. Without a global
 * identity the sharing verbs have to supply one, which is part of what the
 * commit tests prove.
 */
vi.mock('../../shell/env', () => ({
  getShellEnv: async () => ({
    ...process.env,
    GIT_CONFIG_GLOBAL: '/dev/null',
    GIT_CONFIG_NOSYSTEM: '1',
    // Nor the user's global ignore file, which git reads from here even
    // without a global config (a developer's may ignore .claude/settings.local.json).
    XDG_CONFIG_HOME: '/nonexistent-cinna-test-xdg'
  }),
  shellEnvForChild: (env: NodeJS.ProcessEnv) =>
    Object.fromEntries(Object.entries(env).filter(([, v]) => typeof v === 'string')),
  usableTool: async () => 'git'
}))

// The kit contract (for the ignore file `initWithRemote` writes) is read from
// this checkout's bundle, as the scaffold tests do.
const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '../../../..')
vi.mock('electron', () => ({
  app: {
    isPackaged: false,
    getAppPath: () => repoRoot,
    getVersion: () => '0.0.0-test',
    on: () => undefined
  }
}))
vi.mock('../../host/runtimeHost', async () => {
  const { createDesktopHost } = await import('../../host/desktop/runtimeHost')
  return { runtimeHost: createDesktopHost() }
})

const {
  readGitStatus,
  updateGitRepo,
  readShareStatus,
  shareStateOf,
  initWithRemote,
  clone: cloneAgent,
  commitAll,
  pullRebaseClean,
  push: pushAgent,
  shareChanges,
  diffForSummary,
  restoreLocalOnlyFolders,
  keepLocalOnlyFiles,
  putBackLocalOnlyFiles,
  settleLocalOnlyFiles,
  restoreLeftoverLocalOnlyFiles,
  hasLeftoverLocalOnlyFiles,
  preflightShare,
  neverTravelPaths,
  beginAdoption,
  checkAdoptionFinish,
  discardAdoption,
  readVersionsBetween,
  diffBetween,
  ADOPTION_BEFORE_NOTE
} = await import('./gitService')
import type { AdoptionPoints } from './gitService'

let sandbox: string
let origin: string
let clone: string
let other: string

const ENV = {
  ...process.env,
  GIT_AUTHOR_NAME: 'Tester',
  GIT_AUTHOR_EMAIL: 'tester@example.test',
  GIT_COMMITTER_NAME: 'Tester',
  GIT_COMMITTER_EMAIL: 'tester@example.test',
  GIT_CONFIG_GLOBAL: '/dev/null',
  GIT_CONFIG_SYSTEM: '/dev/null',
  XDG_CONFIG_HOME: '/nonexistent-cinna-test-xdg'
}

function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8', env: ENV })
}

function agent(root: string, slug: string, body: string): void {
  const dir = join(root, 'local_agents', slug)
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, 'AGENT.md'), body)
}

beforeAll(() => {
  sandbox = mkdtempSync(join(tmpdir(), 'cinna-git-'))
  origin = join(sandbox, 'origin.git')
  clone = join(sandbox, 'clone')
  other = join(sandbox, 'other')
  for (const dir of [origin, clone, other]) mkdirSync(dir, { recursive: true })

  git(origin, 'init', '--bare', '-b', 'main', '.')
  git(clone, 'init', '-b', 'main', '.')
  git(clone, 'remote', 'add', 'origin', origin)
  agent(clone, 'alpha', '# Alpha\n')
  git(clone, 'add', '-A')
  git(clone, 'commit', '-m', 'the first agent')
  git(clone, 'push', '-u', 'origin', 'main')
  git(other, 'clone', origin, '.')
}, 60_000)

afterAll(() => {
  rmSync(sandbox, { recursive: true, force: true })
})

/** Push one new commit from the second clone, so the first falls behind. */
function pushUpstream(message: string, slug = 'beta'): void {
  agent(other, slug, `# ${slug}\n`)
  git(other, 'add', '-A')
  git(other, 'commit', '-m', message)
  git(other, 'push')
}

describe('readGitStatus', () => {
  it('reports a folder that is not a repository, without throwing', async () => {
    const plain = mkdtempSync(join(tmpdir(), 'cinna-git-plain-'))
    try {
      const status = await readGitStatus(plain)
      expect(status.isRepo).toBe(false)
      expect(status.refusal).toBe('not_a_repo')
    } finally {
      rmSync(plain, { recursive: true, force: true })
    }
  }, 30_000)

  it('reports branch, upstream and an up-to-date tree', async () => {
    const status = await readGitStatus(clone, true)
    expect(status.isRepo).toBe(true)
    expect(status.branch).toBe('main')
    expect(status.upstream).toBe('origin/main')
    expect(status.behind).toBe(0)
    expect(status.ahead).toBe(0)
    expect(status.refusal).toBeNull()
    expect(status.fetched).toBe(true)
  }, 30_000)

  it('counts what is waiting and lists it, newest first', async () => {
    pushUpstream('add the beta agent')
    pushUpstream('add the gamma agent', 'gamma')

    // Without the fetch the counts are the last fetch's, which is the whole
    // reason `fetch` is a parameter: the settings screen renders cached counts.
    expect((await readGitStatus(clone, false)).behind).toBe(0)

    const status = await readGitStatus(clone, true)
    expect(status.behind).toBe(2)
    expect(status.incoming.map((c) => c.subject)).toEqual([
      'add the gamma agent',
      'add the beta agent'
    ])
    // The unit-separator format, not a printable one: a subject containing the
    // delimiter would otherwise split a row into the wrong number of fields and
    // attribute a commit to the wrong person.
    expect(status.incoming[0].author).toBe('Tester')
    expect(status.incoming[0].hash).toMatch(/^[0-9a-f]{7,}$/)
    expect(status.incoming[0].date).toMatch(/^\d{4}-\d{2}-\d{2}T/)
  }, 30_000)

  it('says nothing about uncommitted work when nothing is waiting', async () => {
    // A refusal is about applying an update. A repository that is up to date
    // but has local edits was reporting "commit or discard them" — a demand on
    // a folder where nothing needs doing.
    await updateGitRepo(clone)
    writeFileSync(join(clone, 'local_agents', 'alpha', 'AGENT.md'), '# Alpha, edited\n')
    const status = await readGitStatus(clone, true)
    expect(status.behind).toBe(0)
    expect(status.dirty).toBe(true)
    expect(status.refusal).toBeNull()
  }, 30_000)

  it('refuses a dirty tree once there is something to apply', async () => {
    pushUpstream('add the delta agent', 'delta')
    const status = await readGitStatus(clone, true)
    expect(status.behind).toBe(1)
    expect(status.dirty).toBe(true)
    expect(status.refusal).toBe('dirty')
  }, 30_000)

  it('refuses a diverged history, which outranks a dirty tree', async () => {
    // Committing the local edit does not help: the history is still diverged,
    // so `diverged` has to be the one the user is told about.
    git(clone, 'add', '-A')
    git(clone, 'commit', '-m', 'a local change')
    const status = await readGitStatus(clone, true)
    expect(status.ahead).toBe(1)
    expect(status.behind).toBe(1)
    expect(status.refusal).toBe('diverged')
  }, 30_000)
})

describe('updateGitRepo', () => {
  /**
   * Note on what this does *not* pin: `merge --ff-only` itself.
   *
   * Dropping `--ff-only` leaves every test here green, because the `diverged`
   * refusal above returns before the merge is ever reached — the flag is
   * defence in depth behind a check that already covers it. The state where it
   * would be the only thing standing between the user and a merge commit is a
   * race: the tree diverging between the status read and the merge, which is
   * why `updateGitRepo` re-reads with a fetch first and why the flag stays.
   */
  it('never merges a diverged history, and changes nothing', async () => {
    // The rule the whole module exists to keep: resolving a conflict means
    // deciding whose work survives, in a repository this app knows nothing
    // about, with the result landing in files an agent is then run from.
    const before = git(clone, 'rev-parse', 'HEAD').trim()
    const result = await updateGitRepo(clone)
    expect(result.updated).toBe(false)
    expect(result.refusal).toBe('diverged')
    expect(result.applied).toEqual([])
    expect(git(clone, 'rev-parse', 'HEAD').trim()).toBe(before)
  }, 30_000)

  it('fast-forwards, and reports the commits it applied', async () => {
    // A fresh clone, so this one is behind and not diverged.
    const fresh = join(sandbox, 'fresh')
    mkdirSync(fresh, { recursive: true })
    git(fresh, 'clone', origin, '.')
    pushUpstream('add the epsilon agent', 'epsilon')

    const result = await updateGitRepo(fresh)

    expect(result.updated).toBe(true)
    expect(result.applied.map((c) => c.subject)).toEqual(['add the epsilon agent'])
    expect(result.status.behind).toBe(0)
    expect(result.status.refusal).toBeNull()
    // The pull is the point: a new agent folder is on disk afterwards.
    expect(git(fresh, 'ls-files', 'local_agents/epsilon/AGENT.md').trim()).not.toBe('')
  }, 60_000)

  it('is a no-op, not a failure, when there is nothing to apply', async () => {
    const fresh = join(sandbox, 'uptodate')
    mkdirSync(fresh, { recursive: true })
    git(fresh, 'clone', origin, '.')

    const result = await updateGitRepo(fresh)
    expect(result.updated).toBe(false)
    expect(result.refusal).toBeNull()
    expect(result.applied).toEqual([])
  }, 60_000)
})


// ---------------------------------------------------------------------------
// Sharing one agent folder with a team
// ---------------------------------------------------------------------------

const EXTERNAL = { kind: 'external' } as const

/**
 * A Cinna team library's auth, against a local bare repository: the header
 * is scoped to an origin git never reaches here, so it only switches on what
 * a `cinna` remote gets — the never-travel rules.
 */
const CINNA = { kind: 'cinna', origin: 'http://127.0.0.1:9', token: async () => 'tok-unused' } as const

/** A minimal kit agent folder, with things the ignore file must keep out. */
function kitAgent(dir: string, name: string): void {
  mkdirSync(join(dir, 'app-data'), { recursive: true })
  writeFileSync(
    join(dir, 'cinna-agent.json'),
    JSON.stringify({ id: `id-${name}`, name, description: `${name} agent` }, null, 2) + '\n'
  )
  writeFileSync(join(dir, 'AGENT.md'), `# ${name}\n\nLine one.\nLine two.\n`)
  writeFileSync(join(dir, '.env'), 'SECRET=1\n')
  writeFileSync(join(dir, 'app-data', 'state.json'), '{}\n')
}

function bare(path: string): string {
  mkdirSync(path, { recursive: true })
  git(path, 'init', '--bare', '-q', '-b', 'main', '.')
  return path
}

describe('sharing an agent folder', () => {
  let box: string
  let team: string
  let workshopA: string
  let a: string
  let b: string

  beforeAll(() => {
    box = mkdtempSync(join(tmpdir(), 'cinna-share-'))
    team = bare(join(box, 'team.git'))
    // Workshop A is itself a repository: the nested agent must stay out of it.
    workshopA = join(box, 'workshopA')
    mkdirSync(join(workshopA, 'Local'), { recursive: true })
    git(workshopA, 'init', '-q', '-b', 'main', '.')
    a = join(workshopA, 'Local', 'alpha')
    mkdirSync(a, { recursive: true })
    kitAgent(a, 'Alpha')
    b = join(box, 'workshopB', 'Local', 'alpha')
  }, 60_000)

  afterAll(() => {
    rmSync(box, { recursive: true, force: true })
  })

  it('shares a fresh folder in place, without its secrets, and hides it from the workshop repository', async () => {
    const result = await initWithRemote(a, team, EXTERNAL, { workshopRoot: workshopA })
    expect(result).toEqual({ done: true, refusal: null, detail: null })
    // The kit's ignore file, from the contract — not hard-coded.
    expect(readFileSync(join(a, '.gitignore'), 'utf8')).toContain('app-data/')
    const tree = git(team, 'ls-tree', '-r', '--name-only', 'main').split('\n')
    expect(tree).toContain('cinna-agent.json')
    expect(tree).toContain('AGENT.md')
    expect(tree).toContain('.gitignore')
    expect(tree).not.toContain('.env')
    expect(tree.some((path) => path.startsWith('app-data/'))).toBe(false)
    // The outer repository ignores the nested one, by a per-clone exclude line.
    expect(readFileSync(join(workshopA, '.git', 'info', 'exclude'), 'utf8')).toContain('/Local/alpha/\n')
    expect(git(workshopA, 'status', '--porcelain')).not.toContain('Local/alpha')
    // Identity came from the fallback: this repository and the test env name
    // nobody, and the fallback is never this machine's login and host name.
    expect(git(a, 'log', '-1', '--format=%an <%ae>').trim()).toBe(
      'Cinna Desktop user <cinna-desktop@users.noreply.invalid>'
    )

    const status = await readShareStatus(a, EXTERNAL, true)
    expect(status.ownRepo).toBe(true)
    expect(status.originUrl).toBe(team)
    expect(shareStateOf(status)).toBe('up_to_date')
  }, 60_000)

  it('refuses to share a folder that already has a team version', async () => {
    expect((await initWithRemote(a, team, EXTERNAL)).refusal).toBe('remote_exists')
  }, 30_000)

  it('gets the team version into a new folder, and refuses one that exists', async () => {
    expect(await cloneAgent(team, b, EXTERNAL)).toEqual({ done: true, refusal: null, detail: null })
    expect(existsSync(join(b, 'cinna-agent.json'))).toBe(true)
    expect((await cloneAgent(team, b, EXTERNAL)).refusal).toBe('exists')
    // No staging folder is left beside it.
    expect(readdirSync(dirname(b)).filter((name) => name.includes('.clone-'))).toEqual([])
  }, 60_000)

  it('refuses what is not an agent, and leaves nothing behind', async () => {
    const other = bare(join(box, 'not-agent.git'))
    const seed = join(box, 'seed')
    mkdirSync(seed)
    git(seed, 'init', '-q', '-b', 'main', '.')
    writeFileSync(join(seed, 'README.md'), 'hello\n')
    git(seed, 'add', '-A')
    git(seed, 'commit', '-q', '-m', 'seed')
    git(seed, 'push', '-q', other, 'main')
    const target = join(box, 'getter', 'Local', 'readme')
    expect((await cloneAgent(other, target, EXTERNAL)).refusal).toBe('not_an_agent')
    expect(existsSync(target)).toBe(false)
    expect(readdirSync(dirname(target))).toEqual([])
  }, 60_000)

  it('counts untracked files as changes to share, but never ignored ones', async () => {
    writeFileSync(join(a, 'notes.md'), 'a note\n')
    writeFileSync(join(a, '.env'), 'SECRET=2\n')
    writeFileSync(join(a, 'app-data', 'state.json'), '{"x":1}\n')
    const status = await readShareStatus(a, EXTERNAL, false)
    expect(status.changedFiles).toBe(1)
    expect(status.ahead).toBe(0)
    expect(shareStateOf(status)).toBe('unshared')
    expect(await diffForSummary(a)).toContain('notes.md')
  }, 30_000)

  it('leaves a tracked secret out of the text a share summary is written from', async () => {
    mkdirSync(join(a, 'credentials'), { recursive: true })
    writeFileSync(join(a, 'credentials', 'credentials.json'), '{"token":"tracked-secret-value"}\n')
    git(a, 'add', '-f', 'credentials/credentials.json')
    writeFileSync(join(a, 'summary.md'), 'a summary\n')
    git(a, 'add', 'summary.md')
    git(a, 'commit', '-q', '-m', 'local')
    const text = await diffForSummary(a)
    expect(text).toContain('summary.md')
    expect(text).not.toContain('tracked-secret-value')
    // The clones are shared across this block: leave nothing behind.
    git(a, 'reset', '-q', '--hard', 'HEAD~1')
    rmSync(join(a, 'credentials', 'credentials.json'), { force: true })
  }, 30_000)

  it('shares changes, and the teammate updates to them', async () => {
    expect(await shareChanges(a, 'Add a note', EXTERNAL)).toEqual({
      done: true,
      refusal: null,
      detail: null
    })
    const after = await readShareStatus(a, EXTERNAL, false)
    expect(after.ahead).toBe(0)
    expect(after.changedFiles).toBe(0)

    const behind = await readShareStatus(b, EXTERNAL, true)
    expect(behind.behind).toBe(1)
    // Files only the team changed are not this folder's changes.
    expect(behind.changedFiles).toBe(0)
    expect(shareStateOf(behind)).toBe('behind')

    expect((await pullRebaseClean(b, EXTERNAL)).done).toBe(true)
    expect(readFileSync(join(b, 'notes.md'), 'utf8')).toBe('a note\n')
    expect(shareStateOf(await readShareStatus(b, EXTERNAL, false))).toBe('up_to_date')
  }, 60_000)

  it('says nothing_to_share when nothing differs', async () => {
    expect((await shareChanges(b, 'nothing', EXTERNAL)).refusal).toBe('nothing_to_share')
    expect((await commitAll(b, 'nothing')).refusal).toBe('nothing_to_share')
  }, 30_000)

  it('refuses to update over edits that are not shared yet', async () => {
    writeFileSync(join(a, 'notes.md'), 'a note, revised\n')
    expect((await shareChanges(a, 'Revise the note', EXTERNAL)).done).toBe(true)
    writeFileSync(join(b, 'AGENT.md'), '# Alpha\n\nEdited on B.\n')
    expect((await pullRebaseClean(b, EXTERNAL)).refusal).toBe('dirty')
    git(b, 'checkout', '--', 'AGENT.md')
    expect((await pullRebaseClean(b, EXTERNAL)).done).toBe(true)
  }, 60_000)

  it('rebases a teammate\'s unrelated change cleanly when sending', async () => {
    writeFileSync(join(a, 'from-a.md'), 'a\n')
    expect((await shareChanges(a, 'A adds a file', EXTERNAL)).done).toBe(true)
    writeFileSync(join(b, 'from-b.md'), 'b\n')
    // B's push is refused as non-fast-forward, rebased onto A's, and sent.
    expect((await shareChanges(b, 'B adds a file', EXTERNAL)).done).toBe(true)
    const tree = git(team, 'ls-tree', '-r', '--name-only', 'main')
    expect(tree).toContain('from-a.md')
    expect(tree).toContain('from-b.md')
  }, 60_000)

  it('refuses dirty with an unsent version unless told to combine, then answers diverged_conflict on clashing edits, and leaves the folder exactly as it was', async () => {
    expect((await pullRebaseClean(a, EXTERNAL)).done).toBe(true)
    writeFileSync(join(a, 'AGENT.md'), '# Alpha\n\nLine one, by A.\nLine two.\n')
    expect((await shareChanges(a, 'A rewrites line one', EXTERNAL)).done).toBe(true)

    writeFileSync(join(b, 'AGENT.md'), '# Alpha\n\nLine one, by B.\nLine two.\n')
    expect((await commitAll(b, 'B rewrites line one')).done).toBe(true)
    const head = git(b, 'rev-parse', 'HEAD').trim()

    const status = await readShareStatus(b, EXTERNAL, true)
    expect(status.ahead).toBe(1)
    expect(status.behind).toBe(1)
    expect(shareStateOf(status)).toBe('diverged')

    // Update never combines an unsent version on its own, clash or no clash.
    expect((await pullRebaseClean(b, EXTERNAL)).refusal).toBe('dirty')
    expect(git(b, 'rev-parse', 'HEAD').trim()).toBe(head)
    expect(readFileSync(join(b, 'AGENT.md'), 'utf8')).toBe('# Alpha\n\nLine one, by B.\nLine two.\n')
    expect(git(b, 'status', '--porcelain')).toBe('')

    expect((await pullRebaseClean(b, EXTERNAL, null, undefined, { combine: true })).refusal).toBe('diverged_conflict')
    expect(git(b, 'rev-parse', 'HEAD').trim()).toBe(head)
    expect(readFileSync(join(b, 'AGENT.md'), 'utf8')).toBe('# Alpha\n\nLine one, by B.\nLine two.\n')
    expect(git(b, 'status', '--porcelain')).toBe('')
    expect(existsSync(join(b, '.git', 'rebase-merge'))).toBe(false)
    expect(existsSync(join(b, '.git', 'rebase-apply'))).toBe(false)

    // Sending never forces either: the team's version touches the same file
    // as the unsent one, so the send's retry is refused before any combine is
    // tried — Bring together is the answer, and it is what meets the clash.
    const teamHead = git(team, 'rev-parse', 'main').trim()
    expect((await pushAgent(b, EXTERNAL)).refusal).toBe('team_changed_again')
    expect(git(team, 'rev-parse', 'main').trim()).toBe(teamHead)
    expect(git(b, 'rev-parse', 'HEAD').trim()).toBe(head)
  }, 60_000)

  it('reports the team as ahead when the library lists a head this folder does not have', async () => {
    const status = await readShareStatus(a, null, false, 'f'.repeat(40))
    expect(status.behind).toBe(-1)
    expect(status.remoteHeadSha).toBe('f'.repeat(40))
    // A listed head already in this folder's history is not "behind".
    const head = git(a, 'rev-parse', 'HEAD~1').trim()
    expect((await readShareStatus(a, null, false, head)).behind).toBe(0)
  }, 30_000)

  it('keeps secrets out of the first version when the folder\'s own .gitignore covers nothing', async () => {
    const dir = join(box, 'workshopD', 'Local', 'delta')
    mkdirSync(join(dir, 'credentials'), { recursive: true })
    kitAgent(dir, 'Delta')
    // A developer's own .gitignore, which says nothing about secrets.
    writeFileSync(join(dir, '.gitignore'), '')
    writeFileSync(join(dir, 'credentials', '.env'), 'API_KEY=live\n')
    writeFileSync(join(dir, 'app-data', 'desktop.json'), '{"token":"bearer"}\n')
    const remote = bare(join(box, 'delta.git'))
    expect(await initWithRemote(dir, remote, EXTERNAL)).toEqual({ done: true, refusal: null, detail: null })
    const tree = git(remote, 'ls-tree', '-r', '--name-only', 'main').split('\n')
    expect(tree).toContain('AGENT.md')
    expect(tree).not.toContain('credentials/.env')
    expect(tree).not.toContain('.env')
    expect(tree.some((path) => path.startsWith('app-data/'))).toBe(false)
    // The kit's rules sit in the folder's own exclude file, once.
    const exclude = readFileSync(join(dir, '.git', 'info', 'exclude'), 'utf8')
    expect(exclude.match(/# >>> Cinna Desktop/g)).toHaveLength(1)
    writeFileSync(join(dir, 'notes.md'), 'x\n')
    expect((await shareChanges(dir, 'notes', EXTERNAL)).done).toBe(true)
    expect(readFileSync(join(dir, '.git', 'info', 'exclude'), 'utf8')).toBe(exclude)
  }, 60_000)

  it('refuses secrets_tracked when the folder already records a secret, and records and sends nothing', async () => {
    const remote = bare(join(box, 'epsilon.git'))
    const dir = join(box, 'workshopE', 'Local', 'epsilon')
    mkdirSync(dir, { recursive: true })
    kitAgent(dir, 'Epsilon')
    git(dir, 'init', '-q', '-b', 'main', '.')
    git(dir, 'add', 'cinna-agent.json', 'AGENT.md', '.env')
    git(dir, 'commit', '-q', '-m', 'mine, with a secret')
    // Sharing the developer's own repository: refused before origin is added.
    const shared = await initWithRemote(dir, remote, EXTERNAL)
    expect(shared.refusal).toBe('secrets_tracked')
    expect(shared.detail).toBe('.env')
    expect(() => git(dir, 'config', '--get', 'remote.origin.url')).toThrow()
    // Share changes on one that already has a team version.
    git(dir, 'remote', 'add', 'origin', remote)
    writeFileSync(join(dir, 'notes.md'), 'x\n')
    const head = git(dir, 'rev-parse', 'HEAD').trim()
    expect((await shareChanges(dir, 'notes', EXTERNAL)).refusal).toBe('secrets_tracked')
    expect(git(dir, 'rev-parse', 'HEAD').trim()).toBe(head)
    expect(git(dir, 'ls-files', 'notes.md').trim()).toBe('')
    expect(() => git(remote, 'rev-parse', '--verify', 'main')).toThrow()
  }, 60_000)

  it('carries the server\'s own sentence when it refuses the changes', async () => {
    const guarded = bare(join(box, 'guarded.git'))
    const hook = join(guarded, 'hooks', 'pre-receive')
    writeFileSync(hook, '#!/bin/sh\necho "This agent may not contain a credentials file." >&2\nexit 1\n')
    chmodSync(hook, 0o755)
    const dir = join(box, 'workshopC', 'Local', 'gamma')
    mkdirSync(dir, { recursive: true })
    kitAgent(dir, 'Gamma')
    const result = await initWithRemote(dir, guarded, EXTERNAL)
    expect(result.done).toBe(false)
    expect(result.refusal).toBe('push_rejected')
    expect(result.detail).toContain('This agent may not contain a credentials file.')
  }, 60_000)

  /**
   * A remote that refuses what cinna-core's push policy refuses: any **new**
   * blob, in any version of the send, under `credentials/` or `app-data/`.
   */
  function libraryLike(path: string): string {
    const remote = bare(path)
    const hook = join(remote, 'hooks', 'pre-receive')
    writeFileSync(
      hook,
      [
        '#!/bin/sh',
        'while read old new ref; do',
        '  if git rev-list --objects "$new" --not --all | grep -E " (credentials|app-data)/" >/dev/null; then',
        '    echo "This change includes the agent\'s credentials folder, which never leaves your computer." >&2',
        '    exit 1',
        '  fi',
        'done',
        ''
      ].join('\n')
    )
    chmodSync(hook, 0o755)
    return remote
  }

  /** The template's credentials folder, as a scaffolded agent has it. */
  function credentialsFolder(dir: string): void {
    mkdirSync(join(dir, 'credentials'), { recursive: true })
    writeFileSync(join(dir, 'credentials', 'README.md'), 'Put your keys in .env\n')
    writeFileSync(join(dir, 'credentials', '.env.example'), 'API_KEY=\n')
  }

  it('never sends the credentials or app-data folders, not even the template\'s README', async () => {
    const remote = libraryLike(join(box, 'library-first.git'))
    const dir = join(box, 'workshopG', 'Local', 'eta')
    mkdirSync(dir, { recursive: true })
    kitAgent(dir, 'Eta')
    credentialsFolder(dir)
    const result = await initWithRemote(dir, remote, CINNA)
    expect(result).toEqual({ done: true, refusal: null, detail: null })
    const tree = git(remote, 'ls-tree', '-r', '--name-only', 'main').split('\n')
    expect(tree.some((path) => path.startsWith('credentials/') || path.startsWith('app-data/'))).toBe(false)
    expect(existsSync(join(dir, 'credentials', 'README.md'))).toBe(true)
  }, 60_000)

  it('drops the credentials folder from unsent versions that recorded it, so the send is accepted', async () => {
    // A first send refused by the library left a version carrying credentials/.
    const remote = libraryLike(join(box, 'library-retry.git'))
    const dir = join(box, 'workshopF', 'Local', 'zeta')
    mkdirSync(dir, { recursive: true })
    kitAgent(dir, 'Zeta')
    credentialsFolder(dir)
    git(dir, 'init', '-q', '-b', 'main', '.')
    git(dir, 'remote', 'add', 'origin', remote)
    git(dir, 'add', 'cinna-agent.json', 'AGENT.md', 'credentials')
    git(dir, 'commit', '-q', '-m', 'Shared with the team')
    expect(() => git(dir, 'push', '-q', 'origin', 'HEAD:main')).toThrow()

    const result = await shareChanges(dir, '', CINNA)
    expect(result).toEqual({ done: true, refusal: null, detail: null })
    const everything = git(remote, 'log', '--format=', '--name-only', 'main')
    expect(everything).not.toContain('credentials/')
    expect(git(remote, 'ls-tree', '-r', '--name-only', 'main')).toContain('AGENT.md')
    expect(git(remote, 'log', '--format=%s', 'main')).toContain('Shared with the team')
    expect(readFileSync(join(dir, 'credentials', 'README.md'), 'utf8')).toBe('Put your keys in .env\n')
  }, 60_000)

  /** Every path in every version a bare repository holds. */
  function allPaths(remote: string): string {
    return git(remote, 'rev-list', '--objects', '--all')
  }

  it('keeps a teammate\'s newer version and drops only this folder\'s unsent credentials, when behind', async () => {
    // The old fold soft-reset onto a team ref this history did not contain and
    // recorded this folder's tree on top of it, which undid the teammate's
    // version. Nothing the team has may be rewritten, and the unsent version
    // goes on top of it.
    const remote = libraryLike(join(box, 'library-behind.git'))
    const alice = join(box, 'alice', 'Local', 'iota')
    mkdirSync(alice, { recursive: true })
    kitAgent(alice, 'Iota')
    git(alice, 'init', '-q', '-b', 'main', '.')
    git(alice, 'add', 'cinna-agent.json', 'AGENT.md')
    git(alice, 'commit', '-q', '-m', 'first')
    git(alice, 'push', '-q', remote, 'main')
    const bob = join(box, 'bob', 'Local', 'iota')
    mkdirSync(dirname(bob), { recursive: true })
    git(dirname(bob), 'clone', '-q', remote, 'iota')

    writeFileSync(join(alice, 't'), 'from Alice\n')
    git(alice, 'add', 't')
    git(alice, 'commit', '-q', '-m', 'T1')
    git(alice, 'push', '-q', remote, 'main')

    // Bob knows the team moved (fetched), and records a version carrying the credentials folder.
    git(bob, 'fetch', '-q')
    credentialsFolder(bob)
    writeFileSync(join(bob, 'bob.md'), 'from Bob\n')
    git(bob, 'add', 'bob.md', 'credentials')
    git(bob, 'commit', '-q', '-m', 'Bob\'s change')

    expect(await shareChanges(bob, '', CINNA)).toEqual({ done: true, refusal: null, detail: null })
    const tree = git(remote, 'ls-tree', '-r', '--name-only', 'main').split('\n')
    expect(tree).toContain('t')
    expect(tree).toContain('bob.md')
    const subjects = git(remote, 'log', '--format=%s', 'main').trim().split('\n')
    expect(subjects.indexOf('T1')).toBeGreaterThan(subjects.indexOf('Bob\'s change'))
    expect(allPaths(remote)).not.toMatch(/ (credentials|app-data)\//)
    // Bob's own files stay where they were.
    expect(readFileSync(join(bob, 'credentials', 'README.md'), 'utf8')).toBe('Put your keys in .env\n')
    expect(readFileSync(join(bob, 't'), 'utf8')).toBe('from Alice\n')
  }, 60_000)

  it('keeps a developer\'s history, each version with its message and author, without the credentials folder', async () => {
    const remote = libraryLike(join(box, 'library-history.git'))
    const dir = join(box, 'workshopH', 'Local', 'theta')
    mkdirSync(dir, { recursive: true })
    kitAgent(dir, 'Theta')
    git(dir, 'init', '-q', '-b', 'main', '.')
    git(dir, 'add', 'cinna-agent.json', 'AGENT.md')
    git(dir, 'commit', '-q', '-m', 'one')
    credentialsFolder(dir)
    writeFileSync(join(dir, 'two.md'), '2\n')
    git(dir, 'add', 'two.md', 'credentials')
    git(dir, 'commit', '-q', '-m', 'two')
    writeFileSync(join(dir, 'three.md'), '3\n')
    git(dir, 'add', 'three.md')
    git(dir, 'commit', '-q', '-m', 'three')
    const authored = git(dir, 'log', '--format=%s|%an|%ae|%ad', '--date=raw', 'main').trim().split('\n')

    expect(await initWithRemote(dir, remote, CINNA)).toEqual({ done: true, refusal: null, detail: null })
    const sent = git(remote, 'log', '--format=%s|%an|%ae|%ad', '--date=raw', 'main').trim().split('\n')
    // The three versions, as they were, plus the one that stopped tracking the folder.
    expect(sent.slice(-3)).toEqual(authored)
    expect(sent.length).toBeGreaterThanOrEqual(3)
    expect(allPaths(remote)).not.toMatch(/ (credentials|app-data)\//)
    expect(git(remote, 'ls-tree', '-r', '--name-only', 'main')).toContain('three.md')
    expect(readFileSync(join(dir, 'credentials', 'README.md'), 'utf8')).toBe('Put your keys in .env\n')
  }, 60_000)

  it('updates a folder whose unsent version untracked the credentials folder without deleting it from disk', async () => {
    const remote = bare(join(box, 'update-untracked.git'))
    const alice = join(box, 'alice2', 'Local', 'nu')
    mkdirSync(alice, { recursive: true })
    kitAgent(alice, 'Nu')
    git(alice, 'init', '-q', '-b', 'main', '.')
    git(alice, 'add', 'cinna-agent.json', 'AGENT.md')
    git(alice, 'commit', '-q', '-m', 'first')
    git(alice, 'push', '-q', remote, 'main')
    const bob = join(box, 'bob2', 'Local', 'nu')
    mkdirSync(dirname(bob), { recursive: true })
    git(dirname(bob), 'clone', '-q', remote, 'nu')
    // An unsent version recorded the credentials folder; recording again for
    // a Cinna library untracked it (the file stays on disk, excluded).
    credentialsFolder(bob)
    git(bob, 'add', 'credentials')
    git(bob, 'commit', '-q', '-m', 'with credentials')
    writeFileSync(join(bob, 'bob.md'), 'from Bob\n')
    expect((await commitAll(bob, 'Bob\'s change', null, undefined, true)).done).toBe(true)
    expect(git(bob, 'ls-files', 'credentials').trim()).toBe('')
    // The team moves on.
    writeFileSync(join(alice, 't'), 'from Alice\n')
    git(alice, 'add', 't')
    git(alice, 'commit', '-q', '-m', 'T1')
    git(alice, 'push', '-q', remote, 'main')

    // Bob has an unsent version: only a caller that decided to combine gets the rebase.
    expect(await pullRebaseClean(bob, CINNA)).toEqual({ done: false, refusal: 'dirty', detail: null })
    expect(await pullRebaseClean(bob, CINNA, null, undefined, { combine: true })).toEqual({ done: true, refusal: null, detail: null })
    expect(readFileSync(join(bob, 'credentials', 'README.md'), 'utf8')).toBe('Put your keys in .env\n')
    expect(readFileSync(join(bob, 't'), 'utf8')).toBe('from Alice\n')
    expect(readFileSync(join(bob, 'bob.md'), 'utf8')).toBe('from Bob\n')
    expect(git(bob, 'log', '--format=', '--name-only', 'origin/main..HEAD')).not.toContain('credentials/')
    expect(git(bob, 'status', '--porcelain', '--untracked-files=no')).toBe('')
  }, 60_000)

  it('shares after a recorded credentials file was edited on disk since', async () => {
    const remote = libraryLike(join(box, 'library-edited.git'))
    const dir = join(box, 'workshopEdited', 'Local', 'xi')
    mkdirSync(dir, { recursive: true })
    kitAgent(dir, 'Xi')
    credentialsFolder(dir)
    git(dir, 'init', '-q', '-b', 'main', '.')
    git(dir, 'remote', 'add', 'origin', remote)
    git(dir, 'add', 'cinna-agent.json', 'AGENT.md', 'credentials')
    git(dir, 'commit', '-q', '-m', 'with credentials')
    // Recording for the library stops tracking it; then the user edits the file.
    writeFileSync(join(dir, 'notes.md'), 'x\n')
    expect((await commitAll(dir, 'notes', null, undefined, true)).done).toBe(true)
    writeFileSync(join(dir, 'credentials', 'README.md'), 'My own notes on the keys\n')

    expect(await shareChanges(dir, '', CINNA)).toEqual({ done: true, refusal: null, detail: null })
    expect(allPaths(remote)).not.toMatch(/ (credentials|app-data)\//)
    expect(readFileSync(join(dir, 'credentials', 'README.md'), 'utf8')).toBe('My own notes on the keys\n')
  }, 60_000)

  it('refuses on a detached HEAD rather than rewrite, and leaves HEAD as it was', async () => {
    const remote = libraryLike(join(box, 'library-detached.git'))
    const dir = join(box, 'workshopI', 'Local', 'kappa')
    mkdirSync(dir, { recursive: true })
    kitAgent(dir, 'Kappa')
    credentialsFolder(dir)
    git(dir, 'init', '-q', '-b', 'main', '.')
    git(dir, 'remote', 'add', 'origin', remote)
    git(dir, 'add', 'cinna-agent.json', 'AGENT.md', 'credentials')
    git(dir, 'commit', '-q', '-m', 'with credentials')
    git(dir, 'rm', '-r', '-q', '--cached', 'credentials')
    git(dir, 'commit', '-q', '-m', 'untrack them')
    git(dir, 'checkout', '-q', '--detach')
    const head = readFileSync(join(dir, '.git', 'HEAD'), 'utf8')

    const result = await shareChanges(dir, '', CINNA)
    expect(result.refusal).toBe('failed')
    expect(result.detail).toContain('detached HEAD')
    expect(readFileSync(join(dir, '.git', 'HEAD'), 'utf8')).toBe(head)
    expect(() => git(remote, 'rev-parse', '--verify', 'main')).toThrow()
  }, 60_000)

  it('sends the credentials folder to a remote that is not a Cinna library, as before', async () => {
    const remote = bare(join(box, 'external-creds.git'))
    const dir = join(box, 'workshopJ', 'Local', 'lambda')
    mkdirSync(dir, { recursive: true })
    kitAgent(dir, 'Lambda')
    credentialsFolder(dir)
    expect(await initWithRemote(dir, remote, EXTERNAL)).toEqual({ done: true, refusal: null, detail: null })
    expect(git(remote, 'ls-tree', '-r', '--name-only', 'main').split('\n')).toContain('credentials/README.md')
    expect(git(dir, 'ls-files', 'credentials/README.md').trim()).toBe('credentials/README.md')
    expect(readFileSync(join(dir, '.git', 'info', 'exclude'), 'utf8')).not.toContain('/credentials/')
  }, 60_000)

  it('checks a folder before Share with the team without changing what it tracks', async () => {
    const dir = join(box, 'workshopK', 'Local', 'mu')
    mkdirSync(dir, { recursive: true })
    kitAgent(dir, 'Mu')
    credentialsFolder(dir)
    writeFileSync(join(dir, 'credentials', 'credentials.json'), '{"token":"x"}\n')
    git(dir, 'init', '-q', '-b', 'main', '.')
    git(dir, 'add', 'cinna-agent.json', 'AGENT.md', 'credentials')
    git(dir, 'commit', '-q', '-m', 'mine')
    const tracked = git(dir, 'ls-files')
    const status = git(dir, 'status', '--porcelain', '--untracked-files=no')

    // A Cinna library: what lies under the never-travel folders is left out at
    // the send, so it is no refusal — and nothing is untracked yet.
    expect(await preflightShare(dir, undefined, true)).toBeNull()
    expect(git(dir, 'ls-files')).toBe(tracked)
    expect(git(dir, 'status', '--porcelain', '--untracked-files=no')).toBe(status)
    // Any other target still refuses the tracked secret.
    expect((await preflightShare(dir, undefined, false))?.refusal).toBe('secrets_tracked')
    // And a secret outside those folders is refused for a Cinna library too.
    git(dir, 'add', '-f', '.env')
    expect((await preflightShare(dir, undefined, true))?.refusal).toBe('secrets_tracked')
  }, 60_000)

  it('gives a fetched agent the template\'s credentials and app-data folders, locally', () => {
    const dir = join(box, 'fetched')
    mkdirSync(dir, { recursive: true })
    restoreLocalOnlyFolders(dir)
    expect(existsSync(join(dir, 'credentials', 'README.md'))).toBe(true)
    expect(existsSync(join(dir, 'credentials', '.gitignore'))).toBe(true)
    expect(existsSync(join(dir, 'app-data', 'cache', '.gitignore'))).toBe(true)
    expect(existsSync(join(dir, 'app-data', 'cache', 'gitignore'))).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// A version the library refused, and the files that never travel
// ---------------------------------------------------------------------------

describe('bringing the team\'s changes together', () => {
  let box: string
  let team: string
  /** This machine's folder, and the teammate's clone of the same team version. */
  let a: string
  let b: string
  const BEA = { name: 'Bea', email: 'bea@example.test' }
  const DONE = { done: true, refusal: null, detail: null }

  beforeAll(async () => {
    box = mkdtempSync(join(tmpdir(), 'cinna-adopt-'))
    team = bare(join(box, 'team.git'))
    a = join(box, 'workshopA', 'Local', 'alpha')
    mkdirSync(a, { recursive: true })
    kitAgent(a, 'Alpha')
    mkdirSync(join(a, 'credentials'), { recursive: true })
    writeFileSync(join(a, 'credentials', '.env'), 'KEY=mine\n')
    mkdirSync(join(a, '.claude'), { recursive: true })
    writeFileSync(join(a, '.claude', 'settings.local.json'), '{"mine":true}\n')
    mkdirSync(join(a, 'skills'), { recursive: true })
    writeFileSync(join(a, 'skills', 'pricing.md'), '# Pricing\n\nTax 10%.\n')
    writeFileSync(join(a, 'from-team.md'), 'line one\nline two\nline three\n')
    expect((await initWithRemote(a, team, EXTERNAL)).done).toBe(true)
    b = join(box, 'workshopB', 'Local', 'alpha')
    expect((await cloneAgent(team, b, EXTERNAL)).done).toBe(true)
  }, 60_000)

  afterAll(() => {
    rmSync(box, { recursive: true, force: true })
  })

  /** The teammate changes one file and shares it. */
  async function teamShares(rel: string, content: string, note: string): Promise<void> {
    mkdirSync(dirname(join(b, rel)), { recursive: true })
    writeFileSync(join(b, rel), content)
    expect((await shareChanges(b, note, EXTERNAL, BEA)).done).toBe(true)
  }

  /** Back to the team's version, as if nothing had happened here. */
  function resetToTeam(dir: string): void {
    git(dir, 'fetch', '-q')
    git(dir, 'reset', '-q', '--hard', 'origin/main')
  }

  it('combines a clean divergence: the loose edits recorded first, the points handed over before anything moves', async () => {
    await teamShares('knowledge/terms.md', 'Clients pay net 30.\n', 'Teammate adds the payment terms')
    writeFileSync(join(a, 'AGENT.md'), '# Alpha\n\nLine one.\nLine two.\nLine three, mine.\n')
    const seen: AdoptionPoints[] = []
    const result = await beginAdoption(a, EXTERNAL, null, undefined, (points) => {
      seen.push(points)
      // The loose edits are a version of their own now, and the team's file
      // is not here yet: the record is written before history moves.
      expect(git(a, 'rev-parse', 'HEAD').trim()).toBe(points.headBefore)
      expect(git(a, 'status', '--porcelain')).toBe('')
      expect(existsSync(join(a, 'knowledge', 'terms.md'))).toBe(false)
    })
    expect(result).toEqual(DONE)
    expect(seen).toHaveLength(1)
    const [points] = seen
    expect(points.teamHead).toBe(git(team, 'rev-parse', 'main').trim())
    expect(points.base).toBe(git(a, 'rev-parse', 'origin/main~1').trim())
    // Both sides are in the folder, one unsent version on top of the team's.
    expect(readFileSync(join(a, 'knowledge', 'terms.md'), 'utf8')).toBe('Clients pay net 30.\n')
    expect(readFileSync(join(a, 'AGENT.md'), 'utf8')).toContain('Line three, mine.')
    expect(git(a, 'rev-list', '--count', 'origin/main..HEAD').trim()).toBe('1')
    expect(git(a, 'rev-list', '--count', 'HEAD..origin/main').trim()).toBe('0')
    expect(git(a, 'log', '-1', '--format=%s').trim()).toBe(ADOPTION_BEFORE_NOTE)
    // What the brief is built from, on each side.
    expect((await readVersionsBetween(a, points.base, points.teamHead)).map((v) => [v.note, v.author, v.files])).toEqual([
      ['Teammate adds the payment terms', 'Bea', ['knowledge/terms.md']]
    ])
    expect((await readVersionsBetween(a, points.base, points.headBefore)).map((v) => [v.note, v.files])).toEqual([
      [ADOPTION_BEFORE_NOTE, ['AGENT.md']]
    ])
    const theirs = await diffBetween(a, points.base, points.teamHead)
    expect(theirs.map((d) => d.path)).toEqual(['knowledge/terms.md'])
    expect(theirs[0].diff).toContain('+Clients pay net 30.')
    expect((await diffBetween(a, points.base, points.headBefore)).map((d) => d.path)).toEqual(['AGENT.md'])
    // Nothing to bring together once the team's version is in.
    const again = await beginAdoption(a, EXTERNAL, null, undefined, () => {
      throw new Error('no points when there is nothing to combine')
    })
    expect(again).toEqual({ done: false, refusal: 'adoption_blocked', detail: 'Nothing to bring together: this agent already has the team’s changes.' })
    expect((await shareChanges(a, 'Line three', EXTERNAL)).done).toBe(true)
  }, 60_000)

  it('answers diverged_conflict on clashing edits, HEAD at headBefore with the loose edits recorded', async () => {
    resetToTeam(b)
    await teamShares('AGENT.md', '# Alpha\n\nLine one, by the team.\nLine two.\nLine three, mine.\n', 'Teammate rewrites line one')
    writeFileSync(join(a, 'AGENT.md'), '# Alpha\n\nLine one, by me.\nLine two.\nLine three, mine.\n')
    const seen: AdoptionPoints[] = []
    const result = await beginAdoption(a, EXTERNAL, null, undefined, (points) => seen.push(points))
    expect(result.refusal).toBe('diverged_conflict')
    expect(seen).toHaveLength(1)
    expect(git(a, 'rev-parse', 'HEAD').trim()).toBe(seen[0].headBefore)
    expect(git(a, 'log', '-1', '--format=%s').trim()).toBe(ADOPTION_BEFORE_NOTE)
    expect(readFileSync(join(a, 'AGENT.md'), 'utf8')).toContain('Line one, by me.')
    expect(git(a, 'status', '--porcelain')).toBe('')
    expect(existsSync(join(a, '.git', 'rebase-merge'))).toBe(false)
    resetToTeam(a)
  }, 60_000)

  it('refuses to finish on markers, on a combine left half-done, and when the team’s version left the history', async () => {
    const teamHead = git(a, 'rev-parse', 'origin/main').trim()
    expect(await checkAdoptionFinish(a, teamHead)).toEqual(DONE)
    // Markers in an untracked file count; a setext underline alone does not;
    // an ignored file is not read.
    writeFileSync(join(a, 'notes.md'), '<<<<<<< HEAD\nours\n=======\ntheirs\n>>>>>>> team\n')
    expect(await checkAdoptionFinish(a, teamHead)).toEqual({
      done: false,
      refusal: 'adoption_blocked',
      detail: 'Some files still hold both versions, marked with <<<<<<< and >>>>>>> lines: notes.md.'
    })
    writeFileSync(join(a, 'notes.md'), 'Heading\n=======\n\nBody.\n')
    writeFileSync(join(a, 'app-data', 'scratch.md'), '<<<<<<< HEAD\n')
    expect(await checkAdoptionFinish(a, teamHead)).toEqual(DONE)
    rmSync(join(a, 'notes.md'))
    rmSync(join(a, 'app-data', 'scratch.md'))
    // A rebase stopped on a clash and left there.
    writeFileSync(join(a, 'skills', 'pricing.md'), '# Pricing\n\nTax 10%, by me.\n')
    git(a, 'add', '-A')
    git(a, 'commit', '-q', '-m', 'my tax line')
    resetToTeam(b)
    await teamShares('skills/pricing.md', '# Pricing\n\nTax 20%, by the team.\n', 'Teammate changes the tax')
    git(a, 'fetch', '-q')
    expect(() => git(a, 'rebase', '-q', 'origin/main')).toThrow()
    expect(existsSync(join(a, '.git', 'rebase-merge'))).toBe(true)
    expect(await checkAdoptionFinish(a, teamHead)).toEqual({
      done: false,
      refusal: 'adoption_blocked',
      detail: 'An earlier combine in this folder is still unfinished.'
    })
    git(a, 'rebase', '--abort')
    expect(await checkAdoptionFinish(a, teamHead)).toEqual(DONE)
    // The team moved on: its new version is not in this history.
    const moved = git(a, 'rev-parse', 'origin/main').trim()
    expect(await checkAdoptionFinish(a, moved)).toEqual({
      done: false,
      refusal: 'adoption_blocked',
      detail: 'This agent’s history no longer includes the team’s version the session started from.'
    })
    resetToTeam(a)
  }, 60_000)

  it('discard that cannot put the folder back says so in one fixed sentence, without git’s words', async () => {
    const head = git(a, 'rev-parse', 'HEAD').trim()
    expect(await discardAdoption(a, 'f'.repeat(40))).toEqual({
      done: false,
      refusal: 'adoption_blocked',
      detail: 'The folder could not be put back to where the session began.'
    })
    expect(git(a, 'rev-parse', 'HEAD').trim()).toBe(head)
    expect(git(a, 'status', '--porcelain')).toBe('')
    expect(existsSync(join(a, '.git', 'cinna-local-only'))).toBe(false)
  }, 30_000)

  it('the brief’s diff carries no secret that was recorded at one point and gone at the other', async () => {
    mkdirSync(join(a, 'tools'), { recursive: true })
    writeFileSync(join(a, 'tools', '.env'), 'TOKEN=plain-secret\n')
    git(a, 'add', '-f', 'tools/.env')
    git(a, 'commit', '-q', '-m', 'a token slipped in')
    git(a, 'rm', '-q', 'tools/.env')
    git(a, 'commit', '-q', '-m', 'drop the token')
    // Not tracked now, so the index-based exclusion misses it on both ranges.
    for (const [from, to] of [['HEAD~1', 'HEAD'], ['HEAD~2', 'HEAD~1']]) {
      const entries = await diffBetween(a, from, to)
      expect(entries.map((d) => d.path)).toEqual([])
      expect(JSON.stringify(entries)).not.toContain('plain-secret')
    }
    resetToTeam(a)
  }, 30_000)

  it('discard puts the folder back where the session began, keeping this machine’s local-only files as they are now', async () => {
    resetToTeam(b)
    await teamShares('knowledge/terms.md', 'Clients pay net 45.\n', 'Teammate revises the terms')
    writeFileSync(join(a, 'notes.md'), 'loose, mine\n')
    writeFileSync(join(a, 'credentials', '.env'), 'KEY=mine-at-begin\n')
    writeFileSync(join(a, '.claude', 'settings.local.json'), '{"mine":"at begin"}\n')
    const anchor: { points: AdoptionPoints | null } = { points: null }
    expect(await beginAdoption(a, EXTERNAL, null, undefined, (points) => { anchor.points = points })).toEqual(DONE)
    expect(readFileSync(join(a, 'knowledge', 'terms.md'), 'utf8')).toBe('Clients pay net 45.\n')
    // The session: the agent edits a file and makes one; this machine's own files move too.
    writeFileSync(join(a, 'AGENT.md'), '# Alpha\n\nEdited in the session.\n')
    writeFileSync(join(a, 'made-in-session.md'), 'x\n')
    writeFileSync(join(a, 'credentials', '.env'), 'KEY=during-the-session\n')
    writeFileSync(join(a, '.claude', 'settings.local.json'), '{"mine":"during"}\n')
    expect(await discardAdoption(a, anchor.points!.headBefore)).toEqual(DONE)
    expect(git(a, 'rev-parse', 'HEAD').trim()).toBe(anchor.points!.headBefore)
    expect(git(a, 'status', '--porcelain')).toBe('')
    expect(existsSync(join(a, 'made-in-session.md'))).toBe(false)
    expect(readFileSync(join(a, 'AGENT.md'), 'utf8')).not.toContain('Edited in the session.')
    expect(readFileSync(join(a, 'knowledge', 'terms.md'), 'utf8')).toBe('Clients pay net 30.\n')
    // The version recorded at begin stays: the user's own work.
    expect(readFileSync(join(a, 'notes.md'), 'utf8')).toBe('loose, mine\n')
    expect(git(a, 'log', '-1', '--format=%s').trim()).toBe(ADOPTION_BEFORE_NOTE)
    expect(readFileSync(join(a, 'credentials', '.env'), 'utf8')).toBe('KEY=during-the-session\n')
    expect(readFileSync(join(a, '.claude', 'settings.local.json'), 'utf8')).toBe('{"mine":"during"}\n')
    expect(existsSync(join(a, '.git', 'cinna-local-only'))).toBe(false)
    resetToTeam(a)
  }, 60_000)

  it('sends after a teammate shared first when the files are disjoint, and refuses team_changed_again when they overlap', async () => {
    resetToTeam(b)
    await teamShares('from-team.md', 'line one, by the team\nline two\nline three\n', 'Teammate changes line one')
    // Disjoint: this folder's unsent version touches another file. One
    // rebase, one more send, as before.
    writeFileSync(join(a, 'from-me.md'), 'me\n')
    expect(await shareChanges(a, 'I add a file', EXTERNAL)).toEqual(DONE)
    const tree = git(team, 'ls-tree', '-r', '--name-only', 'main')
    expect(tree).toContain('from-me.md')
    expect(git(team, 'show', 'main:from-team.md')).toBe('line one, by the team\nline two\nline three\n')
    // Overlap on different lines: git would combine it cleanly, and that is
    // exactly the silent combine the gate refuses.
    await teamShares('from-team.md', 'line one, revised by the team\nline two\nline three\n', 'Teammate revises line one')
    const teamHead = git(team, 'rev-parse', 'main').trim()
    writeFileSync(join(a, 'from-team.md'), 'line one, by the team\nline two\nline three, by me\n')
    const refused = await shareChanges(a, 'I change line three', EXTERNAL)
    expect(refused).toEqual({ done: false, refusal: 'team_changed_again', detail: null })
    expect(git(team, 'rev-parse', 'main').trim()).toBe(teamHead)
    expect(git(a, 'rev-list', '--count', 'origin/main..HEAD').trim()).toBe('1')
    expect(git(a, 'log', '-1', '--format=%s').trim()).toBe('I change line three')
    expect(git(a, 'status', '--porcelain')).toBe('')
    expect(existsSync(join(a, '.git', 'rebase-merge'))).toBe(false)
    // The team's version was already fetched (a status read does that for an
    // external remote on every page open): the gate measures from the point
    // the two sides last matched, not from the last fetch, so it still refuses.
    git(a, 'fetch', '--quiet', 'origin')
    expect(git(a, 'rev-parse', 'origin/main').trim()).toBe(teamHead)
    expect(await shareChanges(a, 'I change line three', EXTERNAL)).toEqual({
      done: false,
      refusal: 'team_changed_again',
      detail: null
    })
    expect(git(team, 'rev-parse', 'main').trim()).toBe(teamHead)
  }, 60_000)

  it('the send’s gate sees the team’s version on a folder that never fetched one', async () => {
    const c = join(box, 'workshopC', 'Local', 'alpha')
    expect((await cloneAgent(team, c, EXTERNAL)).done).toBe(true)
    // Linked to the team, but no team ref here yet.
    git(c, 'update-ref', '-d', 'refs/remotes/origin/main')
    expect(() => git(c, 'rev-parse', '--verify', '--quiet', 'origin/main')).toThrow()
    resetToTeam(b)
    await teamShares('from-team.md', 'line one, by the team, again\nline two\nline three\n', 'Teammate changes line one again')
    const teamHead = git(team, 'rev-parse', 'main').trim()
    // Overlap on different lines: git would combine it cleanly, and that is
    // exactly the silent combine the gate refuses.
    writeFileSync(join(c, 'from-team.md'), `${readFileSync(join(c, 'from-team.md'), 'utf8').replace(/line three.*\n/, 'line three, by C\n')}`)
    const refused = await shareChanges(c, 'C changes line three', EXTERNAL)
    expect(refused).toEqual({ done: false, refusal: 'team_changed_again', detail: null })
    expect(git(team, 'rev-parse', 'main').trim()).toBe(teamHead)
    expect(git(c, 'rev-list', '--count', 'origin/main..HEAD').trim()).toBe('1')
    expect(git(c, 'log', '-1', '--format=%s').trim()).toBe('C changes line three')
  }, 60_000)
})

describe('a version the library refused does not block later shares', () => {
  let box: string

  beforeAll(() => {
    box = mkdtempSync(join(tmpdir(), 'cinna-combined-'))
  })

  afterAll(() => {
    rmSync(box, { recursive: true, force: true })
  })

  /**
   * A remote that refuses what cinna-core's push policy refuses for a symlink:
   * any **new** version in the send whose tree holds one. Every send it sees
   * is counted in `received`; `onAccept` runs (outside the hook's git
   * environment) just before it accepts one.
   */
  function symlinkRefusing(path: string, onAccept = ''): { remote: string; received: () => number } {
    const remote = bare(path)
    const log = join(remote, 'received.log')
    const hook = join(remote, 'hooks', 'pre-receive')
    writeFileSync(
      hook,
      [
        '#!/bin/sh',
        `echo x >> "${log}"`,
        'while read old new ref; do',
        '  for c in $(git rev-list "$new" --not --all); do',
        '    if git ls-tree -r "$c" | grep "^120000 " >/dev/null; then',
        '      echo "This agent contains a symbolic link, which the team library does not accept." >&2',
        '      exit 1',
        '    fi',
        '  done',
        'done',
        onAccept === '' ? '' : `(unset GIT_DIR GIT_QUARANTINE_PATH GIT_OBJECT_DIRECTORY GIT_ALTERNATE_OBJECT_DIRECTORIES; ${onAccept})`,
        ''
      ].join('\n')
    )
    chmodSync(hook, 0o755)
    return {
      remote,
      received: () => (existsSync(log) ? readFileSync(log, 'utf8').split('\n').filter(Boolean).length : 0)
    }
  }

  /** A kit agent already shared with `remote` as one accepted version. */
  async function sharedAgent(name: string, remote: string): Promise<string> {
    const dir = join(box, name, 'Local', name)
    mkdirSync(dir, { recursive: true })
    kitAgent(dir, name)
    expect(await initWithRemote(dir, remote, CINNA)).toEqual({ done: true, refusal: null, detail: null })
    return dir
  }

  it('sends the unsent versions as one once the refused file is fixed', async () => {
    const { remote } = symlinkRefusing(join(box, 'fix.git'))
    const dir = await sharedAgent('fix', remote)
    symlinkSync('AGENT.md', join(dir, 'link.md'))
    const refused = await shareChanges(dir, 'Add a link', CINNA)
    expect(refused.refusal).toBe('push_rejected')
    expect(refused.detail).toContain('symbolic link')

    rmSync(join(dir, 'link.md'))
    writeFileSync(join(dir, 'notes.md'), 'fixed\n')
    const unsent = git(dir, 'rev-list', 'origin/main..HEAD').trim()
    expect(await shareChanges(dir, 'Remove the link', CINNA)).toEqual({ done: true, refusal: null, detail: null })

    expect(git(dir, 'rev-parse', 'HEAD').trim()).toBe(git(remote, 'rev-parse', 'main').trim())
    expect(git(dir, 'rev-list', '--count', 'HEAD').trim()).toBe('2')
    expect(git(dir, 'log', '-1', '--format=%B').trim()).toBe('Remove the link\n\nAdd a link')
    expect(git(remote, 'ls-tree', '-r', '--name-only', 'main')).toContain('notes.md')
    expect(git(remote, 'rev-list', '--objects', '--all')).not.toContain('link.md')
    expect(git(dir, 'status', '--porcelain', '--untracked-files=no')).toBe('')
    expect(git(dir, 'for-each-ref', 'refs/cinna/').trim()).toBe('')
    expect(unsent.split('\n')).toHaveLength(1)
  }, 60_000)

  it('leaves history exactly as it was when the combined version is refused too', async () => {
    const { remote, received } = symlinkRefusing(join(box, 'bad.git'))
    const dir = await sharedAgent('bad', remote)
    const teamHead = git(remote, 'rev-parse', 'main').trim()
    symlinkSync('AGENT.md', join(dir, 'link.md'))
    expect((await commitAll(dir, 'Add a link', null, undefined, true)).done).toBe(true)
    writeFileSync(join(dir, 'notes.md'), 'still has the link\n')
    const before = received()

    const result = await shareChanges(dir, 'More notes', CINNA)
    expect(result.refusal).toBe('push_rejected')
    expect(result.detail).toContain('symbolic link')
    // The version-by-version send, then the combined one: two refusals.
    expect(received() - before).toBe(2)
    expect(git(dir, 'log', '--format=%s', `${teamHead}..HEAD`).trim().split('\n')).toEqual(['More notes', 'Add a link'])
    expect(git(remote, 'rev-parse', 'main').trim()).toBe(teamHead)
    expect(git(dir, 'for-each-ref', 'refs/cinna/').trim()).toBe('')
    expect(git(dir, 'status', '--porcelain', '--untracked-files=no')).toBe('')
  }, 60_000)

  it('keeps each version of a share the library accepts', async () => {
    const { remote, received } = symlinkRefusing(join(box, 'normal.git'))
    const dir = await sharedAgent('normal', remote)
    writeFileSync(join(dir, 'one.md'), '1\n')
    expect((await commitAll(dir, 'one', null, undefined, true)).done).toBe(true)
    writeFileSync(join(dir, 'two.md'), '2\n')
    const before = received()
    expect(await shareChanges(dir, 'two', CINNA)).toEqual({ done: true, refusal: null, detail: null })
    expect(received() - before).toBe(1)
    expect(git(remote, 'log', '--format=%s', '-2', 'main').trim().split('\n')).toEqual(['two', 'one'])
    expect(git(dir, 'rev-parse', 'HEAD').trim()).toBe(git(remote, 'rev-parse', 'main').trim())
  }, 60_000)

  it('combines only when the library declined the content, never when it cannot check it now or the identity changed', async () => {
    const remote = bare(join(box, 'unavailable.git'))
    const log = join(remote, 'received.log')
    const sentence = join(box, 'unavailable-sentence')
    // Refuses every send with the sentence in `sentence`, counting them.
    const hook = join(remote, 'hooks', 'pre-receive')
    writeFileSync(
      hook,
      ['#!/bin/sh', `echo x >> "${log}"`, `if [ -f "${sentence}" ]; then cat "${sentence}" >&2; exit 1; fi`, ''].join('\n')
    )
    chmodSync(hook, 0o755)
    const received = (): number => (existsSync(log) ? readFileSync(log, 'utf8').split('\n').filter(Boolean).length : 0)
    const dir = await sharedAgent('unavailable', remote)
    writeFileSync(join(dir, 'one.md'), '1\n')
    expect((await commitAll(dir, 'one', null, undefined, true)).done).toBe(true)
    writeFileSync(join(dir, 'two.md'), '2\n')

    // core's MSG_UNAVAILABLE: a server fault, so no second, combined send.
    writeFileSync(
      sentence,
      "The team library can't check this change right now. Ask your admin to look at the Cinna server.\n"
    )
    let before = received()
    const unavailable = await shareChanges(dir, 'two', CINNA)
    expect(unavailable.refusal).toBe('push_rejected')
    expect(unavailable.detail).toContain("can't check this change right now")
    expect(received() - before).toBe(1)
    expect(git(dir, 'log', '--format=%s', 'origin/main..HEAD').trim().split('\n')).toEqual(['two', 'one'])

    // core's MSG_MANIFEST_ID_CHANGED: the folder's identity, which a combined
    // send carries too, so it is said once and never retried.
    writeFileSync(sentence, "This agent's identity changed; share it as a new agent instead.\n")
    before = received()
    const identity = await shareChanges(dir, 'three', CINNA)
    expect(identity.refusal).toBe('push_rejected')
    expect(identity.detail).toContain("This agent's identity changed; share it as a new agent instead.")
    expect(received() - before).toBe(1)
    expect(git(dir, 'for-each-ref', 'refs/cinna/').trim()).toBe('')

    // A verdict on what a version holds: one combined send follows.
    writeFileSync(sentence, 'The file big.bin is larger than 10 MB, too big to share with the team.\n')
    before = received()
    const content = await pushAgent(dir, CINNA)
    expect(content.refusal).toBe('push_rejected')
    expect(received() - before).toBe(2)
    expect(git(dir, 'for-each-ref', 'refs/cinna/').trim()).toBe('')
  }, 60_000)

  it('replays a version recorded while the combined one was sent onto it, never dropping it', async () => {
    const dir = join(box, 'moved', 'Local', 'moved')
    const armed = join(box, 'moved-armed')
    // Once armed, the library records a version in the folder as it accepts a send.
    const { remote } = symlinkRefusing(
      join(box, 'moved.git'),
      `if [ -f "${armed}" ]; then git -C "${dir}" -c user.name=Meanwhile -c user.email=m@example.test -c commit.gpgsign=false commit -q --allow-empty -m meanwhile; fi`
    )
    expect(await sharedAgent('moved', remote)).toBe(dir)
    symlinkSync('AGENT.md', join(dir, 'link.md'))
    expect((await shareChanges(dir, 'Add a link', CINNA)).refusal).toBe('push_rejected')
    rmSync(join(dir, 'link.md'))
    writeFileSync(armed, '')

    expect((await shareChanges(dir, 'Remove the link', CINNA)).done).toBe(true)
    const sent = git(remote, 'rev-parse', 'main').trim()
    expect(git(remote, 'log', '-1', '--format=%B', 'main').trim()).toBe('Remove the link\n\nAdd a link')
    // The version recorded meanwhile is still the folder's tip, now on the
    // combined version the team has: the sent work is not shown as unsent.
    expect(git(dir, 'log', '-1', '--format=%s').trim()).toBe('meanwhile')
    expect(git(dir, 'rev-parse', 'HEAD~1').trim()).toBe(sent)
    expect(git(dir, 'rev-list', '--count', 'origin/main..HEAD').trim()).toBe('1')
    expect(git(dir, 'for-each-ref', 'refs/cinna/').trim()).toBe('')
    expect(git(dir, 'status', '--porcelain', '--untracked-files=no')).toBe('')
  }, 60_000)
})

describe('.claude/settings.local.json never travels to a Cinna library', () => {
  let box: string
  const RULES = '{"permissions":{"allow":["Bash(rm:*)"]}}\n'

  beforeAll(() => {
    box = mkdtempSync(join(tmpdir(), 'cinna-settings-'))
  })

  afterAll(() => {
    rmSync(box, { recursive: true, force: true })
  })

  function settingsFile(dir: string, body = RULES): void {
    mkdirSync(join(dir, '.claude'), { recursive: true })
    writeFileSync(join(dir, '.claude', 'settings.local.json'), body)
  }

  it('is left out of every version sent, recorded ones included, and stays on disk', async () => {
    const remote = bare(join(box, 'first.git'))
    const dir = join(box, 'first', 'Local', 'first')
    mkdirSync(dir, { recursive: true })
    kitAgent(dir, 'First')
    settingsFile(dir)
    git(dir, 'init', '-q', '-b', 'main', '.')
    git(dir, 'add', 'cinna-agent.json', 'AGENT.md', '.claude')
    git(dir, 'commit', '-q', '-m', 'mine, with my rules')
    // Tracked, it is no refusal: it is cleaned like credentials/.
    expect(await preflightShare(dir, undefined, true)).toBeNull()

    expect(await initWithRemote(dir, remote, CINNA)).toEqual({ done: true, refusal: null, detail: null })
    expect(git(remote, 'rev-list', '--objects', '--all')).not.toContain('settings.local.json')
    expect(readFileSync(join(dir, '.claude', 'settings.local.json'), 'utf8')).toBe(RULES)
    // Anchored and in any case, whatever the clone's core.ignorecase.
    expect(readFileSync(join(dir, '.git', 'info', 'exclude'), 'utf8')).toContain(
      '/.[cC][lL][aA][uU][dD][eE]/[sS][eE][tT][tT][iI][nN][gG][sS].[lL][oO][cC][aA][lL].[jJ][sS][oO][nN]\n'
    )
    expect(git(dir, 'status', '--porcelain')).toBe('')
  }, 60_000)

  it('still travels to a remote that is not a Cinna library when the folder tracks it', async () => {
    // The kit's own gitignore leaves it out since contract 1.9.0; tracked
    // anyway, only a Cinna library takes it out.
    const remote = bare(join(box, 'external.git'))
    const dir = join(box, 'external', 'Local', 'external')
    mkdirSync(dir, { recursive: true })
    kitAgent(dir, 'External')
    settingsFile(dir)
    git(dir, 'init', '-q', '-b', 'main', '.')
    git(dir, 'add', '-f', 'cinna-agent.json', 'AGENT.md', '.claude')
    git(dir, 'commit', '-q', '-m', 'mine, with my rules')
    expect(await initWithRemote(dir, remote, EXTERNAL)).toEqual({ done: true, refusal: null, detail: null })
    expect(git(remote, 'ls-tree', '-r', '--name-only', 'main')).toContain('.claude/settings.local.json')
  }, 60_000)

  it('gives a fetched agent the template\'s file, and never replaces one that is there', () => {
    const dir = join(box, 'fetched')
    mkdirSync(dir, { recursive: true })
    restoreLocalOnlyFolders(dir)
    expect(readFileSync(join(dir, '.claude', 'settings.local.json'), 'utf8')).toContain('"allow"')
    settingsFile(dir)
    restoreLocalOnlyFolders(dir)
    expect(readFileSync(join(dir, '.claude', 'settings.local.json'), 'utf8')).toBe(RULES)
  })

  it('puts back the kept copy, else the template\'s', () => {
    const dir = join(box, 'kept')
    settingsFile(dir)
    const kept = keepLocalOnlyFiles(dir)
    rmSync(join(dir, '.claude'), { recursive: true })
    putBackLocalOnlyFiles(dir, kept)
    expect(readFileSync(join(dir, '.claude', 'settings.local.json'), 'utf8')).toBe(RULES)
    rmSync(join(dir, '.claude'), { recursive: true })
    putBackLocalOnlyFiles(dir, new Map(), undefined, false)
    expect(existsSync(join(dir, '.claude', 'settings.local.json'))).toBe(false)
    putBackLocalOnlyFiles(dir, new Map())
    expect(readFileSync(join(dir, '.claude', 'settings.local.json'), 'utf8')).toContain('"allow"')
  })

  it('keeps a teammate\'s copy when the version that stops tracking it arrives by Update', async () => {
    // A team version shared before the file joined the never-travel list tracks it.
    const remote = bare(join(box, 'old-team.git'))
    const alice = join(box, 'alice', 'Local', 'old')
    mkdirSync(alice, { recursive: true })
    kitAgent(alice, 'Old')
    settingsFile(alice)
    git(alice, 'init', '-q', '-b', 'main', '.')
    git(alice, 'remote', 'add', 'origin', remote)
    git(alice, 'add', '-f', 'cinna-agent.json', 'AGENT.md', '.claude')
    git(alice, 'commit', '-q', '-m', 'first')
    git(alice, 'push', '-q', '-u', 'origin', 'main')
    const bob = join(box, 'bob', 'Local', 'old')
    mkdirSync(dirname(bob), { recursive: true })
    git(dirname(bob), 'clone', '-q', remote, 'old')
    expect(git(bob, 'ls-files', '.claude/settings.local.json').trim()).toBe('.claude/settings.local.json')

    // Alice shares from a desktop that leaves it out: that version stops tracking it.
    writeFileSync(join(alice, 'notes.md'), 'from Alice\n')
    expect(await shareChanges(alice, 'notes', CINNA)).toEqual({ done: true, refusal: null, detail: null })
    expect(git(remote, 'ls-tree', '-r', '--name-only', 'main')).not.toContain('settings.local.json')

    expect(await pullRebaseClean(bob, CINNA)).toEqual({ done: true, refusal: null, detail: null })
    expect(readFileSync(join(bob, 'notes.md'), 'utf8')).toBe('from Alice\n')
    expect(readFileSync(join(bob, '.claude', 'settings.local.json'), 'utf8')).toBe(RULES)
    expect(git(bob, 'ls-files', '.claude/settings.local.json').trim()).toBe('')
    // Ignored, not a change waiting to be shared.
    expect(git(bob, 'status', '--porcelain')).toBe('')
  }, 60_000)
})

describe('the never-travel paths in the contract\'s two shapes, in any case', () => {
  let box: string
  const RULES = '{"permissions":{"allow":["Bash(rm:*)"]}}\n'
  const WIDER = '{"permissions":{"allow":["Bash(*)","Write(*)"]}}\n'
  /** One name for the file in another case; a case-insensitive disk holds only one of the two. */
  const MIXED = join('.Claude', 'Settings.local.json')

  beforeAll(() => {
    box = mkdtempSync(join(tmpdir(), 'cinna-icase-'))
  })

  afterAll(() => {
    rmSync(box, { recursive: true, force: true })
  })

  /** A workshop whose `.cinna-kit/` is newer than the bundle and lists `paths`. */
  function workshopListing(name: string, paths: string[]): string {
    const root = join(box, name)
    const kit = join(root, '.cinna-kit')
    cpSync(join(repoRoot, 'resources', 'cinna-agent-kit'), kit, { recursive: true })
    writeFileSync(join(kit, 'kit.json'), JSON.stringify({ contract_version: '1.99.0' }, null, 2))
    writeFileSync(join(kit, 'CONTRACT_VERSION'), '1.99.0\n')
    const layout = JSON.parse(readFileSync(join(kit, 'layout.json'), 'utf8'))
    layout.shared_remote.never_travels.paths = paths
    writeFileSync(join(kit, 'layout.json'), JSON.stringify(layout, null, 2))
    return root
  }

  function mixedSettings(dir: string, body: string): void {
    mkdirSync(join(dir, '.Claude'), { recursive: true })
    writeFileSync(join(dir, MIXED), body)
  }

  it('reads an entry without a trailing slash as one file, and keeps the settings file for an older list', () => {
    const root = workshopListing('shapes', ['credentials/', './notes.md', '/App-Data/'])
    expect(neverTravelPaths(root)).toEqual(['credentials/', 'notes.md', 'App-Data/', '.claude/settings.local.json'])
    const listed = workshopListing('listed', ['credentials/', '.Claude/Settings.local.json', 'CREDENTIALS/'])
    expect(neverTravelPaths(listed)).toEqual(['credentials/', '.Claude/Settings.local.json'])
    // The bundled contract (1.9.0) lists it itself.
    expect(neverTravelPaths()).toEqual(['credentials/', 'app-data/', '.claude/settings.local.json'])
  })

  it('leaves a tracked .Claude/Settings.local.json and Credentials/ out of every version sent, and nothing more', async () => {
    const remote = bare(join(box, 'mixed.git'))
    const dir = join(box, 'mixed', 'Local', 'mixed')
    mkdirSync(join(dir, 'Credentials'), { recursive: true })
    kitAgent(dir, 'Mixed')
    mixedSettings(dir, RULES)
    writeFileSync(join(dir, 'Credentials', 'notes.txt'), 'mine\n')
    // A file beside it whose name only starts the same travels: files match exactly.
    writeFileSync(join(dir, '.Claude', 'settings.local.json.bak'), '{}\n')
    git(dir, 'init', '-q', '-b', 'main', '.')
    // A Linux clone's default: only the exclude rule's own form ignores another case.
    git(dir, 'config', 'core.ignorecase', 'false')
    git(dir, 'add', '-f', 'cinna-agent.json', 'AGENT.md', '.Claude', 'Credentials')
    git(dir, 'commit', '-q', '-m', 'mine, with my rules in another case')
    expect(git(dir, 'ls-files', '.Claude').trim().split('\n')).toContain('.Claude/Settings.local.json')

    expect(await initWithRemote(dir, remote, CINNA)).toEqual({ done: true, refusal: null, detail: null })
    const sent = git(remote, 'rev-list', '--objects', '--all').toLowerCase()
    expect(sent).not.toMatch(/settings\.local\.json(\n|$)/)
    expect(sent).not.toContain('credentials/')
    expect(git(remote, 'ls-tree', '-r', '--name-only', 'main')).toContain('.Claude/settings.local.json.bak')
    expect(readFileSync(join(dir, MIXED), 'utf8')).toBe(RULES)
    expect(git(dir, 'status', '--porcelain')).toBe('')
  }, 60_000)

  it('updates a folder whose team version tracks it in another case, keeps this machine\'s edit, and counts no change', async () => {
    const remote = bare(join(box, 'team-mixed.git'))
    const alice = join(box, 'team-mixed-alice', 'Local', 'team')
    mkdirSync(alice, { recursive: true })
    kitAgent(alice, 'Team')
    mixedSettings(alice, WIDER)
    git(alice, 'init', '-q', '-b', 'main', '.')
    git(alice, 'remote', 'add', 'origin', remote)
    git(alice, 'add', '-f', 'cinna-agent.json', 'AGENT.md', MIXED)
    git(alice, 'commit', '-q', '-m', 'rules, tracked in another case')
    git(alice, 'push', '-q', '-u', 'origin', 'main')
    const bob = join(box, 'team-mixed-bob', 'Local', 'team')
    mkdirSync(dirname(bob), { recursive: true })
    git(dirname(bob), 'clone', '-q', remote, 'team')
    // Get without a copy of one's own: the template's, never the team's.
    const carol = join(box, 'team-mixed-carol', 'Local', 'team')
    expect((await cloneAgent(remote, carol, CINNA)).done).toBe(true)
    restoreLocalOnlyFolders(carol)
    await settleLocalOnlyFiles(carol, new Map())
    const settled = readFileSync(join(carol, MIXED), 'utf8')
    expect(settled).not.toBe(WIDER)
    expect(settled).toContain('"allow"')
    // Approving a permission rewrites the tracked file.
    writeFileSync(join(bob, MIXED), RULES)
    expect((await readShareStatus(bob, CINNA, false)).changedPaths).toEqual([])

    writeFileSync(join(alice, 'notes.md'), 'from Alice\n')
    git(alice, 'add', 'notes.md')
    git(alice, 'commit', '-q', '-m', 'notes')
    git(alice, 'push', '-q')
    expect(await pullRebaseClean(bob, CINNA)).toEqual({ done: true, refusal: null, detail: null })
    expect(readFileSync(join(bob, 'notes.md'), 'utf8')).toBe('from Alice\n')
    expect(readFileSync(join(bob, MIXED), 'utf8')).toBe(RULES)

    // Bob's next share removes it from the team's latest version, which is what the server requires.
    writeFileSync(join(bob, 'more.md'), 'from Bob\n')
    expect(await shareChanges(bob, 'more', CINNA)).toEqual({ done: true, refusal: null, detail: null })
    expect(git(remote, 'ls-tree', '-r', '--name-only', 'main').toLowerCase()).not.toContain('settings.local.json')
    expect(readFileSync(join(bob, MIXED), 'utf8')).toBe(RULES)
  }, 60_000)
})

describe('this machine\'s .claude/settings.local.json always wins over a team version', () => {
  let box: string
  const MINE = '{"permissions":{"allow":["Bash(ls:*)"]}}\n'
  const WIDER = '{"permissions":{"allow":["Bash(*)","Write(*)"]}}\n'
  const SETTINGS = join('.claude', 'settings.local.json')

  beforeAll(() => {
    box = mkdtempSync(join(tmpdir(), 'cinna-mine-wins-'))
  })

  afterAll(() => {
    rmSync(box, { recursive: true, force: true })
  })

  function settingsFile(dir: string, body: string): void {
    mkdirSync(join(dir, '.claude'), { recursive: true })
    writeFileSync(join(dir, SETTINGS), body)
  }

  /** Alice on plain git (or an older client): her versions track the file. */
  function plainGitAlice(name: string, remote: string): string {
    const alice = join(box, `${name}-alice`, 'Local', name)
    mkdirSync(alice, { recursive: true })
    kitAgent(alice, name)
    git(alice, 'init', '-q', '-b', 'main', '.')
    git(alice, 'remote', 'add', 'origin', remote)
    git(alice, 'add', '-f', 'cinna-agent.json', 'AGENT.md')
    git(alice, 'commit', '-q', '-m', 'first')
    git(alice, 'push', '-q', '-u', 'origin', 'main')
    return alice
  }

  function cloneAs(remote: string, name: string, who: string): string {
    const dir = join(box, `${name}-${who}`, 'Local', name)
    mkdirSync(dirname(dir), { recursive: true })
    git(dirname(dir), 'clone', '-q', remote, name)
    return dir
  }

  it('keeps this machine\'s rules on Update when a teammate\'s version carries a wider allow-list', async () => {
    const remote = bare(join(box, 'wider.git'))
    const alice = plainGitAlice('wider', remote)
    const bob = cloneAs(remote, 'wider', 'bob')
    // Bob's copy is ignored here (the exclude block), so git does not see it.
    settingsFile(bob, MINE)
    writeFileSync(join(bob, 'notes.md'), 'from Bob\n')
    expect(await shareChanges(bob, 'notes', CINNA)).toEqual({ done: true, refusal: null, detail: null })

    // Alice's plain git starts tracking her wider rules and sends them.
    git(alice, 'pull', '-q', '--ff-only')
    settingsFile(alice, WIDER)
    git(alice, 'add', '-f', SETTINGS)
    git(alice, 'commit', '-q', '-m', 'my rules')
    git(alice, 'push', '-q')

    expect(await pullRebaseClean(bob, CINNA)).toEqual({ done: true, refusal: null, detail: null })
    expect(git(bob, 'rev-parse', 'HEAD').trim()).toBe(git(remote, 'rev-parse', 'main').trim())
    expect(readFileSync(join(bob, SETTINGS), 'utf8')).toBe(MINE)
    expect(existsSync(join(bob, '.git', 'cinna-local-only'))).toBe(false)
  }, 60_000)

  it('gives a folder without its own rules the template\'s, never the team\'s, on Update and on Get', async () => {
    const remote = bare(join(box, 'none.git'))
    const alice = plainGitAlice('none', remote)
    const bob = cloneAs(remote, 'none', 'bob')
    settingsFile(alice, WIDER)
    git(alice, 'add', '-f', SETTINGS)
    git(alice, 'commit', '-q', '-m', 'my rules')
    git(alice, 'push', '-q')

    expect(await pullRebaseClean(bob, CINNA)).toEqual({ done: true, refusal: null, detail: null })
    const updated = readFileSync(join(bob, SETTINGS), 'utf8')
    expect(updated).not.toBe(WIDER)
    expect(updated).toContain('"allow"')

    const carol = join(box, 'none-carol', 'Local', 'none')
    expect((await cloneAgent(remote, carol, CINNA)).done).toBe(true)
    expect(readFileSync(join(carol, SETTINGS), 'utf8')).toBe(WIDER)
    restoreLocalOnlyFolders(carol)
    await settleLocalOnlyFiles(carol, new Map())
    expect(readFileSync(join(carol, SETTINGS), 'utf8')).toBe(updated)
  }, 60_000)

  it('keeps this machine\'s copy over the team\'s on Use the team\'s version', async () => {
    const remote = bare(join(box, 'use.git'))
    const alice = plainGitAlice('use', remote)
    settingsFile(alice, WIDER)
    git(alice, 'add', '-f', SETTINGS)
    git(alice, 'commit', '-q', '-m', 'my rules')
    git(alice, 'push', '-q')
    const mine = join(box, 'use-mine')
    settingsFile(mine, MINE)
    const team = join(box, 'use-team', 'Local', 'use')
    expect((await cloneAgent(remote, team, CINNA)).done).toBe(true)
    await settleLocalOnlyFiles(team, keepLocalOnlyFiles(mine))
    expect(readFileSync(join(team, SETTINGS), 'utf8')).toBe(MINE)
  }, 60_000)

  it('updates a folder that still tracks its edited rules, and keeps the edit', async () => {
    const remote = bare(join(box, 'tracked.git'))
    const alice = plainGitAlice('tracked', remote)
    settingsFile(alice, WIDER)
    git(alice, 'add', '-f', SETTINGS)
    git(alice, 'commit', '-q', '-m', 'rules, tracked')
    git(alice, 'push', '-q')
    const bob = cloneAs(remote, 'tracked', 'bob')
    expect(git(bob, 'ls-files', SETTINGS).trim()).toBe('.claude/settings.local.json')
    // Approving a permission rewrites the tracked file.
    settingsFile(bob, MINE)
    writeFileSync(join(alice, 'notes.md'), 'from Alice\n')
    git(alice, 'add', 'notes.md')
    git(alice, 'commit', '-q', '-m', 'notes')
    git(alice, 'push', '-q')

    expect(await pullRebaseClean(bob, CINNA)).toEqual({ done: true, refusal: null, detail: null })
    expect(readFileSync(join(bob, 'notes.md'), 'utf8')).toBe('from Alice\n')
    expect(readFileSync(join(bob, SETTINGS), 'utf8')).toBe(MINE)
    expect(existsSync(join(bob, '.git', 'cinna-local-only'))).toBe(false)
    // Still tracked by the team version, so it differs for good: never a change
    // to share with a Cinna library, which would take it out rather than send it.
    const counts = await readShareStatus(bob, CINNA, false)
    expect(counts.changedPaths).toEqual([])
    expect(shareStateOf(counts)).toBe('up_to_date')
    expect((await readShareStatus(bob, EXTERNAL, false)).changedPaths).toEqual(['.claude/settings.local.json'])
  }, 60_000)

  it('still refuses an Update over any other tracked edit, and leaves the rules edit in place', async () => {
    const remote = bare(join(box, 'dirty.git'))
    const alice = plainGitAlice('dirty', remote)
    settingsFile(alice, WIDER)
    git(alice, 'add', '-f', SETTINGS)
    git(alice, 'commit', '-q', '-m', 'rules, tracked')
    git(alice, 'push', '-q')
    const bob = cloneAs(remote, 'dirty', 'bob')
    settingsFile(bob, MINE)
    writeFileSync(join(bob, 'AGENT.md'), 'an edit not shared yet\n')
    writeFileSync(join(alice, 'notes.md'), 'from Alice\n')
    git(alice, 'add', 'notes.md')
    git(alice, 'commit', '-q', '-m', 'notes')
    git(alice, 'push', '-q')

    expect((await pullRebaseClean(bob, CINNA)).refusal).toBe('dirty')
    expect(readFileSync(join(bob, SETTINGS), 'utf8')).toBe(MINE)
    expect(readFileSync(join(bob, 'AGENT.md'), 'utf8')).toBe('an edit not shared yet\n')
    expect(existsSync(join(bob, '.git', 'cinna-local-only'))).toBe(false)
  }, 60_000)

  it('puts back a copy an interrupted update left under .git, over what is there, then removes it', async () => {
    const remote = bare(join(box, 'leftover.git'))
    plainGitAlice('leftover', remote)
    const bob = cloneAs(remote, 'leftover', 'bob')
    settingsFile(bob, WIDER)
    const backup = join(bob, '.git', 'cinna-local-only')
    settingsFile(backup, MINE)
    expect(hasLeftoverLocalOnlyFiles(bob)).toBe(true)
    restoreLeftoverLocalOnlyFiles(bob)
    expect(readFileSync(join(bob, SETTINGS), 'utf8')).toBe(MINE)
    expect(existsSync(backup)).toBe(false)
    expect(hasLeftoverLocalOnlyFiles(bob)).toBe(false)

    // The next Update restores one first, before it keeps what is on disk.
    settingsFile(bob, WIDER)
    settingsFile(backup, MINE)
    expect(await pullRebaseClean(bob, CINNA)).toEqual({ done: false, refusal: null, detail: null })
    expect(readFileSync(join(bob, SETTINGS), 'utf8')).toBe(MINE)
    expect(existsSync(backup)).toBe(false)
  }, 60_000)
})

// ---------------------------------------------------------------------------
// The Cinna token reaches the server in a header, and nowhere else
// ---------------------------------------------------------------------------

const httpBackend = join(execFileSync('git', ['--exec-path'], { encoding: 'utf8' }).trim(), 'git-http-backend')

describe.skipIf(!existsSync(httpBackend))('Cinna remote token injection', () => {
  let box: string
  let server: Server
  let origin: string
  const seen: Array<string | undefined> = []
  let minted = 0
  const token = async (): Promise<string> => `tok-${++minted}-secret`

  /** Smart HTTP over `git http-backend`, refusing any request without a bearer. */
  function startServer(projectRoot: string): Promise<void> {
    server = createServer((req, res) => {
      seen.push(req.headers.authorization)
      if (!/^Bearer tok-\d+-secret$/.test(req.headers.authorization ?? '')) {
        res.writeHead(403).end('no token')
        return
      }
      serveBackend(projectRoot, req, res)
    })
    return new Promise((resolve) => {
      server.listen(0, '127.0.0.1', () => {
        const address = server.address()
        origin = `http://127.0.0.1:${typeof address === 'object' && address ? address.port : 0}`
        resolve()
      })
    })
  }

  function listen(srv: Server): Promise<string> {
    return new Promise((resolve) => {
      srv.listen(0, '127.0.0.1', () => {
        const address = srv.address()
        resolve(`http://127.0.0.1:${typeof address === 'object' && address ? address.port : 0}`)
      })
    })
  }

  function serveBackend(projectRoot: string, req: IncomingMessage, res: ServerResponse): void {
    {
      const url = new URL(req.url ?? '/', 'http://localhost')
      const child = spawn(httpBackend, [], {
        env: {
          ...ENV,
          GIT_PROJECT_ROOT: projectRoot,
          GIT_HTTP_EXPORT_ALL: '1',
          PATH_INFO: url.pathname,
          QUERY_STRING: url.search.slice(1),
          REQUEST_METHOD: req.method ?? 'GET',
          CONTENT_TYPE: req.headers['content-type'] ?? '',
          HTTP_CONTENT_ENCODING: req.headers['content-encoding'] ?? '',
          REMOTE_USER: 'tester',
          REMOTE_ADDR: '127.0.0.1'
        }
      })
      req.pipe(child.stdin)
      const chunks: Buffer[] = []
      child.stdout.on('data', (chunk: Buffer) => chunks.push(chunk))
      child.on('close', () => {
        const out = Buffer.concat(chunks)
        const split = out.indexOf('\r\n\r\n')
        const head = out.subarray(0, split).toString('utf8')
        const body = out.subarray(split + 4)
        let status = 200
        const headers: Record<string, string> = {}
        for (const line of head.split('\r\n')) {
          const at = line.indexOf(':')
          if (at < 0) continue
          const key = line.slice(0, at).trim()
          const value = line.slice(at + 1).trim()
          if (key.toLowerCase() === 'status') status = Number.parseInt(value, 10)
          else headers[key] = value
        }
        res.writeHead(status, headers).end(body)
      })
    }
  }

  beforeAll(async () => {
    box = mkdtempSync(join(tmpdir(), 'cinna-share-http-'))
    const repo = bare(join(box, 'srv', 'git', 'team-1.git'))
    const seed = join(box, 'seed')
    mkdirSync(seed)
    kitAgent(seed, 'Hosted')
    git(seed, 'init', '-q', '-b', 'main', '.')
    git(seed, 'add', 'cinna-agent.json', 'AGENT.md')
    git(seed, 'commit', '-q', '-m', 'seed')
    git(seed, 'push', '-q', repo, 'main')
    await startServer(join(box, 'srv'))
  }, 60_000)

  afterAll(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()))
    rmSync(box, { recursive: true, force: true })
  })

  it('sends the bearer on clone and push, and never writes it into .git/config', async () => {
    const auth = { kind: 'cinna' as const, origin, token }
    const url = `${origin}/git/team-1.git`
    const dir = join(box, 'home', 'Local', 'hosted')

    expect(await cloneAgent(url, dir, auth)).toEqual({ done: true, refusal: null, detail: null })
    const afterClone = seen.length
    expect(afterClone).toBeGreaterThan(0)

    writeFileSync(join(dir, 'notes.md'), 'shared over http\n')
    expect(await shareChanges(dir, 'Add notes over http', auth)).toEqual({
      done: true,
      refusal: null,
      detail: null
    })
    expect(seen.length).toBeGreaterThan(afterClone)
    // Every request carried a freshly minted bearer, and the push landed.
    expect(seen.every((header) => /^Bearer tok-\d+-secret$/.test(header ?? ''))).toBe(true)
    expect(minted).toBeGreaterThanOrEqual(2)
    expect(git(join(box, 'srv', 'git', 'team-1.git'), 'ls-tree', '-r', '--name-only', 'main')).toContain('notes.md')

    // The stored remote is the plain URL; no token in config, anywhere.
    const config = readFileSync(join(dir, '.git', 'config'), 'utf8')
    expect(config).not.toMatch(/secret|Bearer|extraHeader/i)
    expect(git(dir, 'config', '--get', 'remote.origin.url').trim()).toBe(url)
  }, 60_000)

  it('never follows a redirect with the token: the operation fails and the other server sees no bearer', async () => {
    // B serves the same repository to anyone; A answers every request with a
    // redirect to B. git's default would follow it and send the header on.
    const atB: Array<string | undefined> = []
    const b = createServer((req, res) => {
      atB.push(req.headers.authorization)
      serveBackend(join(box, 'srv'), req, res)
    })
    const bOrigin = await listen(b)
    const a = createServer((req, res) => {
      res.writeHead(302, { Location: `${bOrigin}${req.url ?? '/'}` }).end()
    })
    const aOrigin = await listen(a)
    try {
      const dir = join(box, 'home', 'Local', 'redirected')
      const result = await cloneAgent(`${aOrigin}/git/team-1.git`, dir, { kind: 'cinna', origin: aOrigin, token })
      expect(result.refusal).toBe('fetch_failed')
      expect(existsSync(dir)).toBe(false)
      expect(atB.filter((header) => header !== undefined)).toEqual([])
    } finally {
      await new Promise<void>((resolve) => a.close(() => resolve()))
      await new Promise<void>((resolve) => b.close(() => resolve()))
    }
  }, 60_000)

  it('is refused without the token, which is what proves the header is the credential', async () => {
    const dir = join(box, 'home', 'Local', 'no-token')
    const result = await cloneAgent(`${origin}/git/team-1.git`, dir, EXTERNAL)
    expect(result.refusal).toBe('fetch_failed')
    expect(existsSync(dir)).toBe(false)
  }, 60_000)
})
