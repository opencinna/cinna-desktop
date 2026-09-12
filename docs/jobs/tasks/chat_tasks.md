# A Chat’s First Ask Creates Its Task

## Purpose

An agent asking for input in a conversation opened by hand must reach the same Inbox as an agent running a job. The first persisted ask gives that chat a task, whether it parks the running driver or asks for a later message.

## Core Concepts

- **Lazy task** — a desktop task created by `inboxService.taskForChat` when a chat with no task raises an ask with an agent id. Ordinary chats without such an ask get no task from this mechanism.
- **Driver reply ask** — `deliveryOwner: driver`, `resume: reply` addresses a live parked driver. Its address expires when that process or turn ends. A separate runner-owned reply gate is durable; see [autonomous tasks](autonomous_tasks.md).
- **Next-message ask** — `resume: next_message` records an A2A question or authentication request whose answer starts another turn. Its durable local address survives normal turn completion and app restart.
- **Chat-owned task** — a task whose current chat is not the local chat of a linked job attempt; it finishes from the root turn’s outcome once no next-message continuation remains. Job-owned tasks keep their existing attempt and completion hook. A task started in a new desktop chat after takeover may retain an older `jobRunId` as provenance without giving that old attempt ownership of the new chat.

## User Stories / Flows

1. A user starts a conversation and an agent asks a question or permission, or requests authentication before continuing.
2. If the chat has no task, the Inbox service uses the chat’s title and router, with the full first user message as the immutable goal. The title is the fallback when there is no user message. The answering agent, including a nested agent identified by its child event, becomes the assignee.
3. The task starts on this device before becoming blocked. The ask is written before the blocked status, so the user’s action has a row even if the status write fails.
4. The user answers through the Inbox without opening the conversation. A next-message answer persists a new user message and continues the asking agent in the same chat, task and A2A context; an existing job run remains the same attempt.
5. A typed message routed to that agent settles the same continuation. Other agents’ outstanding requests remain open, and prevent task/job finalization until they are settled.
6. The final root turn settles abandoned requests and finishes the task only when no next-message request remains. The Inbox retains answered cards until the user leaves it.

## Business Rules

- **Start before blocking.** A new task cannot transition directly to blocked; the intermediate `in_progress` also records that this turn is running here.
- **The goal preserves the original request.** A truncated chat title must not become the immutable goal when the full first user message exists.
- **Finishing a turn does not finish a question.** Normal completion expires live reply addresses but preserves next-message requests. Boot expires driver-owned reply addresses only; durable continuations and runner gates need no surviving driver process.
- **A repeated question is a new decision.** Next-message addresses include chat, agent, main-owned turn and protocol request identity; child asks also carry their invocation identity. Repeated frames in one invocation deduplicate, while a later identical question cannot reuse an answered card.
- **Acceptance is atomic.** Saving the continuation message, settling matching requests and checking task status/device authority happen in one database transaction. A refusal rolls back both message and settlement. An already running chat refuses another turn without consuming the ask.
- **Acceptance is not completion.** Once the message is accepted, the modal can close while main continues the turn. A later driver/network failure is the new turn’s outcome; it does not undo the accepted answer. See [the Inbox](inbox.md).
- **Sibling asks survive.** A continued agent settles its own next-message requests. Its failure or cancellation must not expire another agent’s continuation. A coordinator tool refuses to call an agent while that agent still awaits a human answer.
- **A chat-owned task has a finisher.** An explicitly runner-owned turn leaves the whole-task decision to its caller while retaining request cleanup. For an ordinary turn with no continuation remaining, normal done maps to completed, canceled to cancelled, and error/budget endings to error. Job-owned tasks wait for `jobService.reportRunCompletion`, which also defers while next-message requests remain.
- **Explicit endings do not leave idle jobs running.** Completed/error/cancelled/archived task writes expire next-message requests and settle a linked pending/running job attempt. Archive maps that active attempt to cancelled; a terminal attempt keeps its outcome. Manual job completion/cancellation updates a desktop-owned task through the claim-checked task service before writing the job.
- **Inbox event observation never throws into the stream.** A deleted chat creates no task; an event-bookkeeping failure is logged. Acceptance bookkeeping is different: it may refuse inside the transaction so no unaccepted message survives.
- **Pending remote handoff blocks local admission.** The shared executor checks both the active chat reservation and its durable unresolved receipt before starting a turn. Chat input offers receipt recovery even after the task is deleted; recovery cannot take over known-live remote work. See [remote handoff](remote_handoff.md).
- **This is one-turn continuation, not autonomous orchestration.** It creates a parent for persisted asks and continues their owner. The separate [task-start service](tasks_tech.md) supplies explicit Continue after takeover. The separate [autonomous runner](autonomous_tasks.md) supplies coordinator handback, durable gates and consecutive owner turns; scripts remain unimplemented. [Live-run replay](../../chat/messaging/live_runs.md) independently attaches the selected conversation.

## Architecture Overview

Run event → shared main executor observer → inboxService.recordRunEvent → existing task or taskForChat → taskService.create / start → task_input_requests → Inbox.

Inbox answer or typed message → message transaction + resumeChat → same agent/context → next ask or final outcome; job-owned completion stays with jobService.reportRunCompletion.

## Where It Lives

- `src/main/services/inboxService.ts` — lazy creation, request identity, resume/answer guards and completion.
- `src/main/services/runExecutionService.ts` — shared main-owned turn lifetime with optional renderer port.
- `src/main/db/messages.ts` and `src/main/services/messageRoutingService.ts` — transactional message acceptance.
- `src/main/db/taskInputRequests.ts` — durable next-message rows and selective expiry.
- `src/main/services/taskService.ts` — task creation, legal start, run-state mapping and settled-task request expiry.
- `src/main/services/inboxService.test.ts` and `e2e/specs/next-message-inbox.spec.ts` — continuation, restart, identity, sibling and completion coverage.

## Integration Points

- [Jobs](../jobs/jobs.md) — job tasks retain their existing completion hook and attempt.
- [Moving execution across the seam](remote_sync.md#moving-execution-across-the-seam) — handover and takeover controls.
- [A Task on the User’s Other Devices](cross_device.md) — task rows travel; local conversations and continuation addresses do not.
- [Tasks](tasks.md), [the Inbox](inbox.md) and [shared execution](../../chat/chat_routing/chat_routing_tech.md#shared-turn-lifetime-and-acceptance) — work records, answer routing and runtime boundaries.
