import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { createHash } from 'node:crypto'
import { chmodSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  ENGINE_ASSETS,
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

  it('does not download again once it is installed', async () => {
    await resolveEngineBinaryWith(harness())
    expect(downloads).toHaveLength(1)
    await resolveEngineBinaryWith(harness())
    expect(downloads).toHaveLength(1)
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
    ).rejects.toThrow(/no verified opencode build for sunos-sparc/i)
    expect(downloads).toEqual([])
  })
})

describe('sha256File', () => {
  it('hashes the bytes on disk', async () => {
    const path = join(root, 'file')
    writeFileSync(path, ARCHIVE_BYTES)
    expect(await sha256File(path)).toBe(ARCHIVE_SHA)
  })
})

