import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

vi.mock('../logger/logger', () => ({
  createLogger: () => ({ debug() {}, info() {}, warn() {}, error() {} })
}))

const { answersPin, createManagedGh, MARK_USED_INTERVAL_MS, unsupportedMarkerName } = await import('./managedGh')
const { extractArchive } = await import('../managed/managedAsset')

/**
 * The managed gh: a pinned release archive installed whole or not at all into
 * `runtimes/gh-<version>/`, started at most once per run. Like
 * `managedGit.test.ts`, every failure asserts on what is left on disk. No
 * network: the download copies a locally packed archive.
 */

let base: string
let runtimes: string
let archive: string
let sha: string

/** A release-shaped archive (`gh_<v>_test/bin/gh` beside `LICENSE`) whose `gh` prints `versionLine`. */
function packRelease(versionLine = 'gh version 2.105.0 (2026-11-17)'): { archive: string; sha: string } {
  const tree = join(base, 'tree')
  const top = join(tree, 'gh_2.105.0_test')
  mkdirSync(join(top, 'bin'), { recursive: true })
  mkdirSync(join(top, 'share', 'man', 'man1'), { recursive: true })
  writeFileSync(join(top, 'bin', 'gh'), `#!/bin/sh\necho "${versionLine}"\necho "https://github.com/cli/cli/releases/tag/v2.105.0"\n`, { mode: 0o755 })
  writeFileSync(join(top, 'LICENSE'), 'MIT\n')
  writeFileSync(join(top, 'share', 'man', 'man1', 'gh.1'), 'x\n')
  const out = join(base, `gh-${Math.random().toString(36).slice(2)}.tar.gz`)
  const run = spawnSync('tar', ['-czf', out, '-C', tree, 'gh_2.105.0_test'])
  expect(run.status).toBe(0)
  rmSync(tree, { recursive: true, force: true })
  return { archive: out, sha: createHash('sha256').update(readFileSync(out)).digest('hex') }
}

function managed(options: { sha256?: string; platformKey?: string; enabled?: boolean; now?: () => number } = {}) {
  const download = vi.fn(async (_url: string, dest: string) => {
    writeFileSync(dest, readFileSync(archive))
  })
  const probeVersion = vi.fn(async (gh: string) => {
    const run = spawnSync(gh, ['--version'], { encoding: 'utf8' })
    return run.status === 0 ? run.stdout.trim().split('\n')[0]!.trim() : null
  })
  const gh = createManagedGh({
    platformKey: options.platformKey ?? 'darwin-arm64',
    assets: { 'darwin-arm64': { file: 'gh.tar.gz', sha256: options.sha256 ?? sha, url: 'https://example.invalid/gh.tar.gz', size: 1 << 20 } },
    version: '2.105.0',
    versionOutput: 'gh version 2.105.0',
    runtimesRoot: () => runtimes,
    downloadEnabled: () => options.enabled ?? true,
    download,
    extract: extractArchive,
    probeVersion,
    now: options.now
  })
  return { gh, download, probeVersion }
}

beforeEach(() => {
  base = mkdtempSync(join(tmpdir(), 'cinna-managed-gh-'))
  runtimes = join(base, 'runtimes')
  ;({ archive, sha } = packRelease())
})

afterEach(() => {
  rmSync(base, { recursive: true, force: true })
})

describe('installing the managed gh', () => {
  it('publishes the release directory into runtimes/gh-<version>/ with the binary at bin/gh', async () => {
    const { gh, probeVersion } = managed()
    expect(await gh.binaryPath()).toBeNull()
    await gh.ensureInstalled()
    const root = join(runtimes, 'gh-2.105.0')
    expect(readdirSync(runtimes)).toEqual(['gh-2.105.0'])
    expect(readdirSync(root).sort()).toEqual(['LICENSE', 'bin', 'share'])
    expect(statSync(join(root, 'bin', 'gh')).mode & 0o111).not.toBe(0)
    expect(gh.binaryLocation()).toBe(join(root, 'bin', 'gh'))
    expect(await gh.binaryPath()).toBe(join(root, 'bin', 'gh'))
    expect(await gh.installed()).toBe(true)
    // The gate ran the staged copy, before anything was published.
    expect(probeVersion.mock.calls[0]![0]).toMatch(/\.staging-.*\/bin\/gh$/)
  })

  it('publishes nothing on a checksum mismatch, and does not try again this run', async () => {
    const { gh, download } = managed({ sha256: '0'.repeat(64) })
    await gh.ensureInstalled()
    expect(readdirSync(runtimes)).toEqual([])
    expect(await gh.binaryPath()).toBeNull()
    expect(gh.ensureInstalled()).toBeNull()
    expect(download).toHaveBeenCalledTimes(1)
    // A bad download may not recur: the next start tries again.
    expect(existsSync(join(runtimes, unsupportedMarkerName('2.105.0')))).toBe(false)
    const nextStart = managed()
    await nextStart.gh.ensureInstalled()
    expect(nextStart.download).toHaveBeenCalledTimes(1)
    expect(await nextStart.gh.installed()).toBe(true)
  })

  it('publishes nothing when gh does not report the pinned version, and never downloads that version again', async () => {
    ;({ archive, sha } = packRelease('gh version 2.104.0 (2026-11-01)'))
    const { gh } = managed()
    await gh.ensureInstalled()
    expect(readdirSync(runtimes)).toEqual([unsupportedMarkerName('2.105.0')])
    expect(await gh.binaryPath()).toBeNull()
    // The next start finds the marker and downloads nothing.
    const nextStart = managed()
    expect(nextStart.gh.ensureInstalled()).toBeNull()
    expect(nextStart.download).not.toHaveBeenCalled()
  })

  it('writes the unsupported marker for an archive with no bin/gh', async () => {
    const tree = join(base, 'empty')
    mkdirSync(join(tree, 'gh_2.105.0_test'), { recursive: true })
    writeFileSync(join(tree, 'gh_2.105.0_test', 'LICENSE'), 'MIT\n')
    archive = join(base, 'nogh.tar.gz')
    expect(spawnSync('tar', ['-czf', archive, '-C', tree, '.']).status).toBe(0)
    sha = createHash('sha256').update(readFileSync(archive)).digest('hex')
    const { gh } = managed()
    await gh.ensureInstalled()
    expect(readdirSync(runtimes)).toEqual([unsupportedMarkerName('2.105.0')])
  })

  it('runs one install for any number of callers', async () => {
    const { gh, download } = managed()
    const first = gh.ensureInstalled()
    expect(first).not.toBeNull()
    expect(gh.installing()).toBe(true)
    expect(gh.ensureInstalled()).toBe(first)
    await first
    expect(gh.installing()).toBe(false)
    expect(download).toHaveBeenCalledTimes(1)
    // Installed: a later kick finds it there and downloads nothing.
    await gh.ensureInstalled()
    expect(download).toHaveBeenCalledTimes(1)
  })

  it('does nothing under CINNA_GH_DOWNLOAD=off, or on a platform with no pin', async () => {
    const off = managed({ enabled: false })
    expect(off.gh.ensureInstalled()).toBeNull()
    const windows = managed({ platformKey: 'win32-x64' })
    expect(windows.gh.ensureInstalled()).toBeNull()
    expect(windows.gh.supported()).toBe(false)
    expect(await windows.gh.binaryPath()).toBeNull()
    expect(off.download).not.toHaveBeenCalled()
    expect(windows.download).not.toHaveBeenCalled()
    expect(existsSync(runtimes)).toBe(false)
  })

  it('sweeps a week-old superseded gh and stale staging once the new one is in, and keeps a recent one and the git', async () => {
    const monthAgo = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000)
    for (const dir of ['gh-2.100.0', 'gh-2.104.0', 'git-2.56.0', '.staging-1-2-3']) mkdirSync(join(runtimes, dir, 'bin'), { recursive: true })
    utimesSync(join(runtimes, 'gh-2.100.0'), monthAgo, monthAgo)
    utimesSync(join(runtimes, 'git-2.56.0'), monthAgo, monthAgo)
    writeFileSync(join(runtimes, unsupportedMarkerName('2.90.0')), 'x\n')
    const { gh } = managed()
    await gh.ensureInstalled()
    expect(readdirSync(runtimes).sort()).toEqual([unsupportedMarkerName('2.90.0'), 'gh-2.104.0', 'gh-2.105.0', 'git-2.56.0'])
  })
})

describe('the installed binary', () => {
  it('stamps the tree as used when its path is asked for, at most once an interval', async () => {
    const clock = { now: 1_000_000 }
    const { gh } = managed({ now: () => clock.now })
    await gh.ensureInstalled()
    const root = join(runtimes, 'gh-2.105.0')
    const monthAgo = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000)
    const stale = () => utimesSync(root, monthAgo, monthAgo)
    const recent = () => statSync(root).mtimeMs > Date.now() - 60_000
    stale()
    await gh.binaryPath()
    expect(recent()).toBe(true)
    stale()
    clock.now += MARK_USED_INTERVAL_MS - 1
    await gh.binaryPath()
    expect(recent()).toBe(false)
    clock.now += 1
    await gh.binaryPath()
    expect(recent()).toBe(true)
  })

  it('accepts the pinned version followed by its build date, and nothing else', () => {
    expect(answersPin('gh version 2.105.0 (2026-11-17)', 'gh version 2.105.0')).toBe(true)
    expect(answersPin('gh version 2.105.0', 'gh version 2.105.0')).toBe(true)
    expect(answersPin('gh version 2.105.01 (2026-11-17)', 'gh version 2.105.0')).toBe(false)
    expect(answersPin('gh version 2.104.0 (2026-11-01)', 'gh version 2.105.0')).toBe(false)
    expect(answersPin(null, 'gh version 2.105.0')).toBe(false)
  })
})
