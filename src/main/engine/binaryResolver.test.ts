import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { createHash } from 'node:crypto'
import { chmodSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  CODEX_ASSETS,
  CODEX_SPEC,
  ENGINE_ASSETS,
  EngineBinaryError,
  managedBinaryPath,
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
vi.mock('../logger/logger', () => ({
  createLogger: () => ({ debug: () => {}, info: () => {}, warn: () => {}, error: () => {} })
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

/** Everything in the engine root, staging included. */
function everything(): string[] {
  return readdirSync(root).sort()
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'cinna-engine-'))
  downloads = []
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
    ).rejects.toThrow(/does not point at a file/i)
    expect(downloads).toEqual([])

    const dud = join(root, 'dud')
    writeFileSync(dud, 'x')
    await expect(
      resolveEngineBinaryWith(
        harness({ configuredPath: () => dud, probeVersion: async () => null })
      )
    ).rejects.toThrow(/will not run/i)
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
    }
    writeFileSync(join(root, 'opencode.json'), '{}')
    await resolveEngineBinaryWith(harness())
    // Its own old versions and the dead staging go; another tool's install, a
    // directory that merely shares the prefix, and the root's own files stay.
    expect(everything()).toEqual(['codex-0.1.0', 'opencode-9.9.9', 'opencode-notes', 'opencode.json', 'prompts'])
  })

  it('sweeps nothing when the install is already there, or when the install fails', async () => {
    await resolveEngineBinaryWith(harness())
    mkdirSync(join(root, 'opencode-1.0.0'))
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

  it('never uses a codex on PATH: the version under test is the version that runs', async () => {
    // Mutation: flip `CODEX_SPEC.searchPath` and this returns the PATH copy
    // with `source: 'path'` and downloads nothing.
    const onPath = vi.fn(async () => '/opt/homebrew/bin/codex')
    const resolved = await resolveEngineBinaryWith(codex({ which: onPath }))
    expect(onPath).not.toHaveBeenCalled()
    expect(resolved).toMatchObject({ source: 'managed', version: 'codex-cli 0.155.0' })
    expect(downloads).toHaveLength(1)
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
    ).rejects.toThrow(/Fix the Codex path in Settings.*does not point at a file/i)
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

describe('sha256File', () => {
  it('hashes the bytes on disk', async () => {
    const path = join(root, 'file')
    writeFileSync(path, ARCHIVE_BYTES)
    expect(await sha256File(path)).toBe(ARCHIVE_SHA)
  })
})

