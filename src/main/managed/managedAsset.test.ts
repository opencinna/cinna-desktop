import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { createHash } from 'node:crypto'
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  findNamedFile,
  installPinnedAsset,
  isFile,
  sha256File,
  sweepStaging,
  type InstallPinnedAssetOptions
} from './managedAsset'

/**
 * Installing a pinned asset.
 *
 * The assertion that carries this file is **"nothing is left behind"**: after a
 * digest mismatch, a failed download or an archive that unpacked to the wrong
 * thing, the root must hold nothing a later run could mistake for a good
 * install. `rejects.toThrow()` on its own is the weak version of that test — it
 * passes while a half-unpacked binary sits at the install path waiting to be
 * executed — so every failure case asserts on the directory contents too.
 *
 * Its counterpart in `../engine/binaryResolver.test.ts` still exercises the
 * same guarantees through the engine's own resolver, which is the point: this
 * file replaces none of that, it covers the shapes the engine never sees
 * (a flat tarball, a lost rename race, a `locate` that finds nothing).
 */

vi.mock('../logger/logger', () => ({
  createLogger: () => ({ debug: () => {}, info: () => {}, warn: () => {}, error: () => {} })
}))

const BYTES = 'pretend this is a release archive'
const SHA = createHash('sha256').update(BYTES).digest('hex')

let root: string
let downloads: string[]

/** Everything in the root, staging directories included. */
function everything(): string[] {
  return readdirSync(root).sort()
}

function options(overrides: Partial<InstallPinnedAssetOptions> = {}): InstallPinnedAssetOptions {
  const installDir = overrides.installDir ?? join(root, 'tool-1.0.0')
  return {
    root,
    installDir,
    label: 'tool',
    archiveName: 'tool.tar.gz',
    url: 'https://example.invalid/tool.tar.gz',
    sha256: SHA,
    locate: (dir) => findNamedFile(dir, 'tool'),
    isInstalled: () => isFile(join(installDir, 'tool')),
    download: async (_url, dest) => {
      downloads.push(dest)
      writeFileSync(dest, BYTES)
    },
    // The flat shape: a tarball whose members sit at the archive root, like
    // Mutagen's (`mutagen` next to `mutagen-agents.tar.gz`).
    extract: async (_archive, dest) => {
      writeFileSync(join(dest, 'tool'), '#!/bin/sh\n')
      writeFileSync(join(dest, 'tool-agents.tar.gz'), 'sidecar')
    },
    ...overrides
  }
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'cinna-managed-'))
  downloads = []
})

afterEach(() => {
  rmSync(root, { recursive: true, force: true })
})

describe('installPinnedAsset — archive shapes', () => {
  it('publishes a flat tar.gz, sidecar files and all', async () => {
    const result = await installPinnedAsset(options())
    expect(result).toEqual({ installed: true })
    expect(everything()).toEqual(['tool-1.0.0'])
    // The whole directory that held the located file is published, not just the
    // file: Mutagen will not run without the agent bundle beside its binary.
    expect(readdirSync(join(root, 'tool-1.0.0')).sort()).toEqual(['tool', 'tool-agents.tar.gz'])
    // The staged archive is never published alongside it.
    expect(readdirSync(join(root, 'tool-1.0.0'))).not.toContain('tool.tar.gz')
  })

  it('publishes a nested tar.gz at the same install path', async () => {
    // uv's shape: `uv-<target>/uv`. The install path must not depend on it.
    await installPinnedAsset(
      options({
        extract: async (_archive, dest) => {
          mkdirSync(join(dest, 'tool-x86_64-unknown-linux-gnu'))
          writeFileSync(join(dest, 'tool-x86_64-unknown-linux-gnu', 'tool'), '#!/bin/sh\n')
        }
      })
    )
    expect(everything()).toEqual(['tool-1.0.0'])
    expect(readFileSync(join(root, 'tool-1.0.0', 'tool'), 'utf8')).toBe('#!/bin/sh\n')
  })

  it('publishes a single-file zip', async () => {
    // The engine's macOS shape: one executable at the archive root.
    await installPinnedAsset(
      options({
        archiveName: 'tool.zip',
        extract: async (_archive, dest) => writeFileSync(join(dest, 'tool'), '#!/bin/sh\n')
      })
    )
    expect(readdirSync(join(root, 'tool-1.0.0'))).toEqual(['tool'])
  })

  it('does not download again once it is installed', async () => {
    await installPinnedAsset(options())
    expect(downloads).toHaveLength(1)
    const second = await installPinnedAsset(options())
    expect(second).toEqual({ installed: false })
    expect(downloads).toHaveLength(1)
  })
})

describe('installPinnedAsset — failures publish nothing', () => {
  it('discards a download whose digest does not match, and never unpacks it', async () => {
    const extract = vi.fn(async () => undefined)
    await expect(
      installPinnedAsset(
        options({
          extract,
          download: async (_url, dest) => writeFileSync(dest, 'substituted bytes')
        })
      )
    ).rejects.toThrow(/checksum/i)
    // Not merely that it threw: no install directory exists for a later run to
    // find and execute, and the bytes were never handed to `tar`.
    expect(everything()).toEqual([])
    expect(extract).not.toHaveBeenCalled()
  })

  it('carries the checksum_mismatch code, because callers branch on it', async () => {
    await expect(
      installPinnedAsset(
        options({ download: async (_url, dest) => writeFileSync(dest, 'substituted bytes') })
      )
    ).rejects.toMatchObject({ code: 'checksum_mismatch' })
  })

  it('leaves nothing behind when locate finds nothing in the archive', async () => {
    await expect(
      installPinnedAsset(
        options({
          extract: async (_archive, dest) => writeFileSync(join(dest, 'README.md'), 'nope'),
          notFoundMessage: 'The downloaded tool archive did not contain a tool executable.'
        })
      )
    ).rejects.toThrow(/did not contain a tool executable/)
    expect(everything()).toEqual([])
  })

  it('leaves nothing behind when the download itself fails', async () => {
    await expect(
      installPinnedAsset(
        options({
          download: async () => {
            throw new Error('network is down')
          }
        })
      )
    ).rejects.toThrow(/network is down/)
    expect(everything()).toEqual([])
  })
})

describe('installPinnedAsset — a lost rename race', () => {
  it('keeps the install the winner published and reports success', async () => {
    const installDir = join(root, 'tool-1.0.0')
    // Simulate the other process publishing while this one was unpacking: the
    // rename then fails because the destination exists and is non-empty.
    const opts = options({
      extract: async (_archive, dest) => {
        mkdirSync(installDir, { recursive: true })
        writeFileSync(join(installDir, 'tool'), 'the winner')
        writeFileSync(join(dest, 'tool'), 'the loser')
      }
    })
    const result = await installPinnedAsset(opts)
    expect(result).toEqual({ installed: false })
    // The winner's bytes passed the same digest check, so they stay.
    expect(readFileSync(join(installDir, 'tool'), 'utf8')).toBe('the winner')
    // And the loser's staging is still cleaned up.
    expect(everything()).toEqual(['tool-1.0.0'])
  })

  it('still throws when the rename fails and no install appeared', async () => {
    // A rename that fails for a reason other than a race — a read-only parent,
    // a cross-device move — must not be swallowed into a fake success.
    await expect(
      installPinnedAsset(
        options({ installDir: join(root, 'no', 'such', 'parent', 'tool-1.0.0') })
      )
    ).rejects.toThrow()
    expect(everything()).toEqual([])
  })
})

describe('sweepStaging', () => {
  it('removes staging leftovers and nothing else', async () => {
    mkdirSync(join(root, '.staging-123-456', 'unpacked'), { recursive: true })
    writeFileSync(join(root, '.staging-123-456', 'archive'), 'junk')
    mkdirSync(join(root, 'tool-1.0.0'))
    writeFileSync(join(root, 'state.json'), '{}')
    await sweepStaging(root)
    expect(everything()).toEqual(['state.json', 'tool-1.0.0'])
  })

  it('is a no-op on a root that does not exist yet', async () => {
    await expect(sweepStaging(join(root, 'absent'))).resolves.toBeUndefined()
  })
})

describe('findNamedFile', () => {
  it('finds a file at the root and one nested inside the depth limit', async () => {
    writeFileSync(join(root, 'flat'), 'x')
    mkdirSync(join(root, 'a', 'b'), { recursive: true })
    writeFileSync(join(root, 'a', 'b', 'deep'), 'x')
    expect(await findNamedFile(root, 'flat')).toBe(join(root, 'flat'))
    expect(await findNamedFile(root, 'deep')).toBe(join(root, 'a', 'b', 'deep'))
  })

  it('refuses to look past the depth it was given', async () => {
    mkdirSync(join(root, 'a', 'b', 'c'), { recursive: true })
    writeFileSync(join(root, 'a', 'b', 'c', 'buried'), 'x')
    expect(await findNamedFile(root, 'buried', 2)).toBeNull()
  })

  it('returns null rather than a directory of the same name', async () => {
    mkdirSync(join(root, 'tool'))
    expect(await findNamedFile(root, 'tool')).toBeNull()
  })
})

describe('sha256File', () => {
  it('hashes the bytes on disk', async () => {
    const path = join(root, 'file')
    writeFileSync(path, BYTES)
    expect(await sha256File(path)).toBe(SHA)
  })
})
