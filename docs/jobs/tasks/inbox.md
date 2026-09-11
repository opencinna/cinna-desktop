# The Inbox

## Purpose

The Inbox is one list of open questions and permissions belonging to tasks, answerable without opening their chats. The local driver and the remote service keep their own reply mechanisms; the desktop presents both through the same input-request components.

## Sources and Addresses

- Local entries come from open `task_input_requests` rows scoped through their task. The stored request id addresses the parked driver; the in-memory registry is consulted when answering, never to construct the list. A `next_message` ask has no row because the next chat message is its answer.
- Remote entries come from locally stored, non-deleted blocked tasks with a binding whose adapter supports asks. `remoteInboxService` checks availability and fetches `listOpenAsks`; it does not require the task's executor to be remote. This is a live enumeration, not a persisted second registry.
- A remote request address is `remote-ask:` followed by the JSON array of local task id, adapter id, remote task id and ask id. The local task and binding prevent identical service ask ids from colliding or a stale card answering a newly linked task.
- Reads recheck the binding after the network returns. Answers perform a profile-scoped lookup, refuse deleted or rebound tasks, and recheck after availability before invoking the adapter. No credentials or opaque binding state travel in the entry.

## User Flow

1. Open the Inbox from the fixed-width sidebar entry, or from a blocked task with a known ask. Local and remote requests render through the same permission/question components.
2. Enter an answer. While it is sending, the question modal disables editing, sending again, closing, Escape and backdrop dismissal.
3. On success, the modal closes and the card records the outcome. A stale/settled refusal also ends the card; malformed or unavailable delivery keeps the controls and draft for retry.
4. An acted-on card stays mounted until the user leaves the Inbox. Newly arriving cards append after existing cards so a poll cannot move a decision button under the pointer.

## Polling, Failures and Concurrency

`inboxService.list` awaits remote enumeration, then reads current local rows and sorts the merged array newest first. `useInboxList` supplies both the view and badge from one five-second query with one retry, subject to the window visibility gate.

**A failed read rejects the complete list.** TanStack retains its previous data, so the error state must take precedence over a cached count. The sidebar shows an exclamation mark, the Inbox omits its waiting-count label and names the failed refresh, and task actions use `isSuccess` before claiming no asks remain. A cold failure shows a retry state instead of an empty Inbox. The deliberate limitation is that a remote outage also prevents new local entries from reaching that complete array until a successful read; partial results require a separate completeness field, not a successful local-only array.

**A UI deadline does not release the network lock.** Remote reads share one in-flight operation per profile. The UI stops waiting after ten seconds, but retries join the same operation until all fan-out branches settle. `Promise.allSettled` matters: rejecting at the first failed task previously released the lock while slower siblings still ran, allowing every retry to duplicate their network work. Cinna's JSON transport aborts a fetch, including a stalled body, after thirty seconds; a multi-request enumeration can last longer than one transport call.

**One ask has one in-flight answer per profile.** Identical resolutions join the pending operation. A different resolution receives a retryable refusal; otherwise two windows submitting Yes and No could both claim success although only Yes was sent. An answer-facing ten-second deadline returns an unavailable/confirmation-pending result while preserving that same raw operation. A retry during the pending interval does not resend it. The service does not persist a durable answer receipt after the operation settles; the adapter rereads the service's open asks on a subsequent attempt.

## Answer Outcomes

- `ok: true` confirms delivery. The service leaves remote task status unchanged because another session may still be waiting.
- `no_longer_waiting`, `already_answered`, `not_here` and `not_owned` settle the rendered card.
- `malformed` keeps it retryable: the answer or request address was invalid.
- `unavailable` keeps it retryable: the service could not accept/confirm delivery, a deadline elapsed, or a different answer is already being sent. The reason travels as typed result data rather than a thrown IPC error code.

## Architecture and Files

Inbox view / sidebar / task page → `useInboxList` → `inbox:list` → `inboxService.list` → local request repository and `remoteInboxService.list` → adapter.

Shared request block → `useAnswerAsk` → `inbox:answer` → parsed resolution → persisted local address / driver, or `remoteInboxService.answer` / adapter.

- `src/shared/inbox.ts` — shared entry, answer payload and outcome types.
- `src/main/services/inboxService.ts` — local bookkeeping and merged list/answer dispatch.
- `src/main/services/remoteInboxService.ts` — remote address validation, ownership, fan-out and in-flight maps.
- `src/main/services/cinnaApiService.ts` — authenticated JSON transport and thirty-second abort.
- `src/main/ipc/task.ipc.ts` and `src/preload/index.ts` — activated, profile-scoped IPC and typed bridge.
- `src/renderer/src/hooks/useInbox.ts` — shared query and answer invalidation.
- `src/renderer/src/components/inbox/InboxView.tsx` and `src/renderer/src/components/inbox/InboxButton.tsx` — retained cards, count and error state.
- `src/renderer/src/components/chat/AskUserQuestionBlock.tsx` and `src/renderer/src/components/chat/AnswerQuestionsModal.tsx` — guarded submission, preserved draft and modal error.
- `src/renderer/src/components/tasks/TaskView.tsx` — Inbox navigation in a separate slot from remote takeover.

## Integration Points

See [Tasks](tasks.md), [chat-owned tasks](chat_tasks.md), [adapter contract](remote_adapters.md), [Cinna asks](cinna_adapter.md) and [remote coordination](remote_sync.md). Inbox polling enumerates already-known blocked tasks; the separate active-profile task scheduler discovers and refreshes those task rows. The Inbox neither replaces that pull nor subscribes to the service's conversation stream.
