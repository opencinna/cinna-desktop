# Agent Task Tools — an agent keeps its own queue

## Purpose

A folder agent can read and change the tasks that concern it from inside its own turn: list them, put new work in its own queue, hand work to another agent, move or edit a task, report how its current work ended, and leave a comment on the task page. The four tools — `tasks_list`, `task_create`, `task_update`, `task_comment` — sit on the same session loopback MCP server as the [Handover Bus](handover_bus.md) tools and are offered to the same sessions.

## Core Concepts

- **Own queue** — the tasks assigned to the calling agent. For a bare agent that is the Markdown files in its `.cinna/tasks/` ([Folder Tasks](folder_tasks.md)); for a kit agent, ordinary native tasks. An own-queue create is the same create a person makes with **New task** for that agent, so the task lands in the same home.
- **Delegation** — `task_create` with an `assignee` taken from `handover_targets`. It is the delegation request of the [Handover Bus](handover_bus.md), unchanged: `description` is the brief, `id` makes it idempotent, `execution`, `group` and `status: draft` mean what they always meant. There is no separate `handover_create` tool: one way to create work, so an agent cannot pick the wrong one.
- **Relation** — how a task concerns the calling agent: `assigned` (it is the assignee), `created` (its `task_create` made it), `delegated` (it requested the delegation that made it). One task can carry several.
- **Provenance** — the agent whose tool call made a task, the chat it called from, and the task's **chain depth**. Recorded for own-queue creates and for every delegated task, including the one a bare brief's file intake makes.
- **Chain depth** — how many tool-created steps lie above a task. A task created from a chat with no task has depth 0; one created from a chat working on a task is one deeper than that task.
- **Status report** — the agent setting its current task to `completed`, `blocked` or `error` to say how its work ended, instead of leaving the turn's end to decide.
- **Comment** — a short Markdown note an agent leaves on a task, shown on the task page and copied, best effort, to the task's home.

## User Stories / Flows

1. **An agent plans its own work.** During a turn the agent calls `task_create` with a title and a description (and optionally priority, custom fields, `backlog` or `ready`, and a parent in its own queue). A bare agent's task appears as a new file in its `.cinna/tasks/`, trusted as Cinna's own; a kit agent's as a native task. Either shows up in the Tasks view within one poll.
2. **An agent asks another agent for work.** It calls `handover_targets`, then `task_create` with that entry's `target` as `assignee`, an `id`, a title and the brief as `description`, and ends its turn. Everything after that — gate, run, report, return packet — is the [Handover Bus](handover_bus.md).
3. **An agent checks what it has.** `tasks_list` answers the tasks assigned to it, created by it or delegated by it, newest first, at most 50, closed ones left out unless asked for. Each entry carries its status, the status word and category, relations, assignee, parent, the task file's path relative to the agent folder, and the delegation's id and state where there is one. The turn header also says `- ready tasks: N` when the agent has ready tasks assigned to it, so it knows to look without polling.
4. **An agent moves or edits a task.** `task_update` changes title, description, priority, custom fields (the whole set; `{}` clears them) or status. A status may be a status or a status word: a folder task takes its folder's own words (`doing`, a `_board.yaml` word) and writes that word to the file.
5. **An agent says how its work ended.** In a hand-opened chat working on a task, `task_update` on that task with `completed`, `blocked` or `error` records the outcome, and the turn's end does not overwrite it.
6. **An agent leaves a comment.** `task_comment` stores the comment; the task page shows it under **Comments**. A folder task's file gains an entry in its comment log section; a task bound to a service that keeps comments (cinna-core) gets it as a note.

## Business Rules

### Who may create

- **Same sessions as the bus.** The tools are offered wherever `handover_*` is: a folder agent's own chat or a human-routed one, never a nested run. Every call is validated like a bus call: the app is activated, the profile the session was opened under is still active, the chat still answers to this agent, and the agent is enabled.
- **An assignee naming the calling agent is its own queue**, not a delegation to itself — provided the assignee carries nothing beyond `kind` and `agentId`.
- **Arguments are kept to their own path.** `priority`, `custom_fields` and `parent` with an assignee, or `id`, `execution` and `group` without one, are refused rather than ignored: an agent that believed it delegated with a priority, or created its own task with an id, should hear that it did not.
- **A parent must be in the agent's own queue.** An agent cannot hang its work under somebody else's task.
- **One chain for both kinds of work, capped at depth 2.** An own-queue task's depth is one more than the deeper of the chat task's delegation depth and its own chain depth; a delegation's depth is one more than the deeper of its parent delegation's depth and the chat task's chain depth. Kept separate, an agent could have gone around the delegation cap by putting a task in its own queue and delegating from there.
- **At most 20 tool-created tasks per chat**, own-queue and delegated together. The count is of rows created from that chat, deleted ones included, so deleting a task does not buy another and a restart does not reset it. A repeated delegation id — including a repeated bare brief, even a draft, which has no delegation row yet — is answered as before even at the cap, because it is not a new request.
- **Creates are serialized per chat.** The cap is a count checked before the create writes its row; two parallel calls at 19 would both have passed it.

### Who may change what

- **`task_update` takes a task assigned to the agent, the chat's own task, or one the agent created that no conversation has started.** Once a chat runs a task it created for somebody else, that task is the other agent's.
- **Delegated work moves only through its own tools.** A task with a delegation or a file handover behind it is refused: its executor is pointed at `handover_report`, its requester at `handover_reply`. Changing it directly would bypass the lifecycle that wakes the requester.
- **Work something else owns is refused**: a task a runtime or script runner owns, and a task with a turn running in another chat.
- **Status moves are a person's manual moves**, by the same rules as the board: between Backlog, Ready and Done (and Cancelled), refused for work a run or a question holds. An agent gets no move a person does not have.
- **A status report needs a task the turn's end would settle itself.** `completed`, `blocked` or `error` are accepted only on the chat's own task in a hand-opened chat. A job run's task is refused (its run reports the outcome when it ends), and so is a task a runtime owns (its runner does). Delegated tasks are already refused above and report through `handover_report`.
- **A report survives the end of its own turn, and only that turn.** Without it, the turn's end settled the task from how the turn ended and turned an agent's `blocked` or `error` into `completed` a moment later. The mark is keyed by the run that made the report: only that run's end reads it, any new turn in the chat drops a leftover, and a restart forgets it, in which case the turn's end settles the task as before. A task that went back to In progress since the report (an Inbox answer, say) is settled normally.

### Comments

- **An agent comments on tasks assigned to it, created by it or delegated by it**, at most 8000 characters. Delegated work may be commented on, unlike updated: a comment changes nothing the lifecycle reads.
- **The comment in Cinna is the record; the copy is best effort.** It is stored first. A failed copy to the file or service fails nothing: the tool answers with a warning, and the task page marks that comment with a warning glyph ("Not copied to the task's file" / "…to the connected service"). A native task has nowhere to copy to, which is not a failure and shows nothing.
- **The file's comment log is an export.** Entries are appended between `<!-- cinna:log -->` and `<!-- /cinna:log -->`, never rewritten, never read back, and never part of the description. See [Folder Tasks](folder_tasks.md#the-file).
- **Comments are device-local**, like the provenance columns: they do not travel by device sync. An agent id and a chat id mean nothing on another device.
- **There is no way for a person to write one yet.** The page's Comments section is read-only; the data model already allows a user author.

### The Comments section

- **Last on the page, where it cannot push anything.** Below Goal, Description, Handoff note, Artifacts, Details and the Subtasks list, at every width. A comment arriving on the poll lands under everything the user is reading or clicking.
- **The last five, then Show earlier comments.** The window is anchored at the first comment shown, so a comment arriving on the poll is added at the bottom and pushes no visible comment out of the top. Show earlier comments reveals the rest in place and becomes **Show fewer comments** in the same slot, which goes back to the latest five; the control never vanishes from under the pointer.
- **A long comment is clamped** (more than 600 characters or 8 lines) to six whole lines, the last fading out, behind Show more / Show less. Bodies render as Markdown, with headings drawn at body size in bold so a comment's `# Title` never outranks the page's section titles. A comment that could not be copied shows a warning mark: "Not copied to the task's file", "Not copied to the connected service", or plain "Not copied" for a task with neither.
- **No section at all while there are none.** A failed first read keeps a section with "Could not read the comments." and Try again, so a failed read never looks like a task without comments — and a retry does not make the section vanish and come back.
- An agent author's name opens its agent page while the agent is still listed; otherwise it is plain text.

## What this deliberately does not do

- **No tools for a nested or remote-launched session** — the same sessions that never get the bus tools.
- **No reading or writing other agents' queues**: `tasks_list` never lists a task that does not concern the caller.
- **No deleting a task** from a tool. A wrong own task is moved to Cancelled or Done.
- **No `task_update` on delegated work**, and no status report on a job run's or runtime's task — those have owners that report for them.
- **No polling primitive.** The `ready tasks` header line exists so an agent does not call `tasks_list` in a loop.

## Architecture Overview

```
Folder agent session -> loopback MCP (cinna-handovers) -> DelegationToolProvider
   task_create (assignee)  -> delegationService.create            -> Handover Bus
   task_create (own queue) -> taskAuthoringService.createRouted   -> folder file / native task
   task_update             -> taskAuthoringService.update / setStatus, or taskService.setStatus (report)
   task_comment            -> task_comments row -> taskSyncService.copyComment -> file log / service note
Task page -> task:comments -> Comments section
Turn start -> turn header `- ready tasks: N`
```

## Integration Points

- [Handover Bus](handover_bus.md) — delegation semantics, the shared depth cap and the `handover_report` / `handover_reply` tools delegated work moves through.
- [Folder Tasks](folder_tasks.md) — where a bare agent's own queue lives, status words, and the comment log section.
- [Tasks and the Inbox](tasks.md) — the task page that shows Comments, and how a hand-opened chat's turn end settles its task.
- [The Tasks View](../tasks_view/tasks_view.md) — the manual-move rules `task_update` follows.
- [A Task on the User's Other Devices](cross_device.md) — why provenance and comments stay on this device.
- [Technical details](agent_task_tools_tech.md).
