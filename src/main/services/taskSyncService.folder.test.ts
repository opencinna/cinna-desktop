vi.mock('../host/runtimeHost', async () => {
  const { createDesktopHost } = await import('../host/desktop/runtimeHost')
  return { runtimeHost: createDesktopHost() }
})
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, renameSync, rmSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createTestDatabase, type TestDatabase } from '../db/testSupport/nodeSqlite'
import type { RemoteTaskAdapter } from '../tasks/adapters/adapter'

/**
 * Folder tasks end to end: a real database, the real sync service and
 * authoring layer, and the real `folder` adapter over a temp directory. Only
 * the registry (so the production wiring's agent list is not needed) and the
 * agent lookup are stand-ins.
 */

const holder = vi.hoisted(() => ({
  current: null as TestDatabase | null,
  userData: '',
  adapters: [] as RemoteTaskAdapter[],
  agentPath: '',
  /** The folder adapter's clock, so the absence grace can pass without waiting. */
  clock: 0
}))

vi.mock('electron', () => ({ app: { getPath: () => holder.userData } }))
vi.mock('../logger/logger', () => ({
  createLogger: () => ({ debug: () => {}, info: () => {}, warn: () => {}, error: () => {} })
}))
vi.mock('../db/client', () => ({
  getDb: () => {
    if (!holder.current) throw new Error('test database not initialised')
    return holder.current.db
  },
  getRawSqlite: () => {
    if (!holder.current) throw new Error('test database not initialised')
    return holder.current.sqlite
  }
}))
vi.mock('../db/sync', () => ({ syncRepo: { getState: () => null } }))
vi.mock('./agentService', () => ({
  agentService: {
    findAgent: (_settings: string, _profile: string, agentId: string) =>
      ['bare-1', 'kit-1'].includes(agentId) ? { row: { id: agentId, name: agentId === 'bare-1' ? 'Uploader' : 'Kit', enabled: true }, userId: 'settings' } : null
  }
}))
vi.mock('../tasks/adapters', async () => {
  const adapter = await import('../tasks/adapters/adapter')
  const nullAdapter = await import('../tasks/adapters/nullAdapter')
  return {
    ...adapter,
    allAdapters: () => holder.adapters,
    adapterFor: (id: string) => holder.adapters.find((a) => a.id === id) ?? nullAdapter.createNullAdapter(id),
    localHomeFor: async (agentId: string) => {
      for (const a of holder.adapters) if (a.localHome && (await a.localHome.accepts(agentId))) return a
      return null
    }
  }
})

const { taskSyncService } = await import('./taskSyncService')
const { taskService } = await import('./taskService')
const { taskAuthoringService } = await import('./taskAuthoringService')
const { taskRepo } = await import('../db/tasks')
const { createFolderTaskAdapter } = await import('../tasks/adapters/folderTaskAdapter')
const { folderTaskFs } = await import('../tasks/adapters/folderTaskFs')
const { createFakeRemote } = await import('../tasks/adapters/testSupport/fakeRemote')
const { installStatusWordResolver } = await import('../tasks/adapters/statusWords')
const { taskRuntimeRepo } = await import('../db/taskRuntimes')
type TaskRuntimeCheckpoint = import('../tasks/runtimeTypes').TaskRuntimeCheckpoint

// The registry installs this for an adapter with a local home; the registry is
// stood in for here, so the test installs it the same way.
installStatusWordResolver('folder', (remoteId, status, current) =>
  holder.adapters.find((a) => a.id === 'folder')?.localHome?.statusWord(remoteId, status, current))

const USER = 'profile-1'
const SCOPE = { profileUserId: USER, settingsUserId: 'settings' }
let tasksDir: string

beforeEach(() => {
  holder.current = createTestDatabase()
  holder.userData = mkdtempSync(join(tmpdir(), 'cinna-folder-sync-data-'))
  holder.agentPath = mkdtempSync(join(tmpdir(), 'cinna-folder-sync-agent-'))
  tasksDir = join(holder.agentPath, '.cinna', 'tasks')
  holder.clock = 1_000_000
  holder.adapters = [folderAdapter()]
  taskSyncService.resetCursors()
})

afterEach(async () => {
  // Let an immediate push scheduled by the last write settle before the
  // database goes away under it.
  await settle()
  holder.current?.close()
  holder.current = null
  rmSync(holder.userData, { recursive: true, force: true })
  rmSync(holder.agentPath, { recursive: true, force: true })
})

let seed = 0
/** The folder adapter over the temp folder, its stored states read from the database as the wiring does. */
function folderAdapter(): RemoteTaskAdapter {
  return createFolderTaskAdapter({
    agents: async () => [{ id: 'bare-1', name: 'Uploader', path: holder.agentPath }],
    states: async (userId) => new Map(taskRepo.list(userId, { remoteAdapter: 'folder', includeArchived: true })
      .filter((row) => row.remoteId && row.remoteState)
      .map((row) => [row.remoteId as string, row.remoteState as Record<string, unknown>])),
    fs: folderTaskFs,
    randomBytes: (size) => new Uint8Array(size).fill(seed++),
    now: () => holder.clock
  })
}

/** One scheduled pass later: past the absence grace. */
async function passLater(): Promise<void> {
  holder.clock += 30_000
  await taskSyncService.pull(USER)
}

/** Two macrotask turns: the immediate-push hook's `setImmediate`, then its push. */
async function settle(): Promise<void> {
  for (let i = 0; i < 4; i += 1) await new Promise((resolve) => setImmediate(resolve))
  await new Promise((resolve) => setTimeout(resolve, 20))
}

function put(name: string, text: string): string {
  mkdirSync(tasksDir, { recursive: true })
  const path = join(tasksDir, name)
  writeFileSync(path, text)
  return path
}

function later(path: string): void {
  const when = new Date(Date.now() + 5_000)
  utimesSync(path, when, when)
}

function only() {
  const rows = taskRepo.list(USER, { includeArchived: true })
  expect(rows).toHaveLength(1)
  return taskService.getById(USER, rows[0].id)
}

describe('a pull of a bare agent’s folder', () => {
  it('indexes a file written outside Cinna as a device-local task of that agent, run here, changed outside', async () => {
    const path = put('fix-login.md', '---\nid: t-1\ntitle: Fix login\nstatus: Doing\nmeta:\n  owner: sam\n---\nBody.\n')
    await taskSyncService.pull(USER)
    const task = only()
    expect(task).toMatchObject({
      title: 'Fix login', description: 'Body.', status: 'in_progress', statusLabel: 'Doing',
      executor: 'desktop', origin: 'remote', assignee: { kind: 'agent', agentId: 'bare-1', name: 'Uploader' },
      customFields: { meta: 'owner: sam' }, file: { path, readOnlyFields: ['meta'], blockedBy: [] }, fromOutside: true,
      remote: { adapter: 'folder', id: 'bare-1:t-1', key: 't-1', url: null }
    })
    expect(taskRepo.getById(USER, task.id)?.deviceLocal).toBe(true)
    // Device sync never sees it.
    expect(taskRepo.listChangedSince(USER, 0).map((row) => row.id)).not.toContain(task.id)
  })

  it('removes the task once its file has been gone for two passes 30 s apart, not on the first', async () => {
    const path = put('a.md', '---\nid: t-1\ntitle: A\n---\n')
    await taskSyncService.pull(USER)
    const id = only().id
    await taskSyncService.pull(USER)
    expect(taskRepo.getById(USER, id)?.deletedAt).toBeNull()
    rmSync(path)
    await taskSyncService.pull(USER)
    expect(taskRepo.getById(USER, id)).toMatchObject({ deletedAt: null, remoteId: 'bare-1:t-1' })
    holder.clock += 29_000
    await taskSyncService.pull(USER)
    expect(taskRepo.getById(USER, id)?.deletedAt).toBeNull()
    await passLater()
    expect(taskRepo.getById(USER, id)?.deletedAt).not.toBeNull()
  })

  it('keeps a task whose file is gone while a runtime owns it, bound, and removes it once the runtime is done', async () => {
    const path = put('a.md', '---\nid: t-1\ntitle: A\n---\n')
    await taskSyncService.pull(USER)
    const id = only().id
    taskRuntimeRepo.save(USER, id, {} as TaskRuntimeCheckpoint)
    rmSync(path)
    await taskSyncService.pull(USER)
    await passLater()
    await passLater()
    expect(taskRepo.getById(USER, id)).toMatchObject({ deletedAt: null, remoteId: 'bare-1:t-1', remoteAdapter: 'folder' })
    // A watched read of it (the task page) keeps it too.
    holder.clock += 30_000
    await taskSyncService.pullOne(USER, id)
    expect(taskRepo.getById(USER, id)).toMatchObject({ deletedAt: null, remoteId: 'bare-1:t-1' })
    taskRuntimeRepo.remove(USER, id)
    await passLater()
    await passLater()
    expect(taskRepo.getById(USER, id)?.deletedAt).not.toBeNull()
  })

  it('a watched read that finds the file gone removes the task, as a pass does, not just unbinds it', async () => {
    const path = put('a.md', '---\nid: t-1\ntitle: A\n---\n')
    await taskSyncService.pull(USER)
    const id = only().id
    rmSync(path)
    expect(await taskSyncService.pullOne(USER, id)).toBeNull()
    holder.clock += 30_000
    expect(await taskSyncService.pullOne(USER, id)).toBeNull()
    expect(taskRepo.getById(USER, id)?.deletedAt).not.toBeNull()
  })

  it('keeps every task while the folder is moved away, and finds the same ones when it is back', async () => {
    put('a.md', '---\nid: t-1\ntitle: A\n---\n')
    put('b.md', '---\nid: t-2\ntitle: B\n---\n')
    await taskSyncService.pull(USER)
    const before = taskRepo.list(USER, { includeArchived: true }).map((row) => [row.id, row.remoteId]).sort()
    expect(before).toHaveLength(2)
    const away = `${holder.agentPath}-away`
    renameSync(join(holder.agentPath, '.cinna'), away)
    try {
      for (let pass = 0; pass < 4; pass += 1) await passLater()
      // A local edit made meanwhile waits, bound, with its marker.
      const first = taskRepo.list(USER, { includeArchived: true }).find((row) => row.remoteId === 'bare-1:t-1')!
      taskService.update(USER, first.id, { title: 'Edited while away' })
      await settle()
      await taskSyncService.push(USER, first.id)
      expect(taskRepo.getById(USER, first.id)).toMatchObject({ remoteId: 'bare-1:t-1', remoteDirty: ['title'], deletedAt: null })
    } finally {
      renameSync(away, join(holder.agentPath, '.cinna'))
    }
    await passLater()
    const after = taskRepo.list(USER, { includeArchived: true })
    expect(after.map((row) => [row.id, row.remoteId]).sort()).toEqual(before)
    expect(after.every((row) => row.deletedAt === null)).toBe(true)
    await taskSyncService.pushAll(USER)
    expect(readFileSync(join(tasksDir, 'a.md'), 'utf8')).toContain('title: Edited while away')
  })

  it('keeps a task whose file no longer parses, at its last good state', async () => {
    const path = put('a.md', '---\nid: t-1\ntitle: A\n---\nBody.\n')
    await taskSyncService.pull(USER)
    const id = only().id
    writeFileSync(path, 'half-saved\n')
    later(path)
    for (let pass = 0; pass < 3; pass += 1) await passLater()
    expect(taskService.getById(USER, id)).toMatchObject({ title: 'A', description: 'Body.', remote: { id: 'bare-1:t-1' } })
    expect(taskRepo.getById(USER, id)?.deletedAt).toBeNull()
  })

  it('picks up an outside edit of the status word through _board.yaml', async () => {
    const path = put('a.md', '---\nid: t-1\ntitle: A\nstatus: todo\n---\n')
    await taskSyncService.pull(USER)
    expect(only()).toMatchObject({ status: 'new', statusLabel: 'todo' })
    writeFileSync(path, '---\nid: t-1\ntitle: A\nstatus: Shipped\n---\n')
    later(path)
    put('_board.yaml', 'Shipped: done\n')
    await taskSyncService.pull(USER)
    expect(only()).toMatchObject({ status: 'completed', statusLabel: 'Shipped' })
  })
})

describe('task:create for an agent', () => {
  it('writes a bare agent’s task into its folder and binds it: device-local, trusted, in the folder’s word', async () => {
    put('_board.yaml', 'Up Next: ready\n')
    const task = await taskAuthoringService.createRouted(SCOPE, {
      title: 'Write the docs', status: 'open', description: 'All of them.', customFields: { area: 'docs' },
      assignee: { kind: 'agent', agentId: 'bare-1' }
    })
    const file = join(tasksDir, 'write-the-docs.md')
    expect(readFileSync(file, 'utf8')).toContain('status: Up Next')
    expect(task).toMatchObject({
      status: 'open', statusLabel: 'Up Next', origin: 'local', executor: 'desktop', fromOutside: false,
      file: { path: file }, remote: { adapter: 'folder' }, customFields: { area: 'docs' }
    })
    const row = taskRepo.getById(USER, task.id)!
    expect(row.deviceLocal).toBe(true)
    expect(row.trustedDigest).toBe(row.localFile?.digest)
    // A pull of its own write changes nothing and keeps it trusted.
    await taskSyncService.pull(USER)
    expect(taskService.getById(USER, task.id).fromOutside).toBe(false)
  })

  it('keeps the base of a field still owed when it reads the new file back, so an outside change of it still wins', async () => {
    // Between the write and the read-back: somebody edits the title in the
    // file, and the user edits it in Cinna — owed, and pushed right after.
    const real = holder.adapters[0]
    let raced = false
    holder.adapters = [{
      ...real,
      async fetch(userId, binding) {
        if (raced) return real.fetch(userId, binding)
        raced = true
        const file = join(tasksDir, 'race-me.md')
        writeFileSync(file, readFileSync(file, 'utf8').replace('title: Race me', 'title: From the editor'))
        later(file)
        const snapshot = await real.fetch(userId, binding)
        const row = taskRepo.list(USER).find((candidate) => candidate.title === 'Race me')!
        taskService.update(USER, row.id, { title: 'From Cinna' })
        return snapshot
      }
    }]
    await taskAuthoringService.createRouted(SCOPE, { title: 'Race me', assignee: { kind: 'agent', agentId: 'bare-1' } })
    await settle()
    expect(readFileSync(join(tasksDir, 'race-me.md'), 'utf8')).toContain('title: From the editor')
  })

  it('writes a subtask beside its parent and keeps the parent through the read-back and a pull', async () => {
    const parent = await taskAuthoringService.createRouted(SCOPE, { title: 'Parent', assignee: { kind: 'agent', agentId: 'bare-1' } })
    const child = await taskSyncService.createInHome(USER, holder.adapters[0], {
      title: 'Child', goal: 'Child', parentTaskId: parent.id, origin: 'local', executor: 'desktop',
      assigneeKind: 'agent', assigneeAgentId: 'bare-1', assigneeName: 'Uploader'
    })
    expect(child.parentTaskId).toBe(parent.id)
    expect(readFileSync(join(tasksDir, 'child.md'), 'utf8')).toContain(`parent: ${parent.remote!.key}`)
    await taskSyncService.pull(USER)
    expect(taskService.getById(USER, child.id).parentTaskId).toBe(parent.id)
  })

  it('keeps a task for any other assignee native', async () => {
    const task = await taskAuthoringService.createRouted(SCOPE, { title: 'Kit work', assignee: { kind: 'agent', agentId: 'kit-1' } })
    expect(task.remote).toBeNull()
    expect(taskRepo.getById(USER, task.id)?.deviceLocal).toBe(false)
    expect(readdirSync(holder.agentPath)).toEqual([])
  })

  it('pushes a local edit straight away, and an outside edit afterwards reads as changed outside', async () => {
    const task = await taskAuthoringService.createRouted(SCOPE, { title: 'Draft', assignee: { kind: 'agent', agentId: 'bare-1' } })
    const file = join(tasksDir, 'draft.md')
    taskAuthoringService.update(SCOPE, task.id, { title: 'Final', customFields: { area: 'ops' } })
    await settle()
    expect(readFileSync(file, 'utf8')).toContain('title: Final')
    expect(readFileSync(file, 'utf8')).toContain('area: ops')
    expect(taskRepo.getById(USER, task.id)?.remoteDirty).toBeNull()
    later(file)
    await taskSyncService.pull(USER)
    expect(taskService.getById(USER, task.id).fromOutside).toBe(false)

    writeFileSync(file, readFileSync(file, 'utf8').replace('title: Final', 'title: Edited by hand'))
    later(file)
    await taskSyncService.pull(USER)
    expect(taskService.getById(USER, task.id)).toMatchObject({ title: 'Edited by hand', fromOutside: true })
  })

  it('does not call Cinna’s own write “changed outside” after a quit and restart before the next pull', async () => {
    const task = await taskAuthoringService.createRouted(SCOPE, { title: 'Before quitting', assignee: { kind: 'agent', agentId: 'bare-1' } })
    taskAuthoringService.update(SCOPE, task.id, { title: 'Edited, then quit' })
    taskService.setHandoffNote(USER, task.id, 'Left a note.')
    await settle()
    expect(readFileSync(join(tasksDir, 'before-quitting.md'), 'utf8')).toContain('Left a note.')
    // Restart: a fresh adapter (no cache, nothing in memory) and fresh cursors.
    holder.adapters = [folderAdapter()]
    taskSyncService.resetCursors()
    later(join(tasksDir, 'before-quitting.md'))
    await taskSyncService.pull(USER)
    expect(taskService.getById(USER, task.id)).toMatchObject({ title: 'Edited, then quit', fromOutside: false })
  })

  it('lets the file win a field it changed since the last read', async () => {
    const task = await taskAuthoringService.createRouted(SCOPE, { title: 'Original', assignee: { kind: 'agent', agentId: 'bare-1' } })
    const file = join(tasksDir, 'original.md')
    writeFileSync(file, readFileSync(file, 'utf8').replace('title: Original', 'title: From the editor'))
    later(file)
    taskAuthoringService.update(SCOPE, task.id, { title: 'From Cinna', priority: 'high' })
    await settle()
    expect(readFileSync(file, 'utf8')).toContain('title: From the editor')
    expect(readFileSync(file, 'utf8')).toContain('priority: high')
    await taskSyncService.pull(USER)
    expect(taskService.getById(USER, task.id)).toMatchObject({ title: 'From the editor', priority: 'high' })
  })

  it('removes a desktop-created task whose file was deleted, whatever its origin', async () => {
    const task = await taskAuthoringService.createRouted(SCOPE, { title: 'Gone soon', assignee: { kind: 'agent', agentId: 'bare-1' } })
    await taskSyncService.pull(USER)
    rmSync(join(tasksDir, 'gone-soon.md'))
    await taskSyncService.pull(USER)
    expect(taskRepo.getById(USER, task.id)?.deletedAt).toBeNull()
    await passLater()
    expect(taskRepo.getById(USER, task.id)?.deletedAt).not.toBeNull()
  })

  it('lets the file win a field it changed even when a pull landed between the local edit and its push', async () => {
    const task = await taskAuthoringService.createRouted(SCOPE, { title: 'Original', assignee: { kind: 'agent', agentId: 'bare-1' } })
    const file = join(tasksDir, 'original.md')
    // The local edit, held back from its push.
    const pushes = vi.spyOn(taskSyncService, 'push').mockResolvedValue(undefined)
    try {
      taskAuthoringService.update(SCOPE, task.id, { title: 'From Cinna', priority: 'high' })
      await settle()
    } finally {
      pushes.mockRestore()
    }
    expect(taskRepo.getById(USER, task.id)?.remoteDirty?.sort()).toEqual(['priority', 'title'])
    writeFileSync(file, readFileSync(file, 'utf8').replace('title: Original', 'title: From the editor'))
    later(file)
    await taskSyncService.pull(USER)
    await taskSyncService.push(USER, task.id)
    expect(readFileSync(file, 'utf8')).toContain('title: From the editor')
    expect(readFileSync(file, 'utf8')).toContain('priority: high')
    await taskSyncService.pull(USER)
    expect(taskService.getById(USER, task.id)).toMatchObject({ title: 'From the editor', priority: 'high' })
  })

  it('removes the handoff section from the file when the note is cleared', async () => {
    const task = await taskAuthoringService.createRouted(SCOPE, { title: 'Noted', assignee: { kind: 'agent', agentId: 'bare-1' } })
    const file = join(tasksDir, 'noted.md')
    taskService.setHandoffNote(USER, task.id, 'Left a note.')
    await settle()
    expect(readFileSync(file, 'utf8')).toContain('Left a note.')
    taskService.setHandoffNote(USER, task.id, null)
    await settle()
    expect(readFileSync(file, 'utf8')).not.toContain('cinna:handoff')
    expect(taskRepo.getById(USER, task.id)?.remoteDirty).toBeNull()
  })

  it('removes the new file when its row is deleted while the file is being written', async () => {
    const real = holder.adapters[0]
    holder.adapters = [{
      ...real,
      async create(userId, task, parent) {
        const binding = await real.create(userId, task, parent)
        taskService.remove(USER, task.id)
        return binding
      }
    }]
    await expect(taskAuthoringService.createRouted(SCOPE, { title: 'Gone at once', assignee: { kind: 'agent', agentId: 'bare-1' } }))
      .rejects.toThrow()
    expect(existsSync(join(tasksDir, 'gone-at-once.md'))).toBe(false)
    await taskSyncService.pull(USER)
    expect(taskRepo.list(USER, { includeArchived: true }).filter((row) => !row.deletedAt)).toHaveLength(0)
  })

  it('a pull that reads the new file before it is bound does not index it twice', async () => {
    const real = holder.adapters[0]
    let pulled: Promise<void> | null = null
    holder.adapters = [{
      ...real,
      async create(userId, task, parent) {
        const binding = await real.create(userId, task, parent)
        // The file is on disk and the row not yet bound: a pass runs now.
        pulled = taskSyncService.pull(USER)
        await pulled
        return binding
      }
    }]
    await taskAuthoringService.createRouted(SCOPE, { title: 'Only once', assignee: { kind: 'agent', agentId: 'bare-1' } })
    expect(pulled).not.toBeNull()
    await taskSyncService.pull(USER)
    expect(taskRepo.list(USER, { includeArchived: true }).filter((row) => !row.deletedAt)).toHaveLength(1)
  })

  it('refuses an assignee edit on a folder task', async () => {
    const task = await taskAuthoringService.createRouted(SCOPE, { title: 'Pinned', assignee: { kind: 'agent', agentId: 'bare-1' } })
    expect(() => taskAuthoringService.update(SCOPE, task.id, { assignee: { kind: 'model' } })).toThrow('its agent’s folder')
  })
})

describe('task:set-status on a folder task', () => {
  it('moves it as an unbound task may (no remote table) and writes the chosen word', async () => {
    put('_board.yaml', 'Icebox: backlog\nUp Next: ready\nShipped: done\n')
    const task = await taskAuthoringService.createRouted(SCOPE, { title: 'Move me', status: 'open', assignee: { kind: 'agent', agentId: 'bare-1' } })
    const file = join(tasksDir, 'move-me.md')
    // open → new is the manual overlay's, refused for a task bound to a service with a table.
    const moved = await taskAuthoringService.setStatus(SCOPE, task.id, 'new', 'Icebox')
    expect(moved).toMatchObject({ status: 'new', statusLabel: 'Icebox' })
    await settle()
    expect(readFileSync(file, 'utf8')).toContain('status: Icebox')
    // And without a word, the folder's first word for the column.
    await taskAuthoringService.setStatus(SCOPE, task.id, 'completed')
    await settle()
    expect(readFileSync(file, 'utf8')).toContain('status: Shipped')
  })

  it('moves a task the dispatcher flagged back to Ready with the folder’s Ready word', async () => {
    put('_board.yaml', 'Up Next: ready\nDoing: active\nStuck: waiting\n')
    const task = await taskAuthoringService.createRouted(SCOPE, { title: 'Flag me', status: 'open', assignee: { kind: 'agent', agentId: 'bare-1' } })
    taskService.setStatus(USER, task.id, 'in_progress')
    const blocked = taskService.setStatus(USER, task.id, 'blocked', { dispatchNote: 'Ended without reporting' })
    expect(blocked.statusLabel).toBe('Stuck')
    await settle()
    const moved = await taskAuthoringService.setStatus(SCOPE, task.id, 'open', 'Up Next')
    expect(moved).toMatchObject({ status: 'open', statusLabel: 'Up Next', dispatchNote: null })
    await settle()
    expect(readFileSync(join(tasksDir, 'flag-me.md'), 'utf8')).toContain('status: Up Next')
  })

  it('moves the word with the status when a run moves it: the word the push writes, before it is written', async () => {
    put('_board.yaml', 'Up Next: ready\nDoing: active\n')
    const task = await taskAuthoringService.createRouted(SCOPE, { title: 'Run me', status: 'open', assignee: { kind: 'agent', agentId: 'bare-1' } })
    expect(task.statusLabel).toBe('Up Next')
    // A run's own move (not a person's): no word comes with it, and the card
    // keeps a column — the folder's word for the new status.
    expect(taskService.setStatus(USER, task.id, 'in_progress').statusLabel).toBe('Doing')
    await settle()
    expect(readFileSync(join(tasksDir, 'run-me.md'), 'utf8')).toContain('status: Doing')
    later(join(tasksDir, 'run-me.md'))
    await taskSyncService.pull(USER)
    expect(taskService.getById(USER, task.id)).toMatchObject({ status: 'in_progress', statusLabel: 'Doing' })
  })

  it('lets the file win a status word it changed since the last read, and the task takes it on the next pull', async () => {
    const task = await taskAuthoringService.createRouted(SCOPE, { title: 'Edited', status: 'open', assignee: { kind: 'agent', agentId: 'bare-1' } })
    const file = join(tasksDir, 'edited.md')
    writeFileSync(file, readFileSync(file, 'utf8').replace('status: open', 'status: blocked'))
    later(file)
    await taskAuthoringService.setStatus(SCOPE, task.id, 'completed')
    await settle()
    expect(readFileSync(file, 'utf8')).toContain('status: blocked')
    // Lost, not owed: the marker is cleared rather than retried.
    expect(taskRepo.getById(USER, task.id)?.remoteDirty ?? []).not.toContain('status')
    await taskSyncService.pull(USER)
    expect(taskService.getById(USER, task.id)).toMatchObject({ status: 'blocked', statusLabel: 'blocked' })
  })

  it('lets the file win its status word even when a pull landed between the local move and its push', async () => {
    const task = await taskAuthoringService.createRouted(SCOPE, { title: 'Held', status: 'open', assignee: { kind: 'agent', agentId: 'bare-1' } })
    const file = join(tasksDir, 'held.md')
    const pushes = vi.spyOn(taskSyncService, 'push').mockResolvedValue(undefined)
    try {
      await taskAuthoringService.setStatus(SCOPE, task.id, 'completed')
      await settle()
    } finally {
      pushes.mockRestore()
    }
    expect(taskRepo.getById(USER, task.id)?.remoteDirty).toContain('status')
    writeFileSync(file, readFileSync(file, 'utf8').replace('status: open', 'status: blocked'))
    later(file)
    await taskSyncService.pull(USER)
    await taskSyncService.push(USER, task.id)
    expect(readFileSync(file, 'utf8')).toContain('status: blocked')
    await taskSyncService.pull(USER)
    expect(taskService.getById(USER, task.id)).toMatchObject({ status: 'blocked', statusLabel: 'blocked' })
  })

  it('writes the status when the file changed another field but not its status word', async () => {
    const task = await taskAuthoringService.createRouted(SCOPE, { title: 'Original', status: 'open', assignee: { kind: 'agent', agentId: 'bare-1' } })
    const file = join(tasksDir, 'original.md')
    writeFileSync(file, readFileSync(file, 'utf8').replace('title: Original', 'title: From the editor'))
    later(file)
    await taskAuthoringService.setStatus(SCOPE, task.id, 'completed')
    await settle()
    expect(readFileSync(file, 'utf8')).toContain('status: completed')
    expect(readFileSync(file, 'utf8')).toContain('title: From the editor')
    await taskSyncService.pull(USER)
    expect(taskService.getById(USER, task.id)).toMatchObject({ status: 'completed', title: 'From the editor' })
  })

  it('refuses a word that does not mean that status in that folder, and a word for a native task', async () => {
    const task = await taskAuthoringService.createRouted(SCOPE, { title: 'Words', assignee: { kind: 'agent', agentId: 'bare-1' } })
    await expect(taskAuthoringService.setStatus(SCOPE, task.id, 'open', 'done')).rejects.toThrow('not a open word')
    const native = await taskAuthoringService.createRouted(SCOPE, { title: 'Native' })
    await expect(taskAuthoringService.setStatus(SCOPE, native.id, 'open', 'ready')).rejects.toThrow('takes a status word')
    expect(taskService.getById(USER, task.id).status).toBe('new')
  })

  it('answers the folder board for a bare agent and null for any other', async () => {
    put('a.md', '---\ntitle: A\nstatus: Doing\n---\n')
    expect(await taskSyncService.folderBoard(USER, 'bare-1')).toEqual([
      { label: 'Doing', category: 'active', status: 'in_progress', droppable: false }
    ])
    expect(await taskSyncService.folderBoard(USER, 'kit-1')).toBeNull()
  })

  it('gives the board a column for the status of any other task of that agent, in category order', async () => {
    put('_board.yaml', 'Shipped: done\n')
    put('a.md', '---\ntitle: A\nstatus: todo\n---\n')
    await taskSyncService.pull(USER)
    // A task of this agent that is not a file (native, a handover's, a delegation's).
    taskRepo.create(USER, { title: 'Native', goal: 'g', status: 'blocked', assigneeAgentId: 'bare-1', assigneeKind: 'agent' })
    // Another agent's task adds nothing.
    taskRepo.create(USER, { title: 'Other', goal: 'g', status: 'error', assigneeAgentId: 'kit-1', assigneeKind: 'agent' })
    expect((await taskSyncService.folderBoard(USER, 'bare-1'))!.map((column) => [column.label, column.droppable])).toEqual([
      ['todo', true], ['blocked', false], ['Shipped', true]
    ])
  })
})

describe('task:delete of a folder task', () => {
  it('deletes the task and its file, found by id after a rename, and leaves every other file', async () => {
    put('a.md', '---\nid: t-1\ntitle: A\n---\n')
    const other = put('b.md', '---\nid: t-2\ntitle: B\n---\n')
    await taskSyncService.pull(USER)
    const id = taskRepo.list(USER).find((row) => row.title === 'A')!.id
    renameSync(join(tasksDir, 'a.md'), join(tasksDir, 'renamed.md'))
    await taskSyncService.removeTask(USER, id)
    expect(taskRepo.getById(USER, id)?.deletedAt).not.toBeNull()
    expect(existsSync(join(tasksDir, 'renamed.md'))).toBe(false)
    expect(existsSync(other)).toBe(true)
  })

  it('leaves a file that no longer carries the task’s id, and is fine with a file already gone', async () => {
    const path = put('a.md', '---\nid: t-1\ntitle: A\n---\n')
    put('c.md', '---\nid: t-3\ntitle: C\n---\n')
    await taskSyncService.pull(USER)
    const rows = taskRepo.list(USER)
    const a = rows.find((row) => row.title === 'A')!.id
    const c = rows.find((row) => row.title === 'C')!.id
    // Somebody rewrote a.md as another task: it is not t-1's any more.
    writeFileSync(path, '---\nid: t-9\ntitle: Somebody else’s\n---\n')
    later(path)
    await taskSyncService.removeTask(USER, a)
    expect(readFileSync(path, 'utf8')).toContain('id: t-9')
    rmSync(join(tasksDir, 'c.md'))
    await expect(taskSyncService.removeTask(USER, c)).resolves.toBeDefined()
    expect(taskRepo.getById(USER, c)?.deletedAt).not.toBeNull()
  })

  it('keeps the task deleted when its file cannot be removed, and a later pull does not bring it back', async () => {
    const path = put('a.md', '---\nid: t-1\ntitle: A\n---\n')
    await taskSyncService.pull(USER)
    const id = only().id
    chmodSync(tasksDir, 0o555)
    try {
      await taskSyncService.removeTask(USER, id)
      expect(existsSync(path)).toBe(true)
      expect(taskRepo.getById(USER, id)?.deletedAt).not.toBeNull()
      await taskSyncService.pull(USER)
      await passLater()
      expect(taskRepo.list(USER)).toEqual([])
    } finally {
      chmodSync(tasksDir, 0o755)
    }
  })

  it('never touches the file for a device-sync tombstone', async () => {
    const path = put('a.md', '---\nid: t-1\ntitle: A\n---\n')
    await taskSyncService.pull(USER)
    taskService.removeSyncedTask(USER, only().id)
    await settle()
    expect(existsSync(path)).toBe(true)
  })
})

describe('the folder is a home, not a hand-off target', () => {
  it('is never the preferred adapter, and refuses a hand-off of its own task', async () => {
    expect(await taskSyncService.preferredAdapterId(USER)).toBeNull()
    const remote = createFakeRemote({ id: 'fake-service' })
    holder.adapters = [...holder.adapters, remote.adapter]
    expect(await taskSyncService.preferredAdapterId(USER)).toBe('fake-service')
    const task = await taskAuthoringService.createRouted(SCOPE, { title: 'Stay home', assignee: { kind: 'agent', agentId: 'bare-1' } })
    await expect(taskSyncService.handOff(USER, task.id)).rejects.toThrow('can’t be handed off')
  })
})

describe('a comment appended to a folder task’s log', () => {
  it('is not taken for an outside change when a pull read the file before the append and stored after it', async () => {
    const task = await taskAuthoringService.createRouted(SCOPE, { title: 'Logged', assignee: { kind: 'agent', agentId: 'bare-1' } })
    const file = join(tasksDir, 'logged.md')
    await settle()
    later(file)
    await taskSyncService.pull(USER)
    expect(taskService.getById(USER, task.id).fromOutside).toBe(false)

    // The pull reads the file, then the append runs to the end before the pull stores what it read.
    const adapter = holder.adapters[0]
    const list = adapter.list.bind(adapter)
    let appended = false
    adapter.list = async (...args: Parameters<typeof list>) => {
      const read = await list(...args)
      if (!appended) {
        appended = true
        await taskSyncService.appendLog(USER, task.id, '**Uploader** · 2026-10-03 10:00 UTC\nStarted.')
      }
      return read
    }
    // Cinna's own edit is in the file, so the pull has a new digest to store.
    taskAuthoringService.update(SCOPE, task.id, { title: 'Logged again' })
    await settle()
    await taskSyncService.pull(USER)
    expect(appended).toBe(true)
    expect(readFileSync(file, 'utf8')).toContain('Started.')
    await taskSyncService.pull(USER)
    expect(taskService.getById(USER, task.id).fromOutside).toBe(false)
  })
})

describe('trust in outside content', () => {
  it('is not laundered by a Cinna push: a task dragged to Ready still asks, and once approved stays trusted across pulls', async () => {
    const { createTaskDispatchService } = await import('./taskDispatchService')
    const { chatRepo } = await import('../db/chats')
    put('_board.yaml', 'Icebox: backlog\nUp Next: ready\nStuck: waiting\n')
    const file = put('outside.md', '---\nid: t-out\ntitle: Outside job\nstatus: Icebox\n---\nDo the outside thing.\n')
    await taskSyncService.pull(USER)
    const task = only()
    expect(task).toMatchObject({ status: 'new', fromOutside: true })

    // The user drags it to Ready: Cinna writes the status word into the file.
    // Mutation: trust every Cinna write (the old rule) → it reads as Cinna's own here.
    await taskAuthoringService.setStatus(SCOPE, task.id, 'open')
    await settle()
    expect(readFileSync(file, 'utf8')).toContain('status: Up Next')
    later(file)
    await taskSyncService.pull(USER)
    expect(taskService.getById(USER, task.id)).toMatchObject({ status: 'open', fromOutside: true })

    const started: string[] = []
    const dispatcher = createTaskDispatchService({
      agents: async () => [{ id: 'bare-1', name: 'Uploader', path: holder.agentPath }],
      async start(_scope, taskId, agentId) {
        const chat = chatRepo.create(USER, { agentId })
        taskService.beginDesktopChat(USER, taskId, chat.id, { kind: 'agent', agentId, name: 'Uploader' })
        started.push(taskId)
        return { chatId: chat.id, runId: 'run-1', completed: new Promise(() => {}) }
      },
      resume: async () => { throw new Error('No answer is sent in this test.') },
      chatRunning: () => false,
      withSlot: (_agentId, _signal, run) => run(),
      slotFree: () => true,
      trust: (userId, taskId, digest) => taskSyncService.trustLocalContent(userId, taskId, digest),
      refreshTask: async () => {},
      liveAgentIds: () => [],
      publish: () => {}
    })
    try {
      // It still asks before running.
      const asked = await dispatcher.runNext(SCOPE, 'bare-1', task.id)
      expect(asked).toMatchObject({ ok: true, gate: expect.any(String) })
      expect(started).toEqual([])

      // Approved: it runs, and the binding trusts it too.
      // Mutation: trust only the task row → the next pull untrusts it again.
      const answer = await dispatcher.answerGate(SCOPE, (asked as { gate: string }).gate, 'approve')
      expect(answer).toMatchObject({ ok: true, started: { taskId: task.id } })
      expect(started).toEqual([task.id])
      await settle()
      later(file)
      await taskSyncService.pull(USER)
      expect(taskService.getById(USER, task.id).fromOutside).toBe(false)

      // A Cinna write onto trusted content stays trusted, after a restart too.
      taskService.setStatus(USER, task.id, 'blocked')
      await settle()
      expect(readFileSync(file, 'utf8')).toContain('status: Stuck')
      holder.adapters = [folderAdapter()]
      taskSyncService.resetCursors()
      later(file)
      await taskSyncService.pull(USER)
      expect(taskService.getById(USER, task.id)).toMatchObject({ status: 'blocked', fromOutside: false })

      // And an outside edit after that is outside again.
      writeFileSync(file, readFileSync(file, 'utf8').replace('Do the outside thing.', 'Do something else.'))
      later(file)
      await taskSyncService.pull(USER)
      expect(taskService.getById(USER, task.id).fromOutside).toBe(true)
    } finally {
      dispatcher.shutdown()
    }
  })
})
