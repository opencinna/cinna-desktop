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
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
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
    GIT_CONFIG_NOSYSTEM: '1'
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
  diffForSummary
} = await import('./gitService')

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
  GIT_CONFIG_SYSTEM: '/dev/null'
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

  it('answers diverged_conflict on clashing edits, and leaves the folder exactly as it was', async () => {
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

    expect((await pullRebaseClean(b, EXTERNAL)).refusal).toBe('diverged_conflict')
    expect(git(b, 'rev-parse', 'HEAD').trim()).toBe(head)
    expect(readFileSync(join(b, 'AGENT.md'), 'utf8')).toBe('# Alpha\n\nLine one, by B.\nLine two.\n')
    expect(git(b, 'status', '--porcelain')).toBe('')
    expect(existsSync(join(b, '.git', 'rebase-merge'))).toBe(false)
    expect(existsSync(join(b, '.git', 'rebase-apply'))).toBe(false)

    // Sending hits the same wall, through the one retry, and never forces.
    const teamHead = git(team, 'rev-parse', 'main').trim()
    expect((await pushAgent(b, EXTERNAL)).refusal).toBe('diverged_conflict')
    expect(git(team, 'rev-parse', 'main').trim()).toBe(teamHead)
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
