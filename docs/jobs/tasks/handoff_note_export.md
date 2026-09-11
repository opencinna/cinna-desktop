# The Handoff Note, Exported

## Purpose

A task's handoff note — the markdown one worker leaves for the next — is also written to a file under `<userData>/tasks/<task-id>.md`, with the task's identity in YAML frontmatter and the note as the body. It exists so something outside the app (an assistant working in a folder, a person looking) can read what the last agent left behind without going through the UI.

## Core Concepts

- **Task** — a row in the desktop's own `tasks` table (`TaskDto` in `src/shared/tasks.ts`): a title, a goal, a status, an assignee, an executor, optionally a parent and optionally a binding to a remote service. `taskService` (`src/main/services/taskService.ts`) is the only writer of that table
- **Handoff note** — `tasks.handoff_note`, markdown, rewritten at each handoff. Null for a task nobody has left one on
- **Exported note** — the file. **The database is the note; the file is a view of it.** Nothing is ever read back in, nothing branches on whether the file exists, and a write that fails is logged and forgotten
- **Short code** — a bound task's human-facing key on the remote service (`TaskDto.remote.key`). Display only

## What the file contains

Frontmatter, in this order, then the note as the body:

| Key | Value |
|-----|-------|
| `id` | the task id |
| `title` | the task title |
| `status` | the task status, verbatim |
| `assignee` | the assignee's display name, or `null` when nobody is named |
| `parent` | the parent task's **local** id, or `null` for a top-level task |
| `updated` | `updatedAt`, ISO-8601 |
| `shortCode` | **omitted entirely** unless the task is bound to a service that gave it a key |

`shortCode` is absent rather than `null` for an unbound task, because "this task is on no service" is not the same claim as "its short code is empty". `assignee` and `parent` do say `null`, because there the absence is the answer.

The body is the note, always terminated with a newline whether or not the note was.

## Business Rules

- **The export hangs off every `taskService` write, not only the note write.** Five of the frontmatter fields — `title`, `status`, `assignee`, `parent`, `updated` — change from somewhere other than the note, and **nothing ever reads the file back**, so nothing would ever correct a stale one. Exporting only when the note was edited would have left a file claiming `in_progress` under a task that finished an hour ago, which is worse than no file at all. Nine of `taskService`'s tails return through the `written(row)` helper; the two that return a DTO without writing are the no-ops (an `update` with an empty patch, an `applyRunState` that finds nothing to act on), which changed no row and so can change no file.
- **The guarantee is exactly as wide as the service.** Every claim above holds because `taskService` is the only writer of the `tasks` table — a write that went through `taskRepo` directly would skip the export, and a write to a soft-deleted row would *resurrect* its file, since the tombstone is enforced by the service's own lookup and not by the repo. Anything that later writes tasks (a device-sync apply, a remote reconciler) has to go through the service or bring that protection with it.
- **A file that exists is current.** That is the whole property the rule above buys, and it is what a reader outside the app is entitled to assume.
- **No note means no file.** A note that is null, or that is only whitespace, removes the file rather than writing an empty one — so clearing a note is also the delete path.
- **Deleting a task removes the file.** The row survives as a tombstone for sync; the file is a view of a task the user can no longer open, so it goes. A soft delete is still a delete to anything reading the folder.
- **The export never throws.** It runs after the row is already committed, so a full disk or a read-only home must not turn a successful status change into a failed one — a visible wrong status is worse than an invisible missing file. A failure is logged with the error's *message*, since a bare `Error` serializes to `{}` on this logger and this path is deliberately invisible otherwise.
- **A task id is validated before it becomes a path segment.** Ids are usually nanoids, but a task row can be created under an id a sync payload carried, which makes this the only place a value from another machine becomes a filename. Anything outside `[A-Za-z0-9_-]{1,128}` is refused and nothing is written. The warning fires **once per id** (capped at 100 remembered ids), because the export runs on every write and a repeating warning about a condition the user cannot act on just fills the log they would otherwise read.
- **Writes are atomic, and orphaned temp files are swept.** A temp file beside the target, then a rename. A write killed between the two leaves an orphan that no catch block can clean up, and this folder exists to be read from outside the app — so a second, truncated file sitting beside the real one is exactly the confusion to avoid. The next write sweeps temp files older than 60 seconds; younger ones may belong to a write happening right now.
- **No `fsync`, unlike the two sibling writers in this tree.** An agent folder's manifest and its `desktop.json` are the only record of what they hold; this file is not — it is a view of a committed row, and a note lost to a power cut is rewritten by the next task write. What the flush would cost is real: the export is reached from `setStatus`, which the inbox reaches through `applyRunState` while mirroring a run event, on the send path *before* the event reaches the renderer. On an encrypted or busy disk that is a turn's events stalled behind a flush nobody needs.

## Why `<userData>` and not the agent's folder

The obvious home is inside the agent folder that is going to read it. It is not used, for three reasons:

- **Exactly one file in an agent folder belongs to the desktop** — `app-data/desktop.json`, declared as `desktop_owned` in the [kit contract](../../agents/local_agents/kit_contract.md)'s `layout.json`. That list cannot be widened from this repo durably: a workshop's own `.cinna-kit/` copy wins, and a contract refresh replaces it from the linked Cinna instance.
- **Most assignees have no folder to write into.** A bare agent's folder is never written into at all, and an A2A agent or a local model has no folder in the first place — so a folder-relative path would have written nothing for the majority of tasks.
- The precedent is already there: a bare agent's Desktop State lives under `<userData>/external-agents/` for this same tension.

## What this deliberately does not do

- **It does not import.** There is no reader, no watcher, no reconciliation. Editing the file changes nothing and will be overwritten by the next task write.
- **It does not deliver the note to anybody.** Getting the note in front of an agent is a different mechanism: for a task bound to a remote service that is the adapter's `putHandoffNote` ([Remote Task Adapters](remote_adapters.md)); for a local agent nothing carries it yet.
- **The file is not a task artifact.** It is not added to `TaskDto.artifacts`: the task page already renders the note as prose, and an artifact row opens through `app:open-external`, which refuses every scheme but `http(s)` — so it would have been a second rendering of the same string behind a control that does nothing.
- **Nothing sets a handoff note yet.** There is no `task:*` IPC channel for it and no service caller, so in a running app the folder stays empty. The writer is in place so that the first thing to leave a note gets a file that is current from the start.

## Architecture Overview

```
taskService.<any write> -> taskRepo (SQLite, committed)
                        -> written(row) -> taskFileService.exportHandoff(dto)
                                              -> formatFrontmatter (kit/miniYaml)
                                              -> temp file -> rename
                                           <userData>/tasks/<task-id>.md

taskService.remove      -> taskRepo.softDelete
                        -> taskFileService.removeHandoff(taskId)   (ENOENT is success)
```

## Where it lives

- `src/main/services/taskFileService.ts` — `exportHandoff(task)`, `removeHandoff(taskId)`, `handoffPath(taskId)`; the atomic write and the temp sweep
- `src/main/services/taskService.ts` — `written(row)`, the tail every mutating method returns through
- `src/main/db/tasks.ts` — `TaskPatch`, whose docstring names the six columns that are also frontmatter
- `src/main/kit/miniYaml.ts` — `formatFrontmatter(data, body)`, the writer half of the small YAML module (see [Kit Contract](../../agents/local_agents/kit_contract.md))
- Tests: `src/main/services/taskFileService.test.ts` (the file's shape and its failure modes), `src/main/services/taskService.test.ts` (that the file follows the row — including a pinned list of every `taskService` method, so a new one must be classified as a read or a write before the suite passes)

## Integration Points

- [Jobs](../jobs/jobs.md) — a local job run creates the task whose note this exports, and the run history row opens it
- [Remote Task Adapters](remote_adapters.md) — the other place the same note goes, for a task bound to a service
- [Kit Contract](../../agents/local_agents/kit_contract.md) — the YAML subset the frontmatter is written in, and the round trip that bounds it
