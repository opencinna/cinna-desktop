import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { linkSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { createPathCanonicalizer } from './canonicalPath'

/**
 * One spelling per file. On macOS `realpath('/System/Volumes/Data/Users/x')`
 * keeps the prefix although it is the same folder as `/Users/x`; the real
 * firmlink cannot be built in a test, so identities are injected, and a hard
 * link stands in for "the same file under two names" on the real disk.
 */

const identities: Record<string, { dev: number; ino: number }> = {
  '/System/Volumes/Data/Users/me': { dev: 1, ino: 10 },
  '/Users/me': { dev: 1, ino: 10 },
  // Same inode number on another device: a different folder.
  '/System/Volumes/Data/opt/tool': { dev: 1, ino: 20 },
  '/opt/tool': { dev: 2, ino: 20 },
  '/System/Volumes/Data': { dev: 1, ino: 2 },
  '/': { dev: 2, ino: 2 }
}

function identity(path: string): { dev: number; ino: number } {
  const found = identities[path]
  if (!found) throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' })
  return found
}

const fake = (platform: NodeJS.Platform = 'darwin') =>
  createPathCanonicalizer({ platform, stat: async (path) => identity(path), statSync: identity })

describe('lexical', () => {
  it('drops the data-volume prefix on darwin without touching the disk', () => {
    const paths = createPathCanonicalizer({
      platform: 'darwin',
      stat: () => Promise.reject(new Error('no disk')),
      statSync: () => {
        throw new Error('no disk')
      }
    })
    expect(paths.lexical('/System/Volumes/Data/Users/me/Documents/a.md')).toBe('/Users/me/Documents/a.md')
    expect(paths.lexical('/System/Volumes/Data')).toBe('/')
    expect(paths.lexical('/System/Volumes/DataX/a.md')).toBe('/System/Volumes/DataX/a.md')
    expect(paths.lexical('/Users/me')).toBe('/Users/me')
  })

  it('changes nothing off darwin', () => {
    expect(fake('linux').lexical('/System/Volumes/Data/Users/me')).toBe('/System/Volumes/Data/Users/me')
  })
})

describe('canonical', () => {
  it.each([
    ['/System/Volumes/Data/Users/me', '/Users/me'],
    ['/Users/me', '/Users/me'],
    ['/System/Volumes/Data/opt/tool', '/System/Volumes/Data/opt/tool'],
    ['/System/Volumes/Data/nowhere', '/System/Volumes/Data/nowhere'],
    ['/System/Volumes/Data', '/System/Volumes/Data']
  ])('%s → %s', async (path, expected) => {
    expect(await fake().canonical(path)).toBe(expected)
    expect(fake().canonicalSync(path)).toBe(expected)
  })

  it('keeps the spelling off darwin even when it is the same file', async () => {
    expect(await fake('linux').canonical('/System/Volumes/Data/Users/me')).toBe('/System/Volumes/Data/Users/me')
    expect(fake('win32').canonicalSync('/System/Volumes/Data/Users/me')).toBe('/System/Volumes/Data/Users/me')
  })
})

describe('realpath on a real file named twice', () => {
  let root: string
  let volume: string
  let file: string

  beforeAll(() => {
    root = realpathSync(mkdtempSync(join(tmpdir(), 'cinna-canonical-')))
    volume = join(root, 'data-volume')
    file = join(root, 'real', 'a.md')
    mkdirSync(dirname(file), { recursive: true })
    writeFileSync(file, 'x')
    mkdirSync(dirname(volume + file), { recursive: true })
    linkSync(file, volume + file)
    writeFileSync(join(root, 'real', 'b.md'), 'x')
    writeFileSync(volume + join(root, 'real', 'b.md'), 'a copy, not the same file')
  })

  afterAll(() => {
    rmSync(root, { recursive: true, force: true })
  })

  it('realpath alone keeps the long spelling; the canonical realpath drops it', async () => {
    const paths = createPathCanonicalizer({ platform: 'darwin', dataVolume: volume })
    expect(realpathSync(volume + file)).toBe(volume + file)
    expect(await paths.realpath(volume + file)).toBe(file)
  })

  it('keeps the spelling when the shorter path is a different file', async () => {
    const paths = createPathCanonicalizer({ platform: 'darwin', dataVolume: volume })
    const copy = volume + join(root, 'real', 'b.md')
    expect(await paths.realpath(copy)).toBe(copy)
  })

  it('rejects like realpath for a missing path', async () => {
    const paths = createPathCanonicalizer({ platform: 'darwin', dataVolume: volume })
    await expect(paths.realpath(join(root, 'missing.md'))).rejects.toThrow()
  })
})
