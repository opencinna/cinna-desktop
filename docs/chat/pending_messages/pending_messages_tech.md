# Pending Messages — Technical Details

## File Locations

### Shared

- `src/shared/ipcPayloads.ts` — `RunStartResult` (`started` with `runId`, `injected` with optional `saved`, `queued` with `queuedId`), `RunQueueItem` (`id`, `content`, `createdAt`), `RunQueueView` (`items`, `held`) and `RUN_QUEUE_CHANGED_CHANNEL`.
- `src/shared/runEvents.ts` — `RunUserMessageEvent` (`user_message { text }`), posted where a steered message landed.

### Main process

- `src/main/services/runQueueService.ts` — `createRunQueueService()` and the `runQueueService` singleton: the per-profile, per-chat queue, the steer-or-queue decision, drains and holds. Registers `chatRemoved` / `profileRemoved` through `installTaskRunnerHooks`.
- `src/main/services/runExecutionService.ts` — `RunHandle.steer(content)` and `RunHandle.agentId`; exported `answererOf(chat, payload)`, the routing rule `resolveAndRun` also uses, so queue-time and run-time answerers cannot differ.
- `src/main/agents/drivers/driver.ts` — `RunInput.registerSteer` and `SteerFn`.
- `src/main/agents/drivers/acp/acpDriver.ts` — the steering window inside `runTurn`, `advertisesSteering`, and the `onSent` hook on `promptWithCancelGrace`.
- `src/main/agents/drivers/acp/types.ts` — `ACP_STEER_METHOD` (`_session/steering`), `AcpSteerRequest`, `AcpSteerResponse`, `AcpConnection.steer`, `AcpProcessPool.held`.
- `src/main/agents/drivers/acp/acpConnection.ts` and `src/main/agents/drivers/acp/acpWebSocketConnection.ts` — `steer` as a JSON-RPC request on both transports.
- `src/main/agents/drivers/acp/acpProcessPool.ts` — `held(agentId)`.
- `src/main/agents/streamPartsAccumulator.ts` — `partCount()` and `breakContinuation()`.
- `src/main/services/a2aStreamingService.ts` — `TurnSteer`, `RunAgentTurnResult.steers`, and `saveTurnRows`, which persists a steered turn as alternating rows.
- `src/main/ipc/run.ipc.ts` — `run:start` through `runQueueService.submit`, the four queue channels, `ownedChatScope`, and the `run:queue-changed` broadcast.

### Preload

- `src/preload/index.ts` — `window.api.run.start` (now resolving `RunStartResult`), `queueList`, `queueTake`, `queueRemove`, `queueEdit`, `onQueueChanged`.

### Renderer

- `src/renderer/src/hooks/useRunQueue.ts` — `useRunQueue(chatId)`: TanStack Query on `['run-queue', chatId]`. `run:queue-changed` for that chat writes its `view` into the cache with `setQueryData`; `run:queue-list` is only the first read. Invalidating and refetching lost main's order: main announces a drain before starting its turn, a refetch could land after the drained message's saved row, and the message rendered twice — badged as queued, and as the row.
- `src/renderer/src/components/chat/QueuedMessages.tsx` — `useQueuedMessages(chatId, savedUserTexts, liveUserTexts)` (the transcript's view of the queue and of what just left it; `liveUserTexts` are the `user` stream blocks, saved only with the turn's rows) and `QueuedMessages` / `QueuedBubbleRow`.
- `src/renderer/src/components/chat/ChatInput.tsx` — the mid-turn send branch, held-queue restore, message history, queued-message edit mode and the single Stop/Send button.
- `src/renderer/src/hooks/useChatStream.ts` — `startRun` handles each `RunStartResult`; `useRunEventHandler` maps `user_message` to `appendUserMessage`.
- `src/renderer/src/stores/chat.store.ts` — `UserBlock` in `StreamBlock`, `appendUserMessage`, `sentVersion` / `noteSent`, `editingQueued` / `setEditingQueued`, `cancelledQueuedIds` / `noteQueuedCancelled` (the last `CANCELLED_QUEUED_KEPT`, 20, queue IDs cancelled from a bubble). `setActiveChatId` clears `editingQueued` and `sendError`.
- `src/renderer/src/components/chat/MessageStream.tsx` — renders a `user` stream block as a plain `MessageBubble`, mounts `QueuedMessages` inside the content box, suppresses re-animation through `handsOver`, and moves the pre-stream dots below a sent bubble (`holdsSent`).
- `src/renderer/src/hooks/useLiveRunWatch.ts` — holds the snapshot of a run that starts while the ended run's settlement read is in flight; see [Live Run Attachment and Replay](../messaging/live_runs.md).

## Database Schema

None. The queue is a `Map` in `runQueueService`, keyed by `JSON.stringify([profileUserId, chatId])`. A steered message becomes an ordinary `messages` user row with `addressed_agent_id` set to the answering agent; the assistant parts around it are ordinary assistant rows.

## IPC Channels

| Channel | Direction | Contract |
|---|---|---|
| `run:start` | invoke | `RunSendPayload` → `RunStartResult`. `started` with the new run ID; `injected` when the running turn took it (`saved: true` when main saved it as its own row after the turn's rows were built); `queued` with the queue item ID. Refusals reject: attachments while running, empty text while running, unowned chat, and every existing start refusal. |
| `run:queue-list` | invoke | `chatId` → `RunQueueView` for the active profile's owned chat. |
| `run:queue-take` | invoke | `chatId` → `string[]`, every queued text in order; the queue is empty afterwards, held or not. |
| `run:queue-remove` | invoke | `chatId, id` → `boolean`; false when the item is no longer queued. |
| `run:queue-edit` | invoke | `chatId, id, content` → `boolean`; false when the item is no longer queued; empty text rejects. |
| `run:queue-changed` | main → renderer | `{ chatId, view }` after every change. Sent only for chats the active profile owns and only while activated: another profile's chat IDs mean nothing to this window. |

Every queue channel resolves its scope through `ownedChatScope` (activation, active profile, `chatRepo.getOwned`).

## Services & Key Methods

### `runQueueService`

- `submit(scope, payload, options)` — the decision, in order:
  1. No active run in `activeRunsByChat`, or the chat is in `taskRunnersByChat` or `handingOffChats`, or `taskHandoffRepo.unresolvedForChat` finds a receipt → `runExecutionService.start` → `started`. Start refuses runner-owned chats itself.
  2. Unowned chat, attachments, or blank text → reject (`RUN_QUEUE_ATTACHMENTS_REFUSAL` for files).
  3. `answererOf` resolves the target. When it is an agent equal to `active.agentId` **and** nothing is queued for this chat, `active.steer(content)`: `injected` → `{ kind: 'injected' }`, `saved` → `{ kind: 'injected', saved: true }`, anything else falls through.
  4. Push a `QueuedEntry` carrying `addressedAgentId` (the resolved agent, else the payload's address), announce, then `settle` — the turn may have ended while the steer was being asked.
- `options` is a function of the payload that will actually be sent (`QueueStartOptions`): a drain sends merged text, and the Inbox resume in `run.ipc.ts` must see that text. It re-checks activation and throws when the active profile is no longer the one that queued, which holds the queue.
- `settle(key)` — no-op when held or empty. If a run is active, watch its handle. Otherwise splice the leading same-`addressedAgentId` run, **announce before starting** (a view that saw the user row land before learning the item left the queue would show the message twice), start, and watch the new handle when items remain. A throwing start unshifts the items and sets `held`.
- `ended(key, outcome)` — `HOLDING_STATES` (`canceled`, `failed`, `budget`) set `held`; anything else settles. `watch` subscribes once per handle through a `WeakSet`; `completed` never rejects and resolves after the handle has left `activeRunsByChat`.
- `list`, `take`, `remove`, `edit` — scoped by profile; `take` deletes the whole queue and clears `held`.
- `clear(profileUserId, chatId)` and `clearProfile(profileUserId)` — called from the task-runner hooks. `chatService` calls `chatRemoved` on trash and permanent delete; `jobService` calls it when a run's delete removed its chat; `authService` calls `profileRemoved`.
- `onChange(listener)` — `run.ipc.ts` is the one listener. A throwing listener is logged, never propagated into the queue.

### `RunHandle.steer` (`runExecutionService.ts`)

Returns `unavailable` unless the driver registered a `SteerFn` and the run is neither closed nor cancelled; `registerSteer` ignores an offer that arrives after either. Outcome `late` means the engine has the message but the turn's rows were built without it: the handle saves it with `messageRepo.saveUser` (`addressedAgentId` = the run's agent) and `touchChat`, and answers `saved`. If that save throws it answers `injected`, because the engine already has the text and queueing it would say it twice. Never rejects.

### The ACP steering window (`acpDriver.ts`)

- `openSteering` runs from `promptWithCancelGrace`'s `onSent`, once `session/prompt` is on the wire, and only when a connection, session, open turn, `registerSteer` and `advertisesSteering` (`initialize._meta.steering.supported === true`) are all present.
- `closeSteering` runs synchronously from `askAgentToStop` and at the start of `settleSteering`, and calls `registerSteer(null)`.
- `settleSteering` (the prompt's `finally`) waits for in-flight steering requests, bounded by `cancelGraceMs` (`ACP_CANCEL_GRACE_MS`, 3 s), then sets `steeringSettled`.
- `deliverSteer` sends `{ sessionId, prompt: [{ type: 'text', text }], _meta: { steering: { idleBehavior: 'promptRequired' } } }`:
  - `injected` before settling → push `TurnSteer { afterPart: accumulator.partCount(), text }`, `accumulator.breakContinuation()`, post `user_message`, answer `injected`.
  - `injected` after settling → answer `late`, keeping it out of `steers`.
  - `startedNewTurn` → `session/cancel`; `pool.retire(agentId)` while the turn has not settled or when `pool.held` is false; otherwise leave the process and warn. Answer `unavailable`.
  - A rejection, `promptRequired`, `failed` or any unknown outcome → `unavailable`.
- `finish` copies `ctx.steers` onto the result.

### Persistence of a steered turn

- `StreamPartsAccumulator.breakContinuation` sets a boundary: parts below it no longer absorb a same-kind fragment, except a `tool` part named by `toolId`, whose input can still fill in. Without it the text after the message merged into the text before it and persisted as one part.
- `a2aStreamingService` — `saveTurnRows(chatId, agentId, result)` saves `parts.slice(from, afterPart)` as an assistant row (its `content` from `sliceText`: answer kinds, else everything), then the user row, for each steer, then the remainder. An unsteered turn is one row, as before. The failure branch saves each steer as a user row before `saveError`.

## Renderer Components

### `ChatInput`

- **Mid-turn send.** With `chatId` and `isStreaming`, Enter sends `composer.submit(trimmed)` — text only — under the draft's `beginSend` lock and clears the text only when it is unchanged. Files and notes stay.
- **Held restore.** When `useRunQueue` reports `held` with items, `run:queue-take` once (`restoringQueueRef`), append the texts to the draft of the key that asked, joined by blank lines after trimmed trailing newlines, then resize, focus if nothing else has focus, and put the caret at the end.
- **History.** `historyEntries`: saved user rows with text, then `user` stream blocks when the store's active chat is this chat, then non-held queue items with their IDs. `handleKeyDown` calls `recallHistory(direction)` only when `caretOnEdgeLine` puts the caret on the first line (ArrowUp) or the last (ArrowDown); `recallHistory` acts only when the input is empty or still equals the recalled text, and past the newest it empties the input. `Recall` (`chatId`, `index`, `text`, `queuedId`) is component state, reset on `draftKey`, so navigating away drops edit mode and leaves the text as a draft. `activeRecall` reads it only when its `chatId` is this chat: the first render after a switch still holds the previous chat's recall.
- **Edit mode.** A recall with `queuedId` sets `editingId`; `setEditingQueued` mirrors it into the store for the bubble. Enter or Save calls `saveQueuedEdit` → `run:queue-edit`: `true` clears the text if unchanged, `false` sets `QUEUED_EDIT_TOO_LATE`, and both end edit mode.
- **The message leaving mid-edit.** An effect on `runQueue` ends edit mode once the item is gone, and sets `QUEUED_EDIT_TOO_LATE` unless `cancelledQueuedIds` has the ID. `useQueuedMessages.cancel` calls `noteQueuedCancelled` before `run:queue-remove`, so the queue update that follows reads as a cancel. A held queue does not reach this effect as a send: the held-restore effect clears the recall before its take.
- **Held restore with an edit.** Before `run:queue-take`, the held-restore effect reads the held items from the `['run-queue', chatId]` cache, finds the edited ID's index and clears the recall. The returned texts are matched by that index when their count equals the held items', otherwise by the original's text; the draft, trailing newlines trimmed, replaces that entry unless blank, and the joined texts replace the draft. When the edited message is not among them, the texts are appended as for any draft.
- **The notice.** `clearEditTooLate` clears `sendError` only while it is `QUEUED_EDIT_TOO_LATE`: after a successful mid-turn or ordinary send, a successful save, the edit-mode Esc, and an input change to empty.
- **The row.** One button, with Stop and Send under separate `key`s so React never turns the Send node the user just clicked into Stop. Stop (`title="Stop (Esc Esc)"`) renders while `showStop`: streaming, and either a new chat or, when not editing, a blank input or `readiness.refusal !== null`. It reads the refusal, not `blocksSend`: `blocksSend` is false for a `/run:<name>` catalog command, so keyed to it the button flipped between Stop and Send on each keystroke of `/run:build` mid-turn. Otherwise Send renders, with `--color-send-queued` while streaming and `--color-success` when idle. Mid-turn its title is "Send a follow-up · Esc Esc to stop" unless readiness supplies one. Send's click stamps `sendClickedAt`, focuses the textarea and calls `handleSend`; Stop ignores clicks within `STOP_CLICK_GRACE_MS` (500 ms) of that stamp. A Stop reached any other way — Enter, a drain, a switch to a running chat — has no grace. Esc Esc calls `handleCancel` directly, so the guard never delays it. Editing swaps the icon to `Check`, the label to Save and drops the readiness description.

### `useQueuedMessages` and `QueuedMessages`

- Main lists only what is still queued, so what left is read from the difference between two lists: an item gone from a queue that is not and was not held, and not cancelled here, was **sent**; items leaving together share `sentAs`, the merged text.
- Phases: `queued` (badge), `sent` (badge slid away, bubble standing in, `SENT_FALLBACK_MS` 15 s), `leaving` (user cancelled, `LEAVE_MS` 200 ms, zero under reduced motion). A failed `queueRemove` restores `queued` and sets the send error.
- A `leaving` row collapses through `grid-template-rows` `1fr` → `0fr`. The row takes back the transcript's `space-y-3` margin with `-mt-3` and gives it out again as `pt-3` inside the collapsing box, so the gap closes with the bubble instead of on unmount.
- Entering `sent`, an entry records `rowsBefore`: how many of `savedUserTexts` and `liveUserTexts` equal `sentAs`. It retires in the render where the count of `savedUserTexts` equal to `sentAs` exceeds `rowsBefore`, and `handsOver(content)` tells `MessageStream` to suppress that row's entry animation. Counting at send time rather than at queue time keeps out a same-text row saved in between, and a steered message the ended turn saves with its rows.
- State resets on `chatId`, because one `MessageStream` serves every chat. Bubbles of a held queue are not rendered.
- `BADGE_LABELS` render stacked in one grid cell with the inactive ones `invisible`, so the badge width is the longest label's. The [x] is a `h-5 w-5` chip with `bg-[var(--color-bg-secondary)]` at rest and `--color-bg-hover` under the pointer, so it adds no width when hovered.

### `useChatStream.startRun`

- `running` = cached `activeRunId`, or this chat streaming in the store. No `pendingUserMessage` is set when running; `noteSent()` is called for every send to the active chat.
- `started` with no pending bubble → set one now (the turn had already ended). `injected` / `queued` with a pending bubble → clear it. `queued` → invalidate `['run-queue', chatId]`. `injected` with `saved` → invalidate `['chat', chatId]` and `['chats']`.

## Configuration

No settings. Constants: `HOLDING_STATES` and `RUN_QUEUE_ATTACHMENTS_REFUSAL` in `runQueueService.ts`; `ACP_STEER_METHOD` in `acp/types.ts`; the steer settle bound is `ACP_CANCEL_GRACE_MS`; `SENT_FALLBACK_MS` and `LEAVE_MS` in `QueuedMessages.tsx`; `HELD_RUN_MAX_MS` in `useLiveRunWatch.ts`; `QUEUED_EDIT_TOO_LATE`, `STOP_CLICK_GRACE_MS` and the shared `DOUBLE_ESC_WINDOW_MS` in `ChatInput.tsx`; `CANCELLED_QUEUED_KEPT` in `chat.store.ts`.

## Security

- Every queue channel is activation-gated and ownership-checked; the queue key includes the profile, so one profile's queue is never listed, taken, edited or drained for another.
- A drain re-checks activation and the active profile inside `QueueStartOptions`; a switched profile holds the queue instead of sending it under another account.
- The broadcast carries only queue text for an owned chat of the active profile.
- Steering sends only the user's text to an agent the chat is already running; it adds no transport, credential or destination.

## Tests

- `src/main/services/runQueueService.test.ts` — start when idle, queue behind a turn that cannot steer, steer and its saved variant, never steering for another agent or past a queued message, per-agent drains, answerer resolved at queue time, holding on a refused drain, sending when the turn ended mid-steer, runner-owned refusal, files refused, ownership, take/remove/edit/clear and profile isolation.
- `src/main/agents/drivers/acp/acpDriver.test.ts` (`a mid-turn message (the steering extension)`) — injection order and split parts, no offer without the advertisement, closed after settle and on stop, `startedNewTurn` cancelled and retired, `late`, and the held/unheld retire branches. The fake agent gained a `steer` handler script and an `awaitSteer` step.
- `src/main/services/a2aStreamingService.test.ts` and `src/main/ipc/run.routing.test.ts` — persistence order and the IPC result.
- `src/renderer/src/components/chat/ChatInput.pendingQueue.test.tsx` — the running composer (Stop, blue Send, Stop again; a Stop click within the grace after a click on Send ignored, with focus back in the input; an immediate click on a Stop that appeared without a click on Send honoured), held restore, history (including the caret in a recalled multi-line message) and edit mode: the too-late notice and what clears it, a stop folding the edit into the held texts, a cancel from the bubble ending the edit silently, and no edit or notice carried into another chat.
- `src/renderer/src/components/chat/MessageStream.queue.test.tsx` — badge labels and the [x] chip, a cancel collapsing its gap, sent stand-in and merged hand-over, no retirement by a same-text saved or steered row, held queues hidden, re-pin on send, and a steered bubble splitting tool dots.
- `src/renderer/src/components/chat/MessageStream.drain.test.tsx` — the ended turn's output and the sent message stay on screen through a drain until their saved rows are read.
- `src/renderer/src/hooks/useRunQueue.test.tsx` — the pushed view applied in main's order without reading the queue again; another chat's view ignored.
- `src/renderer/src/hooks/useLiveRunWatch.test.tsx` — a run held until the ended run's saved read lands, and applied at once when that read fails.
- `src/renderer/src/hooks/useChatStream.commands.test.tsx` and `useChatStream.events.test.tsx` — result handling and `user_message`.

These are unit and component tests over fakes. A steer against a real Claude Code or Codex CLI is not exercised by any test here; see [the ACP contract](../../agents/local_agents/acp_contract.md#the-steering-extension).
