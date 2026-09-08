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
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

vi.mock('../../logger/logger', () => ({
  createLogger: () => ({ debug: () => {}, info: () => {}, warn: () => {}, error: () => {} })
}))

const { readGitStatus, updateGitRepo } = await import('./gitService')

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
