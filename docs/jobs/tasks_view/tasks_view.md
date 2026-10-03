# The Tasks View

## Purpose

One place to see every root task the profile has — whoever runs it, wherever it came from — as a list grouped by where the work stands or as a board, to write a new task down by hand and to move work that nobody is running between Backlog, Ready and Done. It sits beside the [Inbox](../tasks/inbox.md): the Inbox is what is waiting on the user, the Tasks view is all the work.

## Core Concepts

- **Status category** — the coarse place a task sits, and the only status vocabulary the user reads. Five categories, in lifecycle order: **Backlog** (`new`, `refining`), **Ready** (`open`), **In progress** (`in_progress`), **Waiting** (`blocked`), **Done** (`completed`, `error`, `cancelled`). `archived` has no category: it is the filed-away pile and the view leaves it out. Where a single task's status is named — the status pill, a row's spoken name, the dialogs — Done splits back into **Done**, **Failed** and **Cancelled**, because those are three different answers, and an archived task reads **Archived**.
- **User columns** — Backlog, Ready and Done: the categories a person may put a task in. In progress and Waiting are put there by a run or a question, never by a drag.
- **Manual move** — a status a person sets by hand, from the board or Edit task. It follows the [shared transition table](../tasks/tasks.md#business-rules) plus a small overlay for tasks bound to no service (below).
- **Custom field** — a named value the user attaches to a task (`estimate: 3`, `area: billing`, `labels: ui, docs`): text, a number, true/false or a flat list of those. Shown under **Fields** in the task page's Details.
- **Status word** — a [folder task](../tasks/folder_tasks.md)'s own word for its status (`doing`, `Up Next`), from its file. Wherever a status is named for such a task the word is shown as written, in the tone of the category it maps to; the category still decides everything else.
- **Folder board** — the board filtered to a bare agent whose tasks live in its folder: one column per status word instead of the five categories.
- **Unassigned** — a task whose assignee is the default chat model and which has no conversation yet. Main stores "nobody yet" and "the default model" the same way, so until a chat runs it the task has nobody on it, and that is the word the page and the dialogs use. The agent filter's **No agent** is wider: every task with no agent on it, including one the default model has already run.

## User Stories / Flows

1. **Open the view.** Click the **Tasks** button in the top bar, between the sidebar toggle and Agent Status. The view opens with no sidebar tab selected, like the Inbox; the button stays pressed while it is open.
2. **Read the list.** Sections in the order the user acts on them: **Waiting**, **In progress**, **Ready**, **Backlog**, **Done**, each with its count. Every section is always there, even at zero. Done shows ten rows and **Show more tasks** for the next ten; the other sections show everything. Rows are the same task rows as the Inbox's Recent tasks, and name each row's agent while the filter is **All agents**.
3. **Use the board.** Switch **List | Board** — the choice is remembered. Five columns in lifecycle order: Backlog, Ready, In progress, Waiting, Done. A card shows its status icon, title, agent and a mark for high or urgent priority. Filtered to a bare agent that keeps its tasks in `.cinna/tasks/`, the board is that folder's own words instead — see [the folder board](../tasks/folder_tasks.md#the-folder-board); until the agent's columns are read the board shows the loading line rather than five columns it would then replace.
4. **Narrow it.** The agent filter lists every agent that has a task, A→Z, then **No agent**; the search matches titles. A filter that leaves nothing shows **No tasks match.** instead of five empty sections.
5. **Write a task down.** **New task** asks for a title and nothing else; Enter creates it and the user lands on its page. **More options** holds the goal (defaults to the title), priority, Backlog or Ready (Backlog by default — named in the assignee folder's own words when it keeps a task folder), the assignee (Unassigned or an enabled agent) and custom fields. A task for an enabled bare agent is written into that agent's `.cinna/tasks/` as a file; every other task is stored here only.
6. **Move a task.** Drag a card to Backlog, Ready or Done, or use the card's **⋯ → Move to…** — the same moves, reachable by keyboard. The card moves at once; if main refuses, it goes back and the reason appears in one line under the controls.
7. **Edit a task.** On the task page, **⋯ → Edit task…** opens every field: title, description, priority, status (the manual targets only — a folder task's in its folder's words), assignee and custom fields. A field that cannot change says why in one line under it. A folder task's nested or long custom fields are listed under **Read-only fields**, to be edited in the file.
8. **Run the agent's queue.** Filtered to one folder agent whose queue Cinna works, the controls row gains a split button: **Run next** starts that agent's next Ready task, and the chevron opens the run mode (**Manual** / **One at a time**) with the current one checked. A started task stays where it is in the view: its row moves to In progress by itself. A task whose file needs approval opens the Inbox on its card. When the queue is paused, the left half becomes **Resume** in the warning tone, and its tooltip says what paused it. The menu then also offers the task it paused on and Run next. See [the task dispatcher](../tasks/task_dispatcher.md).
9. **Go back.** A task page opened from the Tasks view — or reached from such a page through its parent or a subtask — shows **Back to Tasks**.
10. **Turn it off.** Settings → Features → Interface → **Tasks button** (on by default) removes the button; turning it off while the view is open returns to the chats.

## Business Rules

### Categories, not raw statuses

- **The user reads categories.** `in_progress` is a column name, and `refining` and `new` mean the same thing to someone looking at their work. Every surface that names a status — the pill, the page's status icon tooltip, a row's accessible name, a card, the dialogs — uses the same words, so a task is not "Backlog" on the board and "new" on its page. A folder task names its status by its file's word on every one of those surfaces alike, for the same reason: the word the agent and the file use is the one the user reads.
- **A status this build does not know prints itself.** The run screen's pill can carry a value an older server sends (`succeeded`); it reads as words, never guessed into a category.
- **Archived is not on the view.** The root query excludes it, as Recent tasks does.

### Manual moves

- **Only from a user column, only to a user column (or Cancelled).** A task In progress or Waiting belongs to a run or a question: closing it by hand would settle a run that is still working. Main refuses with *"This task is in progress — let its run finish it, or stop the run."* or the Waiting equivalent, and the board offers no drag or ⋯ for such a card.
- **The overlay exists for work no service judges.** The pinned table cannot send a task back from Ready to Backlog, nor close one that never started. For a task that lives only here that is bookkeeping, so three moves the table lacks are added: Ready → Backlog, Backlog → Done and Ready → Done. A task **bound** to a service keeps the table unchanged, because its status goes up as a path of legal steps and these pairs have none — the board offers that task only what the service would accept. A [folder task](../tasks/folder_tasks.md) is bound too, but a file keeps no transition table (`transitionTable: false`), so it moves by the overlay like an unbound task.
- **Done is where finished work stays.** Done, Failed and Cancelled have nowhere to go by hand, except that a Failed task may go back to Backlog (the table's `error → new`). Archiving and reopening are not manual moves.
- **Refused while something else owns the status.** A coordinator or script runtime ends its task and keeps a checkpoint for it; a turn live in the task's chat is about to write the status itself. A manual move is refused in both cases, with the reason.
- **A manual close does not invent a job result.** Closing a task by hand when its job run is still pending or running is refused: settling that run as succeeded would record work that never happened. A task whose run already finished is closed alone.
- **The task must be held here.** Like every status write, the device claim decides: a task another device holds or a remote service runs has no moves on the board.
- **Refusals are sentences.** Main words a refused move in category words — *"This task can't move from Ready to Done: it is tracked on the connected service, which doesn't allow that step."* — and never names the service, which is the adapters' business.
- **A folder board adds Cancelled and its own words.** Its droppable columns are every column whose status is `new`, `open`, `completed` or `cancelled` — never Active, Waiting, Failed, Hidden or an unmapped word. A drop of a file task sends the column's word with its status, and main refuses a word that does not mean that status in that folder, or any word for a task with no file. The rules are in [Folder Tasks](../tasks/folder_tasks.md#the-folder-board).
- **A drop does not flicker back.** The board shows the moved card in its new column until a read confirms the write, or shows any status other than the one the move left — something newer has spoken, and the read is the truth again. A second move of the same card keeps its own pending state.

### Writing and editing tasks

- **New task asks for one thing.** Everything main can default, it defaults: the goal is the title, it starts in Backlog, it is local, run by this desktop (claimed by this device once the profile has a sync identity) and routed directly. A new task can start only in Backlog or Ready.
- **The assignee is fixed once a run could have started from it.** It can change only while the task has no conversation, this device holds the claim, no service is bound (the remote assigns its own), it does not live in an agent's folder (the folder is the assignee), it is not a script (its steps name their agents) and no runtime owns it. The dialog disables the control with the reason; main refuses the write regardless. Title, description, priority and custom fields stay writable when the assignee is not.
- **Only an enabled agent can be chosen.** An agent missing from the profile, or switched off in it, is refused with *"That agent is unavailable. Choose another agent."*
- **Edit task writes the status first.** It is the write main is likelier to refuse, and when it is refused nothing has been saved. If the status saves and the rest is refused, the dialog says exactly that and keeps the other edits in the form.
- **Dialogs close on success only.** A refusal stays in the dialog. Escape and an outside click close an untouched form; once the user has typed, Cancel is the only way to discard it.

### Custom fields

- **Scalars and flat lists, named like identifiers.** A key starts with a letter, then letters, digits, `-` or `_`, at most 64 characters; at most 50 fields; text at most 2000 characters. Nested values are refused because the task file format keeps them as frontmatter, where a nested value would not survive a line-level edit. A nested value a task file already holds is shown read-only and never written.
- **Built-in names are reserved.** `status`, `title`, `priority`, `assignee`, `goal`, `description`, `id`, `parent`, `blocked_by`, `origin`, `created`, `updated` and `cinna_task` belong to the task file format; a custom `status` would be read back as the task's status.
- **Edited values are text.** A value the user types is stored as text; a number or a list the user did not touch keeps its type.
- **Shown as written.** Under their own **Fields** heading in Details, keys in the user's own case rather than the built-in rows' small capitals, so a field called "Status" cannot be mistaken for the task's status. An empty value has no row; no non-empty field, no heading.
- **They travel to the user's other devices, and to a task file — not to a service.** A bound task's custom-field edit carries a remote dirty marker like any field; a [folder task](../tasks/folder_tasks.md) writes it into its file's frontmatter, and a service with no field for them (cinna-core) drops the marker on the next push. On device sync, a payload from an older build that does not carry the key keeps this device's fields; an explicit null clears them; a value this build refuses is left alone rather than half-applied. See [A Task on the User's Other Devices](../tasks/cross_device.md).

### Layout

- **Nothing moves under the user.** Every list section and board column is always present; rows keep the order they were first seen for as long as the view is open, so a poll cannot move a row under the pointer; a refused move's sentence is laid over the gap under the controls rather than inserted above the board; the drop highlight is an outline, not a border, so a column never resizes.
- **Controls first, in one row.** Title, List | Board, agent filter, search and New task stay on one line down to the 800 px minimum beside the sidebar; the layout switch drops its words for icons and the search shrinks first. List and board share one width, so switching between them moves no control.
- **The queue control follows the filter, never the search.** It appears only when the agent filter names a folder agent with a queue, so typing in the search moves nothing. With it in the row, narrow widths shrink the search to its glyph and a few characters, with no placeholder it could not show whole, and Run next drops its word for its icon. A pause changes the control in place and adds no row above the list, so a poll that pauses the queue moves nothing; the Inbox card is what asks for attention. Its actions belong to the view, not to the menu, so a result outlives the menu closing. A refusal shows in the same overlay slot under the controls as a refused move. It is secondary-styled, so New task stays the row's one primary action.
- **The view polls, like the Inbox.** The root list re-reads every five seconds, and opening the view nudges device sync as the Inbox and task page do — the rows read local SQLite, so without it a task another device finished would read In progress until the next sync cycle. A failed read keeps the rows and shows **Try again** below them.

## Architecture Overview

```
Top bar Tasks button → ui.store activeView 'tasks' → TasksView
TasksView → useTaskList({rootOnly}) → task:list → taskService.list
Board drop / ⋯ Move to / Edit task status → task:set-status (status, folder word?) → taskAuthoringService.setStatus → taskService.setStatus(…, {manual: true, bound, label})
Folder board → task:folder-board → taskSyncService.folderBoard → folder adapter localHome.board
Filtered to one folder agent → taskDispatch:list / run-next / set-mode / resume → taskDispatchService
New task → task:create → taskAuthoringService.createRouted → taskService.create | taskSyncService.createInHome (bare agent: writes the file)
Edit task fields → task:update → taskAuthoringService.update → taskService.update
Task write → device sync (custom fields travel; folder tasks never do) / bound push (custom fields to a task file only)
```

## Integration Points

- [Tasks and the Inbox](../tasks/tasks.md) — the task record, the task page this view opens, its ⋯ menu and its back-arrow rules. [Technical details](../tasks/tasks_tech.md).
- [The Inbox](../tasks/inbox.md) — Recent tasks share this view's row; Waiting tasks are answered there.
- [Keeping a Bound Task in Step](../tasks/remote_sync.md) — why a bound task keeps the pinned transition table, and how a pulled timestamp never hides a local edit.
- [A Task on the User's Other Devices](../tasks/cross_device.md) — the claim that gates moves and the assignee; how custom fields travel.
- [Folder Tasks](../tasks/folder_tasks.md) — the status words, the folder board, and the File and Blocked by rows on the task page.
- [The Task Dispatcher](../tasks/task_dispatcher.md) — the queue behind the filtered view's Run next / Resume control and the task page's Start.
- [App Shell](../../ui/app_shell/app_shell.md) — the top bar and its button order.
- [Settings](../../ui/settings/settings.md) — the Tasks button toggle in Features → Interface.
- [UX rules](../../development/ui_guidelines/ux_rules.md) — no jumping, controls first, errors that close nothing.
- [Technical details](tasks_view_tech.md).
