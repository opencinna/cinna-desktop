import { describe, it, expect, afterEach, vi } from 'vitest'
import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { HANDOVERS_DIR, allowsAuto } from '../../shared/handovers'

vi.mock('../logger/logger', () => ({
  createLogger: () => ({ debug() {}, info() {}, warn() {}, error() {} })
}))
vi.mock('../shell/env', () => ({ getShellEnv: async () => process.env, usableTool: async (bin: string) => bin }))

const { createHandoverGit, handoverGit } = await import('./handoverGit')

/**
 * The `auto` permission is decided here, so this is tested against a **real
 * `git`** rather than a stubbed one. The question is not "did we call
 * check-ignore" — it is what git actually answers for a directory that is
 * ignored, one that is not, and one that is already committed, and those three
 * answers are what the security boundary in §3.4 stands on.
 *
 * `git` may be absent on a machine (which is the *other* branch, exercised with
 * an injected `execFile` that throws ENOENT), so the real-repository cases skip
 * rather than fail when it is.
 */
const gitAvailable = ((): boolean => {
  try {
    execFileSync('git', ['--version'], { stdio: 'ignore' })
    return true
  } catch {
    return false
  }
})()

const dirs: string[] = []

function repo(options: { init?: boolean; gitignore?: string; commit?: boolean } = {}): string {
  const dir = mkdtempSync(join(tmpdir(), 'handover-git-'))
  dirs.push(dir)
  mkdirSync(join(dir, HANDOVERS_DIR, '20260917-1200-retry'), { recursive: true })
  writeFileSync(join(dir, HANDOVERS_DIR, '20260917-1200-retry', 'brief.md'), 'brief\n')
  if (options.gitignore !== undefined) writeFileSync(join(dir, '.gitignore'), options.gitignore)
  if (options.init) {
    const run = (...args: string[]): void => {
      execFileSync('git', ['-C', dir, ...args], { stdio: 'ignore' })
    }
    run('init', '-q')
    run('config', 'user.email', 'test@example.com')
    run('config', 'user.name', 'Test')
    if (options.commit) {
      run('add', '-A', '-f')
      run('commit', '-q', '-m', 'in')
    }
  }
  return dir
}

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

describe.skipIf(!gitAvailable)('what git says about a real folder', () => {
  it('allows a folder that is not a repository at all — nothing can arrive by pull', async () => {
    const check = await handoverGit.check(repo())
    expect(check.result).toBe('not_a_repo')
    expect(allowsAuto(check)).toBe(true)
  })

  it('allows an ignored handovers directory', async () => {
    const check = await handoverGit.check(repo({ init: true, gitignore: '.cinna/\n' }))
    expect(check.result).toBe('ignored')
    expect(allowsAuto(check)).toBe(true)
  })

  it('refuses a directory that is inside a repository and not ignored', async () => {
    const check = await handoverGit.check(repo({ init: true }))
    expect(check.result).toBe('not_ignored')
    expect(allowsAuto(check)).toBe(false)
    expect(check.detail).toMatch(/gitignore/)
  })

  it('refuses a directory that is already committed, and says so distinctly', async () => {
    // The worst case and the loudest: ignoring it now would not untrack it, and
    // anything that can land a commit can plant a brief.
    const check = await handoverGit.check(repo({ init: true, commit: true }))
    expect(check.result).toBe('tracked')
    expect(allowsAuto(check)).toBe(false)
  })

  it('never grants a permission for a folder that is not there', async () => {
    // `git -C` fails the same way for "not a repository" and "that path is
    // gone", and only one of the two is safe to read as `not_a_repo`.
    const check = await handoverGit.check(join(tmpdir(), 'handover-git-nope-does-not-exist'))
    expect(check.result).toBe('unknown')
    expect(allowsAuto(check)).toBe(false)
  })
})

describe('with no git binary on the machine', () => {
  const enoent = (): never => {
    const error = new Error('spawn git ENOENT') as NodeJS.ErrnoException
    error.code = 'ENOENT'
    throw error
  }

  /** A git that is not there, over a filesystem holding exactly `paths`. */
  function noGit(paths: string[]) {
    const present = new Set(paths)
    return createHandoverGit({
      execFile: async () => enoent(),
      env: async () => ({}),
      exists: (path) => present.has(path)
    })
  }

  const project = join('/', 'work', 'project')

  it('is unknown for a folder with a .git directory — the tracked state cannot be checked', async () => {
    const check = await noGit([project, join(project, '.git')]).check(project)
    expect(check.result).toBe('unknown')
    expect(check.detail).toMatch(/git isn’t available to confirm/)
    expect(allowsAuto(check)).toBe(false)
  })

  it('is unknown for a folder inside a repository whose .git is in a parent', async () => {
    const check = await noGit([project, join('/', 'work', '.git')]).check(project)
    expect(check.result).toBe('unknown')
    expect(allowsAuto(check)).toBe(false)
  })

  it('is unknown for a worktree, whose .git is a file', async () => {
    // `exists` is the only question asked, so a file answers the same as a directory.
    const check = await createHandoverGit({
      execFile: async () => enoent(),
      env: async () => ({}),
      exists: (path) => path === project || path === join(project, '.git')
    }).check(project)
    expect(check.result).toBe('unknown')
    expect(allowsAuto(check)).toBe(false)
  })

  it('allows a folder with no repository anywhere above it', async () => {
    const check = await noGit([project]).check(project)
    expect(check.result).toBe('not_a_repo')
    expect(allowsAuto(check)).toBe(true)
  })

  it('never grants a permission for a folder that is not there', async () => {
    const check = await noGit([]).check(project)
    expect(check.result).toBe('unknown')
  })

  it('never spawns a git the resolver calls unusable (a macOS stub)', async () => {
    // Running `/usr/bin/git` on a Mac without the developer tools pops the
    // install dialog, so the stub must not even be tried.
    const execFile = vi.fn(async () => ({ stdout: 'true\n', stderr: '' }))
    const git = createHandoverGit({
      execFile,
      env: async () => ({}),
      exists: (path) => path === project || path === join(project, '.git'),
      resolveGit: async () => null
    })
    const check = await git.check(project)
    expect(check.result).toBe('unknown')
    expect(execFile).not.toHaveBeenCalled()

    // A credential path cannot be judged without git either; still no spawn.
    const credential = await git.check(project, 'credentials/.env')
    expect(credential.result).toBe('unknown')
    expect(execFile).not.toHaveBeenCalled()
  })

  it('runs the git the resolver found, by its path', async () => {
    const execFile = vi.fn(async (_file: string, args: string[]) => {
      if (args.includes('rev-parse')) throw Object.assign(new Error('not a repo'), { code: 128 })
      return { stdout: '', stderr: '' }
    })
    const check = await createHandoverGit({
      execFile,
      env: async () => ({}),
      exists: () => true,
      resolveGit: async () => '/opt/homebrew/bin/git'
    }).check('/p')
    expect(check.result).toBe('not_a_repo')
    expect(execFile.mock.calls[0]?.[0]).toBe('/opt/homebrew/bin/git')
  })
})

describe('when git answers something unexpected', () => {
  it('never reads a killed git as "no repository"', async () => {
    // The 5 s timeout kills the child with a signal and **no exit code**, and so
    // does an OOM killer; `index.lock` contention and a slow mount both reach
    // it. Reading that as `not_a_repo` would grant `auto` to a repository whose
    // handovers are committed — the one case the check exists to catch.
    const check = await createHandoverGit({
      execFile: async () => {
        throw Object.assign(new Error('Command failed: git rev-parse'), { killed: true, signal: 'SIGTERM' })
      },
      env: async () => ({}),
      exists: () => true
    }).check('/p')
    expect(check.result).toBe('unknown')
    expect(allowsAuto(check)).toBe(false)
  })

  it('is unknown rather than a permission', async () => {
    const check = await createHandoverGit({
      execFile: async (_file, args) => {
        if (args.includes('rev-parse')) return { stdout: 'true\n', stderr: '' }
        // Not exit 1 and not ENOENT: a git that failed for its own reasons.
        const error = Object.assign(new Error('fatal: something else'), { code: 128 })
        throw error
      },
      env: async () => ({}),
      exists: () => true
    }).check('/p')
    expect(check.result).toBe('unknown')
    expect(allowsAuto(check)).toBe(false)
  })
})
