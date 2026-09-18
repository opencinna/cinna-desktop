# File Handovers — a project folder is a task inbox

## Purpose

Any folder Cinna has adopted as a [bare agent](../../agents/local_agents/bare_agents.md) also has an inbox: `.cinna/handovers/<id>/brief.md` inside it is a request for work. The desktop notices the file, records it as a **task assigned to that folder's agent**, asks in the Inbox or — where the user has opted in for that project — runs it, and reads the `report.md` that comes back. When the report is final, the conversation that asked for the work is told.

The handoff artifact is a **file**, which is the whole point: the requester may be a Cinna agent on its own turn, a `claude` in a terminal, a shell script or a person, and so may the executor. Nothing in the exchange needs both ends to be this app.

## Core Concepts

- **Brief** — `brief.md` in a handover folder. The requester's side, written once and never edited after it says `status: ready`.
- **Report** — `report.md` beside it. The executor's side, and the only file it owns; it may be rewritten as often as the executor likes.
- **Revision** — `revisions/NNN.md`, the requester coming back with more to say about a handover already under way. Each one immutable; a correction to a revision is the next revision.
- **Handover id** — the directory name, chosen by the requester: 3 to 64 characters, lower case, starting with a letter or digit, then dots, dashes and underscores (`20260917-1430-add-retry` is the recommended shape). Unique **per folder**, not globally.
- **Executor** — the bare agent whose folder holds the brief. **Requester** — whoever wrote it; a Cinna agent names itself in the brief's `origin:` block.
- **Gate** — the Inbox question asked before a brief runs, when the project has not been set to run them automatically.
- **Intake state** — where the handover is from the desktop's side: `seen`, `gated`, `running`, `waiting_external`, `blocked`, `done`, `failed`, `skipped`, `refused`. Wider than the report's vocabulary, because it also records what the desktop did or declined to do.
- **Warning** — something worth saying about a handover that is carrying on anyway, as distinct from a refusal, which stops it.
- **Withdrawal** — the requester deleting its own brief. It is how an ask is taken back, so the row remembers *when* the brief stopped being on disk and stops naming a directory that is no longer there.
- **Return packet** — what the origin chat is told when a handover it asked for reaches an end: id, status, summary, project path, task id, artifacts and a capped copy of the report body.
- **Depth** — how far down a chain of handovers this one is. A requester writes its own depth plus one; the cap is 2.

## The Contract

```
<project>/.cinna/handovers/<id>/
  brief.md          the requester writes it once — immutable after status: ready
  report.md         the executor writes it, and rewrites it freely
  revisions/001.md  the requester's follow-ups, each written once
```

**`brief.md` frontmatter**

| Key | Required | Meaning |
|---|---|---|
| `cinna_handover` | yes | Marker *and* schema version, `1`. Without it the folder is not a handover and is ignored in silence — it is somebody else's markdown |
| `title` | yes | Becomes the task's title and the gate's question |
| `status` | yes | `draft` or `ready`. Only `ready` is picked up. **There is no default**: between "run this" and "somebody is still typing" there is no safe guess, so a brief without one is a visible parse failure rather than a file that silently never runs |
| `execution` | no (`ask`) | `ask` or `auto`. A *request*, never a permission — see the security boundary below |
| `origin` | no | A nested map of `agent`, `chat`, `task`. Nothing is inferred; a brief with no origin is a human-origin handover |
| `depth` | no (`1`) | The requester's own depth plus one |
| `group` | no | A fan-out group id, so one requester handing the same work to several projects hears back once |

Anything else in the frontmatter is ignored rather than refused, so a newer writer's extra keys do not make an older build reject the file.

**`report.md` frontmatter** carries the same marker, a `status` of `in_progress | blocked | done | failed`, a required one-line `summary`, an optional `question` (the point of a `blocked` report) and an optional `artifacts` list of paths relative to the project. `done` and `failed` are terminal; `blocked` is a question for the requester; `in_progress` updates progress and, before a turn starts, **claims** the brief.

- **The summary is required because a report nobody summarised is a report nobody can see in a list.** It becomes the task's handoff note together with the body, the first line of the return packet, and the one line a group packet shows per member.
- **A shape that is not a list under `artifacts:` is a refusal, not a guess.** An artifact is something the task page links to. The two list-item forms a real executor has been seen writing — `- path: src/x.ts` and `- file: …` — are read as the path they can only have meant; any other map shape is reported as unreadable. (`name: "path: RETRY.md"` reaching a task is how that rule was learned.)

**The "How to report" footer belongs in the brief.** The requester is told to end the brief with the reporting instructions verbatim — where to write, which statuses exist, and to write `status: in_progress` *before* starting. It is in the brief because the executor may be a terminal session Cinna never talks to, and the footer is all it gets.

When Cinna runs the executor, the task's description says the same thing in about fifty words: read the brief at this path, write `report.md` beside it with the marker, one of the four statuses and a one-line summary, `in_progress` before you start and a final status when you stop, and do not edit the brief. Two things it may **not** do. It may not repeat the whole vocabulary — the `artifacts:` list, the `question:` line, the wording of each status — which turned the Description into a 250-word paragraph naming the same absolute path three times. And it may not describe the brief: it used to say the brief "ends with the exact format", which is only true of a brief written from this app's own template. Anything can write a brief, the footer is a recommendation, and an executor sent to look for a format that is not there has been told something false about a file.

**Readable, not perfect.** A handover is acted on when the frontmatter parses, carries the marker and says `ready`. Writers are asked to write whole files (temp file, then rename); a half-written one simply parses on the next event or the next scan. The frontmatter subset is deliberately small — flat `key: value` scalars, the one nested `origin:` map, and `artifacts:` as a list — and is read by hand rather than by a YAML library the project does not otherwise have. The closing `---` is the first later line that is exactly `---`, with no exception for a fence opened inside the frontmatter: tracking fences there would let one stray backtick swallow a whole document, and no value in this contract needs one.

## User Stories / Flows

1. **An agent hands work to another project.** Every folder agent's system prompt carries the requester's half of the protocol, with its own Cinna agent id in it, so it can state `origin.agent`. It writes `.cinna/handovers/<id>/brief.md` into the *other* project and carries on with its own turn.
2. **The desktop notices.** The folder watcher fires within a debounce of the file landing; the minute scan is the backstop. A row is recorded and a task is created for the folder's agent, in `new`, with the brief's title, its body as the goal, and the reporting paragraph — which names the brief's path, once — as the description. Where the brief named a task of the requester's that can be a parent, the new task is filed under it.
3. **The user is asked, or not.** Unless this project is set to run handovers automatically *and* the brief asked for it, an Inbox question appears: **Run**, **Run and auto-run handovers in this project**, **Skip**. It renders as any other question card — an ask has one rendering.
4. **The executor works.** On Run, the task starts a conversation with the folder's agent on the folder's own runtime, and the brief's body is what it is asked to do. Its own permission and question asks reach the Inbox by the ordinary path.
5. **The report comes back.** The executor writes `report.md`. The desktop reads it on the next watch event or scan: `in_progress` updates progress, `blocked` blocks the task and carries the question back, `done` and `failed` close it with the summary and body as the handoff note and the report's artifacts as the task's.
6. **The requester hears.** If the brief named a chat that still answers to the named agent, that chat gets a turn carrying the return packet — as a system row, not as a user message nobody typed. If the origin chat is mid-turn, the packet waits for it rather than racing it.
7. **The requester follows up.** A `revisions/001.md` beside the brief arrives as a new turn on the handover's own conversation, so the session and everything the executor has already read are still there.
8. **Somebody runs it outside the app.** A person in a terminal writes `report.md` with `status: in_progress` before starting. The desktop sees the claim, starts nothing, shows **Outside the app**, and picks the final report up whenever it next looks — including after being closed for the whole job.

## Business Rules

### The three invariants

- **Cinna writes nothing under `.cinna/`, and deletes nothing there either.** Every desktop-side fact — the task id, the run, what the gate said, why something was refused — is a row in SQLite, and the task page is where it is read. There is no mirror file, because a second copy of the truth is a second thing that can be wrong. Retention is the requester's: the protocol says it may delete its own handover folder once the report is final and read, and a person deletes by hand.
- **One brief, one task, forever.** The database enforces it — a unique pair of agent and handover id — rather than a read the next scan could race. An edited `ready` brief is *recorded* with a warning and never acted on: edit-after-ready is the mistake this catches, and the executor may already be working from what the file said the first time.
- **`auto` is the receiving agent's setting, never the brief's.** A brief asking for `execution: auto` is a request. It is honoured only when the agent's own **Handovers** setting says so *and* git says the handovers directory cannot arrive by a pull.

### Auto is a security boundary

A brief run unattended is **arbitrary code execution under that folder's own permission settings**, and a bare folder now runs on exactly those settings. Two things were watched on 2026-09-17 against `claude` 2.1.274 that make this concrete: a project `.mcp.json` server **attaches with no trust step** on the path Cinna uses, where the interactive CLI asks first; and the session's permission mode is taken from the folder's own `defaultMode`, with the desktop's choice only winning because it is set again after every session is created or loaded. Anything that can write to the folder can plant a brief — a `git pull` included.

So:

- **The permission is per agent, lives on the desktop under `userData`, and defaults to asking.** Not in the folder: the folder is writable by whatever can write to the folder. Anything but the literal `auto` off disk reads as *no choice made*, so a hand-edited or foreign state file cannot grant a standing permission by writing something that merely looks affirmative.
- **`auto` is refused while git tracks or does not ignore `.cinna/handovers`.** A folder that is not a repository at all is allowed — nothing can arrive there by pull. An answer git could not give is `unknown`, which is **not** a permission: the failure direction that costs a question is the safe one.
- **The third gate option is offered only when that permission could be given.** Offering "Run and auto-run handovers in this project" and then refusing it on the way back would be worse than a two-option card.
- **A folder with a `.gitignore` but no usable `git` binary** is read statically, and only a short list of literal lines (`.cinna`, `.cinna/handovers`, and their slashed and rooted forms) counts as ignored. A pattern that reading does not recognise is `unknown`, and `unknown` forbids `auto`.

### Depth, and the loop it stops

`MAX_HANDOVER_DEPTH` is 2: a ticket manager at depth 0 hands to project agents at depth 1, which may hand on once more. Above that the brief is recorded, refused with a visible reason, and its task cancelled. **This is also what stops two folders handing work to each other for ever** — a cycle dies within two rounds. The agent runtime deliberately keeps one level of hierarchy; this is the explicit, bounded exception to it, and it is one constant to lower later.

### The gate

- **It is an Inbox question, not a new component.** `deliveryOwner: handover` changes only who main hands the answer to, and the card is the ordinary question card.
- **The card says who is asking, and it is not the agent.** A gate is the desktop's question about a brief no agent has been handed yet, so the card reads *Cinna Desktop is asking…* and carries the question's own **Handover** header; "The agent is asking" named an actor that did not exist at that moment. For the same reason the answer modal offers **no** free-text *Other* here: main matches the answer against the three option labels, so a typed reply could only come back as an error the user cannot act on — the same reasoning that drops the third option where git forbids `auto`.
- **The gate's chat is created hidden.** An Inbox row must name a chat, and a task that has not started has none — so the gate brings one. It is hidden from the sidebar because the user has not decided anything yet, and an empty conversation appearing the moment a file lands in a project folder is the app moving under their hands. It is promoted into the list the moment a turn actually starts in it.
- **The task stays `new` while the gate is open.** Marking it blocked would claim work is under way that nobody has agreed to yet.
- **Skip cancels the task and leaves the folder exactly as it is.** The brief is still on disk; Cinna simply declined it.
- **An unused gate chat is deleted when the gate is withdrawn; a used one is not.** A hidden chat is still reachable by link or search, and a user who opened it and talked to the agent has a conversation. There is no undo for a permanent delete, so a chat with anything in it is let go of rather than destroyed — the row stops pointing at it and it appears in the list.
- **A refused start does not reopen the offer.** The Inbox row has already been answered, so the row goes back to `gated` as a *label* with the refusal recorded; no second card appears, and the task can be started from its own page.
- **A gate that could not be opened is asked again on the next scan.** If the ask row, the task write or the row patch failed, the handover is left recorded with nobody asked about it — and a known row never goes back through intake, so a brief nobody was ever offered sat in a folder for ever with its task in `new` and no card in the Inbox. The retry is deliberately narrow: only a recorded row with a live task, no gate of its own, and **no report status at all** — a brief an outside executor has already claimed must not be offered for a second run.

### Claiming, and running outside the app

An executor that runs outside Cinna writes `report.md` with `status: in_progress` **before** it starts. Intake that finds a readable report beside a brief it has never seen starts nothing: the row becomes `waiting_external`, the task moves to `in_progress`, and the report is applied immediately — so a brief that arrives with a `done` report beside it closes its task without ever running anything here.

**Any report on a gated brief withdraws the card**, whatever the report says. Somebody is answering that brief outside the app, and every status means the same thing for the card: there is no longer an undecided brief to Run. Leaving it open on `blocked` would start a second executor on work an outside one is waiting for an answer about; leaving it open on `done` or `failed` would keep a question attached to finished work, and the borrowed chat with it.

Under `auto`, running the same brief by hand in parallel is the user's own collision; both signals then show on the task page.

### Withdrawing a brief

Deleting the brief is how a requester takes the ask back, and the desktop reads it that way: the task is cancelled, the row becomes `skipped` and an open gate is withdrawn. **Except while a turn is running** — the executor is writing in that folder right now, and cancelling underneath it would abandon work in progress over a file that has already served its purpose. That case is recorded as a warning and nothing else.

The moment the brief goes is recorded on the row even when the task is already over, because the task page prints `.cinna/handovers/<id>` and that row is a claim about a directory on disk. It is cleared the moment a brief with that id is read again — a folder restored from the trash, or one that was simply unreadable for a single scan. A withdrawal and a **Skip** land in the same state and are not the same event: one is a decision about work that was offered, the other is the offer being taken back, and the missing brief is what tells them apart on the page.

### The report wins, and what happens when there is none

- **A terminal report closes the task**, with the summary and body as the handoff note and the report's artifacts as the task's artifacts (resolved against the project folder).
- **A `blocked` report blocks the task and wakes the origin** with the question in the packet. It is a question, not a failure, and it is the return path for one.
- **When Cinna ran the executor and its turn ended without a terminal report**, the turn's own outcome closes the task instead, and the row records that no report was written. The folder is **rescanned first**, so a report written in the last second of the turn still wins. A turn that ended `needs_input` is not an ending at all: the executor parked on its own ask, that ask is in the Inbox, and closing the task would take the question away from the user.
- **A run the app lost is not a run that is still going.** If the app was closed or crashed mid-turn, the handle that would have reported the outcome died with it. A row left `running` for two minutes, whose chat has no live turn, is settled as failed and recorded as a lost run — otherwise the task would sit in progress for ever and the origin would wait for a packet that can never come.
- **An executor parked on a question is not a lost run.** Its turn has genuinely ended, so nothing is live in the chat and the row goes stale while the user reads the card — which is exactly what the sweep above looks for. So the sweep leaves alone any task the Inbox still holds a question about, and a read of that which fails counts as *yes*: the sweep's write closes a task and tells the origin the app had closed, and doing that with the question still on screen is the expensive way to be wrong.
- **A `report.md` that exists and will not parse keeps that warning** when the turn later ends without a terminal report. "No report was written" would tell the executor to write a file it had written; the unreadable one is the more specific fact and the one it has to fix.
- **A report and a revision arriving in the same scan are read in that order**: the executor finishing, then the requester following up — and the follow-up has to be read against the state the report left behind, including a `done` it cannot reopen.

### Waking the origin

- **Origin is validated, never trusted.** The named agent must exist for this profile, and the named chat must still answer to that agent — the same rule a follow-up turn from an engine goes through, and the reason it lives in one shared place. Anything that does not resolve is dropped, the row is warned, and the handover becomes a **human-origin** one: it runs exactly the same way and simply has nobody to wake.
- **A resolved origin task becomes the new task's parent.** The work shows up under the work that asked for it, which is the only cheap way to see a fan-out as one thing. Tasks are one level deep, so a brief whose requesting task is *itself* a subtask hangs off nothing and the row says so: the handover still runs, and only the tree view of it is lost.
- **A busy origin chat is waited for, not raced.** The origin is very likely mid-turn — it is an agent that farmed work out and carried on. The packet waits up to half an hour, polling; past that it is dropped with a warning, because a chat that never goes idle for half an hour has something else wrong with it and the task page still holds the answer.
- **One turn per origin chat at a time.** Two handovers finishing together is ordinary — fan-out is the point — so packets queue per chat instead of colliding.
- **A packet arrives as a system row.** It generates no chat title (a chat is titled after what the person said in it, not after another project's report), carries no A2A message id, and leaves no interrupted-turn marker — a relaunch must not offer to resend a message nobody typed.
- **The packet's body is cut from the end, not the front.** This is the opposite of the catch-up packet, and deliberately so: a transcript's newest lines are what an agent needs, while a report is written top-down and its *beginning* carries the answer.
- **A wake fires once per report, and once more when the report is genuinely a new one.** The digest of the report file is what guarantees the first half: a rescan over identical bytes never reaches the wake at all, so a `done` report sitting in a folder for a week wakes the origin on the day it was written and never again. The second half is the record of having woken, which is *cleared* when a new digest lands — so an executor that rewrites its report with something new to say is news again, while the same bytes read a hundred times are not. The two used to disagree with each other: the fan-in path skipped a member it had already reported, so a rewritten group report was never spoken about again, while the single path read that record not at all and told the origin the same thing twice.

### Groups and revisions

- **A group wakes once, when all of it is over.** A requester that handed the same work to five projects hears one packet listing five results rather than five packets over an hour. "All" means every row the desktop currently knows with that group id under that origin chat — there is no list of intended members anywhere, because `group:` is a string in a file and a sixth brief may be written an hour from now. A member that arrives after the group has been reported wakes on its own. `skipped` and `refused` members count as finished; `blocked` is exempt, because a question that waits for four other projects is a question nobody answers.
- **A revision is a new turn on the handover's own chat**, never a second task. It is not delivered while the brief has not run yet (the executor will read the folder when it starts), nor when nothing of ours is running it, nor after the task is over — a completed task can only be archived, so there is no turn to carry it, and the requester needs a new brief. A **failed** task is different: a revision is exactly how a requester says "try again, like this".
- **Order is the whole meaning of `NNN`**, so a revision file that will not parse holds the ones behind it rather than being stepped over, and says so on the row.

### One pass over a folder at a time

A scan is not atomic: it waits on a `git` subprocess and on a start, and while it does, the minute tick or a watch event can begin a second pass over the same folder. Both would then act on the same rows — the same report applied twice, the origin woken twice, a withdrawal decided against a state that had since changed. So **a folder gets one pass at a time, with at most one waiting behind it**: two callers arriving while a pass runs share that one follow-up, because the pass reads the folder afresh anyway and a second identical sweep would only cost another subprocess.

That is half the answer. The other half is that **every row is re-read immediately before it is acted on**, never taken from the list the pass started with: between the two, a turn may have finished, an Inbox answer may have started an executor, or a report may have moved the row on.

A scan that looks at nothing new must also cost nothing. The mtime and size of `brief.md` and `report.md` as the last scan found them are kept on the row, so a file that has not been touched is not opened or hashed — the digests then say whether the content moved, and the stamps say whether it is worth asking. A stamp may only ever *skip* work: a file that cannot be stat'ed has no stamp, which matches nothing and always falls through to the read.

### Where the user sees it

- **The task page** adds rows to the Details panel it already has, never a banner:
  - **Requested by** — the requesting agent's name, or *Outside the app* for a brief a person or a script wrote. It opens that agent's page where the app still lists one, styled exactly as the Assignee row above it. While the agent list is still loading the row waits rather than saying *Outside the app*, which is a real answer and must not double as "not loaded yet". The label carries the word once: it used to read "Handover from Planner" directly above a row labelled **Handover**.
  - **Handover** — where the handover is, in one phrase that fits one line: *Recorded*, *Waiting in the Inbox*, *Running*, *Outside the app*, *Needs an answer*, *Done*, *Failed*, *Skipped*, *Withdrawn*, *Refused: too deep*. The panel polls every five seconds and this is the row that changes, so a phrase that wrapped moved every row under it while the user was reading them; the longer sentence is on hover, and anything that does not fit belongs in the Note row, which may lengthen the panel and moves nothing.
  - **Folder** — the handover directory, and **only while the brief is on disk**: naming a directory the requester has deleted is a claim about a file that is gone. Plain text, never a button — Finder hides dotfiles, so revealing a `.cinna/…` path would select nothing the user can see. One line, elided around the handover id, which is the part that identifies it and is never cut; the whole path is in the row's tooltip, which is where it is copied from.
  - **Note** — last, and only when there is something to say: the warning, or the withdrawal, which has no warning of its own because nothing went wrong.
- **Every vocabulary is translated in one place**, so the task page and the agent card cannot describe the same row two different ways. **Every warning kind has a sentence**, and a list of the kinds is what a test walks, so the next one added to the union arrives with its sentence; seven of the sixteen had one and a task page read the raw token `report_missing` at the user. A kind from a *newer* build still renders as it arrived rather than blank — it came from this app, and a support conversation can use it.
- **The agent's Permissions tab** carries the **Handovers** setting for a bare folder, with a line under it saying what git answered. That line is always rendered, because it has something true to say in every state and because it is the only thing that explains a greyed-out *Run automatically*.
- **The setting shows what would happen, not what is stored.** A folder set to *Run automatically* whose handovers git has since started tracking asks anyway, so the select reads *Ask before running* and the line beneath it says the setting is there and not in force. A control displaying a value the app will not act on made the user read the refusal as the bug. The stored `auto` is not lost — it comes back into force by itself once git stops objecting — and because choosing *Ask* in a select that already shows *Ask* changes nothing, that line carries the one action that clears it: **Switch to ask**.
- **A task page reads a live row.** While a handover is still moving the page polls; a settled one stops.

### The trade-off, stated

**The app must be open.** The watcher gives latency and the minute tick gives correctness, but neither runs when Cinna does not. A brief written while the app is closed is picked up when it next starts; work somebody ran in a terminal meanwhile is read off its report at that point, and the task finishes and the origin is woken then. There is no OS-level scheduler here — the same trade-off [local schedules](local_schedules.md) and [autonomous tasks](autonomous_tasks.md) already make.

### What this feature deliberately does not do

- **Kit agents are not targets.** A kit folder is published and Cinna already writes into it, so a `.cinna/handovers` there would travel to whoever installed the kit. Kit agents, the model coordinator and scripts are all perfectly good *requesters*.
- **Remote agents are not targets** — A2A, Managed and WebSocket ACP agents have no folder on this disk to hold a brief.
- **Nothing here is a synchronous call.** A handover is durable and asynchronous by construction; an agent calling another agent as a tool within one turn is a different channel.
- **The desktop never tidies the folder.** Not the brief, not the report, not a handover whose task was deleted.
- **No new Inbox component, no new ask kind, no new task origin.** `tasks.origin` stays `local`; the handover row is the only link between a task and the folder it came from.

## Architecture Overview

```
requester (agent / terminal / script / person)
   writes  <project>/.cinna/handovers/<id>/brief.md
                    |
   folder watcher (debounced, not deferred on the turn lock)
   + minute scheduler (activation, window focus, wake)
                    |
              handover intake  ──► handovers row + task (new)
                    |
         ┌──────────┴───────────┐
       gate (Inbox question)   auto (agent setting + git check)
         └──────────┬───────────┘
                    ▼
          task execution ─► folder agent turn (folder's own runtime)
                    |
   executor writes report.md ──► scan ──► task status, note, artifacts
                    |
             return packet ──► origin chat, as a system turn
```

## Integration Points

- [Bare Agents & External Roots](../../agents/local_agents/bare_agents.md) — what a handover target is, and why it runs on the folder's own setup
- [Local Agent Permissions](../../agents/local_agents/permissions.md) — the tab the **Handovers** setting sits on, beside Approvals and the standing grants
- [The Inbox](inbox.md) — where a gate is answered, and the `handover` delivery owner
- [Tasks and the Inbox](tasks.md) — the task a brief becomes, and the page that shows its origin
- [Autonomous Tasks](autonomous_tasks.md) — the bounded exception to one level of hierarchy, and the same app-must-be-open trade-off
- [Turn Outcomes and Completion Ownership](../../chat/messaging/turn_completion.md) — the `handover` input origin, the system row it writes, and the wire-only turn header
- [Chat Routing](../../chat/chat_routing/chat_routing.md) — the catch-up packet the turn header is prepended in front of
- [Technical details](file_handovers_tech.md) — files, schema, IPC, services and tests
