# CLI Commands

## Purpose

Surfaces the shell commands that a Cinna agent exposes via its `CLI_COMMANDS.yaml` (see `CINNA_DESKTOP_CLI_COMMANDS_INTEGRATION.md`) as an in-input command picker. Typing `/` at the start of a word in the chat input opens a modal popup listing the active agent's CLI commands; selecting one inserts the invocation string (`/run:<slug>`) into the textarea so the user can send it.

## Core Concepts

- **CLI Command** — A named shell command declared in an agent's `docs/CLI_COMMANDS.yaml` (a file inside the remote agent's workspace, not in this repo). Exposed to external clients as an `AgentSkill` whose `id` starts with `cinna.run.` (or whose `tags` contain `cinna-run`). Invoking `/run:<slug>` in a chat runs the command server-side with no LLM turn. <!-- nocheck -->
- **Slug** — The portion of the skill id after `cinna.run.` — e.g. `cinna.run.check` → `check`. Used to form the invocation string when `examples[]` is absent on the skill.
- **Invocation string** — The text inserted into the textarea on selection. Sourced from `skill.examples[0]`, falling back to `/run:<slug>`.
- **Prompt-source agent** — Same rule as the `#` (example-prompts) picker: in an active chat it's the chat's bound agent, on the new-chat screen it's the agent currently selected via the agent selector or `@`-mention.
- **`/` trigger** — Typing `/` at the start of the input or after whitespace opens the CLI-command popup. The popup replaces the `/filter` token with the chosen command's invocation string when accepted.

## User Stories / Flows

1. User opens a chat bound to a cinna agent (or selects one on the new-chat screen)
2. User types `/` at the start of a word → a popup opens above the input listing the agent's CLI commands
3. User filters by typing characters (matched against slug, name, command string, and description)
4. User navigates with ArrowUp/ArrowDown and accepts with Enter or Tab → the `/filter` token is replaced by the full invocation string (e.g. `/run:check`)
5. User can edit further or send as-is — selecting does **not** auto-send
6. Pressing Escape, clicking outside, or moving the cursor past a whitespace boundary closes the popup without inserting

## Business Rules

- CLI commands only come from agents that expose `cinna.run.*` skills (or skills tagged `cinna-run`) on their agent card. Agents without such skills leave the `/` trigger inert.
- The agent card is fetched on demand from the main process with the agent's resolved access token. Fetch results are cached via TanStack Query with a 15 s stale time; card refreshes happen automatically when the prompt-source agent changes or the window regains focus (matches the backend's "re-fetch when the user returns to the agent screen" guidance).
- Empty `CLI_COMMANDS.yaml`, missing card, or a card-fetch error all collapse to "no commands" — the `/` trigger is silently disabled.
- The `/` trigger shares the popup-state slot in `ChatInput` with `@` and `#` — only one popup is open at a time; switching trigger characters replaces the popup's contents.
- Unlike `#`, there is no pre-input tag cloud — commands only surface via the modal popup.
- Selecting a command inserts text; the user must still press Enter or click Send to dispatch the message. The backend's `/run:*` routing then executes the shell command without an LLM turn.
- `/` is only recognised as a trigger at the start of input or after whitespace — typing a slash mid-word (e.g. inside a file path) does nothing.

## Architecture Overview

```
Renderer:
  promptSourceAgent (boundAgent ?? selectedAgent)
    └─ useCliCommands(agent.id)            [TanStack Query]
         │
         ▼
  ChatInput
    '/' in textarea → CliCommandPopup
      select → replace '/filter' with command.command (e.g. "/run:check")

Main process:
  agent:list-cli-commands IPC
    └─ agentService.listCliCommands(userId, agentId)
         │
         ├─ fetchAgentCard(agent.cardUrl, accessToken)
         └─ extractCliCommands(card.skills)   [shared/cliCommands.ts]
```

## Integration Points

- [Agents](../../agents/agents/agents.md) — The `/` picker works for any A2A agent with a card URL; access tokens are resolved the same way as normal A2A messaging.
- [Remote Agents](../../agents/remote_agents/remote_agents.md) — Cinna-synced agents are the primary source of CLI commands (the backend enforces the `CLI_COMMANDS.yaml` contract).
- [Example Prompts](../example_prompts/example_prompts.md) — Shares the trigger-popup state machine with `@` and `#` inside `ChatInput`.
- [Messaging](../messaging/messaging.md) — A selected command becomes ordinary message text; the normal send flow dispatches it to the agent, which executes the shell command server-side.
- [Keyboard Shortcuts](../../ui/keyboard_shortcuts/keyboard_shortcuts.md) — The `/` trigger reuses the ArrowUp/Down/Enter/Tab/Esc popup conventions documented there.
