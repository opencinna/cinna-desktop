import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  utimesSync,
  writeFileSync
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

/**
 * The handoff note as a file, over a real temp `userData`.
 *
 * Nothing is mocked below Electron's path lookup on purpose: what this service
 * does *is* filesystem work, and a mocked `fs` would assert that the code calls
 * `writeFileSync`, not that the note comes back out of a real file. The one
 * assertion that matters runs the whole way round — write the file, read it
 * with the same `parseFrontmatter` the kit uses on STATUS.md, and compare.
 */

const holder = vi.hoisted(() => ({ userData: '' }))

vi.mock('electron', () => ({
  app: {
    getPath: (name: string) => {
      if (name !== 'userData') throw new Error(`unexpected path request: ${name}`)
      return holder.userData
    }
  }
}))

const warnings = vi.hoisted(() => ({
  entries: [] as Array<{ message: string; data?: Record<string, unknown> }>
}))
vi.mock('../logger/logger', () => ({
  createLogger: () => ({
    debug: () => {},
    info: () => {},
    warn: (message: string, data?: Record<string, unknown>) =>
      warnings.entries.push({ message, data }),
    error: () => {}
  })
}))

const { taskFileService } = await import('./taskFileService')
const { parseFrontmatter } = await import('../kit/miniYaml')

type Task = Parameters<typeof taskFileService.exportHandoff>[0]

const UPDATED = new Date('2026-09-11T10:15:00.000Z')

function makeTask(overrides: Partial<Task> = {}): Task {
  return {
    id: 'tsk_abcdef',
    title: 'Reconcile payouts',
    goal: 'Reconcile payouts for the last 7 days',
    description: null,
    status: 'in_progress',
    priority: 'normal',
    router: 'direct',
    origin: 'local',
    executor: 'desktop',
    executorDevice: null,
    chatId: null,
    assignee: { agentId: 'agt_1', name: 'Ledger agent', kind: 'agent' },
    parentTaskId: null,
    subtaskCount: 0,
    subtaskCompletedCount: 0,
    remote: null,
    handoffNote: 'Checked the ledger. Two invoices are missing a PO.',
    artifacts: [],
    budget: null,
    errorMessage: null,
    jobId: null,
    jobRunId: null,
    createdAt: UPDATED,
    updatedAt: UPDATED,
    startedAt: null,
    finishedAt: null,
    ...overrides
  } as Task
}

beforeEach(() => {
  holder.userData = mkdtempSync(join(tmpdir(), 'cinna-tasks-'))
  warnings.entries = []
})

afterEach(() => {
  if (holder.userData) rmSync(holder.userData, { recursive: true, force: true })
})

function read(taskId = 'tsk_abcdef'): string {
  return readFileSync(join(holder.userData, 'tasks', `${taskId}.md`), 'utf8')
}

describe('taskFileService.exportHandoff', () => {
  it('writes the note under <userData>/tasks and reads back as frontmatter plus body', () => {
    taskFileService.exportHandoff(makeTask())

    const parsed = parseFrontmatter(read())
    expect(parsed).not.toBeNull()
    expect(parsed!.issues).toEqual([])
    expect(parsed!.data).toEqual({
      id: 'tsk_abcdef',
      title: 'Reconcile payouts',
      status: 'in_progress',
      assignee: 'Ledger agent',
      parent: null,
      updated: '2026-09-11T10:15:00.000Z'
    })
    expect(parsed!.body).toBe('Checked the ledger. Two invoices are missing a PO.\n')
  })

  /**
   * The short code is the bound remote's key, and an unbound task does not have
   * one. Absent rather than `null`, because a reader that sees `shortCode: null`
   * has been told the task has an empty short code, which is a different claim
   * from "this task is not on a service".
   */
  it('carries the short code only when the task is bound to a service', () => {
    taskFileService.exportHandoff(makeTask())
    expect(parseFrontmatter(read())!.data).not.toHaveProperty('shortCode')

    taskFileService.exportHandoff(
      makeTask({ remote: { adapter: 'cinna', id: 'r1', key: 'TASK-12', url: null } })
    )
    expect(parseFrontmatter(read())!.data.shortCode).toBe('TASK-12')
  })

  it('keeps a title that would otherwise be read as something else', () => {
    taskFileService.exportHandoff(makeTask({ title: 'Invoices #12 and #14: chase by 5' }))
    expect(parseFrontmatter(read())!.data.title).toBe('Invoices #12 and #14: chase by 5')
  })

  it('says who it is assigned to, or says nobody', () => {
    taskFileService.exportHandoff(
      makeTask({ assignee: { agentId: null, name: null, kind: 'agent' } })
    )
    expect(parseFrontmatter(read())!.data.assignee).toBeNull()
  })

  it('names the parent when the task has one', () => {
    taskFileService.exportHandoff(makeTask({ parentTaskId: 'tsk_parent' }))
    expect(parseFrontmatter(read())!.data.parent).toBe('tsk_parent')
  })

  it('ends the body with a newline whether or not the note did', () => {
    taskFileService.exportHandoff(makeTask({ handoffNote: 'no trailing newline' }))
    expect(read().endsWith('no trailing newline\n')).toBe(true)

    taskFileService.exportHandoff(makeTask({ handoffNote: 'already has one\n' }))
    expect(read().endsWith('already has one\n')).toBe(true)
  })

  it('keeps a multi-line note whole in the body', () => {
    const note = '## What was done\n\n- read the ledger\n- flagged two invoices\n'
    taskFileService.exportHandoff(makeTask({ handoffNote: note }))
    expect(parseFrontmatter(read())!.body).toBe(note)
  })

  /**
   * Clearing the note is how a handoff ends, and a file left behind would go on
   * telling the next reader about work that is no longer being handed over.
   */
  it('removes the file when the note is cleared', () => {
    taskFileService.exportHandoff(makeTask())
    expect(existsSync(join(holder.userData, 'tasks', 'tsk_abcdef.md'))).toBe(true)

    taskFileService.exportHandoff(makeTask({ handoffNote: null }))
    expect(existsSync(join(holder.userData, 'tasks', 'tsk_abcdef.md'))).toBe(false)
  })

  it('treats a whitespace-only note as no note', () => {
    taskFileService.exportHandoff(makeTask({ handoffNote: '   \n  ' }))
    expect(existsSync(join(holder.userData, 'tasks', 'tsk_abcdef.md'))).toBe(false)
  })

  it('replaces the previous note rather than appending to it', () => {
    taskFileService.exportHandoff(makeTask({ handoffNote: 'first' }))
    taskFileService.exportHandoff(makeTask({ handoffNote: 'second' }))
    expect(read()).not.toContain('first')
    expect(parseFrontmatter(read())!.body).toBe('second\n')
  })

  it('leaves no temp file behind', () => {
    taskFileService.exportHandoff(makeTask())
    expect(readdirSync(join(holder.userData, 'tasks'))).toEqual(['tsk_abcdef.md'])
  })

  /**
   * The `catch` in `writeAtomically` can only unlink on a *caught* failure. A
   * crash, a SIGKILL or a power loss between `open` and `rename` leaves the
   * temp file there for ever — and this folder's whole purpose is being read
   * from outside, so an orphan is a second, truncated file sitting beside the
   * real one for whoever is reading. `manifestIo` sweeps for the same reason.
   */
  it('sweeps a temp file an earlier write was killed in the middle of', () => {
    const dir = join(holder.userData, 'tasks')
    mkdirSync(dir, { recursive: true })
    const orphan = join(dir, '.handoff.999.1757577600000.tmp')
    writeFileSync(orphan, '---\nid: "half a fi')
    const old = new Date(Date.now() - 5 * 60_000)
    utimesSync(orphan, old, old)

    taskFileService.exportHandoff(makeTask())
    expect(readdirSync(dir)).toEqual(['tsk_abcdef.md'])
  })

  /** A write happening right now is not an orphan, whoever is doing it. */
  it('leaves a temp file young enough to belong to a live write alone', () => {
    const dir = join(holder.userData, 'tasks')
    mkdirSync(dir, { recursive: true })
    const live = join(dir, '.handoff.999.1757577600000.tmp')
    writeFileSync(live, 'a write in flight')

    taskFileService.exportHandoff(makeTask())
    expect(readdirSync(dir).sort()).toEqual(['.handoff.999.1757577600000.tmp', 'tsk_abcdef.md'])
  })

  /**
   * `taskRepo.create` accepts an id so a pull can upsert a replica under the
   * one the sync payload carried — so this is the only place a value from
   * another machine becomes a path segment, and the only place that can refuse.
   */
  it.each([
    ['a traversal', '../../../etc/passwd'],
    ['a separator', 'a/b'],
    ['a dot segment', '..'],
    ['an empty id', ''],
    ['a space', 'tsk 1']
  ])('refuses %s as a filename and writes nothing', (_label, id) => {
    taskFileService.exportHandoff(makeTask({ id }))
    expect(existsSync(join(holder.userData, 'tasks'))).toBe(false)
    // **And nothing above it either.** `<userData>/tasks` being absent is true
    // whether or not the guard exists for the traversal cases — the path
    // resolves outside that directory — so the assertion that makes this test's
    // name true is that the guard wrote nowhere at all.
    expect(readdirSync(holder.userData)).toEqual([])
    expect(warnings.entries.some((w) => w.message.includes('cannot be a filename'))).toBe(true)
  })

  /**
   * The export runs on every task write, so a warning per write would fill the
   * log the user can open with a condition they cannot act on.
   */
  it('says an id is unusable once, not on every write', () => {
    // An id no other test in this file uses: the record of what has been
    // complained about is module state and outlives a test, which is what makes
    // it useful in the running app and order-dependent here.
    const task = makeTask({ id: 'only/this/test' })
    taskFileService.exportHandoff(task)
    taskFileService.exportHandoff(task)
    taskFileService.exportHandoff(task)
    expect(warnings.entries.filter((w) => w.message.includes('cannot be a filename'))).toHaveLength(
      1
    )
  })

  /**
   * The `catch` in `writeAtomically` is the only thing that removes a temp file
   * for a failure it *can* see, and the success-path test cannot reach it.
   * A directory where the note should go makes the rename fail with the temp
   * already written.
   */
  it('cleans up its temp file when the rename fails', () => {
    mkdirSync(join(holder.userData, 'tasks', 'tsk_abcdef.md'), { recursive: true })

    expect(() => taskFileService.exportHandoff(makeTask())).not.toThrow()
    expect(readdirSync(join(holder.userData, 'tasks'))).toEqual(['tsk_abcdef.md'])
  })

  /**
   * The row is already committed by the time this runs, so a failure here must
   * not become the caller's failure — the same trade `jobService`'s best-effort
   * task write makes. A read-only tasks directory is the cheapest real version
   * of a full disk.
   */
  it('does not throw when the file cannot be written', () => {
    // A directory where the note should go: the rename fails with the temp
    // already written, which is a real failure of the real write path.
    //
    // **Not `chmodSync(dir, 0o500)`**, which was the first version of this: a
    // permission bit is a no-op for uid 0, so under a root CI container the
    // write would succeed and this test would go red while staying green on
    // every developer machine — a failure that reads as a regression and is not
    // one. Nothing here depends on the uid.
    mkdirSync(join(holder.userData, 'tasks', 'tsk_abcdef.md'), { recursive: true })

    expect(() => taskFileService.exportHandoff(makeTask())).not.toThrow()
    const warning = warnings.entries.find((w) => w.message.includes('could not export'))
    expect(warning).toBeDefined()
    // **The message, not the error object.** `logger.serializeData` unwraps an
    // `Error` only at the top level and `redact` walks own-enumerable
    // properties, of which a plain `Error` has none — so `error: err` reaches
    // the log as `{}`, and this is the only diagnostic a deliberately silent
    // path ever produces.
    expect(typeof warning!.data?.error).toBe('string')
    expect(warning!.data?.error).not.toBe('')
  })
})

describe('taskFileService.removeHandoff', () => {
  it('removes the file', () => {
    taskFileService.exportHandoff(makeTask())
    taskFileService.removeHandoff('tsk_abcdef')
    expect(existsSync(join(holder.userData, 'tasks', 'tsk_abcdef.md'))).toBe(false)
  })

  /** Absent is the goal, so a task that never had a note is already there. */
  it('is silent when there was never a file', () => {
    taskFileService.removeHandoff('tsk_never')
    expect(warnings.entries).toEqual([])
  })
})

describe('taskFileService.handoffPath', () => {
  it('is under <userData>/tasks, named for the task', () => {
    expect(taskFileService.handoffPath('tsk_abcdef')).toBe(
      join(holder.userData, 'tasks', 'tsk_abcdef.md')
    )
  })
})
