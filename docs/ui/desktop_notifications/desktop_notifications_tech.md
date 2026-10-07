# Desktop Notifications: Technical Details

## File Locations

**Core (Hub core, no Electron)**
- `src/main/services/turnNotices.ts` — `TurnRecordSource`, `TurnSettledNotice`, `TurnResultRead`, `shouldNotify()`, `turnNoticeFor()`, and the `turnNotices` listener seam (`onSettled`, `onResultRead`, `settled`, `resultRead`).
- `src/main/services/turnRecord.ts:recordTurnResult()` — takes `source` and calls `turnNotices.settled` after both of its writes.
- Callers that name the source: `runExecutionService.ts` (`live`), `followUpTurnService.ts` (`follow-up`), `interruptedTurnService.ts:finalizeInterrupted()` (`recovery`) — which is also how `remoteTurnRecoveryService` settles a reattached remote turn, so its real ending is `recovery` too.
- Read signals: `chatService.ts:markResultRead()` and `jobService.ts` (the job page's mark-read) call `turnNotices.resultRead` only when `chatRunResultRepo.markRead` returns true.
- Chat origin writers: `chatService.ts:create()` (`user`), `taskExecutionService.ts:start()` (`task`, for a chat it creates), `delegationService.ts:createGateChat()` (`delegation`), `handoverService.ts` gate chat (`handover`), `db/jobs.ts` job-run chat and `scriptRuntimeService.ts` step chats (`job`).
- Task flag writers: `taskExecutionService.ts:start()` (`options.startedBy`), `ipc/task.ipc.ts` `task:start`, `ipc/taskDispatch.ipc.ts` `taskDispatch:run-next`, `taskDispatchService.ts` (`Flight.startedByUser`, `launch(…, startedByUser)`, `runNext(…, { startedBy })`, the `start` dep's `startedBy`).
- `src/main/auth/activation.ts:onProfileClosing()` — profile-closing listeners, fired by `activate()` and `deactivate()`.

**Desktop host**
- `src/main/host/desktop/notificationService.ts` — `notificationService.install()`, `takePendingOpenChat()`, `resetForTests()`; `notificationContent()`.
- `src/main/index.ts:startup()` — `notificationService.install()` right after `initializeHubCore()`, before IPC registration.
- `src/main/ipc/notifications.ipc.ts` — `registerNotificationHandlers()`, registered from `src/main/ipc/index.ts`.
- `src/main/window/focus.ts` — `BACKGROUND_WINDOW`, `ensureMainWindow()`, `focusMainWindow()`, reused for the click.

**Shared / preload / renderer**
- `src/shared/chatOrigin.ts` — `CHAT_ORIGINS`, `ChatOrigin`.
- `src/shared/desktopNotifications.ts` — `NOTIFICATION_OPEN_CHAT_CHANNEL`, `NotificationOpenChat`.
- `src/shared/appSettings.ts` — `desktopNotifications`; default in `src/main/db/appSettings.ts`.
- `src/preload/index.ts` — `window.api.notifications.takePendingOpenChat()`, `onOpenChat(handler)`.
- `src/renderer/src/hooks/useNotificationOpenChat.ts` — mounted once in `App.tsx`'s `Shell` (main window only).
- `src/renderer/src/components/settings/FeaturesSettingsSection.tsx` — the **Desktop notifications** row (`feature-desktop-notifications`).

## Database Schema

- **`chats.origin`** — `TEXT NOT NULL DEFAULT 'user'`, one of `user`, `task`, `delegation`, `handover`, `job` (`src/shared/chatOrigin.ts`). Written once by `chatRepo.create` (`init.origin`, `user` when omitted — tests and the hub spike) or by the job-run insert in `db/jobs.ts`; nothing updates it. Not synced (chats are not a sync collection).
  - Added by `migrateChatOrigin` (`src/main/db/migrations/chat-origin.ts`), registered in `runAllMigrations` after `migrateRetireChatMirror` and before `migrateUserIdColumns`, because its backfill reads `tasks`, `delegations`, `handovers` and `messages`. The `ALTER` and the backfill share one transaction inside `if (!hasColumn(…, 'origin'))`, so a replay never rewrites a value a later build recorded.
  - Backfill, most specific first, each step only over rows still at `user`: handover gate chats → `handover`; delegation gate chats → `delegation`; `hidden_from_list = 1` or a non-null `originating_job_run_id` → `job`; a chat bound by `tasks.chat_id` → `task` **unless** it has a message strictly older than the task (Unix seconds) — the Inbox attached that task to a hand-opened chat on its first ask, and it stays `user`. Provenance columns cannot make that call: the queue clears `dispatch_agent_id` once it settles a run.
  - Because the job step runs before the task step, any hidden chat with a task (a script step's) reads `job`; a hidden task chat of another kind would read `job` too. Neither notifies unless its task is started by hand, which the flag covers independently of origin.
- **`tasks.started_by_user`** — `INTEGER NOT NULL DEFAULT 0`, added by `migrateTasks` (`src/main/db/migrations/tasks.ts`); every existing row reads false, so a backfilled task chat notifies only once the user starts that task again. `taskRepo.setStartedByUser(userId, taskId, value)` is bookkeeping like `setDispatchAgent`: it leaves `updatedAt` alone, so the task list does not reorder. Device-local: absent from `taskMapper` in `src/main/sync/collections.ts` and from `TaskDto`.
  - Written inside the run's acceptance in `taskExecutionService.start` (next to `taskService.beginDesktopChat`), as `options.startedBy === 'user'`. So every start through that function sets or clears it: `task:start` and a Run next that starts a task set it; the queue's own `launch(…, 'queue')`, an outside-content gate's **Approve and run** (`runNext` without `startedBy`), a delegation and a handover clear it. Turns that continue a run do not go through `start` and leave it: an Inbox answer, a follow-up, and a dispatcher `resume` flight — including a Run next that sends a stored answer instead of starting a task.
- **`chat_run_results`** — unchanged; `chatRunResultRepo.markRead` now returns whether a row for that `(chat_id, run_id)` was updated, i.e. whether `runId` is the chat's current result (already read or not). See [Sidebar Session Status](../../chat/session_status/session_status_tech.md).

## IPC Channels

| Channel | Direction | Contract |
|---|---|---|
| `notifications:take-pending-open-chat` | renderer → main (invoke) | → `NotificationOpenChat \| null`. The chat the last click asked for, returned once and cleared; null when none, or when the active profile can no longer open it. No activation check of its own: `openable()` checks `userActivation.isActivated()` and visibility. |
| `notification:open-chat` (`NOTIFICATION_OPEN_CHAT_CHANNEL`) | main → main window (push) | `{ chatId }`, sent after the window is raised. |

## Services & Key Methods

### Core: `turnNotices.ts`

- `shouldNotify({ status, origin, taskStartedByUser })` — the rule without the database: status in `completed`/`needs_input`/`failed`, and `origin === 'user' || taskStartedByUser`.
- `turnNoticeFor(chatId, runId, status)` — reads in the active profile's scope: `visibleChat(getProfileScopeUserId(), chatId)` (absent or `deletedAt` → `notify: false`), `taskRepo.getByChatId` for `startedByUser`, the agent's name through the settings scope then the profile scope. Returns title and agent name, never message text.
- `turnNotices.settled(chatId, runId, status, source)` — returns at once for `recovery` or with no settled listener installed (the plain-Node hub, unit tests: nothing is read). A read failure is logged and swallowed; each listener is called in its own try/catch.
- `turnNotices.resultRead(chatId, runId)` — fired by callers only when `markRead` matched the current result.
- `recordTurnResult` calls `settled` only if the sidebar write succeeded, and after `reportStandaloneTurn`: a notice for a result the sidebar does not have would point the user at nothing.
- **Not every result passes through here.** `taskRunnerService`, `scriptRuntimeService`, `coordinatorJobService` and `jobExecution/scheduled.ts` write `chatRunResultRepo.record` directly, and `runExecutionService` skips `recordTurnResult` for `runnerTaskId` and nested turns. None of those raise a notice.

### Core: `userActivation.onProfileClosing(listener)`

Fired synchronously at the start of every `activate()` (login, profile switch and logout all enter through it, including the first activation at boot) and of `deactivate()`, right after the gate closes. A throwing listener is logged and skipped. Returns an unsubscribe.

### Desktop: `notificationService.ts`

- `install()` — idempotent; subscribes `turnNotices.onSettled → show`, `turnNotices.onResultRead → read`, `userActivation.onProfileClosing → closeAll`.
- `show(notice)` — in order: `notice.notify`; `appSettingsRepo.get('desktopNotifications')`; `userActivation.isActivated()`; `BrowserWindow.getFocusedWindow() === null` (main window and tray popover alike); not in `shownRuns`. Then it remembers the run (`SHOWN_RUNS_LIMIT = 200`, oldest dropped) and, under `BACKGROUND_WINDOW`, logs `desktop notification suppressed under the test harness` with chat, run, status, title and body and returns. Otherwise, if `Notification.isSupported()`, closes the chat's previous notification, creates one from `notificationContent`, keeps it in `live` (by chat id) so its click handler is not garbage-collected, and logs `desktop notification shown`.
- `notificationContent(notice)` — title is the chat title trimmed, else `Cinna`; body is `<agent> · <Finished|Needs your input|Failed>`, or the outcome alone.
- Click → `forget`, then `openChat(chatId)`: if `openable()` fails (not activated, not visible, trashed) it clears the pending chat and only `focusMainWindow()`. Otherwise it sets `pendingOpenChat`, focuses, `await ensureMainWindow()` (which recreates a closed window), focuses again and pushes `notification:open-chat`.
- `pendingOpenChat` is **not** cleared by the push. A click that recreates the window, or lands while the renderer loads, reloads or still shows the startup gate (`ready-to-show` fires before the shell mounts), is pushed to nobody; the renderer takes it on mount and after every push. Latest click wins; opening a chat twice is harmless.
- `read(event)` → `closeFor(chatId)`: whatever is shown for the chat is that run or an older one, stale either way.
- `closeAll()` — closes every live notification and clears `pendingOpenChat`.

### Renderer: `useNotificationOpenChat`

Subscribes to `onOpenChat`; on a push opens the chat and then takes the pending chat (so a delivered click does not reopen at the next mount); on mount takes it once. Opening clears the console (`setLogsOpen(false)`) and the Agent Status overlay and detail, sets the active chat and `activeView = 'chat'`. A taken chat is opened even if the effect was torn down meanwhile (StrictMode remount), since taking it cleared it for everyone else.

## Renderer Components

- `FeaturesSettingsSection` — a `SettingsToggleRow` in the Interface list, directly after **Enable Tray Icon**, before **Show sections in Agents sidebar**. Checked unless the setting is `false` (absent reads as on). Description behind the (?) tip; `title` names the state. Written through `useAppSettings`' `setSetting` like the other service-backed switches.

## Configuration

- **`desktopNotifications`** (app setting, installation-wide, default `true`). Main reads it in `show()` when a turn settles; there is no main-side reaction on write and no restart.
- **`CINNA_BACKGROUND_WINDOW=1`** — set by the E2E fixture and the live-backend harness. Notices are logged, never shown, because those windows are never focused. See [End-to-End Tests](../../development/e2e/e2e.md).
- The OS permission is the platform's: macOS prompts on the first notification; a development build appears as Electron.

## Security

- No message text in a notice or a notification; title, agent name and outcome only, because notifications reach the lock screen and screen captures.
- Scope is re-checked at every step: `turnNoticeFor` against the active profile when the turn ends, `openable()` at click and at `take-pending-open-chat`, and `closeAll` on every profile change, so a notification can neither name nor open another profile's chat.
- `started_by_user` and `chats.origin` never leave the device.

## Verification

- `src/main/services/turnNotices.test.ts` — `shouldNotify` table; `turnNoticeFor` naming the chat and agent without text, task chats only when started by the user, a hand-opened chat with an attached task, other profile and trash; `recordTurnResult` offering `live`/`follow-up` after the sidebar write, silence for Stop and `recovery`; result-read listeners.
- `src/main/host/desktop/notificationService.test.ts` — content, focus suppression, setting/activation/`isSupported`, once per run, one per chat, click raising and opening, pending chat across a loading or absent window and after a push, unopenable chats, profile closing, close on read (including a superseded run), and the harness log line.
- `src/renderer/src/hooks/useNotificationOpenChat.test.tsx` — pending chat on mount, take-after-push, push with nothing pending.
- `src/main/services/taskExecutionService.test.ts`, `taskDispatchService.test.ts`, `ipc/task.ipc.test.ts`, `ipc/taskDispatch.ipc.test.ts` — `startedBy` threading and the flag's set/clear.
- `src/main/db/migrations/migrations.test.ts` — the origin backfill, its replay safety, and a fresh install's columns. `chatService.listOrder.test.ts` — `create` opens a `user` chat, and `markResultRead` tells listeners only for the current result. `scriptRuntimeService.test.ts`, `delegationService.test.ts`, `handoverService.test.ts` — the chats they open carry their own origin.
- `src/renderer/src/components/settings/FeaturesSettingsSection.test.tsx` — the row's position, default and toggle.
