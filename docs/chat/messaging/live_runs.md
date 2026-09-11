# Live Run Attachment and Replay

## Purpose

Opening a running conversation shows the output already produced and continues receiving new output. Leaving the conversation detaches its view without stopping work. This also covers turns started in main by Task Continue or an Inbox answer before their conversation is opened.

## User Flow and Rules

1. Sending is a command. Main reserves the conversation and owns execution; the selected conversation has a separate watch subscription.
2. Opening a conversation resets the visible projection to its current run snapshot, then applies newer events once. An idle watch remains open for the next turn, so consecutive turns need no remount.
3. Switching conversation or profile discards that view's projection and closes its subscription. Queued old callbacks cannot populate the new view.
4. Stop targets the owned active conversation, even before a protocol request ID arrives. Detaching does not mean Stop.
5. On closure, the view reads the saved transcript before retiring live output. A failed read keeps the output available; a later successful query retries settlement. A delayed prior-turn read cannot clear a newer turn or optimistic send.

**One representation per output row.** Model turns save assistant and tool rows between tool rounds while the live projection still contains that output. Showing both would duplicate the conversation. Each run captures the IDs present before it starts. While its complete replay is displayed, the transcript shows those historical rows and all user/system rows, withholding new assistant/tool/transition/error rows until final settlement. The filter is applied before grouping and question selection. The optimistic user bubble still uses persisted user count, not text equality, so repeated identical sends remain distinct.

**Missing the terminal event must not leave pending UI.** A fast send can finish before the selected-chat watch attaches. An idle snapshot therefore fetches the saved transcript and clears only the matching optimistic send after success. The same settlement handles attachments whose replay is unavailable. Otherwise a visually hidden optimistic message could leave the final question card read-only.

## Replay Limits

Main retains at most 8 MiB of accounted baseline/event bytes and 5,000 cached event entries per active run. Adjacent compatible deltas, including adjacent deltas for the same child tool call, are compacted with the shared part-merge rule. Byte accounting includes nested tool inputs/results and remains conservative after compaction.

Overflow or cache-serialization failure discards that run's retained replay. Existing subscribers still receive every live event; future attachments get `replayAvailable: false`, no partial replay and no baseline filter. They use saved-message polling while the active handle remains present. This preserves saved output without pretending a truncated token history is complete. Run close removes the cache; this is process-local attachment, not durable replay after application restart. There is no user setting for these limits.

## Architecture and IPC

Send → `run:start` → main executor → live hub → selected-chat `run:watch` → renderer projection; stream services independently persist the transcript.

| Channel | Contract |
| --- | --- |
| `run:start` | Activated invoke with `RunSendPayload`; returns the new run ID. Main resolves the answerer and owns acceptance/execution. Returning the ID does not promise successful delivery or completion. |
| `run:watch` | Activated MessagePort subscription for an owned chat. Starts with a snapshot, then sequenced event/accepted/closed envelopes. Port closure removes the subscriber without cancelling execution. |
| `run:cancel-chat` | Activated invoke for an owned chat; cancels its main handle, including an early request remembered until the transport exists. |

`run:send`, `agent:send-message`, `llm:send-message` and preload `run.send` remain compatibility paths through the same executor until the later cleanup phase. The normal renderer uses `run.start` plus one selected-chat watch, so it never applies both legacy port events and watch events to the same projection.

## Implementation and Ownership

- `src/shared/runWatch.ts` — snapshot/event/accepted/closed envelope and preload validator. Each run has its executor ID and monotonically increasing sequence; snapshots include replay availability, baseline IDs and compact events.
- `src/main/services/liveRunHub.ts` — profile/chat-keyed active cache and independent subscriber sets; reset snapshot on begin/attach, sequenced fanout, accepted notification and cache removal on close. A failed subscriber does not fail the producer.
- `src/main/services/runExecutionService.ts` — registers the hub before execution, forwards observed output, tracks acceptance and closes once. `src/main/db/chats.ts` supplies `listMessageIds` without loading historical message payloads.
- `src/main/ipc/run.ipc.ts` and `src/preload/index.ts` — activated ownership checks, native watch-port lifecycle and bridge validation. Main rechecks the active profile and chat ownership before every delivery; renderer cleanup also closes its end.
- `src/renderer/src/hooks/useLiveRunWatch.ts` — mounted once by `MainArea`; owns subscription, replay hydration, live sequence checks and terminal transcript settlement. It guards current profile/chat, disposed subscriptions, incrementing projection version and optimistic-message identity. Settlement cancels older chat reads, fetches fresh data, and retries after later query success if an earlier read failed.
- `src/renderer/src/hooks/useChatStream.ts` — `startRun` issues the command and records its optimistic user message; `useRunEventHandler` only projects the event vocabulary. Replay does not repeat status-refresh/readiness side effects.
- `src/renderer/src/stores/chat.store.ts` — selected run ID, baseline IDs and projection version alongside blocks/requests; navigation and reset advance the version.
- `src/renderer/src/components/chat/MessageStream.tsx` — filters persisted duplicates and renders replay/live blocks. `ChatInput` uses owned chat cancellation before a transport request ID is available. `useChatDetail` retains polling as the fallback when no complete live projection is attached.

No new database table, migration or durable event log is introduced. The scope is visibility of an existing main-owned turn. `RunHandle.completed` still denotes stream lifetime and carries no typed outcome; task-runner completion ownership, autonomous loops, coordinator control outcomes, budgets, queues, scripts and schedules remain separate work.

## Verification and Related Features

`src/main/services/liveRunHub.test.ts` covers compact replay, sequence continuity, independent scopes/subscribers, idle watches, overflow and serialization failure. `src/renderer/src/hooks/useLiveRunWatch.test.tsx` covers navigation, overlapping delivery, failed-read recovery, stale completion, idle fast sends, fallback and profile changes. Native watch cases in `src/main/ipc/run.routing.test.ts` cover main-started replay, detach without cancellation and ownership revocation.

See [Messaging](messaging.md), [main turn lifetime](../chat_routing/chat_routing_tech.md#shared-turn-lifetime-and-acceptance), [task execution](../../jobs/tasks/tasks_tech.md) and [A2A streaming](../../agents/agents/streaming_pipeline.md).
