# Turn Outcomes and Completion Ownership

## Purpose

A finished turn reports what happened without assuming that its enclosing task is finished. Ordinary conversations and one-turn jobs keep their existing completion behavior; an explicitly owned runner turn leaves the task decision to its caller.

## Outcome and Lifetime

`src/main/services/turnCompletion.ts` defines `TurnOutcome`. Its state is `completed`, `needs_input`, `failed`, `canceled` or `budget`; text contains the final assistant answer or the stopped round’s retained partial output. Optional error data carries a message and code. An internal coordinator control records explicit handoff, finish or human-wait intent; arbitrary tool prose cannot supply it. Optional usage means reported input/output tokens; absence means unreported, never zero. Current model adapters do not provide usage.

`src/main/services/runExecutionService.ts` returns separate acceptance and completion promises. Acceptance follows the input-message transaction: human input uses a user row; internal runner continuation uses a system row. Completion waits for the asynchronous stream loop, transcript persistence and stream closure, then resolves a `RunOutcome`: the turn result plus run ID, acceptance flag and durable next-message and runner-gate request IDs for that root run. It is an internal service result, not a new renderer IPC payload. The selected-chat watch still closes and reads the saved transcript independently.

A service’s `onFinished` callback records its first outcome before closure. `createTurnCompletion` prevents double reporting and logs bookkeeping failures without making already saved output fail again. A service caller without a callback retains standalone job reporting. When the shared executor supplies a callback, it reports an ordinary job only after deriving the final result at close. A close without an outcome becomes failed and emits an observed terminal fallback so request cleanup still runs.

## Remaining Requests and Uncertainty

Normal completion with remaining next-message addresses or runner gates becomes `needs_input`. Driver-owned live `reply` addresses must expire when their invocation closes, because their driver parks no longer exist. Driver reply addresses are never returned as durable continuation IDs. Runner-owned reply gates have no live driver and survive invocation closure.

If request enumeration fails, or a dead reply row survives cleanup, `inputRequestReadError` marks the request list as uncertain. It leaves the executed turn’s state intact: a bookkeeping read failure cannot rewrite an already completed execution. A caller must refuse automatic progress while this field is present, even when the returned ID list is empty. Logging an observer failure alone is not proof that all questions were closed.

## Completion Owner

Internal callers can supply `runnerTaskId`. Admission requires a non-deleted, profile-owned task in `in_progress` or `blocked`, linked to this chat with a desktop executor and this device’s claim. Equal null device IDs remain the existing offline-profile convention. The renderer cannot request this policy through a send payload.

The executor attaches `completionOwner`, root run ID and invocation ID to observed events. A runner-owned turn may record, answer and expire requests, but neither its stream callback nor Inbox terminal observation finishes the whole task/job. Ordinary turns keep their existing job or chat-owned-task finisher. This is per execution, so one caller’s policy cannot suppress another conversation’s completion.

There is still one active turn per chat. The [autonomous task runner](../../jobs/tasks/autonomous_tasks.md) uses this ownership to coordinate consecutive turns, handback and durable gates; its reservation also excludes ordinary sends between turns and during waits. [Script execution](../../jobs/tasks/script_execution.md) uses the same ownership per isolated child conversation. Schedules and token-budget enforcement remain separate work.

## Model and Agent Endings

- A model response without tool calls finishes naturally. Reaching the ten-round ceiling with more work instead persists a `round_budget` error and returns `budget`; exhausting the loop must not masquerade as a completed task. Stop keeps saved rounds and the current nonblank partial answer, while preserving tool-call/result pairing for future requests.
- A2A input-required/auth-required endings return `needs_input`. Canceled endings return `canceled`. Failed, rejected or other unfinished task states at transport end return a failed result. A nonstream JSON-RPC error envelope enters the error path instead of producing an empty successful answer.
- The direct-agent wrapper persists its result/error, reports the typed ending and releases its active request before close. The successful/needs-input catch-up cursor hook remains separate; failure and cancellation do not advance it. Local Stop retains the prior session checkpoint and does not claim that remote cancellation was acknowledged.

## Request Ownership and Verification

[Inbox invocation ownership](../../jobs/tasks/inbox.md#invocation-ownership-and-cleanup) owns the nullable migration, exact settlement predicates, production tool-result cleanup and task-wide sibling aggregation. [Live-run attachment](live_runs.md) owns transcript deduplication and renderer settlement; typed completion does not replay or persist messages again.

Regression coverage lives in `src/main/ipc/run.routing.test.ts`, `src/main/services/chatStreamingService.stop.test.ts`, `src/main/services/a2aStreamingService.test.ts`, `src/main/services/inboxService.test.ts` and `src/main/db/migrations/migrations.test.ts`. The Inbox integration drives the actual model loop and agent tool provider against the database, checking child cleanup before the next model round and retaining another root’s ask. A2A goldens in `src/main/services/agentTurn/golden.a2a.test.ts` now require correct task-failure and nonstream RPC-error outcomes without known-failure exemptions.
