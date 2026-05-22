# Cinna Re-authentication — Technical Details

## File Locations

### Main Process

| Layer | File | Purpose |
|-------|------|---------|
| Service | `src/main/services/authService.ts` | `authService.reauthCinna(userId)` — OAuth re-run, identity verification, in-place token write |
| IPC | `src/main/ipc/auth.ipc.ts` | `auth:cinna-reauth` handler — resolves active profile via `getProfileScopeUserId()`, delegates to service |
| IPC (consumer) | `src/main/ipc/agent_a2a.ipc.ts` | Detects `CinnaReauthRequired` in `resolveEndpointIfNeeded` / `resolveAccessToken` failure paths; tags both the live `AgentErrorEvent` and the persisted error row with `code: 'cinna_reauth_required'` |
| Helper | `src/main/ipc/_streamPort.ts` | `postAgentError(port, error, code?)` — optional `code` field on the wire |
| Service (gateway) | `src/main/services/agentService.ts` | `resolveAccessToken` lets `CinnaReauthRequired` bubble (previously masked all errors as session expiry). `rethrowAsReauthIfCinna401` converts a 401/403 `AgentCardFetchError` into `CinnaReauthRequired` — but only when `agent.source === 'remote'`. Local A2A agents keep the original error |
| A2A client | `src/main/agents/a2a-client.ts` | Two typed HTTP errors carrying `status: number`: `AgentCardFetchError` (thrown by `fetchRawCard` on non-OK card responses) and `A2aHttpError` (thrown by `buildLoggingFetch` on **any** 401/403 response, intercepting before the SDK wraps the failure into an opaque error shape) |
| Stream service | `src/main/services/a2aStreamingService.ts` | `streamToAgent` accepts `isCinnaTokenAuth?: boolean`. When true and the caught error is an `A2aHttpError` with status 401/403 (`isAuthRejection` type-guard), the error is replaced with `CINNA_SESSION_EXPIRED_MESSAGE` and tagged with the reauth code. No string-matching — the detection is purely structural |
| Auth core | `src/main/auth/cinna-oauth.ts` | `CinnaReauthRequired` error class — constructor accepts `(message?, options?: ErrorOptions)` so callers can chain the originating error via `{ cause }` (e.g. `rethrowAsReauthIfCinna401` preserves the `AgentCardFetchError`); `startCinnaOAuthFlow(serverUrl)` reused unchanged |
| Auth core | `src/main/auth/cinna-tokens.ts` | `storeCinnaTokens(userId, …)` reused — overwrites existing row's token columns |
| DB | `src/main/db/users.ts` | `userRepo.setCinnaTokens` — UPDATE-only, no row insert |
| DB | `src/main/db/messages.ts` | `SaveErrorMessage.code?: string` field, persisted into the row's JSON payload |

### Shared

| File | Purpose |
|------|---------|
| `src/shared/cinnaErrors.ts` | `CINNA_REAUTH_REQUIRED_CODE` constant + `CINNA_SESSION_EXPIRED_MESSAGE` copy — single source of truth for both wire payloads and renderer branch logic |
| `src/shared/agentStreamEvents.ts` | `AgentErrorEvent.code?: string` field on the agent stream wire contract |

### Preload

| File | Purpose |
|------|---------|
| `src/preload/index.ts` | `window.api.auth.cinnaReauth()` — no-arg invocation of `auth:cinna-reauth` |

### Renderer

| Layer | File | Purpose |
|-------|------|---------|
| Hook | `src/renderer/src/hooks/useAuth.ts` | `useCinnaReauth` — mutation + cache invalidation for `['users']`, `['auth','current']`, `['agents']`, `REMOTE_SYNC_STATUS_KEY` |
| Hook (helper) | `src/renderer/src/hooks/useAgents.ts` | `REMOTE_SYNC_STATUS_KEY` + `RemoteSyncStatus` type exports (reused by the reauth hook) |
| UI surface | `src/renderer/src/components/auth/UserMenu.tsx` | "Re-authenticate" menu entry; accent colour when `hasCinnaTokens === false`; inline error banner inside the dropdown |
| UI surface | `src/renderer/src/components/settings/AgentsSettingsSection.tsx` | "Re-authenticate" button inside the `reauth_required` sync banner; kicks off `agent:sync-remote` on success |
| UI surface | `src/renderer/src/components/agents/AgentStatusOverlay.tsx` | `ReauthErrorPanel` replaces the body when `error.code === 'reauth_required'` |
| UI surface | `src/renderer/src/components/chat/MessageStream.tsx` | `SystemMessage` routes by `err.code`: generic errors render via `GenericErrorBubble` (danger styling); `CINNA_REAUTH_REQUIRED_CODE` renders via `ReauthErrorBubble`, which owns both pre-reauth (danger + "Re-authenticate" button) and post-reauth (success styling, `CheckCircle`, "Authenticated — you can resend your message now.") states. The whole bubble swaps on success — the danger headline is replaced, not appended to |
| Hook | `src/renderer/src/hooks/useChatStream.ts` | Stream-port `'error'` events (both LLM and A2A `case 'error'`) deliberately do **not** call `setSendError`. The error has already been persisted main-side and renders as a `SystemMessage` bubble once `['chat', chatId]` refetches — populating the transient banner too would duplicate the message and strip the inline reauth chip. `setSendError` is reserved for failure modes that can't be persisted (new-chat-flow startup errors) |

## Database Schema

No new tables or columns. The re-auth flow writes to the existing four token columns on `users`:

- `cinna_client_id`
- `cinna_access_token_enc`
- `cinna_refresh_token_enc`
- `cinna_token_expires_at`

The error message row's `code` field is stored inside the existing `messages.content` JSON blob (`{ short, detail, code? }`) — no schema change.

## IPC Channels

| Channel | Signature | Purpose |
|---------|-----------|---------|
| `auth:cinna-reauth` | `() → { success, user?, error? }` | Re-run OAuth against the active profile's stored server URL and overwrite tokens. Takes no arguments — target user resolved from the active session |

The handler returns the standard `{success, error}` discriminated union so renderer surfaces can render inline validation errors instead of entering a React Query error state.

## Services & Key Methods

### `src/main/services/authService.ts`

- `authService.reauthCinna(userId: string)` — Positional userId (the IPC layer passes the resolved active profile). Validates `cinna_user` + non-null `cinnaServerUrl`, runs `startCinnaOAuthFlow(serverUrl)`, verifies `profile.email === row.username`, then `storeCinnaTokens(userId, …)`. Raises `AuthError` codes: `not_found`, `invalid_user_type`, `oauth_failed`, `identity_mismatch`. Logs every branch via the `auth` scoped logger
- `authService.registerCinna` — Unchanged. Continues to own the *new-account* creation path; `reauthCinna` is the in-place sibling

### `src/main/services/agentService.ts`

- `agentService.resolveAccessToken` — Refactored from a bare `try/catch` that re-threw everything as `'Cinna session expired…'`. Now lets `CinnaReauthRequired` bubble so callers (`agent_a2a.ipc.ts`) can distinguish reauth-required from unrelated errors. Other errors propagate with their original message intact

### `src/main/ipc/auth.ipc.ts`

- `auth:cinna-reauth` handler — Thin: calls `authService.reauthCinna(getProfileScopeUserId())`, wraps errors via `errorResponse()`

### `src/main/ipc/agent_a2a.ipc.ts`

- `agent:send-message` listener — Two failure paths (`resolveEndpointIfNeeded`, `resolveAccessToken`) detect `err instanceof CinnaReauthRequired` and:
  1. Use `CINNA_SESSION_EXPIRED_MESSAGE` as the user-facing copy
  2. Pass `CINNA_REAUTH_REQUIRED_CODE` to both `postAgentError(port, msg, code)` (live wire) and `messageRepo.saveError({ chatId, short, code })` (persisted)

## Renderer Components

### `useCinnaReauth` in `src/renderer/src/hooks/useAuth.ts`

`useMutation` wrapping `window.api.auth.cinnaReauth()`. On success: invalidates `['users']`, `['auth', 'current']`, `['agents']` and `setQueryData<RemoteSyncStatus>(REMOTE_SYNC_STATUS_KEY, {})`. Updates the auth store's `currentUser` if it matches the returned user id.

### Four entry-point surfaces

| Component | Trigger | Behavior |
|-----------|---------|----------|
| `UserMenu.tsx` | Dropdown entry under "Actions" | Visible whenever `currentUser.type === 'cinna_user'`. Renders in `--color-accent` when `hasCinnaTokens === false`. On error reopens the menu so the inline `reauthError` banner is visible |
| `AgentsSettingsSection.tsx` | Button inside the `reauth_required` sync banner | Calls `useSyncRemoteAgents().mutate()` immediately on success — the previously-synced agents reappear without an extra click |
| `AgentStatusOverlay.tsx` (`ReauthErrorPanel`) | Full-panel replacement when `error.code === 'reauth_required'` | Calls the parent's `onRetry` (the `refetch` from `useAgentStatus`) on success |
| `MessageStream.tsx` (`SystemMessage` → `ReauthErrorBubble`) | Dedicated error bubble when `code === CINNA_REAUTH_REQUIRED_CODE` | Pre-reauth: danger styling + inline "Re-authenticate" button. Post-reauth: the **entire bubble** swaps to success styling (success colour, `CheckCircle`, "Authenticated — you can resend your message now.") — the original "Cinna session expired" headline is replaced rather than supplemented. Does not auto-retry the failed send; user re-submits manually |

## Configuration

- No new env vars, settings, or `app:set-theme`-style toggles. Behavior is fully driven by `users` row state
- OAuth flow timing / abort handling is inherited from `cinna-oauth.ts` — re-auth uses the same browser callback infrastructure (`waitForOAuthCallback`, `findAvailablePort`) as initial registration

## Security

- **No new credential surface**: the renderer never sees the OAuth tokens or refresh tokens. Only `{ success, user }` crosses the IPC boundary on success
- **No renderer-supplied user id**: `auth:cinna-reauth` resolves the target user from `getProfileScopeUserId()`. A compromised or buggy renderer cannot target a different profile's tokens
- **Identity match guard**: the `profile.email === row.username` check prevents linking the local profile to a different server identity if the user accidentally signs in as someone else during the OAuth round-trip
- **In-place column overwrite**: failure branches (`identity_mismatch`, `oauth_failed`) do not touch the existing token columns. There is no partial-state where new tokens are written but the user row is wrong
- **Token storage**: reuses `storeCinnaTokens` → `userRepo.setCinnaTokens`, which already encrypts via `safeStorage` (OS keychain). No new keystore plumbing
- **Logger hygiene**: `reauthCinna` logs `userId`, `serverUrl`, OAuth error messages, and identity-mismatch (existing vs. got). Access/refresh tokens are never logged
- **Error code is opaque**: `CINNA_REAUTH_REQUIRED_CODE` is a stable string constant — renderer code never inspects token state directly; it branches on the typed code
