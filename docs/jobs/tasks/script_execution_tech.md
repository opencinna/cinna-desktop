# Script Execution: Technical Details

## File Locations

- Engine: `src/main/services/scriptRuntimeService.ts`; checkpoint types: `src/main/tasks/scriptRuntimeTypes.ts`; repository: `src/main/db/scriptRuntimes.ts`.
- Definitions and resolution: `src/shared/taskScript.ts`, `src/main/tasks/scriptRouter.ts`, `src/main/tasks/jobRuntimeDefinition.ts`, `src/main/sync/scriptAgents.ts`.
- Shared admission: `src/main/tasks/runtimeAdmission.ts`, `src/main/tasks/executionQueue.ts`, `src/main/tasks/runtimeBudget.ts`.
- Lifecycle: `src/main/services/taskRuntimeService.ts`, `src/main/services/taskRunnerState.ts`, `src/main/services/taskRunnerBridge.ts`, `src/main/index.ts`.
- Job dispatch: `src/main/services/jobService.ts`, `src/main/services/coordinatorJobService.ts`, `src/shared/jobs.ts`, `src/main/ipc/job.ipc.ts`.
- Task controls: `src/shared/taskRuntime.ts`, `src/main/ipc/task.ipc.ts`, `src/preload/index.ts`, `src/renderer/src/components/tasks/TaskRuntimeControl.tsx`, `src/renderer/src/hooks/useJobs.ts`, `src/renderer/src/components/jobs/JobDetail.tsx`, `src/renderer/src/components/chat/RouterBadge.tsx`.

## Database Schema

`task_script_runtimes` in `src/main/db/schema.ts`, created by `src/main/db/migrations/tasks.ts`, has a task primary key with deletion cascade, profile user ID and JSON checkpoint. It is device-local and is not a sync collection. Definitions and task claims still use the existing job/task sync paths.

ScriptRuntimeCheckpoint records the attempt/job-run identity, root conversation, captured settings scope, goal, definition, resolved targets, budget, ownerTurns, elapsedMs, activeStartedAt and step map. Steps retain their task/chat IDs, state, compact output, continuation prompt/origin, lastRunId and pendingRequestIds. Root states are queued, running, waiting, interrupted and completed; terminal task status distinguishes success, failure and cancellation. Step states additionally distinguish pending, failed and canceled.

TaskAssigneeKind includes script and human as explicit task metadata: roots use script, question steps use human and agent steps use agent. These values do not add a driver or make a human gate a model call.

Each declared step gets a separate hidden direct chat and child task. The root gets a hidden Job chat, root task and originating attempt. Creation, initial goal and checkpoint commit in one transaction before enqueue. Full messages remain in the step chat; compact completion transitions and the final assistant summary are saved in the root chat.

## IPC Channels

`job:execute` captures profile/settings scope and returns shared JobExecuteResult. Explicit local coordinator/script jobs return disposition=accepted with local provenance and chatId/runId/taskId after admission. The renderer does not send a first prompt for this arm. Ordinary null-router jobs return renderer_turn; accepted remote Jobs never request a renderer send. The [Job executor contract](../jobs/execution_tech.md) owns this disposition independently of provenance.

Existing `task:resume-runtime` and `task:stop-runtime` use taskRuntimeService to find the owning engine. A script child's ID resolves to its root. Existing task reads project TaskRuntimeInfo with controllerTaskId; checkpoint prompts and resolved target details are not exposed. Existing Inbox/transcript answers reach the engine through taskRunnerBridge before live-driver delivery.

## Services and Key Methods

- `scriptRuntimeService.prepareJob` returns an attempt-bound post-commit launch callback so [schedule receipts](local_schedules_tech.md) can join the creation transaction; `startJob` calls prepare then launch. Preparation validates the job, script, goal and supported budget, resolves every declared target, rechecks the current definition, then commits the attempt before enqueue. `resolveScriptTargets` is lookup-only; `assertScriptTargets` prevents later participant substitution. Remote descriptors also match the current normalized server identity.
- `drive` starts timing before task-slot acquisition, claims eligible steps as queued in the checkpoint and runs independent ready steps concurrently. `withRuntimeAgent` supplies shared global/per-agent admission and waits for the local turn lock. Coordinator and script engines use the same queues; ordinary turns retain their existing admission rules.
- `runStep` expands only validated dependency templates and invokes runExecutionService with the child runnerTaskId. It awaits RunHandle.completed. Runner completion ownership suppresses ordinary per-turn task/job completion. A failed, cancelled, budget-limited or bookkeeping-uncertain outcome cannot release dependencies as successful output.
- Human gate addresses include attempt and step identity, with deliveryOwner=runner, rootRunId=attemptId and invocationId=stepId. Gate creation and waiting checkpoint are transactional. `answer` checks current bindings, open request membership, waiting state, completed turn cleanup and cancellation before settling the answer and continuation together. Human answers complete their step; agent answers queue another turn in the existing child conversation. Pending sibling addresses survive later turns.
- `assertBindings` validates the root remains parentless with its saved chat/goal/router/definition, and all saved child parent/chat/ownership bindings before recovery, Resume, answer and dispatch. `assertCurrent` also checks cancellation and live execution identity. Unsupported future definitions are preserved by sync but refused for execution.
- `recover` restores waiting reservations and interrupts queued/running attempts without replay. `resume` preserves completed steps and saved gates, expires dead driver reply addresses and queues a review instruction for previously dispatched work. Undispatched steps return to pending. The saved elapsed interval is retained; interrupted running recovery conservatively includes downtime.
- `finish` can use the retained in-memory checkpoint after root deletion cascades the stored row. Child status changes require the original parent/chat and local claim. Request cleanup additionally requires the saved chat plus recorded pending ID, a matching non-null lastRunId, or the runner attempt identity. A null run ID never authorizes broad cleanup. Completion settles only the matching active originating Job attempt.
- `taskRunnerBridge` dispatches task/sync/chat/account lifecycle notifications to both engines. Script reservations carry controllerTaskId so one engine's missing-checkpoint cleanup cannot release the other's chats. Root terminal state/deletion closes owned children and gates; cancellation holds reservations until active handles settle. Completed-child metadata edits do not cancel the graph. Interruption marks still-owned unfinished children blocked and rebuilds reservations using actual parent/chat/device ownership, retaining valid chats while releasing moved children.
- `startCoordinatorJob` resolves a captured explicit/effective-default model configuration and required agents/MCPs in main, then rechecks the job/dependency snapshot after asynchronous model preparation. Its outer transaction creates the chat/run/task and calls taskRunnerService.prepare; the returned launch callback runs only after commit. Existing-chat autonomous start uses the same prepare/launch seam.

## Renderer Components

useExecuteJob invalidates saved Job/task/chat queries and optionally navigates for disposition=accepted, then returns without calling startRun. The existing Job form has no script or autonomous-definition authoring controls. Programmatically stored explicit definitions use the existing Run action. JobDetail respects the explicit coordinator/script router before ordinary attachment inference; the display-only Script routes badge explains graph routing without extending the chat-router execution union.

TaskRuntimeControl uses controllerTaskId for whole-script Stop/Resume and states that scope on child pages. It retains fixed action columns and the existing error handling. Live child turns use selected-chat attachment; root transition/summary messages are read through saved-chat polling while the working reservation is active. No durable token replay cache or graph editor is introduced.

## Sidebar Result Projection

`src/main/services/scriptRuntimeService.ts` writes through `src/main/db/chatRunResults.ts` in its controller transactions: root finish/wait/interruption, agent-step completion/wait, human-gate creation/answer and relevant child termination. Leaf turns pass runnerTaskId and do not publish sidebar results. A root outcome therefore exists even when its graph has only human gates. Each new transition uses a fresh identity; duplicate interruption cleanup retains the old one.

Termination reflects already-terminal child statuses changed through task controls while preserving already completed checkpoint siblings. Actual chat/parent/device bindings gate child writes; missing chats are skipped, so permanent deletion cannot strand task/gate cleanup through a result-table foreign-key failure. See [result schema, read acknowledgement and tests](../../chat/session_status/session_status_tech.md).

## Configuration

Defaults are twenty agent turns and sixty minutes; structural ranges and template bounds remain in [the definition contract](script_definitions_tech.md). Script ownerTurns counts each agent dispatch atomically across parallel siblings; human gates consume no turn. Time counts task/agent queues and live approvals, pausing only when remaining work is held by settled saved questions. Explicit maxTokens refuses before dispatch because complete usage reporting is unavailable.

The device-wide taskRunnerConcurrency setting (default two, integer one through eight) applies to separate task and agent queues shared by both engines. Per-agent admission is one at a time, with abortable waiting and the driver's atomic local lock at execution.

## Security

Captured profile/settings scope, device claim, saved graph and actual task/chat bindings are authoritative after waits. Aliases cannot install agents, bypass profile overrides or silently match another server. Reserved chats exclude unrelated sends, remote handoff and model/router changes. Lost ownership interrupts local work; removal cleanup cannot mutate a reparented child or unrelated request. Local checkpoints are not transferred as executable state through sync.

## Validation and Boundaries

`src/main/services/scriptRuntimeService.test.ts` covers graph execution, gates, ownership changes, stop/cleanup and recovery using real database state. Definition/persistence tests remain in `src/main/tasks/scriptRouter.test.ts` and `src/main/tasks/scriptDefinitionPersistence.test.ts`. Test presence documents coverage intent, not a claim that a particular full-suite or built-app validation run has passed.

[Local schedules](local_schedules.md) supply reviewed timed script admission. Complete token accounting and phase 7 protocol/new-driver cleanup remain separate work.
