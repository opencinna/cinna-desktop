# Agent Task Tools — an agent keeps its own queue

## Purpose

A folder agent can read and change the tasks that concern it from inside its own turn: see who it can hand work to, list its tasks and read one in full, put new work in its own queue or hand it to another agent, edit a task or move it as a person would, say how its work went, answer work it delegated, and leave a comment on the task page. The eight tools — `tasks_targets`, `tasks_list`, `tasks_get`, `tasks_create`, `tasks_update`, `tasks_comment`, `tasks_report`, `tasks_reply` — are the [Cinna Task Protocol](task_protocol.md)'s, on the session loopback MCP server named `cinna`, and every session that gets one gets all eight.

## Core Concepts

- **Own queue** — the tasks assigned to the calling agent. For a bare agent that is the Markdown files in its `.cinna/tasks/` ([Folder Tasks](folder_tasks.md)); for a kit agent, ordinary native tasks. An own-queue create is the same create a person makes with **New task** for that agent, so the task lands in the same home.
- **Ref** — how a tool names a task: the task's id as the desktop shows it, copied from a tool result or the turn context. `tasks_comment` and `tasks_report` default to the chat's own task when `ref` is left out.
- **Target** — the string `tasks_targets` returns for each agent the caller can hand work to (`folder:<agentId>`, `kit:<agentId>`, `cinna:<adapter>:<agentId>`), passed back verbatim as `tasks_create`'s `assignee`. Opaque to the agent: a string the desktop did not write is refused.
- **Delegation** — `tasks_create` with an `assignee`. It is the delegation request of the [Handover Bus](handover_bus.md): `description` is the brief, `id` makes it idempotent, `execution`, `group` and `category: draft` mean what the bus says. For a bare folder, `priority` and `custom_fields` are written into the brief, so the receiving task carries them as a [task file](folder_tasks.md) would. There is one way to create work, so an agent cannot pick the wrong one.
- **Relation** — how a task concerns the calling agent: `assigned` (it is the assignee), `created` (its `tasks_create` made it), `delegated` (it requested the delegation that made it). One task can carry several.
- **Provenance** — the agent whose tool call made a task, the chat it called from, and the task's **chain depth**. Recorded for own-queue creates and for every delegated task, including the one a bare brief's file intake makes.
- **Chain depth** — how many tool-created steps lie above a task. A task created from a chat with no task has depth 1, as a delegation from that chat does; one created from a chat working on a task is one deeper than that task.
- **Report** — `tasks_report`: the agent's own statement of how its work on a task is going or how it ended — `done`, `failed`, `blocked` with a question, or `in_progress` — with a one-line summary.
- **Worked** — a task something has already run or holds: the dispatcher owns it, a conversation ran it, an ask on it is open, it is a delegation's or a file handover's, or a runtime or script runner has it. Only a report may close a worked task.
- **Comment** — a short Markdown note an agent leaves on a task, shown on the task page and copied, best effort, to the task's home.

## User Stories / Flows

1. **An agent plans its own work.** During a turn it calls `tasks_create` with a title and a description (and optionally priority, custom fields, `category` `backlog` or `ready`, and a `parent` in its own queue). A bare agent's task appears as a new file in its `.cinna/tasks/`, trusted as Cinna's own; a kit agent's as a native task. Either shows up in the Tasks view within one poll.
2. **An agent asks another agent for work.** It calls `tasks_targets`, then `tasks_create` with that entry's `target` as `assignee`, an `id`, a title and the brief as `description`, and ends its turn. The answer names the delegated task's `ref`. Everything after that — gate, run, report, return packet — is the [Handover Bus](handover_bus.md). It answers a `blocked` question with `tasks_reply` and that `ref`.
3. **An agent checks what it has.** `tasks_list` answers the tasks assigned to it, created by it or delegated by it, newest first, at most 50, closed ones left out unless asked for. Each entry carries its `ref`, status, the status word and `category`, relations, assignee, `parent`, the task file's path relative to the agent folder, and, where there is one, the delegation's id, state, result status, summary and question. The turn header's counts line includes `ready tasks: N` when the agent has ready tasks assigned to it, so it knows to look without polling.
4. **An agent reads one task in full.** `tasks_get` with a `ref` answers the goal, description, status and `category`, priority, assignee, parent, `blocked_by`, custom fields, the task file, the latest ten comments, the latest report (handoff note, artifacts, error), the delegation behind the task, and the delegations it made from that task.
5. **An agent edits or moves a task.** `tasks_update` changes title, description, priority, custom fields (the whole set; `{}` clears them) or `category`. A move may name a category or a status word: a folder task takes its folder's own words (`doing`, a `_board.yaml` word) and writes that word to the file.
6. **An agent says how its work went.** `tasks_report` with `done` or `failed` and a summary before it ends its turn; `blocked` with a `question` when it cannot go on; `in_progress` for a progress line. The task gets the status, a handoff note made of the summary, the question and the body, and the artifacts. On delegated work the same call goes through the bus and wakes the requester.
7. **An agent leaves a comment.** `tasks_comment` stores the comment; the task page shows it under **Comments**. A folder task's file gains an entry in its comment log section; a task bound to a service that keeps comments (cinna-core) gets it as a note, and the files named in `files` are uploaded to that service.

## Business Rules

### Who may create

- **Same sessions as the bus.** The tools are offered to a folder agent's own chat or a human-routed one, never a nested run. Every call is validated like a bus call: the app is activated, the profile the session was opened under is still active, the chat still answers to this agent, and the agent is enabled.
- **An `assignee` must be a target string the desktop wrote.** Anything else — an object, a guessed id, a re-encoded string — is refused with "Choose a target from tasks_targets and pass its target string verbatim as assignee.", before anything is created. A string that decodes is still matched against the session's own targets, so naming an agent the session could not list is refused as unavailable.
- **A local target naming the calling agent is its own queue**, not a delegation to itself. A `cinna:` target never is, even with the same agent id.
- **Arguments are kept to their own path.** `parent` with an assignee, `id`, `execution` and `group` without one, `category: draft` for one's own queue, and `priority` or `custom_fields` delegated to anything but a bare folder are refused rather than ignored: an agent that believed it delegated with a priority, or created its own task with an id, should hear that it did not. A bare folder's brief is the one channel with a place for priority and custom fields; a kit or cloud request has none. A custom field named like a brief key (`execution`, `priority`, `id`… in any case) is refused too, because in the brief it would be read as that key.
- **A parent must be in the agent's own queue.** An agent cannot hang its work under somebody else's task.
- **One chain for both kinds of work, capped at depth 2.** An own-queue task's depth is one more than the deeper of the chat task's delegation depth and its own chain depth, and 1 from a chat with no task, as a delegation from that chat is (it was 0, which let an agent with no task build a chain one step deeper through its own queue than through a delegation); a delegation's depth is one more than the deeper of its parent delegation's depth and the chat task's chain depth. Kept separate, an agent could have gone around the delegation cap by putting a task in its own queue and delegating from there.
- **At most 20 tool-created tasks per chat**, own-queue and delegated together. The count is of rows created from that chat, deleted ones included, so deleting a task does not buy another and a restart does not reset it. A repeated delegation id — including a repeated bare brief, even a draft, which has no delegation row yet — is answered as before even at the cap, because it is not a new request.
- **Creates are serialized per chat.** The cap is a count checked before the create writes its row; two parallel calls at 19 would both have passed it.

### Who may read

- **`tasks_list` and `tasks_get` show only what concerns the caller**: a task assigned to it, created by it or delegated by it — and, for `tasks_get`, the chat's own task. Another agent's queue is never listed or read.
- **`tasks_list` is not a wait primitive.** When nothing changed since the previous call in the same session, its answer adds "Nothing has changed since your last call in this turn; end your turn." A result arrives as a turn; polling for it only spends the turn.

### Who may change what

- **`tasks_update` takes a task assigned to the agent, the chat's own task, or one the agent created that no conversation has started.** Once a chat runs a task it created for somebody else, that task is the other agent's.
- **Delegated work moves only through its own tools.** A task with a delegation or a file handover behind it is refused: its executor is pointed at `tasks_report`, its requester at `tasks_reply`. Changing it directly would bypass the lifecycle that wakes the requester.
- **Work something else owns is refused**: a task a runtime or script runner owns, and a task with a turn running in another chat.
- **Moves are a person's manual moves**, by the same rules as the board: between Backlog, Ready and Done (and Cancelled), refused for work a run or a question holds. An agent gets no move a person does not have.
- **`tasks_update` never says how work went.** A word that states an outcome (`completed`, `blocked`, `error`, `in_progress`, `failed`), any move to In progress, Waiting or Failed, and Done on the chat's own task are refused with a pointer to `tasks_report`.
- **A worked task cannot be closed by `tasks_update`** — Done, Failed or Cancelled — whoever asks. The refusal says to report with `tasks_report`, or to leave cancelling to the user, and that Backlog ↔ Ready is still allowed. A task nothing has run keeps every move a person could make, so an agent can still tidy away a task it created by mistake.

### Reporting

- **One verb.** `tasks_report` is the only way an agent says how work went. The summary is required, one line, at most 1000 characters; `blocked` needs a `question`.
- **On the chat's own task, the report survives the end of its own turn, and only that turn.** Without that, the turn's end settled the task from how the turn ended and turned an agent's `blocked` or `failed` into `completed` a moment later. The mark is keyed by the run that made the report: only that run's end reads it, any new turn in the chat drops a leftover, and a restart forgets it, in which case the turn's end settles the task as before. A task that went back to In progress since the report (an Inbox answer, say) is settled normally. An `in_progress` report is a progress note: it leaves the task In progress, so the turn's end still settles it.
- **On a job run's task, the report wins over the run's outcome.** `done` or `failed` maps the run's attempt to succeeded or failed instead of the run's end overwriting it. `blocked` leaves the attempt running and the task Waiting.
- **On a dispatched task, the report is what keeps the queue going.** The [dispatcher](task_dispatcher.md#the-report-rule) reads the task at the end of the turn. A task left In progress — including after an `in_progress` report — or in Ready or Backlog was not reported on: it is flagged and the queue pauses.
- **On delegated work, the executor reports from the conversation working on it**, and the report goes through the [Handover Bus](handover_bus.md#report-and-answer): it sets the task, wakes the requester and counts toward a group. A requester cannot report on work it delegated; it is pointed at `tasks_reply`. A bare executor whose task has a file handover but no delegation row found for it reports through the handover's own report path instead, as a `report.md` with the same content would, without writing the file.
- **Elsewhere, a report is accepted on a task assigned to the agent, or on one it created that no conversation has run**, unless a runtime owns it or another chat is running it. A task a runtime owns is refused in every case: its runner reports for it.
- **`audience: requester` needs a requester.** On a task nobody delegated it is refused rather than turned into a user question.
- **Repeating a report changes nothing.** An identical repeat on the same task returns the first answer and writes nothing, but still marks the turn as reported. The memory of the last report is in-process: after a restart a repeat writes the same values again. On delegated work the bus recognises a repeat by its result digest.

### Comments

- **An agent comments on tasks assigned to it, created by it or delegated by it**, at most 8000 characters. Delegated work may be commented on, unlike updated: a comment changes nothing the lifecycle reads.
- **Files go only where the task's home keeps them.** `files` are paths inside the agent's folder, at most 20, each an existing file; they are uploaded to the service a task is bound to when that service stores files. A task kept in a file or not bound to a service has nowhere to put them: "Attachments are not supported for this task." Every check runs before anything is posted, so a refused call leaves no comment behind.
- **The comment in Cinna is the record; the copies are best effort.** It is stored first. A failed copy to the file or service, or a failed upload, fails nothing: the tool answers with a warning, and the task page marks that comment with a warning glyph ("Not copied to the task's file" / "…to the connected service"). A native task has nowhere to copy to, which is not a failure and shows nothing.
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

- **No tools for a nested or remote-launched session.**
- **No reading or writing other agents' queues**: `tasks_list` and `tasks_get` never show a task that does not concern the caller.
- **No deleting a task** from a tool. A wrong own task is moved to Cancelled or Done while nothing has worked it.
- **No `tasks_update` on delegated work**, no closing a worked task by a move, and no report on a runtime's task — those have owners that report for them.
- **No polling primitive.** The `ready tasks` count and the result turn exist so an agent does not call `tasks_list` in a loop.

## Architecture Overview

```
Folder agent session -> loopback MCP (cinna) -> DelegationToolProvider -> taskToolService
   tasks_targets            -> delegationService.targets              -> target strings
   tasks_list / tasks_get   -> taskRepo, delegationRepo, taskService  -> what concerns the caller
   tasks_create (assignee)  -> delegationService.create               -> Handover Bus
   tasks_create (own queue) -> taskAuthoringService.createRouted      -> folder file / native task
   tasks_update             -> taskAuthoringService.update / setStatus (manual-move rules)
   tasks_report             -> delegated: delegationService.report -> delegationLifecycle
                               handover row only: handoverService.applyReport
                               otherwise: taskService (note, artifacts, status) + report mark
   tasks_reply              -> delegationService.reply
   tasks_comment            -> task_comments row -> taskSyncService.copyComment / attachFiles
Task page -> task:comments -> Comments section
Turn start -> Cinna task context block (current task, report required, counts)
```

## Integration Points

- [The Cinna Task Protocol](task_protocol.md) — where the eight tools come from, the skill that teaches them, and the turn's context block.
- [Handover Bus](handover_bus.md) — delegation semantics, the shared depth cap, and the report and reply paths delegated work moves through.
- [Folder Tasks](folder_tasks.md) — where a bare agent's own queue lives, status words, and the comment log section.
- [Tasks and the Inbox](tasks.md) — the task page that shows Comments, and how a hand-opened chat's turn end settles its task.
- [The Task Dispatcher](task_dispatcher.md) — the queue that reads a report to decide whether to continue or pause.
- [Jobs](../jobs/jobs.md) — a job run's attempt mapped from the agent's report.
- [The Tasks View](../tasks_view/tasks_view.md) — the manual-move rules `tasks_update` follows.
- [A Task on the User's Other Devices](cross_device.md) — why provenance and comments stay on this device.
- [Agent Publish](../../chat/artifacts/agent_publish.md) — the ninth tool on the same `cinna` server, `artifacts_publish`, offered to the same folder-agent sessions (validated the same way) only while the active profile's instance keeps artifacts. It is not a task tool: it does not touch the queue, and it blocks on a person's approval.
- [Technical details](agent_task_tools_tech.md).
