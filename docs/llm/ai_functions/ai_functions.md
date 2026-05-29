# AI Functions

## Purpose

Shared primitive for **one-shot LLM calls** — short, non-streaming, no-tools requests that compose a system prompt + user text and return a single trimmed string. Used today by Auto Chat Titles; substrate for future chat-summary and similar utility features that should not live inside the conversational streaming pipeline. The module also hosts the provider/model resolution shared with orchestration promotion.

## Core Concepts

- **One-shot call** — A single round-trip to an LLM with a fixed system prompt and a single user message. No streaming visible to the caller, no tool use, no multi-turn history.
- **Adapter resolution** — Picking which provider/model to run the call against: `resolveAdapterFromDefaultMode` returns a ready `{ adapter, modelId }` from the user's default chat mode (no chat involved — e.g. generating a title before the chat exists). A sibling `resolveProviderModelFromChatMode(userId, chatId)` returns the validated `{ providerId, modelId }` pair (chat mode → default mode → chat-bound) without building an adapter — used by orchestration promotion to pick the conductor model.
- **Labelled execution** — Each call site passes a short `label` (e.g. `chat-title`). The label is emitted in the log line so the same primitive serves many features without losing call-site identity in the logger overlay.

## Architecture Overview

```
Caller (chatTitleService, future summaryService)
   └── aiFunctions.resolveAdapterFromDefaultMode(userId)       -> { adapter, modelId }
   │
   └── aiFunctions.runSingleShot({ adapter, modelId, systemPrompt, userText, label, maxOutputChars?, signal? })
       -> Promise<string>   (trimmed, capped to maxOutputChars)
       -> throws AiFunctionError('no_provider' | 'llm_failed' | 'empty_output')

Promotion (chatService.promoteToOrchestrated)
   └── aiFunctions.resolveProviderModelFromChatMode(userId, chatId) -> { providerId, modelId }
       -> throws AiFunctionError('no_provider')
```

## Business Rules

- Adapter resolution always reads chat modes and LLM providers from the **settings scope** (the shared `__default__` user), matching the rest of the app's scope discipline. The caller-supplied `userId` is used only for chat ownership when scoping to a chat.
- The system prompt is sent as a real `role: 'system'` message — the adapters route it correctly per provider (Anthropic top-level `system` field, Gemini `systemInstruction`, OpenAI inline `system` role).
- Output is trimmed and optionally truncated by `maxOutputChars`. An empty trimmed output throws `empty_output`.
- Logs go to scope `ai-functions`. Successful calls log `single-shot complete` with `{ label, modelId, providerType, duration, inLen, outLen }`. Failures log `single-shot failed` with the underlying error.

## Composing a new AI function

For a new feature, follow this template inside its own service:

1. Resolve an adapter via the appropriate helper.
2. Build a domain-specific system prompt + user text.
3. Call `aiFunctions.runSingleShot` with a descriptive `label`.
4. Catch `AiFunctionError` and map its `code` to your feature's domain error so the renderer-facing surface stays stable.

See `chatTitleService` for the reference implementation.

## Integration Points

- [LLM Adapters](../adapters/adapters.md) — `runSingleShot` invokes `adapter.stream` and consumes the result without exposing deltas to the caller.
- [Auto Chat Titles](../../chat/auto_titles/auto_titles.md) — Background title generation uses `runSingleShot` (via `resolveAdapterFromDefaultMode`) after the first user message in a new chat.
- [Orchestrated Agents](../../chat/orchestrated_agents/orchestrated_agents.md) — In-chat promotion resolves the conductor model via `resolveProviderModelFromChatMode`; no provider → the promotion is refused.

## Technical Reference

- Service: `src/main/services/aiFunctionsService.ts`
- Error class: `AiFunctionError` (codes: `no_provider`, `llm_failed`, `empty_output`)
- Settings scope helper: `src/main/auth/scope.ts` → `getSettingsScopeUserId()`
- Logger scope: `ai-functions`
