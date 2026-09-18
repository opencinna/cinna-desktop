import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { createHash } from 'node:crypto'
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, symlinkSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { realpathSync } from 'node:fs'
import {
  binaryFingerprint,
  CLAUDE_ASSETS,
  CLAUDE_SPEC,
  CODEX_ASSETS,
  CODEX_SPEC,
  ENGINE_ASSETS,
  EngineBinaryError,
  knownRuntimeBinary,
  managedBinaryPath,
  pinnedAssetBytes,
  realClaudeResolverDeps,
  realCodexResolverDeps,
  resolveEngineBinaryWith,
  sha256File,
  type BinaryResolverDeps,
  type EngineAsset
} from './binaryResolver'

/**
 * Resolving an engine binary.
 *
 * The assertion that carries this file is **"nothing is left behind"** — after
 * a failed verification, a failed extraction or a failed download, the engine
 * directory must hold nothing a later run could mistake for a good install.
 * `expect(...).rejects.toThrow()` on its own is the weak version of that test:
 * it passes while a half-unpacked binary sits in the install directory waiting
 * to be run. So every failure case asserts on the directory contents too.
 *
 * Every assertion here was mutation-checked, and this file is the one where
 * that claim survived re-checking unchanged: eight mutations — skipping the
 * digest comparison, extracting before verifying, dropping the staging
 * cleanup, silently substituting for a bad configured path, checking PATH
 * before the configured path, refusing to walk a nested archive, downloading
 * for an unlisted platform, and reinstalling over a good install — each failed
 * at least one test here.
 */

vi.mock('electron', () => ({ app: { getPath: () => '/nonexistent' } }))
const logInfo = vi.hoisted(() => vi.fn())
vi.mock('../logger/logger', () => ({
  createLogger: () => ({ debug: () => {}, info: logInfo, warn: () => {}, error: () => {} })
}))

const ARCHIVE_BYTES = 'pretend this is a 46 MB zip'
const ARCHIVE_SHA = createHash('sha256').update(ARCHIVE_BYTES).digest('hex')

let root: string
let downloads: string[]


function harness(overrides: Partial<BinaryResolverDeps> = {}): BinaryResolverDeps {
  const assets: Record<string, EngineAsset> = {
    'test-arch': { file: 'engine.zip', sha256: ARCHIVE_SHA }
  }
  return {
    configuredPath: () => null,
    which: async () => null,
    engineRoot: () => root,
    download: async (_url, dest) => {
      downloads.push(dest)
      writeFileSync(dest, ARCHIVE_BYTES)
    },
    // The real `tar -xf` equivalent: drop an `opencode` file into `dest`.
    extract: async (_archive, dest) => {
      writeFileSync(join(dest, 'opencode'), '#!/bin/sh\necho 1.2.3\n')
    },
    probeVersion: async () => '1.2.3',
    platformKey: () => 'test-arch',
    assets,
    version: '9.9.9',
    ...overrides
  }
}

/** Anything in the engine root that is not a `.staging-*` scratch directory. */
function published(): string[] {
  return readdirSync(root).filter((name) => !name.startsWith('.staging-')).sort()
}

/** Backdate a directory's mtime — the resolver's "last used" stamp — by whole days. */
function idleFor(path: string, days: number): void {
  const then = new Date(Date.now() - days * 24 * 60 * 60 * 1000)
  utimesSync(path, then, then)
}

/** Everything in the engine root, staging included. */
function everything(): string[] {
  return readdirSync(root).sort()
}

beforeEach(() => {
  // Real, because macOS's tmpdir is itself behind a symlink and the reuse path
  // now answers with real paths.
  root = realpathSync(mkdtempSync(join(tmpdir(), 'cinna-engine-')))
  downloads = []
  logInfo.mockClear()
})

afterEach(() => {
  rmSync(root, { recursive: true, force: true })
})

describe('the pin table', () => {
  it('carries a 64-hex digest for every platform it claims to support', () => {
    const keys = Object.keys(ENGINE_ASSETS)
    expect(keys).toContain('darwin-arm64')
    expect(keys.length).toBeGreaterThanOrEqual(4)
    for (const [key, asset] of Object.entries(ENGINE_ASSETS)) {
      expect(asset.sha256, key).toMatch(/^[0-9a-f]{64}$/)
      expect(asset.file, key).not.toBe('')
    }
  })
})

describe('resolveEngineBinaryWith — source precedence', () => {
  it('uses a configured path ahead of PATH and of downloading', async () => {
    const configured = join(root, 'my-opencode')
    writeFileSync(configured, '#!/bin/sh\n')
    chmodSync(configured, 0o755)
    const onPath = vi.fn(async () => '/usr/local/bin/opencode')

    const resolved = await resolveEngineBinaryWith(
      harness({ configuredPath: () => configured, which: onPath })
    )
    expect(resolved).toMatchObject({ path: configured, source: 'configured', version: '1.2.3' })
    expect(onPath).not.toHaveBeenCalled()
    expect(downloads).toEqual([])
  })

  it('refuses rather than silently substituting when the configured path is wrong', async () => {
    // Running a *different* engine than the one the user named is worse than
    // telling them the path is wrong.
    await expect(
      resolveEngineBinaryWith(harness({ configuredPath: () => join(root, 'not-there') }))
    ).rejects.toThrow(/^OpenCode path is not a file — fix it in Local Development\.$/)
    expect(downloads).toEqual([])

    const dud = join(root, 'dud')
    writeFileSync(dud, 'x')
    await expect(
      resolveEngineBinaryWith(
        harness({ configuredPath: () => dud, probeVersion: async () => null })
      )
    ).rejects.toThrow(/^OpenCode path will not run — fix it in Local Development\.$/)
    expect(downloads).toEqual([])
  })

  it('words a path failure without the redirect for the Path field that fixes it', async () => {
    // One message function, two surfaces: under the field in Local Development
    // "fix it in Local Development" names the tab the user is on.
    const said = (deps: Parameters<typeof resolveEngineBinaryWith>[0]) =>
      resolveEngineBinaryWith(deps).then(
        () => null,
        (err: EngineBinaryError) => [err.message, err.pathFieldMessage]
      )
    const dud = join(root, 'dud')
    writeFileSync(dud, 'x')
    expect(await said(harness({ configuredPath: () => join(root, 'not-there') }))).toEqual([
      'OpenCode path is not a file — fix it in Local Development.',
      'OpenCode path is not a file — fix or clear it.'
    ])
    expect(await said(harness({ configuredPath: () => dud, probeVersion: async () => null }))).toEqual([
      'OpenCode path will not run — fix it in Local Development.',
      'OpenCode path will not run — fix or clear it.'
    ])
    expect(downloads).toEqual([])
  })

  it('uses an opencode on PATH ahead of downloading one', async () => {
    const resolved = await resolveEngineBinaryWith(
      harness({ which: async () => '/usr/local/bin/opencode' })
    )
    expect(resolved).toMatchObject({ path: '/usr/local/bin/opencode', source: 'path' })
    expect(downloads).toEqual([])
  })

  it('falls through to the managed copy when the one on PATH will not run', async () => {
    let probes = 0
    const resolved = await resolveEngineBinaryWith(
      harness({
        which: async () => '/usr/local/bin/opencode',
        // First probe is the PATH candidate, second is the installed copy.
        probeVersion: async () => (++probes === 1 ? null : '1.2.3')
      })
    )
    expect(resolved.source).toBe('managed')
    expect(downloads).toHaveLength(1)
  })
})

describe('resolveEngineBinaryWith — the managed install', () => {
  it('downloads, verifies and publishes the binary at a stable path', async () => {
    const resolved = await resolveEngineBinaryWith(harness())
    expect(resolved).toMatchObject({
      path: join(root, 'opencode-9.9.9', 'opencode'),
      source: 'managed',
      version: '1.2.3'
    })
    // Only the published directory survives; the staging scratch is gone.
    expect(everything()).toEqual(['opencode-9.9.9'])
  })

  it('downloads once when two callers ask at the same time', async () => {
    // There are two askers now: local development pre-fetches the binary, and a
    // starting turn resolves it. A user who sends a message while first-run
    // setup is still going has both in flight at once, and the pre-fetch exists
    // to spend the 46 MB *once*.
    let release = (): void => {}
    const held = new Promise<void>((resolve) => {
      release = resolve
    })
    const seen: number[] = []
    const deps = harness({
      download: async (_url, dest, onProgress) => {
        downloads.push(dest)
        await held
        onProgress?.(5, 10)
        writeFileSync(dest, ARCHIVE_BYTES)
      }
    })

    const first = resolveEngineBinaryWith(deps)
    // The second caller brings the progress callback, and must still hear from
    // the download the first one started.
    const second = resolveEngineBinaryWith(deps, (received) => seen.push(received))
    release()
    const [a, b] = await Promise.all([first, second])

    expect(downloads).toHaveLength(1)
    expect(a.path).toBe(b.path)
    expect(seen).toEqual([5])
    expect(published()).toEqual(['opencode-9.9.9'])
  })

  it('does not download again once it is installed', async () => {
    await resolveEngineBinaryWith(harness())
    expect(downloads).toHaveLength(1)
    await resolveEngineBinaryWith(harness())
    expect(downloads).toHaveLength(1)
  })

  it('removes superseded versions and abandoned staging after a successful install, and nothing else', async () => {
    // A pin bump used to leave the previous tree in userData for good.
    for (const dir of ['opencode-1.0.0', 'opencode-9.9.8', '.staging-123-456-1', 'opencode-notes', 'codex-0.1.0', 'prompts']) {
      mkdirSync(join(root, dir))
      writeFileSync(join(root, dir, 'file'), 'x')
      idleFor(join(root, dir), 8)
    }
    writeFileSync(join(root, 'opencode.json'), '{}')
    await resolveEngineBinaryWith(harness())
    // Its own old versions and the dead staging go; another tool's install, a
    // directory that merely shares the prefix, and the root's own files stay.
    expect(everything()).toEqual(['codex-0.1.0', 'opencode-9.9.9', 'opencode-notes', 'opencode.json', 'prompts'])
  })

  it('keeps another version that was used this week: two builds sharing userData must not delete each other', async () => {
    // A dev build and a release build with different pins, one profile. Each
    // install used to remove the other's copy, which the other then downloaded
    // again on its next launch — for ever. Mutation: drop the age check in
    // `sweepSuperseded` and `opencode-9.9.8` is gone.
    mkdirSync(join(root, 'opencode-9.9.8'))
    idleFor(join(root, 'opencode-9.9.8'), 6)
    mkdirSync(join(root, 'opencode-1.0.0'))
    idleFor(join(root, 'opencode-1.0.0'), 8)
    await resolveEngineBinaryWith(harness())
    expect(published()).toEqual(['opencode-9.9.8', 'opencode-9.9.9'])
  })

  it('stamps a managed copy as used every time it is resolved, which is what "this week" is measured from', async () => {
    await resolveEngineBinaryWith(harness())
    const dir = join(root, 'opencode-9.9.9')
    idleFor(dir, 30)
    await resolveEngineBinaryWith(harness())
    expect(Date.now() - statSync(dir).mtimeMs).toBeLessThan(60_000)
    expect(downloads).toHaveLength(1)
  })

  it('does not sweep when the fresh install will not answer --version: the old version may be the one that works', async () => {
    mkdirSync(join(root, 'opencode-1.0.0'))
    idleFor(join(root, 'opencode-1.0.0'), 8)
    await resolveEngineBinaryWith(harness({ probeVersion: async () => null }))
    expect(published()).toEqual(['opencode-1.0.0', 'opencode-9.9.9'])
  })

  it('sweeps nothing when the install is already there, or when the install fails', async () => {
    await resolveEngineBinaryWith(harness())
    mkdirSync(join(root, 'opencode-1.0.0'))
    idleFor(join(root, 'opencode-1.0.0'), 8)
    await resolveEngineBinaryWith(harness())
    expect(published()).toEqual(['opencode-1.0.0', 'opencode-9.9.9'])
    // A failed newer install must not cost the user the version that works.
    await expect(resolveEngineBinaryWith(harness({ version: '10.0.0', download: async () => { throw new Error('offline') } }))).rejects.toThrow()
    expect(published()).toEqual(['opencode-1.0.0', 'opencode-9.9.9'])
  })

  it('discards a download whose checksum does not match, leaving nothing behind', async () => {
    const deps = harness({
      download: async (_url, dest) => {
        downloads.push(dest)
        writeFileSync(dest, 'substituted bytes')
      }
    })
    await expect(resolveEngineBinaryWith(deps)).rejects.toThrow(/checksum/i)
    // The point of the test: not merely that it threw, but that no install
    // directory exists for a later run to find and execute.
    expect(published()).toEqual([])
    expect(everything()).toEqual([])
  })

  it('does not unpack an archive that failed verification', async () => {
    const extract = vi.fn(async () => undefined)
    await expect(
      resolveEngineBinaryWith(
        harness({
          extract,
          download: async (_url, dest) => writeFileSync(dest, 'substituted bytes')
        })
      )
    ).rejects.toThrow(/checksum/i)
    expect(extract).not.toHaveBeenCalled()
  })

  it('leaves nothing behind when the archive contains no executable', async () => {
    await expect(
      resolveEngineBinaryWith(
        harness({
          extract: async (_archive, dest) => writeFileSync(join(dest, 'README.txt'), 'nope')
        })
      )
    ).rejects.toThrow(/did not contain an opencode executable/i)
    expect(everything()).toEqual([])
  })

  it('leaves nothing behind when the download itself fails', async () => {
    await expect(
      resolveEngineBinaryWith(
        harness({
          download: async () => {
            throw new Error('network is down')
          }
        })
      )
    ).rejects.toThrow(/network is down/)
    expect(everything()).toEqual([])
  })

  it('finds a binary the archive nested one level down', async () => {
    const resolved = await resolveEngineBinaryWith(
      harness({
        extract: async (_archive, dest) => {
          mkdirSync(join(dest, 'opencode-linux-x64'))
          writeFileSync(join(dest, 'opencode-linux-x64', 'opencode'), '#!/bin/sh\n')
        }
      })
    )
    // Published at the same place regardless of how the archive nested it, so
    // the "is it installed" check is one path rather than a search.
    expect(resolved.path).toBe(join(root, 'opencode-9.9.9', 'opencode'))
  })

  it('says plainly that a platform with no verified build must install its own', async () => {
    await expect(
      resolveEngineBinaryWith(harness({ platformKey: () => 'sunos-sparc' }))
      // Remedy first, then the platform it has no build for: the sentence lands
      // in a 414px reserved line and problem-first it lost the half that says
      // what to do (ux_rules rule 7).
    ).rejects.toThrow(/Install opencode yourself.*no verified build for sunos-sparc/i)
    expect(downloads).toEqual([])
  })
})

/**
 * The same resolver under the Codex spec.
 *
 * What differs from OpenCode is exactly what these cases pin: the user's PATH
 * copy is never the answer, the archive's triple-named executable is published
 * under one name, and a verified archive whose binary reports another version
 * is discarded like a bad digest — nothing published, nothing left behind.
 */
describe('resolveEngineBinaryWith — the managed Codex CLI', () => {
  const TRIPLE = 'codex-aarch64-apple-darwin'
  function codex(overrides: Partial<BinaryResolverDeps> = {}): BinaryResolverDeps {
    return harness({
      spec: CODEX_SPEC,
      version: '0.155.0',
      assets: {
        'test-arch': {
          file: `${TRIPLE}.tar.gz`,
          sha256: ARCHIVE_SHA,
          url: 'https://example.test/codex.tar.gz',
          executable: TRIPLE
        }
      },
      extract: async (_archive, dest) => {
        writeFileSync(join(dest, TRIPLE), '#!/bin/sh\necho codex-cli 0.155.0\n')
      },
      probeVersion: async () => 'codex-cli 0.155.0',
      ...overrides
    })
  }

  it('never uses a codex on PATH at another version: the version under test is the version that runs', async () => {
    // Mutation: flip `CODEX_SPEC.searchPath`, or drop the `acceptsVersion` gate
    // in `pinnedOnPath`, and this returns the PATH copy and downloads nothing.
    const resolved = await resolveEngineBinaryWith(codex({
      which: async () => '/opt/homebrew/bin/codex',
      probeVersion: async (path) => path === '/opt/homebrew/bin/codex' ? 'codex-cli 0.156.0' : 'codex-cli 0.155.0'
    }))
    expect(resolved).toMatchObject({ source: 'managed', version: 'codex-cli 0.155.0' })
    expect(downloads).toHaveLength(1)
  })

  it('reuses a PATH copy that reports exactly the pinned version, and downloads nothing', async () => {
    const resolved = await resolveEngineBinaryWith(codex({ which: async () => '/opt/homebrew/bin/codex' }))
    expect(resolved).toMatchObject({ path: '/opt/homebrew/bin/codex', source: 'path-pinned', version: 'codex-cli 0.155.0' })
    expect(downloads).toEqual([])
    expect(everything()).toEqual([])
  })

  it('prefers a managed copy that is already installed over probing PATH again', async () => {
    await resolveEngineBinaryWith(codex())
    const onPath = vi.fn(async () => '/opt/homebrew/bin/codex')
    const resolved = await resolveEngineBinaryWith(codex({ which: onPath }))
    expect(resolved.source).toBe('managed')
    expect(onPath).not.toHaveBeenCalled()
  })

  it('an explicit path still outranks an exact-version PATH copy', async () => {
    const configured = join(root, 'candidate-codex')
    writeFileSync(configured, '#!/bin/sh\n')
    const onPath = vi.fn(async () => '/opt/homebrew/bin/codex')
    const resolved = await resolveEngineBinaryWith(codex({ configuredPath: () => configured, which: onPath }))
    expect(resolved.source).toBe('configured')
    expect(onPath).not.toHaveBeenCalled()
  })

  it('publishes the archive’s triple-named executable as codex, at one path per version', async () => {
    const deps = codex()
    const resolved = await resolveEngineBinaryWith(deps)
    expect(resolved.path).toBe(join(root, 'codex-0.155.0', 'codex'))
    expect(resolved.path).toBe(managedBinaryPath(deps))
    // The triple name must not survive into the install: the path a launcher
    // is handed cannot depend on which asset row this platform matched.
    expect(readdirSync(join(root, 'codex-0.155.0'))).toEqual(['codex'])
    expect(published()).toEqual(['codex-0.155.0'])
  })

  it('downloads from the URL the pin row names', async () => {
    const urls: string[] = []
    await resolveEngineBinaryWith(
      codex({
        download: async (url, dest) => {
          urls.push(url)
          writeFileSync(dest, ARCHIVE_BYTES)
        }
      })
    )
    expect(urls).toEqual(['https://example.test/codex.tar.gz'])
  })

  it('discards a verified archive whose binary is not the pinned version', async () => {
    // The digest matched, so these are the pinned bytes — and they still
    // reported something else. Publishing them would make "the directory is
    // there" stop meaning "this is the version the contract was run against".
    const attempt = resolveEngineBinaryWith(codex({ probeVersion: async () => 'codex-cli 0.154.0' }))
    await expect(attempt).rejects.toBeInstanceOf(EngineBinaryError)
    await expect(attempt).rejects.toMatchObject({ code: 'version_mismatch' })
    await expect(attempt).rejects.toThrow(/was not version 0\.155\.0/)
    expect(everything()).toEqual([])
  })

  it('reuses a good install without downloading again', async () => {
    await resolveEngineBinaryWith(codex())
    await resolveEngineBinaryWith(codex())
    expect(downloads).toHaveLength(1)
  })

  it('runs a configured path ahead of the managed copy, and does not version-gate it', async () => {
    const configured = join(root, 'candidate-codex')
    writeFileSync(configured, '#!/bin/sh\n')
    chmodSync(configured, 0o755)
    const resolved = await resolveEngineBinaryWith(
      codex({ configuredPath: () => configured, probeVersion: async () => 'codex-cli 0.156.0' })
    )
    // A candidate version is exactly what this override is for; the UI labels
    // it unverified instead of the resolver refusing it.
    expect(resolved).toEqual({ path: configured, source: 'configured', version: 'codex-cli 0.156.0' })
    expect(downloads).toEqual([])
  })

  it('names the Codex path, not the engine path, when the configured file is wrong', async () => {
    await expect(
      resolveEngineBinaryWith(codex({ configuredPath: () => join(root, 'not-there') }))
    ).rejects.toThrow(/^Codex path is not a file — fix it in Local Development\.$/)
    await expect(resolveEngineBinaryWith(codex({ configuredPath: () => join(root, 'not-there') })))
      .rejects.toMatchObject({ pathFieldMessage: 'Codex path is not a file — fix or clear it.' })
    expect(downloads).toEqual([])
  })

  it('points a platform with no pinned build at the Codex path setting', async () => {
    await expect(
      resolveEngineBinaryWith(codex({ platformKey: () => 'win32-x64' }))
    ).rejects.toThrow(/Set a Codex path in Settings.*no verified Codex build for win32-x64/i)
    expect(downloads).toEqual([])
  })

  it('pins POSIX platforms only, each with a URL and an executable name', () => {
    expect(Object.keys(CODEX_ASSETS).sort()).toEqual(['darwin-arm64', 'darwin-x64', 'linux-arm64', 'linux-x64'])
    for (const [key, asset] of Object.entries(CODEX_ASSETS)) {
      expect(asset.url, key).toMatch(/^https:\/\/github\.com\/openai\/codex\/releases\/download\/rust-v/)
      expect(asset.executable, key).toMatch(/^codex-/)
    }
  })

  describe('with downloads switched off (the E2E sandbox)', () => {
    const before = process.env['CINNA_CODEX_DOWNLOAD']
    beforeEach(() => {
      process.env['CINNA_CODEX_DOWNLOAD'] = 'off'
    })
    afterEach(() => {
      if (before === undefined) delete process.env['CINNA_CODEX_DOWNLOAD']
      else process.env['CINNA_CODEX_DOWNLOAD'] = before
    })

    it('refuses with a remedy instead of reaching the network', async () => {
      // The production download dep, so the guard under test is the real one.
      // A spec that forgot to point the Codex path at its scripted CLI must
      // fail here, in words, rather than pull 90 MB and run the real binary.
      const fetchSpy = vi.spyOn(globalThis, 'fetch')
      try {
        const real = realCodexResolverDeps(() => null)
        await expect(
          resolveEngineBinaryWith(codex({ download: real.download }))
        ).rejects.toThrow(/Set a Codex path in Settings.*switched off/i)
        expect(fetchSpy).not.toHaveBeenCalled()
        expect(everything()).toEqual([])
      } finally {
        fetchSpy.mockRestore()
      }
    })
  })
})

/**
 * The same resolver under the Claude spec. What differs from Codex is the asset:
 * **the executable itself, not an archive**, and one larger than the default guard.
 */
describe('resolveEngineBinaryWith — the pinned Claude Code CLI', () => {
  const VERSION_OUTPUT = '2.1.276 (Claude Code)'
  function claude(overrides: Partial<BinaryResolverDeps> = {}): BinaryResolverDeps {
    return harness({
      spec: CLAUDE_SPEC,
      version: '2.1.276',
      assets: { 'test-arch': { file: 'claude', sha256: ARCHIVE_SHA, url: 'https://example.test/claude', format: 'executable', size: 215_643_408 } },
      extract: async () => { throw new Error('an executable asset must never be unpacked') },
      probeVersion: async () => VERSION_OUTPUT,
      ...overrides
    })
  }

  it('publishes the verified file itself as claude, without unpacking anything', async () => {
    // Mutation: drop the `format === 'executable'` branch in `runInstall` and the
    // harness's `extract` throws — tar would have been run on an executable.
    const deps = claude()
    const resolved = await resolveEngineBinaryWith(deps)
    expect(resolved).toEqual({ path: join(root, 'claude-2.1.276', 'claude'), source: 'managed', version: VERSION_OUTPUT })
    expect(resolved.path).toBe(managedBinaryPath(deps))
    expect(readFileSync(resolved.path, 'utf8')).toBe(ARCHIVE_BYTES)
    if (process.platform !== 'win32') expect(statSync(resolved.path).mode & 0o111).not.toBe(0)
    expect(everything()).toEqual(['claude-2.1.276'])
  })

  it('hands the download the asset’s own size as its ceiling — 215 MB is over the default guard', async () => {
    const ceilings: (number | undefined)[] = []
    await resolveEngineBinaryWith(claude({
      download: async (_url, dest, _onProgress, maxBytes) => { ceilings.push(maxBytes); writeFileSync(dest, ARCHIVE_BYTES) }
    }))
    expect(ceilings).toEqual([215_643_408])
  })

  it('discards substituted bytes before they are ever made executable or probed', async () => {
    const probeVersion = vi.fn(async () => VERSION_OUTPUT)
    await expect(resolveEngineBinaryWith(claude({
      probeVersion, download: async (_url, dest) => writeFileSync(dest, 'substituted bytes')
    }))).rejects.toThrow(/checksum/i)
    expect(probeVersion).not.toHaveBeenCalled()
    expect(everything()).toEqual([])
  })

  it('discards verified bytes that report another version', async () => {
    const attempt = resolveEngineBinaryWith(claude({ probeVersion: async () => '2.1.277 (Claude Code)' }))
    await expect(attempt).rejects.toMatchObject({ code: 'version_mismatch' })
    expect(everything()).toEqual([])
  })

  it('reuses the user’s install only at exactly the pinned version, and remembers which file that was', async () => {
    const real = join(root, 'versions-2.1.276')
    writeFileSync(real, 'the vendor installer’s file')
    const link = join(root, 'claude-on-path')
    symlinkSync(real, link)
    const probed: string[] = []
    const resolved = await resolveEngineBinaryWith(claude({
      which: async () => link,
      probeVersion: async (path) => { probed.push(path); return VERSION_OUTPUT }
    }))
    // The file, not the PATH entry: a pooled adapter keeps this path for every
    // later spawn, and the symlink is what the vendor's updater retargets.
    expect(resolved).toMatchObject({ path: real, source: 'path-pinned', version: VERSION_OUTPUT })
    expect(probed).toEqual([real])
    expect(resolved.fingerprint).toBe(await binaryFingerprint(link))
    expect(downloads).toEqual([])

    // The vendor's updater retargets the symlink: same path, another file.
    const next = join(root, 'versions-2.1.277')
    writeFileSync(next, 'a newer release, a different length')
    rmSync(link)
    symlinkSync(next, link)
    expect(await binaryFingerprint(link)).not.toBe(resolved.fingerprint)

    const other = await resolveEngineBinaryWith(claude({
      which: async () => link,
      probeVersion: async (path) => path === next ? '2.1.277 (Claude Code)' : VERSION_OUTPUT
    }))
    expect(other.source).toBe('managed')
    expect(downloads).toHaveLength(1)
  })

  it('the managed Codex CLI answers with the real file behind a PATH symlink too', async () => {
    const real = join(root, 'Cellar-codex-0.155.0')
    writeFileSync(real, 'a package manager’s file')
    const link = join(root, 'codex-on-path')
    symlinkSync(real, link)
    const resolved = await resolveEngineBinaryWith(harness({
      spec: CODEX_SPEC, version: '0.155.0', which: async () => link, probeVersion: async () => 'codex-cli 0.155.0'
    }))
    expect(resolved).toMatchObject({ path: real, source: 'path-pinned' })
    expect((await knownRuntimeBinary(harness({
      spec: CODEX_SPEC, version: '0.155.0', which: async () => link, probeVersion: async () => 'codex-cli 0.155.0'
    }), { probePath: true }))?.path).toBe(real)
  })

  it('logs which binary it chose — tool, source, version, path — once per resolution, whatever the source', async () => {
    const configured = join(root, 'my-claude')
    writeFileSync(configured, '')
    const chosen = (): unknown[] => logInfo.mock.calls.filter(([message]) => message === 'runtime binary resolved').map(([, fields]) => fields)

    await resolveEngineBinaryWith(claude({ configuredPath: () => configured }))
    expect(chosen()).toEqual([{ tool: 'claude', source: 'configured', version: VERSION_OUTPUT, path: configured }])

    logInfo.mockClear()
    const onPath = join(root, 'claude-on-path')
    writeFileSync(onPath, '')
    await resolveEngineBinaryWith(claude({ which: async () => onPath }))
    expect(chosen()).toEqual([{ tool: 'claude', source: 'path-pinned', version: VERSION_OUTPUT, path: onPath }])

    logInfo.mockClear()
    await resolveEngineBinaryWith(claude())
    expect(chosen()).toEqual([{ tool: 'claude', source: 'managed', version: VERSION_OUTPUT, path: join(root, 'claude-2.1.276', 'claude') }])

    // …and OpenCode's PATH copy, the one source only it has.
    logInfo.mockClear()
    await resolveEngineBinaryWith(harness({ which: async () => '/usr/local/bin/opencode' }))
    expect(chosen()).toEqual([{ tool: 'opencode', source: 'path', version: '1.2.3', path: '/usr/local/bin/opencode' }])
  })

  it('says how big this platform’s pinned asset is, and null where no size is recorded', () => {
    expect(pinnedAssetBytes(claude())).toBe(215_643_408)
    expect(pinnedAssetBytes(claude({ platformKey: () => 'plan9-mips' }))).toBeNull()
    expect(pinnedAssetBytes(harness())).toBeNull()
    // The real tables: every Claude and Codex row has one, and they differ by platform.
    for (const assets of [CLAUDE_ASSETS, CODEX_ASSETS]) {
      const sizes = Object.keys(assets).map((key) => pinnedAssetBytes({ assets, platformKey: () => key }))
      expect(sizes.every((size) => typeof size === 'number' && size > 50_000_000)).toBe(true)
      expect(new Set(sizes).size).toBe(sizes.length)
    }
  })

  it('knownRuntimeBinary never downloads, and probes PATH only when asked to', async () => {
    const which = vi.fn(async () => '/Users/x/.local/bin/claude')
    expect(await knownRuntimeBinary(claude({ which }))).toBeNull()
    expect(which).not.toHaveBeenCalled()
    expect(await knownRuntimeBinary(claude({ which }), { probePath: true })).toMatchObject({ source: 'path-pinned' })
    expect(await knownRuntimeBinary(claude({ which, probeVersion: async () => '2.1.200 (Claude Code)' }), { probePath: true })).toBeNull()
    await resolveEngineBinaryWith(claude())
    expect(await knownRuntimeBinary(claude({ which }))).toMatchObject({ source: 'managed', path: join(root, 'claude-2.1.276', 'claude') })
    expect(downloads).toHaveLength(1)
    // A configured path that is not a file is "nothing here", not a fallback to another binary.
    expect(await knownRuntimeBinary(claude({ configuredPath: () => join(root, 'nope') }), { probePath: true })).toBeNull()
  })

  it('names the Claude path when the configured file is wrong, and for a platform with no build', async () => {
    await expect(resolveEngineBinaryWith(claude({ configuredPath: () => join(root, 'not-there') })))
      .rejects.toThrow(/^Claude path is not a file — fix it in Local Development\.$/)
    await expect(resolveEngineBinaryWith(claude({ platformKey: () => 'win32-x64' })))
      .rejects.toThrow(/Set a Claude path in Settings.*no verified Claude Code build for win32-x64/i)
    await expect(resolveEngineBinaryWith(claude({ platformKey: () => 'win32-x64' }))).rejects.toMatchObject({
      pathFieldMessage: 'Set a Claude path: Cinna has no verified Claude Code build for win32-x64.'
    })
    expect(downloads).toEqual([])
  })

  it('pins four POSIX rows, each a single executable from the vendor bucket with its size', () => {
    expect(Object.keys(CLAUDE_ASSETS).sort()).toEqual(['darwin-arm64', 'darwin-x64', 'linux-arm64', 'linux-x64'])
    for (const [key, asset] of Object.entries(CLAUDE_ASSETS)) {
      expect(asset.url, key).toBe(`https://storage.googleapis.com/claude-code-dist-86c565f3-f756-42ad-8dfa-d59b1c096819/claude-code-releases/2.1.276/${key}/claude`)
      expect(asset.format, key).toBe('executable')
      expect(asset.size, key).toBeGreaterThan(200 * 1024 * 1024)
    }
  })

  it('refuses with a remedy instead of reaching the network when downloads are off (the E2E sandbox)', async () => {
    const before = process.env['CINNA_CLAUDE_DOWNLOAD']
    process.env['CINNA_CLAUDE_DOWNLOAD'] = 'off'
    const fetchSpy = vi.spyOn(globalThis, 'fetch')
    try {
      await expect(resolveEngineBinaryWith(claude({ download: realClaudeResolverDeps(() => null).download })))
        .rejects.toThrow(/Set a Claude path in Settings.*switched off/i)
      expect(fetchSpy).not.toHaveBeenCalled()
      expect(everything()).toEqual([])
    } finally {
      fetchSpy.mockRestore()
      if (before === undefined) delete process.env['CINNA_CLAUDE_DOWNLOAD']
      else process.env['CINNA_CLAUDE_DOWNLOAD'] = before
    }
  })
})

describe('sha256File', () => {
  it('hashes the bytes on disk', async () => {
    const path = join(root, 'file')
    writeFileSync(path, ARCHIVE_BYTES)
    expect(await sha256File(path)).toBe(ARCHIVE_SHA)
  })
})

