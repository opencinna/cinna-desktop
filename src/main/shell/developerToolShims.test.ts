import { describe, it, expect, afterEach, vi } from 'vitest'
import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

vi.mock('../logger/logger', () => ({
  createLogger: () => ({ debug() {}, info() {}, warn() {}, error() {} })
}))

const { createDeveloperToolShims, shimScript } = await import('./developerToolShims')
const { MAC_DEVELOPER_TOOL_STUBS } = await import('./macDeveloperTools')

const dirs: string[] = []
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

function shims(options: {
  platform?: NodeJS.Platform
  installed?: boolean
  /** The developer tools' state; overrides `installed`. */
  state?: 'installed' | 'absent' | 'unknown'
  /** Where each name resolves; unlisted stub names resolve to the /usr/bin stub. */
  paths?: Record<string, string | null>
  /** The first non-stub match along PATH, per name; none unless listed. */
  pastStub?: Record<string, string>
  /** Is the managed git installed? Its wrapper is then `<root>/git-shim/git`. */
  managed?: boolean
}) {
  const root = mkdtempSync(join(tmpdir(), 'tool-shims-'))
  dirs.push(root)
  const dir = join(root, 'tool-shims')
  const which = vi.fn(async (bin: string) =>
    options.paths && bin in options.paths ? options.paths[bin] : `/usr/bin/${bin}`
  )
  const gitDir = join(root, 'git-shim')
  const managedGit = fakeManagedGit(gitDir, options.managed ?? false)
  const whichPastStub = vi.fn(async (bin: string) => options.pastStub?.[bin] ?? null)
  return {
    dir,
    gitDir,
    which,
    whichPastStub,
    managedGit,
    shims: createDeveloperToolShims({
      platform: options.platform ?? 'darwin',
      toolsState: async () => options.state ?? (options.installed ? 'installed' : 'absent'),
      which,
      whichPastStub,
      isStub: (path) => path.startsWith('/usr/bin/'),
      shimDir: () => dir,
      managedGit
    })
  }
}

/**
 * A managed git whose installed state the test flips. Its wrapper, written by
 * `wrapperPath()` while installed and gone otherwise, prints `managed git` and
 * its arguments.
 */
function fakeManagedGit(gitDir: string, installed: boolean) {
  const state = { installed }
  const wrapper = join(gitDir, 'git')
  return {
    state,
    wrapperLocation: () => wrapper,
    wrapperPath: vi.fn(async () => {
      if (!state.installed) {
        rmSync(wrapper, { force: true })
        return null
      }
      mkdirSync(gitDir, { recursive: true })
      writeFileSync(wrapper, '#!/bin/sh\necho "managed git $*"\n', { mode: 0o755 })
      return wrapper
    }),
    ensureInstalled: vi.fn((): Promise<void> | null => null)
  }
}

const ENV = { PATH: '/opt/homebrew/bin:/usr/bin:/bin', HOME: '/Users/x' }

describe('the engine PATH on a Mac without the developer tools', () => {
  it('puts the shim directory first, and keeps everything else', async () => {
    const { shims: s, dir } = shims({})
    const env = await s.apply(ENV)
    expect(env.PATH).toBe(`${dir}:${ENV.PATH}`)
    expect(env.HOME).toBe('/Users/x')
    expect(ENV.PATH).toBe('/opt/homebrew/bin:/usr/bin:/bin')
  })

  it('shims only the names that resolve to the stub — a Homebrew git still wins', async () => {
    const { shims: s, dir } = shims({ paths: { git: '/opt/homebrew/bin/git', python3: null } })
    await s.apply(ENV)
    const names = readdirSync(dir)
    expect(names).toContain('make')
    expect(names).toContain('clang')
    expect(names).not.toContain('git')
    expect(names).not.toContain('python3')
    expect(names).toHaveLength(MAC_DEVELOPER_TOOL_STUBS.size - 2)
  })

  it('writes executable scripts that say why and exit 127, without popping anything', async () => {
    const { shims: s, dir } = shims({})
    await s.apply(ENV)
    const git = join(dir, 'git')
    expect(statSync(git).mode & 0o777).toBe(0o755)
    const run = spawnSync(git, ['rev-parse'], { encoding: 'utf8' })
    expect(run.status).toBe(127)
    expect(run.stdout).toBe('')
    expect(run.stderr).toMatch(/^git: not available — Apple's command line developer tools are not installed \(xcode-select --install\)/)
  })

  it('is idempotent, and does not stack the directory on a PATH that already has it first', async () => {
    const { shims: s, dir } = shims({})
    const once = await s.apply(ENV)
    const twice = await s.apply(once)
    expect(twice.PATH).toBe(once.PATH)
    expect(readdirSync(dir)).toHaveLength(MAC_DEVELOPER_TOOL_STUBS.size)
  })

  it('removes a shim for a tool that has since been installed elsewhere', async () => {
    const first = shims({})
    await first.shims.apply(ENV)
    expect(existsSync(join(first.dir, 'git'))).toBe(true)
    const later = createDeveloperToolShims({
      platform: 'darwin',
      toolsState: async () => 'absent',
      which: async (bin) => (bin === 'git' ? '/opt/homebrew/bin/git' : `/usr/bin/${bin}`),
      whichPastStub: async () => null,
      isStub: (path) => path.startsWith('/usr/bin/'),
      shimDir: () => first.dir,
      managedGit: fakeManagedGit(join(first.dir, '..', 'git-shim'), false)
    })
    await later.apply(ENV)
    expect(existsSync(join(first.dir, 'git'))).toBe(false)
    expect(existsSync(join(first.dir, 'make'))).toBe(true)
  })

  it('rewrites a shim whose content was changed', async () => {
    const { shims: s, dir } = shims({})
    await s.apply(ENV)
    writeFileSync(join(dir, 'git'), '#!/bin/sh\nexec /usr/bin/git "$@"\n')
    await s.apply(ENV)
    expect(spawnSync(join(dir, 'git'), [], { encoding: 'utf8' }).status).toBe(127)
    expect(shimScript('git')).toContain('exit 127')
  })

  it('gives a bare PATH the shim directory alone, never an empty entry', async () => {
    const { shims: s, dir } = shims({})
    expect((await s.apply({ HOME: '/Users/x' } as Record<string, string | undefined>)).PATH).toBe(dir)
  })
})

describe('where nothing is shimmed', () => {
  it('leaves the env alone when the developer tools are installed', async () => {
    const { shims: s, dir, which } = shims({ installed: true })
    expect(await s.apply(ENV)).toBe(ENV)
    expect(existsSync(dir)).toBe(false)
    expect(which).not.toHaveBeenCalled()
  })

  it('leaves the env alone off macOS when git is there', async () => {
    const { shims: s, dir, managedGit } = shims({ platform: 'linux', managed: true })
    expect(await s.apply(ENV)).toBe(ENV)
    expect(existsSync(dir)).toBe(false)
    expect(managedGit.wrapperPath).not.toHaveBeenCalled()
    expect(managedGit.ensureInstalled).not.toHaveBeenCalled()
  })

  it('leaves the env alone on Windows, which has no managed git', async () => {
    const { shims: s, which } = shims({ platform: 'win32', paths: { git: null } })
    expect(await s.apply(ENV)).toBe(ENV)
    expect(which).not.toHaveBeenCalled()
  })

  it('leaves the env alone when no name resolves to a stub', async () => {
    const paths = Object.fromEntries([...MAC_DEVELOPER_TOOL_STUBS].map((name) => [name, null]))
    const { shims: s, dir } = shims({ paths })
    expect(await s.apply(ENV)).toBe(ENV)
    expect(existsSync(dir)).toBe(false)
  })

  it('never fails the turn when the directory cannot be written', async () => {
    const root = mkdtempSync(join(tmpdir(), 'tool-shims-'))
    dirs.push(root)
    const blocker = join(root, 'file')
    writeFileSync(blocker, '')
    const s = createDeveloperToolShims({
      platform: 'darwin',
      toolsState: async () => 'absent',
      which: async (bin) => `/usr/bin/${bin}`,
      whichPastStub: async () => null,
      isStub: () => true,
      shimDir: () => join(blocker, 'tool-shims'),
      managedGit: fakeManagedGit(join(root, 'git-shim'), false)
    })
    expect(await s.apply(ENV)).toBe(ENV)
  })
})

describe('the managed git, when there is no usable git', () => {
  it('on a Mac: puts the wrapper directory first, and keeps a git stand-in that runs the managed git', async () => {
    const { shims: s, dir, gitDir, managedGit } = shims({ managed: true })
    const env = await s.apply(ENV)
    expect(env.PATH).toBe(`${gitDir}:${dir}:${ENV.PATH}`)
    // Never removed: a child started with only tool-shims on its PATH would
    // otherwise fall through to the /usr/bin stub and pop the dialog.
    expect(readdirSync(dir)).toContain('git')
    expect(readdirSync(dir)).toContain('make')
    const run = spawnSync('/bin/sh', [join(dir, 'git'), 'status', '-s'], { encoding: 'utf8' })
    expect([run.status, run.stdout]).toEqual([0, 'managed git status -s\n'])
    expect(managedGit.ensureInstalled).not.toHaveBeenCalled()
  })

  it('on a Mac: the stand-in a running child already has starts delegating the moment the wrapper lands', async () => {
    const { shims: s, dir, managedGit } = shims({})
    await s.apply(ENV)
    const standIn = join(dir, 'git')
    const before = readFileSync(standIn, 'utf8')
    expect(spawnSync('/bin/sh', [standIn, 'log'], { encoding: 'utf8' }).status).toBe(127)
    // The wrapper appears (the install finished); the stand-in is not rewritten.
    managedGit.state.installed = true
    await managedGit.wrapperPath()
    const run = spawnSync('/bin/sh', [standIn, 'log'], { encoding: 'utf8' })
    expect([run.status, run.stdout]).toEqual([0, 'managed git log\n'])
    await s.apply(ENV)
    expect(readFileSync(standIn, 'utf8')).toBe(before)
  })

  it('on a Mac: uses a real git further along PATH — no install, and the stand-in runs that git', async () => {
    const { shims: s, dir, gitDir, managedGit, whichPastStub } = shims({ pastStub: { git: '/opt/homebrew/bin/git' } })
    const env = await s.apply({ PATH: '/usr/bin:/opt/homebrew/bin' })
    expect(env.PATH).toBe(`${dir}:/usr/bin:/opt/homebrew/bin`)
    expect(env.PATH!.split(':')).not.toContain(gitDir)
    expect(readdirSync(dir)).toContain('git')
    expect(readdirSync(dir)).toContain('make')
    expect(whichPastStub).toHaveBeenCalledWith('git')
    expect(managedGit.wrapperPath).not.toHaveBeenCalled()
    expect(managedGit.ensureInstalled).not.toHaveBeenCalled()
  })

  it('the git stand-in prefers a real git further along PATH, and never runs its own dirs or the stub', async () => {
    const { shims: s, dir, gitDir, managedGit } = shims({ managed: true })
    await s.apply(ENV)
    await managedGit.wrapperPath()
    const real = join(dir, '..', 'real bin')
    mkdirSync(real, { recursive: true })
    writeFileSync(join(real, 'git'), '#!/bin/sh\necho "real git $*"\n', { mode: 0o755 })
    const run = (path: string) =>
      spawnSync('/bin/sh', [join(dir, 'git'), 'st'], { encoding: 'utf8', env: { PATH: path } })
    expect(run(`${dir}:${gitDir}:/usr/bin:${real}`).stdout).toBe('real git st\n')
    // No real git: the managed wrapper, never the /usr/bin stub.
    expect(run(`${dir}:${gitDir}:/usr/bin:/bin`).stdout).toBe('managed git st\n')
  })

  it('on a Mac whose xcode-select could not be asked: shims, but never starts the install', async () => {
    const { shims: s, dir, managedGit } = shims({ state: 'unknown' })
    const env = await s.apply(ENV)
    expect(env.PATH).toBe(`${dir}:${ENV.PATH}`)
    expect(readdirSync(dir)).toContain('git')
    expect(managedGit.ensureInstalled).not.toHaveBeenCalled()
    // An installed managed git is still used.
    managedGit.state.installed = true
    expect((await s.apply(ENV)).PATH!.split(':')[0]).toBe(join(dir, '..', 'git-shim'))
    expect(managedGit.ensureInstalled).not.toHaveBeenCalled()
  })

  it('on a Mac: starts the install, and keeps the stand-in, while the managed git is absent', async () => {
    const { shims: s, dir, managedGit } = shims({})
    const env = await s.apply(ENV)
    expect(env.PATH).toBe(`${dir}:${ENV.PATH}`)
    expect(readdirSync(dir)).toContain('git')
    expect(managedGit.ensureInstalled).toHaveBeenCalledTimes(1)
  })

  it('switches stand-in → wrapper → stand-in, and PATH (so every launch key) changes with it', async () => {
    const { shims: s, dir, gitDir, managedGit } = shims({})
    const before = await s.apply(ENV)
    managedGit.state.installed = true
    const after = await s.apply(ENV)
    // The stand-in and the wrapper differ only in content under the same name;
    // were the wrapper written into tool-shims, PATH would not move and a
    // pooled session would keep running without git.
    expect(after.PATH).not.toBe(before.PATH)
    expect(after.PATH!.split(':')[0]).toBe(gitDir)
    expect(spawnSync(join(dir, 'git'), [], { encoding: 'utf8' }).stdout).toBe('managed git \n')
    managedGit.state.installed = false
    const again = await s.apply(ENV)
    expect(again.PATH).toBe(before.PATH)
    expect(spawnSync(join(dir, 'git'), [], { encoding: 'utf8' }).status).toBe(127)
  })

  it('is idempotent with the wrapper, and re-orders a PATH shimmed under the other plan', async () => {
    const { shims: s, dir, gitDir, managedGit } = shims({})
    const standIn = await s.apply(ENV)
    managedGit.state.installed = true
    const once = await s.apply(standIn)
    expect(once.PATH).toBe(`${gitDir}:${dir}:${ENV.PATH}`)
    expect((await s.apply(once)).PATH).toBe(once.PATH)
  })

  it('never consults the managed git when a Homebrew git answers', async () => {
    const { shims: s, gitDir, managedGit } = shims({ managed: true, paths: { git: '/opt/homebrew/bin/git' } })
    const env = await s.apply(ENV)
    expect(env.PATH!.split(':')).not.toContain(gitDir)
    expect(managedGit.wrapperPath).not.toHaveBeenCalled()
    expect(managedGit.ensureInstalled).not.toHaveBeenCalled()
  })

  it('never consults it when the developer tools are installed', async () => {
    const { shims: s, managedGit } = shims({ installed: true, managed: true })
    expect(await s.apply(ENV)).toBe(ENV)
    expect(managedGit.wrapperPath).not.toHaveBeenCalled()
  })

  it('on Linux without git: the wrapper directory alone, once installed', async () => {
    const { shims: s, dir, gitDir } = shims({ platform: 'linux', managed: true, paths: { git: null } })
    const env = await s.apply(ENV)
    expect(env.PATH).toBe(`${gitDir}:${ENV.PATH}`)
    expect(existsSync(dir)).toBe(false)
  })

  it('on Linux without git: the env unchanged and the install started, until then', async () => {
    const { shims: s, managedGit } = shims({ platform: 'linux', paths: { git: null } })
    expect(await s.apply(ENV)).toBe(ENV)
    expect(managedGit.ensureInstalled).toHaveBeenCalledTimes(1)
  })
})
