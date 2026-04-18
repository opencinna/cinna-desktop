# Example Prompts — Technical Details

## File Locations

### Shared

| File | Role |
|------|------|
| `src/shared/agentMetadata.ts` | `RemoteAgentMetadata` interface — typed fields (`entrypoint_prompt`, `example_prompts`, `session_mode`, `ui_color_preset`, `protocol_versions`) plus an index signature for unknown backend extras. Imported from main, preload, and renderer. Type-only — no runtime code. |

### Main Process

| File | Role |
|------|------|
| `src/main/services/agentService.ts` | `syncRemoteAgents()` fetches `/api/v1/external/agents`, copies `example_prompts` (and the other typed fields) into the `metadata` payload handed to the repo. `synthesizeRemoteSkills()` also derives skill placeholders from the first five prompts so the existing skills UI remains populated. |
| `src/main/db/agents.ts` | `RemoteTarget.metadata` is typed as `RemoteAgentMetadata`. `agentRepo.syncRemote()` writes it to the `remote_metadata` column on upsert. |
| `src/main/db/schema.ts` | `agents.remoteMetadata` column: `text('remote_metadata', { mode: 'json' }).$type<RemoteAgentMetadata>()`. |

### Renderer

| File | Role |
|------|------|
| `src/renderer/src/utils/examplePrompts.ts` | `extractExamplePrompts(agent)` reads `agent.remoteMetadata?.example_prompts` and returns `ExamplePrompt[]`. `splitPrompt()` parses `label: body` via regex; entries without a recognisable label get a truncated label and the full string as the body. |
| `src/renderer/src/components/chat/ExamplePromptTags.tsx` | Animated tag cloud on the new-chat screen. Keeps its own `displayPrompts` / `displayKey` / `leaving` state so it can hold the current tags rendered while they fade out (400 ms) before unmounting. Uses `wasVisibleRef` to detect the non-empty → empty transition without reading stale state. Always renders its container (`min-h-10`) so the parent column does not reflow. |
| `src/renderer/src/components/chat/ExamplePromptPopup.tsx` | Presentational `#` popup. Receives already-filtered `items` from ChatInput and renders them as a `role="listbox"` with `role="option"` children. Accepts `anchorRef` so clicks inside the textarea are treated as "inside" for outside-click detection. |
| `src/renderer/src/components/chat/AgentMentionPopup.tsx` | Same presentational contract as the example-prompt popup — used by the `@` trigger. Updated in the same pass to accept filtered `items`, ARIA roles, and an `anchorRef`. |
| `src/renderer/src/components/chat/ChatInput.tsx` | Owns the trigger state machine. `findTriggerToken()` detects `@`/`#` at the cursor. `triggerChar`, `triggerFilter`, `triggerStart`, `triggerIndex` are shared state for both popups. `filteredAgents` and `filteredPrompts` are the single source of truth for list contents. `replaceTriggerToken(text)` splices the selection back into the textarea (empty string for agents — the binding callback carries the choice; full prompt text for `#` selections). A stable `useId()` listbox id drives `aria-controls` / `aria-activedescendant` on the textarea `role="combobox"`. |
| `src/renderer/src/components/layout/MainArea.tsx` | On the new-chat screen, derives `examplePrompts` via `useMemo(() => extractExamplePrompts(selectedAgent), [selectedAgent])` and renders `<ExamplePromptTags>` between the "What can I help with?" heading and `<ChatInput>`. Tag click calls `handleNewChat(prompt.full)` which routes through `useNewChatFlow.startNewChat`. Also passes `selectedAgent` to `ChatInput` so the `#` popup knows which prompts to show before any chat exists. |
| `src/renderer/src/assets/main.css` | CSS keyframes for the tag animations: `example-prompt-tag-fade-in` (opacity), `example-prompt-tag-expand` (max-width + padding), `example-prompt-tag-text-fade` (label opacity), and `example-prompt-tag-fade-out` (exit). `.example-prompt-tag` applies the two entry animations in sequence via per-animation `animation-delay` values; `.example-prompt-tag.is-leaving` pins the expanded dimensions and replaces the entry animation with the 400 ms fade-out. |

## Database Schema

- Table: `agents`
- Column: `remote_metadata` (`text` in JSON mode, nullable)
- Typed in Drizzle as `$type<RemoteAgentMetadata>()` via `src/main/db/schema.ts`
- Populated only for rows with `source='remote'`; local agents write `null`
- Migration: `src/main/db/migrations/agents.ts` adds the column; no migration was needed for this feature — the column already exists and this change narrows its TS type only

## IPC Channels

None added. The feature reads `remoteMetadata` off the existing `agents:list` response; no new main-process endpoints are required.

## Services & Key Methods

- `src/main/services/agentService.ts::syncRemoteAgents(userId)` — unchanged control flow; the `metadata` object passed to `agentRepo.syncRemote` now satisfies the `RemoteAgentMetadata` contract.
- `src/main/services/agentService.ts::synthesizeRemoteSkills(examplePrompts)` — existing helper that derives skill stubs from the first five prompts; independent of this feature but shares the input.

## Renderer Components

### ExamplePromptTags

- Props: `prompts: ExamplePrompt[]`, `onSelect(prompt)`, `animationKey: string`
- Internal state: `displayPrompts`, `displayKey`, `leaving`, `leaveTimerRef`, `wasVisibleRef`
- Effect deps: `[prompts, animationKey]`. On entry with non-empty prompts, swaps state immediately and resets `leaving`; on transition to empty, sets `leaving=true` and schedules a 400 ms timeout that clears `displayPrompts`. Timer is cleared on unmount and at the top of every effect run
- Each child button has a key composed of `displayKey`, index, and label so a new agent selection forces a remount and replays the entry animation
- `--tag-delay` is set inline per tag as `${i * 70}ms` — drives both fade-in and expand delays via `calc(var(--tag-delay, 0ms) + 400ms)` for the expand phase

### ExamplePromptPopup

- Props: `items`, `selectedIndex`, `onSelect`, `onClose`, `listboxId`, `anchorRef?`
- Renders nothing when `items` is empty
- Scrolls the active `<button role="option">` into view on `selectedIndex` change
- Outside-click handler ignores clicks inside `anchorRef` so typing in the textarea doesn't close the popup

### AgentMentionPopup

- Same contract as `ExamplePromptPopup`; invoked by the `@` trigger
- Shares the combobox wiring (listbox id, `aria-activedescendant`) with the `#` popup via the textarea in `ChatInput`

### ChatInput

- Trigger parsing: `findTriggerToken(value, cursorPos)` walks backward from the caret until it finds `@`/`#` at start or after whitespace, or gives up at a whitespace boundary
- `agentPopupOpen = triggerChar === '@' && !chatId && !!onSelectAgent` — agents are only mentionable on the new-chat screen
- `promptPopupOpen = triggerChar === '#' && examplePrompts.length > 0` — works in both new and active chats
- Shared keyboard handler: ArrowUp/Down cycles `triggerIndex` within `activeListLength`; Enter/Tab applies the current selection; Escape closes without inserting
- Textarea carries `role="combobox"`, `aria-expanded`, `aria-controls`, and `aria-activedescendant` referring to `${listboxId}-opt-${triggerIndex}` when a list item is available

### ExamplePromptTags layout rule

- The wrapper is always mounted on the new-chat screen and uses `min-h-10` so the centered column geometry is stable whether or not any tag is currently shown

## Configuration

- No new settings, env vars, or feature flags — rendering is driven entirely by `agent.remoteMetadata?.example_prompts`

## Security

- No credentials or secrets cross this surface; example prompts are plain text supplied by the Cinna backend via the already-scoped `agents:list` IPC response
- `#`-inserted text is placed into the textarea as a plain string; no HTML or markdown evaluation occurs at insertion time. It travels the normal messaging pipeline from there
