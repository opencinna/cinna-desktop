# Folder Tasks

## Purpose

A bare folder agent's work queue is a set of markdown files in its own folder, `<folder>/.cinna/tasks/*.md`, so the agent, a script, a person in an editor or a teammate's `git pull` can read and change it with no Cinna in the loop. Cinna indexes those files as ordinary tasks — on the Tasks view, the board, the task page — and writes back only the lines it owns. **The files are the truth; SQLite is the index.**

## Core Concepts

- **Folder task** — a task whose home is one file in a bare agent's `.cinna/tasks/`. It is bound to the `folder` [remote task adapter](remote_adapters.md) like any bound task, but its remote copy is a file on this machine, which makes it **device-local**: run here, never carried by device sync.
- **Task file** — any `.md` with frontmatter directly under `.cinna/tasks/`: not a dotfile, not in a subdirectory, not `_board.yaml`. A file without frontmatter is not a task, whatever folder it is in.
- **Owned keys** — `cinna_task`, `id`, `title`, `status`, `priority`, `parent`, `blocked_by`, `origin`. The only keys Cinna reads as task fields, and the only ones it ever rewrites (`blocked_by` is read, never written).
- **Custom fields** — every other top-level key. A one-line value (text, number, `true`/`false`, a flat `[a, b]` list) is an editable [custom field](../tasks_view/tasks_view.md#custom-fields). Anything spanning lines — a nested map, a block list, a block scalar, a `{…}` flow map — or a value over 2000 characters is **read-only**: shown as text, never written.
- **Handoff section** — the [handoff note](tasks.md) lives at the end of the body between `<!-- cinna:handoff -->` and `<!-- /cinna:handoff -->`.
- **Comment log** — the task's comments ([`tasks_comment`](agent_task_tools.md#comments)), appended between `<!-- cinna:log -->` and `<!-- /cinna:log -->` before the handoff section. The rest of the body, outside both sections, is the description.
- **Status word** — the word a file writes in `status:` (`doing`, `Up Next`, `wontfix`). It maps to a **category**, and the category to the canonical status Cinna reacts to. The task keeps both: `status` for every rule, `statusLabel` for what the user reads.
- **`_board.yaml`** — an optional file beside the tasks naming the folder's own words, one flat `word: category` per line, in board order.
- **Folder board** — the Tasks board filtered to one such agent (**Filters → Agent**): one column per status word, not the five categories.

## The file

- **The folder is the marker.** `cinna_task:` absent means version 1; `id:` absent means the filename stem. So renaming an id-less file is a delete and a new task, while renaming a file with an `id:` keeps the task — it is found by id, not by name.
- **Two files claiming one id**: the first by name is the task and the other is skipped with a warning, so a copied file cannot make one task flicker between two contents.
- **The frontmatter subset is the handover one** — flat `key: value`, quoted or bare scalars, a trailing ` # comment` on a bare one, BOM and CRLF accepted, the closing `---` the first later line that is exactly `---`. One reader for both file contracts, so a quoted title cannot mean one thing in a brief and another in a task. See [File Handovers](file_handovers.md#the-contract).
- **A write is a line-level patch, never a re-serialization.** The reader is not YAML, so writing a file back from what it read would drop every nested value, comment and key order it cannot represent — a teammate's `meta:` block would vanish on the first status change. A write replaces exactly the lines of the keys it changes (and a scalar custom key when asked) and the handoff section; every other byte, line ending included, stays where it was.
- **The comment log is an export, never read back.** Cinna appends one entry per comment (author, UTC time, the body) and never rewrites one; an edit made inside it changes no comment, and its text is never part of the description — otherwise every comment would have become a description edit that the next push wrote back. A file with no log gets one after the description, before the handoff section, and only lines are added. A body line that would read as a section marker is defused, so a comment cannot close the log or the handoff section early. Like the handoff section, the log is the last closing marker and the opening marker nearest before it, and a description write keeps it byte for byte. Appending an entry does not make a file someone else changed look like Cinna's own: it stays changed outside.
- **The handoff section is the last closing marker and the opening marker nearest before it.** A stray opening marker earlier in the body (a quoted marker, a half-deleted section) is the user's text; paired with Cinna's closing marker instead, the next note write would have replaced everything between them. Text the user wrote after the section is part of the description and survives a note write byte for byte.
- **A new file** is `<slug>.md` from the title (`-2`, `-3`… on a collision, never overwriting), with a fresh `t-xxxxxxxx` id and the keys in a fixed order: `cinna_task, id, title, status, priority, parent, origin: cinna`, then custom fields, then the description and the note.
- Priority reads `low | normal | high | urgent`, plus `medium` as normal and `critical` as urgent, matched like a status word (`High` is `high`); anything else reads as normal. A [handover brief](file_handovers.md) reads the same words but refuses any other.

## Status words

- **Every folder understands a default table without a `_board.yaml`**, matched case- and separator-insensitively (`In Progress` is `in_progress`):

  | Category | Default words | Stored as |
  |---|---|---|
  | Backlog | `new`, `refining`, `backlog`, `todo` | `new` |
  | Ready | `open`, `ready`, `next` | `open` |
  | Active | `in_progress`, `doing`, `wip` | `in_progress` |
  | Waiting | `blocked`, `waiting`, `review` | `blocked` |
  | Done | `done`, `completed`, `closed` | `completed` |
  | Failed | `error`, `failed` | `error` |
  | Cancelled | `cancelled`, `canceled`, `wontfix` | `cancelled` |
  | Hidden | `archived` | `archived` |

- **`_board.yaml` comes first, then the defaults.** A comment, a blank or indented line, or an unknown category is skipped rather than refused — the file is a person's, and one typo must not take the board down. A word named twice keeps its first line. A key may hold spaces (`In Progress: active`, `"on hold": waiting`).
- **A missing `status:` is a fresh task** (Backlog).
- **An unmapped word is shown and inert.** `parked`, in no table, is shown as written, stored as `new` with no category, and nothing reacts to it: no run starts, no column accepts a drop onto it. Refusing the file would hide a task the agent can see; guessing a category would make Cinna act on a word nobody defined.
- **Which word Cinna writes.** When the current word already means the new status, **nothing is written** — a file saying `doing` is not rewritten to `in_progress` because a run started. Otherwise a word the person chose (a board column's) when it means that status; else the folder's first word for that category in board order; else the canonical word (`new`, `open`, `in_progress`, `blocked`, `completed`, `error`, `cancelled`, `archived`).
- **The word moves with the status at once.** A status change made in Cinna (a run, a question, a drop) stores the word the push is about to write, asked of the folder as last read, so the card keeps a column in the gap before the push lands. A home not read yet in this process answers nothing, and the old word is dropped rather than left describing the old status.

## The folder board

- **Columns in lifecycle order**: Backlog, Ready, Active, Waiting, Done, Failed, Cancelled, Hidden. Within a category, the `_board.yaml` words in file order, then the default words the folder's files actually use; the unmapped words in use come last, alphabetically. A word's first spelling in the files is its column title, shown as written (no small capitals, which would rewrite it).
- **Fallback columns.** A category some task on the board sits in but no word of the folder's covers gets one column under the canonical word. That task may be a native, handover or delegation task assigned to the agent — they share its board — and without the fallback it would land in another category's column.
- **Droppable columns** are those whose status is `new`, `open`, `completed` or `cancelled`. **Active and Waiting are never drop targets** — a run and a question own them — and neither are Failed, Hidden or an unmapped word.
- **Where a card stands.** A file task stands in its own word's column; failing that, the first column of its status, then of its category. Any other task of the agent has no word and stands in the first column of its status.
- **Where a card may go.**
  - A **file task** may go to any droppable column whose status it may reach by hand (the manual rule for an *unbound* task — a file keeps no transition table). When its own word has no droppable column (`parked`, or no word at all), the other droppable columns of its own status are open too, so a stray word can be turned into a proper one from Cinna. The drop sends the column's status **and its word**, and the file gets that word.
  - **Any other task** reaches the statuses the category board would give it, each through the first column of that status, and its move sends the status alone. Main refuses a word for a task that has no file.
- **Columns hold still while dragging.** The board polls every five seconds; a poll that brings a new word must not slide a column under the pointer, so the columns are frozen from drag start to drop.
- **The same words reach the dialogs.** New task's Backlog/Ready options say the assignee folder's first backlog and ready words (the values stay `new` and `open`). Edit task's Status offers the folder board's droppable targets; while that board is being read it offers only the current status rather than a list it would then swap under the user.

## Pull: the files into the index

1. **The task sync pass reads every enabled bare agent's `.cinna/tasks/`** on its five-second cycle (see [remote sync](remote_sync.md)). One directory listing per folder; a file whose `mtime:size` stamp has not moved since the last read is not read again, so a hundred-task folder costs one listing.
2. **A watch event asks for that pass now.** The folder watcher classifies any path under `<agent>/.cinna/tasks/` as its own `tasks` target; any number of them in one debounce window become one sync refresh.
3. **A new file becomes a task** of that agent: device-local, run by this desktop, origin `remote`, its title, description, word, priority, custom fields, parent and file facts filled from the file.
4. **A changed file updates its task**, except for fields this device still owes the file (below).

### What makes a task leave

- **A missing folder is unavailable, never gone.** No `.cinna/tasks`, no agent folder, a symlinked `.cinna` or `tasks`, a listing that fails, or an agent the user switched off: every task in it is kept as it is and comes back with the folder. An unmounted volume, a renamed project or a toggle must not delete a queue.
- **A file is gone only after two absences at least 30 seconds apart, from a folder that could be read.** A `git checkout`, a `git stash`, an editor's save-by-rename takes a file away for a moment, and a branch switch in a large repository can take longer than five seconds. The count is in memory only: a restart starts it again.
- **Never while something is working on it.** A task with a runtime, a live turn or autonomous runner in its chat, or an open Inbox ask is kept, bound, however long its file is gone — a file that vanished under a running task is more often a branch switch than a delete — and goes on a later pass once the work stops.
- **A gone file takes its task with it**, whatever the task's origin — including one created in Cinna. Device-local rows are checked for absence on every pass, not on the periodic reconcile, so a deleted file leaves the list within a pass or two of the grace.
- **An unparseable file keeps its last good state.** A half-saved file or a lost fence is present, not missing: the task keeps what it last said. After a restart, with no last good read, it is still present — kept, never counted as absent.
- **A write never decides a task is gone.** Only the pull's confirmation does.

## Push: the index into the files

- **A local write to a folder task is pushed at once**, not on the next pass — five seconds of the file disagreeing with the screen is five seconds in which the agent reads the old word. A push already running for the task is left to finish; one that fails keeps its markers for the scheduled pass rather than retrying in a loop.
- **What is written**: title, description, priority, custom fields (the editable ones), status as a word, archive as the folder's hidden word, and the handoff note — including **clearing** it, which removes the section. The assignee is fixed: the folder is the assignee.
- **A fresh read before every write.** The stamp cache cannot see an outside edit that kept size and mtime (`cp -p`, `rsync -t`, a coarse clock), and a patch over the cached text would have published the old content over it. The write patches the bytes on disk *now*; a file that no longer parses or no longer carries the task's id is not written, and the write waits for a later pass.
- **Temp file, then rename.** An agent or editor reading the file never sees half of it. A new file is published with a hard link, which fails rather than replace a file somebody else just created.
- **The field-level merge: the file wins a field it changed.** Each binding remembers the owned values as last read. If the file's title, description, priority, status word or a custom field differs from that, somebody edited it outside since Cinna last looked, and the local edit of *that field* is dropped — the next pull brings the file's value in. The other fields are still written. A pull that lands between the local edit and its push keeps the remembered value of every field still owed, so the push still sees the outside change; moving it forward would have let the push overwrite it.
- **The status merges like the other fields.** A status change made here is not written when the file's status word changed since the last read: the change is dropped, not retried, and the next pull moves the task to the file's word. An outside edit of another field does not hold the status back. Otherwise the folder's word for the new status is written, unless the file's word already means it.
- **A cleared handoff note is sent** to a remote whose note channel can be emptied (`clearHandoffNote`). On cinna-core's append-only comment stream a cleared note has nothing to unpost and the marker is dropped instead.
- **Credentials are redacted** from what Cinna writes into the folder, as for a delegation brief — a note can quote a token.

## Trust: whose content is this

- **Two digests, because "Cinna wrote this" and "Cinna vouches for this" are different.** The binding records `writtenDigest`, the bytes Cinna last published, and `trustedDigest`, the content Cinna vouches for. Both are kept in the stored binding, not in memory: a quit between a write and the next pull otherwise turned Cinna's own write into "changed outside" on relaunch.
- **What is trusted**: a file Cinna created, a Cinna write onto content that was already trusted, and content the user approved in the Inbox. **A Cinna write does not launder.** A status, field, note or log entry Cinna pushes onto a file someone else changed leaves it untrusted, because the outside text is still in it, so the approval is still asked for. With one digest, the dispatcher's own status write when it started a task would have made any outside edit look like Cinna's.
- **A binding stored before `trustedDigest` existed trusts nothing**, and each such file is approved once in the Inbox before a queue runs it. Those bindings once fell back to trusting what Cinna wrote, but what Cinna wrote was never what a person approved: a file an agent or an editor had changed, with a Cinna status write on top, would have run as trusted. A migration also clears `trusted_digest` on the task rows of those bindings, so the two agree.
- **`trusted_digest`** on the task mirrors the trusted content. **`fromOutside`** is true whenever the file's current digest is not it: a file an editor, a script, a `git pull` or the agent itself wrote or changed. The task page shows it as a small glyph on the File row.
- **It gates running, not reading.** An outside file is indexed, shown and editable like any other. The [task dispatcher](task_dispatcher.md#the-outside-content-gate) will not run it until the user approves that exact content in the Inbox, one card per content hash. Approving stores the digest as trusted on the task and in its binding, so the next pull keeps it trusted. The file's next outside change asks again.

## Create and delete

- **New task for an enabled bare agent writes its file**, whether a person made it or the agent's own [`tasks_create`](agent_task_tools.md) did. The row is created device-local first, the file is written, the row is bound to it, and the file is read back once so the task carries the folder's word, its path and the digest that makes it trusted. A file that cannot be written takes the row with it — the user sees the refusal, not a task that lives nowhere. A pull that lists the folder while the file is unbound does not index it as a second task.
- **A subtask is written beside its parent** and must live in the parent's folder. A task file's subtasks are the files in the same folder whose `parent` is its id; one counts as completed when its word means `completed` (as in the cinna adapter, `error` and `cancelled` do not count).
- **Every other assignee stays native**: a kit agent, a disabled agent, the default model, nobody.
- **Delete task deletes the file.** The row is deleted first and stays deleted whatever the folder answers; the file is removed only if, read now, it still carries this task's id — one renamed over or rewritten as another task stays. One that cannot be removed is a warning, and the row's tombstone keeps the next pull from indexing it again. A push already in flight finishes before the delete.
- **A delete during the create removes the file**, so a task deleted from another window while its file was being written does not come back on the next pull.
- **A device-sync tombstone never touches a file** — and cannot, since device-local rows are never synced.

## Business Rules

- **Bare agents only.** A kit folder is published: a `.cinna/tasks/` there would travel to whoever installed the kit. A kit agent's tasks stay native.
- **Device-local, both ways.** A folder task is never in device sync's push batch, and a record a peer sends for the same id is refused — twice, in the service and at the repository. Its path exists on one machine, so a peer could only show a task it can neither open nor run, and a peer's copy coming back would overwrite the file's. See [A Task on the User's Other Devices](cross_device.md).
- **Never a hand-off target.** A folder is a task's home by construction, not a service work is handed to; it is never the preferred adapter, and a folder task's Hand off is refused.
- **Manual moves are unbound moves.** The file keeps no transition table, so a person's move follows the [manual overlay](../tasks_view/tasks_view.md#manual-moves) for unbound tasks, and the push writes the destination directly instead of walking a path.
- **The assignee is fixed** while the task lives in a folder.
- **No symlink is followed** — not at `.cinna`, not at `tasks`, not at a file. A linked directory reads as absent; a linked file is skipped on a read and refused on a write. A project-controlled link would otherwise point Cinna's writes at any file the user can write.

## What this deliberately does not do

- **No asks, execution, artifacts or assignee directory** on the folder adapter, and no comment *stream*: comments live in Cinna and are only copied into the file's log. Execution of a folder task is the desktop's, like any local task.
- **`blocked_by` is never written.** Main resolves each id against the task files in the same folder, whichever agent indexed them. The task page lists each blocker with its status, and an id that names nothing as "not found". The [dispatcher](task_dispatcher.md#which-task) starts a task only once every blocker is Done. A missing id blocks, so a typo cannot let work start early. A person may still start a blocked task by hand.
- **No moving a task out of its folder** — not by Hand off, not by an assignee change.
- **The app must be open.** Files changed while Cinna is closed are read on the next start.

## Architecture Overview

```
editor / agent / git  ->  <bare agent>/.cinna/tasks/*.md, _board.yaml
                                  |  watcher `tasks` target -> taskSyncScheduler.refresh()
                                  v
taskSyncService pull (5 s) -> folder adapter list/fetch -> upsert (device-local row)

User edit / run / drop -> taskService (row + remote_dirty) -> taskChanged hook
        -> taskSyncService.push -> folder adapter: fresh read -> merge -> patch -> temp + rename

task:create (bare agent) -> taskAuthoringService.createRouted -> localHomeFor -> createInHome
task:delete -> taskSyncService.removeTask -> localHome.discard
tasks_comment -> taskSyncService.copyComment -> appendLog (queued behind the push) -> localHome.appendLog
Board -> task:folder-board -> taskSyncService.folderBoard -> localHome.board
```

## Integration Points

- [Remote Task Adapters](remote_adapters.md) — the seam the `folder` adapter implements, and its capabilities.
- [Keeping a Bound Task in Step](remote_sync.md) — the pass, the dirty markers and the push this rides on.
- [The Tasks View](../tasks_view/tasks_view.md) — the board, the dialogs and the task page that show folder words.
- [File Handovers](file_handovers.md) — the other `.cinna/` file contract, sharing the frontmatter reader, the watcher and the symlink and publish rules.
- [A Task on the User's Other Devices](cross_device.md) — why device-local rows never travel.
- [Bare Agents](../../agents/local_agents/bare_agents.md) — the folders that have a queue.
- [The Task Dispatcher](task_dispatcher.md) — works the queue: `blocked_by`, the status word read again at a turn's end, and the approval of outside content.
- [Technical details](folder_tasks_tech.md).
