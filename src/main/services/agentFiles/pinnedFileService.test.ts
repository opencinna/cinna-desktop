import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdirSync, mkdtempSync, realpathSync, renameSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { createTestDatabase, type TestDatabase } from '../../db/testSupport/nodeSqlite'

vi.mock('../../logger/logger', () => ({
  createLogger: () => ({ debug: () => {}, info: () => {}, warn: () => {}, error: () => {} })
}))

const holder = vi.hoisted(() => ({ current: null as TestDatabase | null }))
vi.mock('../../db/client', () => ({
  getDb: () => holder.current!.db,
  getRawSqlite: () => holder.current!.sqlite
}))

const { createPinnedFileService } = await import('./pinnedFileService')
const { agentPinnedFileRepo } = await import('../../db/agents')
const { LocalAgentError } = await import('../../errors')

/**
 * Pinned files through the service and the real repo on a real database: what
 * is stored for a file inside and outside the agent folder, how a pin resolves
 * once the folder has moved or the file has gone, and what is refused.
 */

const AGENT = 'folder:a'
let root: string
let agentDir: string
let outside: string
let profile: string
let guarded: Set<string>

function write(path: string, contents = 'hello'): void {
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, contents)
}

function service() {
  return createPinnedFileService({
    locateAgent: (agentId) => {
      if (agentId !== AGENT) throw new LocalAgentError('not_found', 'That is not a local agent.')
      return agentDir
    },
    getUserId: () => profile,
    store: agentPinnedFileRepo,
    isGuardedLocation: (path) => [...guarded].some((dir) => path === dir || path.startsWith(dir + '/')),
    platform: process.platform,
    home: join(root, 'home')
  })
}

function storedRows(): Array<{ user_id: string; agent_id: string; path: string; inside: number }> {
  return holder.current!.raw
    .prepare('SELECT user_id, agent_id, path, inside FROM agent_pinned_files ORDER BY rank')
    .all() as never
}

async function pins() {
  const result = await service().list({ agentId: AGENT })
  if (!result.success) throw new Error(result.error)
  return result.pins
}

beforeEach(() => {
  holder.current = createTestDatabase()
  root = realpathSync(mkdtempSync(join(tmpdir(), 'cinna-pinned-files-')))
  agentDir = join(root, 'agent')
  outside = join(root, 'outside')
  profile = 'alice'
  guarded = new Set()
  write(join(agentDir, 'docs/plan.md'))
  write(join(agentDir, 'main.py'))
  write(join(outside, 'notes.md'))
  mkdirSync(join(agentDir, 'data'))
})

afterEach(() => {
  holder.current?.close()
  holder.current = null
  rmSync(root, { recursive: true, force: true })
})

describe('set', () => {
  it('pins a file inside the folder relative to it, and unpins it when asked', async () => {
    const path = join(agentDir, 'docs/plan.md')
    expect(await service().set({ agentId: AGENT, pinned: true, path })).toEqual({ success: true, pinned: true })
    expect(storedRows()).toEqual([{ user_id: 'alice', agent_id: AGENT, path: 'docs/plan.md', inside: 1 }])
    expect(await pins()).toEqual([{ path, displayPath: 'docs/plan.md', inside: true, rank: 1, exists: true }])

    expect(await service().set({ agentId: AGENT, pinned: false, path })).toEqual({ success: true, pinned: false })
    expect(storedRows()).toEqual([])
    expect(await pins()).toEqual([])
  })

  it('pins a file outside the folder by its absolute path', async () => {
    const path = join(outside, 'notes.md')
    expect(await service().set({ agentId: AGENT, pinned: true, path })).toEqual({ success: true, pinned: true })
    expect(storedRows()).toEqual([{ user_id: 'alice', agent_id: AGENT, path, inside: 0 }])
    const [pin] = await pins()
    expect(pin).toMatchObject({ path, inside: false, exists: true })
  })

  it('stores the realpath: a symlink into the folder is pinned as its target', async () => {
    const link = join(root, 'shortcut.md')
    symlinkSync(join(agentDir, 'main.py'), link)
    expect(await service().set({ agentId: AGENT, pinned: true, path: link })).toEqual({ success: true, pinned: true })
    expect(storedRows()).toEqual([{ user_id: 'alice', agent_id: AGENT, path: 'main.py', inside: 1 }])
  })

  it('appends new pins at the bottom', async () => {
    await service().set({ agentId: AGENT, pinned: true, path: join(agentDir, 'main.py') })
    await service().set({ agentId: AGENT, pinned: true, path: join(outside, 'notes.md') })
    await service().set({ agentId: AGENT, pinned: true, path: join(agentDir, 'docs/plan.md') })
    expect((await pins()).map((pin) => pin.displayPath)).toEqual(['main.py', expect.stringContaining('notes.md'), 'docs/plan.md'])
  })

  it('refuses a folder and stores nothing', async () => {
    const result = await service().set({ agentId: AGENT, pinned: true, path: join(agentDir, 'data') })
    expect(result).toMatchObject({ success: false, code: 'not_a_file' })
    expect(storedRows()).toEqual([])
  })

  it('refuses a file that is not there', async () => {
    const result = await service().set({ agentId: AGENT, pinned: true, path: join(agentDir, 'nope.md') })
    expect(result).toMatchObject({ success: false, code: 'not_found' })
    expect(storedRows()).toEqual([])
  })

  it('refuses an agent that is not a folder agent, as data', async () => {
    const result = await service().set({ agentId: 'remote-1', pinned: true, path: join(agentDir, 'main.py') })
    expect(result).toMatchObject({ success: false, code: 'agent_not_found', error: 'That is not a local agent.' })
    expect(storedRows()).toEqual([])
  })

  it('refuses a malformed request', async () => {
    for (const input of [null, {}, { agentId: AGENT }, { agentId: AGENT, path: 'relative.md', pinned: true }, { agentId: '', path: join(agentDir, 'main.py'), pinned: true }, { agentId: AGENT, path: join(agentDir, 'main.py') }, { agentId: AGENT, path: join(agentDir, 'main.py'), pinned: 'yes' }]) {
      expect(await service().set(input)).toMatchObject({ success: false })
    }
    expect(storedRows()).toEqual([])
  })

  it('unpins a file that has gone, without touching the disk', async () => {
    const path = join(agentDir, 'main.py')
    await service().set({ agentId: AGENT, pinned: true, path })
    unlinkSync(path)
    expect(await service().set({ agentId: AGENT, pinned: false, path })).toEqual({ success: true, pinned: false })
    expect(storedRows()).toEqual([])
  })

  it('pinning twice is a no-op: one row, same place', async () => {
    const path = join(agentDir, 'main.py')
    await service().set({ agentId: AGENT, pinned: true, path })
    await service().set({ agentId: AGENT, pinned: true, path: join(agentDir, 'docs/plan.md') })
    expect(await service().set({ agentId: AGENT, pinned: true, path })).toEqual({ success: true, pinned: true })
    expect(storedRows().map((row) => row.path)).toEqual(['main.py', 'docs/plan.md'])
  })

  it('keeps a pin when it is pinned again through a symlinked agent folder', async () => {
    const path = join(agentDir, 'main.py')
    await service().set({ agentId: AGENT, pinned: true, path })
    const alias = join(root, 'alias')
    symlinkSync(agentDir, alias)
    expect(await service().set({ agentId: AGENT, pinned: true, path: join(alias, 'main.py') })).toEqual({ success: true, pinned: true })
    expect(storedRows()).toEqual([{ user_id: 'alice', agent_id: AGENT, path: 'main.py', inside: 1 }])
  })

  it('unpins through a symlinked agent folder spelling', async () => {
    await service().set({ agentId: AGENT, pinned: true, path: join(agentDir, 'main.py') })
    const alias = join(root, 'alias')
    symlinkSync(agentDir, alias)
    expect(await service().set({ agentId: AGENT, pinned: false, path: join(alias, 'main.py') })).toEqual({ success: true, pinned: false })
    expect(storedRows()).toEqual([])
  })

  it('unpinning a file that is not pinned is a no-op', async () => {
    await service().set({ agentId: AGENT, pinned: true, path: join(agentDir, 'main.py') })
    expect(await service().set({ agentId: AGENT, pinned: false, path: join(agentDir, 'docs/plan.md') })).toEqual({ success: true, pinned: false })
    expect(storedRows().map((row) => row.path)).toEqual(['main.py'])
  })

  it('keeps each profile’s pins to itself', async () => {
    await service().set({ agentId: AGENT, pinned: true, path: join(agentDir, 'main.py') })
    profile = 'bob'
    expect(await pins()).toEqual([])
    await service().set({ agentId: AGENT, pinned: true, path: join(agentDir, 'docs/plan.md') })
    expect((await pins()).map((pin) => pin.displayPath)).toEqual(['docs/plan.md'])
    profile = 'alice'
    expect((await pins()).map((pin) => pin.displayPath)).toEqual(['main.py'])
  })
})

describe('list', () => {
  it('resolves an inside pin against the folder where it is now', async () => {
    await service().set({ agentId: AGENT, pinned: true, path: join(agentDir, 'docs/plan.md') })
    const moved = join(root, 'moved-agent')
    renameSync(agentDir, moved)
    agentDir = moved
    expect(await pins()).toEqual([
      { path: join(moved, 'docs/plan.md'), displayPath: 'docs/plan.md', inside: true, rank: 1, exists: true }
    ])
  })

  it('keeps a pin whose file has gone, as missing', async () => {
    await service().set({ agentId: AGENT, pinned: true, path: join(agentDir, 'main.py') })
    await service().set({ agentId: AGENT, pinned: true, path: join(outside, 'notes.md') })
    unlinkSync(join(agentDir, 'main.py'))
    rmSync(outside, { recursive: true })
    expect((await pins()).map((pin) => [pin.displayPath.split('/').pop(), pin.exists])).toEqual([
      ['main.py', false],
      ['notes.md', false]
    ])
  })

  it('reports a pin that became a folder as missing', async () => {
    await service().set({ agentId: AGENT, pinned: true, path: join(agentDir, 'main.py') })
    unlinkSync(join(agentDir, 'main.py'))
    mkdirSync(join(agentDir, 'main.py'))
    expect((await pins())[0].exists).toBe(false)
  })

  it('never probes a pin behind a privacy-guarded folder, and shows it as present', async () => {
    await service().set({ agentId: AGENT, pinned: true, path: join(outside, 'notes.md') })
    rmSync(outside, { recursive: true })
    guarded.add(outside)
    expect((await pins())[0]).toMatchObject({ path: join(outside, 'notes.md'), exists: true })
  })

  it('refuses an unknown agent as data', async () => {
    expect(await service().list({ agentId: 'folder:gone' })).toMatchObject({ success: false, code: 'agent_not_found' })
  })
})

describe('move', () => {
  it('reorders by rank', async () => {
    const [a, b, c] = ['main.py', 'docs/plan.md', 'data/x.md'].map((name) => join(agentDir, name))
    write(c)
    for (const path of [a, b, c]) await service().set({ agentId: AGENT, pinned: true, path })
    expect(await service().move({ agentId: AGENT, path: c, rank: 0.5 })).toEqual({ success: true })
    expect((await pins()).map((pin) => pin.displayPath)).toEqual(['data/x.md', 'main.py', 'docs/plan.md'])
  })

  it('refuses a path that is not pinned and a rank that is not a number', async () => {
    const path = join(agentDir, 'main.py')
    expect(await service().move({ agentId: AGENT, path, rank: 2 })).toMatchObject({ success: false, code: 'not_found' })
    await service().set({ agentId: AGENT, pinned: true, path })
    for (const rank of [Number.NaN, Number.POSITIVE_INFINITY, '2', null]) {
      expect(await service().move({ agentId: AGENT, path, rank })).toMatchObject({ success: false, code: 'invalid_input' })
    }
    expect((await pins())[0].rank).toBe(1)
  })
})
