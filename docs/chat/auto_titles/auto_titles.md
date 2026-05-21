# Auto Chat Titles

## Purpose

Opt-in background feature that replaces the renderer's truncated first-message fallback title with a concise LLM-generated title (≤ 40 chars) after the user's first message in a new chat. Off by default; lives under Settings → Features → AI Functions. Fire-and-forget — every failure mode is logged and swallowed, the streaming flow is never affected.

## Core Concepts

- **`autoChatTitles` toggle** — Installation-global boolean in the `app_settings` KV store. Off by default. Controls whether the title-gen trigger fires at all.
- **First-message trigger** — Fire-and-forget hook in `messageRoutingService.prepareLlmSend` / `prepareAgentSend`. Runs after every user-message persist; the title service self-checks "is this actually the first user message?" so callers stay one-liners.
- **Untouched auto-title** — A chat is considered "still using an auto-generated title" when its current title is either the DB default `'New Chat'` or the renderer's truncated-first-message fallback (see [`deriveTitleFromMessage`](#shared-truncation-rule)). Both shapes are safe to overwrite; anything else is treated as a user edit and never overwritten.
- **Mid-flight rename race** — The user can rename a chat while the LLM call is in flight. The service re-reads the chat title right before writing and bails if the title no longer matches an "untouched auto-title". A real rename always wins over a slow generation.
- **Title broadcast** — `chats:title-updated` event sent from main → renderer when a title successfully writes. Renderer invalidates the chat list + the active chat detail so sidebar and header refresh instantly.
- **Shared truncation rule** — Single source of truth in `src/shared/chatTitle.ts` for the renderer's truncated-title fallback (`message ≤ 50 chars` → message; else `first 50 + '…'`). Used by both the renderer (to compute the fallback) and the main-process title service (to recognise it).

## User Stories / Flows

### Enabling the feature

1. User opens Settings → Features
2. Toggles "Auto-generate chat titles" on
3. The change is persisted via the `app_settings` IPC; subsequent sends will trigger title generation

### First message in a new chat (LLM channel)

1. User opens a new chat and sends their first message
2. Renderer stamps the chat with the truncated-message fallback title and starts the LLM stream
3. Main process persists the user message via `messageRoutingService.prepareLlmSend`
4. Routing service fires `chatTitleService.autoGenerateForFirstMessage` in the background (fire-and-forget) — the streaming pipeline is not awaited on this
5. Title service confirms the feature is on, the user-message count is exactly 1, the chat's current title is an untouched auto-title, and runs a one-shot LLM call against the user's default chat mode (`aiFunctions.resolveAdapterFromDefaultMode`)
6. The model returns a short title; it is sanitised (quote/punct/whitespace stripping, hard 40-char cap)
7. Service re-reads the chat title, confirms still untouched, then persists the new title and broadcasts `chats:title-updated`
8. Renderer sidebar (chat list) and active chat header pick up the new title instantly via React Query cache invalidation

### First message in a new chat (agent channel)

Identical to the LLM flow except step 3 uses `prepareAgentSend` instead of `prepareLlmSend`. The title-gen path is channel-agnostic and always uses the user's default chat mode for the title call (not the agent itself).

### Non-first sends

On every subsequent user message, the routing service still fires the trigger; the title service short-circuits via the user-message-count check (`countByRole(chatId, 'user') !== 1`) before the LLM call. Cost: one `SELECT COUNT(*)` per send.

### Failures

- No default chat mode / no provider configured → service throws `no_provider`, caller logs `warn`, chat keeps its fallback title.
- LLM call fails (network, auth, rate limit) → `llm_failed`, warn, fallback kept.
- Model returns empty or sanitises to empty → `empty_output`, warn, fallback kept.
- User renames the chat during the LLM call → `chat_renamed_mid_flight`, info (rare-but-interesting), the rename wins.
- User pre-renamed the chat before the trigger ran → `chat_renamed_initial`, debug (expected on subsequent sends).

In all cases, the user-visible streaming flow is untouched.

## Business Rules

### Toggle scope

- The `autoChatTitles` flag is **installation-global**, not per-profile. Same scope as Chat Modes and LLM Providers (settings-scope shared `__default__`).
- Defaults to off. A fresh install (or a missing row in `app_settings`) reads as `false`.

### Trigger placement

- Trigger lives in `messageRoutingService` — `prepareLlmSend` and `prepareAgentSend` both fire it after the user message is persisted. No other path triggers title generation.
- The trigger is unconditional at the routing-service level. All checks (toggle, first-message, untouched title) live in the title service itself, so adding a new send channel only requires one extra `fireTitleGenInBackground` call.
- Chats whose first message is a system action (e.g. job-spawned chats that pre-populate state) do not go through routing-service paths and therefore do not auto-generate titles.

### What counts as the "first user message"

- "First" is determined by `messageRepo.countByRole(chatId, 'user') === 1` evaluated **after** the new user message is persisted by the routing service.
- Tool calls, assistant turns, agent transitions, and error rows are not counted.
- If two sends race (extremely rare — the renderer awaits the previous stream), the loser sees `count === 2` and skips.

### What counts as an "untouched" title

- Exactly `'New Chat'` (the DB default seeded by `chatRepo.create`).
- Exactly `deriveTitleFromMessage(firstUserText)` (the renderer's truncated-message fallback).
- Anything else is treated as a user edit and never overwritten.

### Title generation

- The LLM is the user's **default chat mode**'s provider/model, resolved via `aiFunctions.resolveAdapterFromDefaultMode`. The chat's own mode (if different) is not used — the title is a global utility call, not part of the conversation.
- One-shot call, no tools, no streaming surfaced to the caller.
- System prompt asks for a concise title in the user's language, no markdown, no quotes, no trailing punctuation. Hard cap 40 characters.
- Output is sanitised: quotes/backticks stripped, whitespace collapsed, trailing punctuation removed. If sanitisation produces an empty string, treated as `empty_output` and skipped.

### Mid-flight rename protection

- After the LLM responds and before the title is written, the service re-reads the chat and re-checks `isUntouchedAutoTitle`. A user rename during the LLM call always wins.
- The `chat_not_found` outcome is treated the same way — if the chat was deleted mid-generation, the write is skipped.

### Cost and observability

- Every user message incurs one `SELECT COUNT(*)` against `messages` for the early-out (sub-ms in SQLite).
- A first-message send incurs one targeted `SELECT … LIMIT 1` for the message body plus one one-shot LLM call (typically << 1s).
- Title generation uses the same provider/model the user pays for in their default chat mode. The Features-tab UI flags this to the user ("Uses your default chat mode's LLM provider — consumes tokens").
- Log lines (`chat-title` scope) categorise outcomes by code so the logger overlay (Cmd+`) can show success/failure distribution without trawling.

## Architecture Overview

```
User sends first message
   │
   ▼
Renderer (useNewChatFlow.startNewChat)
   ├── createChat()                         → DB chat row, title = 'New Chat'
   ├── deriveTitleFromMessage(message)      → shared truncation
   ├── updateChat({ title: truncated, … })  → renderer fallback applied
   └── startLlm / startAgent                → IPC send
           │
           ▼
Main: messageRoutingService.prepareLlmSend / prepareAgentSend
   ├── messageRepo.saveUser(...)            → user row persisted
   └── fireTitleGenInBackground(userId, chatId)        (fire-and-forget)
           │
           ▼
chatTitleService.autoGenerateForFirstMessage
   ├── appSettingsRepo.get('autoChatTitles')        → feature_disabled?
   ├── chatRepo.getOwned(userId, chatId)            → chat_not_found?
   ├── messageRepo.countByRole(chatId, 'user')       → not_first_message?
   ├── messageRepo.firstByRole(chatId, 'user')       → first user text
   ├── isUntouchedAutoTitle(chat.title, firstText)   → chat_renamed_initial?
   ├── aiFunctions.resolveAdapterFromDefaultMode(userId)  → no_provider?
   ├── aiFunctions.runSingleShot(...)                → llm_failed / empty_output?
   ├── sanitizeTitle(raw)                            → empty_output?
   ├── chatRepo.getOwned(...) re-read                → chat_renamed_mid_flight?
   ├── chatRepo.updateMeta({ title })
   └── win.webContents.send('chats:title-updated', { chatId, title })
           │
           ▼
Renderer (useChatList effect)
   └── invalidate ['chats'] + ['chat', chatId]      → sidebar + header refresh
```

## Integration Points

- [AI Functions](../../llm/ai_functions/ai_functions.md) — Underlying one-shot LLM primitive. The title service is the second consumer (after [Multi-Agent Chats](../multi_agent/multi_agent.md)'s Smart Rewrite).
- [Chat Modes](../chat_modes/chat_modes.md) — The user's default chat mode supplies the provider/model used for the title LLM call (`resolveAdapterFromDefaultMode`).
- [Messaging](../messaging/messaging.md) — Defines the `messages` table the COUNT/first-message queries target, and the `prepareLlmSend` chokepoint where the trigger fires.
- [Multi-Agent Chats](../multi_agent/multi_agent.md) — Title generation also fires on `prepareAgentSend`, so agent-routed first messages get titles too.
- [Settings](../../ui/settings/settings.md) — The Features tab hosts the toggle.
- [Settings Scope](../../core/settings_scope/settings_scope.md) — `app_settings` is installation-global (no `user_id` column), matching the scope of Chat Modes and LLM Providers.

## Shared Truncation Rule

The rule the renderer uses to derive its fallback title from a first user message lives in `src/shared/chatTitle.ts` as `deriveTitleFromMessage(message)` + `AUTO_TITLE_MAX_FROM_MESSAGE = 50`. Both layers import it; if the rule ever changes (different limit, different ellipsis), the title service's "untouched" check stays in sync structurally — there is no second copy to update.
