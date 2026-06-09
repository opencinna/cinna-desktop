# Cinna Accounts — Technical Details

## File Locations

### Main Process

| Layer | File | Purpose |
|-------|------|---------|
| Schema | `src/main/db/schema.ts` | 6 Cinna columns on `users` table |
| Migration | `src/main/db/migrations/users.ts` | ALTER TABLE for Cinna columns with `hasColumn` guards |
| DB Repo | `src/main/db/users.ts` | `userRepo.setCinnaTokens/clearCinnaTokens/getCinnaTokenState` for the 6 Cinna columns |
| OAuth | `src/main/auth/cinna-oauth.ts` | Discovery, PKCE flow, token exchange, refresh, abort |
| Tokens | `src/main/auth/cinna-tokens.ts` | Encrypted token storage (delegates to `userRepo`), auto-refresh, rotation handling |
| Service | `src/main/services/authService.ts` | `authService.registerCinna()` — orchestrates OAuth + user insert + token store + activation, with rollback on failure |
| IPC | `src/main/ipc/auth.ipc.ts` | Thin `auth:register` handler delegates to `authService.registerCinna()`; `auth:cinna-oauth-abort` calls `abortCinnaOAuthFlow()` |
| Errors | `src/main/errors.ts` | `AuthError` with codes including `oauth_failed`, `missing_server_url` |
| Keystore | `src/main/security/keystore.ts` | `encryptApiKey`/`decryptApiKey` — reused for Cinna tokens |
| Callback | `src/main/mcp/oauth-callback.ts` | Reused `findAvailablePort()` + `waitForOAuthCallback()` — extended with `params` map |

### Preload

| File | Purpose |
|------|---------|
| `src/preload/index.ts` | `UserData` extended with Cinna fields; `register()` accepts new params; `cinnaOAuthAbort()` added |

### Renderer

| Layer | File | Purpose |
|-------|------|---------|
| Store | `src/renderer/src/stores/auth.store.ts` | `AuthUser` extended with `cinnaHostingType`, `cinnaServerUrl`, `hasCinnaTokens` |
| Hook | `src/renderer/src/hooks/useAuth.ts` | `useRegister` updated params; `useCinnaOAuthAbort` added; `toAuthUser` helper |
| RegisterForm | `src/renderer/src/components/auth/RegisterForm.tsx` | Multi-step modal: type → hosting → form → waiting |
| UserMenu | `src/renderer/src/components/auth/UserMenu.tsx` | Cloud icon badge for Cinna users; RegisterForm rendered as centered modal |

## Database Schema

### Cinna columns on `users` table

| Column | Type | Purpose |
|--------|------|---------|
| `cinna_server_url` | TEXT | Server URL (e.g. `https://opencinna.io` or custom) |
| `cinna_hosting_type` | TEXT | `cloud` or `self_hosted`; NULL for local users |
| `cinna_client_id` | TEXT | Server-assigned OAuth client ID for this device |
| `cinna_access_token_enc` | BLOB | Encrypted access token via `safeStorage` |
| `cinna_refresh_token_enc` | BLOB | Encrypted refresh token via `safeStorage` |
| `cinna_token_expires_at` | INTEGER | Unix ms when access token expires |

All columns are nullable — NULL for `local_user` accounts. Migration uses `hasColumn` guards for safe upgrades.

## IPC Channels

| Channel | Signature | Purpose |
|---------|-----------|---------|
| `auth:register` | `({ username?, displayName?, password?, accountType, cinnaHostingType?, cinnaServerUrl? }) → { success, user?, error? }` | Create local or Cinna account; Cinna triggers OAuth flow (username/displayName come from OAuth for Cinna) |
| `auth:cinna-oauth-abort` | `() → { success }` | Abort an in-progress Cinna OAuth flow |

### Modified channels

| Channel | Change |
|---------|--------|
| `auth:list-users` | Returns `cinnaHostingType`, `cinnaServerUrl`, `hasCinnaTokens` for Cinna users |
| `auth:get-current` | Same — includes Cinna fields |
| `auth:get-startup` | Same — includes Cinna fields |
| `auth:login` | Same — includes Cinna fields in response |
| `auth:delete-user` | Now calls `clearCinnaTokens()` before cascade delete |

## Services & Key Methods

### `src/main/auth/cinna-oauth.ts`

- `CINNA_CLOUD_URL` — `'https://opencinna.io'`
- `discoverCinnaEndpoints(serverUrl)` — GET `{serverUrl}/.well-known/cinna-desktop`, returns `{ authorization_endpoint, token_endpoint, userinfo_endpoint }`, cached per server URL
- `startCinnaOAuthFlow(serverUrl)` — Full PKCE flow: discover → port → verifier/challenge → state → open browser → await callback → exchange code → fetch userinfo → return `{ clientId, accessToken, refreshToken, expiresIn, profile: { email, displayName } }`
- `abortCinnaOAuthFlow()` — Aborts active OAuth callback server
- `refreshCinnaTokens(serverUrl, clientId, refreshToken)` — POST to token endpoint with `grant_type=refresh_token`; throws `CinnaReauthRequired` on replay detection (`invalid_grant`, `token_reuse_detected`)
- `clearEndpointCache()` — Clears session-scoped discovery cache

### `src/main/auth/cinna-tokens.ts`

- `storeCinnaTokens(userId, { clientId, accessToken, refreshToken, expiresIn })` — Encrypts and writes to user row
- `getCinnaAccessToken(userId)` — Decrypts access token; auto-refreshes if within 60s of expiry; mutex prevents concurrent refresh; throws `CinnaReauthRequired` on failure
- `clearCinnaTokens(userId)` — Nulls all Cinna token/client columns
- `hasCinnaTokens(userId)` — Boolean check

### `src/main/services/authService.ts`

- `toDto(row)` — Internal helper that builds `UserDto` including Cinna fields (`cinnaHostingType`, `cinnaServerUrl`, `hasCinnaTokens`) for `cinna_user` type
- `authService.registerCinna({ hostingType, serverUrl })` — Validates server URL → runs `startCinnaOAuthFlow()` → throws `AuthError('oauth_failed', ...)` on failure → checks for existing username → inserts user row → `storeCinnaTokens()` (rolls back via `userRepo.deleteWithCascade()` if token store fails) → `userActivation.activate()` → returns `UserDto`

### `src/main/ipc/auth.ipc.ts`

- `auth:register` handler — Thin: branches on `accountType`, delegates to `authService.register()` (local) or `authService.registerCinna()` (cinna). Catches errors via `errorResponse()` to return `{ success: false, error }` for inline form display.
- `auth:cinna-oauth-abort` handler — Calls `abortCinnaOAuthFlow()`.

## Renderer Components

### `RegisterForm` in `src/renderer/src/components/auth/RegisterForm.tsx`

Multi-step form with state machine:

| Step | UI | Transitions |
|------|----|-------------|
| `type-select` | Two cards: Local / Cinna. No Cancel — dismiss via click-outside on the modal backdrop. | Local → `local-form`; Cinna → `cinna-hosting` |
| `cinna-hosting` | Two cards: Self-Hosted (left, default) / Cloud (right, shows "Under Development" notice + disables Connect when selected). URL input + "Recent servers" list (self-hosted only, sourced from `localStorage('cinna-selfhosted-history')`). Each recent row is full-width clickable (immediately connects) with an X-on-hover (`stopPropagation`) to remove. Centered "Connect" button. No Cancel. | Connect (or click on a recent row) → `cinna-waiting`; Back → `type-select` |
| `local-form` | Username, Display Name, Password (all optional except username). Centered "Create" button. No Cancel. | Create → success; Back → `type-select` |
| `cinna-waiting` | Spinner + Cancel button (only step that keeps Cancel — it calls `auth:cinna-oauth-abort` to terminate the in-flight flow). | Cancel → abort + `cinna-hosting`; Success → `onSuccess` |

For Cinna accounts, there is no form step — username and display name are received from the OAuth server's userinfo endpoint after authentication. Password can be set later.

Rendered as a centered modal overlay (fixed inset, `bg-black/50` backdrop) instead of inside the dropdown. The dropdown, the modal panel, and the sign-out confirm panel all use the `.app-popover-surface` utility class (frosted-glass, theme-aware) defined in `src/renderer/src/assets/main.css`.

The `RegisterFormProps` interface no longer carries an `onCancel` callback — only `onSuccess`. Dismissal of `type-select` / `cinna-hosting` / `local-form` is the caller's responsibility (click-outside on the backdrop in `UserMenu.tsx`).

### Self-hosted history (renderer-only)

| Concern | Location |
|---------|----------|
| Storage key | `localStorage('cinna-selfhosted-history')` — JSON array of URL strings |
| Read / write helpers | `readSelfHostedHistory()` / `writeSelfHostedHistory(urls)` at the top of `src/renderer/src/components/auth/RegisterForm.tsx` (defensive JSON parse, filters non-strings) |
| Cap | `SELFHOSTED_HISTORY_LIMIT = 8` (most-recent-first, dedup on push) |
| Write trigger | `connectSelfHosted()` on successful `register.mutateAsync`. Failed attempts (`result.success === false`) do not write — wrong URLs do not pollute the list |
| Remove trigger | `handleRemoveHistoryEntry(url)` — the X button inside each row |

### `UserMenu` in `src/renderer/src/components/auth/UserMenu.tsx`

- "Add Account" closes dropdown, opens RegisterForm modal
- Cloud icon (`lucide-react:Cloud`) shown next to `cinna_user` entries in the profile list

## Security

- **PKCE**: code verifier (32 random bytes, base64url) + SHA-256 challenge — prevents authorization code interception
- **State parameter**: 16 random bytes hex — prevents CSRF
- **Localhost-only redirect**: callback server binds to `127.0.0.1` on a random available port
- **Token encryption**: access and refresh tokens encrypted via `safeStorage` (OS keychain) before SQLite storage
- **Token rotation**: server issues new refresh token on each refresh; old token invalidated; replay detection triggers full re-auth and local token wipe
- **Refresh mutex**: concurrent refresh attempts deduplicated via a per-user in-flight promise — prevents race conditions that could trigger false replay detection and cross-account token bleed. Full lifecycle + suspend/resume orphan safeguards in [Token Lifecycle tech](./token_lifecycle_tech.md)
- **No secrets on disk**: `client_id` is public (per OAuth spec for native apps); no client secret stored
- **Cleanup on failure**: if OAuth fails mid-flow, the partially-created user row is deleted — no orphaned records
