# Handover Bus — Technical Details

Behavior and limits: [Handover Bus](handover_bus.md). File parsing and reconciliation remain in [File Handovers](file_handovers_tech.md).

## File Locations

| Layer | Files and responsibility |
|---|---|
| Shared | `src/shared/delegations.ts` — origins, targets, channels, state/result/DTO and durable reply vocabulary; `src/shared/handovers.ts` — file contract, depth cap and packet builders |
| Database | `src/main/db/schema.ts`, `src/main/db/migrations/delegations.ts`, `src/main/db/delegations.ts` — canonical journal, migration/backfill and scoped repository |
| Main admission | `src/main/services/delegationService.ts`, `src/main/services/delegationToolProvider.ts`, `src/main/services/delegationFiles.ts` — validation, gate, tools and exclusive file publication |
| Main lifecycle | `src/main/services/delegationLifecycle.ts`, `src/main/services/delegationReplies.ts`, `src/main/services/handoverWake.ts`, `src/main/services/handoverChatQueue.ts` — results, durable replies and idle-chat return delivery |
| Channels | `src/main/services/handoverService.ts`, `src/main/services/delegationCloud.ts`, `src/main/services/taskExecutionService.ts` — file reconcile, remote journal/adapter dispatch and local task starts |
| Adapter seam | `src/main/tasks/adapters/adapter.ts`, `src/main/tasks/adapters/cinnaTaskAdapter.ts` — delegation metadata, result audience/ask identity, negotiated server support and paged comment fallback |
| Integration | `src/main/services/conductorBridge.ts`, `src/main/services/runExecutionService.ts`, `src/main/services/threadContextService.ts`, `src/main/services/handoverScheduler.ts`, `src/main/services/inboxService.ts` — session tools, header, reconciliation triggers and report-owned completion |
| Permission storage | `src/main/services/localAgents/desktopStateService.ts`, `src/main/services/localAgents/localAgentService.ts` — device-local grants, literal-value coercion and setters |
| IPC/preload | `src/main/ipc/task.ipc.ts`, `src/main/ipc/local_agent.ipc.ts`, `src/main/services/delegationQueryService.ts`, `src/preload/index.ts` — scoped task links and permission mutations |
| Renderer | `src/renderer/src/hooks/useDelegations.ts`, `src/renderer/src/hooks/useLocalAgents.ts`, `src/renderer/src/utils/delegationText.ts`, `src/renderer/src/components/tasks/TaskView.tsx`, `src/renderer/src/components/agents/local/PermissionsCard.tsx` |

Focused tests sit beside these services/repositories/components. `e2e/specs/delegation-local.spec.ts`, `delegation-bare.spec.ts`, `delegation-cloud.spec.ts` and `delegation-settings.spec.ts` exercise the built-app paths; the existing file flow remains in `e2e/specs/handover-flow.spec.ts`.

## Database Schema

`delegations` is device-local and profile-owned; it does not sync. `migrateDelegations` runs after tasks and handovers. Existing handovers are backfilled one-to-one, retaining their UUID as the delegation UUID; root traversal is limited to newly backfilled rows so startup cannot rewrite a new chain's immutable root. A backfilled handover already in `done`, `failed`, `skipped` or `refused` with no `woke_at` is stamped delivered: `woke_at` takes its `updated_at` and `wake_digest` its report digest. It carries a result digest and no acknowledgement, which is exactly what `sweepLostRuns` retries, so unstamped it opened a turn in its origin chat on the first tick after the upgrade.

| Field group | Stored facts |
|---|---|
| Identity | `id`, `user_id`, `requester_key`, `origin_key`, `origin_kind`, `origin_agent_id`, `origin_chat_id`, `origin_task_id`, `origin_remote_ref` |
| Destination/chain | `target_kind`, `target_agent_id`, `channel`, `root_delegation_id`, `depth`, nullable `task_id`, nullable unique `handover_id` |
| Request/admission | `title`, `brief`, `execution`, `state`, `refusal_reason`, `warning`, `gate_request_id`, `gate_chat_id`, `run_id` |
| Result/return | `result_status`, `summary`, `question`, `artifacts`, `result_body`, `question_audience`, `result_digest`, `group_id`, `woke_at`, `wake_run_id`, `wake_digest` |
| Replies | `pending_replies` JSON array of id, message and pending/sending state; guarded additive migration supports intermediate databases |
| Cloud journal | `remote_connection_id`, `remote_task_id`, `remote_task_key`, `remote_url`, `dispatch_state`, `dispatch_error` |
| Time | `created_at`, `updated_at` |

The requester unique index covers profile, origin key, target kind/id, adapter identity and requester key. Task ids are unique when present and use `ON DELETE SET NULL`; deleted work must retain its dedupe receipt. `handover_id` references the handovers row UUID, not the requester-chosen folder name.

`handovers` retains file digest/stat/revision bookkeeping. Its repository mirrors shared state into the canonical delegation in the same transaction. Delegation rows alone determine chain depth; task `parent_task_id` remains the user's separate one-level task hierarchy.

## IPC Channels

| Channel | Input → result |
|---|---|
| `delegation:for-task` | task id → `TaskDelegationsDto` with incoming `from` and outgoing `to`; an inaccessible/deleted task returns no links |
| `local-agent:set-delegation-permission` | agent id, `delegations` or `cloudDelegations`, `ask` or `auto` → `LocalAgentOutcome<LocalAgentDto>` |

Preload exposes `window.api.delegations.forTask` and `window.api.localAgents.setDelegationPermission`. Creation/report/reply are session tools, not renderer mutation channels.

## Services & Key Methods

- `delegationService.targets`, `create`, `list`, `reply`, `report` validate session ownership and perform the requested operation. `createWithTask` makes non-file journal/task linkage atomic; the existing file intake transaction does the same for a handover.
- `delegationService.create` looks an existing request up under the current origin key and, when the chat now has a task, under the chat-only key as well (`delegationOriginKey(originFor(session, null))`): the key carries the origin task, so a chat that gained its task after asking would miss its own row. For a cloud target the standing grant is ignored when the parent delegation or its root has an origin `isOutsideOrigin` (`src/shared/delegations.ts`: `external`, `remote_task`) accepts; the request goes to the gate. The bare-target result carries `id` beside `delegationId`, the same field the kit/cloud DTO has and the one `handover_reply` looks a delegation up by; both are null when the scan recorded no row for the brief.
- `delegationRepo.parentOfOrigin(userId, { taskId, chatId })` is the one lookup for the delegation an origin is itself working under: by the origin task, else through the origin chat's newest undeleted task. `handoverService.intake` takes depth from it through the `chainDepth` dep (stored depth `max(parent + 1, brief.depth)`; with no chain found the declared depth stands), and the `handoverRepo` insert in `src/main/db/handovers.ts` takes `root_delegation_id` from it. Depth and root must not be resolved separately: a brief naming only `origin.chat` that got its writer's depth but a fresh root would hide an outside origin from the cloud-grant rule.
- `DelegationToolProvider.getTools` offers requester tools and offers report only to an executor session. `callTool` rejects unoffered tools/unknown arguments, forwards cancellation to discovery/create and remembers the previous list within that turn to discourage polling.
- `conductorBridge` attaches the provider to eligible local folder ACP sessions, alongside conductor tools when appropriate. The loopback descriptor and bearer belong to the session; pooled engine process configuration stays independent of the chat token. Nested and remote-launch sessions do not gain this path.
- `delegationFiles` validates the handover id and protocol directories; exclusive temporary creation plus hard-link publication makes the final pathname no-clobber. The reporting footer is appended by main. The same destination rule applies to numbered revisions.
- The kit/cloud gate is private to `delegationService`: `openGate` opens a `delegation:<row id>` request on a hidden chat from `createGateChat`, with `gateQuestion` as its text and the options `HANDOVER_GATE_OPTIONS.run`, `autoLabel`, `HANDOVER_GATE_OPTIONS.skip` (`src/shared/handovers.ts`), in that order. `gateNames` supplies the executor (the task's assignee, else the target agent, else a generic phrase) and the requester (the origin agent). `autoLabel` reads `Run and auto-run delegations to <executor>` locally and `Send and let <requester> delegate to the cloud without asking` for cloud.
- `delegationService.answer` resolves those gates; local admission reuses the hidden gate chat. It reads the labels off the open `taskInputRequestRepo` request: a choice not among them is `malformed`, and the stored label that is neither Run nor Skip is the standing grant (`localAgentService.setDelegationPermission` on the target for local, the origin agent for cloud). Rebuilding the label at answer time broke on a rename in between. `reconcile` repairs missing asks, recovers pending replies, sweeps desktop runs and advances/polls cloud journals.
- `delegationLifecycle.applyResult` normalizes and hashes semantic result content, updates the task, stores result fields and initiates return delivery. The private `stateFor` and `taskStatusFor` map a result status (and question audience) to the delegation state and the task status. `applyOutcome`/`watchTurn` supply the no-report fallback; `skip` cancels and contributes to group completion.
- `delegationLifecycle.sweepLostRuns` does two separate things per row. The wake retry runs only for a row with a `result_digest`, no `woke_at`, and a warning that is neither `wake_refused:*` nor `report_unparseable`, in a terminal or `blocked` state. The lost-run test runs only for `channel === 'local'` rows `running` past the grace period; it skips open questions, live turns and pending replies, and retires a row whose task is gone as `skipped`/`task_removed` without stopping the loop. File rows are swept by `handoverService`, cloud rows never.
- `returnPacket` in `delegationLifecycle` builds the non-file single packet for the production `wake` dep: requester key and status, target, task, a `Remote task:` line (key and URL) when `remote_url` is set, a `Note:` line with the row warning on the cloud channel, the question with its `handover_reply` instruction, artifacts, and the body capped at 4000 characters. Group packets go through `wakeGroup` and the file packet shape.
- `taskService.acceptRemoteResult` uses the remote-fact update path for cloud results. Applying a remote result must not call desktop-authority setters on a task now owned remotely.
- `delegationRepo.recordWake` compares the captured expected result digest before updating delivery acknowledgment or warning. `handoverWake` carries that expected digest per member of a group. A queued old packet cannot stamp a newer result delivered.
- `handoverWake` also checks active-profile authority and result freshness before admitting a turn. Its settlement callback releases the lifecycle's pending claim after success, refusal, timeout or failure. Cloud result ids participate in the semantic digest so a repeated question with a new identity receives another wake.
- `delegationReplies.enqueue` persists before queuing and returns a reply id. `reconcile` retries pending entries; entries left sending receive `reply_uncertain` rather than automatic replay. Admission stores the run id and removes the accepted reply; known pre-admission refusal restores pending.
- `delegationCloud.dispatch` journals before each remote effect, captures profile/connection freshness and binds only the delegated task. `reply` requires requester audience, structured ask identity and a matching open ask.
- `delegationCloud.dispatchWork` throws the private `DispatchInterrupted` from its profile/connection assertion. Caught around upload and execute, it patches `dispatch_state` back to `created` when nothing was sent (`state` untouched, so `delegationService.reconcile` dispatches again) and to `uncertain` otherwise; it never takes the `failed` branch a `RemoteTaskError` refusal takes. `delegationService.startFailed` leaves any row with a `dispatch_state` to that journal instead of reopening a Run gate.
- `dispatchWork`'s pre-create checks — first the two task checks: the row has a connection and its own independent task, and that task's assignee is the approved cloud target — go through a local `refuse`: on a row already `creating` with no `remote_task_id` it patches `dispatch_state` and `state` to `uncertain` with the message as `dispatch_error` before throwing. The adapter lookup and capability checks after them settle the same way (`settleUnbound`) before rethrowing, so a service that went away or lost a capability cannot leave the row `creating`.
- `delegationCloud.poll` prefers `snapshot.result`, except that an `in_progress` or `blocked` result on a `completed`, `error`, `cancelled` or `archived` task is discarded. With no usable result it sorts `listComments` newest first and takes the latest `type: 'result'` comment, else the `type: 'message'` comments with `RemoteComment.fromAgent`, kept from the newest backwards while `FALLBACK_BODY_CHARS` (3500, below `returnPacket`'s 4000 cap) lasts — the newest is always kept, cut to the budget if need be — and rejoined oldest first; the summary is the first nonblank line of the newest one, then `errorMessage`, then a status sentence. Status maps `blocked` → `blocked`, `completed` → `done`, anything else → `failed`, audience `user`. The fallback writes the warning "The remote agent filed no structured result; the task status and its latest result comment or messages were used." and the missing-attachment warning is appended when artifacts cannot be read.
- `cinnaTaskAdapter` sets `RemoteComment.fromAgent` from a non-null `author_agent_id`. Its `answerAsk` posts a structured ask to `/api/v1/tasks/{id}/delegation-reply` with `result_id` and the raw answer only: the server quotes the question to the executor itself, and repeating it doubled it.
- `delegationRepo.unboundCreatePending(userId, adapterId)` is true for a row in `dispatch_state = 'creating'` with no `remote_task_id` whose task still exists undeleted (an inner join on `tasks.deleted_at IS NULL`: a deleted child is only soft-deleted, so `task_id` stays set on the row). The full pull in `taskSyncService` checks it beside the handoff equivalents and skips the adapter without advancing its cursor.
- `delegationQueryService.forTask` is a read-only, scoped projection. `inboxService.endTurn` defers report-owned delegated tasks to lifecycle, preserving blocked/user-waiting states.

## Renderer Components

`useTaskDelegations` polls task relationship data. `TaskView` displays Delegated from/to links independently of Parent task/Subtasks, plus local/cloud state and nonempty warnings; the `Where` row (remote task key) appears for a cloud target only. The Delegated to value takes the row's remaining width (`Detail`'s `wide`), so titles truncate against the label instead of wrapping. A Delegated to row adds `delegationNoteText` under its state label only when the state is `uncertain`, `failed` or `refused` and the text is nonempty, as one truncating line with the full text in `title`; the Delegated from side keeps its own Note row. `delegationNoteText` returns `DelegationDto.dispatchError` first for an `uncertain` or `failed` row, before the warning and refusal reason. Missing task targets render unavailable text. The `Delegations` read-error row with its retry action renders only when the query has an error and no data.

`PermissionsCard` uses the existing permission field layout: kit agents get Delegations (`Ask before running` / `Run automatically`); both folder kinds get Cloud delegations (`Ask before sending` / `Send without asking`); bare agents retain Handovers. Explanation is behind `SettingsInfoTip`, saves disable the affected select, and failures stay inline through `unwrapIpcError`. The error under each of the three selects is an always-rendered one-line slot that truncates with the full text in `title`, as the Approvals field does: a refused save must not push the settings below it down.

## Configuration

There is no new environment variable or OS scheduler. The existing handover scheduler reconciles on the wall-clock minute and app lifecycle triggers. Open-delegation counts are wire-only additions to `buildTurnHeader`, absent when zero.

`delegations` and `cloudDelegations` are stored in the desktop-state `.delegations` sidecar under `userData` for both kit and bare agents. Only literal `auto` grants automatic admission; other values do not. Bare `handovers` retains its existing git-check policy. Remote metadata/result behavior is negotiated through adapter capabilities/server support, not adapter-name branches in the bus.

## Security

- Main derives profile/origin/depth, validates chat-to-agent ownership and rejects inactive profiles, disabled targets, stale cloud connections and excess depth. A tool argument cannot impersonate another requester or lower the chain depth.
- File-origin validation selects the owning profile; an unresolved origin does not become a cross-profile wake address. Symlink checks and no-clobber publication protect protocol boundaries without widening engine sandbox roots.
- Cloud auto permission is attached to the sender. Local kit auto permission is attached to the receiver. Folder-controlled manifests cannot grant either permission.
- A remote blocked result with no explicit requester audience is treated as a user question. Only a matching requester-directed ask can be answered by `handover_reply`.
- Journal ambiguity stays visible. Neither remote execution nor a local reply left sending is silently replayed after a crash. Wake digest acknowledgment prevents stale queued result delivery from suppressing a newer result; it is not a cross-process exactly-once guarantee.

## Verification

Repository and service tests cover migration/backfill, scoped requester identity, immutable file publication, permission gates, depth, mixed-channel groups, replies, result delivery and restart recovery. Adapter contract tests cover negotiated support, legacy fallback and uncertain dispatch.

Build first with `make build`, then run each Electron scenario separately with `make e2e-one SPEC=<name>`:

- `handover-flow`: the file channel and task navigation.
- `delegation-local`: real loopback MCP creation, approval, blocked report, requester reply and final wake through a scripted ACP engine.
- `delegation-bare`: a kit requester delegating to an adopted bare folder through the session tools alone — main publishes `brief.md` and `revisions/001.md`, both reports are `handover_report` calls, and no `report.md` exists at any point. It does not cover `execution: auto`, groups or restart recovery.
- `delegation-cloud`: independent cloud creation, two identically worded questions with distinct result ids, replies and final return through the HTTP adapter.
- `delegation-settings`: kit/bare permission controls and persistence.

These scenarios use isolated HOME/userData directories and local fake services. Real pinned engine probes verify MCP/session-load and filesystem boundaries separately; they do not establish authenticated automatic-approval behavior against live model services.
