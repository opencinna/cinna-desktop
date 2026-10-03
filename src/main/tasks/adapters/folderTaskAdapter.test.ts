import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, renameSync, rmSync, symlinkSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createFolderTaskAdapter, type FolderAgentRef, type FolderFs } from './folderTaskAdapter'
import { folderTaskFs } from './folderTaskFs'
import { RemoteTaskError, type RemoteBinding, type RemoteTaskAdapter, type RemoteTaskSnapshot } from './adapter'
import type { TaskDto } from '../../../shared/tasks'

vi.mock('../../logger/logger', () => ({
  createLogger: () => ({ debug: () => {}, info: () => {}, warn: () => {}, error: () => {} })
}))

/**
 * The `folder` adapter against a real temp directory — the behaviour the
 * contract suite does not reach: the stamp cache, own-write recognition, the
 * field merge, the status word, renames, and the refusals that keep a project
 * folder from pointing Cinna's writes elsewhere.
 */

const USER = 'profile-1'
let root: string
let agent: FolderAgentRef
let agents: FolderAgentRef[]
let reads: string[]
let adapter: RemoteTaskAdapter
let tasksDir: string
/** What the profile stored for each binding — the sync service's job in production. */
let stored: Map<string, Record<string, unknown>>
let fs: FolderFs
/** The adapter's clock: the absence grace is measured on it. */
let clock: number

function makeAdapter(): RemoteTaskAdapter {
  let counter = 0
  return createFolderTaskAdapter({
    agents: async () => agents,
    states: async () => new Map(stored),
    fs,
    randomBytes: (size) => new Uint8Array(size).fill(counter++),
    now: () => clock
  })
}

/** Store a binding as the sync service would after a push or a create. */
function remember(binding: RemoteBinding): RemoteBinding {
  stored.set(binding.id, binding.state)
  return binding
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'cinna-folder-tasks-'))
  agent = { id: 'folder:external:r1:.', name: 'Uploader', path: root }
  agents = [agent]
  reads = []
  tasksDir = join(root, '.cinna', 'tasks')
  stored = new Map()
  clock = 1_000_000
  fs = {
    ...folderTaskFs,
    read: (path) => {
      reads.push(path)
      return folderTaskFs.read(path)
    }
  }
  adapter = makeAdapter()
})
afterEach(() => rmSync(root, { recursive: true, force: true }))

function put(name: string, text: string): string {
  mkdirSync(tasksDir, { recursive: true })
  const path = join(tasksDir, name)
  writeFileSync(path, text)
  return path
}

/** A write in the same millisecond keeps mtime; push it forward so the stamp moves for sure. */
function touchLater(path: string): void {
  const later = new Date(Date.now() + 5_000)
  utimesSync(path, later, later)
}

async function only(): Promise<RemoteTaskSnapshot> {
  const list = await adapter.list(USER, null)
  expect(list).toHaveLength(1)
  return list[0]
}

function task(overrides: Partial<TaskDto> = {}): TaskDto {
  const now = new Date()
  return {
    id: 'tsk_1', title: 'Fix the login bug', goal: 'Fix the login bug', description: 'It rejects valid passwords.',
    status: 'new', priority: 'normal', router: 'direct', origin: 'local', executor: 'desktop', executorDevice: null,
    runsHere: true, chatId: null, assignee: { kind: 'agent', agentId: agent.id, name: agent.name }, parentTaskId: null,
    subtaskCount: 0, subtaskCompletedCount: 0, remote: null, handoffNote: null, artifacts: [], budget: null,
    errorMessage: null, customFields: null, statusLabel: null, file: null, fromOutside: false, jobId: null, jobRunId: null,
    createdAt: now, updatedAt: now, startedAt: null, finishedAt: null, ...overrides
  }
}

const NESTED = '---\nid: t-1\ntitle: Fix login\nstatus: doing\npriority: High\nestimate: 3\nmeta:\n  owner: sam\nparent: t-0\nblocked_by: [t-9]\n---\nBody.\n'

describe('pull', () => {
  it('maps a file into a snapshot: canonical status, its own word, the folder agent, custom fields and the file', async () => {
    const path = put('fix-login.md', NESTED)
    const snapshot = await only()
    expect(snapshot).toMatchObject({
      binding: { adapter: 'folder', id: `${agent.id}:t-1`, key: 't-1', url: null },
      title: 'Fix login',
      description: 'Body.',
      status: 'in_progress',
      statusLabel: 'doing',
      priority: 'high',
      assignee: { ref: agent.id, name: 'Uploader', kind: 'agent' },
      parentId: `${agent.id}:t-0`,
      customFields: { estimate: 3, meta: 'owner: sam' },
      file: { path, ours: false, readOnlyFields: ['meta'], blockedBy: ['t-9'] }
    })
    expect(snapshot.file?.digest).toMatch(/^[0-9a-f]{64}$/)
  })

  it('counts the subtasks in the same folder, and the completed ones by the folder’s words', async () => {
    put('_board.yaml', 'Shipped: done\n')
    put('p.md', '---\nid: t-p\ntitle: Parent\nstatus: todo\n---\n')
    put('c1.md', '---\nid: t-c1\ntitle: One\nstatus: Shipped\nparent: t-p\n---\n')
    put('c2.md', '---\nid: t-c2\ntitle: Two\nstatus: doing\nparent: t-p\n---\n')
    put('c3.md', '---\nid: t-c3\ntitle: Three\nstatus: cancelled\nparent: t-p\n---\n')
    put('o.md', '---\nid: t-o\ntitle: Other\nstatus: Shipped\n---\n')
    const list = await adapter.list(USER, null)
    const byKey = new Map(list.map((snapshot) => [snapshot.binding.key, snapshot]))
    expect(byKey.get('t-p')).toMatchObject({ subtaskCount: 3, subtaskCompletedCount: 1 })
    expect(byKey.get('t-o')).toMatchObject({ subtaskCount: 0, subtaskCompletedCount: 0 })
    expect(await adapter.fetch(USER, byKey.get('t-p')!.binding)).toMatchObject({ subtaskCount: 3, subtaskCompletedCount: 1 })
  })

  it('reads a file again only when its stamp moved', async () => {
    const path = put('a.md', '---\ntitle: A\n---\n')
    put('b.md', '---\ntitle: B\n---\n')
    await adapter.list(USER, null)
    expect(reads).toHaveLength(2)
    await adapter.list(USER, null)
    expect(reads).toHaveLength(2)
    writeFileSync(path, '---\ntitle: A2\n---\n')
    touchLater(path)
    const titles = (await adapter.list(USER, null)).map((snapshot) => snapshot.title).sort()
    expect(titles).toEqual(['A2', 'B'])
    expect(reads).toHaveLength(3)
  })

  it('skips dotfiles, non-markdown, files without frontmatter, symlinks and a second file claiming an id', async () => {
    put('.hidden.md', '---\ntitle: H\n---\n')
    put('notes.txt', '---\ntitle: T\n---\n')
    put('plain.md', '# no frontmatter\n')
    put('a.md', '---\nid: same\ntitle: First\n---\n')
    put('b.md', '---\nid: same\ntitle: Second\n---\n')
    const outside = join(root, 'outside.md')
    writeFileSync(outside, '---\ntitle: Outside\n---\n')
    symlinkSync(outside, join(tasksDir, 'link.md'))
    expect((await adapter.list(USER, null)).map((snapshot) => snapshot.title)).toEqual(['First'])
  })

  it('refuses a symlinked .cinna or tasks directory: no tasks, and no write lands there', async () => {
    const elsewhere = mkdtempSync(join(tmpdir(), 'cinna-elsewhere-'))
    try {
      mkdirSync(join(elsewhere, 'tasks'))
      writeFileSync(join(elsewhere, 'tasks', 'x.md'), '---\ntitle: X\n---\n')
      symlinkSync(elsewhere, join(root, '.cinna'))
      expect(await adapter.list(USER, null)).toEqual([])
      await expect(adapter.create(USER, task(), null)).rejects.toMatchObject({ code: 'rejected' })
      expect(readdirSync(join(elsewhere, 'tasks'))).toEqual(['x.md'])
    } finally {
      rmSync(elsewhere, { recursive: true, force: true })
    }
  })

  it('reads the status through _board.yaml, and re-reads the board when it changes', async () => {
    put('a.md', '---\ntitle: A\nstatus: todo\n---\n')
    expect((await only()).status).toBe('new')
    const board = put('_board.yaml', 'todo: ready\n')
    expect((await only()).status).toBe('open')
    writeFileSync(board, 'todo: done\n')
    touchLater(board)
    expect((await only()).status).toBe('completed')
  })

  it('finds a renamed file by its id, and calls a missing one not ours only on a second read 30 s later', async () => {
    const path = put('a.md', '---\nid: t-1\ntitle: A\n---\n')
    const binding = (await only()).binding
    rmSync(path)
    put('renamed.md', '---\nid: t-1\ntitle: A\n---\n')
    const fetched = await adapter.fetch(USER, binding)
    expect(fetched.binding.id).toBe(binding.id)
    expect((fetched.binding.state as { file: string }).file).toBe('renamed.md')
    rmSync(join(tasksDir, 'renamed.md'))
    await expect(adapter.fetch(USER, binding)).rejects.toMatchObject({ code: 'unavailable' })
    clock += 29_999
    await expect(adapter.fetch(USER, binding)).rejects.toMatchObject({ code: 'unavailable' })
    clock += 1
    await expect(adapter.fetch(USER, binding)).rejects.toMatchObject({ code: 'not_ours' })
  })

  it('answers unavailable, never not ours, while the agent folder, .cinna or .cinna/tasks is missing', async () => {
    put('a.md', '---\nid: t-1\ntitle: A\n---\n')
    const binding = (await only()).binding
    const away = `${root}-away`
    for (const missing of [tasksDir, join(root, '.cinna'), root]) {
      renameSync(missing, away)
      for (let pass = 0; pass < 3; pass += 1) {
        await expect(adapter.fetch(USER, binding)).rejects.toMatchObject({ code: 'unavailable' })
        expect(await adapter.list(USER, null)).toEqual([])
        clock += 10_000
      }
      renameSync(away, missing)
      expect((await adapter.fetch(USER, binding)).binding.id).toBe(binding.id)
    }
  })

  it('answers unavailable for a .cinna/tasks it cannot list', async () => {
    put('a.md', '---\nid: t-1\ntitle: A\n---\n')
    const binding = (await only()).binding
    fs = { ...fs, list: () => { throw Object.assign(new Error('denied'), { code: 'EACCES' }) } }
    adapter = makeAdapter()
    for (let pass = 0; pass < 3; pass += 1) {
      await expect(adapter.fetch(USER, binding)).rejects.toMatchObject({ code: 'unavailable' })
      clock += 10_000
    }
  })

  it('a missing folder between two absences starts the count again', async () => {
    const path = put('a.md', '---\nid: t-1\ntitle: A\n---\n')
    const binding = (await only()).binding
    rmSync(path)
    await expect(adapter.fetch(USER, binding)).rejects.toMatchObject({ code: 'unavailable' })
    clock += 40_000
    rmSync(tasksDir, { recursive: true })
    await expect(adapter.fetch(USER, binding)).rejects.toMatchObject({ code: 'unavailable' })
    mkdirSync(tasksDir)
    clock += 40_000
    // First absence from a readable folder since it came back.
    await expect(adapter.fetch(USER, binding)).rejects.toMatchObject({ code: 'unavailable' })
    clock += 30_000
    await expect(adapter.fetch(USER, binding)).rejects.toMatchObject({ code: 'not_ours' })
  })

  it('keeps a file that is there but no longer parses at its last good read', async () => {
    const path = put('a.md', '---\nid: t-1\ntitle: A\n---\nBody.\n')
    const binding = (await only()).binding
    writeFileSync(path, 'title: A\nhalf-saved, the fences gone\n')
    touchLater(path)
    expect((await only()).title).toBe('A')
    for (let pass = 0; pass < 3; pass += 1) {
      expect((await adapter.fetch(USER, binding)).title).toBe('A')
      clock += 10_000
    }
    // A write never lands over the broken file.
    await expect(adapter.pushFields(USER, binding, { title: 'B' })).rejects.toMatchObject({ code: 'unavailable' })
    expect(readFileSync(path, 'utf8')).toBe('title: A\nhalf-saved, the fences gone\n')
  })

  it('keeps a bound file that does not parse after a restart (no last good read): unavailable, not gone', async () => {
    const path = put('a.md', '---\nid: t-1\ntitle: A\n---\n')
    const binding = (await only()).binding
    writeFileSync(path, 'broken\n')
    touchLater(path)
    adapter = makeAdapter()
    for (let pass = 0; pass < 3; pass += 1) {
      await expect(adapter.fetch(USER, binding)).rejects.toMatchObject({ code: 'unavailable' })
      clock += 10_000
    }
  })

  it('the file coming back within the grace clears the count', async () => {
    const path = put('a.md', '---\nid: t-1\ntitle: A\n---\n')
    const binding = (await only()).binding
    const text = readFileSync(path, 'utf8')
    rmSync(path)
    await expect(adapter.fetch(USER, binding)).rejects.toMatchObject({ code: 'unavailable' })
    clock += 20_000
    put('a.md', text)
    await adapter.list(USER, null)
    rmSync(path)
    clock += 20_000
    await expect(adapter.fetch(USER, binding)).rejects.toMatchObject({ code: 'unavailable' })
  })

  it('keeps the task of an agent that was switched off: unavailable, not gone', async () => {
    put('a.md', '---\nid: t-1\ntitle: A\n---\n')
    const binding = (await only()).binding
    agents = []
    await expect(adapter.fetch(USER, binding)).rejects.toMatchObject({ code: 'unavailable' })
    expect(await adapter.list(USER, null)).toEqual([])
  })
})

describe('push', () => {
  it('reads its own write back as ours, and an edit from outside as not', async () => {
    const path = put('a.md', NESTED)
    const binding = (await only()).binding
    remember(await adapter.pushFields(USER, binding, { title: 'Fix login for good' }))
    touchLater(path)
    expect((await only()).file?.ours).toBe(true)
    writeFileSync(path, readFileSync(path, 'utf8').replace('Body.', 'Edited by hand.'))
    touchLater(path)
    expect((await only()).file?.ours).toBe(false)
  })

  it('still knows its own write after a restart: the written digest lives in the stored binding', async () => {
    const path = put('a.md', NESTED)
    const binding = (await only()).binding
    const pushed = remember(await adapter.pushFields(USER, binding, { title: 'Written before quitting' }))
    remember((await adapter.putHandoffNote(USER, pushed, 'Half done.')) as RemoteBinding)
    // A new process: no cache, nothing in memory — only what the profile stored.
    adapter = makeAdapter()
    const pulled = await only()
    expect(pulled.file?.ours).toBe(true)
    // The pull carries the written digest forward, so storing its state loses nothing.
    expect((pulled.binding.state as { writtenDigest?: string }).writtenDigest).toBe(pulled.file?.digest)
    writeFileSync(path, readFileSync(path, 'utf8').replace('Half done.', 'Edited by hand.'))
    touchLater(path)
    adapter = makeAdapter()
    expect((await only()).file?.ours).toBe(false)
  })

  it('patches owned lines only, leaving nested custom YAML exactly as it was', async () => {
    const path = put('a.md', NESTED)
    const binding = (await only()).binding
    await adapter.pushFields(USER, binding, { title: 'New title', priority: 'urgent', description: 'New body.' })
    expect(readFileSync(path, 'utf8')).toBe(
      '---\nid: t-1\ntitle: New title\nstatus: doing\npriority: urgent\nestimate: 3\nmeta:\n  owner: sam\nparent: t-0\nblocked_by: [t-9]\n---\nNew body.\n'
    )
  })

  it('lets the file win on a field it changed since the last read, and still writes the others', async () => {
    const path = put('a.md', '---\nid: t-1\ntitle: Original\npriority: low\n---\nBody.\n')
    const binding = (await only()).binding
    writeFileSync(path, '---\nid: t-1\ntitle: Renamed in the editor\npriority: low\n---\nBody.\n')
    touchLater(path)
    const after = await adapter.pushFields(USER, binding, { title: 'Renamed in Cinna', priority: 'high' })
    expect(readFileSync(path, 'utf8')).toBe('---\nid: t-1\ntitle: Renamed in the editor\npriority: high\n---\nBody.\n')
    // The base now matches the file, so the next pull brings the file's title in.
    expect((after.state as { base: { title: string } }).base.title).toBe('Renamed in the editor')
  })

  it('writes one scalar custom field, removes one, and never touches a nested one', async () => {
    const path = put('a.md', NESTED)
    const binding = (await only()).binding
    await adapter.pushFields(USER, binding, { customFields: { meta: 'ignored', area: 'auth' } })
    const text = readFileSync(path, 'utf8')
    expect(text).not.toContain('estimate:')
    expect(text).toContain('meta:\n  owner: sam\n')
    expect(text).toContain('area: auth\n---')
    expect(text).not.toContain('ignored')
  })

  it('writes a status in the folder’s words: nothing when the word fits, a chosen label, else the board', async () => {
    const path = put('a.md', '---\nid: t-1\ntitle: A\nstatus: doing\n---\n')
    put('_board.yaml', 'Icebox: backlog\nShipped: done\n')
    // Each write's binding is the next one's, as the sync service stores it.
    let binding = (await only()).binding
    const before = readFileSync(path, 'utf8')
    binding = await adapter.pushStatus(USER, binding, 'in_progress')
    expect(readFileSync(path, 'utf8')).toBe(before)
    binding = await adapter.pushStatus(USER, binding, 'completed')
    expect(readFileSync(path, 'utf8')).toContain('status: Shipped')
    binding = await adapter.pushStatus(USER, binding, 'new', undefined, { label: 'todo' })
    expect(readFileSync(path, 'utf8')).toContain('status: todo')
    // A label that does not mean the status is not used.
    binding = await adapter.pushStatus(USER, binding, 'open', undefined, { label: 'Shipped' })
    expect(readFileSync(path, 'utf8')).toContain('status: open')
    binding = await adapter.archive(USER, binding)
    expect(readFileSync(path, 'utf8')).toContain('status: archived')
    await expect(adapter.pushStatus(USER, binding, 'archived')).rejects.toBeInstanceOf(RemoteTaskError)
  })

  it('lets the file win its status word when it changed since the last read, and the base takes the file’s word', async () => {
    const path = put('a.md', '---\nid: t-1\ntitle: A\nstatus: todo\n---\n')
    const binding = (await only()).binding
    writeFileSync(path, '---\nid: t-1\ntitle: A\nstatus: blocked\n---\n')
    touchLater(path)
    const after = await adapter.pushStatus(USER, binding, 'completed')
    expect(readFileSync(path, 'utf8')).toBe('---\nid: t-1\ntitle: A\nstatus: blocked\n---\n')
    expect((after.state as { base: { status: string } }).base.status).toBe('blocked')
  })

  it('writes the status when the file changed another field, not its status word', async () => {
    const path = put('a.md', '---\nid: t-1\ntitle: A\nstatus: todo\n---\n')
    const binding = (await only()).binding
    writeFileSync(path, '---\nid: t-1\ntitle: Renamed in the editor\nstatus: todo\n---\n')
    touchLater(path)
    await adapter.pushStatus(USER, binding, 'completed')
    expect(readFileSync(path, 'utf8')).toBe('---\nid: t-1\ntitle: Renamed in the editor\nstatus: completed\n---\n')
  })

  it('keeps the handoff section at the end of the body, and removes it for a cleared note', async () => {
    const path = put('a.md', NESTED)
    const binding = (await only()).binding
    expect(adapter.capabilities().clearHandoffNote).toBe(true)
    await adapter.putHandoffNote(USER, binding, 'Half done.')
    expect(readFileSync(path, 'utf8')).toBe(`${NESTED}\n<!-- cinna:handoff -->\nHalf done.\n<!-- /cinna:handoff -->\n`)
    await adapter.putHandoffNote(USER, binding, null)
    expect(readFileSync(path, 'utf8')).toBe(NESTED)
  })

  it('never answers not ours to a write whose file is gone, however long it has been', async () => {
    const path = put('a.md', '---\nid: t-1\ntitle: A\n---\n')
    const binding = (await only()).binding
    rmSync(path)
    for (let pass = 0; pass < 3; pass += 1) {
      await expect(adapter.pushFields(USER, binding, { title: 'B' })).rejects.toMatchObject({ code: 'unavailable' })
      await expect(adapter.pushStatus(USER, binding, 'open', 'r')).rejects.toMatchObject({ code: 'unavailable' })
      await expect(adapter.putHandoffNote(USER, binding, 'Note')).rejects.toMatchObject({ code: 'unavailable' })
      await expect(adapter.listSubtasks(USER, binding)).rejects.toMatchObject({ code: 'unavailable' })
      clock += 10_000
    }
    rmSync(tasksDir, { recursive: true })
    await expect(adapter.pushFields(USER, binding, { title: 'B' })).rejects.toMatchObject({ code: 'unavailable' })
  })

  it('patches the bytes on disk, not a cached copy the stamp could not tell apart (cp -p, rsync -t)', async () => {
    const path = put('a.md', '---\nid: t-1\ntitle: Alpha\npriority: low\n---\nOld body\n')
    const stamp = new Date('2026-01-01T00:00:00Z')
    utimesSync(path, stamp, stamp)
    const binding = (await only()).binding
    // Same size, same mtime: invisible to the listing's stamp.
    writeFileSync(path, '---\nid: t-1\ntitle: Alpha\npriority: low\n---\nNew body\n')
    utimesSync(path, stamp, stamp)
    await adapter.pushFields(USER, binding, { priority: 'high' })
    expect(readFileSync(path, 'utf8')).toBe('---\nid: t-1\ntitle: Alpha\npriority: high\n---\nNew body\n')
  })

  it('lets the file win a field it changed even when the stamp could not tell (same size and mtime)', async () => {
    const path = put('a.md', '---\nid: t-1\ntitle: Alpha\n---\n')
    const stamp = new Date('2026-01-01T00:00:00Z')
    utimesSync(path, stamp, stamp)
    const binding = (await only()).binding
    writeFileSync(path, '---\nid: t-1\ntitle: Gamma\n---\n')
    utimesSync(path, stamp, stamp)
    await adapter.pushFields(USER, binding, { title: 'Delta' })
    expect(readFileSync(path, 'utf8')).toBe('---\nid: t-1\ntitle: Gamma\n---\n')
  })

  it('keeps the base of a field still owed when a pull lands before the push (stateWhileOwed)', async () => {
    const path = put('a.md', '---\nid: t-1\ntitle: Original\npriority: low\n---\n')
    const bound = (await only()).binding
    writeFileSync(path, '---\nid: t-1\ntitle: From the editor\npriority: normal\n---\n')
    touchLater(path)
    const pulled = (await only()).binding
    const kept = adapter.stateWhileOwed!(bound.state, pulled.state, ['title']) as { base: { title: string; priority: string } }
    expect(kept.base).toMatchObject({ title: 'Original', priority: 'normal' })
    expect(adapter.stateWhileOwed!(bound.state, pulled.state, [])).toBe(pulled.state)
  })

  it('refuses to write through a task file that became a symlink', async () => {
    const path = put('a.md', '---\nid: t-1\ntitle: A\n---\n')
    const binding = (await only()).binding
    const outside = join(root, 'target.md')
    writeFileSync(outside, '---\nid: t-1\ntitle: A\n---\n')
    rmSync(path)
    symlinkSync(outside, path)
    // The listing skips the link, so the task is not there to write.
    await expect(adapter.pushFields(USER, binding, { title: 'B' })).rejects.toMatchObject({ code: 'unavailable' })
    expect(readFileSync(outside, 'utf8')).toContain('title: A')
  })
})

describe('create', () => {
  it('writes <slug>.md with a fresh id in the fixed key order, then -2 on a collision', async () => {
    const first = remember(await adapter.create(USER, task({ status: 'open', customFields: { area: 'auth' } }), null))
    const second = await adapter.create(USER, task(), null)
    expect(readdirSync(tasksDir).sort()).toEqual(['fix-the-login-bug-2.md', 'fix-the-login-bug.md'])
    expect(first.id).toBe(`${agent.id}:t-aaaaaaaa`)
    expect(second.key).not.toBe(first.key)
    expect(readFileSync(join(tasksDir, 'fix-the-login-bug.md'), 'utf8')).toBe(
      '---\ncinna_task: 1\nid: t-aaaaaaaa\ntitle: Fix the login bug\nstatus: open\npriority: normal\norigin: cinna\narea: auth\n---\nIt rejects valid passwords.\n'
    )
    const pulled = (await adapter.list(USER, null)).find((snapshot) => snapshot.binding.id === first.id)
    expect(pulled?.file?.ours).toBe(true)
  })

  it('uses the folder’s own word for the status it starts in', async () => {
    put('_board.yaml', 'Icebox: backlog\n')
    await adapter.create(USER, task(), null)
    expect(readFileSync(join(tasksDir, 'fix-the-login-bug.md'), 'utf8')).toContain('status: Icebox')
  })

  it('refuses an assignee with no folder, and a subtask whose parent is elsewhere', async () => {
    await expect(adapter.create(USER, task({ assignee: { kind: 'model', agentId: null, name: null } }), null))
      .rejects.toMatchObject({ code: 'invalid_request' })
    const other: RemoteBinding = { adapter: 'folder', id: 'someone-else:t-1', key: 't-1', url: null, state: {} }
    await expect(adapter.create(USER, task({ parentTaskId: 'p' }), other)).rejects.toMatchObject({ code: 'invalid_request' })
  })

  it('discards the bound file on delete, refuses to remove a symlink, and is fine with nothing there', async () => {
    const path = put('a.md', '---\nid: t-1\ntitle: A\n---\n')
    const binding = (await only()).binding
    await adapter.localHome!.discard(USER, binding)
    expect(readdirSync(tasksDir)).toEqual([])
    await expect(adapter.localHome!.discard(USER, binding)).resolves.toBeUndefined()
    const target = join(root, 'elsewhere.md')
    writeFileSync(target, 'keep me')
    symlinkSync(target, path)
    expect(() => folderTaskFs.remove(path)).toThrow(expect.objectContaining({ code: 'ELOOP' }))
    expect(readFileSync(target, 'utf8')).toBe('keep me')
    expect(() => folderTaskFs.remove(join(tasksDir, 'missing.md'))).not.toThrow()
  })

  it('does not discard a file the listing still calls this task but that carries another id when read now', async () => {
    const path = put('a.md', '---\nid: t-1\ntitle: A\n---\n')
    const stamp = new Date('2026-01-01T00:00:00Z')
    utimesSync(path, stamp, stamp)
    const binding = (await only()).binding
    // Same size, same mtime: the listing's cache still says t-1.
    writeFileSync(path, '---\nid: t-9\ntitle: A\n---\n')
    utimesSync(path, stamp, stamp)
    await adapter.localHome!.discard(USER, binding)
    expect(readFileSync(path, 'utf8')).toContain('id: t-9')
  })

  it('answers the folder board for its agent, and nothing for another', async () => {
    put('a.md', '---\ntitle: A\nstatus: Doing\n---\n')
    put('_board.yaml', 'Icebox: backlog\n')
    expect(await adapter.localHome?.accepts(agent.id)).toBe(true)
    expect(await adapter.localHome?.accepts('kit-agent')).toBe(false)
    expect(await adapter.localHome?.board(USER, agent.id, [])).toEqual([
      { label: 'Icebox', category: 'backlog', status: 'new', droppable: true },
      { label: 'Doing', category: 'active', status: 'in_progress', droppable: false }
    ])
  })

  it('gives a board column to every status its shown tasks sit in, and to a word a row holds', async () => {
    put('a.md', '---\ntitle: A\nstatus: Doing\n---\n')
    put('_board.yaml', 'Icebox: backlog\n')
    const columns = await adapter.localHome!.board(USER, agent.id, [
      // A native or handover task of this agent: no word, its status's category.
      { status: 'completed', statusLabel: null },
      { status: 'blocked', statusLabel: null },
      // A file task whose word no file holds right now.
      { status: 'open', statusLabel: 'Next' },
      // A status a column already holds adds nothing.
      { status: 'in_progress', statusLabel: null }
    ])
    expect(columns.map((column) => column.label)).toEqual(['Icebox', 'Next', 'Doing', 'blocked', 'completed'])
  })

  it('answers the word a status change will write from the folder as last read, and nothing before a read', async () => {
    put('a.md', '---\nid: t-1\ntitle: A\nstatus: Icebox\n---\n')
    put('_board.yaml', 'Icebox: backlog\nDoing: active\n')
    const home = adapter.localHome!
    expect(home.statusWord(`${agent.id}:t-1`, 'in_progress', 'Icebox')).toBeUndefined()
    await adapter.list(USER, null)
    expect(home.statusWord(`${agent.id}:t-1`, 'in_progress', 'Icebox')).toBe('Doing')
    expect(home.statusWord(`${agent.id}:t-1`, 'new', 'Icebox')).toBe('Icebox')
    expect(home.statusWord(`${agent.id}:t-1`, 'completed', 'Icebox')).toBe('completed')
    expect(home.statusWord('someone-else:t-1', 'completed', 'Icebox')).toBeUndefined()
  })
})
