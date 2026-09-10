# Stream Event Typing — LLM Reference

Project-specific wire contract for every `MessagePort` that carries a turn. LLM-targeted reference — concise patterns only, skip standard discriminated-union/Electron knowledge.

## One Vocabulary

| Send path | Posts `RunEvent` from | Receiver |
|-----------|-----------------------|----------|
| `agent:send-message` — a direct agent chat (A2A, OpenCode, Claude) | `a2aStreamingService.streamToAgent`, the turn runner's `onEvent` (`runAgentTurn`, `LocalAgentTurnRunner`, `ClaudeAgentTurnRunner`), `StreamPartsAccumulator`, `postRunError` in `agent_a2a.ipc.ts` | `useChatStream.handleRun` |
| `llm:send-message` — an LLM chat, orchestrated or not | `chatStreamingService`, `postRunError` in `llm.ipc.ts` | `useChatStream.handleRun` |

One union (`RunEvent`, `src/shared/runEvents.ts`), one guard (`isRunEvent`), one handler. The two IPC channels still exist; what differs between them is **which** variants a sender posts, never the shape of one.

### The overturned rule: "Distinct unions — never unify"

This reference used to require two unions, `AgentStreamEvent` and `LlmStreamEvent`, on the grounds that LLM deltas were text-only and the two error events carried different extras. Those were optional fields, not different semantics: an LLM delta is an agent delta with `kind: 'text'`, and `code` and `errorDetail` are two optional fields of one error. Keeping the unions apart had already cost two things:

- **A third union.** An orchestrated sub-thread needed to carry an agent's events inside an LLM stream, so `LlmStreamEvent` grew `tool_subevent` wrapping an `AgentStreamEvent` — a vocabulary nested in another vocabulary for the same thing.
- **Two renderer handlers that drift.** `handleLlm` and `handleAgent` each wrote `request-id`, `delta`, `done` and `error`, and a case that exists on one path can silently not exist on the other.

Do not re-split. A new protocol maps onto `RunEvent`; it does not get its own union.

## Mapping from the Retired Unions

| Retired | `RunEvent` |
|---------|------------|
| `AgentRequestIdEvent`, `LlmRequestIdEvent` | `request-id` |
| `LlmDeltaEvent { text }` | `delta { kind: 'text', text }` |
| `AgentDeltaEvent` | `delta` (`RunDeltaEvent`), same fields |
| `AgentStatusEvent { state: AgentTaskState }` | `status { state: RunState }` — `input-required` and `auth-required` both become `needs_input`, anything unrecognised `unknown` (`a2aStreamingService.ts:toRunState`) <!-- nocheck --> |
| an A2A `input-required` / `auth-required` status-update | `status { state: 'needs_input' }`, then `needs_input { resume: 'next_message' }` |
| a `tool` part named `cinna_permission_request` / `askuserquestion` with a `per_` / `que_` id | the part is still posted — it is the transcript — then `needs_input { resume: 'reply' }` |
| (nothing) an ask answered, rejected or expired | `input_resolved` |
| `LlmToolUseEvent`, `LlmToolResultEvent`, `LlmToolErrorEvent` | `tool_use`, `tool_result`, `tool_error`, same fields |
| `LlmToolSubEvent { toolCallId, event: AgentStreamEvent }` (`tool_subevent`) | `child { toolCallId, agentId, event: RunEvent }` |
| `AgentDoneEvent`, `LlmDoneEvent` | `done { stopReason? }` |
| `AgentErrorEvent { code? }`, `LlmErrorEvent { errorDetail? }` | `error { code?, errorDetail? }` |
| `postAgentError(port, msg, code?)`, `postLlmError(port, msg)` | `postRunError(port, msg, { code?, errorDetail? })` |
| `isAgentStreamEvent`, `isLlmStreamEvent` | `isRunEvent` |
| `useChatStream.handleAgent`, `handleLlm` | `useChatStream.handleRun` |

**Persisted `messages.parts` did not change.** An ask is still stored as a `tool` part with a reserved name and a `per_` / `que_` id. The events are live-only, so every path that reads a transcript still recognises an ask by name and id (`src/shared/localAgentRequests.ts`) — a reloaded chat has no events to read.

## Variants

- `request-id { requestId }` — first, exactly once, posted by the layer above the runner (`streamToAgent`, `chatStreamingService`). The id `cancel` takes
- `status { state: RunState, taskId?, contextId? }` — `RunState` = `submitted | working | needs_input | completed | failed | canceled | rejected | unknown`. Posted by A2A only. The renderer ignores it; a `needs_input` state is always followed by its own event, and that is what the store records
- `delta { kind: ContentKind, text, toolName?, toolInput?, toolId?, toolStream?, commandInvocation?, file? }` — already a true delta. Field meanings: [A2A Streaming Pipeline](../../agents/agents/streaming_pipeline.md#delta-event-payload-over-messageport)
- `tool_use { id, name, input, provider?, providerType?: 'mcp' | 'agent', providerAgentId? }` — LLM path only, posted before the call resolves
- `tool_result { id, result: unknown }`, `tool_error { id, error }` — pair with `tool_use` by `id`. Not the `tool_result` **content kind**, which is a `delta`
- `needs_input { requestId, request: InputRequest, resume: 'reply' | 'next_message' }` — see the contract below
- `input_resolved { requestId, resolution: RequestResolution }` — `RequestResolution` is declared in `src/shared/localAgentRequests.ts` because it crosses the wire; `pendingRequests.ts` re-exports it
- `child { toolCallId, agentId, event: RunEvent }` — LLM path only: one event of an agent the LLM called as a tool, keyed by the orchestrator's tool-call id
- `done { stopReason?: 'end_turn' | 'canceled' | 'budget' | 'error' }` — `canceled` whenever a stop ended the turn, on both paths and every exit: an LLM adapter rejecting mid-reply (the round's partial reply, unless only whitespace, is saved as an assistant message first, and any tool call the stop skipped gets a "not run" result row), an A2A turn whose result also carries an error — a stream that threw after the stop included, since `runAgentTurn` then still returns what streamed — which falls through to the normal ending and keeps it, and a runner that threw after the stop (nothing to keep). Otherwise `end_turn`. `budget` and `error` are declared and posted by nothing yet. The renderer's Stop clears no state of its own, so a stop that posted no terminal event would leave the chat streaming — see [Messaging tech — Cancellation](../../chat/messaging/messaging_tech.md#cancellation)
- `error { error, code?, errorDetail? }` — `code` is a machine discriminator (`cinna_reauth_required`) so a surface branches without matching copy; `errorDetail` is the adapter detail behind a SystemMessage's "Details"

`InputRequest`:

- `permission { action, resources, callId? }` — OpenCode and Claude asks. `action` is the engine's own word (`bash`, `Bash`, `WebFetch`)
- `question { questions: InputQuestion[] }` — `InputQuestion` is `{ question, header?, multiSelect, options }`, the type `turnStream.ts:mapQuestions` returns. An A2A question is built from the status message's `text`-kind parts only, as one open question — or none when the agent sent no text — because A2A gives a question no structure <!-- nocheck -->
- `auth { message, method?, url? }` — A2A `auth-required`; `message` falls back to `A2A_AUTH_REQUIRED_FALLBACK` when the status carries no text
- `elicitation { message, schema }` — declared, posted by nothing yet

## The `needs_input` / `input_resolved` Contract

| | `resume: 'reply'` | `resume: 'next_message'` |
|---|---|---|
| Posted by | `LocalAgentTurnRunner.park()`, the permission gate in `ClaudeAgentTurnRunner` | `runAgentTurn`, on a `status-update` frame |
| Means | the run is parked **now**; the answer goes by id through `agent:answer-request`, and the address dies with the turn | the protocol ended the turn; the user's next message is the answer |
| `requestId` | the engine's `per_*` / `que_*` id — the same id as the ask's `tool` part `toolId` | the A2A task id |
| Makes a block answerable | yes | never — the composer is the answer path |
| Followed by `input_resolved` | when settled while the turn is open | never |

Rules, each pinned by a runner-contract clause (see [Characterization tests](../../agents/local_agents/agent_turn_tech.md#the-runner-contract)):

- **The part first, then `needs_input`.** The ask's block is streamed and its registration made before the event is posted, so an answer sent the instant the event arrives finds both. `park.needs_input` asserts it arrives before any answer
- **One `needs_input` per ask**, not repeated on the way out (`park.needs_input`)
- **One `input_resolved` per ask settled while the turn is open, after its `needs_input`** (`park.input_resolved`). An answer carries what was posted; a reject or a park timeout carries `{ kind: 'rejected' }` (`park.reject`, `park.timeout`). An ask the engine settles itself — answered from another window, or OpenCode echoing our own reply as `permission.v2.replied` — is reported once: `resolvedIds` dedupes, and `engineResolution` reads the resolution off the event, falling back to `rejected` for anything the desktop's vocabulary cannot state. Both runners post it **before** the decision line, so the block stops offering buttons before the transcript says what was decided
- **Teardown posts nothing.** Each local runner holds an `open` flag and closes it before its `finally` sweeps what is parked — OpenCode also closes it before the `/interrupt` on a stop, because the engine can echo a settle while that POST is in flight. An ask swept away by the turn's own ending was answered by nobody, and the `done` or `error` posted above the runner already says the park is gone (`park.abort` asserts no `input_resolved`)
- **A2A posts `needs_input` from the streaming path's `status-update` only**, after the `status` and after the delta that already showed the question's text. A `task` frame that arrives already parked posts no `status` and so no `needs_input`, and neither does the non-streaming `message/send` path

## Receiver: `handleRun` and the Chat Store

- `delta` → `appendDelta` with every field; an LLM delta lands exactly where a bare text append would
- `tool_result` / `tool_error` → resolve or fail the tool block, then `dropInputRequestsFor(id)`: a nested agent's asks end with its call
- `needs_input` → `addInputRequest` (a repeated id replaces its entry in place and is no longer settled); `input_resolved` → `resolveInputRequest`, which removes the entry and records the id in `settledInputRequestIds` whether or not the store held it — an ask known only through the registry poll is just as settled
- `child` → a nested `needs_input` / `input_resolved` goes to the same list, tagged with `toolCallId`; a `child` inside a `child` is dropped, because the sub-thread renders one level and nothing sends deeper; everything else goes to `appendToolSubEvent`, which keeps non-`notice` `delta`s only — so a nested `status`, `done` or `error` never ends the outer turn
- `status` → ignored

Store lifecycle (`src/renderer/src/stores/chat.store.ts`):

- `inputRequests` — asks this stream announced and has not settled. Cleared by `startStreaming`, `setActiveChatId` and `reset`. `finishStreaming`, `clearStreamingBlocks` and `stopStreaming` drop only the `reply` entries, whose parked turn just died; a `next_message` ask stays until the next turn, which is its answer
- `settledInputRequestIds` — cleared only by `startStreaming`, `setActiveChatId` and `reset`, because the registry poll's last read can land after the stream has ended

Liveness of an ask's block (`MessageStream.renderRequestBlock`): the part has an engine id, the id is **not** settled (`isSettledInputRequest`), and either the registry poll lists it (`useAgentRequests.isPending`) or the stream announced it as a `reply` ask (`isLiveInputRequest`).

- **Settled wins over both**, because the poll lags the stream by up to a tick: a park that timed out, or an ask answered elsewhere, would otherwise keep offering buttons whose answer can only be refused
- **The poll stays.** A reloaded renderer has no port and re-opens a prompt only because the main-process registry still holds it; an ask raised before this renderer subscribed never reaches it as an event
- `useAgentRequests`' answer functions also call `resolveInputRequest` optimistically, since the `input_resolved` echo has not arrived yet
- `PermissionRequestBlock` always receives `requestId={part.toolId}`; `interactive` is the liveness above, and the block stays live while its own answer is in flight even after `interactive` turns false — the settle can land before the answer call returns
- **A pending ask holds the transcript.** `MessageStream` passes `hold` to `useStickToBottom` while `inputRequests` has a `reply` entry with no `toolCallId` whose id is not settled, so a second ask arriving cannot scroll its own button under the pointer aimed at the first ([Transcript Scrolling](../../chat/conversation_ui/scroll_following.md)). Store-driven only: a block live from the poll alone does not hold

## Known Issues

- **Nested asks have no control.** A nested (`child`) ask from an orchestrated folder agent is recorded in `inputRequests`, and the registry would take an answer by id, but no sub-thread renders a control for it — so it still ends at its park timeout
- **Request blocks still change height under the pointer** in two cases the hold does not cover: an answered block's button row giving way to a shorter decision line, and a poll-only block turning live late — [Local Agent Permissions](../../agents/local_agents/permissions.md#known-issues-in-the-block)

## Sender Wiring

| Layer | Where | Typed surface |
|-------|-------|---------------|
| Streaming services | `services/a2aStreamingService.ts`, `services/chatStreamingService.ts` | each declares a `StreamPort` whose `postMessage` takes `RunEvent` |
| Runner sink | `RunAgentTurnInput.onEvent` (`a2aStreamingService.ts`), `ToolCallOptions.onEvent` (`llm/toolProvider.ts`) | `(event: RunEvent) => void` |
| Accumulator | `agents/streamPartsAccumulator.ts` | `DeltaPort.postMessage(RunDeltaEvent)` |
| IPC pre-flight errors | `ipc/agent_a2a.ipc.ts`, `ipc/llm.ipc.ts` | `postRunError(port, msg, extras?)` in `ipc/_streamPort.ts` |

**Rule:** every outbound frame goes through a typed surface. Raw `port.postMessage({ … })` is forbidden.

- `postRunError` sets only the extras that are present. An `undefined` key survives structured clone as a present-but-undefined property, which is not the shape either retired helper put on the wire
- `chatStreamingService` wires an agent provider's `onEvent` only when the provider has a `providerAgentId`, because `child` names the agent: a provider without one runs buffered rather than post a `child` with an invented id

## Bridge

- `preload/index.ts` — `agents.sendMessage` and `llm.sendMessage` both run `isRunEvent` in `channel.port1.onmessage`, `console.warn` `[preload] dropped off-contract run event` and drop anything else, and only then call `onEvent`
- The guard checks the discriminator only, against `RUN_EVENT_TYPES` with `hasOwnProperty` — so `{ type: 'toString' }` is off-contract, and a retired `tool_subevent` is dropped. A recognised `type` with a wrong-shaped payload branches into its case, where the wrong values surface as visible errors rather than silently dropped events
- Senders are typed too, so both ends must drift at once for an off-contract event to pass — defense in depth, not the primary mechanism

## Adding a Variant

Three records are typed over `RunEvent['type']`, so a new variant fails the typecheck until each lists it: `RUN_EVENT_TYPES` in the guard, `EVERY_VARIANT` in the guard's test, and `RUN_EVENT_TYPES` beside the events-test rows.

1. Add the interface to `src/shared/runEvents.ts`, with JSDoc saying who posts it and when, and add it to the `RunEvent` union
2. Add its `type` to `RUN_EVENT_TYPES` in the same file. It is a `Record<RunEvent['type'], true>`, so the typecheck fails until the guard lists it — a variant the guard does not know would be dropped in preload with only a console warning
3. Emit it from the sender; `StreamPort` / `onEvent` typing enforces the shape
4. Handle it in `useChatStream.handleRun`. An unhandled case falls through silently — that is the forward-compatibility contract — so decide it explicitly, and decide what it means inside a `child` as well
5. Add a row to `src/renderer/src/hooks/useChatStream.events.test.tsx`. Its own `RUN_EVENT_TYPES` guard makes `npm run typecheck:web` fail until the type is listed, and a runtime check fails until an agent or LLM row exercises it
6. Add an instance to `EVERY_VARIANT` in `src/shared/runEvents.test.ts`. It is typed `{ [T in RunEvent['type']]: Extract<RunEvent, { type: T }> }` and fed to `it.each`, so the typecheck fails until the new variant has one, and the guard is then tested against it
7. If a runner posts it, the golden `*.expected.json` files change: edit them on purpose, never regenerate blind (see [The expectation-file rule](../../agents/local_agents/agent_turn_tech.md#the-expectation-file-rule))

A new optional field on an existing variant needs only step 1; the compiler flags every sender and receiver that does not satisfy the new shape.

## Part Merge Rule

Live blocks and persisted parts split in the same places because one function decides it: `continuesPart` in `src/shared/partMerge.ts`, called by the accumulator, `chat.store.appendDelta` and the sub-thread's `appendAgentDeltaPart`. The rule, and the two-asks defect it fixed, are in [A2A Streaming Pipeline](../../agents/agents/streaming_pipeline.md#renderer-routing).

## Subtype Assignment Quirk

`DeltaPort.postMessage(RunDeltaEvent)` is **narrower** than `StreamPort.postMessage(RunEvent)`. `StreamPort` is assignable to `DeltaPort` through function-parameter contravariance, so a runner hands its sink to the accumulator with no cast.

## Discriminated Narrowing in the Receiver

`handleRun` uses `switch (event.type)`; each case narrows `event`. **Do not write `event.text!` / `event.id!` / `event.x ?? 'fallback'`** — fields the union marks required are guaranteed inside the branch. Optional fields (`errorDetail`, `stopReason`) stay `T | undefined`. Inside `child`, narrow `event.event` again: it is a full `RunEvent`.

## References

- Vocabulary and guard: `src/shared/runEvents.ts`, `src/shared/runEvents.test.ts`
- Merge rule: `src/shared/partMerge.ts`
- Ask conventions and `RequestResolution`: `src/shared/localAgentRequests.ts`
- Senders: `src/main/services/a2aStreamingService.ts`, `src/main/services/chatStreamingService.ts`, `src/main/services/agentTurn/localAgentTurnRunner.ts`, `src/main/services/agentTurn/claudeAgentTurnRunner.ts`, `src/main/agents/streamPartsAccumulator.ts`
- IPC error helper: `src/main/ipc/_streamPort.ts`
- Preload bridge: `src/preload/index.ts`
- Receiver: `src/renderer/src/hooks/useChatStream.ts`, `src/renderer/src/stores/chat.store.ts`, `src/renderer/src/components/chat/MessageStream.tsx`, `src/renderer/src/hooks/useAgentRequests.ts`
- Contract tests: `src/main/services/agentTurn/__golden__/driverContract.ts` (`describeDriverContract`, run through each agent driver), `src/renderer/src/hooks/useChatStream.events.test.tsx`
- Adjacent: [A2A Streaming Pipeline](../../agents/agents/streaming_pipeline.md) (the `cinna.*` metadata behind `delta`), [The Agent Turn Runner](../../agents/local_agents/agent_turn.md) (parking and answering), [Orchestrated Agents](../../chat/orchestrated_agents/orchestrated_agents.md) (`child`), [Messaging](../../chat/messaging/messaging.md) (LLM streaming flow)
