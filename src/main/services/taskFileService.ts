/**
 * The handoff note as a file on disk — `<userData>/tasks/<task-id>.md`, with
 * the task's identity in frontmatter and the note as the body.
 *
 * **The database is the note; this is a view of it.** Nothing is ever read back
 * in (phase 5), nothing branches on whether the file exists, and a write that
 * fails is logged and forgotten. The file exists so that something outside the
 * app — an assistant working in a folder, a person looking — can read what the
 * last agent left behind without going through the UI. `taskService` is the
 * only writer, and it writes on every change that the frontmatter names, so a
 * file that exists is current rather than a snapshot of whenever the note was
 * last edited.
 *
 * **Why `<userData>` and not the agent folder.** §5.11 of the phase plan puts
 * this at `app-data/storage/tasks/<id>.md` so a folder agent could read it from
 * its cwd. That path is inside the agent's own runtime storage, and Invariant 2
 * is that exactly one file in an agent folder belongs to the desktop
 * (`app-data/desktop.json`, declared in the kit contract's `desktop_owned`) —
 * a list this repo cannot durably widen, because a contract refresh replaces
 * `layout.json` from the linked Cinna instance. It would also have written
 * nothing at all for the assignees most tasks have: a bare agent's folder is
 * never written into, and an A2A agent or a model has no folder. So the file
 * lives beside the desktop's other per-install state, on the same precedent as
 * a bare agent's desktop state under `<userData>/external-agents/`. What
 * carries the note *to* an agent is phase 6's catch-up packet, which sends the
 * string rather than the path.
 */

import { app } from 'electron'
import { mkdirSync, readdirSync, renameSync, statSync, unlinkSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { formatFrontmatter } from '../kit/miniYaml'
import { createLogger } from '../logger/logger'
import type { TaskDto } from '../../shared/tasks'

const logger = createLogger('task-file')

/**
 * A task id is a nanoid here, but it is also whatever a sync payload carried
 * (`taskRepo.create` accepts an `id` so a pull can upsert a replica under the
 * peer's). This is the only place one becomes a path segment, so it is the
 * place that checks — `..` and a separator are the two that matter.
 */
const SAFE_ID = /^[A-Za-z0-9_-]{1,128}$/

/**
 * Ids already complained about.
 *
 * Without it the warning fires on **every subsequent write** to that task — and
 * the export hangs off every write — filling the log the user can open with a
 * condition they cannot act on. One line per id says the same thing once.
 *
 * Capped, because the ids that land here come from payloads this process did
 * not write: a peer sending a thousand malformed rows should not also cost a
 * thousand retained strings. Past the cap nothing new is remembered, so the
 * warning starts repeating again — which is the right way round, since by then
 * something is genuinely wrong.
 */
const COMPLAINT_CAP = 100
const complainedAbout = new Set<string>()

/** `<userData>/tasks`, or null when Electron is not there to say where that is. */
function tasksRoot(): string | null {
  try {
    return join(app.getPath('userData'), 'tasks')
  } catch (err) {
    // Reached only outside a running app: `app.getPath('userData')` is
    // available before `whenReady` and throws only for an unknown path name or
    // when there is no `app` at all — a unit test that has not mocked Electron.
    // `desktopStateService` has the same try/catch for the same reason; null
    // rather than its `tmpdir()` fallback, because a fallback that did fire
    // would write real notes somewhere nobody will look for them.
    //
    // Logged at `debug` so that if it ever *did* fire in production, the export
    // going completely silent is at least visible — the sibling failure (an
    // unusable id) warns, and a silent no-op beside a loud one is the pair that
    // wastes an afternoon.
    logger.debug('no userData path; the handoff note will not be exported', {
      error: err instanceof Error ? err.message : String(err)
    })
    return null
  }
}

/** The prefix every in-flight write's temp file shares. */
const TEMP_PREFIX = '.handoff.'
const TEMP_SUFFIX = '.tmp'
/** A temp file older than this cannot belong to a write still in flight. */
const STALE_TEMP_MS = 60_000

/**
 * Remove temp files left behind by a write killed between `open` and `rename`.
 *
 * The `catch` below can only unlink on a *caught* failure; a crash, a SIGKILL
 * or a power loss leaves one there for ever. That matters more here than in
 * most places: this folder exists to be read from outside the app, so an orphan
 * is a second, truncated file sitting beside the real one for whoever is
 * reading. `manifestIo` learned the same thing about an agent folder and the
 * sweep is copied from it, dot-prefix and all.
 *
 * Anything younger than {@link STALE_TEMP_MS} is left alone: it may belong to a
 * write happening right now.
 */
function sweepStaleTemps(dir: string): void {
  let entries: string[]
  try {
    entries = readdirSync(dir)
  } catch {
    return // no folder yet, or unreadable; either way there is nothing to sweep
  }
  const cutoff = Date.now() - STALE_TEMP_MS
  for (const entry of entries) {
    if (!entry.startsWith(TEMP_PREFIX) || !entry.endsWith(TEMP_SUFFIX)) continue
    const path = join(dir, entry)
    try {
      if (statSync(path).mtimeMs < cutoff) unlinkSync(path)
    } catch {
      /* it went on its own, or is not ours to remove */
    }
  }
}

/**
 * Write the file so no reader can ever see half of it: a temp beside it, then a
 * rename, which is atomic within a directory.
 *
 * **No `fsync`.** The tree's two other copies of this helper have one, and both
 * are right to: an agent folder's `desktop.json` and its manifest are the only
 * record of what they hold. This file is not — it is a view of a row that is
 * already committed, nothing reads it back, and a note lost to a power cut is
 * rewritten by the next task write. What `fsync` would buy here is nothing, and
 * what it costs is the one syscall in this sequence with unbounded tail
 * latency: `taskService.setStatus` is reached from `inboxService.recordRunEvent`,
 * which runs on the **send path before the event reaches the renderer**, so on
 * an encrypted, networked or busy disk it would stall a turn's events behind a
 * flush nobody needs.
 *
 * `writeFileSync` and not `writeSync`: a `write(2)` that placed only some of the
 * bytes returns the short count with no error, and execution would carry on to
 * the rename and publish a file cut mid-frontmatter — which `parseFrontmatter`
 * reads as no frontmatter at all, a file that exists and cannot be parsed,
 * strictly worse than the missing one this design is willing to accept.
 * `writeFileSync` loops until the whole string is down.
 */
function writeAtomically(path: string, contents: string): void {
  const dir = dirname(path)
  mkdirSync(dir, { recursive: true })
  sweepStaleTemps(dir)
  const temp = join(dir, `${TEMP_PREFIX}${process.pid}.${Date.now()}${TEMP_SUFFIX}`)
  try {
    writeFileSync(temp, contents)
    renameSync(temp, path)
  } catch (err) {
    try {
      unlinkSync(temp)
    } catch {
      /* the temp file may never have been created */
    }
    throw err
  }
}

export const taskFileService = {
  /** Where this task's note is, or null when the id cannot be one. */
  handoffPath(taskId: string): string | null {
    const root = tasksRoot()
    if (!root) return null
    if (!SAFE_ID.test(taskId)) {
      if (!complainedAbout.has(taskId)) {
        if (complainedAbout.size < COMPLAINT_CAP) complainedAbout.add(taskId)
        logger.warn('task id cannot be a filename', { taskId })
      }
      return null
    }
    return join(root, `${taskId}.md`)
  },

  /**
   * Bring the file into line with the task: written when there is a note,
   * removed when there is not.
   *
   * **Never throws.** It is called from inside `taskService` after the row is
   * already committed, so a full disk or a read-only home must not turn a
   * successful status change into a failed one — the same trade `jobService`'s
   * best-effort task write makes, and for the same reason: a visible wrong
   * status is worse than an invisible missing file.
   */
  exportHandoff(task: TaskDto): void {
    const path = this.handoffPath(task.id)
    if (!path) return
    if (task.handoffNote === null || task.handoffNote.trim() === '') {
      this.removeHandoff(task.id)
      return
    }

    const body = task.handoffNote.endsWith('\n') ? task.handoffNote : `${task.handoffNote}\n`
    try {
      writeAtomically(
        path,
        formatFrontmatter(
          {
            id: task.id,
            title: task.title,
            status: task.status,
            assignee: task.assignee.name,
            parent: task.parentTaskId,
            updated: task.updatedAt.toISOString(),
            // Absent rather than null when the task is bound to nothing: an
            // unbound task has no short code, which is not the same claim as
            // "its short code is empty".
            shortCode: task.remote?.key ?? undefined
          },
          body
        )
      )
    } catch (err) {
      // The message, not the error: `logger.serializeData` unwraps an `Error`
      // only at the top level, and `redact` then walks own-enumerable
      // properties — of which a plain `Error` has none — so `error: err` logs
      // as `{}`. On a path deliberately designed to be invisible, that is the
      // whole diagnostic. Both sibling best-effort writes do it this way.
      logger.warn('could not export the handoff note', {
        taskId: task.id,
        error: err instanceof Error ? err.message : String(err)
      })
    }
  },

  /** The note is gone, or the task is. Absent is the goal, so ENOENT is success. */
  removeHandoff(taskId: string): void {
    const path = this.handoffPath(taskId)
    if (!path) return
    try {
      unlinkSync(path)
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return
      logger.warn('could not remove the handoff note', {
        taskId,
        error: err instanceof Error ? err.message : String(err)
      })
    }
  }
}
