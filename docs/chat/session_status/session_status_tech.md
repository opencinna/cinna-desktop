# Sidebar Session Status: Technical Details

## File Locations

- Shared contract: `src/shared/chatRunResult.ts` defines ChatRunResult and ChatRunResultStatus.
- Database: `src/main/db/chatRunResults.ts`; table in `src/main/db/schema.ts`; migration in `src/main/db/migrations/chat-run-results.ts`, registered by `src/main/db/migrations/index.ts` after chat creation.
- Main: `src/main/services/chatService.ts`, `src/main/services/runExecutionService.ts`, `src/main/services/runExecutionState.ts`, `src/main/services/taskRunnerState.ts`, `src/main/services/taskRunnerService.ts` and `src/main/services/scriptRuntimeService.ts`.
- IPC and preload: `src/main/ipc/chat.ipc.ts`, existing cancellation in `src/main/ipc/run.ipc.ts`, ChatData and window.api methods in `src/preload/index.ts`; active-delete refusal code in `src/main/errors.ts`.
- Renderer: `src/renderer/src/components/chat/ChatItem.tsx`, `src/renderer/src/components/chat/ChatList.tsx`, `src/renderer/src/components/layout/MainArea.tsx`, `src/renderer/src/hooks/useChat.ts`, `src/renderer/src/hooks/useLiveRunWatch.ts` and `src/renderer/src/hooks/useReadChatResult.ts`. Selected streaming state remains in `src/renderer/src/stores/chat.store.ts`.

## Database Schema

`chat_run_results` holds one row per chat. chat_id is its primary key and references chats.id with ON DELETE CASCADE; run_id identifies the result, status is completed/needs_input/failed/canceled, and unread is a boolean. The idempotent migration creates an empty table on upgrade, without inferring unread state from old messages. Replaying migrations preserves saved rows.

ChatRunResult exposes runId, status and unread. **runId is an acknowledgement identity, not always a transport turn ID.** Standalone turns use their executor handle ID; controller transitions generate a fresh ID for each published outcome, including successive waits within one attempt. This prevents an acknowledgement for an earlier gate from clearing completion or a later question. ActiveRunId independently identifies an active turn or working reservation.

The repository's record upserts the latest result and sets unread false for canceled, true otherwise. get and list join chats to scope reads by owner. markRead updates only the matching chat_id and run_id after service ownership validation. Soft deletion retains the result with its chat; permanent deletion cascades it. Controller cleanup skips result writes for an already removed chat so the new foreign key cannot roll back task cancellation or question expiry. This table is device-local and contains no message payloads or credentials.

## IPC Channels

| Channel / preload method | Contract |
| --- | --- |
| chat:list / chat.list() | Listed ChatData rows include activeRunId and lastRunResult, each nullable. |
| chat:get / chat.get(chatId) | Owned chat and saved messages, with activeRunId and lastRunResult read in the same synchronous main call; null if unavailable. |
| chat:mark-result-read / chat.markResultRead(chatId, runId) | Promise of void; acknowledges only the matching current result after checking chat ownership. An obsolete ID changes nothing. |
| run:cancel-chat / run.cancelChat(chatId) | Existing owned cancellation; routes to the controller reservation before an individual active handle. Acknowledges the request before asynchronous cleanup necessarily ends. |
| chat:delete / chat.delete(chatId) | Ordinary soft deletion; throws ChatError with run_active and “Interrupt the session before deleting it.” while an active turn or working reservation exists. |

Activation and profile resolution stay in main's thin IPC handlers. `chat:get` does not mark anything read: background queries, cached details and selected-chat subscriptions can read it without displaying the result.

## Services & Key Methods

- `chatService.list/get` combines repository data with activeRunsByChat and taskRunnersByChat. An active handle wins; otherwise only a reservation with working=true supplies activity. Waiting/interrupted reservations can still prevent unrelated sends but do not supply a spinner. `chatService.markResultRead` verifies ownership before calling the repository.
- `runExecutionService` records a standalone result after deriving open-request uncertainty and before live hub closure. User cancellation wins even if a driver subsequently reports completion. Otherwise budget or inputRequestReadError maps to failed; completed with durable requests maps to needs_input. A refused preserveOnRefusal answer leaves the previous result intact. Persistence failures are logged without failing already saved output.
- Internal runnerTaskId suppresses leaf result writes as well as ordinary task/job finalization. A canceled leaf can be a controller-enforced timeout, and a successful leaf can be followed by another owner turn, so neither may overwrite the controller's result.
- `taskRunnerService` publishes through finish, wait and interrupted alongside its task/checkpoint writes. Completion maps to completed, error to failed, cancellation to canceled; durable waits and recoverable interruption map to needs_input. Limits are controller errors even when the active transport ends canceled. Generic task-status changes also update the result; metadata edits after an already projected interruption/status keep the prior identity and read state.
- `scriptRuntimeService` publishes root outcomes and relevant child outcomes for completed agent steps, human gates/answers, waits, interruption and termination. The root needs its own projection because it never runs a leaf turn. Cleanup follows task/chat/device bindings, reflects externally changed child terminal statuses and preserves already completed checkpoint siblings. A stopped leaf cannot overwrite this projection later.
- Repeated interruption cleanup preserves the first interruption identity. A successful read during shutdown settlement must not be undone when the canceled leaf finally closes. Real later transitions still generate fresh identities.

## Renderer Components

`useChatList` polls every second under the existing query lifecycle, including for sessions other than the selected chat. `useLiveRunWatch` also patches the matching list row on an active snapshot before navigation can clear selected streaming state. It cancels older list reads first, because a late idle response previously overwrote the newer activity. Background completion is learned from list refreshes; the watch remains selected-chat-only. `ChatList` uses the same signal — a row that was running in the previous list result and is not in this one — to refresh the unpolled [chat row summaries](../chat_row_summary/chat_row_summary_tech.md#data), which no invalidation reaches for a background turn.

`ChatItem` considers its main activeRunId or its own selected isStreaming flag running. Its single trailing button shows a 12 px animated Loader2 spinner, replaced by Square on row hover or focus-within. While interruption is pending it stays a disabled spinner named **Interrupting session…**. Otherwise its names are **Interrupt session** or **Delete session**. `useInterruptChat` owns cancellation and chat/list invalidation; the component stops click propagation, so interrupting another row does not select it or reset the visible draft. Main's running guard remains authoritative after a stale list response.

Stopped unread rows use CircleCheck/success, CircleHelp/warning or CircleAlert/danger with CSS variable colors. Their image names are **Completed — unread results**, **Needs input — unread results** and **Failed — unread results**. Hover/focus replaces the image with Trash2; the button remains named Delete session and its title combines outcome and action. The title is withheld while the row's [summary tooltip](../chat_row_summary/chat_row_summary.md) is open — the button lies on the pointer's way to it, and two tooltips at once say two things; the accessible name does not depend on the title. Canceled or read results have no result image. Interrupt/delete errors use the existing IPC unwrapping and render beside the row.

`ChatItem` also consumes `ui.store.revealChatId`: when it names the row's chat, an effect calls `scrollIntoView({ block: 'nearest' })` on the row, clears the request and sets a local `revealed` flag that adds `ring-1 ring-inset ring-[var(--color-accent)]` and a 10% accent fill with `data-revealed`, for `REVEAL_MS = 1_800`. The task page's `TaskActionsMenu` sets the request; `useShowChatInList`'s hook-level `onError` clears it when the move fails. It parallels `revealNoteId` for the Notes list.

`MainArea` mounts useReadChatResult once and passes a chat ID only for activeView=chat. The hook tracks document focus and visibility, reads the shared chat list and detail queries, and requires all of: no list activity, unread result, successful detail, matching result ID, visible conversation and foreground document. Its effect sends an acknowledgement only then. Successful acknowledgement cancels older list reads and patches unread=false only for the same result and current profile. Rejection leaves the result unread; reopening or regaining focus can retry. It does not acknowledge on watch closure, since final saved output or an error may still be loading, particularly after replay overflow.

## Configuration

No new setting, environment variable, notification permission or sync collection. List refresh uses a 1,000 ms interval; live attachment keeps its existing replay limits and detail-poll fallback. Restarts retain result rows but do not restore process-local active handles or replay; controller recovery follows its own checkpoint rules. A remote agent turn recovered after a relaunch is a new handle (`runExecutionService.adopt`), so its chat shows the spinner and interrupt action again until the recovery settles it. See [Interrupted Turn Recovery](../../agents/turn_recovery/turn_recovery.md).

## Security

List/detail results are scoped through chat ownership. Mark-read requires activation and owned-chat validation; cancellation retains its existing ownership check. The renderer cannot choose controller completion ownership through a send payload. Result status contains no secrets, message text or remote reply address.

## Verification

- `src/renderer/src/components/chat/ChatItem.test.tsx` covers background interruption without selection, pending/error controls, delete after stop and all result icons.
- `src/renderer/src/components/chat/ChatItem.reveal.test.tsx` covers the reveal: it scrolls and lights the row once without opening the chat, waits for a row that appears later, and leaves other rows alone.
- `src/renderer/src/hooks/useChat.watched.test.tsx` and `src/renderer/src/hooks/useLiveRunWatch.test.tsx` cover main activity refresh, selection changes with an older idle list request, and replay-unavailable closure without premature acknowledgement.
- `src/renderer/src/hooks/useReadChatResult.test.tsx` covers foreground/background visibility, matching detail identity, pending/failed/stale reads and delayed acknowledgements against newer outcomes.
- `src/main/services/chatService.setRouter.test.ts` covers owned activity/results, delete guards, stale run-ID reads, migration replay and permanent deletion. `src/main/ipc/run.routing.test.ts` covers standalone statuses, user cancellation and suppression of runner-owned leaf writes.
- `src/main/services/taskRunnerService.test.ts` and `src/main/services/scriptRuntimeService.test.ts` cover limits, gates, fresh identities, external cancellation, completed siblings, interruption idempotency and cleanup after permanent chat deletion.
- `e2e/specs/chat-session-status.spec.ts` has seven real Electron/loopback A2A scenarios: background interrupt then delete; completed/needs-input/failed background results retained across restart then acknowledged after opening; and those three foreground endings remaining read after switching away. It checks actual saved transcripts, cancellation wire traffic, stream abort and the other conversation's draft. Results and run handlers are not fabricated.
- Spinner regressions require computed opacity and animation-name assertions: Playwright's toBeVisible accepts opacity zero. Loader2 renders as svg.lucide-loader-circle and is aria-hidden; target the named action and inspect its icon. `e2e/specs/llm-stop.spec.ts` uses exact accessible **Stop**/**Send** names, because Square now also appears in sidebar interrupt actions. See [E2E writing rules](../../development/e2e/e2e_llm.md).
