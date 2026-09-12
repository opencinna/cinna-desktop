# Local Schedules: Technical Details

## File Locations

- Contracts: `src/shared/localSchedules.ts`, `src/shared/kit/manifest.ts`, `resources/cinna-kit-contract/schema/cinna-agent.schema.json`.
- Main: `src/main/services/localScheduleService.ts`, `src/main/services/localScheduleScheduler.ts`, `src/main/tasks/scheduleCron.ts`.
- Storage: `src/main/db/localSchedules.ts`, `src/main/db/schema.ts`, `src/main/db/migrations/local-schedules.ts`, registered in `src/main/db/migrations/index.ts`.
- Lifecycle: `src/main/auth/activation.ts`, `src/main/auth/reload.ts`, `src/main/index.ts`; execution: `src/main/services/scriptRuntimeService.ts`, `src/main/services/jobService.ts`, `src/main/services/taskRunnerBridge.ts`.
- IPC/preload: `src/main/ipc/localSchedule.ipc.ts`, `src/main/ipc/index.ts`, `src/preload/index.ts`.
- Renderer: `src/renderer/src/components/agents/local/SchedulesTab.tsx`, `src/renderer/src/components/agents/local/LocalAgentPage.tsx`.

## Database Schema

local_schedule_bindings stores user, manifest ID, name, normalized definition/revision, current Job ID/fingerprint, all historical Job IDs, enabled/reason and monotonic UTC-minute watermark. Its user/manifest/name identity is unique. local_schedule_occurrences stores binding/user, civil key, UTC minute, frozen definition/revision, status, task/run/chat references and reason. Binding/civil key is unique. Both user references cascade; occurrence binding deletion cascades too. Task/run/chat references deliberately survive as receipt evidence rather than cascading away with the referenced work.

Statuses are prepared, dispatched, completed, failed, cancelled, interrupted and skipped_overlap. These tables are device-local and absent from app-sync collections; generated Jobs use ordinary definition sync. The idempotent migration adds user, binding/minute and binding/status indexes.

Ordinary list reads latest with `LIMIT 1`. Overlap queries only unfinished receipt statuses, then a joined Job-run/task predicate with `LIMIT 1` plus current runtime reservations. Historical terminal receipts are not deserialized on every tick; full history reads previously made polling cost grow with every completed run.

## IPC Channels

- local-schedule:list(agentId) → LocalScheduleItem[].
- local-schedule:enable(LocalScheduleReview) → refreshed LocalScheduleItem[]. The review carries profileUserId, agentId, name, revision and timezone.
- local-schedule:disable(bindingId) → void.

Each ipcHandle handler requires activation and captures profileUserId/settingsUserId in main. Preload exposes window.api.localSchedules.list/enable/disable. The revision is a comparison token, never execution authority.

## Services & Key Methods

- localScheduleService.list/rowsFor reads the fresh folder and reconciles binding availability/latest result without creating consent. definitionFor verifies kit identity, profile enable override, readiness, static_prompt, name/prompt bounds and cron/timezone. revisionOf hashes normalized definition; jobFingerprint binds the generated Job's owner/type/title/prompt/router/script/budget. Both fresh reads in enable must be valid; the final read requires exactly one matching name before comparison and writes.
- enable creates or reuses the matching one-step script Job and binding transactionally. The step uses the folder manifest ID and the literal goal template. Prior Job IDs remain in the overlap set. The watermark is at least the current minute; rereview cannot reset civil deduplication.
- check captures the observed minute and checks scheduler generation plus that same current minute before admission. Matching occurrence claim, scriptRuntimeService.prepareJob writes and linked prepared receipt share an outer transaction. Failure rolls back all prepared rows and records a separate failed receipt/watermark. After commit it records dispatch intent, then calls launch; launch failure calls interruptPrepared and records interruption.
- scriptRuntimeService.prepareJob returns task/run/chat IDs and an attempt-bound launch callback. It performs no driver dispatch or reservation before commit. launch rejects an open transaction, changed attempt/bindings or duplicate active execution. startJob remains the manual prepare-then-launch wrapper.
- reconcileOccurrence projects terminal run/task evidence only after held cleanup reservations finish. Interrupted or unknown prior work remains overlap-blocking; the service does not infer successful execution from missing evidence. jobService.deleteRun notifies taskRunnerBridge.chatRemoved only for an actually deleted owned chat, matching chatService lifecycle.
- createLocalScheduleScheduler owns one aligned minute timeout and coalesces activation/focus/wake requests. It drains a trailing refresh even when it arrives between cycle completion and promise cleanup. Generation/scope/suspend guards survive the lazy service import. Stop invalidates pending checks; resume evaluates only the current minute.
- UserActivation serializes provider teardown/reload using an operation chain and invalidates older work with an epoch. reloadUserProviders checks currency after asynchronous disconnect before registration. Only the winning activation opens the IPC gate and starts schedulers. Suspend/quit stops admissions before runtime interruption; admitted work retains its captured profile/settings scope.
- scheduleCron parses at most 512 characters into bounded fields. A field starting with wildcard syntax retains wildcard DOM/DOW semantics; a full explicit range is restricted syntax. A lone numeric start with a step extends to the field maximum. scheduleMinute uses Intl in the frozen zone and forms a zone/date/hour/minute civil key without offset, intentionally deduplicating repeated daylight-saving minutes.

## Renderer Components

LocalAgentPage includes Schedules for kit agents and retains a valid fallback when switching to bare agents. SchedulesContent is keyed by profile plus agent, polls every five seconds and renders declaration availability, local enablement, latest receipt and Open task. The dialog holds the reviewed item during background refresh. Pending refs suppress repeated submit and dismissal; errors preserve review and use reserved slots. Successful enable invalidates schedule and Job queries. Main rejects an old-profile review even if the renderer switches before delivery. On the opened TaskView, Back to Job stays within the header width: the arrow keeps its size, the label ellipsizes and a tooltip retains the full name. The task heading wraps even an unbroken title, retaining its full text beside the fixed-size status pill. Long generated schedule titles previously overflowed both navigation and heading.

## Configuration

No device scheduler setting or OS job is installed. Consent is a local binding. Cron is minute/hour/day-of-month/month/weekday with numeric lists/ranges/steps; timezone uses Intl validation/canonicalization and falls back to the reviewed OS zone when omitted. Generated Jobs use twenty turns/sixty minutes and existing script queue/budget rules, including saved-question pauses and counted live approvals. Unsupported token budgets are not invented.

## Security

The kit-kind guard establishes ownership of manifest declarations; it does not select a transport. The kind-branch ratchet pins exactly this ownership guard with a count of 1 and unchanged overall limits. Actual participant execution still uses script/driver contracts. Scope checks, fresh folder validation, definition revision, generated-Job fingerprint and local ownership remain main-process responsibilities. Sync cannot transfer local opt-in or runnable checkpoints.

## Validation Boundaries

Source coverage lives in `src/main/tasks/scheduleCron.test.ts`, `src/main/services/localScheduleService.test.ts`, `src/main/services/localScheduleScheduler.test.ts`, `src/main/auth/activation.test.ts`, `src/main/auth/reload.test.ts`, `src/main/db/migrations/migrations.test.ts` and `src/main/services/scriptRuntimeService.test.ts`. `e2e/specs/local-schedules.spec.ts` exercises built opt-in, due execution, saved questions/overlap, definition review and disable/restart with real minute boundaries. Test presence is not a claim that the current built-app pass has completed.
