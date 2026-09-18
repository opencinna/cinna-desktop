# AI Functions

## Purpose

Run a short text transformation for titles and agent drafts with one output string, no chat history and no tools. Its billing/runtime choice is independent of the chat mode and of the agent being drafted.

## Core Concepts

- **Explicit binding** — Settings → Features → AI Functions credential and model. Empty credential selects the Default runtime; an unavailable explicitly selected credential is an error, never an excuse to spend another key.
- **Adapter backend** — a configured provider SDK executes one request with system/user messages. Adapter types, credential testing and catalogs remain available; adapters no longer drive conversational chat/tool loops.
- **Runtime backend** — a fresh ACP session on a compatible pooled process, using a no-tools utility profile. Its session address is never saved or loaded again.

## User Stories / Flows

1. Select an AI Functions credential/model or leave Default runtime selected. Changing credential clears the model selection.
2. Drafting may start a cold runtime and waits for the result. Background titles request a warm process only; without one they defer, leaving the ordinary derived title in place.
3. A runtime utility receives the function's instructions as its system prompt and the caller's text as user input. It never receives a chat's transcript or attached connectors.

## Business Rules

- `aiFunctions.resolveBackend(userId)` resolves the explicit credential across shared/default and active managed scopes. It does not read the default chat mode to choose an adapter.
- Both backends obey caller cancellation, a 90-second ceiling and a maximum 16000 output characters; callers can request a smaller cap. Whitespace-only output is an error.
- The runtime session is canceled/unbound after one reply. ACP has no session/delete; discarding the address is the non-reuse boundary. A late session/new after cancellation is canceled before any prompt.
- Claude/OpenCode enforce their synthetic no-native-tools policy. Codex uses the [verified restricted profile](../../agents/local_agents/codex_engine_tech.md#restricted-chat-and-ai-function-policy), available only for the pinned CLI version on POSIX with a bundled model; unsupported configurations refuse. Selecting an AI Functions credential remains an independent alternative.
- OpenCode utility processes are keyed by the exact function system prompt as well as profile/runtime/credential/model. Repeated matching functions reuse that process with fresh sessions. A warm synthetic chat has a fixed title-only companion mode; only the shared title prompt may reuse it. Claude keeps function instructions in its per-session system prompt. Codex uses a stable process cwd and patched per-session developer instructions, so a compatible warm chat process can answer a fresh utility session without inheriting the chat prompt. Each utility has its own session cwd, no MCP descriptors and no saved transcript; instruction files are not used as an additional Codex prompt channel.
- Background title generation does not create a process merely to title a chat. Drafting and chat execution may deliberately use different backends.
- Errors use `AiFunctionError`: no_provider, llm_failed or empty_output. Secret values stay in main and never appear in the settings status.

## Architecture Overview

Title/draft caller → resolveBackend → runSingleShot → one provider SDK request or fresh no-tools ACP session → trimmed, capped string.

## Integration Points

- [Settings](../../ui/settings/settings.md) — independent credential/model selectors.
- [Runtime orchestration](../../chat/orchestrated_agents/orchestrated_agents.md) — pooled processes and synthetic policy.
- [Auto titles](../../chat/auto_titles/auto_titles.md) — warm-only background behavior.
- [LLM adapters](../adapters/adapters.md) — one-shot provider implementation and model discovery.

## Technical Reference

`src/main/services/aiFunctionsService.ts` owns resolution and common timeout/output limits; `src/main/services/aiFunctionRuntimeService.ts` owns the throwaway session lifecycle; `src/main/agents/drivers/index.ts` prepares runtime plans; `src/main/services/syntheticRuntimePooling.ts` owns compatibility keys. Settings keys are aiFunctionsCredentialId and aiFunctionsModelId; empty strings mean no explicit selection.
