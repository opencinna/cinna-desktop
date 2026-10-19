# Agent Colors — Technical Details

Business rules: [Agent Colors](agent_colors.md).

## File Locations

### Shared
- `src/shared/agentColors.ts` — `AGENT_COLOR_PRESETS` (`{id, name, color: '#RRGGBB'}` ×15), `isAgentColorPreset(value)` (main's validator), `agentColorPreset(id)` (lookup; `undefined` for an unknown or retired id), `AgentColorDto` (`{agentId, preset}`). Shared because main validates the id and the renderer draws the swatch. Ids are stored: never rename one.

### Main process
- `src/main/db/schema.ts` — `agentColors` (Drizzle), primary key `(userId, agentId)`.
- `src/main/db/migrations/agent-colors.ts` — `migrateAgentColors`, registered in `runAllMigrations` directly after `migrateAgentShortcuts`. Creation only.
- `src/main/db/agents.ts` — `agentColorRepo.{listForUser, set, deleteForAgent}`. `set(userId, agentId, null)` deletes the row; otherwise an upsert on `(user_id, agent_id)`. `deleteForAgent` drops the id in **every** profile. `agentRepo.rekeyFolderRow` repoints `agent_colors.agent_id` for every profile, not filtered by `userId`, beside `agent_shortcuts`.
- `src/main/db/users.ts` — `userRepo.deleteWithCascade` deletes the profile's `agent_colors` rows in its transaction.
- `src/main/services/agentService.ts` — `listColors(profileUserId)` maps rows to `AgentColorDto` (unknown ids are passed through; the renderer drops them). `setColor(defaultUserId, profileUserId, agentId, preset)` throws `AgentError` `invalid_id` (empty id), `invalid_color` (not in `AGENT_COLOR_PRESETS`) and — only when choosing, not clearing — `not_found` when `findAgent(default, profile, id)` does not resolve. `delete()` calls `agentColorRepo.deleteForAgent` after `agentShortcutRepo.deleteForAgent`; it is the hand-added-connection path, so a folder agent's trash/prune never reaches it.
- `src/main/errors.ts` — `AgentErrorCode` gains `invalid_color`.
- `src/main/ipc/agent.ipc.ts` — `agent:list-colors`, `agent:set-color`.

### Preload
- `src/preload/index.ts` — `window.api.agents.listColors()` and `window.api.agents.setColor(agentId, preset | null)`.

### Renderer
- `src/renderer/src/hooks/useAgents.ts` — `AGENT_COLORS_KEY = ['agents', 'colors']`, under the `['agents']` prefix for the reason `AGENT_SHORTCUTS_KEY` is: every agents invalidation and the profile-switch reset re-read it. `useAgentColors()`; `useSetAgentColor()` throws on `success: false` and returns its `onSettled` invalidation, so the mutation stays pending until the list has re-read.
- `src/renderer/src/components/agents/AgentColorsProvider.tsx` — calls `useAgentColors()` once and provides `agentColorMap(data)` (memoised) through `AgentColorsContext`. Mounted in `App.tsx` inside `AuthGate`, around `OnboardingGate` and the app-level modals.
- `src/renderer/src/utils/agentColors.ts` — the lookup every surface uses:
  - `presetForAgentId(id)` — the hash color, `{border, bg}` from `COLOR_PRESETS`; unchanged, now the fallback.
  - `agentInk(hex, use: 'text' | 'glyph' = 'text')` — `color-mix(in oklab, hex var(<strength>, 100%), black)`, with `--agent-ink-strength` for `text` and `--agent-glyph-strength` for `glyph`. Both are set in `src/renderer/src/assets/main.css`: `100%` on the dark theme (the hex unchanged); on the light one `68%` for text and `82%` for glyphs.
  - `chipColorsFor(hex)` — `{border: agentInk(hex), bg: rgba(r,g,b,0.10)}`: text-strength ink for the border and text, the raw hex for the tint.
  - `AgentColorsContext` — `ReadonlyMap<agentId, '#RRGGBB'>`, default an empty map, so a component rendered outside the provider (a test without it) gets hash colors and no tints rather than an error.
  - `agentColorMap(rows)` — builds the map, dropping ids `agentColorPreset` does not know.
  - `useChosenAgentColor(use: 'glyph' | 'fill' = 'glyph')` — `(agentId) => color | null`; for surfaces that stay plain at None. `glyph` returns `agentInk(hex, 'glyph')` (`AgentTypeIcon`, `WhoIcon`, `LocalAgentsList`); `fill` returns the raw hex (`ChatList`, for the row dot).
  - `useAgentColor()` — `(agentId) => {border, bg}`: chosen, else `presetForAgentId`; for chips and labels.
- `src/renderer/src/components/agents/AgentInterfaceTab.tsx` — the tab is now a `space-y-6` stack of the **Keyboard shortcut** section and the module-private `AgentColorSection`: a `SettingsSection` "Color" with a `SettingsLabel` ("Color preset", info tooltip naming the surfaces) and a `role="group"` of `aria-pressed` swatch buttons, None (`Ban` icon) first. Swatches are filled with the raw preset hex. Selection is `ring-2 ring-offset-2` plus a `Check` inside in `text-black/70` on every preset (dark contrasts better than white on all fifteen); the displayed value is `setColor.variables.preset` while pending, else the saved one; clicking the current value calls nothing. Errors render as `role="alert"` through `unwrapIpcError`.
- `src/renderer/src/components/agents/AgentTypeIcon.tsx` — optional `color` and `agentId` props. The icon's color is `color ?? useChosenAgentColor()(agentId)`; set, it replaces the muted text class with an inline `color`. `agentId` lets a caller with no lookup of its own get the tint: `LocalAgentPage` and `ExternalAgentPage` headers and `settings/AgentsSettingsSection.tsx` pass it; `LocalAgentsList` and `WhoIcon` pass `color`.
- `src/renderer/src/components/agents/local/LocalAgentsList.tsx` — `useChosenAgentColor()` once in `LocalAgentsList`; `AgentRow` and `ExternalAgentRow` take `color` and pass it to `AgentTypeIcon`.
- `src/renderer/src/components/chat/ChatItemTooltip.tsx` — `WhoIcon` passes `useChosenAgentColor()(who.agentId)` to `AgentTypeIcon`, so both the Chats who group header (`ChatGroupHeader`) and the row tooltip's who line are tinted.
- `src/renderer/src/components/chat/ChatList.tsx` — `agentColorOf(chat)` = chosen color of `summaries[chat.id].with.agentId ?? chat.agentId`. `rows()`, `byList()` and `days()` take an `underWho` flag, `true` only from the who-grouping branch; such rows get `agentColor={undefined}`. The Active block, Pinned, flat and date-only rows pass `agentColorOf(chat)`.
- `src/renderer/src/components/chat/ChatItem.tsx` — optional `agentColor`; renders a 4 px (`w-1 h-1`) `rounded-full` `span[data-agent-color-dot]` (`aria-hidden`, `pointer-events-none`), `absolute left-[3px]` and vertically centred inside the row's left padding — out of flow, so the title's position does not depend on it.
- `useAgentColor()` replaces `presetForAgentId` in `ChatInput.tsx` (bound-agent chip; `ACCENT_CHIP` still for a hidden conductor), `OnDemandAgentChips.tsx`, `MessageBubble.tsx` (agent and addressed-agent labels), `AgentContribution.tsx`, `AgentToolSubThread.tsx` and `jobs/JobEditForm.tsx`. `presetForAgentId(agentId, avoid?)` takes the enclosing thread's colour and steps to the next preset when the hash lands on its border; `AgentToolSubThread` supplies it from an `EnclosingThreadColor` context.

## Database Schema

- `agent_colors` (migration `src/main/db/migrations/agent-colors.ts`): `user_id`, `agent_id`, `preset`, `updated_at`. `PRIMARY KEY (user_id, agent_id)` — one color per agent per profile; no uniqueness on `preset`, so agents may share one. No row means None.
- **A table of its own, not a column on `agent_overrides`.** Many readers take `agentOverrideRepo.get(...)?.enabled ?? row.enabled`; an override row created only to hold a color would silently enable a disabled agent. The same reason `agent_shortcuts` is separate.
- **No FK to `agents.id`**: sync may drop and re-create a remote row under the same id, and the color must survive. Cleanup is explicit — `agentService.delete` (every profile), `userRepo.deleteWithCascade` (one profile), and `rekeyFolderRow` (repoint, every profile).

## IPC Channels

| Channel | Direction | Purpose |
|---------|-----------|---------|
| `agent:list-colors` | renderer → main | `() → AgentColorDto[]` for the active profile (`getProfileScopeUserId()`). Requires an activated user. |
| `agent:set-color` | renderer → main | `({agentId, preset: string \| null}) → {success, error?}`. Resolves the agent with `getSettingsScopeUserId()` and `getProfileScopeUserId()`; writes under the profile. Errors are returned as data (message only), not thrown. Requires an activated user. |

## Security

- The table holds ids only. Main accepts nothing but a listed preset id, so the renderer cannot store arbitrary CSS; the hex drawn always comes from `AGENT_COLOR_PRESETS`.
- Reads and writes are scoped to the active profile in main; one profile's colors never reach another's renderer.

## Tests

- `src/main/services/agentService.colors.test.ts` — set, replace, share, clear (including an agent that is gone), per-profile isolation, `invalid_color`, `not_found`, re-key in every profile, delete in every profile, profile cascade.
- `src/renderer/src/utils/agentColors.test.tsx` — fifteen distinct ids, the 10% tint, chosen-else-hash, retired id ignored, outside-provider fallback, `AgentTypeIcon` tint, `WhoIcon` tint.
- `src/renderer/src/components/agents/AgentInterfaceTab.test.tsx` — None plus fifteen swatches, None chosen by default, choose/clear, pending shows the choice, re-click saves nothing, error shown and selection restored.
- `src/renderer/src/components/chat/ChatList.test.tsx` / `ChatItem.test.tsx` — the dot on ungrouped and date-grouped rows and in Pinned, none under a who group, none for an agent at None.
