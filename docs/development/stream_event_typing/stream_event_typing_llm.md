# Stream Event Typing — LLM Reference

Project-specific wire contract for the two `MessagePort` streaming channels (agent A2A + LLM). LLM-targeted reference — concise patterns only, skip standard discriminated-union/Electron knowledge.

## The Two Channels

| Channel | Use | Shared union | Receiver |
|---------|-----|--------------|----------|
| Agent (A2A) | Remote agent turns via `a2aStreamingService` | `AgentStreamEvent` in `src/shared/agentStreamEvents.ts` | `useChatStream.handleAgent` |
| LLM | Local LLM turns via `chatStreamingService` | `LlmStreamEvent` in `src/shared/llmStreamEvents.ts` | `useChatStream.handleLlm` |

Both are discriminated unions on `type`. **Distinct unions — never unify.** Different semantics (LLM deltas are text-only; agent deltas carry `kind` + tool metadata + `commandInvocation`; LLM errors carry `errorDetail`; agent errors don't).

## Union Variants

### `AgentStreamEvent`
- `{ type: 'request-id', requestId }`
- `{ type: 'status', state: AgentTaskState, taskId?, contextId? }` — `state` is the A2A v0.3 literal union mirrored inline (`'submitted' | 'working' | 'input-required' | 'completed' | 'canceled' | 'failed' | 'rejected' | 'auth-required' | 'unknown'`)
- `{ type: 'delta', kind: ContentKind, text, toolName?, toolInput?, toolId?, toolStream?, commandInvocation? }`
- `{ type: 'done' }`
- `{ type: 'error', error }`

### `LlmStreamEvent`
- `{ type: 'request-id', requestId }`
- `{ type: 'delta', text }` — no `kind`, no tool fields
- `{ type: 'tool_use', id, name, input, provider? }`
- `{ type: 'tool_result', id, result }` — `result: unknown`, intentionally
- `{ type: 'tool_error', id, error }`
- `{ type: 'done' }`
- `{ type: 'error', error, errorDetail? }` — `errorDetail` powers the SystemMessage row's "Details" disclosure

## Sender Wiring

| Layer | Agent | LLM |
|-------|-------|-----|
| Streaming service | `services/a2aStreamingService.ts` — `StreamPort.postMessage(AgentStreamEvent)` | `services/chatStreamingService.ts` — `StreamPort.postMessage(LlmStreamEvent)` |
| Accumulator (agent only) | `agents/streamPartsAccumulator.ts` — `DeltaPort.postMessage(AgentDeltaEvent)` (narrower; subtype-assignable from `StreamPort`) | n/a |
| IPC pre-flight errors | `ipc/agent_a2a.ipc.ts` — uses `postAgentError(port, msg)` from `ipc/_streamPort.ts` | `ipc/llm.ipc.ts` — uses `postLlmError(port, msg)` from `ipc/_streamPort.ts` |

**Rule:** Every outbound stream frame must go through a typed surface. Raw `port.postMessage({ … })` is forbidden — use the typed `StreamPort` (in services) or the `postAgentError` / `postLlmError` helpers (in IPC handlers).

## Bridge & Receiver Wiring

| Layer | Agent | LLM |
|-------|-------|-----|
| Preload bridge | `preload/index.ts::agents.sendMessage` — `onEvent: (event: AgentStreamEvent) => void` | `preload/index.ts::llm.sendMessage` — `onEvent: (event: LlmStreamEvent) => void` |
| Runtime guard | `isAgentStreamEvent(x): x is AgentStreamEvent` in the shared module | `isLlmStreamEvent(x): x is LlmStreamEvent` in the shared module |
| Receiver | `hooks/useChatStream.ts::handleAgent` | `hooks/useChatStream.ts::handleLlm` |

Preload's `channel.port1.onmessage` runs the guard, `console.warn`'s and drops off-contract messages, and only then forwards to `onEvent`. Guards check the discriminator only — payload shape is enforced by TypeScript narrowing in the receiver's switch.

## Adding a New Event Variant

1. Add the interface to the matching `src/shared/{agent,llm}StreamEvents.ts` (with JSDoc explaining when it fires)
2. Add it to the `…StreamEvent` union alias
3. Add its `type` literal to the guard's discriminator list (`is…StreamEvent`)
4. Emit it from the sender (`StreamPort.postMessage` typecheck enforces the shape)
5. Handle it in `useChatStream.handle{Agent,Llm}`'s switch (unhandled cases fall through silently — that's the forward-compat contract)

Adding a new field on an existing variant only requires step 1; the compiler flags every sender and receiver that doesn't satisfy the new shape.

## Subtype Assignment Quirk

`DeltaPort.postMessage(AgentDeltaEvent)` is **narrower** than `StreamPort.postMessage(AgentStreamEvent)`. `StreamPort` is assignable to `DeltaPort` via function-parameter contravariance (a postMessage that accepts the full union can be called with just `AgentDeltaEvent`). No cast needed when `a2aStreamingService` hands its port to the accumulator.

## Discriminated Narrowing in Receivers

`useChatStream.handle{Agent,Llm}` use `switch (event.type)` — each case narrows `event` to the matching variant. **Do not write `event.text!` / `event.id!` / `event.x ?? 'fallback'`** — fields the union marks required are guaranteed inside the case branch. Optional fields (e.g. `LlmErrorEvent.errorDetail`) stay `T | undefined`.

## Trust Boundary

The contextBridge `as`-cast was replaced by the runtime guards described above. Senders are also typed, so both ends must drift simultaneously for an off-contract event to pass — defense-in-depth, not the primary mechanism.

## References

- Shared unions: `src/shared/agentStreamEvents.ts`, `src/shared/llmStreamEvents.ts`
- Sender ports: `src/main/services/a2aStreamingService.ts`, `src/main/services/chatStreamingService.ts`, `src/main/agents/streamPartsAccumulator.ts`
- IPC error helpers: `src/main/ipc/_streamPort.ts`
- Preload bridge: `src/preload/index.ts`
- Receiver: `src/renderer/src/hooks/useChatStream.ts`
- Adjacent contracts: [A2A Streaming Pipeline](../../agents/agents/streaming_pipeline.md) (the `cinna.*` metadata contract that drives `AgentDeltaEvent` payloads), [Messaging](../../chat/messaging/messaging.md) (LLM streaming flow)
