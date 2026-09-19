# Job Execution and Refresh — Technical Details

The [Jobs](jobs.md) definition is reusable; a Job Run is one attempt, and its Task is the durable work. Stored local/remote provenance owns configuration and historical conversation links. It does not decide how a task is refreshed after a handoff.

## File Locations

| Layer | Files and responsibility |
|---|---|
| Pure policy | `src/main/tasks/jobDefinitionPolicy.ts`, `src/main/tasks/jobRuntimeDefinition.ts`: supported stored definition and autonomous grammar |
| Main execution | `src/main/services/jobExecution/contract.ts`, `index.ts`, `desktop.ts`, `remote.ts`: actual preparation and dispatch owners |
| Dependencies | `src/main/services/jobExecution/dependencies.ts`: portable dependency ownership shared by admission and Job indicators |
| Facade | `src/main/services/jobService.ts`: scoped CRUD, endpoint capability checks, current-task refresh and legacy adoption |
| Storage | `src/main/db/jobs.ts`, `src/main/db/jobRunRefresh.ts`: history queries and pure refresh projection |
| Task lifecycle | `src/main/services/taskService.ts`, `src/main/services/taskSyncService.ts`, `src/main/services/taskSyncScheduler.ts`: current-attempt projection, confirmed loss and shared remote reads |
| Wire | `src/shared/jobs.ts`, `src/main/ipc/job.ipc.ts`, `src/preload/index.ts`: result disposition and run refresh metadata |
| Renderer | `src/renderer/src/hooks/useJobs.ts`, `useCinnaRunPoll.ts`, `src/renderer/src/components/jobs/JobRunRow.tsx`: one dispatch, saved-row polling and the history row, which has no refresh control |

## Database Schema

The existing Job, Job Run, Task and handoff-receipt tables are unchanged by executor selection. See [Jobs storage](jobs_tech.md#database-schema) and [Tasks storage](../tasks/tasks_tech.md#database-schema).

`job_runs.type`, `local_chat_id` and legacy remote pointers retain original provenance. A task can later execute remotely while its attempt remains local-origin. `task_id` and `tasks.job_run_id` identify the current association; a historical link alone does not authorize rewriting an attempt.

`JobRunData.refreshMode` is required, derived DTO metadata, never a stored or synced column. `listByJob` joins profile-owned task fields and receipts without network calls or per-row service requests. The nested task projection starts with nonnullable executor: otherwise Drizzle can mistake a live task with null deletedAt for a missing joined row. Single-run enrichment calls the same pure projection.

## IPC Channels

- `job:execute(jobId)` captures profile and settings scope and returns `JobExecuteResult` after the selected executor's preparation or admission. `disposition: renderer_turn` carries the initial chat/prompt/agent/mode payload. `disposition: accepted` carries admitted task/run identity and an optional navigation chat. Stored type and the local compatibility execution field remain data; disposition owns the renderer action.
- `job:refresh-run(runId, { force? })` returns the current `JobRunData`. Force permits reading terminal history; it never bypasses task ownership, handoff review or historical-outcome guards.
- `job:list-runs` and `job:get` expose the same refresh metadata. No additional executor-specific IPC endpoint is introduced.

All handlers require activation and derive scope in main. `executeLocal` remains a synchronous internal compatibility method; `executeCinnaTask` remains asynchronous. Each requires the selected executor's corresponding optional capability before any write or network call.

## Services and Key Methods

`jobDefinitionPolicy` accepts supported local/remote stored types and refuses unknown values. `executorFor` composes this pure policy with actual implementation objects. Runtime-field validation can import the policy without importing services; it validates locally authored definitions while sync and unrelated edits preserve future values.

### Desktop preparation

`desktopJobExecutor.prepareRendererTurn` preserves ordinary null-router behavior: validate portable dependencies and attached agents, resolve the captured settings-scoped mode/MCPs, and derive chat routing. Chat, attachments, run, task, task association and initial task status are written in one transaction. A failure while creating the task cannot leave a hidden chat or running attempt behind. No stream starts inside this transaction.

`desktopJobExecutor.execute` sends explicit coordinator/script definitions through the existing main-owned admission services. Coordinator admission rechecks its Job/dependency/model snapshot after asynchronous preparation; script admission rechecks its current definition and resolved targets. Their prepare/launch seams commit before execution is queued. Ordinary jobs retain renderer model/default resolution; this contract does not silently migrate them to autonomous execution.

### Remote admission

`remoteJobExecutor.executeRemote` validates the required assignee and supported definition before availability. `taskSyncService.captureConnection` captures the synchronization generation; after availability, the executor rereads the scoped nondeleted Job and compares type, title, prompt, assignee, priority and runtime fields. A changed connection or definition refuses before creating work.

The executor creates a local Task, then calls the same `taskSyncService.handOff` as the Task page. Handoff owns its task/claim/live-run checks, writer queue, adapter dispatch and durable uncertainty receipt. An ordinary refusal cleans up the new task while preserving the original error. Accepted or uncertain work is retained: it may already be running remotely.

After acceptance, Job-run creation and task linkage share a transaction. If this local transaction fails, return `handed_over`, retain the task and receipt, and direct the user to Tasks without re-executing. Local rollback cannot retract remote acceptance. See [handoff recovery](../tasks/remote_handoff.md).

## Refresh Modes and Ownership

| Mode | Meaning and action |
|---|---|
| `bound_task` | A nondeleted task currently executes remotely and has a binding. Manual refresh uses that binding regardless of run origin. |
| `legacy_adoption` | A remote-origin run has its old remote pointer but no task. Associate it on eligible refresh; terminal history requires force. |
| `handoff_review` | An unresolved creating/executing/accepted-pending/uncertain receipt requires Task-page recovery. Ordinary refresh does not replay handoff. |
| `none` | No current bound/adoption read is available. Return saved history without inventing a remote target. |

`refreshRun` checks the current mode and unforced terminal state before work. It rereads the scoped run after waits and discards consequences from an invalidated connection. A local takeover or changed binding cannot be interpreted as lost remote work. Successful snapshots use `taskService.persistRemotePatch` and its current-attempt projection; refresh does not repeat that status write, which would erase error details or finish timestamps.

`adoptRemoteRun` rereads the run after adapter availability. Deletion, changed Job/pointer, generation change or an unforced terminal transition prevents creating a task. Concurrent adopters join an already-associated run. If discovery already created the same remote task, adoption joins that replica and does not overwrite existing Job-run provenance. Otherwise task creation, binding and association are transactional.

### Confirmed remote loss

Only a typed network `not_ours` opts into `unbindRemote(..., { confirmedMissing: true })`. The binding clear and failure of the exact matching active remote Job attempt commit together. Required guards are scoped run ownership, current task association, direct nullable chat equality, pending/running status and no unresolved receipt. Terminal outcomes remain unchanged. The Task keeps its last-known status and executor: missing remote work is not local execution.

Relink/reset uses the default false option, preserving the last-known Task and run state without claiming remote deletion. Reconciliation confirms absent nonterminal remote-origin replicas and local-origin remote-executor tasks under existing generation/revision checks. It unbinds confirmed loss and deletes only replicas, preserving locally authored work. This shared lifecycle is necessary because a Task-page read can discover loss before a Job refresh; otherwise the binding disappears while the Job remains running forever.

## Renderer Components

`useExecuteJob` handles disposition rather than provenance. Accepted work invalidates Job/task/chat queries and optionally opens its chat; it never calls startRun. Ordinary renderer-turn preparation sends once after existing configuration resolution. Missing/unknown dispositions refuse before navigation or dispatch. `navigate: false` remains supported.

`JobRunRow` offers no Refresh: no renderer surface calls `job:refresh-run` with `force`, so terminal history is never re-read from the job page. A row with a live task opens the task; an orphaned row opens its chat or the service run view by provenance, and its Delete run disclosure follows provenance too (a local run's chat goes with it, a cinna run's service task does not). The profile task scheduler owns normal network refresh. Job list/history queries poll SQLite while active attempts remain. `useCinnaRunPoll` only performs legacy adoption every five seconds while visible and stops once association succeeds; bound work does not gain a second per-view timer.

## Configuration and Security

No new setting or credential is introduced. Captured settings/profile scope governs desktop dependencies; remote adapter and credential handling remain behind the existing task handoff transport. Revalidation protects local writes after awaits but cannot retract an already-issued remote request.

The kind-branch ratchet has zero counted behavioral debt. Job cleanup replaces eight behavioral consumers, classifies 22 existing schema/provenance comparisons, and explicitly pins two definition-policy comparisons plus one legacy-adoption comparison. Those physical comparisons remain visible and exact-counted as ownership; zero does not mean every branch was removed.

## Regression Coverage

- `src/main/services/jobService.executeLocal.test.ts`: failed task preparation leaves no chat/run/task.
- `src/main/services/jobService.executeCinnaTask.test.ts`: changed/deleted preflight, deleted/repointed/terminal adoption, real SQL-trigger failure after remote acceptance, current-binding DTOs, takeover safety, background/scheduler loss, terminal history, unresolved-receipt refusal before remote calls, relink preserving last-known run state, and preserved remote errors/timestamps.
- `src/renderer/src/hooks/useJobs.executeError.test.tsx`: exactly one ordinary send; accepted and unknown dispositions never send.
- `src/renderer/src/hooks/useCinnaRunPoll.test.tsx`: visible legacy adoption stops after association and skips bound/recovery/passive/terminal history.
- `e2e/specs/job-executor-refresh.spec.ts`: a local-origin Job handed remote moves its history row from running to succeeded through the bound Task's own refresh, and a forced `refreshRun` over the API still reads the service.
- `src/main/agents/kindBranches.test.ts`: exact ownership inventory and zero behavioral ceiling.
