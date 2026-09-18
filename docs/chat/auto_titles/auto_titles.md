# Auto Chat Titles

## Purpose

Opt-in background feature that replaces the renderer's truncated first-message fallback title with a concise LLM-generated title (≤ 40 chars) after the user's first message in a new chat. Off by default; lives under Settings → Features → AI Functions. Fire-and-forget — every failure mode is logged and swallowed, the streaming flow is never affected.

A chat whose root agent runs on **Codex** is the exception: Codex names its own thread, and that title names the chat instead. Cinna runs no AI title of its own for such a chat, whatever the toggle says (see [Codex chats are named by Codex](#codex-chats-are-named-by-codex)).

## Core Concepts

- **`autoChatTitles` toggle** — Installation-global boolean in the `app_settings` KV store. Off by default. Controls whether the title-gen trigger fires at all.
- **First-message trigger** — Fire-and-forget hook in `messageRoutingService.prepareAgentSend`, the one send path: a plain chat is answered by its chat-owned Default runtime, so it goes through the agent path too. Runs after every user-message persist; the title service self-checks "is this actually the first user message?" so callers stay one-liners.
- **Engine title** — The title an agent's engine gives its own session. Only Codex's is used: it reports `session_info_update { title }` twice, first a **placeholder** that is the prompt verbatim, then the title its own model generated. The second names the chat.
- **Untouched auto-title** — A chat is considered "still using an auto-generated title" when its current title is either the DB default `'New Chat'` or the renderer's truncated-first-message fallback (see [`deriveTitleFromMessage`](#shared-truncation-rule)). Both shapes are safe to overwrite; anything else is treated as a user edit and never overwritten.
- **Mid-flight rename race** — The user can rename a chat while the LLM call is in flight. The service re-reads the chat title right before writing and bails if the title no longer matches an "untouched auto-title". A real rename always wins over a slow generation.
- **Title broadcast** — `chats:title-updated` event sent from main → renderer when a title successfully writes. Renderer invalidates the chat list + the active chat detail so sidebar and header refresh instantly.
- **Shared truncation rule** — Single source of truth in `src/shared/chatTitle.ts` for the renderer's truncated-title fallback (`message ≤ 50 chars` → message; else `first 50 + '…'`). Used by both the renderer (to compute the fallback) and the main-process title service (to recognise it).

## User Stories / Flows

### Enabling the feature

1. User opens Settings → Features
2. Toggles "Auto-generate chat titles" on
3. The change is persisted via the `app_settings` IPC; subsequent sends will trigger title generation

### First message in a new chat

1. User opens a new chat and sends their first message
2. Renderer stamps the chat with the truncated-message fallback title and starts the run
3. Main binds the chat's root — the chat-owned Default runtime for a plain chat, or the agent the chat was started with — and persists the user message via `messageRoutingService.prepareAgentSend`
4. Routing service fires `chatTitleService.autoGenerateForFirstMessage` in the background (fire-and-forget) — the streaming pipeline is not awaited on this
5. Title service confirms the feature is on, the user-message count is exactly 1, the chat's current title is an untouched auto-title, and runs a one-shot AI Functions call through `aiFunctions.resolveBackend`
6. The model returns a short title; it is sanitised (quote/punct/whitespace stripping, hard 40-char cap)
7. Service re-reads the chat title, confirms still untouched, then persists the new title and broadcasts `chats:title-updated`
8. Renderer sidebar (chat list) and active chat header pick up the new title instantly via React Query cache invalidation

The title call always uses the AI Functions binding, never the agent answering the chat. On the Default runtime it runs only on a process that is already warm; in a brand-new plain chat none is warm yet at step 4, so the call is deferred and retried once when the first turn completes (see Trigger placement).

### Codex chats are named by Codex

1. User sends the first message in a chat whose root runs on Codex (a Codex Default runtime, or a Codex folder agent)
2. The send path sees that the root's engine names the chat, and does **not** fire Cinna's title trigger — neither at persist nor after the turn
3. Codex reports its placeholder title (the prompt echoed back); the driver recognises it against the prompts it sent that session and drops it
4. After the turn, Codex reports the title its own model generated; the driver hands it to the title service, which checks that the reporting agent is the chat's root and that the chat's title is still untouched, sanitises it (same 40-char cap) and writes and broadcasts it as above
5. If Codex never sends a title, the derived fallback title stays — there is no fallback to Cinna's AI title

### Non-first sends

On every subsequent user message, the routing service still fires the trigger; the title service short-circuits via the user-message-count check (`countByRole(chatId, 'user') !== 1`) before the LLM call. Cost: one `SELECT COUNT(*)` per send.

### Failures

- The AI Functions credential is deleted, disabled, missing its API key or unsupported → the call runs on the Default runtime instead (warned once per stale credential in the `ai-functions` log); it does not fail. See [AI Functions](../../llm/ai_functions/ai_functions.md).
- The Default runtime has no warm process → the call is deferred, the fallback title is kept, and the after-turn retry tries again.
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

- Trigger lives in `messageRoutingService.prepareAgentSend`, fired after the user message is persisted. The one other trigger is the after-turn retry below.
- When an agent turn completes (and its input was not desktop-authored), the trigger fires once more. A warm-only title cannot run at first-message persist in a brand-new plain chat — that turn has not spawned its process yet — so titles on the Default runtime never appeared. Turn completion is the first moment the process is warm. Every precondition still applies, so the retry is a no-op after the first exchange or once a title exists; a chat with a title call still in flight is skipped rather than doubled.
- The trigger is unconditional at the routing-service level. All checks (toggle, first-message, untouched title) live in the title service itself, so adding a new send channel only requires one extra `fireTitleGenInBackground` call.
- Neither trigger fires for a chat whose root runs on Codex (the send path's `engineTitles`), so Cinna's title and Codex's never race for the same chat and the user's login is not charged a second title call — Codex already makes one of its own on every session ([The Codex Engine](../../agents/local_agents/codex_engine.md)). Decided per turn from the answering agent's row: a root, non-nested turn by an ACP agent on the stdio transport whose launcher is `codex`.
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

- The backend is the **AI Functions** credential/model or Default runtime, resolved via `aiFunctions.resolveBackend`. The chat's own mode (if different) is not used — the title is a global utility call, not part of the conversation.
- One-shot call, no tools, no streaming surfaced to the caller.
- System prompt asks for a concise title in the user's language, no markdown, no quotes, no trailing punctuation. Hard cap 40 characters.
- Output is sanitised: quotes/backticks stripped, whitespace collapsed, trailing punctuation removed. If sanitisation produces an empty string, treated as `empty_output` and skipped.

### Codex's title

- **Only the chat's root agent names the chat.** A specialist, a subagent's child session, an agent @-addressed in a human-routed chat and an AI Function's utility session report titles of their own; they speak for themselves, not the chat.
- **Only while the title is untouched** — the same rule as Cinna's AI title, so a title the user set is never replaced, and once Codex's title is written it is no longer "untouched" and a later one does not replace it.
- **Applied regardless of `autoChatTitles`.** The setting governs Cinna spending a model call; Codex makes its own title request whether Cinna uses the answer or not, and it cannot be switched off.
- **The placeholder is dropped by matching, not by position.** A title equal to a prompt recently sent to that session, or longer than 40 characters and the start of one (whitespace-normalised either way), is the echo; anything else is the real title. Were the placeholder applied, the chat would be named after the prompt itself.
- **A short title the prompt merely starts with is a real name.** Codex often names a thread with the prompt's opening words — "Fix flaky parser test" for "Fix flaky parser test and add coverage" — and treating any start of the prompt as the echo threw those names away and left the chat on its derived fallback title. 40 characters is longer than any title Codex generates, so only a cut that long is read as the prompt truncated.
- **A session this process never prompted names nothing.** After a restart a loaded session has no prompt to recognise its placeholder by, and was titled long ago anyway.
- **Only Codex.** Claude reports the same update; its titles are not used.

### Mid-flight rename protection

- After the LLM responds and before the title is written, the service re-reads the chat and re-checks `isUntouchedAutoTitle`. A user rename during the LLM call always wins.
- The `chat_not_found` outcome is treated the same way — if the chat was deleted mid-generation, the write is skipped.

### Cost and observability

- Every user message incurs one `SELECT COUNT(*)` against `messages` for the early-out (sub-ms in SQLite).
- A first-message send incurs one targeted `SELECT … LIMIT 1` for the message body plus one one-shot LLM call (typically << 1s).
- Title generation runs on the AI Functions credential/model chosen in Settings → Features, or the Default runtime when none is chosen (or the chosen one is unavailable). The toggle's description says so ("Uses the AI Functions runtime selected above.").
- A Codex chat costs Cinna no title call; Codex's own title request (on `gpt-5.6-luna`, once per session) is billed to the user's Codex login either way.
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
   └── startRun                             → IPC send (run:send)
           │
           ▼
Main: runExecutionService.runAgentTurn
   ├── chatConductorService.bind            → plain chat gets its Default runtime root
   ├── engineTitles = root turn on Codex?
   └── messageRoutingService.prepareAgentSend
          ├── messageRepo.saveUser(...)     → user row persisted
          └── engineTitles? ── no ──► fireTitleGenInBackground(userId, chatId)  (fire-and-forget)
                           └─ yes ─► (nothing; Codex names the chat, see below)
   … turn completes …
   └── retryTitleAfterTurn(userId, chatId, engineTitles)
          └── engineTitles? ── no ──► fireTitleGenInBackground again (warm process now)
           │
           ▼
chatTitleService.autoGenerateForFirstMessage
   ├── appSettingsRepo.get('autoChatTitles')        → feature_disabled?
   ├── chatRepo.getOwned(userId, chatId)            → chat_not_found?
   ├── messageRepo.countByRole(chatId, 'user')       → not_first_message?
   ├── messageRepo.firstByRole(chatId, 'user')       → first user text
   ├── isUntouchedAutoTitle(chat.title, firstText)   → chat_renamed_initial?
   ├── aiFunctions.resolveBackend(userId)            → credential, else Default runtime
   ├── aiFunctions.runSingleShot(... warmOnly)       → deferred / llm_failed / empty_output?
   ├── sanitizeTitle(raw)                            → empty_output?
   ├── chatRepo.getOwned(...) re-read                → chat_renamed_mid_flight?
   ├── chatRepo.updateMeta({ title })
   └── win.webContents.send('chats:title-updated', { chatId, title })
           │
           ▼
Renderer (useChatList effect)
   └── invalidate ['chats'] + ['chat', chatId]      → sidebar + header refresh

Codex root session: session_info_update { title }
   └── acpDriver → SessionTitles.observe             → placeholder (a sent prompt)? dropped
          └── chatTitleService.applyEngineTitle      → root agent? untouched title?
                 └── chatRepo.updateMeta + chats:title-updated (as above)
```

## Integration Points

- [AI Functions](../../llm/ai_functions/ai_functions.md) — Underlying one-shot LLM primitive. The title service is the primary consumer of `runSingleShot`.
- [Chat Modes](../chat_modes/chat_modes.md) — Features → AI Functions supplies the title backend (`resolveBackend`).
- [Messaging](../messaging/messaging.md) — Defines the `messages` table the COUNT/first-message queries target. The trigger fires from `prepareAgentSend`, the path every chat's first message takes.
- [The Codex Engine](../../agents/local_agents/codex_engine.md) — the thread-title request Codex makes on its own, whose answer names a Codex chat.
- [Settings](../../ui/settings/settings.md) — The Features tab hosts the toggle.
- [Settings Scope](../../core/settings_scope/settings_scope.md) — `app_settings` is installation-global (no `user_id` column), matching the scope of Chat Modes and LLM Providers.

## Shared Truncation Rule

The rule the renderer uses to derive its fallback title from a first user message lives in `src/shared/chatTitle.ts` as `deriveTitleFromMessage(message)` + `AUTO_TITLE_MAX_FROM_MESSAGE = 50`. Both layers import it; if the rule ever changes (different limit, different ellipsis), the title service's "untouched" check stays in sync structurally — there is no second copy to update.

Runtime fallback uses warmOnly: true. If no compatible process is warm, title generation defers and keeps the derived title; it does not spawn a process in the background. The deferred title is retried once, when the first turn completes (see Trigger placement). An explicit AI Functions credential still uses one SDK request.

A compatible warm Codex chat process can serve a fresh restricted title session with its own cwd, exact per-session developer instructions and no MCP descriptors. The chat transcript and prompt are not reused. Compatibility still requires the [verified Codex policy](../../agents/local_agents/codex_engine_tech.md#restricted-chat-and-ai-function-policy); an installed or merely selected runtime is not itself a warm process.
