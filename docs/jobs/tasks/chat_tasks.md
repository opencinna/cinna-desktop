# A Chat’s First Ask Creates Its Task

## Purpose

An agent asking for input in a conversation opened by hand must reach the same inbox as an agent running a job. The first answerable parked ask gives that chat a task, so every persisted input request has a task to belong to.

## Core Concepts

- **Lazy task** — a desktop task created by `inboxService.taskForChat` when a chat with no task raises its first persisted ask. Ordinary chats without such an ask get no task from this mechanism.
- **Parked ask** — a `needs_input` event with `resume: reply` and an agent id, recorded in `task_input_requests`. A `next_message` event has no live reply address and writes no inbox row.
- **Chat-owned task** — a task without `jobRunId`; its turn’s ending is the work’s outcome. A job-owned task has a separate completion hook that knows the attempt’s outcome.

## User Stories / Flows

1. A user starts a conversation and an agent parks on a question or permission.
2. If the chat has no task, the inbox service creates one using the chat’s title and router, with the full first user message as the immutable goal. The title is the fallback when there is no user message. The answering agent, including a nested agent identified by its child event, becomes the assignee.
3. The task starts on this device before becoming blocked. The service writes the ask before marking the task blocked, so the user’s action has a row even if the status write fails.
4. The Inbox displays the ask. Its task link opens the task page, whose **Open the conversation** header control returns to the original chat.
5. Answering resumes the task when no open asks remain. The root turn’s done or error event settles abandoned asks and finishes a chat-owned task.

## Business Rules

- **Only an ask that gets a row creates a task.** Creating one for `next_message` would leave a blocked task with no reply address and nothing in the inbox. An existing task still receives the event’s blocked state.
- **Start before blocking.** A new task cannot transition directly to blocked; the legal intermediate `in_progress` also records the truth that this turn is running here.
- **The goal preserves the original request.** The chat title can be a truncation; copying it into the immutable goal would permanently lose what the user asked.
- **A chat-owned task must have a finisher.** Done maps to completed, done with `stopReason: canceled` maps to cancelled, and error maps to error. Without this, a task created by a hand-opened chat remained running indefinitely because `jobService.reportRunCompletion` finds only job runs.
- **A job-owned task waits for its job’s completion hook.** `endTurn` releases a blocked task when it expired abandoned asks, but leaves the outcome to `reportRunCompletion`; the root event alone cannot know all job outcomes. A nested agent finishing does not finish the enclosing task.
- **Inbox bookkeeping never throws into the stream.** A deleted chat creates no task; a failed task or ask write is logged without interrupting the agent’s transport.
- **This does not create a task for every chat or a desktop start control.** It supplies a parent for a persisted local ask. Remote asks use the remote-adapter path, and execution handover is documented separately.

## Architecture Overview

Run event → inboxService.recordRunEvent → openAsk → existing task or taskForChat → taskService.create / start → task_input_requests → Inbox → task page → original conversation.

Root done / error → inboxService.endTurn → expire open asks → finish chat-owned task, or leave the job-owned outcome to jobService.reportRunCompletion.

## Where It Lives

- `src/main/services/inboxService.ts` — `taskForChat`, `openAsk`, `endTurn`, `endedAs`, and the non-throwing event tap.
- `src/main/services/inboxService.test.ts` — lazy creation, goal preservation, unsupported resume paths and completion cases.
- `src/main/services/taskService.ts` — task creation, legal start and run-state mapping.
- `src/renderer/src/components/tasks/TaskView.tsx` — task page and its conversation control.

## Integration Points

- [Jobs](../jobs/jobs.md) — job tasks are created at execution and retain their own completion hook.
- [Moving execution across the seam](remote_sync.md#moving-execution-across-the-seam) — remote handover and take-over controls.
- [A Task on the User’s Other Devices](cross_device.md) — task rows travel; the local conversation does not.

- [Tasks](tasks.md) and [the Inbox](inbox.md) — durable work records and the local/remote answer list.
