# Keyboard Shortcuts — Technical Details

## File Locations

### Main process

| File | Role |
|------|------|
| `src/main/index.ts` | Registers the `View > Toggle App Logs` menu items with accelerators `CommandOrControl+`` (visible) and `CommandOrControl+Shift+`` (hidden with `acceleratorWorksWhenHidden: true`). The `click` handler calls `toggleLogsOverlay` which invokes `webContents.send('logger:toggle-overlay')`. |
| `src/main/index.ts` (File menu) | **New Chat** (`CommandOrControl+N`), **New Chat with This Agent** (`CommandOrControl+Shift+N`) and one item per `AGENT_SHORTCUT_SLOTS` digit (`CommandOrControl+<n>`, `visible: false`, `acceleratorWorksWhenHidden: true`). Every `click` calls the local `sendShortcut(shortcut)`, which sends `app:shortcut` with an `AppShortcut` payload to `getMainWindow()` unless it is missing or destroyed. |
| `src/shared/appShortcuts.ts` | `AppShortcut` (`{kind: 'new-chat'}` · `{kind: 'new-chat-same-agent'}` · `{kind: 'agent', slot}`), `AGENT_SHORTCUT_SLOTS` (1–9), `isAgentShortcutSlot` (integer 1–9), `AgentShortcutDto` (`{slot, agentId}`). Shared by main, preload and renderer. |
| `src/main/db/schema.ts` / `src/main/db/migrations/agent-shortcuts.ts` | `agent_shortcuts` table — see Database Schema. |
| `src/main/db/agents.ts` | `agentShortcutRepo.{listForUser, set, deleteForAgent}`; `agentRepo.rekeyFolderRow` repoints `agent_shortcuts.agent_id` for every profile. |
| `src/main/db/users.ts` | `userRepo.deleteWithCascade` deletes the profile's `agent_shortcuts` rows in its transaction. |
| `src/main/services/agentService.ts` | `listShortcuts(profileUserId)`, `setShortcut(defaultUserId, profileUserId, agentId, slot)`; `delete` calls `agentShortcutRepo.deleteForAgent` after `agentRepo.delete`. |
| `src/main/ipc/agent.ipc.ts` | `agent:list-shortcuts`, `agent:set-shortcut`. |
| `src/main/errors.ts` | `AgentErrorCode` `invalid_shortcut`. |

### Renderer — Components

| File | Role |
|------|------|
| `src/renderer/src/components/chat/ChatInput.tsx` | `handleKeyDown` on the textarea, in this order: the `~` mode popup; a trigger popup (`ArrowUp`/`ArrowDown`/`Enter`/`Tab`/`Escape`); `Escape` while editing a recalled queued message (leave edit, empty the input, `lastEscapeAt.current = 0`); `ArrowUp`/`ArrowDown` with no modifier and the caret on the first or last line (`caretOnEdgeLine`) through `recallHistory`, which consumes the key only when it acted; the new-chat chord (`onDoubleEscape`); the active-chat stop chord (`chatId && isStreaming` → `handleCancel`); `Enter` without `Shift` (`handleSend`, which saves a queued edit instead when one is active). Both chords share the `lastEscapeAt` ref and `DOUBLE_ESC_WINDOW_MS` (400 ms). |
| `src/renderer/src/components/layout/ChatWorkspace.tsx` | Wires `onDoubleEscape={() => setPendingAgentIds([])}` on the new-chat `ChatInput` instance only. The active-chat instance omits the prop; there the chord reaches `ChatInput`'s own stop branch instead, and only while a turn runs. |
| `src/renderer/src/components/logger/LogsOverlay.tsx` | `useEffect` attaches a `window` `keydown` listener gated on `logsOpen`; `Escape` closes the overlay via `setLogsOpen(false)`. |
| `src/renderer/src/components/agents/AgentStatusOverlay.tsx` | `useEffect` attaches a `window` `keydown` listener gated on `agentStatusOpen`; `Escape` back-navigates if `detailAgentId` is set, otherwise closes the overlay. |
| `src/renderer/src/components/agents/AgentInterfaceTab.tsx` | The agent page's Interface tab. A `SettingsSection` "Keyboard shortcut" with one `select` (None, `⌘1`–`⌘9`); an option held by another agent is labelled `agentShortcutLabel(slot) · truncateName(name)`. While the mutation is pending the select shows `setShortcut.variables.slot`, not the saved value, so it never snaps back before the list re-reads. Errors render as `role="alert"` under the select through `unwrapIpcError`. Mounted with `key={agent.id}` by `ExternalAgentPage` (`tab === 'interface'`) and `LocalAgentPage` (`activeTab === 'interface'`, last `TABS` entry, also on bare agents). |
| `src/renderer/src/components/settings/ChatModeCard.tsx` | Inline `onKeyDown` on the mode-name input: `Enter` calls `e.currentTarget.blur()` to commit the edit. |
| `src/renderer/src/components/chat/AgentMentionPopup.tsx` / `ExamplePromptPopup.tsx` | Render-only — they own no key handling. All navigation keys are processed by `ChatInput.handleKeyDown` and the popups receive `selectedIndex` / `onSelect` / `onClose` as props. |

### Renderer — Store

| File | Role |
|------|------|
| `src/renderer/src/stores/ui.store.ts` | `activeView`, `activeExternalAgentId`, `activeLocalAgentId` are what `⇧⌘N` reads; `setActiveJobId(null)` + `setPendingAgentId` + `setActiveView('chat')` + `setSidebarTab('chats')` is the landing `startAgentChat` performs (`ChatWorkspace` consumes `pendingAgentId`). Also holds the open-state flags the context shortcuts gate on: `logsOpen`, `agentStatusOpen`, plus the persisted `loggerEnabled` toggle that gates the `⌘` ` menu-accelerator handler. |

### Renderer — Hooks & utils

| File | Role |
|------|------|
| `src/renderer/src/hooks/useAppShortcuts.ts` | Mounted once in `App.tsx` `Shell`, after the auth and onboarding gates. Subscribes to `window.api.app.onShortcut` once (deps: `queryClient`); `useStartNewChat` is read through a ref. Everything else — screen, chat, bindings, agent list — is read at key time: `fetchQuery` on `['chat', id]`, `['agents']` and `AGENT_SHORTCUTS_KEY`, so an invalidated cache is re-read before it is trusted. Returns early while `document.querySelector('[aria-modal="true"]')` matches. Failures are logged (`app-shortcuts` logger), not surfaced. |
| `src/renderer/src/utils/appShortcuts.ts` | Pure rules: `startableAgent(agents, id)` (listed, `enabled`, not `conductor`), `resolveShortcutAgent(screen, agents)` (`chat` view → `routingOf(chat)` with `router === 'direct'` → `rootAgentId`; `external-agent` / `local-agent` → the page's id; anything else → null), `agentShortcutLabel(slot)` (`⌘3` or `Ctrl+3`), `truncateName(name, 24)`. |
| `src/renderer/src/hooks/useAgents.ts` | `AGENT_SHORTCUTS_KEY = ['agents', 'shortcuts']` — under the `['agents']` prefix, so every agents invalidation and the profile-switch reset re-read it. `useAgentShortcuts()`; `useSetAgentShortcut()` throws on `success: false` and returns its `onSettled` invalidation so the mutation stays pending until the list has re-read. |
| `src/renderer/src/hooks/useStartNewChat.ts` | The TopBar `+` action `⌘N` reuses. |

### Preload

| File | Role |
|------|------|
| `src/preload/index.ts` | Exposes `window.api.logger.onToggleOverlay(handler)` which the renderer uses to receive the `logger:toggle-overlay` broadcast from the main-process menu `click`; `window.api.app.onShortcut(handler)` for `app:shortcut` (returns an unsubscribe); `window.api.agents.listShortcuts()` and `window.api.agents.setShortcut(agentId, slot)`. |

## Database Schema

- `agent_shortcuts` (migration `src/main/db/migrations/agent-shortcuts.ts`, registered after `migrateAgentOverrides`): `user_id`, `slot`, `agent_id`, `updated_at`. `PRIMARY KEY (user_id, slot)` and `UNIQUE (user_id, agent_id)` — one agent per digit and one digit per agent, per profile, enforced by the table. The Drizzle definition declares only the primary key; the unique constraint lives in the migration.
- **A table of its own, not a column on `agent_overrides`.** Many readers take `agentOverrideRepo.get(...)?.enabled ?? row.enabled`; an override row created only to hold a digit would have silently enabled a disabled agent.
- **No FK to `agents.id`**, for the reason `agent_overrides` has none: sync may drop and re-create a remote row under the same id, and the binding must survive that. Cleanup is explicit — `agentService.delete` (hand-added connections only; remote and folder rows refuse that path), `userRepo.deleteWithCascade`, and `rekeyFolderRow` repointing by `agent_id` across every profile, since a folder agent lives in the default scope while any profile may bind it.
- `agentShortcutRepo.set` is one transaction: delete the agent's current row, return on `null`, delete whoever holds `slot`, insert. That order is what turns a taken digit into a move instead of a constraint error.

## IPC Channels

| Channel | Direction | Purpose |
|---------|-----------|---------|
| `logger:toggle-overlay` | main → renderer | Fired from the `⌘` ` / `⌘⇧` ` menu accelerator; renderer flips `ui.store.logsOpen` when the logger is enabled. |
| `app:shortcut` | main → renderer | `AppShortcut` payload from the File menu's chat-starting items. |
| `agent:list-shortcuts` | renderer → main | `() → AgentShortcutDto[]` for the active profile (`getProfileScopeUserId()`), ordered by slot. Requires an activated user. |
| `agent:set-shortcut` | renderer → main | `({agentId, slot: number \| null}) → {success, error?}`. Validates the id (`invalid_id`), the slot (`invalid_shortcut`) and — only when binding — that `findAgent(default, profile, agentId)` resolves (`not_found`). Clearing needs no agent, so a binding whose agent is gone can still be removed. Errors are returned as data, not thrown. |

## Key Flows

### Global accelerator → overlay toggle

1. User presses `⌘` ` — macOS routes the keystroke to the focused window's menu.
2. Electron matches the accelerator on the `View > Toggle App Logs` menu item in `src/main/index.ts`.
3. The `click` handler invokes `toggleLogsOverlay`, which calls `BrowserWindow.getAllWindows()[0].webContents.send('logger:toggle-overlay')`.
4. The renderer listener registered via `window.api.logger.onToggleOverlay` flips `logsOpen` on `ui.store` — gated on `loggerEnabled` so the shortcut is a no-op when the logger is off.
5. `LogsOverlay` reacts to the flag and mounts / unmounts.

### Chat-starting accelerator → new chat

1. The user presses `⌘N`, `⇧⌘N` or `⌘<digit>`; the File menu item's `click` calls `sendShortcut`, which sends `app:shortcut` to the main window.
2. `useAppShortcuts` receives it. An `aria-modal="true"` element in the document ends it here.
3. `new-chat` → `useStartNewChat()`.
4. `new-chat-same-agent` → when `activeView === 'chat'` and a chat is active, `fetchQuery(['chat', id])`; then `resolveShortcutAgent` over the screen and a fresh `['agents']` list. An id → `startAgentChat`; null → `useStartNewChat()`.
5. `agent` → `fetchQuery(AGENT_SHORTCUTS_KEY)`; no binding for the slot → return. Otherwise `startableAgent` on a fresh `['agents']` list: a row → `startAgentChat`; none → a toast, "*Name* is disabled" when the row is listed, disabled and not a conductor, else "The agent for *label* is no longer available".

### Double-ESC → clear agent

1. User presses `Esc` in the new-chat `ChatInput` with no popup open.
2. `handleKeyDown` enters the `e.key === 'Escape' && onDoubleEscape` branch, calls `preventDefault`, reads `Date.now()`.
3. First press: `now - lastEscapeAt.current` is larger than `DOUBLE_ESC_WINDOW_MS`, so `lastEscapeAt.current = now`.
4. User presses `Esc` again within 400 ms: `now - lastEscapeAt.current <= DOUBLE_ESC_WINDOW_MS`, so `lastEscapeAt.current = 0` and `onDoubleEscape()` fires.
5. `ChatWorkspace`'s callback runs `setPendingAgentIds([])`, clearing the pending agent chips on the dashboard or embedded agent composer.

### Double-ESC → stop a running turn

1. User presses `Esc` in an existing chat's `ChatInput` while a turn runs, with no popup open and no queued message being edited.
2. `handleKeyDown` enters the `e.key === 'Escape' && chatId && isStreaming` branch (`isStreaming` is a port stream or the chat's `activeRunId`) and calls `preventDefault`.
3. First press arms `lastEscapeAt`; a second within 400 ms clears it and calls `handleCancel` — the same owned `run:cancel-chat` the Stop button uses.

### History recall and queued-message edit

1. `ArrowUp` or `ArrowDown` with no modifier calls `recallHistory(-1 | 1)` when `caretOnEdgeLine` puts the caret on the input's first line (no line break before `selectionStart`) or its last (none after `selectionEnd`), respectively. It acts only when the input is empty (starting past the newest entry) or equals the recalled `Recall.text`; otherwise it returns false and the caret moves as usual.
2. Entries are saved user messages, then the chat's `user` stream blocks, then non-held queue items carrying their queue IDs. At the oldest entry `ArrowUp` is consumed and does nothing; past the newest `ArrowDown` empties the input.
3. A recalled entry with a queue ID sets edit mode: `Enter` or the Save button calls `run:queue-edit`, and `Escape` leaves edit mode and empties the input. Details: [Pending Messages tech](../../chat/pending_messages/pending_messages_tech.md#chatinput).

### Popup-ESC invalidation

1. `@` or `#` popup is open, `Esc` fires.
2. The popup branch runs first: `closeTrigger()` resets the popup state and sets `lastEscapeAt.current = 0`.
3. A subsequent `Esc` within 400 ms computes `now - 0`, which is always much greater than 400 ms — so it starts a fresh chord rather than completing the previous one.

### Context-scoped overlay close

1. Overlay opens → `logsOpen` / `agentStatusOpen` becomes `true` → its `useEffect` runs.
2. `useEffect` attaches `window.addEventListener('keydown', onKey)` and returns a cleanup.
3. `onKey` checks the gate flag, calls `preventDefault` and the close action when appropriate.
4. Overlay closes → `useEffect` cleanup removes the listener.

## Configuration

- `DOUBLE_ESC_WINDOW_MS` — module-level constant in `src/renderer/src/components/chat/ChatInput.tsx`. Tune if the chord window needs to be tighter or looser.
- Menu accelerators in `src/main/index.ts` — adding or changing global shortcuts means editing this menu. Another chat-starting key is a new `AppShortcut` variant plus a File menu item, not a new channel.
- `AGENT_SHORTCUT_SLOTS` in `src/shared/appShortcuts.ts` — the digits offered; menu items, select options and `isAgentShortcutSlot` all derive from it (the last hard-codes 1–9). Prefer `CommandOrControl` over `Cmd`/`Ctrl` literals so bindings stay cross-platform.

## Security

- No raw `keydown` listeners in the preload or main process — all key handling happens either via Electron menu accelerators or inside the sandboxed renderer.
- The `logger:toggle-overlay` broadcast carries no payload — the renderer treats it as a pure "toggle" event and cannot be coerced into toggling other state.
- `app:shortcut` carries only which key was pressed; the renderer resolves bindings itself through `agent:list-shortcuts`, scoped to the active profile in main, so one profile's bindings never reach another.
- `agent:set-shortcut` refuses a slot outside 1–9 and a binding to an agent the active profile cannot see. The table holds ids and digits only.
- No shortcut writes to persistent storage directly (bindings are written from the Interface tab, never by a key); every effect is a store action that the renderer already gates (e.g. `loggerEnabled` prevents the toggle from running when the logger is off).
