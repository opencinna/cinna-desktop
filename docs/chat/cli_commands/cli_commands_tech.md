# CLI Commands — Technical Details

## File Locations

### Shared

| File | Role |
|------|------|
| `src/shared/cliCommands.ts` | Pure parsing helpers. `CliCommand` interface (`slug`, `name`, `description`, `command`) and `extractCliCommands(skills)` — walks an agent card's `skills[]`, filters for `id.startsWith("cinna.run.")` or `tags` including `cinna-run`, and normalises each into a `CliCommand`. Imported from both main (card extraction) and preload (type surface). |

### Main Process

| File | Role |
|------|------|
| `src/main/services/agentService.ts` | `listCliCommands(userId, agentId)` — loads the agent row, resolves its access token, calls `fetchAgentCard(cardUrl, token)`, and returns `extractCliCommands(card.skills)`. Returns `[]` for non-A2A agents or agents without a `cardUrl`. Does not persist — the card cache is still driven by `testAgent`. |
| `src/main/ipc/agent_a2a.ipc.ts` | Registers `agent:list-cli-commands` handler. Wraps `agentService.listCliCommands` in `ipcErrorShape` and returns `{ success, commands, error? }`. |
| `src/main/agents/a2a-client.ts` | Unchanged — `fetchAgentCard` is reused for the on-demand card fetch. |

### Preload

| File | Role |
|------|------|
| `src/preload/index.ts` | Exposes `window.api.agents.listCliCommands(agentId)` returning `{ success, commands: CliCommand[], error? }`. Imports `CliCommand` from `src/shared/cliCommands.ts`. |

### Renderer

| File | Role |
|------|------|
| `src/renderer/src/hooks/useCliCommands.ts` | TanStack Query hook. Query key `['agents', 'cli-commands', agentId]`, `enabled` gated on a truthy `agentId`, `staleTime: 15_000`. Re-exports `CliCommand` for colocation with consumers. |
| `src/renderer/src/components/chat/CliCommandPopup.tsx` | Presentational `/` popup. Same contract as `ExamplePromptPopup` — receives pre-filtered `items`, a `selectedIndex`, and emits `onSelect` / `onClose`. Renders each command's invocation string (`cmd.command`) as the primary label, the skill's `name` as a trailing tag, and the first line of the description underneath. Uses `lucide-react`'s `Terminal` icon. |
| `src/renderer/src/components/chat/ChatInput.tsx` | Adds `/` to `TriggerChar` and to `findTriggerToken`. Invokes `useCliCommands(promptSourceAgent?.id)` alongside the existing prompt extraction; memoises the result array. New `filteredCommands`, `commandPopupOpen`, `selectCommand`, and a `commandGate` in `handleInput`. `activeListLength` and the Enter/Tab branch extended to cover the command popup. ARIA wiring (`aria-expanded`, `aria-controls`, `aria-activedescendant`) extended. |

## Database Schema

None. CLI commands are fetched fresh from the agent card every time they are requested — nothing new is persisted.

## IPC Channels

| Channel | Direction | Payload | Response |
|---------|-----------|---------|----------|
| `agent:list-cli-commands` | renderer → main | `agentId: string` | `{ success: boolean; commands: CliCommand[]; error?: string }` |

## Services & Key Methods

- `src/main/services/agentService.ts::listCliCommands(userId, agentId)` — fetches the agent card and returns parsed CLI commands. Throws `AgentError('not_found')` if the agent row isn't owned by the user; returns `[]` for non-A2A agents or missing card URLs.
- `src/shared/cliCommands.ts::extractCliCommands(skills)` — pure parser. Accepts `unknown` (defensive against raw card JSON), filters by skill id prefix `cinna.run.` or tag `cinna-run`, and derives `command` from `examples[0]` with a `/run:<slug>` fallback.

## Renderer Components

### CliCommandPopup

- Props: `items`, `selectedIndex`, `onSelect`, `onClose`, `listboxId`, `anchorRef?`
- Renders nothing when `items` is empty
- Scrolls the active `<button role="option">` into view on `selectedIndex` change
- Outside-click handler ignores clicks inside `anchorRef` so typing in the textarea doesn't close the popup
- Visual layout mirrors `ExamplePromptPopup` with a terminal icon and the invocation string (`/run:<slug>`) as the primary label

### ChatInput extensions

- `TriggerChar` union extended to `'@' | '#' | '/'`
- `findTriggerToken` scans backward for any of the three trigger characters
- `commandPopupOpen = triggerChar === '/' && commands.length > 0`
- `filteredCommands` matches against `slug`, `name`, `command`, and `description`
- `selectCommand(cmd)` replaces the `/filter` token with `cmd.command` (no auto-send, consistent with `#`)
- `commands` memoised via `useMemo(() => cliCommands ?? [], [cliCommands])` so the filter `useMemo` stays stable across renders that leave the query data unchanged

## Configuration

- No new settings, env vars, or feature flags. Discovery is entirely driven by the agent card's `skills[]` and the `cinna.run.*` / `cinna-run` convention documented in `CINNA_DESKTOP_CLI_COMMANDS_INTEGRATION.md`.

## Security

- Access tokens for the card fetch are resolved via the existing `agentService.resolveAccessToken` path — remote agents use the user's Cinna JWT, local agents use their encrypted per-agent token. No secrets cross the IPC boundary.
- Inserted invocation strings travel as plain text through the normal messaging pipeline; there is no client-side shell execution or expansion.
