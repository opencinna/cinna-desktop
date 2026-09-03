import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import {
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  utimesSync,
  writeFileSync
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

// The scoped logger reaches the Electron main window; stub it so these modules
// can be exercised in a plain Node environment.
vi.mock('../logger/logger', () => ({
  createLogger: () => ({ debug: () => {}, info: () => {}, warn: () => {}, error: () => {} })
}))

import { KitError } from '../errors'
import {
  manifestPath,
  readStamp,
  readWithStamp,
  serializeManifest,
  writeIfUnchanged,
  writeManifest
} from './manifestIo'

let dir: string

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'cinna-manifest-'))
})

afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
})

const MANIFEST = {
  contract_version: '1.0.0',
  id: '3f2504e0-4f89-41d3-9a0c-0305e82c3301',
  name: 'Invoice Watcher',
  slug: 'invoice-watcher',
  description: 'Flags invoices that arrive without a purchase-order number.',
  // Keys no build of this app knows about. They must come back untouched.
  future_field: { nested: [1, 2, 3] },
  publications: [{ platform_url: 'https://acme.test', agent_id: 'a1', unknown_stamp: true }]
}

describe('manifestIo', () => {
  it('round-trips unknown keys and formatting', () => {
    const path = manifestPath(dir)
    writeManifest(path, MANIFEST)

    const raw = readFileSync(path, 'utf8')
    expect(raw.endsWith('}\n')).toBe(true)
    expect(raw).toContain('\n  "contract_version": "1.0.0"')

    const { manifest } = readWithStamp(path)
    expect(manifest.future_field).toEqual({ nested: [1, 2, 3] })
    expect(manifest.publications?.[0].unknown_stamp).toBe(true)

    // Rewriting what we read changes nothing on disk.
    const stamp = readWithStamp(path).stamp
    writeIfUnchanged(path, manifest, stamp)
    expect(readFileSync(path, 'utf8')).toBe(raw)
  })

  it('preserves an unknown key through an edit of a known one', () => {
    const path = manifestPath(dir)
    writeManifest(path, MANIFEST)
    const { manifest, stamp } = readWithStamp(path)
    manifest.description = 'Now it also checks totals.'
    writeIfUnchanged(path, manifest, stamp)

    const after = readWithStamp(path).manifest
    expect(after.description).toBe('Now it also checks totals.')
    expect(after.future_field).toEqual({ nested: [1, 2, 3] })
  })

  it('refuses to write over a file that changed underneath', () => {
    const path = manifestPath(dir)
    writeManifest(path, MANIFEST)
    const { manifest, stamp } = readWithStamp(path)

    // Somebody else — an assistant, the agent itself — writes the file.
    writeFileSync(path, serializeManifest({ ...MANIFEST, name: 'Renamed by an assistant' }))

    let error: unknown
    try {
      writeIfUnchanged(path, { ...manifest, name: 'Renamed by the desktop' }, stamp)
    } catch (err) {
      error = err
    }
    expect(error).toBeInstanceOf(KitError)
    expect((error as InstanceType<typeof KitError>).code).toBe('manifest_modified')
    expect(readWithStamp(path).manifest.name).toBe('Renamed by an assistant')
  })

  it('refuses a rewrite that preserved mtime and size — the cp -p / rsync -t case', () => {
    const path = manifestPath(dir)
    writeManifest(path, MANIFEST)
    const { manifest, stamp } = readWithStamp(path)
    const before = statSync(path)

    // Another writer replaces the content with something the *same length* and
    // restores the timestamps, exactly as `cp -p`, `rsync -t`, `git checkout`
    // and several editors do.
    const theirs = serializeManifest({ ...MANIFEST, id: '00000000-0000-4000-8000-000000000000' })
    expect(Buffer.byteLength(theirs)).toBe(before.size)
    writeFileSync(path, theirs)
    utimesSync(path, before.atime, before.mtime)
    const after = statSync(path)
    expect(after.size).toBe(before.size)
    expect(Math.abs(after.mtimeMs - before.mtimeMs)).toBeLessThan(1)

    let error: unknown
    try {
      writeIfUnchanged(path, { ...manifest, description: 'the desktop had stale content' }, stamp)
    } catch (err) {
      error = err
    }
    expect(error).toBeInstanceOf(KitError)
    expect((error as InstanceType<typeof KitError>).code).toBe('manifest_modified')
    // The other writer's content survives, untouched.
    expect(readFileSync(path, 'utf8')).toBe(theirs)
  })

  it('decides on content, not metadata, when the two disagree', () => {
    // The test above restores the timestamps through `utimes`, which on this
    // filesystem lands a fraction of a millisecond off — so the cheap metadata
    // check may be what catches it there. This one removes that luck: the stamp
    // carries the *current* mtime and size and only the earlier content hash,
    // which is what a filesystem with coarser mtime granularity produces
    // naturally. The hash has to be the authority or this write goes through.
    const path = manifestPath(dir)
    writeManifest(path, MANIFEST)
    const mine = readWithStamp(path)

    const theirs = serializeManifest({ ...MANIFEST, id: '00000000-0000-4000-8000-000000000000' })
    writeFileSync(path, theirs)
    const theirStamp = readStamp(path)
    expect(theirStamp).not.toBeNull()

    const metadataIdenticalContentNot = { ...theirStamp!, hash: mine.stamp.hash }
    expect(() =>
      writeIfUnchanged(path, mine.manifest, metadataIdenticalContentNot)
    ).toThrowError(expect.objectContaining({ code: 'manifest_modified' }))
    expect(readFileSync(path, 'utf8')).toBe(theirs)
  })

  it('reports a removed file as modified rather than recreating it', () => {
    const path = manifestPath(dir)
    writeManifest(path, MANIFEST)
    const { manifest, stamp } = readWithStamp(path)
    rmSync(path)
    expect(() => writeIfUnchanged(path, manifest, stamp)).toThrow(KitError)
  })

  it('raises typed errors for a missing or corrupt manifest', () => {
    const path = manifestPath(dir)
    expect(() => readWithStamp(path)).toThrowError(
      expect.objectContaining({ code: 'manifest_not_found' })
    )

    writeFileSync(path, '{ "name": "half a manif')
    expect(() => readWithStamp(path)).toThrowError(
      expect.objectContaining({ code: 'manifest_invalid_json' })
    )

    writeFileSync(path, '[1, 2, 3]')
    expect(() => readWithStamp(path)).toThrowError(
      expect.objectContaining({ code: 'manifest_not_object' })
    )
  })

  it('leaves no temp files behind', () => {
    const path = manifestPath(dir)
    writeManifest(path, MANIFEST)
    writeManifest(path, MANIFEST)
    expect(readdirSync(dir)).toEqual(['cinna-agent.json'])
  })

  it('sweeps an orphan left by a write that was killed mid-flight', () => {
    const path = manifestPath(dir)
    // What a SIGKILL between open() and rename() leaves behind. No catch block
    // can clean this up, so the next write has to.
    const orphan = join(dir, '.cinna-agent.json.4242.1756845000000.tmp')
    writeFileSync(orphan, '{ "half": ')
    const old = Date.now() / 1000 - 3600
    utimesSync(orphan, old, old)

    writeManifest(path, MANIFEST)
    expect(readdirSync(dir)).toEqual(['cinna-agent.json'])
  })

  it('leaves a fresh temp file alone — it may belong to another writer', () => {
    const path = manifestPath(dir)
    const inFlight = join(dir, '.cinna-agent.json.9999.1756845000000.tmp')
    writeFileSync(inFlight, 'someone else is writing')

    writeManifest(path, MANIFEST)
    expect(readdirSync(dir).sort()).toEqual([
      '.cinna-agent.json.9999.1756845000000.tmp',
      'cinna-agent.json'
    ])
  })

  it('sweeps nothing that is not one of its own temp files', () => {
    const path = manifestPath(dir)
    const other = join(dir, 'notes.tmp')
    writeFileSync(other, 'not mine')
    const old = Date.now() / 1000 - 3600
    utimesSync(other, old, old)

    writeManifest(path, MANIFEST)
    expect(readdirSync(dir).sort()).toEqual(['cinna-agent.json', 'notes.tmp'])
  })
})
