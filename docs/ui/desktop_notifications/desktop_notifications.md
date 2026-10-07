# Desktop Notifications

## Purpose

Tell the user, through the operating system's notification centre, that a conversation of theirs has stopped — finished, waiting for their input, or failed — while Cinna is not the app in front. A click brings Cinna forward with that conversation open. Inside the app the [sidebar result icons](../../chat/session_status/session_status.md) already say the same thing, so a notification only exists for the time the user cannot see them.

## Core Concepts

- **Turn notice** — what core says when a chat's turn ends and its sidebar result has been written: which chat, which run, the outcome, the chat's title and agent, and whether this stop is one the user cares about. Data only; core never shows anything.
- **The user's own chat** — a chat the user opened themselves, or the chat of a task the user started by hand. Every other chat belongs to work Cinna or an agent started, and stays quiet.
- **Chat origin** — who opened a chat: the user, a task, a delegation, a handover or a job. Recorded once when the chat is created and never changed, so a later event cannot turn somebody else's chat into the user's or the other way round.
- **Started by the user** (task) — whether the user started the task's current run with **Start** on the task page, **Run next** on its agent's queue, or **Run autonomously** from a coordinator chat. Any other start clears it; a turn that continues the same run (an Inbox answer, a follow-up) leaves it alone.
- **Background** — no Cinna window has focus: neither the main window nor the tray popover. A minimized app, one hidden to the tray, or one behind another app all count.

## User Stories / Flows

### A conversation finishes while the user is elsewhere

1. The user sends a message to an agent and switches to their browser.
2. The turn ends. Cinna is not focused, so the OS shows a notification: the chat's title as its heading, and the agent's name with **Finished**, **Needs your input** or **Failed** as its line (just the outcome when the chat has no agent).
3. The user clicks it. Cinna comes forward — reopening its main window if it had been closed — any open console or Agent Status overlay closes, and the chat opens, even a task's chat that the Chats list does not show.

### The user reads it inside the app first

1. A notification is on screen for a chat.
2. The user returns to Cinna by other means and opens that chat; its result is marked read.
3. The notification is withdrawn from the notification centre, since what it announced has been seen.

### A task the user started

1. The user presses **Start** on a task page, or **Run next** on an agent's queue, and leaves Cinna.
2. That turn, and every turn continuing the same run, notifies on its outcome like a chat of their own.
3. Once the queue picks the task up on its own, or a delegation or handover starts it, its turns are quiet again.

### Turning it off

1. Settings → Features → Interface → **Desktop notifications**, right after **Enable Tray Icon** (on by default). What it does is behind the row's (?) tip.
2. Off stops new notifications at once; nothing needs a restart.

## Business Rules

### Which stops notify

- **Finished, needs input and failed notify; Stop never does.** The user's own Stop is not news to them. A cancelled turn has no sidebar icon either, for the same reason.
- **A turn recovered after a restart never notifies.** The boot pass records the endings of turns Cinna was killed under; announcing them would greet a relaunch with a burst of notices about work that ended before it. The rule covers the whole recovery path, so a remote agent's turn that Cinna reattaches to after a relaunch stays quiet even when it finishes long after the restart ([Interrupted Turn Recovery](../../agents/turn_recovery/turn_recovery.md)). A turn an agent opens on its own after its reply ([a follow-up turn](../../agents/local_agents/agent_turn.md#a-turn-the-agent-starts-on-its-own-is-a-follow-up-turn)) is live work and does notify.
- **Only the user's own chats.** A chat they opened, or the chat of a task they started by hand. A chat the user opened stays theirs when the Inbox attaches a task to it on its first ask, because a chat's origin never changes.
- **Never for work Cinna started.** Queue auto-runs, runs started by **Approve and run** on an Inbox card, delegations, handovers and jobs (including their script steps) are quiet, however the user reaches their chats. They are reviewed in the Inbox, the Tasks view and the Jobs list, which exist for that; a notification per automatic run would train the user to ignore all of them.
- **An autonomous task the user ran notifies when it asks for input, finishes or fails** — once per outcome, not per specialist turn inside it. Resuming one whose question was already waiting announces nothing new. **Script controllers and scheduled jobs never notify**: they write their results without passing through the turn notice.
- **Only for the active profile.** A chat the open profile cannot see, or one in the trash, is never announced; no notification is shown before a profile is open (first run, sign-in, a locked profile).

### When one is shown

- **Never while Cinna is the active app**, even if a different chat is on screen. The user is in the app and sees the sidebar change; an OS banner over their own window would be noise.
- **The setting is read at the moment the turn ends**, so turning it off silences everything after that instant.
- **No message text, ever.** The heading is the chat's title (or **Cinna** for an untitled chat), the line is the agent and the outcome. Notifications show on the lock screen and in screen recordings; what an agent said stays in the app.
- **Once per run.** The same run is never announced twice.
- **One per chat.** A newer outcome for a chat replaces its older notification rather than stacking beside it.

### When one goes away

- **Read in the app → withdrawn.** When the chat's current result is marked read — opening the chat, or a job's page showing its latest run — its notification is closed. A stale view reading an older run does not close the notification for a newer one.
- **Profile left → all withdrawn.** Switching profile or signing out closes every notification and forgets a click that had not been delivered yet, so nothing on screen names another profile's chat.
- **A click on a chat that is no longer openable** — another profile's, or since trashed — only brings Cinna forward and names nothing.

### Platform

- **macOS asks permission the first time.** The first notification triggers the system's permission prompt; until the user allows it in System Settings → Notifications, nothing appears. A development build is listed there, and shows its notifications, as **Electron** rather than Cinna.
- **Never under the test harnesses.** With `CINNA_BACKGROUND_WINDOW=1` (the E2E fixture and the live-backend harness) the app's windows are never focused, so every turn of a spec would reach the developer's notification centre. The notice is written to the log instead of shown, which a spec can read.

## What this deliberately does not do

- **No history, badge count or notification list.** The sidebar's unread results and the Inbox are the record; a notification is only a pointer to them.
- **No per-chat or per-agent switches.** One switch; the rules above decide the rest.
- **Nothing for remote events the desktop did not run** — a cinna-core task changing on the server, a peer device's turn. Only turns this app recorded.
- **Not synced.** The setting is this installation's, and whether a task was started by hand is this device's business; neither travels with [device sync](../../sync/data_sync/data_sync.md).

## Architecture Overview

```
Turn closes (live run / follow-up turn)          Boot pass (recovery)
   -> recordTurnResult -> sidebar result written     -> recordTurnResult -> (no notice)
   -> turnNotices.settled -> core decides "the user's stop?" (chat origin, task started by user, status)
      -> desktop notificationService: setting on? profile open? no Cinna window focused? not shown yet?
         -> OS Notification (title + agent · outcome)
            click -> raise main window -> renderer opens the chat
Result marked read (chat opened / job page) -> turnNotices.resultRead -> notification closed
Profile switch / sign-out -> userActivation.onProfileClosing -> every notification closed
```

## Integration Points

- [Sidebar Session Status](../../chat/session_status/session_status.md) — the result a notice announces, and the read acknowledgement that withdraws it.
- [Turn Outcomes](../../chat/messaging/turn_completion.md) and [Interrupted Turn Recovery](../../agents/turn_recovery/turn_recovery.md) — where turn results are recorded, and the boot pass that never notifies.
- [The Task Dispatcher](../../jobs/tasks/task_dispatcher.md) and [Tasks](../../jobs/tasks/tasks.md) — Run next and Start mark a task as started by the user; the queue's own runs do not.
- [A Chat's First Ask Creates Its Task](../../jobs/tasks/chat_tasks.md) — why a hand-opened chat with a task stays the user's.
- [Handover Bus](../../jobs/tasks/handover_bus.md), [File Handovers](../../jobs/tasks/file_handovers.md), [Jobs](../../jobs/jobs/jobs.md) — work whose chats never notify.
- [Settings](../settings/settings.md) — the Features → Interface switch.
- [Menu-Bar Tray](../tray/tray.md) — a focused tray popover counts as Cinna being in front.
- [User Accounts](../../auth/user_accounts/user_accounts.md) — profile switches and sign-out close every notification.
- [Hub Core Ownership](../../development/hub_core/hub_core_llm.md) — the decision is core's; showing it is the desktop host's.
- [Technical details](desktop_notifications_tech.md).
