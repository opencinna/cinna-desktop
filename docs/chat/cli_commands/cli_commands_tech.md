# CLI Commands — Technical Details

## File Locations

### Shared

| File | Role |
|------|------|
| `src/shared/cliCommands.ts` | Pure parsing helpers. `CliCommand` interface (`slug`, `name`, `description`, `command`) and `extractCliCommands(skills)` — walks an agent card's `skills[]`, filters for `id.startsWith("cinna.run.")` or `tags` including `cinna-run`, and normalises each into a `CliCommand`. Imported from both main (card extraction) and preload (type surface). |

### Main Process

| File | Role |
|------|------|
| `src/main/services/agentService.ts` | `listCliCommands(userId, agentId)` — loads the agent row, resolves its access token, calls `fetchAgentCard(cardUrl, token)`, and returns `extractCliCommands(card.skills)`. Returns `[]` for non-A2A agents or agents without a `cardUrl`. Emits a trace log with `{ agentId, count, durationMs }` on success. Does not persist — the card cache is still driven by `testAgent`. |
| `src/main/ipc/agent_a2a.ipc.ts` | Registers `agent:list-cli-commands` handler. Wraps `agentService.listCliCommands` in `ipcErrorShape` and returns `{ success, commands, error? }`. Network-family failures (ECONN*, ETIMEDOUT, terminated, socket hang up, …) are logged at `debug` to avoid flooding the logger overlay during transient backend blips; other failures stay at `warn`. |
| `src/main/agents/a2a-client.ts` | Unchanged — `fetchAgentCard` is reused for the on-demand card fetch. |

### Preload

| File | Role |
|------|------|
| `src/preload/index.ts` | Exposes `window.api.agents.listCliCommands(agentId)` returning `{ success, commands: CliCommand[], error? }`. Imports `CliCommand` from `src/shared/cliCommands.ts`. |

### Renderer

| File | Role |
|------|------|
| `src/renderer/src/hooks/useCliCommands.ts` | TanStack Query hook. Query key `['agents', 'cli-commands', agentId]`, `enabled` gated on a truthy `agentId`, `staleTime: 15_000`, `retry: 1` (one retry covers a transient blip without amplifying outages), `refetchOnWindowFocus: true` (card refreshes when the user returns to the agent screen). Re-exports `CliCommand` for colocation with consumers. |
| `src/renderer/src/components/chat/CliCommandPopup.tsx` | Thin wrapper around the shared [Mention Popups](../mention_popups/mention_popups.md) primitive — binds `CliCommand`, declares the `Terminal` icon, `Agent Commands` header, `w-80` width, and a 2-line-clamped `cmd.description` secondary. Primary label is the invocation string (`cmd.command`, e.g. `/run:status`). |
| `src/renderer/src/components/chat/ChatInput.tsx` | Adds `/` to `TriggerChar` and to `findTriggerToken`. Invokes `useCliCommands(promptSourceAgent?.id)` alongside the existing prompt extraction; memoises the result array. New `filteredCommands`, `commandPopupOpen`, `selectCommand`, and a `commandGate` in `handleInput`. `activeListLength` and the Enter/Tab branch extended to cover the command popup. ARIA wiring (`aria-expanded`, `aria-controls`, `aria-activedescendant`) extended. |

## Database Schema

None. CLI commands are fetched fresh from the agent card every time they are requested — nothing new is persisted.

## IPC Channels

| Channel | Direction | Payload | Response |
|---------|-----------|---------|----------|
| `agent:list-cli-commands` | renderer → main | `agentId: string` | `{ success: boolean; commands: CliCommand[]; error?: string }` |

## Services & Key Methods

- `src/main/services/agentService.ts::listCliCommands(userId, agentId)` — fetches the agent card and returns parsed CLI commands. Throws `AgentError('not_found')` if the agent row isn't owned by the user; returns `[]` for non-A2A agents or missing card URLs. Emits a structured trace log (`CLI commands fetched`, `{ agentId, count, durationMs }`) so the logger overlay can correlate user actions with the external card fetch.
- `src/shared/cliCommands.ts::extractCliCommands(skills)` — pure parser. Accepts `unknown` (defensive against raw card JSON), filters by skill id prefix `cinna.run.` or tag `cinna-run`, and derives `command` from `examples[0]` with a `/run:<slug>` fallback.

## Renderer Components

### CliCommandPopup

- Thin wrapper over the shared `MentionPopup<T>` primitive — see [Mention Popups](../mention_popups/mention_popups.md) for the listbox shell, ARIA semantics, theming, and outside-click handling
- Wrapper-specific config: `Terminal` icon, `Agent Commands` header, `w-80` width, 2-line-clamped secondary

### ChatInput extensions

- `TriggerChar` union extended to `'@' | '#' | '/'`
- `findTriggerToken` scans backward for any of the three trigger characters
- `commandPopupOpen = triggerChar === '/' && commands.length > 0`
- `filteredCommands` matches **only** `slug` and `command` (the signature parts) — `name` and `description` are intentionally excluded so a filter like `/status` does not pull in commands whose human-readable text happens to contain "status"
- `selectCommand(cmd)` replaces the `/filter` token with `cmd.command` (no auto-send, consistent with `#`)
- `commands` memoised via `useMemo(() => cliCommands ?? [], [cliCommands])` so the filter `useMemo` stays stable across renders that leave the query data unchanged

## Configuration

- No new settings, env vars, or feature flags. Discovery is entirely driven by the agent card's `skills[]` and the `cinna.run.*` / `cinna-run` convention documented in `CINNA_DESKTOP_CLI_COMMANDS_INTEGRATION.md`.

## Security

- Access tokens for the card fetch are resolved via the existing `agentService.resolveAccessToken` path — remote agents use the user's Cinna JWT, local agents use their encrypted per-agent token. No secrets cross the IPC boundary.
- Inserted invocation strings travel as plain text through the normal messaging pipeline; there is no client-side shell execution or expansion.
