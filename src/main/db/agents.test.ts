import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { createTestDatabase, type TestDatabase } from './testSupport/nodeSqlite'
import type { RemoteAgentMetadata } from '../../shared/agentMetadata'

/**
 * `agentRepo.replaceFolderIndex` is the one write that can *delete* a user's
 * agents, so it is tested against a real database with the real migrations
 * applied — see `testSupport/nodeSqlite.ts` for why that is not
 * `better-sqlite3`.
 */

const holder = vi.hoisted(() => ({ current: null as TestDatabase | null }))

vi.mock('./client', () => ({
  getDb: () => {
    if (!holder.current) throw new Error('test database not initialised')
    return holder.current.db
  },
  getRawSqlite: () => {
    if (!holder.current) throw new Error('test database not initialised')
    return holder.current.sqlite
  }
}))

const { agentRepo } = await import('./agents')
type FolderIndexEntry = Parameters<typeof agentRepo.replaceFolderIndex>[2][number]

const USER = '__default__'

/**
 * `remoteMetadata` is per-entry rather than a shared constant on purpose: it is
 * synthesized from each folder's own manifest, so a fixture that gave every
 * entry the same object could not fail a test about the right one reaching the
 * right row. The example prompt names the agent it came from.
 */
function meta(id: string): RemoteAgentMetadata {
  return {
    entrypoint_prompt: null,
    example_prompts: [`ask ${id} something`],
    session_mode: null,
    ui_color_preset: null,
    protocol_versions: []
  }
}

function entry(id: string, name = id): FolderIndexEntry {
  return { id, name, description: null, localPath: `/w/Local/${id}`, remoteMetadata: meta(id) }
}

function ids(rows: Array<{ id: string }>): string[] {
  return rows.map((r) => r.id).sort()
}

beforeEach(() => {
  holder.current = createTestDatabase()
})

afterEach(() => {
  holder.current?.close()
  holder.current = null
})

describe('replaceFolderIndex', () => {
  it('inserts the scanned folders', () => {
    const result = agentRepo.replaceFolderIndex(USER, 'r1', [
      entry('folder:a', 'Alpha'),
      entry('folder:b', 'Beta')
    ])
    expect(result).toEqual({ indexed: 2, pruned: 0 })

    const rows = agentRepo.listFolder(USER)
    expect(ids(rows)).toEqual(['folder:a', 'folder:b'])
    const alpha = rows.find((r) => r.id === 'folder:a')
    expect(alpha?.name).toBe('Alpha')
    expect(alpha?.source).toBe('folder')
    expect(alpha?.localRootId).toBe('r1')
    expect(alpha?.localPath).toBe('/w/Local/folder:a')
    // Enabled, like any other newly-added agent. `enabled` is the user's toggle
    // and nothing else. While no runner could serve a folder agent, that gap was
    // expressed by a separate predicate at the pickers rather than by this
    // column — otherwise "the user turned it off" and "it predates the runner"
    // would have been the same value, and nothing could safely have turned them
    // back on. The runner landed, the predicate is gone, and this column still
    // means only what it always meant.
    expect(alpha?.enabled).toBe(true)
  })

  it('leaves the user’s toggle alone in both directions across a rescan', () => {
    agentRepo.replaceFolderIndex(USER, 'r1', [entry('folder:a')])
    agentRepo.update(USER, 'folder:a', { enabled: false })

    agentRepo.replaceFolderIndex(USER, 'r1', [entry('folder:a')])
    expect(agentRepo.getOwned(USER, 'folder:a')?.enabled).toBe(false)

    agentRepo.update(USER, 'folder:a', { enabled: true })
    agentRepo.replaceFolderIndex(USER, 'r1', [entry('folder:a')])
    expect(agentRepo.getOwned(USER, 'folder:a')?.enabled).toBe(true)
  })

  it('prunes the rows whose folders are gone, and only those', () => {
    agentRepo.replaceFolderIndex(USER, 'r1', [entry('folder:a'), entry('folder:b')])
    const result = agentRepo.replaceFolderIndex(USER, 'r1', [entry('folder:a')])

    expect(result).toEqual({ indexed: 1, pruned: 1 })
    expect(ids(agentRepo.listFolder(USER))).toEqual(['folder:a'])
  })

  it('updates a folder in place instead of re-creating it', () => {
    agentRepo.replaceFolderIndex(USER, 'r1', [entry('folder:a', 'Alpha')])
    const created = agentRepo.getOwned(USER, 'folder:a')?.createdAt

    agentRepo.replaceFolderIndex(USER, 'r1', [
      {
        id: 'folder:a',
        name: 'Renamed',
        description: 'now described',
        localPath: '/w/Local/a2',
        remoteMetadata: meta('folder:a-rescanned')
      }
    ])

    const row = agentRepo.getOwned(USER, 'folder:a')
    expect(row?.name).toBe('Renamed')
    expect(row?.description).toBe('now described')
    expect(row?.localPath).toBe('/w/Local/a2')
    // Same row: the id is the manifest's, so chats stay attached across a rename.
    expect(row?.createdAt).toEqual(created)
  })

  it('never overwrites the user’s enabled toggle', () => {
    agentRepo.replaceFolderIndex(USER, 'r1', [entry('folder:a')])
    agentRepo.update(USER, 'folder:a', { enabled: false })

    agentRepo.replaceFolderIndex(USER, 'r1', [entry('folder:a')])
    expect(agentRepo.getOwned(USER, 'folder:a')?.enabled).toBe(false)
  })

  it('scopes pruning to one root, so a folder moved between roots survives', () => {
    agentRepo.replaceFolderIndex(USER, 'r1', [entry('folder:a')])
    // The folder now scans under r2 — the upsert repoints it…
    agentRepo.replaceFolderIndex(USER, 'r2', [entry('folder:a')])
    expect(agentRepo.getOwned(USER, 'folder:a')?.localRootId).toBe('r2')

    // …and r1's next scan, which no longer sees it, must not delete it.
    const result = agentRepo.replaceFolderIndex(USER, 'r1', [])
    expect(result).toEqual({ indexed: 0, pruned: 0 })
    expect(ids(agentRepo.listFolder(USER))).toEqual(['folder:a'])
  })

  it('holds back a row whose folder is on disk but unreadable', () => {
    agentRepo.replaceFolderIndex(USER, 'r1', [entry('folder:a'), entry('folder:b')])

    // `folder:a`'s manifest stopped parsing, so the scan cannot name it — but
    // its folder is still there. Pruning would cascade its sessions away.
    const result = agentRepo.replaceFolderIndex(USER, 'r1', [entry('folder:b')], [
      '/w/Local/folder:a'
    ])

    expect(result).toEqual({ indexed: 1, pruned: 0 })
    expect(ids(agentRepo.listFolder(USER))).toEqual(['folder:a', 'folder:b'])
  })

  it('still prunes when the protected path is not the one that vanished', () => {
    agentRepo.replaceFolderIndex(USER, 'r1', [entry('folder:a'), entry('folder:b')])

    // `folder:a` unreadable, `folder:b` deleted from disk, one pass.
    const result = agentRepo.replaceFolderIndex(USER, 'r1', [], ['/w/Local/folder:a'])

    expect(result).toEqual({ indexed: 0, pruned: 1 })
    expect(ids(agentRepo.listFolder(USER))).toEqual(['folder:a'])
  })

  it('leaves A2A and remote agents alone', () => {
    const local = agentRepo.create(USER, { name: 'A2A', protocol: 'a2a', cardUrl: 'https://x/y' })
    agentRepo.replaceFolderIndex(USER, 'r1', [entry('folder:a')])
    agentRepo.replaceFolderIndex(USER, 'r1', [])

    expect(agentRepo.getOwned(USER, local.id)).toBeDefined()
    expect(agentRepo.listFolder(USER)).toEqual([])
  })

  it('does not reach across users', () => {
    agentRepo.replaceFolderIndex(USER, 'r1', [entry('folder:a')])
    const result = agentRepo.replaceFolderIndex('someone-else', 'r1', [])

    expect(result).toEqual({ indexed: 0, pruned: 0 })
    expect(ids(agentRepo.listFolder(USER))).toEqual(['folder:a'])
  })

  it('rolls the whole rescan back when one write fails', () => {
    agentRepo.replaceFolderIndex(USER, 'r1', [entry('folder:a'), entry('folder:b')])
    expect(() =>
      agentRepo.replaceFolderIndex(USER, 'r1', [
        entry('folder:a'),
        // `name` is NOT NULL — this insert throws mid-transaction.
        {
          id: 'folder:c',
          name: null as unknown as string,
          description: null,
          localPath: '/w/c',
          remoteMetadata: meta('folder:c')
        }
      ])
    ).toThrow()

    // `folder:b` is still there: nothing was pruned, nothing was inserted.
    expect(ids(agentRepo.listFolder(USER))).toEqual(['folder:a', 'folder:b'])
  })
})

describe('pruneFolderIndexForRoot', () => {
  it('drops every folder row of one root', () => {
    agentRepo.replaceFolderIndex(USER, 'r1', [entry('folder:a'), entry('folder:b')])
    agentRepo.replaceFolderIndex(USER, 'r2', [entry('folder:c')])

    expect(agentRepo.pruneFolderIndexForRoot(USER, 'r1')).toBe(2)
    expect(ids(agentRepo.listFolder(USER))).toEqual(['folder:c'])
  })
})

/**
 * The folder row's `remoteMetadata` is synthesized from the folder's manifest
 * and is a cache over it, in the same sense `name` and `description` are. What
 * matters is that **all three** writers refresh it, because the one that is
 * easiest to miss is the one that matters most: a rescan takes the *update*
 * branch, and the single-folder path is the watcher, which is what fires when
 * someone edits `cinna-agent.json` — precisely when these values change.
 */
describe('the synthesized manifest metadata on a folder row', () => {
  it('lands on a newly indexed folder', () => {
    agentRepo.replaceFolderIndex(USER, 'r1', [entry('folder:a')])
    expect(agentRepo.getOwned(USER, 'folder:a')?.remoteMetadata).toEqual(meta('folder:a'))
  })

  it('is refreshed by a rescan, which takes the update branch', () => {
    // The trap: writing it only on insert leaves every pre-existing folder row
    // without one forever, because a rescan never inserts again.
    agentRepo.replaceFolderIndex(USER, 'r1', [entry('folder:a')])
    agentRepo.replaceFolderIndex(USER, 'r1', [
      { ...entry('folder:a'), remoteMetadata: meta('edited') }
    ])
    expect(agentRepo.getOwned(USER, 'folder:a')?.remoteMetadata).toEqual(meta('edited'))
  })

  it('is refreshed by the single-folder update, which is the watcher path', () => {
    agentRepo.replaceFolderIndex(USER, 'r1', [entry('folder:a')])
    agentRepo.updateFolderIndex(USER, { ...entry('folder:a'), remoteMetadata: meta('edited') }, 'r1')
    expect(agentRepo.getOwned(USER, 'folder:a')?.remoteMetadata).toEqual(meta('edited'))
  })

  it('follows the row through a rekey, without being listed anywhere', () => {
    // `rekeyFolderRow` is a whole-row spread rather than a field list, so it
    // carries any column added later for free. Asserted rather than assumed —
    // it is the one folder-row writer this change did not have to touch, and a
    // future edit to a field list there would be silent.
    agentRepo.replaceFolderIndex(USER, 'r1', [entry('folder:legacy:r1:a')])
    agentRepo.rekeyFolderRow(USER, 'folder:legacy:r1:a', 'folder:stamped-uuid')
    expect(agentRepo.getOwned(USER, 'folder:stamped-uuid')?.remoteMetadata).toEqual(
      meta('folder:legacy:r1:a')
    )
  })

  it('gives two folders their own metadata rather than one shared object', () => {
    agentRepo.replaceFolderIndex(USER, 'r1', [entry('folder:a'), entry('folder:b')])
    expect(agentRepo.getOwned(USER, 'folder:a')?.remoteMetadata).toEqual(meta('folder:a'))
    expect(agentRepo.getOwned(USER, 'folder:b')?.remoteMetadata).toEqual(meta('folder:b'))
  })
})
