# Example Prompts

## Purpose

Surfaces a remote agent's suggested starter prompts in two places — as a clickable tag cloud above the new-chat input when that agent is selected, and as a `#`-triggered picker inside any chat input. Lets users jump into a pre-written prompt without retyping it.

## Core Concepts

- **Example Prompt** — A string on a remote agent's `remoteMetadata.example_prompts` list. Typical shape: `label: full prompt text` (e.g. `dad-joke: tell me a dad joke`). The portion before the colon is the **label** (shown on the tag); the portion after is the **full** prompt (sent as the actual message).
- **Tag cloud** — Animated row of pill buttons rendered above the ChatInput on the new-chat screen when the currently-selected agent has example prompts. Clicking a tag starts a new chat with the full prompt as the first message.
- **`#` trigger** — Typing `#` at the start of a word inside ChatInput opens a popup listing example prompts (same keyboard behaviour as the `@`-mention popup). Selecting a prompt replaces the `#filter` token with the full prompt text.
- **Prompt-source agent** — The agent whose example prompts populate the popup. In an active chat, this is the chat's bound agent. On the new-chat screen, it is the currently selected agent.
- **Entry animation** — Each tag first fades in as a small circular badge, then expands horizontally into a full pill. The label text fades in during the expand phase. Tags are staggered by index via a CSS custom property.
- **Exit animation** — When the agent is deselected (or switched to one without prompts), the current tags fade out together before unmounting, pinned at their expanded dimensions so they don't collapse back to circles.

## User Stories / Flows

### Tag cloud on the new-chat screen

1. User selects a remote agent via the agent selector or `@`-mention
2. If that agent has example prompts, a tag cloud fades in above the input, each tag expanding from a circle to a pill
3. User clicks a tag → a new chat is created and the full prompt is sent as the first message, using the standard new-chat flow
4. User deselects the agent (or picks one without prompts) → tags fade out over 400 ms and unmount

### `#` picker inside an input

1. User types `#` at the start of the input or after whitespace
2. A popup opens above the input listing the prompt-source agent's example prompts
3. User filters by typing characters (matched against both label and full text), navigates with ArrowUp/ArrowDown, and picks with Enter or Tab
4. The `#filter` token is replaced in the textarea by the full prompt text; the user can edit it further or send as-is
5. Escape or clicking outside (but not on the textarea itself) closes the popup without inserting

## Business Rules

- Example prompts only come from remote agents — local agents store `remoteMetadata: null` and contribute no prompts
- A string is parsed as `label: full` only when it starts with a non-space, non-colon character followed by `:` and whitespace within 40 characters. Otherwise the full string is used as both label (truncated to 32 chars with an ellipsis) and full prompt
- Empty and non-string entries in `example_prompts` are filtered out
- The tag-cloud row always occupies `min-h-10` on the new-chat screen so the centered column's geometry does not reflow when tags appear or disappear
- Each tag's entry animation runs once on mount — switching agents remounts the tags (new animation key) so the animation replays for the new set
- The `#` trigger is gated by having a prompt-source agent with at least one example prompt — it's inert otherwise
- The `@` and `#` triggers share one popup-state slot in `ChatInput` — only one popup is open at a time; switching trigger characters replaces the popup's contents
- Selecting an example prompt in an active chat only inserts text into the textarea — it does not auto-send; the user must confirm with the send button or Enter
- Clicking a tag on the new-chat screen does auto-send — tags are a shortcut, not a drafting aid

## Architecture Overview

```
Backend sync:
  Cinna backend /api/v1/external/agents
    → agentService.syncRemoteAgents
      → agentRepo.syncRemote
        → agents.remote_metadata column (JSON RemoteAgentMetadata)

Renderer:
  useAgents() → AgentData.remoteMetadata.example_prompts
    ├─ MainArea (new-chat screen)
    │    extractExamplePrompts(selectedAgent)
    │    └─ ExamplePromptTags
    │         tag click → useNewChatFlow.startNewChat(prompt.full)
    │
    └─ ChatInput (both new-chat and active-chat)
         selectedAgent (new chat) OR boundAgent (active chat)
         '#' in textarea → ExamplePromptPopup
           select → replace '#filter' with prompt.full in textarea
```

## Integration Points

- [Remote Agents](../../agents/remote_agents/remote_agents.md) — Source of `example_prompts`; the backend sync stores them under `remoteMetadata`
- [Agents](../../agents/agents/agents.md) — The `#` picker works in any chat bound to a remote agent, including sessions that were themselves started via a tag click
- [Messaging](../messaging/messaging.md) — A tag click drives the standard new-chat flow; a `#` pick becomes ordinary message text that travels the same streaming pipeline
