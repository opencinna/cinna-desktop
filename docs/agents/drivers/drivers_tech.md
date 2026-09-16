# Agent Drivers — Technical Details

## File Locations

- Shared: `src/shared/agentDrivers.ts` holds AgentDriverId (a2a/acp/managed), AcpLauncherId (opencode/claude/codex/custom; gemini recognized but unimplemented), capabilities/readiness DTOs and guards. `src/shared/runEvents.ts` is the run event vocabulary.
- Registry: `src/main/agents/drivers/index.ts` wires production dependencies and driverFor; `src/main/agents/drivers/driver.ts` defines AgentDriver/RunInput/RunResult/ParkedAsk; `src/main/agents/drivers/driverOf.ts` and `src/main/agents/drivers/capabilities.ts` are pure row readers. `src/main/agents/drivers/unsupportedDriver.ts` provides total refusal for unknown identities.
- A2A: `src/main/agents/drivers/a2aDriver.ts`, `src/main/agents/drivers/a2aConnection.ts`, `src/main/agents/drivers/a2aErrors.ts`, `src/main/agents/a2a-client.ts`, `src/main/services/a2aStreamingService.ts`.
- ACP: `src/main/agents/drivers/acp/acpDriver.ts`, `src/main/agents/drivers/acp/acpRuntime.ts`, `src/main/agents/drivers/acp/acpLaunchers.ts`, `src/main/agents/drivers/acp/acpPool.ts`, `src/main/agents/drivers/acp/acpProcessPool.ts`, `src/main/agents/drivers/acp/acpConnection.ts`; message/permission/question translation lives beside them.
- Managed: `src/main/agents/drivers/managed/managedDriver.ts`, `src/main/agents/drivers/managed/managedRun.ts`, `src/main/agents/drivers/managed/managedEvents.ts`, `src/main/services/managedAgentService.ts`.
- Execution: `src/main/services/runExecutionService.ts`, `src/main/services/liveRunHub.ts`, `src/main/services/messageRoutingService.ts`, `src/main/services/a2aAsMcpProvider.ts`; custom configuration `src/main/services/customAgentService.ts`.
- Readiness/CRUD: `src/main/services/agentReadinessService.ts`, `src/main/services/agentService.ts`, `src/main/db/agents.ts`, `src/main/ipc/agent.ipc.ts`.
- IPC/preload: `src/main/ipc/run.ipc.ts`, `src/main/ipc/agent_a2a.ipc.ts`, `src/preload/index.ts`.
- Readiness presentation: `src/renderer/src/components/chat/ComposerReadiness.tsx` owns the warning action; `src/renderer/src/components/settings/SettingsLayout.tsx` supplies its shared `SettingsButton`.
- Renderer: `src/renderer/src/hooks/useChatStream.ts` (useRunEventHandler and send command), `src/renderer/src/hooks/useLiveRunWatch.ts` (selected-chat subscription), `src/renderer/src/hooks/useAgents.ts` (readiness), `src/renderer/src/hooks/useAgentRequests.ts`, `src/renderer/src/components/chat/ChatInput.tsx`.

## Database Schema

- agents.driver selects transport; source remains ownership. driver_config contains launcher-specific configuration, never a fallback dispatch instruction based on source.
- `src/main/db/migrations/agent-drivers.ts` backfills historical rows, followed by `src/main/db/migrations/acp-driver.ts`. There is no recurring agents-driver-populated boot repair. Unknown/null IDs remain visible, inert and explicitly unsupported.
- agentSessionRepo in `src/main/db/agents.ts` is the driver-neutral repository. The physical a2a_sessions table and context_id/task_id/task_state columns remain unchanged. General session continuity keys chat/agent; storage does not determine which driver runs.
- Folder ACP also records desktop state; custom ACP has binding-keyed external files; Managed uses its private managed_agent_sessions table and public generic context mirror. Their differing persistence/recovery guarantees are documented in the feature references below.
- Folder scanners write the explicit ACP launcher through folderIndexLauncher/setFolderLauncher. Execution re-reads the folder runtime; a temporary invalid/unreadable folder is refused rather than switching engines.

## IPC Channels

| Channel | Contract |
|---|---|
| run:start | Activated RunSendPayload command → `RunStartResult`: a new run, or a message steered into or queued behind the chat's running turn. Main chooses the router/agent and owns acceptance/completion. |
| run:watch | Owned chat MessagePort subscription → initial snapshot and sequenced live envelopes. Detaching does not stop execution. |
| run:cancel-chat | Cancel the owned chat's main run, including early startup. |
| run:send | Retained lower-level RunSendPayload + MessagePort path through the same executor; not the normal renderer selection route. |
| agent:list | DTOs include raw driver, capabilities and cached readiness; schedules eligible background checks without awaiting them. |
| agent:check-readiness | Explicit fresh readiness check; changed visible results invalidate renderer data. |
| agent:answer-request | Shared durable Inbox answer route; captured ACP/Managed authority owns delivery. |
| agent:pending-requests | Active-profile owned chat → live permission/question registrations. |
| agent:get-session | Owned chat → generic session DTO; no private runtime binding. |
| agent:reply-uncertainty | Active-profile owned registration → current uncertainty display reason or null. |

The old agent/model-specific send forwards are removed. Custom and Managed configuration channels are described in their own technical references. No renderer-selected transport or private reply destination enters normal run:start.

## Services & Key Methods

- driverFor reads only the explicit supported driver ID. Unknown identities resolve to unsupportedDriver, with stable inert capabilities, invalid readiness, refused replies and no I/O. Historical migration backfills are the only ownership-based defaulting.
- runExecutionService.start reserves a chat, persists/adopts input, resolves shared routing and invokes the selected driver or model/script path. Acceptance and completion are separate. liveRunHub observes output even without a subscriber; stream services persist it. See [live attachment](../../chat/messaging/live_runs.md) and [turn outcomes](../../chat/messaging/turn_completion.md).
- A2AAsMcpProvider invokes the same driver for specialist tool calls and supplies trusted attribution/event framing. Coordinator controls are separate ToolProvider implementations; an LLM coordinator is not an AgentDriver.
- AgentDriver.run takes owner, row and RunInput and returns a result carrying failures. Readiness never throws; capabilities are pure. Synchronous respond is ACP; Managed's actual reply destination is its captured asynchronous registration. Shared contracts validate both families.
- **Mid-turn delivery is offered, not declared.** `RunInput.registerSteer` receives a `SteerFn` while the driver can take a user message into the running turn and `null` the moment it cannot — which can happen more than once in a turn: the ACP driver withdraws the offer while a tool call runs and makes it again when the last one ends. A `SteerFn` answers `injected`, `late` or `unavailable` and never rejects. Only the ACP driver calls it, and only for an agent whose `initialize` answer advertised `_meta.steering.supported`. That is why it is not an `AgentCapabilities` field: capabilities are computed from the row without I/O, and this is known only once a process has answered. `runExecutionService` exposes it as `RunHandle.steer`, whether it is offered right now as `RunHandle.steerable`, and each renewed offer through `RunHandle.onSteerable`; [Pending Messages](../../chat/pending_messages/pending_messages_tech.md) decides when to use it, and hands queued messages to the turn on a renewed offer. A2A, Managed and the model path never offer it.
- **What a turn has streamed is offered too, for a turn that may never return.** `RunInput.registerSnapshot` is called once, early in the turn, with a function returning a shallow copy of the turn's `parts`, `notices` and `steers` lists (`TurnSnapshot`), text read in streaming mode so a half-written attach tag is left out. The direct-chat wrapper reads it when the app quits mid-turn — Electron does not wait for the turn — and when a driver throws despite its contract, so the output the user watched arrive is saved either way. All three drivers register one — ACP and A2A from their accumulators, Managed from its parts list; a driver that does not loses an unfinished turn's output at quit. `runExecutionService` passes it through from the wrapper's `TurnIO`; a `/run:` command never registers. See [What a direct turn keeps when it never returns](../agents/streaming_pipeline.md#what-a-direct-turn-keeps-when-it-never-returns)

### Capabilities per driver

| | `a2a`, Cinna-synced | `a2a`, hand-added | `acp`, launcher `opencode` | `acp`, launchers `claude` / `codex` | `managed` | `acp`, launcher `custom` |
|---|---|---|---|---| --- | --- |
| `streaming` / `cancel` | yes / yes | yes / yes | yes / yes | yes / yes | yes / yes | yes / yes |
| `sessions` | `context` | `context` | `resumable` | `resumable` | `resumable` | `resumable` |
| `input` (asks raised) | `question`, `auth` | `question`, `auth` | `permission` | `permission`, `question` | `permission` | `permission`, `question` |
| `inputResume` | `next_message` | `next_message` | `reply` | `reply` | `reply` | `reply` |
| `attachments` | `cinna` | `none` | `none` | `none` | `none` | `none` |
| `auth` | `cinna` | `token` when one is stored, else `none` | `none` | `cli` | `token` (API credential) | `cli` |
| `commands` | `card` | `card` | `catalog` | `catalog` | `none` | `none` |
| `mcpInjection` | no | no | no | no | no | no |
| `cwd` | no | no | yes | yes | no | no |


### ACP execution

readAcpRuntime is asynchronous and captures either a fresh folder and its state closures, an owned custom command and binding validation, or an account builder restored through `restoreDevelopmentContext`. Builder restoration joins startup reconciliation and warms the model catalogue before projecting the account workspace into a folder view; external state closures retain session/grant authority. See [Build Sessions runtime](../local_dev/build_sessions_tech.md#saved-sessions-and-launch-plans). Folder launchers choose OpenCode/Claude/Codex from the current folder runtime; custom uses the saved executable configuration. Both run through one ACP turn implementation, process pool and per-agent lock. queueWhenBusy permits abortable autonomous admission; ordinary interactive overlap refuses. `acpDriver.beforeStart` races both runtime reads and launch planning against Stop, observes late outcomes and removes abort listeners; canceled preparation cannot acquire a process or emit a later event, while shared restoration can finish independently.

The replay gate closes before session bind/load. Replayed history never duplicates transcript output or old asks. Stop and ceiling cover initialize/new/load/setup; late startup cannot publish a canceled connection or send a prompt. During a prompt the cancellation grace retires an unresponsive process; external commands warn when remote stop is unconfirmed. User Stop returns canceled while retaining partial text. See [ACP turn](../local_agents/agent_turn_tech.md) and [custom commands](../custom_agents/custom_agents_tech.md).

respond finds the runtime captured for the actual park and validates it before grant/once delivery. The optional registration validator also runs before the legacy folder orphan fallback. Grants belong to the captured folder or external binding; a renderer-supplied ID cannot reconstruct that authority.

### The A2A driver

The A2A driver owns card/endpoint/token preflight and Cinna reauthentication classification. Stop interrupts silent card/JSON/SSE waits, preserves visible partial output and the prior session checkpoint, and sends at most one best-effort tasks/cancel after client/task identity is known. A cancel answered `canceled` or `completed` counts as confirmed (an older Cinna backend answers `completed` when the cancel lands before the agent spoke). A cancel answered with no state (an older backend's empty result) gets one `tasks/get`, where only `canceled` confirms. The turn waits `CANCEL_ANSWER_WAIT_MS` (500 ms) for the cancel and `CANCEL_READ_WAIT_MS` (1 s) more for that read. A confirmed stop saves the task state through the injected `saveTaskState`; without one, the turn gets a notice that the remote stop was not confirmed. The driver forwards `RunInput.messageId` as the A2A `messageId`, and passes `renewAccessToken`, which resolves the token again for a poll that was refused while a dropped turn is collected and reports a needed sign-in as a 401. Bound fetch signals work through the legacy SDK client's injected fetch seam; cancellation uses an independent deadline. See [streaming pipeline](../agents/streaming_pipeline.md).

### Managed execution

The official SDK owns sessions/events HTTP/SSE. The driver reconciles complete history, waits for the exact processed kickoff, and applies permission barriers before further output. Private profile/configuration/credential identity fences continuity. The saved checkpoint state does not gate a send. The remote session's status and history do: a budget pause, work still running or queued, a pending permission or a terminated session refuse, each naming its cause, while an idle session after `end_turn` or `retries_exhausted` accepts. Bounded Stop distinguishes confirmed interruption from uncertain remote state. `followManagedSession` re-attaches to a turn the app was closed under; see [Interrupted Turn Recovery](../turn_recovery/turn_recovery_tech.md). See [Managed Agents](../managed_agents/managed_agents_tech.md).

### Readiness and renderer behavior

agentReadinessService holds main-memory cached results, schedules enabled rows without blocking list responses, discards superseded checks and broadcasts visible changes. A2A probes card/auth with a deadline; OpenCode uses folder readiness without downloading on a list read; Claude and Codex add installed/login rungs. Managed validates local credential/configuration availability. Custom ordinary reads return its latest binding-keyed check or null; only explicit Test/Check again initializes a command.

The composer refuses the directly addressed agent on an established refusal and retains the draft. Null never refuses. Bare catalog commands remain eligible independently of model readiness. Tool specialists report failure through their tool result. Cinna reauthentication is selected by capabilities.auth, not source. useAgents invalidates with cancelRefetch false so multiple mounted listeners do not restart the same fetch.

`ComposerReadinessWarning` renders `ReadinessActionButton`, keyed by reason ID plus action label. It reuses `SettingsButton` sizing/background/border; **Check again** shows a 13 px `RefreshCw` at rest and spins it while pending. Other readiness actions retain their own pending label and use a 13 px `Loader2`. Pending is `action.pending || feedback`: a local 600 ms timer makes an immediate unchanged result visible, while the mutation's pending flag keeps a slower operation spinning beyond that interval. A resolved warning unmounts immediately rather than waiting for the timer.

The action sets `aria-busy` and focus-preserving `aria-disabled`. `SettingsButton` suppresses clicks while aria-disabled, and the action additionally guards `action.pending` and its timer ref, preventing duplicates even before a rerender. The timer is cleared on unmount; changing the keyed action resets its feedback. `src/renderer/src/components/chat/ComposerReadiness.test.tsx` covers the refresh icon, immediate-result interval, busy/spinning state, retained keyboard focus and duplicate suppression.

## The Kind-Branch Ratchet

`src/main/agents/kindBranches.test.ts` is the authoritative scanner. It strips comments, walks main/shared/renderer TypeScript excluding tests/goldens/snapshots, and classifies source, engine, kind, jobType, providerType, routing and remoteAdapter comparisons. Every counted category equals its exact LIMITS value; aggregate LIMIT is zero.

Zero means no counted behavioral debt. Explicit allowlisted transport/sync sites and exact per-file ownership/authoring/presentation pins remain, including custom configuration ownership and trusted coordinator controls. Raising a pin is not interchangeable with hiding new behavior; each pin names its reason and the scanner checks both additions and removals. Migration history and physical legacy table names are not live routing fallbacks.

## Configuration and Security

[Codex](../local_agents/codex_engine_tech.md) shares Claude's advertised capability values but retains its own launcher, CLI profile and approval default. Its form elicitation bridge has actual-adapter coverage; a matching capability vector does not imply identical permission or configuration behavior.

Configuration/auth belongs to the selected launcher/driver, with APIs documented in [folder engines](../local_agents/engine_tech.md), [custom commands](../custom_agents/custom_agents_tech.md) and [Managed sessions](../managed_agents/managed_agents_tech.md). Keys remain in main. Source checks outside transport code govern who may read/edit/sync a row; driver capabilities govern execution affordances. Bound remote replies never select a replacement credential or destination after user/profile/configuration changes.

## Verification

`src/main/agents/drivers/__golden__/driverContract.ts` is shared by A2A, folder ACP, custom ACP and Managed subjects. It asserts failure/cancellation settlement, quietness, request lifetime, continuity, capability stability, readiness and unknown answers. A2A's next-message semantics omit its six live-park clauses; ACP/custom/Managed execute them. The former ACP cancellation-result exception is removed. Wrappers, not drivers, own root request-id and terminal delivery. Golden A2A fixtures preserve protocol evidence; real ACP child and official Managed HTTP/SSE peers exercise their transports. See [runtime history](../../development/agent_runtime/agent_runtime.md) for measured closure evidence.

## Captured asynchronous reply delivery

- `src/main/agents/drivers/replyDelivery.ts`: AsyncReplyBinding owns validate/respondAsync/optional normalize. ReplyRegistration contains opaque token, AbortSignal, origin, binding, isCurrent and token-fenced release; these never appear in owner/list DTOs. The binding must preserve originating agent/credential/session identity and validate again inside future transport dispatch after any asynchronous credential work.
- `src/main/agents/drivers/pendingRequests.ts`: register optionally captures delivery; absence is the synchronous ACP origin. The optional synchronous validate callback captures external runtime authority and is checked before orphan fallback. Ordinary resolve refuses a non-rejected answer into an asynchronous registration. Replacement/cancel/timeout/clear invalidate the old token and signal. Async drop also settles its local barrier rejected without sending another remote answer; ACP drop preserves notification-only behavior and leaves its old answered promise unresolved.
- `src/main/services/replyAnswerClaims.ts`: a WeakMap keyed by registration token owns sending/accepted_pending/uncertain. The signature uses normalized permission kind/reply or the full question answer; remembered is persistence metadata and does not change the remote decision or prevent an equivalent answer joining. Same answer joins the installed promise; opposing answer returns answer_in_progress. Definite not_sent clears the claim for explicit retry. Throws/unknown acknowledgment become uncertain and never resend. Accepted_pending retries validation and synchronous local commitment only. Cancellation settles the claim promptly even if the underlying remote promise remains unresolved; late responses cannot release a replacement.
- `src/main/services/askDelivery.ts` — `deliverAnswerWithCommit`: validates captured profile/settings scope, chat, durable request/task and binding before dispatch and after acceptance. Async success is commit then release. The ACP branch calls existing deliverAnswer and commit in one synchronous stack; introducing an unconditional await would let resumed ACP cleanup expire the row first. Effective always becomes once with the actual remembered boolean in the durable resolution, matching the ACP park/stream outcome. Async normalization likewise carries remembered into the committed/released effective permission.
- `src/main/services/inboxService.ts` — `answerFromTranscript`: an existing durable row always goes through answer, including refusal. Otherwise runner bridge gets its own route, then only rowless ACP can use live fallback. Remote-address and next-message routes retain their separate mechanisms.
- `src/main/db/taskInputRequests.ts` — `commitReply`: transaction rechecks exact task/chat/agent/rootRun/invocation/createdAt, open driver-owned reply and desktop task; settlement and strict aggregate task update commit together. Service also requires runsHere and blocked/in_progress. Siblings retain needs_input. Failure rolls back the request row, so accepted async delivery keeps its park and retries only local commitment.
- `src/main/services/inboxReplyDelivery.test.ts` uses real SQLite/registry and the actual ACP responder to pin both surfaces, immediate continuation ordering, effective Always/once, siblings and rollback. `src/main/services/replyAnswerClaims.test.ts` pins acceptance, conflicts, uncertainty, cancellation/replacement and local-only retry.

Claims are memory-only; restart expires live driver reply rows and never replays uncertain confirmation. The [Managed transport](../managed_agents/managed_agents_tech.md) supplies unique request IDs, captured session/thread/tool addresses, bounded no-retry HTTP and a stream barrier before continuation/end-turn processing. Its SDK0.125 integration and private database continuity are described there.
