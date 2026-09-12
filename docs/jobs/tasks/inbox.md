# The Inbox

## Purpose

The Inbox is one list of open questions and permissions belonging to tasks, answerable without opening their chats. A live local driver, a durable A2A continuation, a coordinator runner gate and a bound remote service keep their own answer mechanisms; the desktop presents them through the same input-request components.

## Sources and Addresses

- Local entries come from open `task_input_requests` rows scoped through their task. A driver-owned `reply` id addresses the parked driver; the in-memory registry is consulted when answering, never to construct the list. A `next_message` row instead records a durable continuation, visible only while its task is blocked/in progress and belongs to this desktop device.
- Next-message addresses start with `next-message:` and encode chat, agent, main turn and protocol request ids. Child invocation identity is part of the turn key. Duplicate frames deduplicate; repeated questions in later turns get new cards. They survive normal turn completion and restart, unlike live reply addresses.
- Runner gates use `deliveryOwner: runner`, a null agent and a reply resume kind. Their IDs include runtime attempt, main turn and tool call; they survive boot and ordinary turn cleanup. Main commits the gate and checkpoint before publishing the ask, and commits its answer plus continuation checkpoint before enqueueing. Checkpoint pendingRequestIds retains sibling addresses across sequential root turns. Both Inbox and transcript answer IPC route through the runner before live-driver delivery. Answers during turn cleanup refuse retryably; the Inbox stays open. See [autonomous execution](autonomous_tasks_tech.md).
- Remote entries come from locally stored, non-deleted blocked tasks with a binding whose adapter supports asks. `remoteInboxService` checks availability and fetches `listOpenAsks`; it does not require the task's executor to be remote. This is a live enumeration, not a persisted second registry.
- A remote request address is `remote-ask:` followed by the JSON array of local task id, adapter id, remote task id and ask id. The local task and binding prevent identical service ask ids from colliding or a stale card answering a newly linked task.
- Reads recheck the binding after the network returns. Answers perform a profile-scoped lookup, refuse deleted or rebound tasks, and recheck after availability before invoking the adapter. No credentials or opaque binding state travel in the entry.

## User Flow

1. Open the Inbox from the fixed-width sidebar entry, or from a blocked task with a known ask. Local and remote requests render through the same permission/question components.
2. Enter an answer. While it is sending, the question modal disables editing, sending again, closing, Escape and backdrop dismissal.
3. On success, the modal closes and the card records the outcome. A stale/settled refusal also ends the card; malformed or unavailable delivery keeps the controls and draft for retry.
4. A next-message question starts a new turn in main after acceptance, leaving the Inbox open. Authentication asks use the same modal with the agent’s message followed by **Reply when you are ready to continue.** A textless question becomes **What should the agent do next?**; textless authentication uses the sign-in fallback.
5. An acted-on card stays mounted until the user leaves the Inbox. Newly arriving cards append after existing cards so a poll cannot move a decision button under the pointer.

## Polling, Failures and Concurrency

`inboxService.list` awaits remote enumeration, then reads current local rows and sorts the merged array newest first. `useInboxList` supplies both the view and badge from one five-second query with one retry, subject to the window visibility gate.

**A failed read rejects the complete list.** TanStack retains its previous data, so the error state must take precedence over a cached count. The sidebar shows an exclamation mark, the Inbox omits its waiting-count label and names the failed refresh, and task actions use `isSuccess` before claiming no asks remain. A cold failure shows a retry state instead of an empty Inbox. The deliberate limitation is that a remote outage also prevents new local entries from reaching that complete array until a successful read; partial results require a separate completeness field, not a successful local-only array.

**A UI deadline does not release the network lock.** Remote reads share one in-flight operation per profile. The UI stops waiting after ten seconds, but retries join the same operation until all fan-out branches settle. `Promise.allSettled` matters: rejecting at the first failed task previously released the lock while slower siblings still ran, allowing every retry to duplicate their network work. Cinna's JSON transport aborts a fetch, including a stalled body, after thirty seconds; a multi-request enumeration can last longer than one transport call.

**One remote ask has one in-flight answer per profile.** Identical resolutions join the pending operation. A different resolution receives a retryable refusal; otherwise two windows submitting Yes and No could both claim success although only Yes was sent. An answer-facing ten-second deadline returns an unavailable/confirmation-pending result while preserving that same raw operation. A retry during the pending interval does not resend it. The service does not persist a durable answer receipt after the operation settles; the adapter rereads the service's open asks on a subsequent attempt.

## Answer Outcomes

- `ok: true` confirms a live/remote answer was delivered, or a next-message/runner answer was accepted and persisted. It does not promise the continued turn has finished. Remote task status stays unchanged because another session may still be waiting.
- `no_longer_waiting`, `already_answered`, `not_here` and `not_owned` settle the rendered card.
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

Inbox view / sidebar / task page → `useInboxList` → `inbox:list` → `inboxService.list` → local request repository and `remoteInboxService.list` → adapter.

Shared request block → `useAnswerAsk` → `inbox:answer` → parsed resolution → persisted local address / driver, next-message address / `runExecutionService`, or `remoteInboxService.answer` / adapter.

- `src/shared/inbox.ts` — shared entry, answer payload and outcome types.
- `src/main/services/inboxService.ts` — local bookkeeping, `resumeChat`, scoped continuation guards and merged list/answer dispatch.
- `src/main/services/runExecutionService.ts` — explicit profile/settings scopes, acceptance and completion handles, single-chat admission, optional renderer forwarding.
- `src/main/db/messages.ts` and `src/main/services/messageRoutingService.ts` — user-message transaction and acceptance callback.
- `src/main/services/remoteInboxService.ts` — remote address validation, ownership, fan-out and in-flight maps.
- `src/main/services/cinnaApiService.ts` — authenticated JSON transport and thirty-second abort.
- `src/main/ipc/task.ipc.ts` and `src/preload/index.ts` — activated, profile-scoped IPC and typed bridge.
- `src/renderer/src/hooks/useInbox.ts` — shared query and answer invalidation.
- `src/renderer/src/components/inbox/InboxView.tsx` and `src/renderer/src/components/inbox/InboxButton.tsx` — retained cards, count and error state.
- `src/renderer/src/components/chat/AskUserQuestionBlock.tsx` and `src/renderer/src/components/chat/AnswerQuestionsModal.tsx` — guarded submission, preserved draft and modal error.
- `src/renderer/src/components/tasks/TaskView.tsx` — Inbox navigation in a separate slot from remote takeover.

## Integration Points

See [Tasks](tasks.md), [chat-owned tasks](chat_tasks.md), [adapter contract](remote_adapters.md), [Cinna asks](cinna_adapter.md) and [remote coordination](remote_sync.md). Inbox polling enumerates already-known blocked tasks; the separate active-profile task scheduler discovers and refreshes those task rows. The Inbox neither replaces that pull nor subscribes to the service's conversation stream.
