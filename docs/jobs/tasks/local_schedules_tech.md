# Local Schedules: Technical Details

## Ownership and files

Agent schedules keep `cinna-agent.json` `schedules[]` as their portable definition source. Local Job schedules store timing rules only in the profile/device binding store and reference the existing source Job. `static_prompt` and `script_trigger`, `cron_string`, `timezone`, `prompt`, and `command` retain their manifest meanings. Schedule names remain identity within a stable kit manifest ID; no mandatory schedule UUID is added to the manifest.

Key implementation areas:

- `src/shared/localSchedules.ts`, `src/shared/scheduleTemplates.ts`, and `src/shared/scheduleTiming.ts`: IPC contracts, execution union, templates, and editor timing normalization.
- `src/main/services/localScheduleService.ts`, `jobScheduleService.ts`, and `localScheduleScheduler.ts`: agent/Job review and durable admission under one shared scheduler, reconciliation, and lifecycle triggers.
- `src/main/tasks/scheduleCron.ts`: numeric cron parsing, matching, and timezone-aware next occurrence.
- `src/main/db/localSchedules.ts`, `schema.ts`, and migrations: profile-local bindings and receipts.
- `src/main/services/localAgents/localAgentService.ts` and `commandService.ts`: stamped manifest edits, catalog resolution, and structured subprocess execution.
- `src/main/services/jobExecution/scheduled.ts`, `scriptRuntimeService.ts`, and `coordinatorJobService.ts`: transaction-safe Job preparation and post-commit dispatch.
- `src/main/ipc/localSchedule.ipc.ts`, `src/preload/index.ts`, `src/renderer/src/components/agents/local/SchedulesTab.tsx`, and `src/renderer/src/components/jobs/JobSchedules.tsx`: scoped lists with the on/off switch, history, and Stop surfaces. `SchedulesTab.tsx` exports the pieces both lists share (`ScheduleSwitch`, `ScheduleTimingLine`, `ScheduleNextLine`, `scheduleRowVersion`, `ScheduleActions`); `JobSchedules.tsx` also exports `useJobScheduleCount` for the Job page's tab badge.
- `src/renderer/src/components/agents/local/ScheduleEditor.tsx` (the one editor for both targets, with the agent type chooser, `BadgeMultiSelect`, the cron reference dialog and `scheduleTimingLabel`), `TimezonePicker.tsx` (`timezoneOptions`, `timezoneOffset`, `matchesTimezone`), `cronCheatsheet.md` (the reference text, imported with `?raw` and rendered as markdown), `scheduleClock.ts` (`scheduleTime`, `relativeTimeUntil`, `useNow`), and `ScheduleHistory.tsx`.
- `src/renderer/src/components/jobs/JobDetail.tsx`: the **Prompt | Schedules** tabs on a schedulable Job.

## Timing authority and editor

Built-in `ScheduleTemplate` records have stable IDs, versions, labels, and structured weekday/hour rules. `workday-morning` is `0 8 * * 1-5`; `workday-hourly` is `0 9-18 * * 1-5`, including 18:00. Custom and Advanced are form modes, not templates. Shared/main logic validates unique sorted numeric day/hour sets and compiles Custom as minute zero across all selected combinations.

The effective cron and explicit canonical IANA timezone determine execution. Optional editor metadata stays device-local; template updates cannot change saved definitions. Metadata that disagrees with an externally changed cron is discarded. Existing definitions without metadata remain valid, and rules that cannot be represented by the days/hours editor reopen in Advanced. Switching away from advanced text must make replacement explicit and retain the unsaved advanced value within the form.

A new agent schedule opens on a type chooser, not the form: a `role="group"` "Schedule type" of two cards, **Prompt schedule** (`static_prompt`) and **Script schedule** (`script_trigger`). `typeChosen` starts true for an edit and for a Job schedule, so only a new agent schedule sees it. Picking a card sets `executionType` and shows the form; the form's **Back** (new agent schedules only) clears the error and returns to the cards, keeping what was typed. The title names the type once it is known — "New prompt schedule", "Edit script schedule" — and is plain "New schedule" on the chooser and for every Job schedule. Execution type is immutable after creation, so an edit has no type control, no chooser and no Back: a control that can never be used is one more thing to read on every edit.

The form shows the agent schedule's prompt or command (a Job schedule's editor has neither: the Job page behind it shows the Job), the schedule and timezone on one row (`sm:grid-cols-[minmax(0,1fr)_15rem]`), the timing summary, the next occurrence, and a script's resolved command. Every label sits in its own `mb-1.5` span above its control, and the Name input, the Schedule `<select>` and the timezone trigger are all `h-9`, so the two controls on the shared row line up top and bottom. Catch-up and per-type limits sit in a `SettingsInfoTip` beside the title. **Create schedule** / **Save schedule** uses `schedulePrimaryButtonClass`, the accent fill with `--color-accent-hover` that the page's Start chat uses.

The editor has no enable control; `enabled` is derived, not state. A new schedule is `true`; an edit sends `item.binding?.enabled ?? false`, the value the list's switch shows. Main already reports a binding held back by a reason as `enabled: false` (`binding.enabled && !reason` in `rowsFor`, `row.enabled && !problem` in `jobScheduleService.list`), so editing such a schedule saves it off and `save` writes `reason: null`. That is deliberate: a save must not turn a schedule on that the user has not seen go on. The submit button reads **Create schedule** or **Save schedule**; the save warning reads "Saved, but not turned on."

The next-time line is "Next scheduled time: <time in the zone> · <relativeTimeUntil>", "Next scheduled time: —" while cron or timezone is blank (the preview effect never fires then, so "Checking…" would never resolve), and the preview's error text on failure. `relativeTimeUntil` names the two largest units and drops a zero second unit ("in 3 days", never "in 3 days 0 hours" or a jump to minutes), says "now" within the minute just past and "overdue" beyond it. `useNow` re-reads the clock every 30 seconds so the suffix stays current in an open editor or list.

Custom days and hours are two `BadgeMultiSelect`s stacked in one column, each the editor's full width: chosen values as badges with a × each, and a `<select>` offering the rest. Values are re-sorted into the options' order on every change, so the saved rule does not depend on pick order. A × ignores `event.detail > 1`: the next badge slides under the pointer, and the second click of a double click would remove a value nobody aimed at. After a removal, focus moves to the × now in that place, else the one before, else the picker — never `<body>`.

The editor `<dialog>` is `w-[38rem]`; the delete confirmation on both lists (`scheduleDialogClass`) is `w-[32rem]`. It is pinned to `mt-[10vh]` rather than centred, because it grows while the user works (badges wrap, the advanced field appears) and a centred dialog would move its title and every field above the one being edited (ux_rules rule 1). The cron reference is a second modal `<dialog>` portaled to `<body>`; its `onCancel` calls `preventDefault` and `stopPropagation`, because React bubbles the cancel through the component tree into the editor's own `onCancel`, and Escape would otherwise close both. Closing it returns focus to the (?) that opened it.

The timezone is a `TimezonePicker`: a button styled as the form's inputs, showing the zone (underscores as spaces) and its current offset, and a `usePopover('below-right')` overlay with a search box and a `role="listbox"` "Timezones", so opening it resizes nothing (ux_rules rule 1). `timezoneOptions(current)` is `Intl.supportedValuesOf('timeZone')` plus `UTC` plus the current value, sorted — a stored zone this runtime does not list must not vanish, or the form would show a different zone than the one saved. `timezoneOffset` always formats in `en-US` (`shortOffset`, "GMT+2"), so searching "gmt+2" works under any system locale, and returns empty for a zone `Intl` rejects. Offsets are computed once per open, since they change only at a DST boundary. `matchesTimezone` is case-insensitive, treats spaces and underscores alike and matches the offset too. Arrow keys move the active option (kept in view with `scrollIntoView`), Enter picks it, and Tab closes the list. Like `SettingsInfoTip`, the overlay portals into `triggerRef.current.closest('dialog')`, because the editor is a modal in the top layer; its Escape calls `preventDefault` and `stopPropagation`, so it closes the list and not the editor, and focus returns to the trigger. The trigger is named by `aria-labelledby` pointing at the "Timezone" span.

## Schedule lists and the switch

`SchedulesTab` (agent) and `JobSchedulesContent` (Job) render the same card: name, `ScheduleTimingLine`, `ScheduleSwitch` (`role="switch"`, labelled "Run “<name>” on this device"), `ScheduleActions`, then the reason line only when there is one, `ScheduleNextLine`, and the latest run. `ScheduleNextLine` is rendered in both states ("Next scheduled time: … · in …" or "Off on this device"), so the switch never adds or removes a line below it.

`ScheduleTimingLine` reads `scheduleTimingLabel(item)`, which classifies the schedule with the same `initialTiming` the editor opens with: a template's label ("Workday morning"), "Custom · <scheduleRuleSummary>" ("Custom · Mon, Wed at 07:00"), or "Cron · <cron>" in mono, then the zone. The card therefore names the choice the user will see selected on Edit, not a cron string they would have to decode; the raw `cron · timezone` stays in the line's `title`.

The switch calls the API directly; there is no enable dialog. Agent: on → `localSchedules.enable({ profileUserId, agentId, name, revision, timezone })`, off → `localSchedules.disable(binding.id)`; it is disabled while the row has a `problem` or no `revision`, which `enable` would refuse anyway. A successful turn-on clears a standing "Saved, but not turned on" warning, which no longer holds. Job: on → `jobSchedules.enable` with `jobRevision` from the list's own snapshot, so the Job revision recorded is the one the user is looking at; main compares it and refuses "The Job changed a moment ago. Try again." if the Job moved. A Job-changed `problem` does not disable the Job switch — turning it on is how the schedule adopts the current Job — whereas an agent `problem` does.

A switch error is stored with `scheduleRowVersion(item)` (revision, problem, enabled, reason) and shown only while the row still has that version. The lists poll every five seconds; without the check, a later poll that brings a new reason line would leave the earlier error under it, describing a state the card no longer shows.

Both list queries use `refetchInterval: 5000` and `refetchOnMount: 'always'`, and neither has a Refresh button: opening the tab must show what the scheduler did since, not a cached list from a few seconds ago. `useJobScheduleCount` reads the same `['job-schedules', profileUserId, jobId]` key for the Job page's tab badge, with no poll of its own (the list polls while it is on screen) and `enabled` false for a Job that cannot be scheduled.

The Job page's tab state lives in `JobDetail` above its early returns, so the chosen tab survives moving from Job to Job, as the agent page's tabs do (ux_rules rule 2). A Job for which `canScheduleJob(job.type)` is false gets no tabs, only its **Prompt** section.

The editor and the cards put explanation in `SettingsInfoTip`. Inside a modal `<dialog>` the tip portals into `triggerRef.current.closest('dialog')` rather than `<body>` — a modal dialog is in the top layer and makes the rest of the document inert, so a tip on `<body>` would render behind it — and its Escape handler calls `preventDefault`, so Escape closes the tip and not the dialog.

## Manifest edits and review

All mutations capture the active profile/settings scope in main and validate the caller's profile and stale-write/review tokens. The renderer does not authorize execution or write files. Folder edits use the existing per-agent editor lock, expected file stamp, validation, atomic replacement, and preservation of unrelated/unknown fields.

Filesystem and SQLite changes cannot be one transaction. Save the stamped manifest first, reread and validate the resulting definition, then update local consent. A failed binding update leaves the definition saved but off; the old revision cannot admit new work. A stale editor must not overwrite external edits. An in-app rename moves the existing binding, receipts, and historical Job overlap set. An external rename is a removed declaration plus a new declaration with no binding (off on this device).

`localScheduleService.save`/`delete` compare the caller's `revision` against the row's current one, including `null`. A row with a `problem` has a null revision, so the editor can still save or delete it. Rejecting those rows would leave the problem unfixable in the one place built to fix it. `enable` still refuses any row that has a problem or no revision.

The manifest's `enabled` field is the author's portable intent; device opt-in lives only in the binding. `save` builds the entry from the original, keeping any existing `enabled` value exactly, and never adds one. It validates the form with `enabled` masked, so an author-disabled entry stays editable. After the write, a disabled save masks `enabled` again and updates the binding without a warning. An enabled save re-reads the entry unmasked, so `definitionFor` refuses it with "This schedule is disabled in the manifest". The caller gets the usual "Saved, but not turned on" warning.

A generated Job belongs to one reviewed revision. `save` and `enable` reuse `binding.jobId` only when `prior.revision` equals the revision being saved or reviewed, and the Job's fingerprint still matches. Otherwise an enabling prompt schedule creates a fresh Job. A disabled save carries no Job forward (`jobId: ''`), so a later `enable` generates one for the definition it reviews. `jobIds` keeps every earlier Job for history and overlap.

Fresh validation checks kit identity, effective agent enablement, runnable readiness, unique schedule name, execution type, literal prompt or command, cron, timezone, and resolved catalog entry. Readiness `credentials_needed` warns as it does for ordinary work; `invalid` and `contract_too_new` refuse. A `/run:<name>` revision includes the resolved/localized command, so catalog edits invalidate consent. Script file contents are not whole-folder hashed.

## Durable state and migration

Bindings retain profile, manifest identity, schedule name, reviewed definition/revision, local enablement, generated Job fingerprint and historical Job IDs, monotonic clock protection, a next-due UTC instant, and editor metadata. Scripts need no Job until an agent follow-up is required.

Receipts retain the captured definition/revision, original due civil key and UTC instant, observation/coverage time, scheduled versus catch-up trigger, actual start/finish times, lifecycle status, structured command outcome, and any task/run/chat links. Lifecycle and result are distinct: storing a command result or linking a follow-up task is not equivalent to completing that task. Receipt references survive deletion of task/run/chat evidence. Bindings and receipts cascade with their profile and never enter sync.

The idempotent migration preserves old prompt definitions, history, generated Jobs, historical overlap, and enablement. Old bindings receive a next-due baseline strictly after migration time, preventing retroactive catch-up for downtime the old scheduler deliberately skipped. It never enables disabled or previously unsupported declarations. An enabled binding it cannot carry forward (a script schedule, or a definition whose next time cannot be computed) is turned off with the stored reason "Review this schedule after upgrading." — that string is persisted in existing databases and shown as the card's reason; the switch turns such a schedule back on like any other.

Polls use enabled/profile/due indexes and bounded unfinished-work predicates. Ordinary lists fetch latest receipts; history is paginated. Terminal history must not be deserialized on each tick.

## Admission and catch-up

One scheduler handles startup/profile activation, aligned minute ticks, focus, and resume. Scope/generation invalidation remains authoritative after asynchronous boundaries. Stopping or switching profiles cancels/interrupts tracked execution and stops new admission; it does not disable consent or reset the due cursor.

1. Capture scope, generation, and observation time; validate the live definition and binding revision. Unreadable/transiently unavailable folders retain their pending due time; confirmed changed or removed definitions turn the binding off with a reason (only the scheduler pass persists that; a list read reports it without writing).
2. Reconcile unfinished receipts from durable task/run evidence and active reservations. Unknown or interrupted work requires explicit recovery and counts for overlap.
3. If the stored next-due instant is after the observation, do nothing. Otherwise consider one occurrence for that stored instant, covering eligible times through the observation.
4. In one SQLite transaction, compare-and-claim the binding cursor/revision, insert the receipt, prepare a prompt Job attempt if needed, and advance next due strictly beyond the observation. Overlap inserts one skipped receipt and consumes the same covered period. Never iterate from old due times to enqueue a historical replay.
5. Commit before launching a process or agent. Recheck scope and persist dispatch intent before the side effect. Actual execution times remain separate from intended due time. The claim's validity check requires both a current scope and the same observed wall-clock minute (`valid()`). The pre-launch gate in `localScheduleService` and `jobScheduleService` checks only `current()`, meaning the profile and scheduler generation. An admitted run that crosses a minute boundary during preparation still launches. Requiring the same minute there would turn a slow but committed occurrence into an interrupted task that needs review.
6. For script results requiring an agent, persist the command result before preparing the task, then atomically link the prepared task before its launch. Never rerun the command because follow-up preparation or launch failed.

Preparation failure rolls back partial task writes. A separate transaction records the failed observation and advances its cursor together; if this cannot commit, launch nothing. Lost processes after committed admission become interrupted work rather than unclaimed due events. This is durable deduplication, not exactly-once external execution.

Every admitted failure consumes the occurrence. Turning a schedule on, or saving a changed definition while it is on, establishes a future-only baseline. Disabled intervals are not due. Later due times during unfinished work are skipped rather than queued; completion never drains a backlog. Distinct overdue schedules each get at most one catch-up.

## Script execution and follow-up

The shared command executor returns separate bounded stdout/stderr, exit code, start/finish times, timeout/abort/spawn errors, and truncation flags. The existing interactive `/run:` behavior is an adapter over this executor. Both use the established shell environment, localized catalog resolution, credential preparation, owning folder, folder turn lock, five-minute timeout, abort handling, and process-tree termination.

The two differ in lock acquisition (`commandService.ts` `executeForAgent`). An interactive `/run:` takes `turnLock.withLock` and is refused with `turn_in_progress` while the agent is busy. `runScheduled` passes a queue signal and waits in `turnLock.withQueuedLock` behind a chat turn, an editor save, or another command. A due occurrence that failed just because a chat happened to be streaming would count as a lost run. The five-minute ceiling starts only inside the lock body, so time spent waiting does not count against it. While a run waits, its receipt is `dispatched` and unfinished, so later due times record overlap skips.

`runScheduled` reports `started`, which is set by the first statement inside the lock body and is never inferred from an error message. When the tracked controller aborts before that point (Stop, sleep/suspend, profile switch, or scheduler stop), `executeScheduledCommand` records the receipt as `cancelled` with "Stopped before the command started; it will not be replayed". It does not hold later occurrences. Once the command has started, the existing rules apply: a user Stop is `cancelled`, while suspend, a profile change, or shutdown is `interrupted` and needs review.

Quiet success requires exit code 0, untruncated stdout, and `stdout.trim() === 'OK'`. Capture that exact-output classification before credential redaction, then redact retained stdout, stderr, and spawn errors. Stderr does not affect that test and remains in history. Other normally completed outcomes, including nonzero exits, start one agent task. Spawn errors and timeouts record an execution error; cancellation and uncertain process outcomes record cancellation/interruption, without automatic rerun. Bounded output belongs in occurrence history rather than general diagnostic logs.

The follow-up prompt includes schedule name, reviewed command, intended due time, actual execution time, exit code, stdout, and stderr, clearly identified as execution output. Store this occurrence-specific input on the task attempt, without mutating the reusable Job or invalidating its fingerprint. The generated one-step script selects the owning manifest identity and retains the ordinary twenty-turn/sixty-minute defaults, Inbox, Stop, and recovery controls.

A script holds the schedule's reservation through its command and any follow-up. Release its folder turn lock before launching the agent to avoid self-deadlock. Long command execution is tracked outside the short scheduler admission pass. Profile change/shutdown must cancel or interrupt that tracked execution. Quiet checks create no empty chat or model invocation; their receipts still provide history and a Stop action while running.

## Known limitations

- The queued lock wait has no cap. A scheduled command held behind a long chat turn runs late, and nothing marks the receipt as late apart from the gap between its due time and actual start time.
- In `turnLock.fireWaiters`, queued acquirers and deferred `whenFree` callbacks, such as the watcher rescan and credential regeneration, share one waiter list and run in order. A queued scheduled command that was registered earlier can take the lock before a deferred rescan or regeneration runs, and that callback then runs while the command holds the lock.

## Cron and clocks

Cron retains five numeric fields, at most 512 characters, supporting wildcards, lists, ranges, positive steps, and Sunday 0/7. A lone numeric value with a step extends to that field's maximum. Wildcard syntax retains wildcard day semantics; explicitly restricted day-of-month and weekday fields combine with OR. Named weekdays, macros, seconds, and Quartz modifiers are rejected.

Next occurrence is computed strictly after the observation using a bounded timezone-aware calendar/field search, not by scanning the missed interval. Impossible rules fail validation; sparse valid rules such as February 29 remain supported. Saved UTC instants compare due times; the saved IANA zone interprets the rule. No operating-system timezone change silently modifies it.

Spring-forward civil gaps have no occurrence. Repeated fall-back minutes share a zone/date/hour/minute civil key and run once, including when the later UTC instant is reached while advancing a cursor. Monotonic observation protection prevents wall-clock rollback from repeating work. Forward jumps collapse into a single catch-up.

## Validation

Focused coverage belongs in cron/timing, schedule service/scheduler, command, migration, and script-runtime tests. Use injected clocks and lifecycle triggers for deterministic multi-day catch-up, enablement baselines, exact-minute/weekend recovery, concurrency, crash stages, overlap, profile changes, catalog edits, output truncation, and DST cases. Renderer coverage verifies the day/hour badges (order, add, remove, double-click, focus), the next-time line and its relative suffix, the pinned dialog, the cron reference's Escape, create-on and edit-keeps-state, the list switch in both directions, the stale-error rule, refetch on mount, the Job page tabs, and advanced-rule round-trip. The built-app schedule flow exercises editor save, quiet script history without a chat, and non-OK follow-up through ordinary task navigation.

Kit schema descriptions are generated from Core's kit source through `make kit-sync`; do not hand-edit the bundle or its tree hash. The existing bundled schema already accepts both schedule types and all fields used by the editor, so this desktop feature requires no schema or contract-version change. The scheduling guidance in the bundle comes from Core's kit source (Core commit `b06af0da`), re-bundled with `make kit-sync` and pinned in `scripts/kit-sync/contract.lock.json`. Contract bundle/conformance tests verify compatibility. Test inventory is not a claim that every validation pass has run; record actual commands and results with the change.

## Scheduling existing local Jobs

A Job schedule references a live, profile-owned `type: local` Job and creates
attempts under that source Job ID. It must not create a generated replacement Job
or inject a turn into an existing chat. `cinna_task` Jobs are outside local
scheduling. Agent and Job bindings have distinct ownership identities in the
shared local schedule tables; agent listing/admission must never treat a Job
binding as a manifest declaration.

The Job revision a schedule records includes its execution fields and dependency
attachments, not only a Job timestamp: prompt, mode, router/script/budget,
attached agent IDs, attached MCP IDs, and portable dependency evidence all affect
what can execute. Normalize attachment ordering for fingerprints. Re-read and
compare that revision in main at save/enable, admission, and any asynchronous
preparation boundary. A changed/deleted source Job cannot execute under stale
consent. Unavailable dependencies must preserve ordinary execution refusal
rather than silently falling back to a different participant.

Job schedule CRUD uses validated profile, source Job, and binding revision
tokens. It requires no manifest filesystem write. The rule, timezone, editor
metadata, consent, next due instant, cursor revision, and receipts remain in
SQLite and outside Job definition sync. Deleting a timing rule stops future
admission while keeping execution evidence. Source Job deletion also stops new
admission. Timing edits and explicit enablement create a future-only baseline.

The existing `localScheduleScheduler` runs both ownership kinds with the same
activation/focus/resume/aligned-minute lifecycle. There is no additional polling
service. Job admission claims the due cursor, writes its occurrence, and prepares
the source Job's chat/run/task together before committing. Dispatch happens only
after commit and scope revalidation. An admitted preparation/launch failure is
consumed or interrupted under the same recovery policy as an agent occurrence;
a subsequent focus event does not execute it again.

Ordinary Jobs need a main-owned scheduled launch path because their manual
`renderer_turn` result normally relies on the open renderer to send the first
message. Scheduled launch resolves the existing routing/defaults, creates an
ordinary task attempt, and dispatches once from main. Explicit coordinator and
script definitions reuse their existing preparation/execution seams. This does
not alter the manual Run button's dispatch contract.

Overlap includes every unfinished run of the source Job, whether created manually
or by any of its schedules, plus active ordinary turns and held runtime cleanup reservations. Waiting or
interrupted tasks remain unfinished. A second schedule cannot evade overlap by
having a different binding ID. One blocked due interval produces one skip and
advances its cursor; completion never releases a backlog.

Startup reconciliation marks an orphaned ordinary desktop attempt interrupted
when its receipt was committed before launch and no live local turn remains.
Only attempts owned by this desktop qualify; a handoff or another desktop's
ownership must not be interrupted by local recovery. Disabled and deleted rules
still reconcile their unfinished receipts.

Regression coverage should prove source Job/run/task identity, renderer-closed
execution, ordinary/direct/model/coordinator/script routing, dependency review
changes, stale save/profile rejection, manual and cross-schedule overlap,
interrupted recovery, single catch-up, disabled/deleted source behavior, local-only
sync state, and unchanged agent schedule admission. Built-app coverage saves a
Job schedule through the detail page and follows the resulting ordinary task.
