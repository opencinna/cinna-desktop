# Sidebar Session Status

## Purpose

Show which conversations are still working and which have new results to read, even after the user opens another chat. A running conversation can be interrupted directly from its sidebar row without losing the conversation currently on screen.

## Core Concepts

- **Running session** — a main-owned turn or a working coordinator/script reservation. Selecting a different conversation changes the view, not the lifetime of that work.
- **Unread result** — the latest saved result for one conversation that has not been acknowledged while that conversation is open in the foreground. This is local to this installation and profile; it is not a message count or a remote task notification.
- **Result status** — completed, needs input or failed. User cancellation returns directly to the ordinary delete action without an unread icon.

## User Stories / Flows

### Follow or interrupt background work

1. Start a conversation and open another chat. The original row keeps its spinning icon in the position used by its delete action.
2. Hover the running row or focus its action. The spinner becomes a square **Interrupt session** button.
3. Press it. The row shows **Interrupting session…** while the request is pending. The currently open conversation and its unsent draft remain in place.
4. Once execution has stopped, **Delete session** becomes available. An interrupt request being accepted is not proof that cancellation cleanup has finished; the running action remains until main reports it stopped.

### Return to unseen results

1. Leave a session working in another chat, or put the application in the background.
2. When work ends, its row replaces the spinner with a result icon: a green check for completion, an amber question mark for needed input, or a red alert for failure. Hover/focus still exposes **Delete session** for stopped work.
3. Open that conversation in the foreground and let its saved transcript load. The indicator clears only when the loaded conversation contains that same latest result.
4. Leave and return, or restart the app. An acknowledged result stays read; an unopened result remains unread across restart.

## Business Rules

- **Main owns activity.** Running indicators survive selection changes and cover work started without an open conversation. A selected transcript's streaming flag alone previously lost the spinner as soon as another row was selected.
- **Activity takes precedence.** A new run hides the previous result icon while it is working. Working coordinator reservations keep the row interruptible between turns. Waiting or interrupted reservations are not working spinners; the Inbox and task controls provide their recovery actions.
- **Interrupt does not navigate or delete.** It targets the row's conversation and, for a reserved autonomous session, its whole controller. Deletion through the ordinary chat action refuses while work is active, including when a stale renderer still offers delete. Failure leaves the row available with an inline error and retry.
- **A result describes the owning session.** A coordinator's successful intermediate turn is not completion. Time/turn-limit failures produce failed results; durable waits and recoverable system interruption produce needs-input results. Script roots and their relevant child conversations receive results from their controller. Ending a script does not overwrite already completed siblings.
- **User cancellation creates no unread notification.** Stopping active or waiting work clears its previous result indicator, including cancellation through task controls. System interruption requiring recovery is distinct from user Stop.
- **Selection alone is not reading.** The chat view must be visible, the document focused and not hidden, and a successful saved-transcript read must contain the current result identity. Opening Settings or the Inbox with that chat still selected does not count. Pending, failed or stale reads cannot acknowledge a newer result, and a delayed acknowledgement cannot clear a later one. This tracks opening the conversation, not scrolling to or reading every individual message.
- **Only the latest result is retained.** A new result replaces the previous one for that chat. Repeated cleanup and metadata-only edits must not turn an already read result unread again. Read state is persisted locally; there is no notification history, badge count, new preference or app-sync collection.
- **Status does not promote hidden chats.** Job-created conversations follow the existing rules for appearing in Chats. These indicators describe listed conversations; they do not replace the task page, Inbox, agent readiness or Agent Status.

## Architecture Overview

Main turn or controller → local latest-result record and active reservation → chat list/detail IPC → sidebar row and foreground read acknowledgement → matching saved result marked read.

## Integration Points

- [Technical details](session_status_tech.md) — storage, IPC, activity precedence, read identity and regression coverage.
- [Messaging](../messaging/messaging.md) and [live attachment](../messaging/live_runs.md) — execution, cancellation and selected-chat replay.
- [Turn outcomes](../messaging/turn_completion.md) — per-turn completion and the controller that owns the session outcome.
- [Conversation UI](../conversation_ui/conversation_ui.md) and [App Shell](../../ui/app_shell/app_shell.md) — transcript visibility and sidebar navigation.
- [Tasks](../../jobs/tasks/tasks.md), [autonomous coordination](../../jobs/tasks/autonomous_tasks.md), [script execution](../../jobs/tasks/script_execution.md) and [Inbox](../../jobs/tasks/inbox.md) — whole-session controls and durable human waits.
