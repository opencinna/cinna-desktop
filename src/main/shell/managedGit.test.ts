import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

vi.mock('../logger/logger', () => ({
  createLogger: () => ({ debug() {}, info() {}, warn() {}, error() {} })
}))

const { createManagedGit, gitWrapperScript, MARK_USED_INTERVAL_MS, shellQuote, unsupportedMarkerName } = await import('./managedGit')
const { extractArchive } = await import('../managed/managedAsset')

/**
 * The managed git: a pinned tree installed whole or not at all, started at most
 * once per run, and run through a wrapper that carries dugite's environment.
 * Like `managedAsset.test.ts`, every failure asserts on what is left on disk.
 */

let base: string
let runtimes: string
let shimDir: string
let archive: string
let sha: string

/** A dugite-shaped tree, packed as the release packs it (`./bin/git`, `./libexec/…`). */
function packTree(version = '2.53.0'): { archive: string; sha: string } {
  const tree = join(base, 'tree')
  mkdirSync(join(tree, 'bin'), { recursive: true })
  mkdirSync(join(tree, 'libexec', 'git-core'), { recursive: true })
  mkdirSync(join(tree, 'share', 'git-core', 'templates'), { recursive: true })
  mkdirSync(join(tree, 'etc'), { recursive: true })
  writeFileSync(join(tree, 'bin', 'git'), `#!/bin/sh\necho "git version ${version}"\n`, { mode: 0o755 })
  writeFileSync(join(tree, 'libexec', 'git-core', 'git-remote-https'), '#!/bin/sh\n', { mode: 0o755 })
  writeFileSync(join(tree, 'share', 'git-core', 'templates', 'description'), 'x\n')
  writeFileSync(join(tree, 'etc', 'gitconfig'), '[core]\n')
  const out = join(base, `git-${version}.tar.gz`)
  const run = spawnSync('tar', ['-czf', out, '-C', tree, '.'])
  expect(run.status).toBe(0)
  rmSync(tree, { recursive: true, force: true })
  return { archive: out, sha: createHash('sha256').update(readFileSync(out)).digest('hex') }
}

function managed(options: { sha256?: string; platformKey?: string; enabled?: boolean; probe?: (git: string, env: Record<string, string>) => Promise<string | null>; now?: () => number } = {}) {
  const download = vi.fn(async (_url: string, dest: string) => {
    writeFileSync(dest, readFileSync(archive))
  })
  const probeVersion = vi.fn(
    options.probe ??
      (async (git: string, env: Record<string, string>) => {
        const run = spawnSync(git, ['--version'], { encoding: 'utf8', env: { ...process.env, ...env } })
        return run.status === 0 ? run.stdout.trim() : null
      })
  )
  const git = createManagedGit({
    platform: 'darwin',
    platformKey: options.platformKey ?? 'darwin-arm64',
    assets: { 'darwin-arm64': { file: 'git.tar.gz', sha256: options.sha256 ?? sha, url: 'https://example.invalid/git.tar.gz', size: 1 << 20 } },
    version: '2.53.0',
    versionOutput: 'git version 2.53.0',
    runtimesRoot: () => runtimes,
    shimDir: () => shimDir,
    downloadEnabled: () => options.enabled ?? true,
    download,
    extract: extractArchive,
    probeVersion,
    now: options.now
  })
  return { git, download, probeVersion }
}

beforeEach(() => {
  base = mkdtempSync(join(tmpdir(), 'cinna-managed-git-'))
  runtimes = join(base, 'runtimes')
  shimDir = join(base, 'git-shim')
  ;({ archive, sha } = packTree())
})

afterEach(() => {
  rmSync(base, { recursive: true, force: true })
})

describe('installing the managed git', () => {
  it('publishes the whole tree, not just bin/, and nothing else', async () => {
    const { git, probeVersion } = managed()
    await git.ensureInstalled()
    const root = join(runtimes, 'git-2.53.0')
    expect(readdirSync(runtimes)).toEqual(['git-2.53.0'])
    expect(readdirSync(root).sort()).toEqual(['bin', 'etc', 'libexec', 'share'])
    expect(existsSync(join(root, 'libexec', 'git-core', 'git-remote-https'))).toBe(true)
    expect(statSync(join(root, 'bin', 'git')).mode & 0o111).not.toBe(0)
    expect(await git.installed()).toBe(true)
    // The gate ran the staged tree with dugite's environment pointed into it.
    const [, env] = probeVersion.mock.calls[0]!
    expect(env['GIT_EXEC_PATH']).toMatch(/\.staging-.*\/libexec\/git-core$/)
    expect(env['GIT_TEMPLATE_DIR']).toMatch(/\/share\/git-core\/templates$/)
  })

  it('publishes nothing on a checksum mismatch, and does not try again this run', async () => {
    const { git, download } = managed({ sha256: '0'.repeat(64) })
    await git.ensureInstalled()
    expect(readdirSync(runtimes)).toEqual([])
    expect(await git.installed()).toBe(false)
    expect(git.ensureInstalled()).toBeNull()
    expect(await git.fallback()).toBeNull()
    expect(download).toHaveBeenCalledTimes(1)
    // A bad download may not recur: the next start tries again.
    const nextStart = managed()
    expect(existsSync(join(runtimes, unsupportedMarkerName('2.53.0')))).toBe(false)
    await nextStart.git.ensureInstalled()
    expect(nextStart.download).toHaveBeenCalledTimes(1)
    expect(await nextStart.git.installed()).toBe(true)
  })

  it('publishes nothing when the tree does not report the pinned version, and never downloads that version again', async () => {
    ;({ archive, sha } = packTree('2.52.0'))
    const { git } = managed()
    await git.ensureInstalled()
    expect(readdirSync(runtimes)).toEqual([unsupportedMarkerName('2.53.0')])
    expect(await git.installed()).toBe(false)
    // The next start finds the marker and downloads nothing.
    const nextStart = managed()
    expect(nextStart.git.ensureInstalled()).toBeNull()
    expect(await nextStart.git.fallback()).toBeNull()
    expect(nextStart.download).not.toHaveBeenCalled()
  })

  it('keeps the unsupported marker through a sweep', async () => {
    mkdirSync(runtimes, { recursive: true })
    writeFileSync(join(runtimes, unsupportedMarkerName('2.40.0')), 'x\n')
    const { git } = managed()
    await git.ensureInstalled()
    expect(readdirSync(runtimes).sort()).toEqual([unsupportedMarkerName('2.40.0'), 'git-2.53.0'])
  })

  it('runs one install for any number of callers', async () => {
    const { git, download } = managed()
    const first = git.ensureInstalled()
    expect(git.ensureInstalled()).toBe(first)
    await first
    expect(download).toHaveBeenCalledTimes(1)
    // Installed: a later kick finds it there and downloads nothing.
    await git.ensureInstalled()
    expect(download).toHaveBeenCalledTimes(1)
  })

  it('does nothing under CINNA_GIT_DOWNLOAD=off, or on a platform with no pin', async () => {
    const off = managed({ enabled: false })
    expect(off.git.ensureInstalled()).toBeNull()
    const windows = managed({ platformKey: 'win32-x64' })
    expect(windows.git.ensureInstalled()).toBeNull()
    expect(windows.git.supported()).toBe(false)
    expect(off.download).not.toHaveBeenCalled()
    expect(windows.download).not.toHaveBeenCalled()
  })

  it('sweeps a superseded managed git once the new one is in', async () => {
    const old = join(runtimes, 'git-2.40.0')
    mkdirSync(join(old, 'bin'), { recursive: true })
    const monthAgo = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000)
    utimesSync(old, monthAgo, monthAgo)
    const { git } = managed()
    await git.ensureInstalled()
    expect(readdirSync(runtimes)).toEqual(['git-2.53.0'])
  })
})

describe('the wrapper', () => {
  it('is written only once the tree is installed, and the fallback starts the install until then', async () => {
    const { git, download } = managed()
    expect(await git.wrapperPath()).toBeNull()
    expect(existsSync(shimDir)).toBe(false)
    expect(await git.fallback()).toBeNull()
    await git.ensureInstalled()
    expect(download).toHaveBeenCalledTimes(1)
    const path = await git.fallback()
    expect(path).toBe(join(shimDir, 'git'))
    expect(statSync(path!).mode & 0o777).toBe(0o755)
    expect(readdirSync(shimDir)).toEqual(['git'])
  })

  it('starts no install from the fallback when told not to', async () => {
    const { git, download } = managed()
    expect(await git.fallback({ install: false })).toBeNull()
    // An install would reach the download after its staging sweep; give it time to.
    await new Promise((resolve) => setTimeout(resolve, 200))
    expect(download).not.toHaveBeenCalled()
    expect(existsSync(runtimes)).toBe(false)
    expect(git.wrapperLocation()).toBe(join(shimDir, 'git'))
  })

  it('stamps the tree as used when the wrapper is confirmed, at most once an interval', async () => {
    const clock = { now: 1_000_000 }
    const { git } = managed({ now: () => clock.now })
    await git.ensureInstalled()
    const root = join(runtimes, 'git-2.53.0')
    const monthAgo = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000)
    const stale = () => utimesSync(root, monthAgo, monthAgo)
    const recent = () => statSync(root).mtimeMs > Date.now() - 60_000
    stale()
    await git.wrapperPath()
    expect(recent()).toBe(true)
    stale()
    clock.now += MARK_USED_INTERVAL_MS - 1
    await git.wrapperPath()
    expect(recent()).toBe(false)
    clock.now += 1
    await git.fallback()
    expect(recent()).toBe(true)
  })

  it('runs the managed git with dugite’s environment and passes every argument through', async () => {
    const root = join(base, "odd dir's $HOME")
    mkdirSync(join(root, 'bin'), { recursive: true })
    writeFileSync(
      join(root, 'bin', 'git'),
      '#!/bin/sh\nprintf "%s\\n" "$GIT_EXEC_PATH" "$GIT_TEMPLATE_DIR" "$GIT_CONFIG_SYSTEM" "$#" "$@"\n',
      { mode: 0o755 }
    )
    const wrapper = join(base, 'git')
    writeFileSync(wrapper, gitWrapperScript(root, 'darwin', '2.53.0'), { mode: 0o755 })
    const run = spawnSync(wrapper, ['commit', '-m', 'two words', "it's"], { encoding: 'utf8', env: { PATH: '/usr/bin:/bin' } })
    expect(run.status).toBe(0)
    expect(run.stdout.split('\n')).toEqual([
      join(root, 'libexec', 'git-core'),
      join(root, 'share', 'git-core', 'templates'),
      join(root, 'etc', 'gitconfig'),
      '4',
      'commit',
      '-m',
      'two words',
      "it's",
      ''
    ])
    // A user's own system config is left alone, as dugite leaves it.
    const own = spawnSync(wrapper, [], { encoding: 'utf8', env: { PATH: '/usr/bin:/bin', GIT_CONFIG_SYSTEM: '/etc/mine' } })
    expect(own.stdout.split('\n')[2]).toBe('/etc/mine')
  })

  it('on Linux also sets PREFIX and the bundled CA file, unless one is given', () => {
    const script = gitWrapperScript('/r', 'linux', '2.53.0')
    expect(script).toContain("PREFIX='/r'; export PREFIX")
    expect(script).toContain(`if [ -z "\${GIT_SSL_CAINFO:-}" ]; then GIT_SSL_CAINFO='/r/ssl/cacert.pem'; export GIT_SSL_CAINFO; fi`)
    expect(gitWrapperScript('/r', 'darwin', '2.53.0')).not.toContain('GIT_SSL_CAINFO')
    expect(script.startsWith('#!/bin/sh\n')).toBe(true)
    expect(script.trimEnd().split('\n').at(-1)).toBe(`exec '/r/bin/git' "$@"`)
  })

  it('quotes any path as one shell word', () => {
    expect(shellQuote("a b'c$d")).toBe(`'a b'\\''c$d'`)
    const echoed = spawnSync('/bin/sh', ['-c', `printf %s ${shellQuote("a b'c$d`\\")}`], { encoding: 'utf8' })
    expect(echoed.stdout).toBe("a b'c$d`\\")
  })
})
