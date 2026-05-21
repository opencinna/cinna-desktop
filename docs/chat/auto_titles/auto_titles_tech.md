# Auto Chat Titles — Technical Details

## File Locations

### Shared

| File | Role |
|------|------|
| `src/shared/appSettings.ts` | `AppSettingsSchema` interface (currently one key: `autoChatTitles: boolean`), `AppSettingKey` alias, `CHAT_TITLE_UPDATED_CHANNEL` constant, `ChatTitleUpdatedPayload` interface. Single source of truth for the settings schema across main + preload + renderer. |
| `src/shared/chatTitle.ts` | `AUTO_TITLE_MAX_FROM_MESSAGE = 50` constant + `deriveTitleFromMessage(message)` function. Renderer uses it to compute the fallback chat title; main-process title service uses it to recognise that fallback as an "untouched auto-title". |

### Main Process — DB

| File | Role |
|------|------|
| `src/main/db/schema.ts` | `appSettings` table (`key TEXT PK`, `value TEXT`, `updated_at INTEGER`). Installation-global KV store; no `user_id`. |
| `src/main/db/migrations/app-settings.ts` | `migrateAppSettings` creates `app_settings` table. Idempotent (`CREATE TABLE IF NOT EXISTS`); no `ALTER TABLE` paths (the schema is fixed). |
| `src/main/db/client.ts` | Registers `migrateAppSettings` in `runMigrations()` after `migrateNotes`, before the legacy `migrateUserIdColumns` backfill. |
| `src/main/db/appSettings.ts` | `appSettingsRepo` with `get<K>(key)`, `set<K>(key, value)`, `getAll()`. Values are JSON-serialised; corrupt rows fall back to `DEFAULTS` (`{ autoChatTitles: false }`). |
| `src/main/db/messages.ts` | New `messageRepo.countByRole(chatId, role)` (`SELECT COUNT(*)`) and `messageRepo.firstByRole(chatId, role)` (`SELECT … ORDER BY sort_order ASC LIMIT 1`) for cheap first-message detection without loading the full history. |
| `src/main/db/chats.ts` | `chatRepo.updateMeta(userId, chatId, { title })` writes the generated title. No new methods. |

### Main Process — Services

| File | Role |
|------|------|
| `src/main/services/chatTitleService.ts` | Owns the title-gen orchestration: toggle check → first-message check → adapter resolve → one-shot LLM → sanitise → re-check → persist → broadcast. Exports `chatTitleService.autoGenerateForFirstMessage({ userId, chatId })` and `ChatTitleError`. |
| `src/main/services/appSettingsService.ts` | Chokepoint for `app_settings` reads/writes. Validates `(key, value)` against `AppSettingsSchema` at runtime (`Object.hasOwn(DEFAULTS, key)` + `typeof value === typeof DEFAULTS[key]`). Throws `AppSettingsError`. |
| `src/main/services/messageRoutingService.ts` | Hosts `fireTitleGenInBackground(userId, chatId)` — the fire-and-forget caller. Invoked from both `prepareLlmSend` and `prepareAgentSend` after `messageRepo.saveUser`. Classifies `ChatTitleError` codes into debug/info/warn log levels. |
| `src/main/services/aiFunctionsService.ts` | Existing primitive. `resolveAdapterFromDefaultMode` + `runSingleShot` are the two methods the title service composes. Unchanged. |
| `src/main/errors.ts` | `AppSettingsError` (codes: `invalid_key`, `invalid_value`). `ChatTitleError` is defined inside `chatTitleService.ts`, not here. |

### Main Process — IPC

| File | Role |
|------|------|
| `src/main/ipc/settings.ipc.ts` | Registers `settings:get-all` and `settings:set`. Loose `(key: string, value: unknown)` signature pushes validation to `appSettingsService.set`. |
| `src/main/ipc/index.ts` | Calls `registerSettingsHandlers()` from `registerAllIpcHandlers`. |
| `src/main/index.ts` | `getMainWindow()` is the broadcast target the title service uses to emit `CHAT_TITLE_UPDATED_CHANNEL`. |

### Preload

| File | Role |
|------|------|
| `src/preload/index.ts` | `api.settings.getAll()` / `api.settings.set(key, value)` bridge methods. `api.chat.onTitleUpdated(handler)` subscription to the `chats:title-updated` broadcast (returns unsubscribe). |

### Renderer

| File | Role |
|------|------|
| `src/renderer/src/hooks/useAppSettings.ts` | `useAppSettings()` (`useQuery`, key `['app-settings']`) reads the schema. `useSetAppSetting()` (`useMutation`) writes with optimistic cache update + rollback on error + renderer-logger trace on failure. |
| `src/renderer/src/hooks/useChat.ts` | `useChatList` effect subscribes to `window.api.chat.onTitleUpdated` and invalidates `['chats']` + `['chat', chatId]` on each event. Mirrors the `useMcpProviders` `onStatusChanged` pattern. |
| `src/renderer/src/hooks/useNewChatFlow.ts` | Calls `deriveTitleFromMessage(message)` from `src/shared/chatTitle.ts` to compute the fallback title at chat-creation time. |
| `src/renderer/src/components/settings/FeaturesSettingsSection.tsx` | Renders the "AI Functions" subsection with the "Auto-generate chat titles" toggle. Pure consumer of `useAppSettings` / `useSetAppSetting`. |
| `src/renderer/src/components/settings/SettingsPage.tsx` | Adds `'features'` to `sectionTitles` and dispatches to `FeaturesSettingsSection`. |
| `src/renderer/src/components/layout/Sidebar.tsx` | Inserts `{ id: 'features', label: 'Features', icon: Sparkles }` into `defaultMenuItems` between `accounts` and `development`. |
| `src/renderer/src/stores/ui.store.ts` | Adds `'features'` to the `SettingsMenu` union. |

## Database Schema

`app_settings` table (`src/main/db/migrations/app-settings.ts`):

| Column | Type | Notes |
|--------|------|-------|
| `key` | `TEXT PRIMARY KEY` | One of `AppSettingsSchema`'s keys. Validated at the service layer, not by SQLite. |
| `value` | `TEXT NOT NULL` | JSON-encoded value. Type must match `typeof DEFAULTS[key]`. |
| `updated_at` | `INTEGER NOT NULL` | Timestamp; not consumed by reads but written on every `set`. |

No foreign keys. No `user_id` — settings are installation-global.

No new columns on `messages` or `chats`. The feature reuses `chats.title` and writes via `chatRepo.updateMeta`.

## IPC Channels

### Settings

| Channel | Direction | Payload | Returns |
|---------|-----------|---------|---------|
| `settings:get-all` | renderer → main | none | `AppSettingsSchema` (full snapshot with defaults applied for missing rows) |
| `settings:set` | renderer → main | `(key: string, value: unknown)` | `{ success: true }`; throws `AppSettingsError` (`invalid_key` / `invalid_value`) on validation failure |

### Title broadcast

| Channel | Direction | Payload |
|---------|-----------|---------|
| `chats:title-updated` | main → renderer (broadcast) | `{ chatId: string, title: string }` (= `ChatTitleUpdatedPayload`) |

Emitted from `chatTitleService` via `getMainWindow().webContents.send(CHAT_TITLE_UPDATED_CHANNEL, …)`. One event per successful title write. Renderer subscribes via `window.api.chat.onTitleUpdated`.

## Services & Key Methods

- `src/main/services/chatTitleService.ts::chatTitleService.autoGenerateForFirstMessage({ userId, chatId })` — The whole orchestration. Self-checks all pre-conditions. Throws `ChatTitleError` with one of the codes below; caller is responsible for catching and classifying.
- `src/main/services/chatTitleService.ts::isUntouchedAutoTitle(currentTitle, firstUserText)` — Pure helper. Returns `true` iff `currentTitle === 'New Chat'` or `currentTitle === deriveTitleFromMessage(firstUserText)`.
- `src/main/services/chatTitleService.ts::sanitizeTitle(raw)` — Strips quotes/backticks/whitespace/trailing punctuation, hard-caps at 40 chars. Pure.
- `src/main/services/messageRoutingService.ts::fireTitleGenInBackground(userId, chatId)` — Private; wraps `autoGenerateForFirstMessage` with the log-level classifier and `void`s the promise. Called from `prepareLlmSend` and `prepareAgentSend`.
- `src/main/services/appSettingsService.ts::appSettingsService.set(key, value)` — Validates then delegates to `appSettingsRepo.set`. Throws `AppSettingsError`.
- `src/main/services/appSettingsService.ts::appSettingsService.getAll()` — Delegates to `appSettingsRepo.getAll`.
- `src/main/db/messages.ts::messageRepo.countByRole(chatId, role)` — Single-row COUNT query. Returns 0 when no rows.
- `src/main/db/messages.ts::messageRepo.firstByRole(chatId, role)` — `LIMIT 1` targeted fetch ordered by `sort_order`.

### `ChatTitleErrorCode` reference

| Code | Caller log level | Meaning |
|------|------------------|---------|
| `feature_disabled` | debug | `autoChatTitles` is off. Fires on every send. |
| `not_first_message` | debug | More than one user message in the chat — the trigger fired but it's not actually the first send. |
| `chat_not_found` | warn | Chat row missing (deleted, foreign user, or race with hard delete). |
| `chat_renamed_initial` | debug | Up-front check found a user-set title. Fires on every non-first send too. |
| `chat_renamed_mid_flight` | info | The chat was renamed during the LLM call — the rename wins, the generation is discarded. |
| `no_provider` | warn | Default chat mode missing, or its provider has no API key / is disabled. |
| `llm_failed` | warn | Adapter call threw (network, auth, rate limit). |
| `empty_output` | warn | Model returned nothing, or sanitisation produced an empty string. |

## Renderer Components

- `src/renderer/src/components/settings/FeaturesSettingsSection.tsx` — Single section ("AI Functions") with one switch. Consumes `useAppSettings` for the current value, `useSetAppSetting` for writes (optimistic, with rollback). Shows an inline error message in `--color-danger` if the initial load fails.
- `src/renderer/src/components/layout/Sidebar.tsx` — New menu entry (`Sparkles` icon, label "Features"). No special scoping — Default group, between `accounts` and `development`.
- `src/renderer/src/components/settings/SettingsPage.tsx` — `sectionTitles.features = 'Features'`; dispatches `<FeaturesSettingsSection key="features" />` when `settingsTab === 'features'`.

## Configuration

| Setting | Default | Storage | Notes |
|---------|---------|---------|-------|
| `autoChatTitles` | `false` | `app_settings` table | Toggled from Settings → Features. |

No env vars. No build-time flags. The hard limits (40-char output cap, 50-char renderer truncation) are defined as `MAX_TITLE_CHARS` (in `chatTitleService.ts`) and `AUTO_TITLE_MAX_FROM_MESSAGE` (in `src/shared/chatTitle.ts`).

## Security

- The toggle write path is gated by `userActivation.requireActivated()` — same gate as every other settings IPC. There is no per-user authorization on the value itself (`app_settings` is global).
- The `(key, value)` pair is runtime-validated at `appSettingsService.set` against `AppSettingsSchema` to prevent mass-assignment from a buggy or compromised renderer (unknown keys / wrong types are rejected before reaching SQLite).
- Title content originates from the LLM and is sanitised before persisting (quote/punct/whitespace stripping, hard 40-char cap). It is then rendered through the same React text path as any other chat title — no `dangerouslySetInnerHTML`.
- The default chat mode's provider sees the user's first message text via `runSingleShot.userText`. This is the same provider the user already trusts with their conversation — no new third party is introduced. The Features-tab description flags token consumption to the user.

## Observability

- Logger scope `chat-title` (in `chatTitleService.ts`) emits `info "chat title generated"` on success with `{ chatId, modelId, providerType, titleLen }`.
- Logger scope `routing` (in `messageRoutingService.ts::fireTitleGenInBackground`) emits the classified skip/lose/fail line on every non-success.
- Logger scope `app-settings` (in `appSettingsService.ts`) emits `info "app setting updated"` on every successful write.
- The underlying LLM call is logged by `aiFunctionsService` at scope `ai-functions` with `label: 'chat-title'`, so the logger overlay (Cmd+`) can filter and trace per-feature LLM cost.

## Backward Compatibility

- Pre-existing chats keep their existing titles. The trigger only fires on user-message persists, and the "untouched auto-title" check protects every old chat with a real user-typed title.
- Pre-existing installations that upgrade get an `app_settings` table on first boot (idempotent `CREATE TABLE IF NOT EXISTS`); `autoChatTitles` reads as `false` until the user toggles it on.
- The renderer's truncated-title behaviour is unchanged whether the toggle is on or off — the LLM-generated title overwrites that fallback only after a successful generation.
