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
- `src/main/ipc/localSchedule.ipc.ts`, `src/preload/index.ts`, `src/renderer/src/components/agents/local/SchedulesTab.tsx`, and `src/renderer/src/components/jobs/JobSchedules.tsx`: scoped editor, enablement, history, and Stop surfaces.

## Timing authority and editor

Built-in `ScheduleTemplate` records have stable IDs, versions, labels, and structured weekday/hour rules. `workday-morning` is `0 8 * * 1-5`; `workday-hourly` is `0 9-18 * * 1-5`, including 18:00. Custom and Advanced are form modes, not templates. Shared/main logic validates unique sorted numeric day/hour sets and compiles Custom as minute zero across all selected combinations.

The effective cron and explicit canonical IANA timezone determine execution. Optional editor metadata stays device-local; template updates cannot change saved definitions. Metadata that disagrees with an externally changed cron is discarded. Existing definitions without metadata remain valid, and rules that cannot be represented by the checkbox editor reopen in Advanced. Switching away from advanced text must make replacement explicit and retain the unsaved advanced value within the form.

The form shows the execution definition, timezone, timing summary, next occurrence, and single-catch-up behavior. Saving an enabled definition serves as review; imported and external changes use the separate review flow. Execution type is immutable after creation.

## Manifest edits and review

All mutations capture the active profile/settings scope in main and validate the caller's profile and stale-write/review tokens. The renderer does not authorize execution or write files. Folder edits use the existing per-agent editor lock, expected file stamp, validation, atomic replacement, and preservation of unrelated/unknown fields.

Filesystem and SQLite changes cannot be one transaction. Save the stamped manifest first, reread and validate the resulting definition, then update local consent. A failed binding update leaves the definition saved but requiring review; the old reviewed revision cannot admit new work. A stale editor must not overwrite external edits. An in-app rename moves the existing binding, receipts, and historical Job overlap set. An external rename is a removed declaration plus a new unreviewed declaration.

`localScheduleService.save`/`delete` compare the caller's `revision` against the row's current one, including `null`. A row with a `problem` has a null revision, so the editor can still save or delete it. Rejecting those rows would leave the problem unfixable in the one place built to fix it. `enable` still refuses any row that has a problem or no revision.

The manifest's `enabled` field is the author's portable intent; device opt-in lives only in the binding. `save` builds the entry from the original, keeping any existing `enabled` value exactly, and never adds one. It validates the form with `enabled` masked, so an author-disabled entry stays editable. After the write, a disabled save masks `enabled` again and updates the binding without a warning. An enabled save re-reads the entry unmasked, so `definitionFor` refuses it with "This schedule is disabled in the manifest". The caller gets the usual "Saved; enablement needs review" warning.

A generated Job belongs to one reviewed revision. `save` and `enable` reuse `binding.jobId` only when `prior.revision` equals the revision being saved or reviewed, and the Job's fingerprint still matches. Otherwise an enabling prompt schedule creates a fresh Job. A disabled save carries no Job forward (`jobId: ''`), so a later `enable` generates one for the definition it reviews. `jobIds` keeps every earlier Job for history and overlap.

Fresh validation checks kit identity, effective agent enablement, runnable readiness, unique schedule name, execution type, literal prompt or command, cron, timezone, and resolved catalog entry. Readiness `credentials_needed` warns as it does for ordinary work; `invalid` and `contract_too_new` refuse. A `/run:<name>` revision includes the resolved/localized command, so catalog edits invalidate consent. Script file contents are not whole-folder hashed.

## Durable state and migration

Bindings retain profile, manifest identity, schedule name, reviewed definition/revision, local enablement, generated Job fingerprint and historical Job IDs, monotonic clock protection, a next-due UTC instant, and editor metadata. Scripts need no Job until an agent follow-up is required.

Receipts retain the captured definition/revision, original due civil key and UTC instant, observation/coverage time, scheduled versus catch-up trigger, actual start/finish times, lifecycle status, structured command outcome, and any task/run/chat links. Lifecycle and result are distinct: storing a command result or linking a follow-up task is not equivalent to completing that task. Receipt references survive deletion of task/run/chat evidence. Bindings and receipts cascade with their profile and never enter sync.

The idempotent migration preserves old reviewed prompt definitions, history, generated Jobs, historical overlap, and enablement. Old bindings receive a next-due baseline strictly after migration time, preventing retroactive catch-up for downtime the old scheduler deliberately skipped. It never enables disabled or previously unsupported declarations.

Polls use enabled/profile/due indexes and bounded unfinished-work predicates. Ordinary lists fetch latest receipts; history is paginated. Terminal history must not be deserialized on each tick.

## Admission and catch-up

One scheduler handles startup/profile activation, aligned minute ticks, focus, and resume. Scope/generation invalidation remains authoritative after asynchronous boundaries. Stopping or switching profiles cancels/interrupts tracked execution and stops new admission; it does not disable consent or reset the due cursor.

1. Capture scope, generation, and observation time; validate the live definition and binding revision. Unreadable/transiently unavailable folders retain their pending due time; confirmed changed or removed definitions suspend admission for review.
2. Reconcile unfinished receipts from durable task/run evidence and active reservations. Unknown or interrupted work requires explicit recovery and counts for overlap.
3. If the stored next-due instant is after the observation, do nothing. Otherwise consider one occurrence for that stored instant, covering eligible times through the observation.
4. In one SQLite transaction, compare-and-claim the binding cursor/revision, insert the receipt, prepare a prompt Job attempt if needed, and advance next due strictly beyond the observation. Overlap inserts one skipped receipt and consumes the same covered period. Never iterate from old due times to enqueue a historical replay.
5. Commit before launching a process or agent. Recheck scope and persist dispatch intent before the side effect. Actual execution times remain separate from intended due time. The claim's validity check requires both a current scope and the same observed wall-clock minute (`valid()`). The pre-launch gate in `localScheduleService` and `jobScheduleService` checks only `current()`, meaning the profile and scheduler generation. An admitted run that crosses a minute boundary during preparation still launches. Requiring the same minute there would turn a slow but committed occurrence into an interrupted task that needs review.
6. For script results requiring an agent, persist the command result before preparing the task, then atomically link the prepared task before its launch. Never rerun the command because follow-up preparation or launch failed.

Preparation failure rolls back partial task writes. A separate transaction records the failed observation and advances its cursor together; if this cannot commit, launch nothing. Lost processes after committed admission become interrupted work rather than unclaimed due events. This is durable deduplication, not exactly-once external execution.

Every admitted failure consumes the occurrence. Re-enable or a reviewed execution-definition change establishes a future-only baseline. Disabled intervals are not due. Later due times during unfinished work are skipped rather than queued; completion never drains a backlog. Distinct overdue schedules each get at most one catch-up.

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

Focused coverage belongs in cron/timing, schedule service/scheduler, command, migration, and script-runtime tests. Use injected clocks and lifecycle triggers for deterministic multi-day catch-up, enablement baselines, exact-minute/weekend recovery, concurrency, crash stages, overlap, profile changes, catalog edits, output truncation, and DST cases. Renderer coverage verifies the two rows of twelve hour controls and advanced-rule round-trip. The built-app schedule flow exercises editor save, quiet script history without a chat, and non-OK follow-up through ordinary task navigation.

Kit schema descriptions are generated from Core's kit source through `make kit-sync`; do not hand-edit the bundle or its tree hash. The existing bundled schema already accepts both schedule types and all fields used by the editor, so this desktop feature requires no schema or contract-version change. The scheduling guidance in the bundle comes from Core's kit source (Core commit `b06af0da`), re-bundled with `make kit-sync` and pinned in `scripts/kit-sync/contract.lock.json`. Contract bundle/conformance tests verify compatibility. Test inventory is not a claim that every validation pass has run; record actual commands and results with the change.

## Scheduling existing local Jobs

A Job schedule references a live, profile-owned `type: local` Job and creates
attempts under that source Job ID. It must not create a generated replacement Job
or inject a turn into an existing chat. `cinna_task` Jobs are outside local
scheduling. Agent and Job bindings have distinct ownership identities in the
shared local schedule tables; agent listing/admission must never treat a Job
binding as a manifest declaration.

The reviewed Job revision includes its execution fields and dependency
attachments, not only a Job timestamp: prompt, mode, router/script/budget,
attached agent IDs, attached MCP IDs, and portable dependency evidence all affect
what can execute. Normalize attachment ordering for fingerprints. Re-read and
compare that revision in main at save/enable, admission, and any asynchronous
preparation boundary. A changed/deleted source Job cannot execute under stale
consent. Unavailable dependencies must preserve ordinary execution refusal
rather than silently falling back to a different participant.

Job schedule CRUD uses validated profile, source Job, and binding/review revision
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
