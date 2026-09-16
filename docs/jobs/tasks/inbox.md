# The Inbox

## Purpose

The Inbox is one list of open questions and permissions belonging to tasks, answerable without opening their chats. A live local driver, a durable A2A continuation, a coordinator runner gate and a bound remote service keep their own answer mechanisms; the desktop presents them through the same input-request components.

## Sources and Addresses

- Local entries come from open `task_input_requests` rows scoped through their task. A driver-owned `reply` id addresses the parked driver; the in-memory registry is consulted when answering, never to construct the list. A `next_message` row instead records a durable continuation, visible only while its task is blocked/in progress and belongs to this desktop device.
- Next-message addresses start with `next-message:` and encode chat, agent, main turn and protocol request ids. Child invocation identity is part of the turn key. Duplicate frames deduplicate; repeated questions in later turns get new cards. They survive normal turn completion and restart, unlike live reply addresses.
- Runner gates use `deliveryOwner: runner`, a null agent and a reply resume kind. Their IDs include runtime attempt, main turn and tool call; they survive boot and ordinary turn cleanup. Main commits the gate and checkpoint before publishing the ask, and commits its answer plus continuation checkpoint before enqueueing. Checkpoint pendingRequestIds retains sibling addresses across sequential root turns. Both Inbox and transcript answer IPC route through the runner before live-driver delivery. Answers during turn cleanup refuse retryably; the Inbox stays open. See [autonomous execution](autonomous_tasks_tech.md). Script ask_user gates instead use attempt/step identities and belong to isolated child tasks; answers validate the saved graph and every child binding before progressing that step. Whole-script Stop refuses late answers and expires only its recorded/run-scoped requests. See [script execution](script_execution_tech.md).
- Remote entries come from locally stored, non-deleted blocked tasks with a binding whose adapter supports asks. `remoteInboxService` checks availability and fetches `listOpenAsks`; it does not require the task's executor to be remote. This is a live enumeration, not a persisted second registry.
- A remote request address is `remote-ask:` followed by the JSON array of local task id, adapter id, remote task id and ask id. The local task and binding prevent identical service ask ids from colliding or a stale card answering a newly linked task.
- Reads recheck the binding after the network returns. Answers perform a profile-scoped lookup, refuse deleted or rebound tasks, and recheck after availability before invoking the adapter. No credentials or opaque binding state travel in the entry.

## User Flow

1. Open the Inbox from the compact square top-bar button between the sidebar toggle and New Chat (available even with the sidebar collapsed or Settings open), or from a blocked task with a known ask. Local and remote requests render through the same permission/question components.
2. Enter an answer. While it is sending, the question modal disables editing, sending again, closing, Escape and backdrop dismissal.
3. On success, the modal closes and the card records the outcome. A stale/settled refusal also ends the card; malformed or unavailable delivery keeps the controls and draft for retry.
4. A next-message question starts a new turn in main after acceptance, leaving the Inbox open. Authentication asks use the same modal with the agent’s message followed by **Reply when you are ready to continue.** A textless question shows the questions, headers and options of the Cinna ask-user tool part it carries, and becomes **What should the agent do next?** only when it carries none; textless authentication uses the sign-in fallback.
5. An acted-on card stays mounted until the user leaves the Inbox. Newly arriving cards append after existing cards so a poll cannot move a decision button under the pointer.
6. Below the asks, **Recent tasks** lists root work, including tasks with no ask and no job. Clicking a row opens the task page. A task with neither a parent nor a job offers **Back to the Inbox** from there.

## Recent Tasks

The Inbox screen is one page with one scrollbar: the asks, then the work they belong to. Tasks come from job runs and conversations; nobody starts one from a list. They used to fill a section of the Jobs sidebar, where they competed for height with the jobs, the one list in that panel the user acts on. The sidebar now shows jobs only.

- **The block is anchored to the bottom of the screen.** On a quiet screen, the spare height collects between the asks and the tasks. Arriving tasks grow the block upward into that gap, and the page scrolls only when the two blocks together outgrow the window. After that, asks push the tasks down, which is the right priority: what is waiting on the user comes before what already happened. The anchor exists because the asks block has three quiet heights (loading, empty, failed or partial). Anything placed directly under it moved every time the Inbox opened cold or a service stopped responding.
- **Ten rows, then Show more tasks for ten more.** Each row shows a status icon (`TaskStatusIcon`), the title, and the relative time of the last update. The status comes first so every title starts at the same left edge, and the time comes last because it is the only part whose width changes on its own. The accessible name is `<title> — <status>`: an `aria-label` replaces the row's content, and the status is the point of the list. The time is left out because it rewrites itself every minute.
- **Order is fixed while the screen is open.** The query is `updated_at DESC` and runs every five seconds. Without a fixed order, any task changing anywhere would jump to the top and shift every row under the pointer. A task updated while the screen is open keeps its place, and a new task appears at the end. Leaving and reopening the Inbox restores true order.
- **Show more keeps the button under the pointer.** The new rows would push the button ten rows down and put a task row where it was, so a second click would open a task nobody chose. The page scrolls by exactly the added height. This is allowed because it responds directly to the user's click.
- **It reads only local SQLite.** `useTaskList()` with no parent calls `tasks.list({rootOnly:true})`, so this list cannot be half-read the way a remote refresh can be. A failed read keeps the rows and shows **Tasks could not be read.** with `Try again` under them. Opening the Inbox triggers a device-sync pull (the Inbox is in `SYNCED_VIEWS`), and the five-second poll then shows a task another device changed.
- **It is not the composer's Tasks badge either.** That badge lists one chat's root tasks, ten at most, and its **Open Inbox** leads here for the rest ([Session Activity](../../agents/session_activity/session_activity.md#seeing-the-chats-tasks)). Both use the same row.
- **It is not the Subtasks list.** A task page still lists its children through `TaskList`, at that page's scale, with its own background refresh and error footer.

## Polling, Failures and Concurrency

`inbox:list` returns an `InboxSnapshot`: `entries`, newest first, and `unreadable`, the remote services this read could not reach. `inboxService.list` starts the remote enumeration, reads the current local rows while it runs, then merges the two. `useInboxList` supplies the view, the badge and the task page from one five-second query with one retry, subject to the window visibility gate.

**An unreachable service leaves a gap in the list; the rest of the list still loads.** Local asks are always returned, whatever the remote side answered. Each service that could not be read is named once in `unreadable` by adapter id, with the first failure's reason, however many of its blocked tasks failed. An empty `unreadable` means the list is complete, so there is no separate completeness flag that could disagree with it. The old contract rejected the whole list when any remote read failed, so an ask parked on this machine disappeared from the Inbox for as long as someone else's service was down. The local read also does not wait for the remote one to finish first: an unresponsive service took the full ten-second deadline on every poll, so a cold Inbox showed `Loading…` over a local permission ask for all of that time.

**A whole-list failure still rejects.** A SQLite error means this device is broken, not that a source was unreachable, and there is no partial list to return. TanStack keeps its previous data on a rejection, so the error state takes precedence over the cached count everywhere.

**Remote asks from the last read stay on screen while something is unreadable.** Main deliberately keeps no cache of remote asks: they are a live enumeration of the service, not a second registry. The renderer is therefore the only place that remembers them. While `unreadable` is non-empty, `useInboxList` merges in the `remote` entries from the previous read that this read did not return. Local entries are never retained, because a local row that left the list left it in main. Dropping a remote card would pull a row out from under the user, and it would hide an ask that can still be answered: answering goes through the adapter, which refuses with a retryable error while the service is down.

**What each surface shows:**

| State | Top-bar badge (visible / accessible name) | Inbox view | Blocked task page |
|---|---|---|---|
| Complete read | count, blank at zero / `Inbox — <n> waiting` or `Inbox` | the list, or **Nothing is waiting on you.** | an ask, or nothing waiting → re-run |
| Partial read | count in the warning tint, **`!`** when the count is zero / `Inbox — <n> waiting, one service could not be read` (or `<n> services`) | rows, then **One service could not be read — some requests may be missing.** with `Try again`; with no rows, **Part of the inbox could not be read.** instead of the empty state | a bound task with no ask found: **This task is blocked. What it is waiting on could not be read.** with `Try again`; an unbound task is unaffected |
| Rejected read | `!` / `Inbox — could not be read` | the last rows plus **Showing the last read — the inbox could not be refreshed.**; cold, **The inbox could not be read.** | the same could-not-be-read line, bound or not |

- **A partial badge keeps its count.** The asks it counts really are waiting, so replacing the number with `!` would hide a fact behind a warning. The only thing the number cannot claim is that it is all of them, and only the accessible name says so, because the overlay is `aria-hidden` and two characters wide. At zero, though, a count-keeping badge would look exactly like a healthy, empty inbox for a profile whose only bound service just went down. So zero is the one partial state that shows `!`.
- **The two failures never show together.** In the view, a rejected refresh and an unreadable service share one line under the list, and the rejected one wins, because on a rejection `data` is the *previous* read and repeating its old service failure would report two problems where there is one. The line sits under the rows, never above them, so a failure arriving while the pointer is on a card does not move the card.
- **The sentence never names a service.** `describeUnreadable` in `useInbox.ts` is the one wording, shared by the badge and the view. A `RemoteTaskAdapter` has an id and no display name, and an id is not something to show a user.
- **The task page asks whether the gap could contain *its* ask.** A task with no remote binding can only have local asks, and those are complete once the query resolves, so the page still treats its answer as known. A bound task's answer is unknown while anything is unreadable. That page therefore neither offers the re-run nor claims nothing is waiting. Before this check, the partial case rendered **This task is blocked.** with no explanation and no retry.

**A UI deadline does not release the network lock.** Remote reads share one in-flight operation per profile. The UI stops waiting after ten seconds and receives a snapshot that names every adapter the read was waiting on as unreadable (**The service did not answer in time.**), rather than a rejection, so the local rows survive one slow system. Retries join the same operation until all fan-out branches settle. `Promise.allSettled` matters: rejecting at the first failed task previously released the lock while slower siblings still ran, allowing every retry to duplicate their network work. Cinna's JSON transport aborts a fetch, including a stalled body, after thirty seconds; a multi-request enumeration can last longer than one transport call.

**One remote ask has one in-flight answer per profile.** Identical resolutions join the pending operation. A different resolution receives a retryable refusal; otherwise two windows submitting Yes and No could both claim success although only Yes was sent. An answer-facing ten-second deadline returns an unavailable/confirmation-pending result while preserving that same raw operation. A retry during the pending interval does not resend it. The service does not persist a durable answer receipt after the operation settles; the adapter rereads the service's open asks on a subsequent attempt.

## Driver reply acceptance and commitment

Transcript and Inbox answers use the same durable request settlement. A row already present in task_input_requests cannot fall back to live delivery when it is expired, foreign or otherwise refused. Rowless delivery remains limited to an ACP-origin park; a captured custom runtime is validated before delivery or missing-agent fallback, so deleted/reconfigured command agents cannot answer through the folder orphan path; an asynchronous binding never uses the missing-agent ACP fallback. Runner gates, next-message continuation and adapter-owned remote asks keep their existing routes.

An async driver reply captures its original delivery binding and one registration token. Identical normalized permission decisions or full question answers join (remembered metadata does not alter that identity); an opposing answer receives answer_in_progress. Definitely unsent delivery can retry explicitly. Unknown acknowledgment returns uncertain with **Do not submit it again**; repeated attempts do not send another confirmation. Accepted-but-unrecorded delivery remains accepted_pending and retries only the local transaction, with that distinction in its reason.

The durable transaction rechecks the exact request/run/invocation/task/chat/agent binding and local active task ownership, then settles the effective answer and updates aggregate task state. An open sibling keeps the task blocked. Only a successful transaction releases an asynchronous park; rollback preserves it. ACP retains its synchronous grant/resolve/commit order so the immediately resumed continuation sees the durable answer before closeAsk/endTurn. Its grant semantics remain unchanged; the durable effective once resolution includes the actual remembered boolean, matching the park/stream result. Async normalization also preserves that metadata in the committed/released permission.

Cancellation, replacement or expiry invalidates the claim. Dropping an asynchronous registration also rejects its local barrier; ACP's notification-only drop remains unchanged. Claims do not survive restart: ordinary driver reply rows expire rather than replay remote confirmations. The [Managed driver](../../agents/managed_agents/managed_agents.md) uses this route for exact session/thread/tool confirmations. Its requests carry allowRemember false, so both Inbox and transcript offer once or deny. An uncertain answer remains visibly unresolved with all decisions disabled. Transcript and Inbox share the warning immediately and restore it from main after renderer reload through agent:reply-uncertainty, which checks active-profile chat ownership. A newly mounted live Managed block is inert until that authoritative read succeeds or returns a known warning; failed reads retain the guard and retry. Main still prevents another remote submission regardless of renderer cache/navigation state. This renderer reload behavior does not persist claims across a main-process restart.

The top-bar count is an overlay on a fixed-size button: blank at zero, the count through 99, and `99+` above that. Its accessible name announces the complete count or the read failure; updates do not move neighboring controls.

## Answer Outcomes

- `ok: true` confirms a live/remote answer was delivered, or a next-message/runner answer was accepted and persisted. Durable driver replies also require local request/task commitment; async remote acceptance alone is insufficient. It does not promise the continued turn has finished. Remote task status stays unchanged because another session may still be waiting.
- `no_longer_waiting`, `already_answered`, `not_here` and `not_owned` settle the rendered card.
- `uncertain` preserves the card and reason; the claim will not resend an answer whose remote acceptance is unknown.
- `answer_in_progress` refuses a conflicting answer while the original registration owns delivery.
- `malformed` keeps it retryable: the answer or request address was invalid.
- `unavailable` keeps it retryable: the service could not accept/confirm delivery, a deadline elapsed, or a different answer is already being sent. The reason travels as typed result data rather than a thrown IPC error code.

## Durable Continuation and Refusal

The ordinary next-message path below persists its user message at turn acceptance. Runner-owned answers instead settle the gate and advance the checkpoint transactionally before enqueueing; the ensuing turn persists the answer message. Both preserve the same task/chat and keep the Inbox selected, but they do not share an identical acceptance transaction.

A next-message answer must contain nonempty question text and still belong to an available chat/agent and a desktop-owned blocked/in-progress task. A moved claim or settled task cannot be resumed from a stale card. Typed messages use the same task-authority checks.

`runExecutionService` admits one active turn per chat. If the preceding stream has not finished, the answer returns a retryable busy refusal, leaving the request and modal draft intact. Main waits for `handle.accepted`, not the full turn lifetime: the user message and `inboxService.resumeChat` run in one database transaction, settling only that agent’s requests. A transaction refusal rolls both back. Another agent’s open ask prevents finalization; the continued turn’s end restores the task’s blocked status.

After acceptance, the same task/chat/job attempt and A2A context continue without a renderer port. Later network/driver errors become the continued turn’s recorded outcome. Successful turn completion preserves new next-message asks and defers job finalization until none remain. Explicit completed/error/cancelled/archived task writes expire next-message requests and settle the linked active job attempt. Manual terminal job writes update the desktop-owned task first, validating its device claim; an already terminal attempt is not rewritten. Opening that conversation attaches through the shared [live-run watch](../../chat/messaging/live_runs.md); ordinary next-message delivery starts one turn; runner-owned delivery instead advances the [autonomous checkpoint](autonomous_tasks.md).

## Invocation Ownership and Cleanup

New local rows store nullable `root_run_id` and `invocation_id` alongside chat/agent identity. `src/main/db/migrations/tasks.ts` adds them idempotently and indexes scoped open-request reads; existing rows retain null ownership. Stream-derived settlement compares the exact chat/root/invocation, so a late resolution cannot consume a reused request ID belonging to another child.

A root ending expires its own run’s driver-owned reply rows; a child ending touches only its invocation. Success preserves next-message continuations, while error/cancellation expires that ending scope. Legacy events retain the prior chat/agent cleanup path. Boot expires driver-owned reply rows globally but preserves runner gates, and an explicit terminal task write still closes its durable continuations.

Production agent tools do not have to emit a child terminal event. The model’s parent `tool_result` or `tool_error` performs exact invocation cleanup before another model round begins. Otherwise a driver that silently released its park could leave an undeliverable permission card visible until the entire model turn ended.

Every answer, typed continuation, resolution and expiry recomputes blocked/working from all remaining asks on the task. Settling one request must not hide a sibling, including one belonging to another root or a legacy row. Runner-owned endings perform this bookkeeping without finishing the whole task/job. The executor’s [completion result](../../chat/messaging/turn_completion.md) returns next-message and runner-gate IDs and separately discloses uncertain reads or surviving dead replies.

## Architecture and Files

Inbox view / top bar / task page → `useInboxList` → `inbox:list` → `inboxService.list` → local request repository and `remoteInboxService.list` → adapter.

Shared request block → `useAnswerAsk` → `inbox:answer` → parsed resolution → persisted local address / driver, next-message address / `runExecutionService`, or `remoteInboxService.answer` / adapter.

- `src/shared/inbox.ts` — shared entry, snapshot (`InboxSnapshot`, `InboxUnreadableSource`), answer payload and outcome types.
- `src/main/services/inboxService.ts` — local bookkeeping, `resumeChat`, scoped continuation guards and merged list/answer dispatch.
- `src/main/services/runExecutionService.ts` — explicit profile/settings scopes, acceptance and completion handles, single-chat admission, optional renderer forwarding.
- `src/main/db/messages.ts` and `src/main/services/messageRoutingService.ts` — user-message transaction and acceptance callback.
- `src/main/services/remoteInboxService.ts` — remote address validation, ownership, fan-out, per-adapter `unreadable` collection, the snapshot-returning read deadline and in-flight maps.
- `src/main/services/cinnaApiService.ts` — authenticated JSON transport and thirty-second abort.
- `src/main/ipc/task.ipc.ts` and `src/preload/index.ts` — activated, profile-scoped IPC and typed bridge.
- `src/renderer/src/hooks/useInbox.ts` — shared query, retention of remote entries across a partial read, `describeUnreadable`, and answer invalidation.
- `src/renderer/src/components/inbox/InboxView.tsx` and `src/renderer/src/components/inbox/InboxButton.tsx` — retained cards, count, partial and error states, and the bottom-anchored Recent tasks block.
- `src/renderer/src/components/tasks/RecentTasks.tsx` and `src/renderer/src/components/tasks/TaskStatusIcon.tsx` — the task rows under the asks, and the status-to-icon mapping, which uses the same severity colours as `TaskStatusPill`.
- `src/renderer/src/hooks/useSync.ts` — `SYNCED_VIEWS` includes `inbox`, so opening the screen triggers a device-sync pull.
- `src/renderer/src/components/chat/AskUserQuestionBlock.tsx` and `src/renderer/src/components/chat/AnswerQuestionsModal.tsx` — guarded submission, preserved draft and modal error.
- `src/renderer/src/components/tasks/TaskView.tsx` — Inbox navigation in a separate slot from remote takeover. The header's **Back to the Inbox** appears only for a task with neither a parent nor a job, so it never adds to a header that already has **Parent task** or **Back to {job}** (those two are independent of each other).

## Integration Points

See [Tasks](tasks.md), [chat-owned tasks](chat_tasks.md), [adapter contract](remote_adapters.md), [Cinna asks](cinna_adapter.md) and [remote coordination](remote_sync.md). Inbox polling enumerates already-known blocked tasks; the separate active-profile task scheduler discovers and refreshes those task rows. The Inbox neither replaces that pull nor subscribes to the service's conversation stream.
